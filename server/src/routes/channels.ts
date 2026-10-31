import { Router } from 'express';
import { z } from 'zod';
import {
  atLeast,
  canPostChannel,
  canViewChannel,
  canViewMeeting,
  canViewTask,
  isAdmin,
  isActiveMember,
  isChannelMember,
  isGuest,
  loadChannel,
  loadProject,
  type Auth,
} from '../access.js';
import type { Database, Row } from '../db.js';
import { audit, authOf, notify, publishToChannel, readNotificationGroup, recordActivity, removeUnusedStorage, type Ctx } from '../context.js';
import { emitEvent } from '../webhooks.js';
import { extractTeamMentionIds, syncTeamChannels } from '../teams.js';
import { sendAutoReplies } from '../away.js';
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
  // In your Saved: the item itself, or a message you saved a copy of (copies point at the original).
  const mySaved = await db.get('SELECT id FROM channels WHERE workspace_id = ? AND created_by = ? AND personal = 1', auth.workspaceId, auth.userId);
  const roots = [...new Set(rows.map((r) => r.forwarded_from ?? r.id))];
  const savedCopies = new Set(
    mySaved
      ? (await db.all(
          `SELECT forwarded_from FROM messages WHERE channel_id = ? AND deleted_at IS NULL AND forwarded_from IN (${roots.map(() => '?').join(',')})`,
          mySaved.id,
          ...roots,
        )).map((r) => r.forwarded_from)
      : [],
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
  const polls = await pollsFor(db, auth, ids);
  const forwardIds = [...new Set(rows.map((r) => r.forwarded_from).filter(Boolean))];
  const forwards = new Map(
    forwardIds.length
      ? (await db.all(
          `SELECT m.id, m.body, m.created_at, m.edited_at, m.deleted_at, m.channel_id, c.workspace_id, c.name AS channel_name, c.kind AS channel_kind,
                  c.personal AS channel_personal, u.name AS user_name, u.color AS user_color
             FROM messages m JOIN channels c ON c.id = m.channel_id JOIN users u ON u.id = m.user_id WHERE m.id IN (${forwardIds.map(() => '?').join(',')})`,
          ...forwardIds,
        )).map((f) => [f.id, f])
      : [],
  );
  // Where a forward came from is only shown to people who can open that conversation themselves.
  const canSee = new Map<string, boolean>();
  for (const f of forwards.values()) {
    if (!canSee.has(f.channel_id)) canSee.set(f.channel_id, await canViewChannel(db, auth, { id: f.channel_id, workspace_id: f.workspace_id, kind: f.channel_kind }));
  }
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
      saved: saved.has(m.id) || savedCopies.has(m.forwarded_from ?? m.id) || (!!mySaved && m.channel_id === mySaved.id),
      reactions: deleted ? [] : [...grouped.values()],
      reply_count: reply?.n ?? 0,
      last_reply_at: reply?.last_at ?? null,
      ack_count: messageAcks.length,
      acked: messageAcks.some((a) => a.user_id === auth.userId),
      files: deleted ? [] : files.filter((f) => f.message_id === m.id),
      tasks: tasks.filter((t) => t.source_message_id === m.id),
      decisions: decisions.filter((d) => d.message_id === m.id),
      poll: deleted ? null : polls.get(m.id) ?? null,
      forwarded: deleted || (!m.forwarded_from && !m.forward_snapshot) ? null : forwardView(m, forwards.get(m.forwarded_from), canSee),
      auto_reply: !!m.auto_reply,
      // Lets the sender's outbox match a sent message to the one it was waiting for.
      client_id: m.user_id === auth.userId ? m.client_id ?? null : null,
    };
  });
}

export interface ForwardSnapshot {
  message_id: string;
  body: string;
  created_at: string;
  user_id: string;
  user_name: string;
  user_color: string;
  files: { name: string; mime: string; size: number }[];
}

function parseSnapshot(raw: unknown): ForwardSnapshot | null {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    return JSON.parse(raw) as ForwardSnapshot;
  } catch {
    return null;
  }
}

/**
 * A forwarded message as shown in its new place. A forward is a copy: it shows what the original said when it
 * was forwarded, whoever reads it. Where it came from (and a link back) is only shown to people who can open
 * that conversation; nobody else learns its name, or whether it still exists.
 */
function forwardView(m: Row, src: Row | undefined, canSee: Map<string, boolean>) {
  const snap = parseSnapshot(m.forward_snapshot);
  const visible = !!src && !!canSee.get(src.channel_id);
  const source =
    visible && !src!.deleted_at
      ? {
          message_id: src!.id,
          channel_id: src!.channel_id,
          kind: src!.channel_kind,
          personal: !!src!.channel_personal,
          channel_name: src!.channel_personal ? 'Saved' : src!.channel_kind === 'dm' ? null : src!.channel_name,
        }
      : null;
  // Older forwards (before copies) pointed at the live original.
  if (!snap) {
    if (!src) return { deleted: true };
    if (src.deleted_at) return { deleted: true };
    return {
      copy: false,
      id: source ? src.id : undefined,
      deleted: false,
      body: src.body,
      created_at: src.created_at,
      channel_id: source?.channel_id,
      channel_name: source && !source.personal ? source.channel_name : null,
      user: { name: src.user_name, color: src.user_color },
      source,
      original_deleted: false,
      original_edited: false,
    };
  }
  return {
    copy: true,
    id: source ? src!.id : undefined,
    deleted: false,
    body: snap.body,
    created_at: snap.created_at,
    channel_id: source?.channel_id,
    channel_name: source && !source.personal ? source.channel_name : null,
    user: { name: snap.user_name, color: snap.user_color },
    source,
    original_deleted: visible && !!src!.deleted_at,
    original_edited: visible && !src!.deleted_at && !!src!.edited_at && src!.edited_at > m.created_at,
  };
}

