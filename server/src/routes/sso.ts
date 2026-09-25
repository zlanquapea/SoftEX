import { createCipheriv, createDecipheriv, createHash, createPublicKey, randomBytes, verify as verifySignature } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { requireRole } from '../access.js';
import { audit, authOf, type Ctx } from '../context.js';
import { badRequest, hashPassword, HttpError, newId, now, parse, pickColor, randomToken } from '../util.js';
import { requireFeature, requireMemberCapacity } from '../plans.js';
import { startSession } from './auth.js';

/**
 * Single sign-on with OpenID Connect (authorization code flow + PKCE), §5.7.
 * Works with Google Workspace, Microsoft Entra ID, Okta, Auth0, Keycloak and any
 * other standards-compliant provider. Each workspace configures its own
 * provider and email domain; client secrets are encrypted at rest.
 */

type JsonWebKey = Record<string, unknown> & { kty?: string };

// ---------- Secret encryption ----------

const keyFrom = (secret: string) => createHash('sha256').update(secret).digest();

export function encryptSecret(secretKey: string, plain: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFrom(secretKey), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${data.toString('base64')}`;
}

export function decryptSecret(secretKey: string, stored: string) {
  const [v, iv, tag, data] = stored.split(':');
  if (v !== 'v1') throw new Error('Unknown secret format');
  const decipher = createDecipheriv('aes-256-gcm', keyFrom(secretKey), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}

// ---------- OIDC helpers ----------

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

const discoveryCache = new Map<string, { at: number; doc: Discovery }>();
const jwksCache = new Map<string, { at: number; keys: (JsonWebKey & { kid?: string })[] }>();

async function getJson(url: string) {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000), headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${url} responded ${res.status}`);
  return res.json();
}

export async function discover(issuer: string): Promise<Discovery> {
  const cached = discoveryCache.get(issuer);
  if (cached && Date.now() - cached.at < 3_600_000) return cached.doc;
  const doc = (await getJson(`${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`)) as Discovery;
  for (const key of ['issuer', 'authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const) {
    if (typeof doc[key] !== 'string') throw new Error(`Provider configuration is missing ${key}`);
  }
  discoveryCache.set(issuer, { at: Date.now(), doc });
  return doc;
}

async function jwks(uri: string, forceRefresh = false) {
  const cached = jwksCache.get(uri);
  if (!forceRefresh && cached && Date.now() - cached.at < 3_600_000) return cached.keys;
  const { keys } = (await getJson(uri)) as { keys: (JsonWebKey & { kid?: string })[] };
  jwksCache.set(uri, { at: Date.now(), keys });
  return keys;
}

const b64url = (s: string) => Buffer.from(s, 'base64url');

export async function verifyIdToken(idToken: string, opts: { issuer: string; clientId: string; nonce: string; jwksUri: string }) {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('Malformed ID token');
  const header = JSON.parse(b64url(parts[0]).toString('utf8'));
  const claims = JSON.parse(b64url(parts[1]).toString('utf8'));
  const alg = header.alg as string;
  if (!['RS256', 'ES256'].includes(alg)) throw new Error(`Unsupported signing algorithm ${alg}`);
  const find = (keys: (JsonWebKey & { kid?: string })[]) => keys.find((k) => (!header.kid || k.kid === header.kid) && (alg === 'RS256' ? k.kty === 'RSA' : k.kty === 'EC'));
  let jwk = find(await jwks(opts.jwksUri));
  if (!jwk) jwk = find(await jwks(opts.jwksUri, true)); // provider rotated keys
  if (!jwk) throw new Error('Signing key not found');
  const key = createPublicKey({ key: jwk as never, format: 'jwk' });
  const ok = verifySignature(
    'sha256',
    Buffer.from(`${parts[0]}.${parts[1]}`),
    alg === 'ES256' ? { key, dsaEncoding: 'ieee-p1363' } : key,
    b64url(parts[2]),
  );
  if (!ok) throw new Error('Invalid ID token signature');
  const t = Math.floor(Date.now() / 1000);
  if (claims.iss !== opts.issuer) throw new Error('ID token issuer mismatch');
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(opts.clientId)) throw new Error('ID token audience mismatch');
  if (typeof claims.exp !== 'number' || claims.exp < t - 60) throw new Error('ID token expired');
  if (claims.nonce !== opts.nonce) throw new Error('ID token nonce mismatch');
  return claims as { sub: string; email?: string; email_verified?: boolean | string; name?: string };
}

// ---------- Routes ----------

