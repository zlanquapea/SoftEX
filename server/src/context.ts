import type { Request } from 'express';
import type { Auth } from './access.js';
import { canViewChannel } from './access.js';
import type { Database, Row } from './db.js';
import type { RealtimeHub } from './realtime.js';
import { newId, now } from './util.js';

export interface Config {
  uploadDir: string;
  meetingBaseUrl: string;
  maxUploadBytes: number;
  secureCookies: boolean;
}

export interface Ctx {
  db: Database;
  hub: RealtimeHub;
  config: Config;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: Auth;
    }
  }
}

export const authOf = (req: Request): Auth => {
  if (!req.auth) throw new Error('auth middleware missing');
  return req.auth;
};

/** Public shape of a user; never includes credentials. */
export const USER_FIELDS =
  'u.id, u.name, u.email, u.title, u.timezone, u.working_hours, u.expertise, u.status, u.status_text, u.focus_until, u.color';

export function userSummary(db: Database, userId: string | null | undefined) {
  if (!userId) return null;
  return db.get('SELECT id, name, color, title FROM users WHERE id = ?', userId) ?? null;
}

// ---------- Notifications ----------

export interface NotifyInput {
  userId: string;
  kind: string;
  title: string;
  body?: string;
  link?: string;
  actorId?: string;
  urgent?: boolean;
}

function inQuietHours(user: Row, at = new Date()) {
  if (user.focus_until && user.focus_until > at.toISOString()) return true;
  if (!user.quiet_start || !user.quiet_end) return false;
  let local: string;
  try {
    local = at.toLocaleTimeString('en-GB', { timeZone: user.timezone || 'UTC', hour: '2-digit', minute: '2-digit', hour12: false });
  } catch {
    local = at.toISOString().slice(11, 16);
  }
  const { quiet_start: start, quiet_end: end } = user;
  return start <= end ? local >= start && local < end : local >= start || local < end;
}

/**
 * Store a notification and deliver it live. During quiet hours or focus time the
 * notification is still stored (and shown in the Inbox) but the live push is
 * marked silent unless it is urgent (§5.5 urgent escalation rules).
 */
export function notify(ctx: Ctx, workspaceId: string, input: NotifyInput) {
  if (input.actorId && input.actorId === input.userId) return;
  const user = ctx.db.get(
    `SELECT u.* FROM users u JOIN memberships m ON m.user_id = u.id
      WHERE u.id = ? AND m.workspace_id = ? AND m.deactivated_at IS NULL`,
    input.userId,
    workspaceId,
  );
  if (!user) return;
  const row = {
    id: newId(),
    workspace_id: workspaceId,
    user_id: input.userId,
    kind: input.kind,
    title: input.title,
    body: (input.body ?? '').slice(0, 280),
    link: input.link ?? '',
    actor_id: input.actorId ?? null,
    urgent: input.urgent ? 1 : 0,
    created_at: now(),
  };
  ctx.db.insert('notifications', row);
  const silent = !input.urgent && inQuietHours(user);
  ctx.hub.toUser(workspaceId, input.userId, {
    type: 'notification',
    notification: { ...row, read_at: null, actor: userSummary(ctx.db, input.actorId) },
    silent,
  });
}

// ---------- Activity & audit ----------

export interface ActivityInput {
  actorId: string;
  verb: string;
  objectType: string;
  objectId: string;
  summary: string;
  link?: string;
  projectId?: string | null;
  channelId?: string | null;
}

export function recordActivity(ctx: Ctx, workspaceId: string, input: ActivityInput) {
  const row = {
    id: newId(),
    workspace_id: workspaceId,
    actor_id: input.actorId,
    verb: input.verb,
    object_type: input.objectType,
    object_id: input.objectId,
    project_id: input.projectId ?? null,
    channel_id: input.channelId ?? null,
    summary: input.summary,
    link: input.link ?? '',
    created_at: now(),
  };
  ctx.db.insert('activity', row);
}

export function audit(
  ctx: Ctx,
  workspaceId: string,
  actorId: string | null,
  action: string,
  targetType: string,
  targetId: string,
  detail: Record<string, unknown> = {},
) {
  ctx.db.insert('audit_events', {
    id: newId(),
    workspace_id: workspaceId,
    actor_id: actorId,
    action,
    target_type: targetType,
    target_id: targetId,
    detail,
    created_at: now(),
  });
}

/** Publish an event to everyone who can currently see the given channel. */
export function publishToChannel(ctx: Ctx, channel: Row, event: { type: string; [k: string]: unknown }) {
  ctx.hub.publish(channel.workspace_id, event, (auth) => canViewChannel(ctx.db, auth, channel));
}