/** Each person's private Saved conversation in this workspace, made the first time it's needed. */
export async function savedChannel(db: Database, auth: Auth): Promise<Row> {
  const find = () => db.get('SELECT * FROM channels WHERE workspace_id = ? AND created_by = ? AND personal = 1', auth.workspaceId, auth.userId);
  const found = await find();
  if (found) return found;
  // A direct message with only yourself (from before Saved existed) becomes Saved, keeping what's in it.
  const selfDm = await db.get(
    `SELECT c.id FROM channels c WHERE c.workspace_id = ? AND c.kind = 'dm' AND c.personal = 0 AND c.created_by = ?
        AND NOT EXISTS (SELECT 1 FROM channel_members m WHERE m.channel_id = c.id AND m.user_id != ?)
        AND NOT EXISTS (SELECT 1 FROM messages x WHERE x.channel_id = c.id AND x.user_id != ?)
      ORDER BY c.created_at LIMIT 1`,
    auth.workspaceId,
    auth.userId,
    auth.userId,
    auth.userId,
  );
  try {
    if (selfDm && await isChannelMember(db, selfDm.id, auth.userId)) {
      await db.run("UPDATE channels SET personal = 1, name = 'Saved' WHERE id = ?", selfDm.id);
    } else {
      const id = newId();
      await db.transaction(async () => {
        await db.insert('channels', { id, workspace_id: auth.workspaceId, name: 'Saved', kind: 'dm', personal: 1, created_by: auth.userId, created_at: now() });
        await db.run('INSERT OR IGNORE INTO channel_members (channel_id, user_id, joined_at, last_read_at) VALUES (?, ?, ?, ?)', id, auth.userId, now(), now());
      });
    }
  } catch (error) {
    // Made at the same moment by another request: use that one.
    const raced = await find();
    if (raced) return raced;
    throw error;
  }
  const saved = (await find())!;
  await moveBookmarks(db, auth, saved);
  return saved;
}

/** What a forward keeps of the original: frozen at the moment it's forwarded. A forward of a forward keeps the first original. */
async function snapshotFor(db: Database, message: Row): Promise<ForwardSnapshot> {
  const existing = parseSnapshot(message.forward_snapshot);
  if (existing) return existing;
  let original = message;
  if (message.forwarded_from) {
    const pointed = await db.get('SELECT * FROM messages WHERE id = ?', message.forwarded_from);
    if (pointed && !pointed.deleted_at) original = pointed;
  }
  const author = (await db.get('SELECT name, color FROM users WHERE id = ?', original.user_id)) ?? { name: 'Someone', color: '#888888' };
  const files = await db.all(
    `SELECT f.name, v.mime, v.size FROM files f JOIN file_versions v ON v.file_id = f.id AND v.version = f.current_version
      WHERE f.message_id = ? AND f.archived_at IS NULL ORDER BY f.created_at`,
    message.id,
  );
  return {
    message_id: original.id,
    body: original.body,
    created_at: original.created_at,
    user_id: original.user_id,
    user_name: author.name,
    user_color: author.color,
    // Not where it came from: that's looked up when it's shown, for people allowed to see it.
    files: files.map((f) => ({ name: f.name, mime: f.mime, size: Number(f.size) })),
  };
}

/**
 * Forward `message` (which `auth` can read) to `target` as a copy, with an optional note. Its attachments come
 * along as new files in the target conversation that share the stored bytes (so they use no extra storage) and
 * are only readable by people who can read the target.
 */
export async function forwardMessage(ctx: Ctx, auth: Auth, message: Row, target: Row, note: string, clientId?: string) {
  if (message.deleted_at) throw badRequest('This message was deleted');
  if (!await canPostChannel(ctx.db, auth, target)) throw forbidden(target.kind === 'announcement' ? 'Only leads and admins can post announcements' : 'You can’t post in that conversation');
  const snapshot = await snapshotFor(ctx.db, message);
  return postMessage(ctx, auth, target, {
    body: note,
    clientId,
    forward: { snapshot, originalId: snapshot.message_id, filesFrom: message.id },
  });
}

