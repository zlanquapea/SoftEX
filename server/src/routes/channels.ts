import { Router } from 'express';
import { z } from 'zod';
import {
  atLeast,
  canPostChannel,
  canViewChannel,
  isAdmin,
  isActiveMember,
  isChannelMember,
  isGuest,
  loadChannel,
  loadProject,
  type Auth,
} from '../access.js';
import type { Database, Row } from '../db.js';
import { audit, authOf, notify, publishToChannel, recordActivity, type Ctx } from '../context.js';
import { emitEvent } from '../webhooks.js';
import { badRequest, extractMentionIds, forbidden, newId, notFound, now, parse, filterAsync } from '../util.js';

const ChannelName = z
  .string()
  .trim()
  .toLowerCase()
  .min(2)
  .max(60)
  .regex(/^[a-z0-9][a-z0-9-_]*$/, 'use lowercase letters, numbers, hyphens and underscores');

export async function serializeMessages(db: Database, auth: Auth, rows: Row[]) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const marks = ids.map(() => '?').join(',');
  const reactions = await db.all(`SELECT message_id, emoji, user_id FROM reactions WHERE message_id IN (${marks})`, ...ids);
  const replies = await db.all(
    `SELECT parent_id, COUNT(*) AS n, MAX(created_at) AS last_at FROM messages
      WHERE parent_id IN (${marks}) AND deleted_at IS NULL GROUP BY parent_id`,
    ...ids,
  );
  const saved = new Set(
    (await db.all(`SELECT message_id FROM saved_messages WHERE user_id = ? AND message_id IN (${marks})`, auth.userId, ...ids)).map(
      (r) => r.message_id,
    ),
  );
  const acks = await db.all(`SELECT message_id, user_id FROM acknowledgements WHERE message_id IN (${marks})`, ...ids);
  const files = await db.all(
    `SELECT f.id, f.name, f.message_id, v.mime, v.size FROM files f
       JOIN file_versions v ON v.file_id = f.id AND v.version = f.current_version
      WHERE f.message_id IN (${marks}) AND f.archived_at IS NULL`,
    ...ids,
  );
  const tasks = await db.all(`SELECT id, title, status, source_message_id FROM tasks WHERE source_message_id IN (${marks})`, ...ids);
  const decisions = await db.all(`SELECT id, title, message_id FROM decisions WHERE message_id IN (${marks})`, ...ids);
  const users = new Map(
    (await db
      .all(
        `SELECT id, name, color, title FROM users WHERE id IN (${[...new Set(rows.map((r) => r.user_id))].map(() => '?').join(',')})`,
        ...new Set(rows.map((r) => r.user_id)),
      ))
      .map((u) => [u.id, u]),
  );
  return rows.map((m) => {
    const grouped = new Map<string, { emoji: string; count: number; mine: boolean }>();
    for (const r of reactions.filter((x) => x.message_id === m.id)) {
      const g = grouped.get(r.emoji) ?? { emoji: r.emoji, count: 0, mine: false };
      g.count += 1;
      g.mine ||= r.user_id === auth.userId;
      grouped.set(r.emoji, g);
    }
    const reply = replies.find((x) => x.parent_id === m.id);
    const deleted = !!m.deleted_at;
    const messageAcks = acks.filter((a) => a.message_id === m.id);
    return {
      id: m.id,
      channel_id: m.channel_id,
      parent_id: m.parent_id,
      user: users.get(m.user_id) ?? null,
      body: deleted ? '' : m.body,
      urgent: !!m.urgent,
      created_at: m.created_at,
      edited_at: m.edited_at,
      deleted,
      pinned: !!m.pinned_at,
      saved: saved.has(m.id),
      reactions: deleted ? [] : [...grouped.values()],
      reply_count: reply?.n ?? 0,
      last_reply_at: reply?.last_at ?? null,
      ack_count: messageAcks.length,
      acked: messageAcks.some((a) => a.user_id === auth.userId),
      files: deleted ? [] : files.filter((f) => f.message_id === m.id),
      tasks: tasks.filter((t) => t.source_message_id === m.id),
      decisions: decisions.filter((d) => d.message_id === m.id),
    };
  });
}