const domainOf = (email: string) => email.split('@')[1]?.toLowerCase() ?? '';

export function ssoPublicRouter(ctx: Ctx) {
  const r = Router();
  const { db } = ctx;
  const redirectUri = () => `${ctx.config.publicUrl}/api/auth/sso/callback`;

  const workspaceForEmail = async (email: string) =>
    await db.get(`SELECT * FROM workspaces WHERE sso_enabled = 1 AND sso_domain = ? LIMIT 1`, domainOf(email));

  r.get('/auth/sso/discover', async (req, res) => {
    const { email } = parse(z.object({ email: z.string().trim().toLowerCase().email() }), req.query);
    const ws = await workspaceForEmail(email);
    res.json({ sso: !!ws, workspace_name: ws?.name ?? null, required: !!ws?.sso_required });
  });

  r.get('/auth/sso/start', async (req, res) => {
    const { email } = parse(z.object({ email: z.string().trim().toLowerCase().email() }), req.query);
    const ws = await workspaceForEmail(email);
    if (!ws) throw new HttpError(404, 'Single sign-on is not set up for this email domain');
    const doc = await discover(ws.sso_issuer);
    const state = randomToken();
    const nonce = randomToken();
    const verifier = randomToken();
    await db.run('DELETE FROM sso_states WHERE created_at < ?', new Date(Date.now() - 15 * 60_000).toISOString());
    await db.insert('sso_states', { state, workspace_id: ws.id, nonce, code_verifier: verifier, created_at: now() });
    const url = new URL(doc.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: ws.sso_client_id,
      redirect_uri: redirectUri(),
      scope: 'openid email profile',
      state,
      nonce,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      login_hint: email,
    }).toString();
    res.redirect(url.toString());
  });

  r.get('/auth/sso/callback', async (req, res) => {
    const fail = (message: string) => res.redirect(`/login?sso_error=${encodeURIComponent(message)}`);
    const q = req.query as Record<string, string | undefined>;
    if (q.error) return fail(q.error_description || q.error);
    const saved = q.state ? await db.get('SELECT * FROM sso_states WHERE state = ?', q.state) : undefined;
    if (!saved || !q.code || saved.created_at < new Date(Date.now() - 15 * 60_000).toISOString()) return fail('Your sign-in attempt expired. Please try again.');
    await db.run('DELETE FROM sso_states WHERE state = ?', saved.state);
    const ws = await db.get('SELECT * FROM workspaces WHERE id = ? AND sso_enabled = 1', saved.workspace_id);
    if (!ws || !ctx.config.secretKey) return fail('Single sign-on is no longer enabled for this workspace.');
    if (ws.suspended_at) return fail('This workspace has been suspended.');
    try {
      const doc = await discover(ws.sso_issuer);
      const tokenRes = await fetch(doc.token_endpoint, {
        method: 'POST',
        signal: AbortSignal.timeout(10_000),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: q.code,
          redirect_uri: redirectUri(),
          client_id: ws.sso_client_id,
          client_secret: decryptSecret(ctx.config.secretKey, ws.sso_client_secret),
          code_verifier: saved.code_verifier,
        }),
      });
      const tokens = (await tokenRes.json()) as { id_token?: string; error?: string };
      if (!tokenRes.ok || !tokens.id_token) throw new Error(tokens.error ?? `Token endpoint responded ${tokenRes.status}`);
      const claims = await verifyIdToken(tokens.id_token, { issuer: doc.issuer, clientId: ws.sso_client_id, nonce: saved.nonce, jwksUri: doc.jwks_uri });
      const email = claims.email?.toLowerCase();
      if (!email || claims.email_verified === false || claims.email_verified === 'false') throw new Error('Your identity provider did not return a verified email address');
      if (domainOf(email) !== ws.sso_domain) throw new Error(`Only ${ws.sso_domain} accounts can sign in to ${ws.name}`);

      let user = await db.get('SELECT * FROM users WHERE email = ?', email);
      let membership = user ? await db.get('SELECT * FROM memberships WHERE workspace_id = ? AND user_id = ?', ws.id, user.id) : undefined;
      if (membership?.deactivated_at) throw new Error('Your access to this workspace has been removed');
      if (!membership) {
        if (!ws.sso_auto_provision) throw new Error('You do not have an account in this workspace yet. Ask an administrator to invite you.');
        await requireMemberCapacity(ctx, ws.id, 1);
        await db.transaction(async () => {
          if (!user) {
            const id = newId();
            await db.insert('users', {
              id,
              email,
              name: (claims.name || email.split('@')[0]).slice(0, 80),
              // Random, never-shared password: the account signs in through SSO (or a reset link).
              password_hash: hashPassword(randomToken()),
              color: pickColor(email),
              email_verified_at: now(),
              created_at: now(),
            });
            user = (await db.get('SELECT * FROM users WHERE id = ?', id))!;
          }
          await db.insert('memberships', { workspace_id: ws.id, user_id: user!.id, role: 'member', created_at: now() });
          for (const c of await db.all(`SELECT id FROM channels WHERE workspace_id = ? AND kind IN ('public','announcement') AND name IN ('general','announcements')`, ws.id)) {
            await db.run('INSERT OR IGNORE INTO channel_members (channel_id, user_id, joined_at) VALUES (?, ?, ?)', c.id, user!.id, now());
          }
          await audit(ctx, ws.id, user!.id, 'sso.provisioned', 'user', user!.id, { email });
        });
        membership = { role: 'member' };
      }
      await startSession(ctx, res, user!.id, ws.id);
      await audit(ctx, ws.id, user!.id, 'auth.sso_login', 'user', user!.id, { ip: req.ip });
      res.redirect('/');
    } catch (error) {
      await audit(ctx, ws.id, null, 'auth.sso_failed', 'workspace', ws.id, { reason: (error as Error).message });
      fail((error as Error).message);
    }
  });

  return r;
}

