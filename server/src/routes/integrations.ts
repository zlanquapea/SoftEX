import { Router } from 'express';
import { z } from 'zod';
import { requireRole } from '../access.js';
import { audit, authOf, type Ctx } from '../context.js';
import { assertSafeWebhookUrl, WEBHOOK_EVENTS } from '../webhooks.js';
import { badRequest, newId, notFound, now, parse, parseJson, randomToken, sha256 } from '../util.js';
import { requireFeature, requireVerifiedEmail } from '../plans.js';

/** Personal API tokens, webhooks and the email outbox. Browser sessions only (see requireAuth). */
export function integrationsRouter(ctx: Ctx) {
  const r = Router();
  const { db } = ctx;

  // ======================= Personal API tokens =======================

  r.get('/integrations/tokens', (req, res) => {
    const auth = authOf(req);
    res.json(
      db.all(
        `SELECT id, name, prefix, scope, last_used_at, expires_at, revoked_at, created_at FROM api_tokens
          WHERE user_id = ? AND workspace_id = ? ORDER BY revoked_at IS NOT NULL, created_at DESC`,
        auth.userId,
        auth.workspaceId,
      ),
    );
  });

  r.post('/integrations/tokens', (req, res) => {
    const auth = authOf(req);
    const body = parse(
      z.object({ name: z.string().trim().min(1).max(80), scope: z.enum(['read', 'write']).default('read'), expiresInDays: z.number().int().min(1).max(365).nullish() }),
      req.body,
    );
    if (auth.role === 'guest') throw badRequest('Guests cannot create API tokens');
    requireFeature(ctx, auth.workspaceId, 'api');
    requireVerifiedEmail(ctx, auth);
    const token = `sx_${randomToken()}`;
    const id = newId();
    db.insert('api_tokens', {
      id,
      workspace_id: auth.workspaceId,
      user_id: auth.userId,
      name: body.name,
      token_hash: sha256(token),
      prefix: token.slice(0, 10),
      scope: body.scope,
      expires_at: body.expiresInDays ? new Date(Date.now() + body.expiresInDays * 86_400_000).toISOString() : null,
      created_at: now(),
    });
    audit(ctx, auth.workspaceId, auth.userId, 'api_token.created', 'api_token', id, { name: body.name, scope: body.scope });
    // The full token is shown once; only its hash is stored.
    res.status(201).json({ id, token });
  });

  r.delete('/integrations/tokens/:id', (req, res) => {
    const auth = authOf(req);
    const changed = db.run('UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL', now(), req.params.id, auth.userId);
    if (!changed.changes) throw notFound('Token');
    audit(ctx, auth.workspaceId, auth.userId, 'api_token.revoked', 'api_token', req.params.id);
    res.json({ ok: true });
  });

  // ======================= Webhooks (admins) =======================

  const WebhookBody = z.object({
    url: z.string().url().max(500),
    events: z.array(z.enum([...WEBHOOK_EVENTS, '*'])).min(1),
    description: z.string().max(200).default(''),
    active: z.boolean().default(true),
  });

  const checkUrl = async (url: string) => {
    try {
      await assertSafeWebhookUrl(ctx, url);
    } catch (e) {
      throw badRequest(`url: ${(e as Error).message}`);
    }
  };

  const webhookSummary = (w: Record<string, any>) => ({
    id: w.id,
    url: w.url,
    events: parseJson<string[]>(w.events, []),
    description: w.description,
    active: !!w.active,
    created_at: w.created_at,
    recent: db.get(
      `SELECT SUM(status = 'delivered') AS delivered, SUM(status = 'failed') AS failed, SUM(status = 'pending') AS pending
         FROM (SELECT status FROM webhook_deliveries WHERE webhook_id = ? ORDER BY created_at DESC LIMIT 50)`,
      w.id,
    ),
  });

  r.get('/integrations/webhooks', (req, res) => {
    const auth = authOf(req);
    requireRole(auth, 'admin');
    res.json({ events: WEBHOOK_EVENTS, webhooks: db.all('SELECT * FROM webhooks WHERE workspace_id = ? ORDER BY created_at', auth.workspaceId).map(webhookSummary) });
  });

  r.post('/integrations/webhooks', async (req, res) => {
    const auth = authOf(req);
    requireRole(auth, 'admin');
    requireFeature(ctx, auth.workspaceId, 'api');
    requireVerifiedEmail(ctx, auth);
    const body = parse(WebhookBody, req.body);
    await checkUrl(body.url);
    const id = newId();
    const secret = `whsec_${randomToken()}`;
    db.insert('webhooks', { id, workspace_id: auth.workspaceId, url: body.url, events: body.events, secret, active: body.active, description: body.description, created_by: auth.userId, created_at: now() });
    audit(ctx, auth.workspaceId, auth.userId, 'webhook.created', 'webhook', id, { url: body.url, events: body.events });
    res.status(201).json({ ...webhookSummary(db.get('SELECT * FROM webhooks WHERE id = ?', id)!), secret });
  });

  const loadHook = (workspaceId: string, id: string) => {
    const hook = db.get('SELECT * FROM webhooks WHERE id = ? AND workspace_id = ?', id, workspaceId);
    if (!hook) throw notFound('Webhook');
    return hook;
  };

  r.patch('/integrations/webhooks/:id', async (req, res) => {
    const auth = authOf(req);
    requireRole(auth, 'admin');
    const hook = loadHook(auth.workspaceId, req.params.id);
    const body = parse(WebhookBody.partial(), req.body);
    if (body.url) await checkUrl(body.url);
    db.update('webhooks', hook.id, { url: body.url, events: body.events, description: body.description, active: body.active });
    audit(ctx, auth.workspaceId, auth.userId, 'webhook.updated', 'webhook', hook.id, body);
    res.json(webhookSummary(db.get('SELECT * FROM webhooks WHERE id = ?', hook.id)!));
  });

  r.post('/integrations/webhooks/:id/rotate-secret', (req, res) => {
    const auth = authOf(req);
    requireRole(auth, 'admin');
    const hook = loadHook(auth.workspaceId, req.params.id);
    const secret = `whsec_${randomToken()}`;
    db.update('webhooks', hook.id, { secret });
    audit(ctx, auth.workspaceId, auth.userId, 'webhook.secret_rotated', 'webhook', hook.id);
    res.json({ secret });
  });

  r.delete('/integrations/webhooks/:id', (req, res) => {
    const auth = authOf(req);
    requireRole(auth, 'admin');
    const hook = loadHook(auth.workspaceId, req.params.id);
    db.run('DELETE FROM webhooks WHERE id = ?', hook.id);
    audit(ctx, auth.workspaceId, auth.userId, 'webhook.deleted', 'webhook', hook.id, { url: hook.url });
    res.json({ ok: true });
  });

  r.post('/integrations/webhooks/:id/ping', (req, res) => {
    const auth = authOf(req);
    requireRole(auth, 'admin');
    const hook = loadHook(auth.workspaceId, req.params.id);
    const payload = JSON.stringify({ id: newId(), type: 'ping', created_at: now(), workspace_id: auth.workspaceId, data: { message: 'Webhook configured correctly' } });
    db.insert('webhook_deliveries', { id: newId(), webhook_id: hook.id, event: 'ping', payload, next_attempt_at: now(), created_at: now() });
    res.json({ ok: true });
  });

  r.get('/integrations/webhooks/:id/deliveries', (req, res) => {
    const auth = authOf(req);
    requireRole(auth, 'admin');
    const hook = loadHook(auth.workspaceId, req.params.id);
    res.json(
      db.all(
        `SELECT id, event, status, attempts, response_status, last_error, created_at, delivered_at, next_attempt_at FROM webhook_deliveries
          WHERE webhook_id = ? ORDER BY created_at DESC LIMIT 50`,
        hook.id,
      ),
    );
  });

  // ======================= Email outbox (admins) =======================

  r.get('/integrations/emails', (req, res) => {
    const auth = authOf(req);
    requireRole(auth, 'admin');
    res.json({
      smtp_configured: !!ctx.config.smtpUrl || !!ctx.mail,
      emails: db.all(
        `SELECT id, kind, to_email, subject, status, attempts, last_error, created_at, sent_at FROM outbound_emails
          WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 100`,
        auth.workspaceId,
      ),
    });
  });

  r.post('/integrations/emails/:id/retry', (req, res) => {
    const auth = authOf(req);
    requireRole(auth, 'admin');
    const changed = db.run(
      `UPDATE outbound_emails SET status = 'queued', next_attempt_at = ?, last_error = NULL WHERE id = ? AND workspace_id = ? AND status = 'failed'`,
      now(),
      req.params.id,
      auth.workspaceId,
    );
    if (!changed.changes) throw notFound('Failed email');
    res.json({ ok: true });
  });

  return r;
}