/** Copies of a message's attachments for a forwarded copy: readable by whoever can read its conversation, sharing the stored bytes. */
async function copyAttachments(db: Database, fromMessageId: string, to: { id: string; channel: Row; ownerId: string; createdAt: string }) {
  const originals = await db.all(
    `SELECT f.name, f.external_url, v.storage_key, v.mime, v.size FROM files f JOIN file_versions v ON v.file_id = f.id AND v.version = f.current_version
      WHERE f.message_id = ? AND f.archived_at IS NULL ORDER BY f.created_at`,
    fromMessageId,
  );
  for (const f of originals) {
    const fileId = newId();
    await db.insert('files', {
      id: fileId,
      workspace_id: to.channel.workspace_id,
      channel_id: to.channel.id,
      message_id: to.id,
      owner_id: to.ownerId,
      name: f.name,
      external_url: f.external_url ?? null,
      current_version: 1,
      created_at: to.createdAt,
      updated_at: to.createdAt,
    });
    await db.insert('file_versions', { id: newId(), file_id: fileId, version: 1, storage_key: f.storage_key, mime: f.mime, size: f.size, uploaded_by: to.ownerId, created_at: to.createdAt });
  }
}

/** Bookmarks from before Saved was a conversation become copies in it (those you can still read). */
async function moveBookmarks(db: Database, auth: Auth, saved: Row) {
  const marks = await db.all(
    `SELECT m.*, s.created_at AS saved_at FROM saved_messages s JOIN messages m ON m.id = s.message_id JOIN channels c ON c.id = m.channel_id
      WHERE s.user_id = ? AND c.workspace_id = ? AND m.deleted_at IS NULL ORDER BY s.created_at`,
    auth.userId,
    auth.workspaceId,
  );
  for (const m of marks) {
    const channel = (await db.get('SELECT * FROM channels WHERE id = ?', m.channel_id))!;
    if (!await canViewChannel(db, auth, channel)) continue;
    const snapshot = await snapshotFor(db, m);
    const id = newId();
    await db.transaction(async () => {
      await db.insert('messages', {
        id,
        channel_id: saved.id,
        user_id: auth.userId,
        body: '',
        created_at: m.saved_at,
        forwarded_from: snapshot.message_id,
        forward_snapshot: JSON.stringify(snapshot),
      });
      await copyAttachments(db, m.id, { id, channel: saved, ownerId: auth.userId, createdAt: m.saved_at });
      await db.run('DELETE FROM saved_messages WHERE user_id = ? AND message_id = ?', auth.userId, m.id);
    });
  }
}

/**
 * Take something out of Saved for good: the item, its replies, and its attachment copies (stored bytes are
 * removed when nothing else uses them). Under a legal hold it's hidden instead.
 */
async function removeFromSaved(ctx: Ctx, channel: Row, message: Row) {
  const { db } = ctx;
  if ((await db.get('SELECT legal_hold FROM workspaces WHERE id = ?', channel.workspace_id))?.legal_hold) {
    await db.update('messages', message.id, { deleted_at: now(), pinned_at: null });
  } else {
    const ids = [message.id, ...(await db.all('SELECT id FROM messages WHERE parent_id = ?', message.id)).map((r) => r.id)];
    const marks = ids.map(() => '?').join(',');
    const files = await db.all(`SELECT id FROM files WHERE message_id IN (${marks}) AND channel_id = ?`, ...ids, channel.id);
    const keys: string[] = [];
    await db.transaction(async () => {
      for (const f of files) {
        keys.push(...(await db.all('SELECT storage_key FROM file_versions WHERE file_id = ?', f.id)).map((v) => v.storage_key));
        await db.run('DELETE FROM file_versions WHERE file_id = ?', f.id);
        await db.run('DELETE FROM files WHERE id = ?', f.id);
      }
      await db.run(`DELETE FROM messages WHERE parent_id = ?`, message.id);
      await db.run('DELETE FROM messages WHERE id = ?', message.id);
    });
    await removeUnusedStorage(ctx, keys);
  }
  await publishToChannel(ctx, channel, { type: 'message.removed', messageId: message.id, channelId: channel.id, parentId: message.parent_id });
}


async function pollsFor(db: Database, auth: Auth, messageIds: string[]) {
  const out = new Map<string, unknown>();
  if (!messageIds.length) return out;
  const polls = await db.all(`SELECT * FROM polls WHERE message_id IN (${messageIds.map(() => '?').join(',')})`, ...messageIds);
  if (!polls.length) return out;
  const votes = await db.all(
    `SELECT v.poll_id, v.option_index, v.user_id, u.name FROM poll_votes v JOIN users u ON u.id = v.user_id
      WHERE v.poll_id IN (${polls.map(() => '?').join(',')}) ORDER BY v.created_at`,
    ...polls.map((p) => p.id),
  );
  for (const p of polls) {
    const mine = votes.filter((v) => v.poll_id === p.id);
    const labels = JSON.parse(p.options) as string[];
    out.set(p.message_id, {
      id: p.id,
      question: p.question,
      multiple: !!p.multiple,
      anonymous: !!p.anonymous,
      closed: !!p.closed_at,
      voters: new Set(mine.map((v) => v.user_id)).size,
      options: labels.map((label, index) => {
        const picked = mine.filter((v) => v.option_index === index);
        return { label, votes: picked.length, voters: p.anonymous ? [] : picked.map((v) => v.name) };
      }),
      my_votes: mine.filter((v) => v.user_id === auth.userId).map((v) => v.option_index),
    });
  }
  return out;
}

