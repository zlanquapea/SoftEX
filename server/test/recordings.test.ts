import { afterEach, describe, expect, it } from 'vitest';
import type { SpeechToText } from '../src/stt.js';
import { flushJobs, invite, registerOwner, setup, type TestEnv } from './helpers.js';

let env: TestEnv;
afterEach(() => env?.cleanup());

const soon = () => new Date(Date.now() + 3_600_000).toISOString();
// Not a real WebM, but uploads only check the declared type; the scanner and storage don't care.
const audio = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(4096, 7)]);

describe('meeting recordings and transcripts', () => {
  it('records with consent, shows live captions and transcribes on the server', async () => {
    const heard: { mime: string; bytes: number }[] = [];
    const stt: SpeechToText = {
      transcribe: async ({ data, mime }) => {
        heard.push({ mime, bytes: data.length });
        return [
          { start_ms: 0, end_ms: 4000, text: 'Welcome everyone to the budget review.' },
          { start_ms: 4000, end_ms: 9000, text: 'We agreed to fund the Gbarnga clinic.' },
        ];
      },
    };
    const prompts: string[] = [];
    env = setup({ stt, ai: { complete: async ({ prompt }) => (prompts.push(prompt), { text: 'Summary: fund the clinic.', refused: false }) } });
    const owner = await registerOwner(env, 'Olu Owner');
    const guestOfMeeting = await invite(env, owner.agent, 'member', {}, 'Ina Invited');
    const outsider = await invite(env, owner.agent);
    const secretProject = (await owner.agent.post('/api/projects').send({ name: 'Board', visibility: 'private', memberIds: [guestOfMeeting.id] })).body;
    const meeting = (await owner.agent.post('/api/meetings').send({ title: 'Budget review', startsAt: soon(), participantIds: [guestOfMeeting.id], projectId: secretProject.id })).body;

    // Everyone must have been told.
    expect((await owner.agent.post(`/api/meetings/${meeting.id}/recordings`).send({ kind: 'audio' })).status).toBe(400);
    expect((await outsider.agent.post(`/api/meetings/${meeting.id}/recordings`).send({ kind: 'audio', consent: true })).status).toBe(404);
    const rec = (await owner.agent.post(`/api/meetings/${meeting.id}/recordings`).send({ kind: 'audio', consent: true, language: 'en' })).body;
    expect(rec).toMatchObject({ status: 'recording', transcript_status: 'none' });
    const inbox = (await guestOfMeeting.agent.get('/api/notifications')).body.notifications;
    expect(inbox.some((n: { title: string }) => n.title === 'Olu Owner started recording “Budget review”')).toBe(true);

    // Live captions come only from the recorder.
    expect((await guestOfMeeting.agent.post(`/api/recordings/${rec.id}/segments`).send({ segments: [{ startMs: 0, endMs: 1, text: 'x' }] })).status).toBe(403);
    await owner.agent.post(`/api/recordings/${rec.id}/segments`).send({ segments: [{ startMs: 0, endMs: 3500, text: 'welcome everyone to the budget review' }] }).expect(201);
    let transcript = (await guestOfMeeting.agent.get(`/api/recordings/${rec.id}/transcript`)).body;
    expect(transcript).toMatchObject({ source: 'live', segments: [{ text: 'welcome everyone to the budget review', speaker_name: 'Olu Owner' }] });

    // Only audio or video can be uploaded, and only by the recorder.
    expect((await owner.agent.post(`/api/recordings/${rec.id}/upload`).attach('file', Buffer.from('hi'), { filename: 'x.txt', contentType: 'text/plain' })).status).toBe(400);
    expect((await guestOfMeeting.agent.post(`/api/recordings/${rec.id}/upload`).attach('file', audio, { filename: 'r.weba', contentType: 'audio/webm' })).status).toBe(403);

    // Server transcription needs the workspace's AI features turned on.
    const status = (await owner.agent.get(`/api/meetings/${meeting.id}/recordings`)).body;
    expect(status.server_transcription).toBe(false);
    await owner.agent.patch('/api/admin/workspace').send({ aiEnabled: true }).expect(200);
    const saved = await owner.agent.post(`/api/recordings/${rec.id}/upload`).field('durationSec', '9').field('transcribe', 'true').attach('file', audio, { filename: 'r.weba', contentType: 'audio/webm' });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ status: 'ready', transcript_status: 'queued', duration_sec: 9, media_url: `/api/recordings/${rec.id}/media` });
    expect((await owner.agent.post(`/api/recordings/${rec.id}/upload`).attach('file', audio, { filename: 'r.weba', contentType: 'audio/webm' })).status).toBe(400);

    await flushJobs(env);
    expect(heard).toEqual([{ mime: 'audio/webm', bytes: audio.length }]);
    transcript = (await guestOfMeeting.agent.get(`/api/recordings/${rec.id}/transcript`)).body;
    expect(transcript.source).toBe('server');
    expect(transcript.segments.map((s: { text: string }) => s.text)).toEqual(['Welcome everyone to the budget review.', 'We agreed to fund the Gbarnga clinic.']);
    expect((await owner.agent.get('/api/notifications')).body.notifications.some((n: { title: string }) => n.title.includes('transcript of “Budget review” is ready'))).toBe(true);

    // Playback streams with byte ranges, to people who can open the meeting only.
    const part = await guestOfMeeting.agent.get(`/api/recordings/${rec.id}/media`).set('Range', 'bytes=0-3');
    expect(part.status).toBe(206);
    expect(part.headers['content-type']).toBe('audio/webm');
    expect(part.headers['content-range']).toBe(`bytes 0-3/${audio.length}`);
    expect((await outsider.agent.get(`/api/recordings/${rec.id}/media`)).status).toBe(404);
    expect((await outsider.agent.get(`/api/recordings/${rec.id}/transcript`)).status).toBe(404);

    // Transcripts are searchable (for people who can see the meeting) and feed the AI summary.
    const found = (await guestOfMeeting.agent.get('/api/search').query({ q: 'Gbarnga', type: 'meetings' })).body.meetings;
    expect(found.map((m: { id: string }) => m.id)).toEqual([meeting.id]);
    expect((await outsider.agent.get('/api/search').query({ q: 'Gbarnga', type: 'meetings' })).body.meetings).toEqual([]);
    await owner.agent.post(`/api/ai/meetings/${meeting.id}/summary`).expect(200);
    expect(prompts.at(-1)).toContain('We agreed to fund the Gbarnga clinic.');

    // Only the recorder or organizer can delete it.
    expect((await guestOfMeeting.agent.delete(`/api/recordings/${rec.id}`)).status).toBe(403);
    await owner.agent.delete(`/api/recordings/${rec.id}`).expect(200);
    expect((await owner.agent.get(`/api/meetings/${meeting.id}/recordings`)).body.recordings).toEqual([]);
  });

  it('works without a transcription service, and stops cleanly', async () => {
    env = setup();
    const owner = await registerOwner(env);
    const meeting = (await owner.agent.post('/api/meetings').send({ title: 'Stand-up', startsAt: soon() })).body;
    const infoRes = await owner.agent.get(`/api/meetings/${meeting.id}/recordings`);
    // Küü's own pages may use the microphone and screen sharing (recordings, voice notes).
    expect(infoRes.headers['permissions-policy']).toContain('microphone=(self)');
    expect(infoRes.headers['permissions-policy']).toContain('display-capture=(self)');
    const info = infoRes.body;
    expect(info).toMatchObject({ available: true, can_record: true, server_transcription: false });
    const rec = (await owner.agent.post(`/api/meetings/${meeting.id}/recordings`).send({ kind: 'screen', consent: true })).body;
    const saved = await owner.agent.post(`/api/recordings/${rec.id}/upload`).field('transcribe', 'true').attach('file', audio, { filename: 'r.webm', contentType: 'video/webm' });
    expect(saved.body).toMatchObject({ status: 'ready', transcript_status: 'none', kind: 'screen' });
    expect((await owner.agent.post(`/api/recordings/${rec.id}/transcribe`)).status).toBe(409);

    const second = (await owner.agent.post(`/api/meetings/${meeting.id}/recordings`).send({ consent: true })).body;
    await owner.agent.post(`/api/recordings/${second.id}/stop`).expect(200);
    expect((await owner.agent.post(`/api/recordings/${second.id}/segments`).send({ segments: [{ startMs: 0, endMs: 1, text: 'late' }] })).status).toBe(400);
    const list = (await owner.agent.get(`/api/meetings/${meeting.id}/recordings`)).body.recordings;
    expect(list.map((r: { status: string }) => r.status)).toEqual(['ready', 'stopped']);

    // Cancelling the meeting removes its recordings.
    await owner.agent.delete(`/api/meetings/${meeting.id}`).expect(200);
    expect(Number((await env.softex.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM meeting_recordings'))!.n)).toBe(0);
  });
});
