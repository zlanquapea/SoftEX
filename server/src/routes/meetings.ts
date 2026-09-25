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
import { minutesAfter, type Row } from '../db.js';
import { authOf, notify, publishToChannel, recordActivity, userSummary, type Ctx } from '../context.js';
import { emitEvent } from '../webhooks.js';
import { forbidden, newId, notFound, now, parse, filterAsync } from '../util.js';
import { queueEmail } from '../mailer.js';
import { serializeTasks } from './tasks.js';
import { serializeMessages } from './channels.js';

/** iCalendar invite used for both the download endpoint and email attachments. */
export function buildIcs(m: { id: string; title: string; agenda: string; starts_at: string; duration_min: number; video_url: string; location: string }, publicUrl: string, method: 'PUBLISH' | 'REQUEST' | 'CANCEL' = 'PUBLISH') {
  const end = new Date(new Date(m.starts_at).getTime() + m.duration_min * 60_000).toISOString();
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//SoftEX//Meetings//EN',
    `METHOD:${method}`,
    'BEGIN:VEVENT',
    `UID:${m.id}@softex`,
    `DTSTAMP:${icsDate(new Date().toISOString())}`,
    `DTSTART:${icsDate(m.starts_at)}`,
    `DTEND:${icsDate(end)}`,
    `SUMMARY:${icsEscape(m.title)}`,
    `DESCRIPTION:${icsEscape(`${m.agenda}\n\n${publicUrl}/meetings/${m.id}`)}`,
    `LOCATION:${icsEscape(m.video_url || m.location)}`,
    `URL:${publicUrl}/meetings/${m.id}`,
    method === 'CANCEL' ? 'STATUS:CANCELLED' : 'STATUS:CONFIRMED',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
}

const icsDate = (iso: string) => iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const icsEscape = (s: string) => s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[,;]/g, (c) => `\\${c}`);

