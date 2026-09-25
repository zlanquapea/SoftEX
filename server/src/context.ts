import type { Request } from 'express';
import type { Auth } from './access.js';
import { canViewChannel } from './access.js';
import type { Database, Row } from './db.js';
import type { BillingConfig } from './plans.js';
import type { RealtimeHub } from './realtime.js';
import { queueEmail } from './mailer.js';
import { newId, now } from './util.js';

export interface Config {
  uploadDir: string;
  meetingBaseUrl: string;
  maxUploadBytes: number;
  secureCookies: boolean;
  /** Public origin used in links inside emails and SSO redirects, e.g. https://softex.example.com */
  publicUrl: string;
  /** SMTP connection URL (smtp[s]://user:pass@host:port). Without it, emails are recorded in the outbox and logged. */
  smtpUrl?: string;
  mailFrom: string;
  /** Secret used to encrypt stored credentials such as SSO client secrets. */
  secretKey?: string;
  /** ClamAV daemon for malware scanning of uploads, e.g. { host: 'clamav', port: 3310 }. */
  clamav?: { host: string; port: number };
  /** Allow webhooks to private network addresses (only for development and tests). */
  allowPrivateWebhooks: boolean;
  aiModel: string;
  /** Who may create new workspaces from the sign-up page: anyone, only the very first person, or nobody. */
  registration: 'open' | 'first' | 'closed';
  /** 'saas' turns on plans, trials, usage limits, email verification and the operator console. */
  mode: 'self_hosted' | 'saas';
  /** Email addresses of the people who run this service; they get the operator console. */
  operatorEmails: string[];
  billing: BillingConfig;
  /** The business running a hosted service; shown on the website, terms and privacy policy. */
  company: { name?: string; address?: string; email?: string };
}

/** Minimal mail transport interface (nodemailer-compatible) so tests can inject a fake. */
export interface MailTransport {
  sendMail(message: {
    from: string;
    to: string;
    subject: string;
    text: string;
    html?: string;
    attachments?: { filename: string; content: string; contentType?: string }[];
  }): Promise<unknown>;
}

/** The subset of the Anthropic client SoftEX uses, injectable for tests. */
export interface AiClient {
  complete(input: { system: string; prompt: string; jsonSchema?: Record<string, unknown> }): Promise<{ text: string; refused: boolean }>;
}

export interface Ctx {
  db: Database;
  hub: RealtimeHub;
  config: Config;
  mail?: MailTransport;
  ai?: AiClient;
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

export async function userSummary(db: Database, userId: string | null | undefined) {
  if (!userId) return null;
  return await db.get('SELECT id, name, color, title FROM users WHERE id = ?', userId) ?? null;
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
export async function notify(ctx: Ctx, workspaceId: string, input: NotifyInput) {
  if (input.actorId && input.actorId === input.userId) return;
  const user = await ctx.db.get(
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
  await ctx.db.insert('notifications', row);
  const silent = !input.urgent && inQuietHours(user);
  // Urgent items also go out by email when the person is not connected to SoftEX right now.
  if (input.urgent && user.email_urgent && !ctx.hub.isOnline(workspaceId, input.userId)) {
    await queueEmail(ctx, {
      workspaceId,
      kind: 'urgent',
      to: user.email,
      subject: `Urgent: ${input.title}`,
      text: input.body ? `${input.title}\n\n“${input.body.replace(/@\[([^\]]+)\]\([0-9a-f-]{36}\)/g, '@$1')}”` : input.title,
      action: { label: 'Open in SoftEX', url: `${ctx.config.publicUrl}${input.link ?? '/inbox'}` },
    });
  }
  await ctx.hub.toUser(workspaceId, input.userId, {
    type: 'notification',
    notification: { ...row, read_at: null, actor: await userSummary(ctx.db, input.actorId) },
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

export async function recordActivity(ctx: Ctx, workspaceId: string, input: ActivityInput) {
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
  await ctx.db.insert('activity', row);
}

export async function audit(
  ctx: Ctx,
  workspaceId: string,
  actorId: string | null,
  action: string,
  targetType: string,
  targetId: string,
  detail: Record<string, unknown> = {},
) {
  await ctx.db.insert('audit_events', {
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

/** Service-level log for the operator; kept even after the workspace it mentions is deleted. */
export async function platformEvent(ctx: Ctx, actor: string, action: string, workspace: Row | null, detail: Record<string, unknown> = {}) {
  await ctx.db.insert('platform_events', {
    id: newId(),
    actor,
    action,
    workspace_id: workspace?.id ?? null,
    workspace_name: workspace?.name ?? null,
    detail,
    created_at: now(),
  });
}

/** Publish an event to everyone who can currently see the given channel. */
export async function publishToChannel(ctx: Ctx, channel: Row, event: { type: string; [k: string]: unknown }) {
  await ctx.hub.publish(channel.workspace_id, event, (auth) => canViewChannel(ctx.db, auth, channel));
}
