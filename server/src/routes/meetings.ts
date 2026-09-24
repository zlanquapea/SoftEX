import { Router } from 'express';
import { z } from 'zod';
import {
  canContributeProject,
  canManageProject,
  canPostChannel,
  canViewDecision,
  canViewMeeting,
  canViewTask,
  isAdmin,
  isActiveMember,
  isGuest,
  loadChannel,
  loadProject,
  type Auth,
} from '../access.js';
import type { Row } from '../db.js';
import { authOf, notify, publishToChannel, recordActivity, userSummary, type Ctx } from '../context.js';
import { forbidden, newId, notFound, now, parse } from '../util.js';
import { serializeTasks } from './tasks.js';
import { serializeMessages } from './channels.js';

const icsDate = (iso: string) => iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const icsEscape = (s: string) => s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[,;]/g, (c) => `\\${c}`);

export function meetingsRouter(ctx: Ctx) {
  const r = Router();
  const { db } = ctx;

  const loadMeeting = (auth: Auth, id: string) => {
    const meeting = db.get('SELECT * FROM meetings WHERE id = ?', id);
    if (!meeting || !canViewMeeting(db, auth, meeting)) throw notFound('Meeting');
    return meeting;
  };

  const participants = (meetingId: string) =>
    db.all(
      `SELECT u.id, u.name, u.color, u.timezone, p.response FROM meeting_participants p JOIN users u ON u.id = p.user_id
        WHERE p.meeting_id = ? ORDER BY u.name`,
      meetingId,
    );

  const summary = (m: Row) => ({
    id: m.id,
    title: m.title,
    starts_at: m.starts_at,
    ends_at: new Date(new Date(m.starts_at).getTime() + m.duration_min * 60_000).toISOString(),
    duration_min: m.duration_min,
    location: m.location,
    video_url: m.video_url,
    project: m.project_id ? db.get('SELECT id, name, color FROM projects WHERE id = ?', m.project_id) ?? null : null,
    channel_id: m.channel_id,
    organizer: userSummary(db, m.organizer_id),
    started_at: m.started_at,
    ended_at: m.ended_at,
    participants: participants(m.id),
  });

  const isOrganizerOrManager = (auth: Auth, m: Row) => {
    if (m.organizer_id === auth.userId || isAdmin(auth)) return true;
    if (m.project_id) {
      const project = db.get('SELECT * FROM projects WHERE id = ?', m.project_id);
      return !!project && canManageProject(db, auth, project);
    }
    return false;
  };

  const canTakeNotes = (auth: Auth, m: Row) => {
    if (isOrganizerOrManager(auth, m)) return true;
    if (db.get('SELECT 1 FROM meeting_participants WHERE meeting_id = ? AND user_id = ?', m.id, auth.userId)) return true;
    if (m.project_id) {
      const project = db.get('SELECT * FROM projects WHERE id = ?', m.project_id);
      return !!project && canContributeProject(db, auth, project);
    }
    return false;
  };

  r.get('/meetings', (req, res) => {
    const auth = authOf(req);
    const q = parse(z.object({ range: z.enum(['upcoming', 'past', 'all']).default('upcoming'), projectId: z.string().optional() }), req.query);
    if (q.projectId) loadProject(db, auth, q.projectId);
    const t = now();
    const cond =
      q.range === 'upcoming'
        ? `AND m.ended_at IS NULL AND datetime(m.starts_at, '+' || m.duration_min || ' minutes') >= datetime(?)`
        : q.range === 'past'
          ? `AND (m.ended_at IS NOT NULL OR datetime(m.starts_at, '+' || m.duration_min || ' minutes') < datetime(?))`
          : '';
    const params: string[] = [auth.workspaceId];
    if (q.range !== 'all') params.push(t);
    if (q.projectId) params.push(q.projectId);
    const rows = db
      .all(
        `SELECT m.* FROM meetings m WHERE m.workspace_id = ? ${cond} ${q.projectId ? 'AND m.project_id = ?' : ''}
          ORDER BY m.starts_at ${q.range === 'past' ? 'DESC' : 'ASC'} LIMIT 500`,
        ...params,
      )
      .filter((m) => canViewMeeting(db, auth, m));
    res.json(rows.slice(0, 200).map(summary));
  });

  r.post('/meetings', (req, res) => {
    const auth = authOf(req);
    const body = parse(
      z.object({
        title: z.string().trim().min(1).max(200),
        agenda: z.string().max(10_000).default(''),
        startsAt: z.string().datetime({ offset: true }),
        durationMin: z.number().int().min(5).max(24 * 60).default(30),
        location: z.string().max(200).default(''),
        video: z.boolean().default(true),
        projectId: z.string().nullish(),
        channelId: z.string().nullish(),
        participantIds: z.array(z.string()).max(300).default([]),
      }),
      req.body,
    );
    if (body.projectId) {
      const project = loadProject(db, auth, body.projectId);
      if (!canContributeProject(db, auth, project)) throw forbidden();
    }
    let channel: Row | null = null;
    if (body.channelId) {
      channel = loadChannel(db, auth, body.channelId);
      if (!canPostChannel(db, auth, channel)) throw forbidden();
    }
    if (isGuest(auth) && !body.projectId && !body.channelId) throw forbidden('Guests can schedule meetings only from shared channels or projects');
    const id = newId();
    const startsAt = new Date(body.startsAt).toISOString();
    const people = [...new Set([auth.userId, ...body.participantIds])].filter((u) => isActiveMember(db, auth.workspaceId, u));
    db.transaction(() => {
      db.insert('meetings', {
        id,
        workspace_id: auth.workspaceId,
        project_id: body.projectId ?? channel?.project_id ?? null,
        channel_id: body.channelId ?? null,
        title: body.title,
        agenda: body.agenda,
        starts_at: startsAt,
        duration_min: body.durationMin,
        location: body.location,
        video_url: body.video ? `${ctx.config.meetingBaseUrl.replace(/\/$/, '')}/SoftEX-${id.replace(/-/g, '').slice(0, 20)}` : '',
        organizer_id: auth.userId,
        created_at: now(),
      });
      for (const u of people) {
        db.insert('meeting_participants', { meeting_id: id, user_id: u, response: u === auth.userId ? 'accepted' : 'pending' });
      }
    });
    const organizer = db.get('SELECT name FROM users WHERE id = ?', auth.userId)!;
    for (const u of people) {
      notify(ctx, auth.workspaceId, { userId: u, kind: 'meeting', title: `${organizer.name} invited you to “${body.title}”`, body: new Date(startsAt).toUTCString(), link: `/meetings/${id}`, actorId: auth.userId });
    }
    if (channel) {
      const messageId = newId();
      db.insert('messages', {
        id: messageId,
        channel_id: channel.id,
        user_id: auth.userId,
        body: `📅 Scheduled a meeting: **${body.title}** — [open meeting](/meetings/${id})`,
        created_at: now(),
      });
      const [message] = serializeMessages(db, auth, [db.get('SELECT * FROM messages WHERE id = ?', messageId)!]);
      publishToChannel(ctx, channel, { type: 'message.created', message });
    }
    recordActivity(ctx, auth.workspaceId, {
      actorId: auth.userId,
      verb: 'scheduled',
      objectType: 'meeting',
      objectId: id,
      projectId: body.projectId ?? channel?.project_id,
      channelId: body.channelId,
      summary: `scheduled “${body.title}”`,
      link: `/meetings/${id}`,
    });
    res.status(201).json(summary(db.get('SELECT * FROM meetings WHERE id = ?', id)!));
  });

  r.get('/meetings/:id', (req, res) => {
    const auth = authOf(req);
    const m = loadMeeting(auth, req.params.id);
    const tasks = serializeTasks(
      db,
      db.all('SELECT * FROM tasks WHERE meeting_id = ? ORDER BY created_at', m.id).filter((t) => canViewTask(db, auth, t)),
    );
    const decisions = db
      .all(`SELECT d.*, u.name AS decided_by_name FROM decisions d JOIN users u ON u.id = d.decided_by WHERE meeting_id = ? ORDER BY created_at`, m.id)
      .filter((d) => canViewDecision(db, auth, d));
    const channel = m.channel_id ? db.get('SELECT id, name, kind FROM channels WHERE id = ?', m.channel_id) : null;
    res.json({
      ...summary(m),
      agenda: m.agenda,
      notes: m.notes,
      tasks,
      decisions,
      channel,
      my_response: db.get('SELECT response FROM meeting_participants WHERE meeting_id = ? AND user_id = ?', m.id, auth.userId)?.response ?? null,
      can_manage: isOrganizerOrManager(auth, m),
      can_take_notes: canTakeNotes(auth, m),
    });
  });

  r.patch('/meetings/:id', (req, res) => {
    const auth = authOf(req);
    const m = loadMeeting(auth, req.params.id);
    const body = parse(
      z.object({
        title: z.string().trim().min(1).max(200).optional(),
        agenda: z.string().max(10_000).optional(),
        notes: z.string().max(100_000).optional(),
        startsAt: z.string().datetime({ offset: true }).optional(),
        durationMin: z.number().int().min(5).max(24 * 60).optional(),
        location: z.string().max(200).optional(),
        participantIds: z.array(z.string()).max(300).optional(),
      }),
      req.body,
    );
    const managing = body.title !== undefined || body.startsAt !== undefined || body.durationMin !== undefined || body.location !== undefined || body.participantIds !== undefined;
    if (managing && !isOrganizerOrManager(auth, m)) throw forbidden('Only the organizer can change the meeting details');
    if ((body.notes !== undefined || body.agenda !== undefined) && !canTakeNotes(auth, m)) throw forbidden('Only participants can edit the agenda and notes');
    db.update('meetings', m.id, {
      title: body.title,
      agenda: body.agenda,
      notes: body.notes,
      starts_at: body.startsAt ? new Date(body.startsAt).toISOString() : undefined,
      duration_min: body.durationMin,
      location: body.location,
    });
    if (body.participantIds) {
      const current = new Set(participants(m.id).map((p) => p.id));
      for (const u of body.participantIds) {
        if (current.has(u) || !isActiveMember(db, auth.workspaceId, u)) continue;
        db.insert('meeting_participants', { meeting_id: m.id, user_id: u });
        notify(ctx, auth.workspaceId, { userId: u, kind: 'meeting', title: `You were invited to “${body.title ?? m.title}”`, link: `/meetings/${m.id}`, actorId: auth.userId });
      }
      for (const u of current) {
        if (!body.participantIds.includes(u) && u !== m.organizer_id) db.run('DELETE FROM meeting_participants WHERE meeting_id = ? AND user_id = ?', m.id, u);
      }
    }
    if (body.startsAt && body.startsAt !== m.starts_at) {
      for (const p of participants(m.id)) {
        notify(ctx, auth.workspaceId, { userId: p.id, kind: 'meeting', title: `“${m.title}” was rescheduled`, body: new Date(body.startsAt).toUTCString(), link: `/meetings/${m.id}`, actorId: auth.userId });
      }
    }
    ctx.hub.publish(auth.workspaceId, { type: 'meeting.updated', meetingId: m.id }, (a) => canViewMeeting(db, a, m));
    res.json(summary(db.get('SELECT * FROM meetings WHERE id = ?', m.id)!));
  });

  r.post('/meetings/:id/respond', (req, res) => {
    const auth = authOf(req);
    const m = loadMeeting(auth, req.params.id);
    const { response } = parse(z.object({ response: z.enum(['accepted', 'declined', 'pending']) }), req.body);
    const changed = db.run('UPDATE meeting_participants SET response = ? WHERE meeting_id = ? AND user_id = ?', response, m.id, auth.userId);
    if (!changed.changes) db.insert('meeting_participants', { meeting_id: m.id, user_id: auth.userId, response });
    res.json({ ok: true });
  });

  r.post('/meetings/:id/start', (req, res) => {
    const auth = authOf(req);
    const m = loadMeeting(auth, req.params.id);
    if (!canTakeNotes(auth, m)) throw forbidden();
    if (!m.started_at) {
      db.update('meetings', m.id, { started_at: now() });
      const starter = db.get('SELECT name FROM users WHERE id = ?', auth.userId)!;
      for (const p of participants(m.id)) {
        if (p.response === 'declined') continue;
        notify(ctx, auth.workspaceId, { userId: p.id, kind: 'meeting', title: `“${m.title}” has started`, body: `${starter.name} started the meeting`, link: `/meetings/${m.id}`, actorId: auth.userId, urgent: true });
      }
    }
    ctx.hub.publish(auth.workspaceId, { type: 'meeting.updated', meetingId: m.id }, (a) => canViewMeeting(db, a, m));
    res.json({ video_url: m.video_url });
  });

  r.post('/meetings/:id/end', (req, res) => {
    const auth = authOf(req);
    const m = loadMeeting(auth, req.params.id);
    if (!canTakeNotes(auth, m)) throw forbidden();
    db.update('meetings', m.id, { ended_at: now(), started_at: m.started_at ?? now() });
    const followUps = db.get('SELECT COUNT(*) AS n FROM tasks WHERE meeting_id = ?', m.id)!.n;
    const decisions = db.get('SELECT COUNT(*) AS n FROM decisions WHERE meeting_id = ?', m.id)!.n;
    recordActivity(ctx, auth.workspaceId, {
      actorId: auth.userId,
      verb: 'ended',
      objectType: 'meeting',
      objectId: m.id,
      projectId: m.project_id,
      channelId: m.channel_id,
      summary: `wrapped up “${m.title}” with ${decisions} decision(s) and ${followUps} follow-up task(s)`,
      link: `/meetings/${m.id}`,
    });
    for (const p of participants(m.id)) {
      notify(ctx, auth.workspaceId, { userId: p.id, kind: 'meeting', title: `Notes and follow-ups from “${m.title}”`, body: `${decisions} decision(s), ${followUps} follow-up task(s)`, link: `/meetings/${m.id}`, actorId: auth.userId });
    }
    ctx.hub.publish(auth.workspaceId, { type: 'meeting.updated', meetingId: m.id }, (a) => canViewMeeting(db, a, m));
    res.json({ ok: true });
  });

  r.delete('/meetings/:id', (req, res) => {
    const auth = authOf(req);
    const m = loadMeeting(auth, req.params.id);
    if (!isOrganizerOrManager(auth, m)) throw forbidden('Only the organizer can cancel this meeting');
    const people = participants(m.id);
    db.run('DELETE FROM meetings WHERE id = ?', m.id);
    for (const p of people) {
      notify(ctx, auth.workspaceId, { userId: p.id, kind: 'meeting', title: `“${m.title}” was cancelled`, link: '/meetings', actorId: auth.userId });
    }
    res.json({ ok: true });
  });

  /** Calendar integration: an iCalendar invite importable into any calendar client. */
  r.get('/meetings/:id/ics', (req, res) => {
    const auth = authOf(req);
    const m = loadMeeting(auth, req.params.id);
    const end = new Date(new Date(m.starts_at).getTime() + m.duration_min * 60_000).toISOString();
    const origin = `${req.protocol}://${req.get('host')}`;
    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//SoftEX//Meetings//EN',
      'METHOD:PUBLISH',
      'BEGIN:VEVENT',
      `UID:${m.id}@softex`,
      `DTSTAMP:${icsDate(now())}`,
      `DTSTART:${icsDate(m.starts_at)}`,
      `DTEND:${icsDate(end)}`,
      `SUMMARY:${icsEscape(m.title)}`,
      `DESCRIPTION:${icsEscape(`${m.agenda}\n\n${origin}/meetings/${m.id}`)}`,
      `LOCATION:${icsEscape(m.video_url || m.location)}`,
      `URL:${origin}/meetings/${m.id}`,
      'END:VEVENT',
      'END:VCALENDAR',
    ];
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="meeting-${m.id.slice(0, 8)}.ics"`);
    res.send(lines.join('\r\n'));
  });

  return r;
}