async function channelList(db: Database, auth: Auth) {
  const channels = await db.all(
    `SELECT c.*, cm.last_read_at, cm.notify, (cm.user_id IS NOT NULL) AS joined, p.name AS project_name
       FROM channels c
       LEFT JOIN channel_members cm ON cm.channel_id = c.id AND cm.user_id = ?
       LEFT JOIN projects p ON p.id = c.project_id
      WHERE c.workspace_id = ? AND c.archived_at IS NULL
      ORDER BY c.name`,
    auth.userId,
    auth.workspaceId,
  );
  return (await Promise.all((await filterAsync(channels, (c) => canViewChannel(db, auth, c))).map(async (c) => {
      const since = c.last_read_at ?? c.created_at;
      const unread = c.joined
        ? (await db.get(
            `SELECT COUNT(*) AS n FROM messages WHERE channel_id = ? AND created_at > ? AND user_id != ? AND deleted_at IS NULL`,
            c.id,
            since,
            auth.userId,
          ))!.n
        : 0;
      const mentions = c.joined
        ? (await db.get(
            `SELECT COUNT(*) AS n FROM messages WHERE channel_id = ? AND created_at > ? AND deleted_at IS NULL AND instr(body, ?) > 0`,
            c.id,
            since,
            `(${auth.userId})`,
          ))!.n
        : 0;
      const members =
        c.kind === 'dm'
          ? await db.all(
              `SELECT u.id, u.name, u.color, u.status FROM channel_members m JOIN users u ON u.id = m.user_id
                WHERE m.channel_id = ? AND u.id != ?`,
              c.id,
              auth.userId,
            )
          : undefined;
      const lastMessage = await db.get(
        `SELECT created_at FROM messages WHERE channel_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1`,
        c.id,
      );
      return {
        id: c.id,
        name: c.name,
        topic: c.topic,
        kind: c.kind,
        project_id: c.project_id,
        project_name: c.project_name,
        team_id: c.team_id,
        joined: !!c.joined,
        notify: c.notify ?? 'all',
        unread,
        mentions: c.kind === 'dm' ? unread : mentions,
        members,
        last_message_at: lastMessage?.created_at ?? null,
      };
    })));
}

export interface NewMessage {
  body: string;
  parentId?: string | null;
  urgent?: boolean;
  fileIds?: string[];
}

/**
 * Post a message as `auth`: permission checks, persistence, live delivery,
 * webhooks and notifications. Used by the API and by scheduled messages.
 */
