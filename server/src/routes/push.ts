import { Router } from 'express';
import { z } from 'zod';
import { authOf, type Ctx } from '../context.js';
import { isAllowedPushEndpoint, pushIdle, sendPush, vapidKeys } from '../push.js';
import { HttpError, badRequest, newId, now, parse } from '../util.js';

/** Turning phone and desktop push notifications on and off for a device. */
export function pushRouter(ctx: Ctx) {
  const r = Router();
  const { db } = ctx;

  r.get('/push/config', async (_req, res) => {
    if (!ctx.push) return res.json({ enabled: false });
    res.json({ enabled: true, publicKey: (await vapidKeys(ctx)).publicKey });
  });

  r.post('/me/push', async (req, res) => {
    const auth = authOf(req);
    if (!ctx.push) throw new HttpError(404, 'Push notifications are not available on this server');
    if (!auth.sessionId) throw new HttpError(403, 'Push notifications need a signed-in browser');
    const body = parse(
      z.object({ endpoint: z.string().url().max(1000), keys: z.object({ p256dh: z.string().min(20).max(200), auth: z.string().min(8).max(100) }) }),
      req.body,
    );
    if (!isAllowedPushEndpoint(body.endpoint)) throw badRequest('This browser’s push service is not supported');
    await db.transaction(async () => {
      // A device's endpoint is unique; if someone else signed in on it before, it's now this person's.
      await db.run('DELETE FROM push_subscriptions WHERE endpoint = ?', body.endpoint);
      await db.insert('push_subscriptions', {
        id: newId(),
        user_id: auth.userId,
        session_id: auth.sessionId,
        endpoint: body.endpoint,
        p256dh: body.keys.p256dh,
        auth: body.keys.auth,
        user_agent: req.get('user-agent')?.slice(0, 400) ?? null,
        created_at: now(),
      });
      // Keep the 20 most recent devices.
      const extra = await db.all('SELECT id FROM push_subscriptions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1000 OFFSET 20', auth.userId);
      for (const row of extra) await db.run('DELETE FROM push_subscriptions WHERE id = ?', row.id);
    });
    res.status(201).json({ ok: true });
  });

  r.delete('/me/push', async (req, res) => {
    const auth = authOf(req);
    const body = parse(z.object({ endpoint: z.string().max(1000) }), req.body);
    await db.run('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?', body.endpoint, auth.userId);
    res.json({ ok: true });
  });

  /** Send a test notification to this person's devices. */
  r.post('/me/push/test', async (req, res) => {
    const auth = authOf(req);
    const count = (await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?', auth.userId))!.n;
    if (!count) throw badRequest('Turn on notifications on this device first');
    sendPush(ctx, auth.userId, { title: 'Küü notifications are on', body: 'You’ll get alerts here when you’re away from Küü.', url: '/settings?tab=notifications', tag: 'softex-test' });
    await pushIdle();
    res.json({ ok: true });
  });

  return r;
}