/** "@channel", "@here" and "@everyone" in a message (not inside a word or an e-mail address). */
export function broadcastMention(body: string): 'channel' | 'here' | null {
  const m = /(?:^|[\s(])@(channel|here|everyone)\b/i.exec(body);
  if (!m) return null;
  return m[1].toLowerCase() === 'here' ? 'here' : 'channel';
}

async function channelList(db: Database, auth: Auth) {
  await savedChannel(db, auth);
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
        `SELECT m.created_at, m.body, m.user_id, m.forward_snapshot, u.name AS user_name FROM messages m JOIN users u ON u.id = m.user_id
          WHERE m.channel_id = ? AND m.deleted_at IS NULL AND m.parent_id IS NULL ORDER BY m.created_at DESC LIMIT 1`,
        c.id,
      );
      return {
        id: c.id,
        name: c.personal ? 'Saved' : c.name,
        topic: c.topic,
        kind: c.kind,
        personal: !!c.personal,
        project_id: c.project_id,
        project_name: c.project_name,
        team_id: c.team_id,
        joined: !!c.joined,
        notify: c.notify ?? 'all',
        unread,
        mentions: c.kind === 'dm' ? unread : mentions,
        members,
        last_message_at: lastMessage?.created_at ?? null,
        // A preview for the conversation list (for channels you're in; others show their topic).
        last_message:
          lastMessage && (c.kind === 'dm' || c.joined)
            ? {
                text: String(lastMessage.body || parseSnapshot(lastMessage.forward_snapshot)?.body || '').slice(0, 160),
                mine: lastMessage.user_id === auth.userId,
                author: String(lastMessage.user_name ?? '').split(' ')[0],
                forwarded: !!lastMessage.forward_snapshot,
              }
            : undefined,
      };
    })));
}

export interface NewMessage {
  body: string;
  parentId?: string | null;
  urgent?: boolean;
  fileIds?: string[];
  poll?: { question: string; options: string[]; multiple?: boolean; anonymous?: boolean } | null;
  forwardedFrom?: string | null;
  /** A forwarded copy: the original as it was, and the message whose attachments come along. */
  forward?: { snapshot: ForwardSnapshot; originalId: string; filesFrom: string } | null;
  /** The sender's id for this message: sending it again returns the first one instead of posting twice. */
  clientId?: string | null;
}

/**
 * Post a message as `auth`: permission checks, persistence, live delivery,
 * webhooks and notifications. Used by the API and by scheduled messages.
 */