export function meetingsRouter(ctx: Ctx) {
  const r = Router();
  const { db } = ctx;

  /** Calendar invitations by email, so meetings land in Outlook, Google Calendar or Apple Calendar. */
  const emailInvites = async (m: Row, userIds: string[], method: 'REQUEST' | 'CANCEL') => {
    if (!userIds.length) return;
    const organizer = (await db.get('SELECT name FROM users WHERE id = ?', m.organizer_id))!.name;
    const when = new Date(m.starts_at).toUTCString().replace('GMT', 'UTC');
    for (const u of await db.all(`SELECT id, email, timezone FROM users WHERE id IN (${userIds.map(() => '?').join(',')})`, ...userIds)) {
      let local = when;
      try {
        local = new Date(m.starts_at).toLocaleString('en-GB', { timeZone: u.timezone, dateStyle: 'full', timeStyle: 'short' }) + ` (${u.timezone})`;
      } catch {
        /* keep UTC */
      }
      await queueEmail(ctx, {
        workspaceId: m.workspace_id,
        kind: method === 'CANCEL' ? 'meeting_cancelled' : 'meeting_invite',
        to: u.email,
        subject: method === 'CANCEL' ? `Cancelled: ${m.title}` : `Invitation: ${m.title}`,
        text:
          method === 'CANCEL'
            ? `${organizer} cancelled “${m.title}” scheduled for ${local}.`
            : `${organizer} invited you to “${m.title}”.\n\nWhen: ${local}, ${m.duration_min} minutes${m.location ? `\nWhere: ${m.location}` : ''}${m.video_url ? `\nVideo: ${m.video_url}` : ''}${m.agenda ? `\n\nAgenda:\n${m.agenda}` : ''}`,
        action: method === 'CANCEL' ? undefined : { label: 'Open meeting', url: `${ctx.config.publicUrl}/meetings/${m.id}` },
        attachments: [{ filename: 'invite.ics', content: buildIcs(m as any, ctx.config.publicUrl, method), contentType: `text/calendar; method=${method}` }],
      });
    }
  };

  const loadMeeting = async (auth: Auth, id: string) => {
    const meeting = await db.get('SELECT * FROM meetings WHERE id = ?', id);
    if (!meeting || !await canViewMeeting(db, auth, meeting)) throw notFound('Meeting');
    return meeting;
  };

  const participants = async (meetingId: string) =>
    await db.all(
      `SELECT u.id, u.name, u.color, u.timezone, p.response FROM meeting_participants p JOIN users u ON u.id = p.user_id
        WHERE p.meeting_id = ? ORDER BY u.name`,
      meetingId,
    );

  const summary = async (m: Row) => ({
    id: m.id,
    title: m.title,
    starts_at: m.starts_at,
    ends_at: new Date(new Date(m.starts_at).getTime() + m.duration_min * 60_000).toISOString(),
    duration_min: m.duration_min,
    location: m.location,
    video_url: m.video_url,
    project: m.project_id ? await db.get('SELECT id, name, color FROM projects WHERE id = ?', m.project_id) ?? null : null,
    channel_id: m.channel_id,
    organizer: await userSummary(db, m.organizer_id),
    started_at: m.started_at,
    ended_at: m.ended_at,
    participants: await participants(m.id),
  });

  const isOrganizerOrManager = async (auth: Auth, m: Row) => {
    if (m.organizer_id === auth.userId || isAdmin(auth)) return true;
    if (m.project_id) {
      const project = await db.get('SELECT * FROM projects WHERE id = ?', m.project_id);
      return !!project && await canManageProject(db, auth, project);
    }
    return false;
  };

  const canTakeNotes = async (auth: Auth, m: Row) => {
    if (await isOrganizerOrManager(auth, m)) return true;
    if (await db.get('SELECT 1 FROM meeting_participants WHERE meeting_id = ? AND user_id = ?', m.id, auth.userId)) return true;
    if (m.project_id) {
      const project = await db.get('SELECT * FROM projects WHERE id = ?', m.project_id);
      return !!project && await canContributeProject(db, auth, project);
    }
    return false;
  };

  r.get('/meetings', async (req, res) => {
    const auth = authOf(req);
    const q = parse(z.object({ range: z.enum(['upcoming', 'past', 'all']).default('upcoming'), projectId: z.string().optional() }), req.query);
    if (q.projectId) await loadProject(db, auth, q.projectId);
    const t = now();
    const [ends, at] = minutesAfter(db, 'm.starts_at', 'm.duration_min');
    const cond = q.range === 'upcoming' ? `AND m.ended_at IS NULL AND ${ends} >= ${at}` : q.range === 'past' ? `AND (m.ended_at IS NOT NULL OR ${ends} < ${at})` : '';
    const params: string[] = [auth.workspaceId];
    if (q.range !== 'all') params.push(t);
    if (q.projectId) params.push(q.projectId);
    const rows = (await filterAsync((await db
      .all(
        `SELECT m.* FROM meetings m WHERE m.workspace_id = ? ${cond} ${q.projectId ? 'AND m.project_id = ?' : ''}
          ORDER BY m.starts_at ${q.range === 'past' ? 'DESC' : 'ASC'} LIMIT 500`,
        ...params,
      )), (m) => canViewMeeting(db, auth, m)));
    res.json((await Promise.all(rows.slice(0, 200).map(summary))));
  });

  r.post('/meetings', async (req, res) => {
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
      const project = await loadProject(db, auth, body.projectId);
      if (!await canContributeProject(db, auth, project)) throw forbidden();
    }
    let channel: Row | null = null;
    if (body.channelId) {
      channel = await loadChannel(db, auth, body.channelId);
      if (!await canPostChannel(db, auth, channel)) throw forbidden();
    }
    if (isGuest(auth) && !body.projectId && !body.channelId) throw forbidden('Guests can schedule meetings only from shared channels or projects');
    const id = newId();
    const startsAt = new Date(body.startsAt).toISOString();
    const people = (await filterAsync([...new Set([auth.userId, ...body.participantIds])], (u) => isActiveMember(db, auth.workspaceId, u)));
    await db.transaction(async () => {
      await db.insert('meetings', {
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
        await db.insert('meeting_participants', { meeting_id: id, user_id: u, response: u === auth.userId ? 'accepted' : 'pending' });
      }
    });
    const organizer = (await db.get('SELECT name FROM users WHERE id = ?', auth.userId))!;
    for (const u of people) {
      await notify(ctx, auth.workspaceId, { userId: u, kind: 'meeting', title: `${organizer.name} invited you to “${body.title}”`, body: new Date(startsAt).toUTCString(), link: `/meetings/${id}`, actorId: auth.userId });
    }
    await emailInvites((await db.get('SELECT * FROM meetings WHERE id = ?', id))!, people.filter((u) => u !== auth.userId), 'REQUEST');
    if (channel) {
      const messageId = newId();
      await db.insert('messages', {
        id: messageId,
        channel_id: channel.id,
        user_id: auth.userId,
        body: `📅 Scheduled a meeting: **${body.title}** — [open meeting](/meetings/${id})`,
        created_at: now(),
      });
      const [message] = await serializeMessages(db, auth, [(await db.get('SELECT * FROM messages WHERE id = ?', messageId))!]);
      await publishToChannel(ctx, channel, { type: 'message.created', message });
    }
    await recordActivity(ctx, auth.workspaceId, {
      actorId: auth.userId,
      verb: 'scheduled',
      objectType: 'meeting',
      objectId: id,
      projectId: body.projectId ?? channel?.project_id,
      channelId: body.channelId,
      summary: `scheduled “${body.title}”`,
      link: `/meetings/${id}`,
    });
    res.status(201).json(await summary((await db.get('SELECT * FROM meetings WHERE id = ?', id))!));
  });

  r.get('/meetings/:id', async (req, res) => {
    const auth = authOf(req);
    const m = await loadMeeting(auth, req.params.id);
    const tasks = await serializeTasks(
      db,
      (await filterAsync((await db.all('SELECT * FROM tasks WHERE meeting_id = ? ORDER BY created_at', m.id)), (t) => canViewTask(db, auth, t))),
    );
    const decisions = (await filterAsync((await db
      .all(`SELECT d.*, u.name AS decided_by_name FROM decisions d JOIN users u ON u.id = d.decided_by WHERE meeting_id = ? ORDER BY created_at`, m.id)), (d) => canViewDecision(db, auth, d)));
    const channel = m.channel_id ? await db.get('SELECT id, name, kind FROM channels WHERE id = ?', m.channel_id) : null;
    res.json({
      ...await summary(m),
      agenda: m.agenda,
      notes: m.notes,
      tasks,
      decisions,
      channel,
      my_response: (await db.get('SELECT response FROM meeting_participants WHERE meeting_id = ? AND user_id = ?', m.id, auth.userId))?.response ?? null,
      can_manage: await isOrganizerOrManager(auth, m),
      can_take_notes: await canTakeNotes(auth, m),
    });
  });

  r.patch('/meetings/:id', async (req, res) => {
    const auth = authOf(req);
    const m = await loadMeeting(auth, req.params.id);
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
    if (managing && !await isOrganizerOrManager(auth, m)) throw forbidden('Only the organizer can change the meeting details');
    if ((body.notes !== undefined || body.agenda !== undefined) && !await canTakeNotes(auth, m)) throw forbidden('Only participants can edit the agenda and notes');
    await db.update('meetings', m.id, {
      title: body.title,
      agenda: body.agenda,
      notes: body.notes,
      starts_at: body.startsAt ? new Date(body.startsAt).toISOString() : undefined,
      duration_min: body.durationMin,
      location: body.location,
    });
    if (body.participantIds) {
      const current = new Set((await participants(m.id)).map((p) => p.id));
      for (const u of body.participantIds) {
        if (current.has(u) || !await isActiveMember(db, auth.workspaceId, u)) continue;
        await db.insert('meeting_participants', { meeting_id: m.id, user_id: u });
        await notify(ctx, auth.workspaceId, { userId: u, kind: 'meeting', title: `You were invited to “${body.title ?? m.title}”`, link: `/meetings/${m.id}`, actorId: auth.userId });
      }
      for (const u of current) {
        if (!body.participantIds.includes(u) && u !== m.organizer_id) await db.run('DELETE FROM meeting_participants WHERE meeting_id = ? AND user_id = ?', m.id, u);
      }
    }
    if (body.startsAt && body.startsAt !== m.starts_at) {
      for (const p of await participants(m.id)) {
        await notify(ctx, auth.workspaceId, { userId: p.id, kind: 'meeting', title: `“${m.title}” was rescheduled`, body: new Date(body.startsAt).toUTCString(), link: `/meetings/${m.id}`, actorId: auth.userId });
      }
    }
    await ctx.hub.publish(auth.workspaceId, { type: 'meeting.updated', meetingId: m.id }, { kind: 'meeting', meetingId: m.id });
    res.json(await summary((await db.get('SELECT * FROM meetings WHERE id = ?', m.id))!));
  });

  r.post('/meetings/:id/respond', async (req, res) => {
    const auth = authOf(req);
    const m = await loadMeeting(auth, req.params.id);
    const { response } = parse(z.object({ response: z.enum(['accepted', 'declined', 'pending']) }), req.body);
    const changed = await db.run('UPDATE meeting_participants SET response = ? WHERE meeting_id = ? AND user_id = ?', response, m.id, auth.userId);
    if (!changed.changes) await db.insert('meeting_participants', { meeting_id: m.id, user_id: auth.userId, response });
    res.json({ ok: true });
  });

  r.post('/meetings/:id/start', async (req, res) => {
    const auth = authOf(req);
    const m = await loadMeeting(auth, req.params.id);
    if (!await canTakeNotes(auth, m)) throw forbidden();
    if (!m.started_at) {
      await db.update('meetings', m.id, { started_at: now() });
      const starter = (await db.get('SELECT name FROM users WHERE id = ?', auth.userId))!;
      for (const p of await participants(m.id)) {
        if (p.response === 'declined') continue;
        await notify(ctx, auth.workspaceId, { userId: p.id, kind: 'meeting', title: `“${m.title}” has started`, body: `${starter.name} started the meeting`, link: `/meetings/${m.id}`, actorId: auth.userId, urgent: true });
      }
    }
    await ctx.hub.publish(auth.workspaceId, { type: 'meeting.updated', meetingId: m.id }, { kind: 'meeting', meetingId: m.id });
    res.json({ video_url: m.video_url });
  });

  r.post('/meetings/:id/end', async (req, res) => {
    const auth = authOf(req);
    const m = await loadMeeting(auth, req.params.id);
    if (!await canTakeNotes(auth, m)) throw forbidden();
    await db.update('meetings', m.id, { ended_at: now(), started_at: m.started_at ?? now() });
    const followUps = (await db.get('SELECT COUNT(*) AS n FROM tasks WHERE meeting_id = ?', m.id))!.n;
    const decisions = (await db.get('SELECT COUNT(*) AS n FROM decisions WHERE meeting_id = ?', m.id))!.n;
    await emitEvent(ctx, auth.workspaceId, 'meeting.ended', { id: m.id, title: m.title, project_id: m.project_id, decisions, follow_up_tasks: followUps }, { projectId: m.project_id, channelId: m.channel_id });
    await recordActivity(ctx, auth.workspaceId, {
      actorId: auth.userId,
      verb: 'ended',
      objectType: 'meeting',
      objectId: m.id,
      projectId: m.project_id,
      channelId: m.channel_id,
      summary: `wrapped up “${m.title}” with ${decisions} decision(s) and ${followUps} follow-up task(s)`,
      link: `/meetings/${m.id}`,
    });
    for (const p of await participants(m.id)) {
      await notify(ctx, auth.workspaceId, { userId: p.id, kind: 'meeting', title: `Notes and follow-ups from “${m.title}”`, body: `${decisions} decision(s), ${followUps} follow-up task(s)`, link: `/meetings/${m.id}`, actorId: auth.userId });
    }
    await ctx.hub.publish(auth.workspaceId, { type: 'meeting.updated', meetingId: m.id }, { kind: 'meeting', meetingId: m.id });
    res.json({ ok: true });
  });

  r.delete('/meetings/:id', async (req, res) => {
    const auth = authOf(req);
    const m = await loadMeeting(auth, req.params.id);
    if (!await isOrganizerOrManager(auth, m)) throw forbidden('Only the organizer can cancel this meeting');
    const people = await participants(m.id);
    await emailInvites(m, people.map((p) => p.id).filter((u) => u !== auth.userId), 'CANCEL');
    await db.run('DELETE FROM meetings WHERE id = ?', m.id);
    for (const p of people) {
      await notify(ctx, auth.workspaceId, { userId: p.id, kind: 'meeting', title: `“${m.title}” was cancelled`, link: '/meetings', actorId: auth.userId });
    }
    res.json({ ok: true });
  });

  /** Calendar integration: an iCalendar invite importable into any calendar client. */
  r.get('/meetings/:id/ics', async (req, res) => {
    const auth = authOf(req);
    const m = await loadMeeting(auth, req.params.id);
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="meeting-${m.id.slice(0, 8)}.ics"`);
    res.send(buildIcs(m as Parameters<typeof buildIcs>[0], ctx.config.publicUrl));
  });

  return r;
}
