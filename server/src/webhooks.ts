import { createHmac } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { Ctx } from './context.js';
import { newId, now, parseJson } from './util.js';
import { hasFeature } from './plans.js';

/**
 * Outgoing webhooks (§5.7, §12). Events are queued in `webhook_deliveries` and
 * delivered by a background job with retries, so consumers must tolerate
 * duplicates (use the `id` field to de-duplicate). Payloads carry only the
 * fields a consumer needs, and events about private channels, private projects
 * or direct messages are never sent to webhooks.
 */
export const WEBHOOK_EVENTS = [
  'message.created',
  'task.created',
  'task.assigned',
  'task.status_changed',
  'document.version_added',
  'meeting.ended',
  'decision.recorded',
  'project.created',
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

interface Scope {
  projectId?: string | null;
  channelId?: string | null;
}

async function isPublicScope(ctx: Ctx, scope: Scope) {
  if (scope.channelId) {
    const c = await ctx.db.get('SELECT kind FROM channels WHERE id = ?', scope.channelId);
    if (!c || !['public', 'announcement'].includes(c.kind)) return false;
  }
  if (scope.projectId) {
    const p = await ctx.db.get('SELECT visibility FROM projects WHERE id = ?', scope.projectId);
    if (!p || p.visibility !== 'workspace') return false;
  }
  return !!(scope.channelId || scope.projectId);
}

export async function emitEvent(ctx: Ctx, workspaceId: string, event: WebhookEvent, data: Record<string, unknown>, scope: Scope) {
  const hooks = await ctx.db.all('SELECT id, events FROM webhooks WHERE workspace_id = ? AND active = 1', workspaceId);
  if (!hooks.length || !await isPublicScope(ctx, scope) || !await hasFeature(ctx, workspaceId, 'api')) return;
  const payload = JSON.stringify({ id: newId(), type: event, created_at: now(), workspace_id: workspaceId, data });
  for (const hook of hooks) {
    const events = parseJson<string[]>(hook.events, []);
    if (!events.includes(event) && !events.includes('*')) continue;
    await ctx.db.insert('webhook_deliveries', { id: newId(), webhook_id: hook.id, event, payload, next_attempt_at: now(), created_at: now() });
  }
}

export const signPayload = (secret: string, timestamp: string, body: string) =>
  `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;

const PRIVATE_V4 = [/^10\./, /^127\./, /^169\.254\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^0\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./];
export const isPrivateAddress = (ip: string) =>
  isIP(ip) === 6
    ? /^(::1|::|fc|fd|fe80|::ffff:(10|127|169\.254|192\.168|172\.(1[6-9]|2\d|3[01]))\.)/i.test(ip)
    : PRIVATE_V4.some((re) => re.test(ip));

/** Reject URLs that resolve to internal addresses (SSRF protection). */
export async function assertSafeWebhookUrl(ctx: Ctx, url: string) {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Enter a valid URL');
  }
  if (ctx.config.allowPrivateWebhooks) {
    if (!/^https?:$/.test(parsed.protocol)) throw new Error('Webhook URLs must use http or https');
    return;
  }
  if (parsed.protocol !== 'https:') throw new Error('Webhook URLs must use https');
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  if (!addresses.length || addresses.some(isPrivateAddress)) throw new Error('Webhook URLs cannot point to private or internal network addresses');
}

const MAX_ATTEMPTS = 8;

export async function processWebhookQueue(ctx: Ctx, limit = 20) {
  const due = await ctx.db.all(
    `SELECT d.*, w.url, w.secret, w.active FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook_id
      WHERE d.status = 'pending' AND d.next_attempt_at <= ? ORDER BY d.created_at LIMIT ?`,
    now(),
    limit,
  );
  await Promise.all(due.map((d) => deliver(ctx, d)));
  return due.length;
}

async function deliver(ctx: Ctx, d: Record<string, any>) {
  if (!d.active) {
    await ctx.db.run(`UPDATE webhook_deliveries SET status = 'failed', last_error = 'Webhook disabled' WHERE id = ?`, d.id);
    return;
  }
  const timestamp = String(Math.floor(Date.now() / 1000));
  let status: number | null = null;
  try {
    await assertSafeWebhookUrl(ctx, d.url);
    const res = await fetch(d.url, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'SoftEX-Webhooks/1',
        'X-SoftEX-Event': d.event,
        'X-SoftEX-Delivery': d.id,
        'X-SoftEX-Timestamp': timestamp,
        'X-SoftEX-Signature': signPayload(d.secret, timestamp, d.payload),
      },
      body: d.payload,
    });
    status = res.status;
    if (res.status >= 200 && res.status < 300) {
      await ctx.db.run(`UPDATE webhook_deliveries SET status = 'delivered', attempts = attempts + 1, response_status = ?, delivered_at = ?, last_error = NULL WHERE id = ?`, status, now(), d.id);
      return;
    }
    throw new Error(`Endpoint responded ${res.status}`);
  } catch (error) {
    const attempts = d.attempts + 1;
    const backoff = Math.min(12 * 3_600_000, 30_000 * 2 ** attempts);
    await ctx.db.run(
      `UPDATE webhook_deliveries SET attempts = ?, response_status = ?, last_error = ?, status = ?, next_attempt_at = ? WHERE id = ?`,
      attempts,
      status,
      String((error as Error).message).slice(0, 300),
      attempts >= MAX_ATTEMPTS ? 'failed' : 'pending',
      new Date(Date.now() + backoff).toISOString(),
      d.id,
    );
  }
}