export async function postMessage(ctx: Ctx, auth: Auth, channel: Row, input: NewMessage) {
  const { db } = ctx;
  const body = { body: input.body, parentId: input.parentId ?? null, urgent: !!input.urgent, fileIds: input.fileIds ?? [] };
  if (!body.body && !body.fileIds.length && !input.poll && !input.forwardedFrom && !input.forward) throw badRequest('Write a message or attach a file');
  const sentBefore = async () =>
    input.clientId ? await db.get('SELECT * FROM messages WHERE channel_id = ? AND user_id = ? AND client_id = ?', channel.id, auth.userId, input.clientId) : undefined;
  const repeat = await sentBefore();
  if (repeat) return (await serializeMessages(db, auth, [repeat]))[0];
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
  try {
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
        forwarded_from: input.forward?.originalId ?? input.forwardedFrom ?? null,
        forward_snapshot: input.forward ? JSON.stringify(input.forward.snapshot) : null,
        client_id: input.clientId ?? null,
      });
      if (input.forward) await copyAttachments(db, input.forward.filesFrom, { id, channel, ownerId: auth.userId, createdAt });
      if (input.poll) {
        await db.insert('polls', {
          id: newId(),
          message_id: id,
          question: input.poll.question,
          options: JSON.stringify(input.poll.options),
          multiple: !!input.poll.multiple,
          anonymous: !!input.poll.anonymous,
        });
      }
      for (const fileId of body.fileIds) {
        await db.run('UPDATE files SET message_id = ?, channel_id = ? WHERE id = ? AND owner_id = ? AND message_id IS NULL', id, channel.id, fileId, auth.userId);
      }
      await db.run('UPDATE channel_members SET last_read_at = ? WHERE channel_id = ? AND user_id = ?', createdAt, channel.id, auth.userId);
    });
  } catch (error) {
    // The same send arriving twice at once: the other one won, so answer with it.
    const raced = await sentBefore();
    if (raced) return (await serializeMessages(db, auth, [raced]))[0];
    throw error;
  }
  const [message] = await serializeMessages(db, auth, [(await db.get('SELECT * FROM messages WHERE id = ?', id))!]);
  await publishToChannel(ctx, channel, { type: 'message.created', message });
  // Writing in a chat means you have caught up with it.
  await readNotificationGroup(ctx, auth.workspaceId, auth.userId, `/channels/${channel.id}`, createdAt);
  // Saved is private: no integrations, notifications or automatic replies.
  if (channel.personal) return message;
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
  // A reply only counts as seen if its thread is open; a top-level message if the channel is.
  const viewKey = parent ? `/channels/${channel.id}?thread=${parent.id}` : `/channels/${channel.id}`;
  const preview = body.body.replace(/@\[([^\]]+)\]\((?:team:)?[0-9a-f-]{36}\)/g, '@$1');
  const notified = new Set<string>([auth.userId]);
  const prefs = new Map((await db.all('SELECT user_id, notify FROM channel_members WHERE channel_id = ?', channel.id)).map((m) => [m.user_id, m.notify]));
  const mentioned: string[] = [];
  for (const userId of extractMentionIds(body.body)) {
    if (notified.has(userId) || !await isActiveMember(db, auth.workspaceId, userId)) continue;
    const role = (await db.get('SELECT role FROM memberships WHERE workspace_id = ? AND user_id = ?', auth.workspaceId, userId))!.role;
    if (!await canViewChannel(db, { userId, workspaceId: auth.workspaceId, role }, channel)) continue;
    mentioned.push(userId);
    if (prefs.get(userId) === 'none' && !body.urgent) continue;
    notified.add(userId);
    await notify(ctx, auth.workspaceId, { userId, kind: 'mention', title: `${actor.name} mentioned you in ${where}`, body: preview, link, viewKey, actorId: auth.userId, urgent: body.urgent });
  }
  // @Team reaches everyone on the team who can see this conversation, and shows in the team's inbox.
  for (const teamId of extractTeamMentionIds(body.body)) {
    const team = await db.get('SELECT * FROM teams WHERE id = ? AND workspace_id = ?', teamId, auth.workspaceId);
    if (!team) continue;
    for (const { user_id: userId } of await db.all('SELECT user_id FROM team_members WHERE team_id = ?', team.id)) {
      if (notified.has(userId) || !await isActiveMember(db, auth.workspaceId, userId)) continue;
      const role = (await db.get('SELECT role FROM memberships WHERE workspace_id = ? AND user_id = ?', auth.workspaceId, userId))!.role;
      if (!await canViewChannel(db, { userId, workspaceId: auth.workspaceId, role }, channel)) continue;
      if (prefs.get(userId) === 'none' && !body.urgent) continue;
      notified.add(userId);
      await notify(ctx, auth.workspaceId, { userId, kind: 'mention', title: `${actor.name} mentioned @${team.name} in ${where}`, body: preview, link, viewKey, actorId: auth.userId, urgent: body.urgent });
    }
  }
  const recipients = async (ids: string[], kind: string, title: string) => {
    for (const userId of ids) {
      if (notified.has(userId)) continue;
      const pref = prefs.get(userId) ?? 'all';
      // "Mentions and replies" still hears about replies in threads they're in; "Muted" hears nothing but urgent messages.
      if (!body.urgent && kind !== 'announcement' && !(pref === 'all' || (pref === 'mentions' && kind === 'thread'))) continue;
      notified.add(userId);
      await notify(ctx, auth.workspaceId, { userId, kind, title, body: preview, link, viewKey, actorId: auth.userId, urgent: body.urgent });
    }
  };
  const memberIds = [...prefs.keys()];
  // @channel / @everyone reach every member; @here only those online right now. Guests can't broadcast.
  const broadcast = channel.kind === 'dm' || isGuest(auth) ? null : broadcastMention(body.body);
  if (broadcast) {
    const online = broadcast === 'here' ? new Set(ctx.hub.onlineUsers(auth.workspaceId)) : null;
    for (const userId of memberIds) {
      if (notified.has(userId) || (online && !online.has(userId))) continue;
      if (prefs.get(userId) === 'none' && !body.urgent) continue;
      if (!await isActiveMember(db, auth.workspaceId, userId)) continue;
      notified.add(userId);
      await notify(ctx, auth.workspaceId, { userId, kind: 'mention', title: `${actor.name} notified @${broadcast} in ${where}`, body: preview, link, viewKey, actorId: auth.userId, urgent: body.urgent });
    }
  }
  if (channel.kind === 'dm') await recipients(memberIds, 'dm', `New message from ${actor.name}`);
  if (parent) {
    // People in the thread and those following it, except anyone who muted it.
    const threadPeople = (await db.all('SELECT DISTINCT user_id FROM messages WHERE parent_id = ? OR id = ?', parent.id, parent.id)).map((m) => m.user_id);
    const subs = await db.all('SELECT user_id, mode FROM thread_subscriptions WHERE message_id = ?', parent.id);
    const muted = new Set(subs.filter((s) => s.mode === 'mute').map((s) => s.user_id));
    const audience: string[] = [];
    for (const userId of new Set([...threadPeople, ...subs.filter((s) => s.mode === 'follow').map((s) => s.user_id)])) {
      if (muted.has(userId) || !await isActiveMember(db, auth.workspaceId, userId)) continue;
      if (!prefs.has(userId)) {
        const role = (await db.get('SELECT role FROM memberships WHERE workspace_id = ? AND user_id = ?', auth.workspaceId, userId))?.role;
        if (!role || !await canViewChannel(db, { userId, workspaceId: auth.workspaceId, role }, channel)) continue;
      }
      audience.push(userId);
    }
    await recipients(audience, 'thread', `${actor.name} replied to a thread in ${where}`);
  } else if (channel.kind === 'announcement') {
    await recipients(memberIds, 'announcement', `New announcement in #${channel.name}`);
  } else if (body.urgent) {
    await recipients(memberIds, 'urgent', `Urgent message from ${actor.name} in ${where}`);
  }
  // Anyone written to who is out of office answers automatically.
  await sendAutoReplies(ctx, auth, channel, { dm: channel.kind === 'dm' ? memberIds : [], mentioned });
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
    // A team's channel includes everyone on the team.
    if (body.teamId) await syncTeamChannels(db, body.teamId);
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
    if (channel.personal) throw badRequest('Saved is yours to keep');
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
    if (channel.personal) throw badRequest('Saved is yours to keep');
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
    const readAt = now();
    await db.run('UPDATE channel_members SET last_read_at = ? WHERE channel_id = ? AND user_id = ?', readAt, channel.id, auth.userId);
    // Reading the chat is reading what you were notified about in it.
    await readNotificationGroup(ctx, auth.workspaceId, auth.userId, `/channels/${channel.id}`, readAt);
    res.json({ ok: true });
  });

  // ----- Direct and group messages -----

  r.post('/dms', async (req, res) => {
    const auth = authOf(req);
    const { userIds } = parse(z.object({ userIds: z.array(z.string()).min(1).max(8) }), req.body);
    const members = [...new Set([auth.userId, ...userIds])].sort();
    for (const id of members) if (!await isActiveMember(db, auth.workspaceId, id)) throw notFound('Person');
    // A message to yourself goes to Saved.
    if (members.length === 1) return res.json({ id: (await savedChannel(db, auth)).id });
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
          WHERE c.workspace_id = ? AND c.kind = 'dm' AND c.personal = 0 GROUP BY c.id`,
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
    // When you last read this chat, so the first unread message can be marked (read before the visit marks it read).
    const member = await db.get('SELECT last_read_at FROM channel_members WHERE channel_id = ? AND user_id = ?', channel.id, auth.userId);
    res.json({ messages: await serializeMessages(db, auth, rows.reverse()), has_more: rows.length === q.limit, last_read_at: member?.last_read_at ?? null });
  });

  /** "Mark unread": everything from this message on counts as unread again, so the chat shows up as unread. */
  r.post('/channels/:id/unread', async (req, res) => {
    const auth = authOf(req);
    const channel = await loadChannel(db, auth, req.params.id);
    const { messageId } = parse(z.object({ messageId: z.string() }), req.body);
    const message = await db.get('SELECT created_at FROM messages WHERE id = ? AND channel_id = ?', messageId, channel.id);
    if (!message) throw notFound('Message');
    // Just before the message, so it and everything after it are unread.
    const before = new Date(new Date(message.created_at).getTime() - 1).toISOString();
    const { changes } = await db.run('UPDATE channel_members SET last_read_at = ? WHERE channel_id = ? AND user_id = ?', before, channel.id, auth.userId);
    if (!changes) throw badRequest('Join the channel to keep track of what you have read');
    await ctx.hub.publish(auth.workspaceId, { type: 'channel.updated', channelId: channel.id }, { kind: 'user', userId: auth.userId });
    res.json({ ok: true, last_read_at: before });
  });

  r.get('/channels/:id/pins', async (req, res) => {
    const auth = authOf(req);
    const channel = await loadChannel(db, auth, req.params.id);
    const rows = await db.all('SELECT * FROM messages WHERE channel_id = ? AND pinned_at IS NOT NULL AND deleted_at IS NULL ORDER BY pinned_at DESC', channel.id);
    res.json(await serializeMessages(db, auth, rows));
  });

  /**
   * What a channel's details page shows besides its members: who started it, the tasks made from its
   * messages (and its project's open tasks), its meetings, and how many files and pins it has.
   */
  r.get('/channels/:id/overview', async (req, res) => {
    const auth = authOf(req);
    const channel = await loadChannel(db, auth, req.params.id);
    const creator = await db.get('SELECT id, name, color FROM users WHERE id = ?', channel.created_by);
    const taskRows = await db.all(
      `SELECT t.* FROM tasks t LEFT JOIN messages m ON m.id = t.source_message_id
        WHERE t.workspace_id = ? AND (m.channel_id = ? ${channel.project_id ? 'OR (t.project_id = ? AND t.status != \'done\')' : ''})
        ORDER BY CASE WHEN t.status = 'done' THEN 1 ELSE 0 END, t.updated_at DESC LIMIT 40`,
      ...(channel.project_id ? [auth.workspaceId, channel.id, channel.project_id] : [auth.workspaceId, channel.id]),
    );
    const tasks = (await filterAsync(taskRows, (t) => canViewTask(db, auth, t))).slice(0, 12);
    const owners = new Map<string, Row>();
    for (const t of tasks) if (t.owner_id && !owners.has(t.owner_id)) owners.set(t.owner_id, (await db.get('SELECT id, name, color FROM users WHERE id = ?', t.owner_id))!);
    // Upcoming meetings soonest first, then past ones most recent first.
    const at = now();
    const meetingRows = await db.all('SELECT * FROM meetings WHERE channel_id = ? ORDER BY starts_at DESC LIMIT 100', channel.id);
    const upcoming = meetingRows.filter((m) => m.starts_at >= at).reverse();
    const past = meetingRows.filter((m) => m.starts_at < at);
    const meetings = (await filterAsync([...upcoming, ...past], (m) => canViewMeeting(db, auth, m))).slice(0, 8);
    const count = async (sql: string) => Number((await db.get(sql, channel.id))?.n ?? 0);
    res.json({
      created_by: creator ?? null,
      created_at: channel.created_at,
      file_count: await count('SELECT COUNT(*) AS n FROM files WHERE channel_id = ? AND archived_at IS NULL'),
      pin_count: await count('SELECT COUNT(*) AS n FROM messages WHERE channel_id = ? AND pinned_at IS NOT NULL AND deleted_at IS NULL'),
      tasks: tasks.map((t) => ({ id: t.id, title: t.title, status: t.status, due_date: t.due_date, owner: t.owner_id ? owners.get(t.owner_id) ?? null : null })),
      meetings: meetings.map((m) => ({ id: m.id, title: m.title, starts_at: m.starts_at, ends_at: m.ends_at })),
    });
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
      channel: { id: channel.id, name: channel.personal ? 'Saved' : channel.name, kind: channel.kind, personal: !!channel.personal },
      root: (await serializeMessages(db, auth, [root]))[0],
      replies: await serializeMessages(db, auth, replies),
      subscription: await threadSubscription(auth, root, replies),
    });
  });

  /** Whether you hear about new replies: you do if you're in the thread or follow it, unless you muted it. */
  const threadSubscription = async (auth: Auth, root: Row, replies: Row[]) => {
    const mode = ((await db.get('SELECT mode FROM thread_subscriptions WHERE user_id = ? AND message_id = ?', auth.userId, root.id))?.mode ?? null) as
      | 'follow'
      | 'mute'
      | null;
    const participant = root.user_id === auth.userId || replies.some((r) => r.user_id === auth.userId);
    return { mode, following: mode === 'follow' || (mode !== 'mute' && participant) };
  };

  r.put('/messages/:id/subscription', async (req, res) => {
    const auth = authOf(req);
    const { message } = await loadMessage(auth, req.params.id);
    if (message.parent_id) throw badRequest('Follow the thread from its first message');
    const { mode } = parse(z.object({ mode: z.enum(['follow', 'mute', 'none']) }), req.body);
    await db.run('DELETE FROM thread_subscriptions WHERE user_id = ? AND message_id = ?', auth.userId, message.id);
    if (mode !== 'none') await db.insert('thread_subscriptions', { user_id: auth.userId, message_id: message.id, mode, created_at: now() });
    const replies = await db.all('SELECT user_id FROM messages WHERE parent_id = ?', message.id);
    res.json(await threadSubscription(auth, message, replies));
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
        clientId: z.string().trim().min(8).max(64).optional(),
      }),
      req.body,
    );
    const message = await postMessage(ctx, auth, channel, body);
    res.status(201).json(message);
  });

  r.post('/channels/:id/polls', async (req, res) => {
    const auth = authOf(req);
    const channel = await loadChannel(db, auth, req.params.id);
    const body = parse(
      z.object({
        question: z.string().trim().min(1).max(300),
        options: z.array(z.string().trim().min(1).max(120)).min(2).max(10),
        multiple: z.boolean().default(false),
        anonymous: z.boolean().default(false),
        parentId: z.string().nullish(),
      }),
      req.body,
    );
    if (new Set(body.options.map((o) => o.toLowerCase())).size !== body.options.length) throw badRequest('Poll options must be different');
    const message = await postMessage(ctx, auth, channel, {
      body: `📊 ${body.question}`,
      parentId: body.parentId,
      poll: { question: body.question, options: body.options, multiple: body.multiple, anonymous: body.anonymous },
    });
    res.status(201).json(message);
  });

  const loadPoll = async (auth: Auth, id: string) => {
    const poll = await db.get('SELECT * FROM polls WHERE id = ?', id);
    if (!poll) throw notFound('Poll');
    const { message, channel } = await loadMessage(auth, poll.message_id);
    if (message.deleted_at) throw notFound('Poll');
    return { poll, message, channel };
  };

  r.post('/polls/:id/vote', async (req, res) => {
    const auth = authOf(req);
    const { poll, message, channel } = await loadPoll(auth, req.params.id);
    if (poll.closed_at) throw badRequest('This poll is closed');
    const { options } = parse(z.object({ options: z.array(z.number().int().min(0)).max(10) }), req.body);
    const count = (JSON.parse(poll.options) as string[]).length;
    const picked = [...new Set(options)];
    if (picked.some((i) => i >= count)) throw badRequest('Unknown option');
    if (!poll.multiple && picked.length > 1) throw badRequest('Pick one option');
    await db.transaction(async () => {
      await db.run('DELETE FROM poll_votes WHERE poll_id = ? AND user_id = ?', poll.id, auth.userId);
      for (const i of picked) await db.insert('poll_votes', { poll_id: poll.id, user_id: auth.userId, option_index: i, created_at: now() });
    });
    await publishToChannel(ctx, channel, { type: 'message.updated', messageId: message.id, channelId: channel.id, parentId: message.parent_id });
    const [updated] = await serializeMessages(db, auth, [message]);
    res.json(updated.poll);
  });

  r.post('/polls/:id/close', async (req, res) => {
    const auth = authOf(req);
    const { poll, message, channel } = await loadPoll(auth, req.params.id);
    if (message.user_id !== auth.userId && !isAdmin(auth)) throw forbidden('Only the author or an admin can close this poll');
    await db.run('UPDATE polls SET closed_at = ? WHERE id = ?', poll.closed_at ? null : now(), poll.id);
    await publishToChannel(ctx, channel, { type: 'message.updated', messageId: message.id, channelId: channel.id, parentId: message.parent_id });
    res.json({ closed: !poll.closed_at });
  });

  /** Forward a copy to a conversation you can post in ("saved" for your Saved), with an optional note. */
  r.post('/messages/:id/forward', async (req, res) => {
    const auth = authOf(req);
    const { message } = await loadMessage(auth, req.params.id);
    if (message.deleted_at) throw badRequest('This message was deleted');
    const body = parse(
      z.object({ channelId: z.string(), comment: z.string().trim().max(10_000).default(''), clientId: z.string().trim().min(8).max(64).optional() }),
      req.body,
    );
    const target = body.channelId === 'saved' ? await savedChannel(db, auth) : await loadChannel(db, auth, body.channelId);
    const forwardedMessage = await forwardMessage(ctx, auth, message, target, body.comment, body.clientId);
    res.status(201).json(forwardedMessage);
  });

  /** Where you can forward to: your Saved, and the conversations you can post in. */
  r.get('/forward-targets', async (req, res) => {
    const auth = authOf(req);
    const list = await channelList(db, auth);
    const out = [];
    for (const c of list) {
      if (c.kind !== 'dm' && !c.joined) continue;
      const channel = (await db.get('SELECT * FROM channels WHERE id = ?', c.id))!;
      if (!await canPostChannel(db, auth, channel)) continue;
      out.push({ id: c.id, name: c.name, kind: c.kind, personal: c.personal, members: c.members, last_message_at: c.last_message_at });
    }
    out.sort((a, b) => Number(b.personal) - Number(a.personal) || String(b.last_message_at ?? '').localeCompare(String(a.last_message_at ?? '')));
    res.json(out);
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
    // Your own notes in Saved are always yours to change.
    const ownSaved = !!channel.personal && message.user_id === auth.userId;
    if (!ownSaved && !await editPolicy(auth, message)) throw forbidden('Your workspace policy does not allow editing this message');
    const { body } = parse(z.object({ body: z.string().trim().min(1).max(10_000) }), req.body);
    await db.update('messages', message.id, { body, edited_at: now() });
    const [updated] = await serializeMessages(db, auth, [(await db.get('SELECT * FROM messages WHERE id = ?', message.id))!]);
    await publishToChannel(ctx, channel, { type: 'message.updated', messageId: message.id, channelId: channel.id, parentId: message.parent_id });
    res.json(updated);
  });

  r.delete('/messages/:id', async (req, res) => {
    const auth = authOf(req);
    const { message, channel } = await loadMessage(auth, req.params.id);
    if (channel.personal && channel.created_by === auth.userId) {
      await removeFromSaved(ctx, channel, message);
      return res.json({ ok: true });
    }
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

  /**
   * Save to Saved (a private copy) or take it out again. Saving is just for you; pinning is for everyone in the
   * conversation.
   */
  r.post('/messages/:id/save', async (req, res) => {
    const auth = authOf(req);
    const { message, channel } = await loadMessage(auth, req.params.id);
    if (channel.personal) {
      await removeFromSaved(ctx, channel, message);
      return res.json({ saved: false, removed: message.id });
    }
    // A bookmark from before Saved was a conversation.
    if (await db.get('SELECT 1 FROM saved_messages WHERE user_id = ? AND message_id = ?', auth.userId, message.id)) {
      await db.run('DELETE FROM saved_messages WHERE user_id = ? AND message_id = ?', auth.userId, message.id);
      return res.json({ saved: false });
    }
    const saved = await savedChannel(db, auth);
    const copy = await db.get('SELECT * FROM messages WHERE channel_id = ? AND forwarded_from = ? AND deleted_at IS NULL', saved.id, message.forwarded_from ?? message.id);
    if (copy) {
      await removeFromSaved(ctx, saved, copy);
      return res.json({ saved: false, removed: copy.id });
    }
    const item = await forwardMessage(ctx, auth, message, saved, '');
    res.status(201).json({ saved: true, channel_id: saved.id, message: item });
  });

  /** What's in your Saved, newest first (for older apps that list it separately). */
  r.get('/saved', async (req, res) => {
    const auth = authOf(req);
    const saved = await savedChannel(db, auth);
    const rows = await db.all('SELECT * FROM messages WHERE channel_id = ? AND parent_id IS NULL AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 200', saved.id);
    const serialized = await serializeMessages(db, auth, rows);
    res.json(serialized.map((m) => ({ ...m, channel_name: 'Saved', channel_kind: 'dm' })));
  });

  /** The Saved conversation's id. */
  r.get('/saved/channel', async (req, res) => res.json({ id: (await savedChannel(db, authOf(req))).id }));

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
