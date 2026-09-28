import { mkdirSync, unlinkSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { canManageMeeting, canTakeMeetingNotes, canViewMeeting, isAdmin, type Auth } from '../access.js';
import { audit, authOf, notify, type Ctx } from '../context.js';
import type { Row } from '../db.js';
import { hasFeature, requireFeature, requireStorage } from '../plans.js';
import { scanUpload } from '../scanner.js';
import { HttpError, badRequest, forbidden, newId, notFound, now, parse } from '../util.js';
import { parseRange } from './knowledge.js';

/**
 * Meeting recordings and transcripts (Teams, Zoom, Google Meet).
 *
 * Someone taking part records the meeting from their browser (microphone, or screen and
 * microphone) after confirming everyone has been told. Everyone watching the meeting page sees
 * that it is being recorded. While recording, the browser can send live captions; afterwards the
 * server can transcribe the file with a Whisper-compatible service, if one is configured and the
 * workspace allows AI processing. Recordings are only ever served to people who can open the
 * meeting, and they count towards the workspace's storage.
 */

const MEDIA_TYPES: Record<string, string> = {
  'audio/webm': 'weba',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'video/webm': 'webm',
  'video/mp4': 'mp4',
};

const Segment = z.object({ startMs: z.number().int().min(0), endMs: z.number().int().min(0), text: z.string().trim().min(1).max(2000) });

async function readAll(stream: Readable) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/** Transcribe queued recordings (run by the background job loop). */
export async function processTranscriptions(ctx: Ctx) {
  if (!ctx.stt) return;
  const { db } = ctx;
  const queued = await db.all("SELECT * FROM meeting_recordings WHERE transcript_status = 'queued' ORDER BY ended_at LIMIT 2");
  for (const rec of queued) {
    // Claim it, so a second server doesn't do the same work.
    const { changes } = await db.run("UPDATE meeting_recordings SET transcript_status = 'processing' WHERE id = ? AND transcript_status = 'queued'", rec.id);
    if (!changes) continue;
    try {
      const stream = await ctx.files.open(rec.storage_key);
      if (!stream) throw new Error('The recording file is missing');
      const data = await readAll(stream);
      const segments = await ctx.stt.transcribe({ data, mime: rec.mime, name: `recording.${MEDIA_TYPES[rec.mime] ?? 'webm'}`, language: rec.language ?? undefined });
      await db.transaction(async () => {
        await db.run("DELETE FROM transcript_segments WHERE recording_id = ? AND source = 'server'", rec.id);
        for (const s of segments.slice(0, 5000)) {
          await db.insert('transcript_segments', {
            id: newId(),
            recording_id: rec.id,
            meeting_id: rec.meeting_id,
            start_ms: s.start_ms,
            end_ms: s.end_ms,
            speaker_id: null,
            text: s.text.slice(0, 2000),
            source: 'server',
            created_at: now(),
          });
        }
        await db.run("UPDATE meeting_recordings SET transcript_status = 'done', transcript_error = NULL WHERE id = ?", rec.id);
      });
      const meeting = await db.get('SELECT title FROM meetings WHERE id = ?', rec.meeting_id);
      await notify(ctx, rec.workspace_id, { userId: rec.started_by, kind: 'meeting', title: `The transcript of “${meeting?.title ?? 'your meeting'}” is ready`, link: `/meetings/${rec.meeting_id}#recordings` });
      await ctx.hub.publish(rec.workspace_id, { type: 'meeting.recording', meetingId: rec.meeting_id }, { kind: 'meeting', meetingId: rec.meeting_id });
    } catch (e) {
      console.error('Transcription failed', e);
      await db.run("UPDATE meeting_recordings SET transcript_status = 'failed', transcript_error = ? WHERE id = ?", String((e as Error).message).slice(0, 300), rec.id);
    }
  }
}

export function recordingsRouter(ctx: Ctx) {
  const r = Router();
  const { db } = ctx;
  const incomingDir = resolve(ctx.config.uploadDir, 'incoming');
  mkdirSync(incomingDir, { recursive: true });
  const upload = multer({ dest: incomingDir, limits: { fileSize: ctx.config.maxUploadBytes, files: 1 } });
  const tempPath = (file: Express.Multer.File) => {
    const path = resolve(file.path);
    if (!path.startsWith(incomingDir + sep)) throw badRequest('Invalid upload');
    return path;
  };

  const loadMeeting = async (auth: Auth, id: string) => {
    const meeting = await db.get('SELECT * FROM meetings WHERE id = ?', id);
    if (!meeting || !await canViewMeeting(db, auth, meeting)) throw notFound('Meeting');
    return meeting;
  };
  const loadRecording = async (auth: Auth, id: string) => {
    const rec = await db.get('SELECT * FROM meeting_recordings WHERE id = ? AND workspace_id = ?', id, auth.workspaceId);
    if (!rec) throw notFound('Recording');
    const meeting = await loadMeeting(auth, rec.meeting_id);
    return { rec, meeting };
  };
  const serverTranscription = async (workspaceId: string) =>
    !!ctx.stt && !!(await db.get('SELECT ai_enabled FROM workspaces WHERE id = ?', workspaceId))?.ai_enabled;

  const serialize = async (auth: Auth, rec: Row, meeting: Row) => ({
    id: rec.id,
    kind: rec.kind,
    status: rec.status,
    mime: rec.mime,
    size: Number(rec.size) || 0,
    duration_sec: Number(rec.duration_sec) || 0,
    started_by: await db.get('SELECT id, name, color FROM users WHERE id = ?', rec.started_by),
    started_at: rec.started_at,
    ended_at: rec.ended_at,
    transcript_status: rec.transcript_status,
    transcript_error: rec.transcript_error ?? null,
    segment_count: Number((await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM transcript_segments WHERE recording_id = ?', rec.id))!.n),
    media_url: rec.storage_key ? `/api/recordings/${rec.id}/media` : null,
    can_delete: rec.started_by === auth.userId || await canManageMeeting(db, auth, meeting),
  });

  r.get('/meetings/:id/recordings', async (req, res) => {
    const auth = authOf(req);
    const meeting = await loadMeeting(auth, req.params.id);
    const rows = await db.all('SELECT * FROM meeting_recordings WHERE meeting_id = ? ORDER BY started_at', meeting.id);
    res.json({
      recordings: await Promise.all(rows.map((rec) => serialize(auth, rec, meeting))),
      available: await hasFeature(ctx, auth.workspaceId, 'recordings'),
      can_record: await canTakeMeetingNotes(db, auth, meeting),
      server_transcription: await serverTranscription(auth.workspaceId),
      max_bytes: ctx.config.maxUploadBytes,
    });
  });

  r.post('/meetings/:id/recordings', async (req, res) => {
    const auth = authOf(req);
    const meeting = await loadMeeting(auth, req.params.id);
    if (!await canTakeMeetingNotes(db, auth, meeting)) throw forbidden('Only people taking part can record this meeting');
    await requireFeature(ctx, auth.workspaceId, 'recordings');
    const body = parse(
      z.object({
        kind: z.enum(['audio', 'screen']).default('audio'),
        consent: z.literal(true, { message: 'Confirm that everyone knows the meeting is being recorded' }),
        language: z.string().regex(/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/).optional(),
      }),
      req.body,
    );
    const id = newId();
    await db.insert('meeting_recordings', {
      id,
      workspace_id: auth.workspaceId,
      meeting_id: meeting.id,
      started_by: auth.userId,
      kind: body.kind,
      status: 'recording',
      language: body.language ?? null,
      started_at: now(),
    });
    const user = (await db.get('SELECT name FROM users WHERE id = ?', auth.userId))!;
    await audit(ctx, auth.workspaceId, auth.userId, 'meeting.recording_started', 'meeting', meeting.id, { recordingId: id, kind: body.kind });
    await ctx.hub.publish(auth.workspaceId, { type: 'meeting.recording', meetingId: meeting.id, active: true, by: user.name }, { kind: 'meeting', meetingId: meeting.id });
    // Everyone invited hears about it, so nobody is recorded without knowing.
    const invited = await db.all('SELECT user_id FROM meeting_participants WHERE meeting_id = ? AND user_id != ?', meeting.id, auth.userId);
    for (const p of invited) {
      await notify(ctx, auth.workspaceId, { userId: p.user_id, kind: 'meeting', title: `${user.name} started recording “${meeting.title}”`, link: `/meetings/${meeting.id}#recordings`, actorId: auth.userId });
    }
    res.status(201).json(await serialize(auth, (await db.get('SELECT * FROM meeting_recordings WHERE id = ?', id))!, meeting));
  });

  /** Live captions from the recorder's browser. */
  r.post('/recordings/:id/segments', async (req, res) => {
    const auth = authOf(req);
    const { rec, meeting } = await loadRecording(auth, req.params.id);
    if (rec.started_by !== auth.userId) throw forbidden('Only the person recording can add live captions');
    if (rec.status !== 'recording') throw badRequest('This recording has ended');
    const { segments } = parse(z.object({ segments: z.array(Segment).min(1).max(50) }), req.body);
    const rows = segments.map((s) => ({ id: newId(), recording_id: rec.id, meeting_id: meeting.id, start_ms: s.startMs, end_ms: Math.max(s.startMs, s.endMs), speaker_id: auth.userId, text: s.text, source: 'live', created_at: now() }));
    await db.transaction(async () => {
      for (const row of rows) await db.insert('transcript_segments', row);
      if (rec.transcript_status === 'none') await db.run("UPDATE meeting_recordings SET transcript_status = 'live' WHERE id = ?", rec.id);
    });
    const speaker = await db.get('SELECT id, name FROM users WHERE id = ?', auth.userId);
    await ctx.hub.publish(
      auth.workspaceId,
      { type: 'meeting.caption', meetingId: meeting.id, recordingId: rec.id, segments: rows.map((s) => ({ id: s.id, start_ms: s.start_ms, text: s.text, speaker })) },
      { kind: 'meeting', meetingId: meeting.id },
    );
    res.status(201).json({ ok: true });
  });

  /** The finished file. Optional server transcription runs in the background. */
  r.post('/recordings/:id/upload', upload.single('file'), async (req, res) => {
    const auth = authOf(req);
    const file = req.file;
    const cleanup = () => {
      try {
        if (file) unlinkSync(tempPath(file));
      } catch {
        /* already moved into storage, or never written */
      }
    };
    try {
      if (!file) throw badRequest('Attach the recording');
      const { rec, meeting } = await loadRecording(auth, String(req.params.id));
      if (rec.started_by !== auth.userId) throw forbidden('Only the person recording can upload it');
      if (rec.status !== 'recording') throw badRequest('This recording was already saved');
      const mime = (file.mimetype || '').split(';')[0].toLowerCase();
      if (!MEDIA_TYPES[mime]) throw badRequest('Recordings must be audio or video (WebM, MP4, Ogg, MP3 or WAV)');
      const body = parse(z.object({ durationSec: z.coerce.number().int().min(0).max(24 * 3600).default(0), transcribe: z.enum(['true', 'false']).default('false') }), req.body);
      await requireStorage(ctx, auth.workspaceId, file.size);
      await scanUpload(ctx.config, tempPath(file), file.originalname || 'recording');
      const key = newId();
      await ctx.files.put(key, tempPath(file), mime);
      const queue = body.transcribe === 'true' && await serverTranscription(auth.workspaceId);
      await db.run(
        `UPDATE meeting_recordings SET status = 'ready', storage_key = ?, mime = ?, size = ?, duration_sec = ?, ended_at = ?, transcript_status = ?
          WHERE id = ?`,
        key,
        mime,
        file.size,
        body.durationSec,
        now(),
        queue ? 'queued' : rec.transcript_status,
        rec.id,
      );
      await audit(ctx, auth.workspaceId, auth.userId, 'meeting.recording_saved', 'meeting', meeting.id, { recordingId: rec.id, bytes: file.size, transcribe: queue });
      await ctx.hub.publish(auth.workspaceId, { type: 'meeting.recording', meetingId: meeting.id, active: false }, { kind: 'meeting', meetingId: meeting.id });
      res.json(await serialize(auth, (await db.get('SELECT * FROM meeting_recordings WHERE id = ?', rec.id))!, meeting));
    } finally {
      cleanup();
    }
  });

  /** Stop without saving a file (the browser failed, or the recorder cancelled). */
  r.post('/recordings/:id/stop', async (req, res) => {
    const auth = authOf(req);
    const { rec, meeting } = await loadRecording(auth, req.params.id);
    if (rec.started_by !== auth.userId && !await canManageMeeting(db, auth, meeting)) throw forbidden();
    if (rec.status === 'recording') await db.run("UPDATE meeting_recordings SET status = 'stopped', ended_at = ? WHERE id = ?", now(), rec.id);
    await ctx.hub.publish(auth.workspaceId, { type: 'meeting.recording', meetingId: meeting.id, active: false }, { kind: 'meeting', meetingId: meeting.id });
    res.json({ ok: true });
  });

  /** Ask the server to (re)transcribe a saved recording. */
  r.post('/recordings/:id/transcribe', async (req, res) => {
    const auth = authOf(req);
    const { rec, meeting } = await loadRecording(auth, req.params.id);
    if (rec.started_by !== auth.userId && !await canManageMeeting(db, auth, meeting)) throw forbidden();
    if (!rec.storage_key) throw badRequest('This recording has no saved file');
    if (!await serverTranscription(auth.workspaceId)) throw new HttpError(409, 'Server transcription is not available. An admin needs to turn on AI features, and the server needs a transcription service.');
    await db.run("UPDATE meeting_recordings SET transcript_status = 'queued', transcript_error = NULL WHERE id = ?", rec.id);
    res.json({ ok: true });
  });

  r.get('/recordings/:id/transcript', async (req, res) => {
    const auth = authOf(req);
    const { rec } = await loadRecording(auth, req.params.id);
    // Prefer the server's full transcript when there is one; otherwise the live captions.
    const source = (await db.get("SELECT 1 FROM transcript_segments WHERE recording_id = ? AND source = 'server' LIMIT 1", rec.id)) ? 'server' : 'live';
    const segments = await db.all(
      `SELECT s.id, s.start_ms, s.end_ms, s.text, s.source, u.id AS speaker_id, u.name AS speaker_name
         FROM transcript_segments s LEFT JOIN users u ON u.id = s.speaker_id WHERE s.recording_id = ? AND s.source = ? ORDER BY s.start_ms, s.created_at`,
      rec.id,
      source,
    );
    res.json({ source, segments });
  });

  r.get('/recordings/:id/media', async (req, res) => {
    const auth = authOf(req);
    const { rec } = await loadRecording(auth, req.params.id);
    if (!rec.storage_key) throw notFound('Recording file');
    const size = Number(rec.size);
    const range = parseRange(req.get('range'), size);
    if (range === 'invalid') {
      res.setHeader('Content-Range', `bytes */${size}`);
      return res.status(416).end();
    }
    const stream = await ctx.files.open(rec.storage_key, range ?? undefined);
    if (!stream) throw new HttpError(410, 'The recording is no longer available');
    res.setHeader('Content-Type', rec.mime);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; media-src 'self'; sandbox");
    if (req.query.download === '1') res.setHeader('Content-Disposition', `attachment; filename="meeting-recording.${MEDIA_TYPES[rec.mime] ?? 'webm'}"`);
    if (range) {
      res.status(206);
      res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
      res.setHeader('Content-Length', String(range.end - range.start + 1));
    } else res.setHeader('Content-Length', String(size));
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  });

  r.delete('/recordings/:id', async (req, res) => {
    const auth = authOf(req);
    const { rec, meeting } = await loadRecording(auth, req.params.id);
    if (rec.started_by !== auth.userId && !await canManageMeeting(db, auth, meeting) && !isAdmin(auth)) throw forbidden('Only the recorder or the organizer can delete a recording');
    await db.run('DELETE FROM meeting_recordings WHERE id = ?', rec.id);
    if (rec.storage_key) await ctx.files.remove(rec.storage_key);
    await audit(ctx, auth.workspaceId, auth.userId, 'meeting.recording_deleted', 'meeting', meeting.id, { recordingId: rec.id });
    await ctx.hub.publish(auth.workspaceId, { type: 'meeting.recording', meetingId: meeting.id }, { kind: 'meeting', meetingId: meeting.id });
    res.json({ ok: true });
  });

  return r;
}
