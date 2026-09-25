import webpush from 'web-push';
import type { Ctx } from './context.js';
import { decryptSecret, encryptSecret } from './routes/sso.js';
import { now } from './util.js';

/**
 * Web Push (§5.5 notifications): alerts on phones and desktops when Küü isn't open.
 * Each subscription belongs to a browser session, so signing out, revoking the device or
 * changing the password stops the alerts. Payloads are end-to-end encrypted to the device.
 */

export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushPayload {
  title: string;
  body?: string;
  /** Path inside Küü to open when the notification is tapped. */
  url?: string;
  /** Notifications with the same tag replace each other on the device. */
  tag?: string;
}

/** Sends one push message; swapped for a fake in tests. Returns the push service's HTTP status. */
export interface PushTransport {
  send(subscription: PushSubscriptionInput, payload: string, vapid: VapidKeys): Promise<number>;
}

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
  subject: string;
}

export const webPushTransport: PushTransport = {
  async send(subscription, payload, vapid) {
    try {
      const res = await webpush.sendNotification(subscription, payload, {
        TTL: 12 * 3600,
        urgency: 'high',
        vapidDetails: { subject: vapid.subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
        timeout: 10_000,
      });
      return res.statusCode;
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode;
      if (status) return status;
      throw error;
    }
  },
};

/**
 * Push services used by current browsers. Subscriptions pointing anywhere else are refused,
 * so the server can't be made to send requests to arbitrary (or internal) addresses.
 */
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)notify\.windows\.com$/, /^android\.googleapis\.com$/];

export function isAllowedPushEndpoint(endpoint: string) {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return false;
  const host = url.hostname.toLowerCase();
  return PUSH_HOSTS.some((re) => re.test(host));
}

let cachedKeys: { db: unknown; keys: Promise<VapidKeys> } | undefined;

/**
 * The server's VAPID key pair. From SOFTEX_VAPID_* when set; otherwise generated once and
 * kept in the database (encrypted when SOFTEX_SECRET_KEY is set) so every server shares it.
 */
export function vapidKeys(ctx: Ctx): Promise<VapidKeys> {
  const subject = ctx.config.vapid?.subject ?? (ctx.config.company.email ? `mailto:${ctx.config.company.email}` : ctx.config.publicUrl.startsWith('https:') ? ctx.config.publicUrl : 'mailto:admin@softex.invalid');
  if (ctx.config.vapid?.publicKey && ctx.config.vapid.privateKey) {
    return Promise.resolve({ publicKey: ctx.config.vapid.publicKey, privateKey: ctx.config.vapid.privateKey, subject });
  }
  if (cachedKeys?.db !== ctx.db) {
    const keys = (async () => {
      const read = () => ctx.db.get<{ value: string }>("SELECT value FROM server_settings WHERE key = 'vapid'");
      let row = await read();
      if (!row) {
        const fresh = webpush.generateVAPIDKeys();
        const value = JSON.stringify({
          publicKey: fresh.publicKey,
          privateKey: ctx.config.secretKey ? encryptSecret(ctx.config.secretKey, fresh.privateKey) : fresh.privateKey,
          encrypted: !!ctx.config.secretKey,
        });
        // Another server may have created the keys at the same moment; the first one wins.
        await ctx.db.run('INSERT OR IGNORE INTO server_settings (key, value, created_at) VALUES (?, ?, ?)', 'vapid', value, now());
        row = await read();
      }
      const stored = JSON.parse(row!.value) as { publicKey: string; privateKey: string; encrypted: boolean };
      const privateKey = stored.encrypted ? decryptSecret(ctx.config.secretKey ?? '', stored.privateKey) : stored.privateKey;
      return { publicKey: stored.publicKey, privateKey, subject };
    })();
    keys.catch(() => (cachedKeys = undefined));
    cachedKeys = { db: ctx.db, keys };
  }
  return cachedKeys.keys;
}

/** Pushes still being sent, so tests (and shutdown) can wait for them. */
const pending = new Set<Promise<void>>();
export const pushIdle = async () => {
  while (pending.size) await Promise.all([...pending]);
};

/** Send a notification to every device where the person is signed in and has alerts on. Never throws. */
export function sendPush(ctx: Ctx, userId: string, payload: PushPayload) {
  if (!ctx.push) return;
  const transport = ctx.push;
  const job = (async () => {
    const subs = await ctx.db.all(
      `SELECT p.id, p.endpoint, p.p256dh, p.auth FROM push_subscriptions p JOIN sessions s ON s.id = p.session_id
        WHERE p.user_id = ? AND s.user_id = p.user_id AND s.expires_at > ?`,
      userId,
      now(),
    );
    if (!subs.length) return;
    const keys = await vapidKeys(ctx);
    const body = JSON.stringify(payload);
    await Promise.all(
      subs.map(async (sub) => {
        try {
          const status = await transport.send({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, body, keys);
          if (status === 404 || status === 410) await ctx.db.run('DELETE FROM push_subscriptions WHERE id = ?', sub.id);
          else if (status >= 200 && status < 300) await ctx.db.run('UPDATE push_subscriptions SET last_success_at = ? WHERE id = ?', now(), sub.id);
          else console.warn(`Push service answered ${status}`);
        } catch (error) {
          console.warn('Push delivery failed', (error as Error).message);
        }
      }),
    );
  })().catch((error) => console.error('Push failed', error));
  pending.add(job);
  void job.finally(() => pending.delete(job));
}