export async function postMessage(ctx: Ctx, auth: Auth, channel: Row, input: NewMessage) {
  const { db } = ctx;
  const body = { body: input.body, parentId: input.parentId ?? null, urgent: !!input.urgent, fileIds: input.fileIds ?? [] };
  if (!body.body && !body.fileIds.length) throw badRequest('Write a message or attach a file');
  if (!await canPostChannel(db, auth, channel)) {
    // Anyone who can read an announcement may reply in its thread.
    if (!(channel.kind === 'announcement' && body.parentId && await canViewChannel(db, auth, channel))) {
      throw forbidden(channel.kind === 'announcement' ? 'Only leads and admins can post announcements' : 'You cannot post here');
    }
  }
  let parent: Row | undefined;
  if (body.parentId) {
    parent = await db.get('SELECT * FROM messages WHERE id = ? AND channel_id = ?', body.parentId, channel.id);
    if (!parent || parent.parent_id) throw badRequest('Replies must target a top-level message in this channel');
  }
  const id = newId();
  const createdAt = now();
  await db.transaction(async () => {
    if (channel.kind !== 'dm' && !await isChannelMember(db, channel.id, auth.userId)) {
      await db.run('INSERT OR IGNORE INTO channel_members (channel_id, user_id, joined_at, last_read_at) VALUES (?, ?, ?, ?)', channel.id, auth.userId, now(), now());
    }
    await db.insert('messages', {
      id,
      channel_id: channel.id,
      user_id: auth.userId,
      parent_id: parent?.id ?? null,
      body: body.body,
      urgent: body.urgent,
      created_at: createdAt,
    });
    for (const fileId of body.fileIds) {
      await db.run('UPDATE files SET message_id = ?, channel_id = ? WHERE id = ? AND owner_id = ? AND message_id IS NULL', id, channel.id, fileId, auth.userId);
    }
    await db.run('UPDATE channel_members SET last_read_at = ? WHERE channel_id = ? AND user_id = ?', createdAt, channel.id, auth.userId);
  });
  const [message] = await serializeMessages(db, auth, [(await db.get('SELECT * FROM messages WHERE id = ?', id))!]);
  await publishToChannel(ctx, channel, { type: 'message.created', message });
  await emitEvent(
    ctx,
    auth.workspaceId,
    'message.created',
    { id, channel_id: channel.id, channel_name: channel.name, parent_id: parent?.id ?? null, user_id: auth.userId, body: body.body, created_at: createdAt },
    { channelId: channel.id },
  );

  // Notifications: mentions, DMs, thread replies and announcements, respecting channel preferences.
  const actor = (await db.get('SELECT name FROM users WHERE id = ?', auth.userId))!;
  const where = channel.kind === 'dm' ? 'a direct message' : `#${channel.name}`;
  const link = `/channels/${channel.id}?message=${parent?.id ?? id}`;
  const preview = body.body.replace(/@\[([^\]]+)\]\([0-9a-f-]{36}\)/g, '@$1');
  const notified = new Set<string>([auth.userId]);
  const prefs = new Map((await db.all('SELECT user_id, notify FROM channel_members WHERE channel_id = ?', channel.id)).map((m) => [m.user_id, m.notify]));
  for (const userId of extractMentionIds(body.body)) {
    if (notified.has(userId) || !await isActiveMember(db, auth.workspaceId, userId)) continue;
    const role = (await db.get('SELECT role FROM memberships WHERE workspace_id = ? AND user_id = ?', auth.workspaceId, userId))!.role;
    if (!await canViewChannel(db, { userId, workspaceId: auth.workspaceId, role }, channel)) continue;
    if (prefs.get(userId) === 'none' && !body.urgent) continue;
    notified.add(userId);
    await notify(ctx, auth.workspaceId, { userId, kind: 'mention', title: `${actor.name} mentioned you in ${where}`, body: preview, link, actorId: auth.userId, urgent: body.urgent });
  }
  const recipients = async (ids: string[], kind: string, title: string) => {
    for (const userId of ids) {
      if (notified.has(userId)) continue;
      const pref = prefs.get(userId) ?? 'all';
      if (pref !== 'all' && !body.urgent && kind !== 'announcement') continue;
      notified.add(userId);
      await notify(ctx, auth.workspaceId, { userId, kind, title, body: preview, link, actorId: auth.userId, urgent: body.urgent });
    }
  };
  const memberIds = [...prefs.keys()];
  if (channel.kind === 'dm') await recipients(memberIds, 'dm', `New message from ${actor.name}`);
  if (parent) {
    const threadPeople = (await db.all('SELECT DISTINCT user_id FROM messages WHERE parent_id = ? OR id = ?', parent.id, parent.id)).map((m) => m.user_id);
    await recipients(threadPeople.filter((u) => prefs.has(u)), 'thread', `${actor.name} replied to a thread in ${where}`);
  } else if (channel.kind === 'announcement') {
    await recipients(memberIds, 'announcement', `New announcement in #${channel.name}`);
  } else if (body.urgent) {
    await recipients(memberIds, 'urgent', `Urgent message from ${actor.name} in ${where}`);
  }
  return message;
}