export function ssoAdminRouter(ctx: Ctx) {
  const r = Router();
  const { db } = ctx;

  r.get('/admin/sso', async (req, res) => {
    const auth = authOf(req);
    requireRole(auth, 'admin');
    const ws = (await db.get('SELECT * FROM workspaces WHERE id = ?', auth.workspaceId))!;
    res.json({
      available: !!ctx.config.secretKey,
      enabled: !!ws.sso_enabled,
      issuer: ws.sso_issuer ?? '',
      client_id: ws.sso_client_id ?? '',
      has_client_secret: !!ws.sso_client_secret,
      domain: ws.sso_domain ?? '',
      required: !!ws.sso_required,
      auto_provision: !!ws.sso_auto_provision,
      redirect_uri: `${ctx.config.publicUrl}/api/auth/sso/callback`,
    });
  });

  r.put('/admin/sso', async (req, res) => {
    const auth = authOf(req);
    requireRole(auth, 'admin');
    if (!ctx.config.secretKey) throw badRequest('Set SOFTEX_SECRET_KEY on the server before configuring single sign-on');
    const body = parse(
      z.object({
        enabled: z.boolean(),
        issuer: z.string().url().max(300),
        clientId: z.string().trim().min(1).max(300),
        clientSecret: z.string().max(500).optional(),
        domain: z
          .string()
          .trim()
          .toLowerCase()
          .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, 'enter a domain such as acme.com'),
        required: z.boolean().default(false),
        autoProvision: z.boolean().default(true),
      }),
      req.body,
    );
    if (body.enabled) await requireFeature(ctx, auth.workspaceId, 'sso');
    const ws = (await db.get('SELECT * FROM workspaces WHERE id = ?', auth.workspaceId))!;
    const clash = await db.get('SELECT 1 FROM workspaces WHERE sso_domain = ? AND sso_enabled = 1 AND id != ?', body.domain, auth.workspaceId);
    if (body.enabled && clash) throw badRequest('Another workspace already uses single sign-on for this domain');
    if (!body.clientSecret && !ws.sso_client_secret) throw badRequest('clientSecret: Required');
    if (body.enabled) {
      try {
        await discover(body.issuer);
      } catch (e) {
        throw badRequest(`Could not read the provider configuration: ${(e as Error).message}`);
      }
    }
    await db.update('workspaces', auth.workspaceId, {
      sso_enabled: body.enabled,
      sso_issuer: body.issuer.replace(/\/$/, ''),
      sso_client_id: body.clientId,
      sso_client_secret: body.clientSecret ? encryptSecret(ctx.config.secretKey, body.clientSecret) : undefined,
      sso_domain: body.domain,
      sso_required: body.required,
      sso_auto_provision: body.autoProvision,
    });
    await audit(ctx, auth.workspaceId, auth.userId, 'workspace.sso_updated', 'workspace', auth.workspaceId, {
      enabled: body.enabled,
      issuer: body.issuer,
      domain: body.domain,
      required: body.required,
      autoProvision: body.autoProvision,
    });
    res.json({ ok: true });
  });

  return r;
}
