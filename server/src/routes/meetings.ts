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
import { forbidden, newId, notFound, now, parse, filterAsync, randomToken, sha256 } from '../util.js';
import { queueEmail } from '../mailer.js';
import { serializeTasks } from './tasks.js';
import { serializeMessages } from './channels.js';

type IcsMeeting = { id: string; title: string; agenda: string; starts_at: string; duration_min: number; video_url: string; location: string };

function vevent(m: IcsMeeting, publicUrl: string, cancelled = false) {
  const end = new Date(new Date(m.starts_at).getTime() + m.duration_min * 60_000).toISOString();
  return [
    'BEGIN:VEVENT',
    `UID:${m.id}@softex`,
    `DTSTAMP:${icsDate(new Date().toISOString())}`,
    `DTSTART:${icsDate(m.starts_at)}`,
    `DTEND:${icsDate(end)}`,
    `SUMMARY:${icsEscape(m.title)}`,
    `DESCRIPTION:${icsEscape(`${m.agenda}\n\n${publicUrl}/meetings/${m.id}`)}`,
    `LOCATION:${icsEscape(m.video_url || m.location)}`,
    `URL:${publicUrl}/meetings/${m.id}`,
    cancelled ? 'STATUS:CANCELLED' : 'STATUS:CONFIRMED',
    'END:VEVENT',
  ];
}

/** Lines longer than 75 octets are folded, as RFC 5545 requires. */
function icsLines(lines: string[]) {
  const out: string[] = [];
  for (const line of lines) {
    let rest = Buffer.from(line, 'utf8');
    let first = true;
    while (rest.length > (first ? 75 : 74)) {
      let cut = first ? 75 : 74;
      while (cut > 0 && (rest[cut] & 0xc0) === 0x80) cut--; // don't split a UTF-8 character
      out.push((first ? '' : ' ') + rest.subarray(0, cut).toString('utf8'));
      rest = rest.subarray(cut);
      first = false;
    }
    out.push((first ? '' : ' ') + rest.toString('utf8'));
  }
  return out.join('\r\n') + '\r\n';
}

/** iCalendar invite used for both the download endpoint and email attachments. */
export function buildIcs(m: IcsMeeting, publicUrl: string, method: 'PUBLISH' | 'REQUEST' | 'CANCEL' = 'PUBLISH') {
  return icsLines(['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//SoftEX//Meetings//EN', `METHOD:${method}`, ...vevent(m, publicUrl, method === 'CANCEL'), 'END:VCALENDAR']);
}

/**
 * Calendar subscription (§5.4 calendar integration): a private link that Google Calendar,
 * Outlook or Apple Calendar poll for the person's meetings. The link is the credential,
 * so only its hash is stored; it stops working when the person resets or turns it off,
 * leaves the workspace, or the workspace is suspended.
 */
export function calendarFeedRouter(ctx: Ctx) {
  const r = Router();
  const { db } = ctx;
  r.get('/calendar/:token', async (req, res) => {
    const token = String(req.params.token).replace(/\.ics$/, '');
    const feed = await db.get(
      `SELECT f.token_hash, f.user_id, f.workspace_id, m.role, w.name AS workspace_name FROM calendar_feeds f
         JOIN memberships m ON m.workspace_id = f.workspace_id AND m.user_id = f.user_id
         JOIN workspaces w ON w.id = f.workspace_id
        WHERE f.token_hash = ? AND m.deactivated_at IS NULL AND w.suspended_at IS NULL
          AND (m.guest_expires_at IS NULL OR m.guest_expires_at > ?)`,
      sha256(token),
      now(),
    );
    if (!feed) throw notFound('Calendar');
    const auth: Auth = { userId: feed.user_id, workspaceId: feed.workspace_id, role: feed.role };
    const from = new Date(Date.now() - 60 * 86_400_000).toISOString();
    const to = new Date(Date.now() + 366 * 86_400_000).toISOString();
    const rows = await db.all(
      `SELECT DISTINCT m.* FROM meetings m LEFT JOIN meeting_participants p ON p.meeting_id = m.id AND p.user_id = ?
        WHERE m.workspace_id = ? AND m.starts_at >= ? AND m.starts_at <= ?
          AND (m.organizer_id = ? OR (p.user_id IS NOT NULL AND p.response != 'declined'))
        ORDER BY m.starts_at LIMIT 1000`,
      feed.user_id,
      feed.workspace_id,
      from,
      to,
      feed.user_id,
    );
    const visible = await filterAsync(rows, (m) => canViewMeeting(db, auth, m));
    await db.run('UPDATE calendar_feeds SET last_used_at = ? WHERE token_hash = ?', now(), feed.token_hash);
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(
      icsLines([
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//SoftEX//Meetings//EN',
        'METHOD:PUBLISH',
        'CALSCALE:GREGORIAN',
        `X-WR-CALNAME:${icsEscape(`SoftEX · ${feed.workspace_name}`)}`,
        'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
        'X-PUBLISHED-TTL:PT1H',
        ...visible.flatMap((m) => vevent(m as IcsMeeting, ctx.config.publicUrl)),
        'END:VCALENDAR',
      ]),
    );
  });
  return r;
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

  // The person's private calendar subscription link for this workspace.
  r.get('/me/calendar-feed', async (req, res) => {
    const auth = authOf(req);
    const feed = await db.get('SELECT created_at, last_used_at FROM calendar_feeds WHERE user_id = ? AND workspace_id = ?', auth.userId, auth.workspaceId);
    res.json({ enabled: !!feed, created_at: feed?.created_at ?? null, last_used_at: feed?.last_used_at ?? null });
  });

  /** Create the link, or replace it (the old one stops working). The link is only shown now. */
  r.post('/me/calendar-feed', async (req, res) => {
    const auth = authOf(req);
    const token = randomToken();
    await db.transaction(async () => {
      await db.run('DELETE FROM calendar_feeds WHERE user_id = ? AND workspace_id = ?', auth.userId, auth.workspaceId);
      await db.insert('calendar_feeds', { token_hash: sha256(token), user_id: auth.userId, workspace_id: auth.workspaceId, created_at: now() });
    });
    const url = `${ctx.config.publicUrl}/api/calendar/${token}.ics`;
    res.status(201).json({ url, webcal: url.replace(/^https?:/, 'webcal:') });
  });

  r.delete('/me/calendar-feed', async (req, res) => {
    const auth = authOf(req);
    await db.run('DELETE FROM calendar_feeds WHERE user_id = ? AND workspace_id = ?', auth.userId, auth.workspaceId);
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