export function channelsRouter(ctx: Ctx) {
  const r = Router();
  const { db } = ctx;

  const addMember = async (channelId: string, userId: string) =>
    await db.run('INSERT OR IGNORE INTO channel_members (channel_id, user_id, joined_at, last_read_at) VALUES (?, ?, ?, ?)', channelId, userId, now(), now());

  r.get('/channels', async (req, res) => res.json(await channelList(db, authOf(req))));

  r.post('/channels', async (req, res) => {
    const auth = authOf(req);
    if (isGuest(auth)) throw forbidden('Guests cannot create channels');
    const body = parse(
      z.object({
        name: ChannelName,
        topic: z.string().max(250).default(''),
        kind: z.enum(['public', 'private', 'announcement']).default('public'),
        projectId: z.string().nullish(),
        teamId: z.string().nullish(),
        memberIds: z.array(z.string()).max(500).default([]),
      }),
      req.body,
    );
    if (body.kind === 'announcement' && !atLeast(auth, 'lead')) throw forbidden('Only leads and admins can create announcement channels');
    if (await db.get('SELECT 1 FROM channels WHERE workspace_id = ? AND name = ? AND kind != ? AND archived_at IS NULL', auth.workspaceId, body.name, 'dm')) {
      throw badRequest('A channel with this name already exists');
    }
    if (body.projectId) await loadProject(db, auth, body.projectId);
    if (body.teamId && !await db.get('SELECT 1 FROM teams WHERE id = ? AND workspace_id = ?', body.teamId, auth.workspaceId)) throw notFound('Team');
    const id = newId();
    await db.transaction(async () => {
      await db.insert('channels', {
        id,
        workspace_id: auth.workspaceId,
        name: body.name,
        topic: body.topic,
        kind: body.kind,
        project_id: body.projectId ?? null,
        team_id: body.teamId ?? null,
        created_by: auth.userId,
        created_at: now(),
      });
      await addMember(id, auth.userId);
      for (const userId of body.memberIds) if (await isActiveMember(db, auth.workspaceId, userId)) await addMember(id, userId);
    });
    await recordActivity(ctx, auth.workspaceId, {
      actorId: auth.userId,
      verb: 'created',
      objectType: 'channel',
      objectId: id,
      channelId: id,
      projectId: body.projectId,
      summary: `created #${body.name}`,
      link: `/channels/${id}`,
    });
    await audit(ctx, auth.workspaceId, auth.userId, 'channel.created', 'channel', id, { kind: body.kind });
    res.status(201).json((await channelList(db, auth)).find((c) => c.id === id));
  });

  r.get('/channels/:id', async (req, res) => {
    const auth = authOf(req);
    const channel = await loadChannel(db, auth, req.params.id);
    const members = await db.all(
      `SELECT u.id, u.name, u.color, u.title, u.status, mm.role FROM channel_members m
         JOIN users u ON u.id = m.user_id
         JOIN memberships mm ON mm.user_id = u.id AND mm.workspace_id = ?
        WHERE m.channel_id = ? AND mm.deactivated_at IS NULL ORDER BY u.name`,
      auth.workspaceId,
      channel.id,
    );
    const summary = (await channelList(db, auth)).find((c) => c.id === channel.id);
    const project = channel.project_id ? await db.get('SELECT id, name, color FROM projects WHERE id = ?', channel.project_id) : null;
    res.json({
      ...summary,
      ...{ id: channel.id, name: channel.name, topic: channel.topic, kind: channel.kind, archived_at: channel.archived_at, created_by: channel.created_by },
      project,
      members,
      can_post: await canPostChannel(db, auth, channel),
      can_manage: channel.created_by === auth.userId || isAdmin(auth),
      ai_excluded: !!channel.ai_excluded,
    });
  });

  r.patch('/channels/:id', async (req, res) => {
    const auth = authOf(req);
    const channel = await loadChannel(db, auth, req.params.id);
    if (channel.kind === 'dm') throw badRequest('Direct messages cannot be renamed');
    if (channel.created_by !== auth.userId && !isAdmin(auth)) throw forbidden('Only the channel creator or an admin can change this channel');
    const body = parse(
      z.object({ name: ChannelName.optional(), topic: z.string().max(250).optional(), archived: z.boolean().optional(), projectId: z.string().nullish() }),
      req.body,
    );
    if (body.projectId) await loadProject(db, auth, body.projectId);
    await db.update('channels', channel.id, {
      name: body.name,
      topic: body.topic,
      project_id: body.projectId === undefined ? undefined : body.projectId,
      archived_at: body.archived === undefined ? undefined : body.archived ? now() : null,
    });
    if (body.archived !== undefined) await audit(ctx, auth.workspaceId, auth.userId, body.archived ? 'channel.archived' : 'channel.restored', 'channel', channel.id);
    await publishToChannel(ctx, channel, { type: 'channel.updated', channelId: channel.id });
    res.json({ ok: true });
  });

  r.post('/channels/:id/join', async (req, res) => {
    const auth = authOf(req);
    const channel = await loadChannel(db, auth, req.params.id);
    if (channel.kind === 'dm' || channel.kind === 'private') throw forbidden('Ask a member to add you to this channel');
    await addMember(channel.id, auth.userId);
    res.json({ ok: true });
  });

  r.post('/channels/:id/leave', async (req, res) => {
    const auth = authOf(req);
    const channel = await loadChannel(db, auth, req.params.id);
    await db.run('DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?', channel.id, auth.userId);
    res.json({ ok: true });
  });

  r.post('/channels/:id/members', async (req, res) => {
    const auth = authOf(req);
    const channel = await loadChannel(db, auth, req.params.id);
    if (channel.kind === 'dm') throw badRequest('Start a new group message to add people');
    if (isGuest(auth)) throw forbidden('Guests cannot add people to channels');
    if (!await isChannelMember(db, channel.id, auth.userId)) throw forbidden('Join the channel first');
    const { userIds } = parse(z.object({ userIds: z.array(z.string()).min(1).max(500) }), req.body);
    for (const userId of userIds) {
      if (!await isActiveMember(db, auth.workspaceId, userId)) continue;
      await addMember(channel.id, userId);
      await notify(ctx, auth.workspaceId, {
        userId,
        kind: 'channel',
        title: `You were added to #${channel.name}`,
        link: `/channels/${channel.id}`,
        actorId: auth.userId,
      });
    }
    await audit(ctx, auth.workspaceId, auth.userId, 'channel.members_added', 'channel', channel.id, { userIds });
    await publishToChannel(ctx, channel, { type: 'channel.updated', channelId: channel.id });
    res.json({ ok: true });
  });

  r.delete('/channels/:id/members/:userId', async (req, res) => {
    const auth = authOf(req);
    const channel = await loadChannel(db, auth, req.params.id);
    if (req.params.userId !== auth.userId && channel.created_by !== auth.userId && !isAdmin(auth)) {
      throw forbidden('Only the channel creator or an admin can remove people');
    }
    await db.run('DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?', channel.id, req.params.userId);
    await audit(ctx, auth.workspaceId, auth.userId, 'channel.member_removed', 'channel', channel.id, { userId: req.params.userId });
    res.json({ ok: true });
  });

  r.patch('/channels/:id/preferences', async (req, res) => {
    const auth = authOf(req);
    const channel = await loadChannel(db, auth, req.params.id);
    const { notify: pref } = parse(z.object({ notify: z.enum(['all', 'mentions', 'none']) }), req.body);
    await db.run('UPDATE channel_members SET notify = ? WHERE channel_id = ? AND user_id = ?', pref, channel.id, auth.userId);
    res.json({ ok: true });
  });

  r.post('/channels/:id/read', async (req, res) => {
    const auth = authOf(req);
    const channel = await loadChannel(db, auth, req.params.id);
    await db.run('UPDATE channel_members SET last_read_at = ? WHERE channel_id = ? AND user_id = ?', now(), channel.id, auth.userId);
    res.json({ ok: true });
  });

  // ----- Direct and group messages -----

  r.post('/dms', async (req, res) => {
    const auth = authOf(req);
    const { userIds } = parse(z.object({ userIds: z.array(z.string()).min(1).max(8) }), req.body);
    const members = [...new Set([auth.userId, ...userIds])].sort();
    for (const id of members) if (!await isActiveMember(db, auth.workspaceId, id)) throw notFound('Person');
    if (isGuest(auth)) {
      // Guests may only message people who share a channel or project with them.
      for (const id of members.filter((m) => m !== auth.userId)) {
        const shares = await db.get(
          `SELECT 1 FROM channel_members a JOIN channel_members b ON a.channel_id = b.channel_id WHERE a.user_id = ? AND b.user_id = ?
           UNION SELECT 1 FROM project_members a JOIN project_members b ON a.project_id = b.project_id WHERE a.user_id = ? AND b.user_id = ?`,
          auth.userId,
          id,
          auth.userId,
          id,
        );
        if (!shares) throw forbidden('Guests can only message people they collaborate with');
      }
    }
    const existing = (await db
      .all(
        `SELECT c.id, GROUP_CONCAT(m.user_id) AS members FROM channels c JOIN channel_members m ON m.channel_id = c.id
          WHERE c.workspace_id = ? AND c.kind = 'dm' GROUP BY c.id`,
        auth.workspaceId,
      ))
      .find((c) => (c.members as string).split(',').sort().join(',') === members.join(','));
    if (existing) return res.json({ id: existing.id });
    const id = newId();
    const names = (await db.all(`SELECT name FROM users WHERE id IN (${members.map(() => '?').join(',')})`, ...members)).map((u) => u.name);
    await db.transaction(async () => {
      await db.insert('channels', {
        id,
        workspace_id: auth.workspaceId,
        name: names.join(', ').slice(0, 60),
        kind: 'dm',
        created_by: auth.userId,
        created_at: now(),
      });
      for (const m of members) await addMember(id, m);
    });
    res.status(201).json({ id });
  });

  // ----- Messages -----

  r.get('/channels/:id/messages', async (req, res) => {
    const auth = authOf(req);
    const channel = await loadChannel(db, auth, req.params.id);
    const q = parse(z.object({ before: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }), req.query);
    const rows = await db.all(
      `SELECT * FROM messages WHERE channel_id = ? AND parent_id IS NULL ${q.before ? 'AND created_at < ?' : ''}
        ORDER BY created_at DESC LIMIT ?`,
      ...(q.before ? [channel.id, q.before, q.limit] : [channel.id, q.limit]),
    );
    res.json({ messages: await serializeMessages(db, auth, rows.reverse()), has_more: rows.length === q.limit });
  });

  r.get('/channels/:id/pins', async (req, res) => {
    const auth = authOf(req);
    const channel = await loadChannel(db, auth, req.params.id);
    const rows = await db.all('SELECT * FROM messages WHERE channel_id = ? AND pinned_at IS NOT NULL AND deleted_at IS NULL ORDER BY pinned_at DESC', channel.id);
    res.json(await serializeMessages(db, auth, rows));
  });

  r.get('/channels/:id/files', async (req, res) => {
    const auth = authOf(req);
    const channel = await loadChannel(db, auth, req.params.id);
    res.json(
      await db.all(
        `SELECT f.id, f.name, f.created_at, v.mime, v.size, u.name AS owner_name FROM files f
           JOIN file_versions v ON v.file_id = f.id AND v.version = f.current_version JOIN users u ON u.id = f.owner_id
          WHERE f.channel_id = ? AND f.archived_at IS NULL ORDER BY f.created_at DESC`,
        channel.id,
      ),
    );
  });

  const loadMessage = async (auth: Auth, id: string) => {
    const message = await db.get('SELECT * FROM messages WHERE id = ?', id);
    if (!message) throw notFound('Message');
    const channel = await loadChannel(db, auth, message.channel_id);
    return { message, channel };
  };

  r.get('/messages/:id/thread', async (req, res) => {
    const auth = authOf(req);
    const { message, channel } = await loadMessage(authOf(req), req.params.id);
    const root = message.parent_id ? (await db.get('SELECT * FROM messages WHERE id = ?', message.parent_id))! : message;
    const replies = await db.all('SELECT * FROM messages WHERE parent_id = ? ORDER BY created_at', root.id);
    res.json({
      channel: { id: channel.id, name: channel.name, kind: channel.kind },
      root: (await serializeMessages(db, auth, [root]))[0],
      replies: await serializeMessages(db, auth, replies),
    });
  });

  r.post('/channels/:id/messages', async (req, res) => {
    const auth = authOf(req);
    const channel = await loadChannel(db, auth, req.params.id);
    const body = parse(
      z.object({
        body: z.string().trim().max(10_000).default(''),
        parentId: z.string().nullish(),
        urgent: z.boolean().default(false),
        fileIds: z.array(z.string()).max(10).default([]),
      }),
      req.body,
    );
    const message = await postMessage(ctx, auth, channel, body);
    res.status(201).json(message);
  });

  const editPolicy = async (auth: Auth, message: Row) => {
    const policy = (await db.get('SELECT message_edit_policy FROM workspaces WHERE id = ?', auth.workspaceId))!.message_edit_policy;
    if (policy === 'none') return false;
    if (policy === 'admins') return isAdmin(auth);
    return message.user_id === auth.userId;
  };

  r.patch('/messages/:id', async (req, res) => {
    const auth = authOf(req);
    const { message, channel } = await loadMessage(auth, req.params.id);
    if (message.deleted_at) throw badRequest('This message was deleted');
    if (!await editPolicy(auth, message)) throw forbidden('Your workspace policy does not allow editing this message');
    const { body } = parse(z.object({ body: z.string().trim().min(1).max(10_000) }), req.body);
    await db.update('messages', message.id, { body, edited_at: now() });
    const [updated] = await serializeMessages(db, auth, [(await db.get('SELECT * FROM messages WHERE id = ?', message.id))!]);
    await publishToChannel(ctx, channel, { type: 'message.updated', messageId: message.id, channelId: channel.id, parentId: message.parent_id });
    res.json(updated);
  });

  r.delete('/messages/:id', async (req, res) => {
    const auth = authOf(req);
    const { message, channel } = await loadMessage(auth, req.params.id);
    const allowed = message.user_id === auth.userId ? await editPolicy(auth, message) || isAdmin(auth) : isAdmin(auth);
    if (!allowed) throw forbidden('You cannot delete this message');
    await db.update('messages', message.id, { deleted_at: now(), pinned_at: null });
    if (message.user_id !== auth.userId) await audit(ctx, auth.workspaceId, auth.userId, 'message.deleted_by_admin', 'message', message.id, { channelId: channel.id });
    await publishToChannel(ctx, channel, { type: 'message.updated', messageId: message.id, channelId: channel.id, parentId: message.parent_id });
    res.json({ ok: true });
  });

  r.post('/messages/:id/reactions', async (req, res) => {
    const auth = authOf(req);
    const { message, channel } = await loadMessage(auth, req.params.id);
    const { emoji } = parse(z.object({ emoji: z.string().min(1).max(16) }), req.body);
    const exists = await db.get('SELECT 1 FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?', message.id, auth.userId, emoji);
    if (exists) await db.run('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?', message.id, auth.userId, emoji);
    else await db.insert('reactions', { message_id: message.id, user_id: auth.userId, emoji });
    await publishToChannel(ctx, channel, { type: 'message.updated', messageId: message.id, channelId: channel.id, parentId: message.parent_id });
    res.json({ ok: true });
  });

  r.post('/messages/:id/pin', async (req, res) => {
    const auth = authOf(req);
    const { message, channel } = await loadMessage(auth, req.params.id);
    if (!await canPostChannel(db, auth, channel)) throw forbidden();
    await db.update('messages', message.id, message.pinned_at ? { pinned_at: null, pinned_by: null } : { pinned_at: now(), pinned_by: auth.userId });
    await publishToChannel(ctx, channel, { type: 'message.updated', messageId: message.id, channelId: channel.id, parentId: message.parent_id });
    res.json({ pinned: !message.pinned_at });
  });

  r.post('/messages/:id/save', async (req, res) => {
    const auth = authOf(req);
    const { message } = await loadMessage(auth, req.params.id);
    const exists = await db.get('SELECT 1 FROM saved_messages WHERE user_id = ? AND message_id = ?', auth.userId, message.id);
    if (exists) await db.run('DELETE FROM saved_messages WHERE user_id = ? AND message_id = ?', auth.userId, message.id);
    else await db.insert('saved_messages', { user_id: auth.userId, message_id: message.id, created_at: now() });
    res.json({ saved: !exists });
  });

  r.get('/saved', async (req, res) => {
    const auth = authOf(req);
    const rows = (await filterAsync((await db
      .all(
        `SELECT m.*, c.name AS channel_name, c.kind AS channel_kind FROM saved_messages s JOIN messages m ON m.id = s.message_id
           JOIN channels c ON c.id = m.channel_id WHERE s.user_id = ? AND m.deleted_at IS NULL ORDER BY s.created_at DESC`,
        auth.userId,
      )), async (m) => canViewChannel(db, auth, (await db.get('SELECT * FROM channels WHERE id = ?', m.channel_id))!)));
    const serialized = await serializeMessages(db, auth, rows);
    res.json(serialized.map((m, i) => ({ ...m, channel_name: rows[i].channel_name, channel_kind: rows[i].channel_kind })));
  });

  r.post('/messages/:id/ack', async (req, res) => {
    const auth = authOf(req);
    const { message, channel } = await loadMessage(auth, req.params.id);
    if (channel.kind !== 'announcement') throw badRequest('Only announcements can be acknowledged');
    await db.run('INSERT OR IGNORE INTO acknowledgements (message_id, user_id, created_at) VALUES (?, ?, ?)', message.id, auth.userId, now());
    await publishToChannel(ctx, channel, { type: 'message.updated', messageId: message.id, channelId: channel.id, parentId: null });
    res.json({ ok: true });
  });

  r.get('/messages/:id/acks', async (req, res) => {
    const auth = authOf(req);
    const { message, channel } = await loadMessage(auth, req.params.id);
    if (message.user_id !== auth.userId && !isAdmin(auth)) throw forbidden('Only the author or an admin can view acknowledgements');
    const members = await db.all(
      `SELECT u.id, u.name, u.color, a.created_at AS acked_at FROM channel_members cm JOIN users u ON u.id = cm.user_id
         JOIN memberships mm ON mm.user_id = u.id AND mm.workspace_id = ? AND mm.deactivated_at IS NULL
         LEFT JOIN acknowledgements a ON a.message_id = ? AND a.user_id = u.id
        WHERE cm.channel_id = ? ORDER BY a.created_at IS NULL, u.name`,
      auth.workspaceId,
      message.id,
      channel.id,
    );
    res.json(members);
  });

  return r;
}
