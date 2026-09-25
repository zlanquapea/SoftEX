import { Router, type NextFunction, type Request, type Response } from 'express';
import type { IncomingMessage } from 'node:http';
import { z } from 'zod';
import type { Auth, Role } from '../access.js';
import type { Row } from '../db.js';
import { audit, authOf, platformEvent, type Ctx } from '../context.js';
import { generateSecret, otpauthUrl, verifyTotp } from '../totp.js';
import { queueEmail } from '../mailer.js';
import { TERMS_VERSION, effectivePlan, hasFeature, isOperator, isSaas, planError, requireMemberCapacity } from '../plans.js';
import {
  HttpError,
  badRequest,
  hashPassword,
  newId,
  now,
  parse,
  parseJson,
  pickColor,
  randomToken,
  sha256,
  verifyPassword,
} from '../util.js';

const COOKIE = 'softex_session';
const SESSION_DAYS = 14;

function readCookie(header: string | undefined, name: string) {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

function tokenFrom(req: IncomingMessage) {
  const bearer = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
  return bearer ?? readCookie(req.headers.cookie, COOKIE);
}

/** Resolve the session for an HTTP or WebSocket request; null when anonymous or revoked. */
export async function authenticate(ctx: Ctx, req: IncomingMessage): Promise<Auth | null> {
  const token = tokenFrom(req);
  if (!token) return null;
  if (token.startsWith('sx_')) return authenticateApiToken(ctx, token);
  const row = await ctx.db.get(
    `SELECT s.user_id, s.workspace_id, m.role FROM sessions s
       JOIN memberships m ON m.workspace_id = s.workspace_id AND m.user_id = s.user_id
       JOIN workspaces w ON w.id = s.workspace_id
      WHERE s.token_hash = ? AND s.expires_at > ? AND m.deactivated_at IS NULL AND w.suspended_at IS NULL
        AND (m.guest_expires_at IS NULL OR m.guest_expires_at > ?)`,
    sha256(token),
    now(),
    now(),
  );
  if (!row) return null;
  return { userId: row.user_id, workspaceId: row.workspace_id, role: row.role as Role };
}

/** Personal API tokens (§5.7 public API): act as the user, limited by the token's scope. */
async function authenticateApiToken(ctx: Ctx, token: string): Promise<Auth | null> {
  const row = await ctx.db.get(
    `SELECT t.id, t.user_id, t.workspace_id, t.scope, m.role FROM api_tokens t
       JOIN memberships m ON m.workspace_id = t.workspace_id AND m.user_id = t.user_id
       JOIN workspaces w ON w.id = t.workspace_id
      WHERE t.token_hash = ? AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > ?) AND w.suspended_at IS NULL
        AND m.deactivated_at IS NULL AND (m.guest_expires_at IS NULL OR m.guest_expires_at > ?)`,
    sha256(token),
    now(),
    now(),
  );
  if (!row) return null;
  await ctx.db.run('UPDATE api_tokens SET last_used_at = ? WHERE id = ?', now(), row.id);
  return { userId: row.user_id, workspaceId: row.workspace_id, role: row.role as Role, tokenScope: row.scope };
}

const tokenWindows = new Map<string, { count: number; reset: number }>();

export function requireAuth(ctx: Ctx) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const auth = await authenticate(ctx, req);
    if (!auth) return next(new HttpError(401, 'Please sign in'));
    req.auth = auth;
    if (auth.tokenScope) {
      if (!await hasFeature(ctx, auth.workspaceId, 'api')) {
        return next(planError('API access is available on the Standard plan.', { feature: 'api' }));
      }
      if (auth.tokenScope === 'read' && req.method !== 'GET') return next(new HttpError(403, 'This API token is read-only'));
      if (req.path.startsWith('/me/') || req.path.startsWith('/integrations')) {
        return next(new HttpError(403, 'API tokens cannot manage account settings or integrations'));
      }
      // 600 requests per minute per token.
      const key = sha256(tokenFrom(req)!);
      const t = Date.now();
      const w = tokenWindows.get(key);
      if (!w || w.reset < t) tokenWindows.set(key, { count: 1, reset: t + 60_000 });
      else if (++w.count > 600) return next(new HttpError(429, 'Rate limit exceeded for this API token'));
    }
    // Workspaces that require MFA block everything except MFA enrolment until it is set up.
    const needsMfa = await ctx.db.get(
      `SELECT 1 FROM workspaces w, users u WHERE w.id = ? AND u.id = ? AND w.require_mfa = 1 AND u.mfa_enabled = 0`,
      auth.workspaceId,
      auth.userId,
    );
    if (needsMfa && !req.path.startsWith('/me')) {
      return next(new HttpError(403, 'Multifactor authentication must be set up for this workspace', { code: 'mfa_setup_required' }));
    }
    next();
  };
}

export async function startSession(ctx: Ctx, res: Response, userId: string, workspaceId: string) {
  const token = randomToken();
  const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  await ctx.db.insert('sessions', {
    token_hash: sha256(token),
    user_id: userId,
    workspace_id: workspaceId,
    created_at: now(),
    expires_at: expires.toISOString(),
  });
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: ctx.config.secureCookies,
    expires,
    path: '/',
  });
  return token;
}

/** Tiny in-memory limiter for credential endpoints (§9 "rate limit abuse"). */
const attempts = new Map<string, { count: number; reset: number }>();
function rateLimit(key: string, max = 10, windowMs = 15 * 60_000) {
  const t = Date.now();
  const entry = attempts.get(key);
  if (!entry || entry.reset < t) {
    attempts.set(key, { count: 1, reset: t + windowMs });
    return;
  }
  entry.count += 1;
  if (entry.count > max) throw new HttpError(429, 'Too many attempts. Please wait a few minutes and try again.');
}
export const resetRateLimits = () => attempts.clear();

const Email = z.string().trim().toLowerCase().email().max(200);
const Password = z.string().min(8, 'must be at least 8 characters').max(200);
const Name = z.string().trim().min(1).max(80);

export async function mePayload(ctx: Ctx, auth: Auth) {
  const user = (await ctx.db.get(
    `SELECT id, name, email, title, timezone, working_hours, expertise, status, status_text, focus_until,
            quiet_start, quiet_end, color, mfa_enabled, email_digest, email_urgent, email_verified_at FROM users WHERE id = ?`,
    auth.userId,
  ))!;
  const workspace = (await ctx.db.get('SELECT * FROM workspaces WHERE id = ?', auth.workspaceId))!;
  const membership = (await ctx.db.get(
    'SELECT role, guest_expires_at, sponsor_id FROM memberships WHERE workspace_id = ? AND user_id = ?',
    auth.workspaceId,
    auth.userId,
  ))!;
  const workspaces = await ctx.db.all(
    `SELECT w.id, w.name, m.role FROM workspaces w JOIN memberships m ON m.workspace_id = w.id
      WHERE m.user_id = ? AND m.deactivated_at IS NULL AND w.suspended_at IS NULL ORDER BY w.name`,
    auth.userId,
  );
  const memberCount = (await ctx.db.get(
    'SELECT COUNT(*) AS n FROM memberships WHERE workspace_id = ? AND deactivated_at IS NULL',
    auth.workspaceId,
  ))!.n;
  return {
    user: {
      ...user,
      expertise: parseJson<string[]>(user.expertise, []),
      mfa_enabled: !!user.mfa_enabled,
      email_digest: !!user.email_digest,
      email_urgent: !!user.email_urgent,
      email_verified: !!user.email_verified_at,
    } as Row,
    workspace: {
      id: workspace.id,
      name: workspace.name,
      message_edit_policy: workspace.message_edit_policy,
      guest_default_days: workspace.guest_default_days,
      require_mfa: !!workspace.require_mfa,
      member_count: memberCount,
      sso_enabled: !!workspace.sso_enabled,
      sso_required: !!workspace.sso_required,
      ai_enabled: !!workspace.ai_enabled,
      retention_days: workspace.retention_days ?? null,
      legal_hold: !!workspace.legal_hold,
      ai_available: !!ctx.ai,
      plan: (({ id, name, status, trial_ends_at, paid_through, features }) => ({ id, name, status, trial_ends_at, paid_through, features }))(
        await effectivePlan(ctx, workspace),
      ),
    },
    mode: ctx.config.mode,
    operator: isOperator(ctx, user.email),
    role: membership.role,
    guest_expires_at: membership.guest_expires_at,
    mfa_setup_required: !!workspace.require_mfa && !user.mfa_enabled,
    workspaces,
  };
}

/** Email a link that proves the person owns their address (hosted servers). */
export async function sendVerificationEmail(ctx: Ctx, user: { id: string; name: string; email: string }) {
  const token = randomToken();
  await ctx.db.run('DELETE FROM email_verifications WHERE user_id = ?', user.id);
  await ctx.db.insert('email_verifications', {
    token_hash: sha256(token),
    user_id: user.id,
    email: user.email,
    expires_at: new Date(Date.now() + 3 * 86_400_000).toISOString(),
    created_at: now(),
  });
  await queueEmail(ctx, {
    kind: 'verify_email',
    to: user.email,
    subject: 'Confirm your email address for SoftEX',
    text: `Hi ${user.name.split(' ')[0]},\n\nPlease confirm this is your email address. The link works for three days. If you didn’t create a SoftEX account, you can ignore this email.`,
    action: { label: 'Confirm email address', url: `${ctx.config.publicUrl}/verify-email/${token}` },
  });
}

export function authRouter(ctx: Ctx) {
  const r = Router();
  const { db } = ctx;

  r.post('/auth/register', async (req, res) => {
    const body = parse(
      z.object({ name: Name, email: Email, password: Password, workspaceName: z.string().trim().min(2).max(80), acceptTerms: z.boolean().optional() }),
      req.body,
    );
    if (isSaas(ctx) && !body.acceptTerms) throw badRequest('Please accept the Terms of Service and Privacy Policy to continue');
    rateLimit(`register:${req.ip}`, 20);
    const { registration } = ctx.config;
    if (registration === 'closed' || (registration === 'first' && await db.get('SELECT 1 FROM workspaces LIMIT 1'))) {
      throw new HttpError(403, 'New workspaces cannot be created on this server. Ask an admin to invite you.');
    }
    if (await db.get('SELECT 1 FROM users WHERE email = ?', body.email)) {
      throw new HttpError(409, 'An account with this email already exists. Sign in instead.');
    }
    const userId = newId();
    const workspaceId = newId();
    await db.transaction(async () => {
      await db.insert('users', {
        id: userId,
        email: body.email,
        name: body.name,
        password_hash: hashPassword(body.password),
        color: pickColor(body.email),
        email_verified_at: isSaas(ctx) ? null : now(),
        terms_accepted_at: body.acceptTerms ? now() : null,
        terms_version: body.acceptTerms ? TERMS_VERSION : null,
        created_at: now(),
      });
      await db.insert('workspaces', {
        id: workspaceId,
        name: body.workspaceName,
        plan: 'free',
        trial_ends_at: isSaas(ctx) ? new Date(Date.now() + ctx.config.billing.trialDays * 86_400_000).toISOString() : null,
        created_at: now(),
      });
      await db.insert('memberships', { workspace_id: workspaceId, user_id: userId, role: 'owner', created_at: now() });
      const generalId = newId();
      await db.insert('channels', {
        id: generalId,
        workspace_id: workspaceId,
        name: 'general',
        topic: 'Company-wide conversation',
        kind: 'public',
        created_by: userId,
        created_at: now(),
      });
      await db.insert('channel_members', { channel_id: generalId, user_id: userId, joined_at: now() });
      const annId = newId();
      await db.insert('channels', {
        id: annId,
        workspace_id: workspaceId,
        name: 'announcements',
        topic: 'Important notices. Leads and admins can post.',
        kind: 'announcement',
        created_by: userId,
        created_at: now(),
      });
      await db.insert('channel_members', { channel_id: annId, user_id: userId, joined_at: now() });
      await audit(ctx, workspaceId, userId, 'workspace.created', 'workspace', workspaceId, { name: body.workspaceName });
    });
    if (isSaas(ctx)) await sendVerificationEmail(ctx, { id: userId, name: body.name, email: body.email });
    await startSession(ctx, res, userId, workspaceId);
    res.status(201).json(await mePayload(ctx, { userId, workspaceId, role: 'owner' }));
  });

  r.post('/auth/login', async (req, res) => {
    const body = parse(
      z.object({ email: Email, password: z.string().min(1).max(200), code: z.string().optional(), workspaceId: z.string().optional() }),
      req.body,
    );
    rateLimit(`login:${req.ip}:${body.email}`);
    const user = await db.get('SELECT * FROM users WHERE email = ?', body.email);
    if (!user || !verifyPassword(body.password, user.password_hash)) {
      throw new HttpError(401, 'Email or password is incorrect');
    }
    if (user.mfa_enabled) {
      if (!body.code) throw new HttpError(401, 'Enter the code from your authenticator app', { code: 'mfa_required' });
      if (!verifyTotp(user.mfa_secret, body.code)) throw new HttpError(401, 'That code is not valid', { code: 'mfa_required' });
    }
    const all = await db.all(
      `SELECT m.workspace_id, m.role, w.suspended_at FROM memberships m JOIN workspaces w ON w.id = m.workspace_id
        WHERE m.user_id = ? AND m.deactivated_at IS NULL
         AND (m.guest_expires_at IS NULL OR m.guest_expires_at > ?) ORDER BY m.created_at`,
      user.id,
      now(),
    );
    const memberships = all.filter((m) => !m.suspended_at);
    const membership = memberships.find((m) => m.workspace_id === body.workspaceId) ?? memberships[0];
    if (!membership && all.length) {
      throw new HttpError(403, `This workspace has been suspended. Contact ${ctx.config.billing.supportEmail ?? 'support'} for help.`, { code: 'workspace_suspended' });
    }
    if (!membership) throw new HttpError(403, 'Your access to SoftEX has ended. Contact your workspace administrator.');
    const ws = (await db.get('SELECT sso_enabled, sso_required FROM workspaces WHERE id = ?', membership.workspace_id))!;
    if (ws.sso_enabled && ws.sso_required && membership.role !== 'owner') {
      throw new HttpError(403, 'Your workspace requires single sign-on. Use “Sign in with SSO”.', { code: 'sso_required' });
    }
    await startSession(ctx, res, user.id, membership.workspace_id);
    await audit(ctx, membership.workspace_id, user.id, 'auth.login', 'user', user.id, { ip: req.ip });
    res.json(await mePayload(ctx, { userId: user.id, workspaceId: membership.workspace_id, role: membership.role }));
  });

  r.post('/auth/logout', async (req, res) => {
    const token = tokenFrom(req);
    if (token) await db.run('DELETE FROM sessions WHERE token_hash = ?', sha256(token));
    res.clearCookie(COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  r.post('/auth/verify-email', async (req, res) => {
    const { token } = parse(z.object({ token: z.string().min(10).max(200) }), req.body);
    rateLimit(`verify:${req.ip}`, 30);
    const row = await db.get('SELECT * FROM email_verifications WHERE token_hash = ? AND expires_at > ?', sha256(token), now());
    const user = row ? await db.get('SELECT id, email FROM users WHERE id = ?', row.user_id) : undefined;
    // The link only counts for the address it was sent to.
    if (!row || !user || user.email !== row.email) throw new HttpError(400, 'This confirmation link has expired or was already used. Sign in and send a new one.');
    await db.transaction(async () => {
      await db.run('UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?', now(), user.id);
      await db.run('DELETE FROM email_verifications WHERE user_id = ?', user.id);
    });
    res.json({ ok: true });
  });

  // ----- Password reset by email -----

  r.post('/auth/forgot', async (req, res) => {
    const { email } = parse(z.object({ email: Email }), req.body);
    rateLimit(`forgot:${req.ip}`, 10);
    const user = await db.get('SELECT id, name, email FROM users WHERE email = ?', email);
    if (user) {
      const token = randomToken();
      await db.insert('password_resets', { token_hash: sha256(token), user_id: user.id, expires_at: new Date(Date.now() + 3_600_000).toISOString(), created_at: now() });
      await queueEmail(ctx, {
        kind: 'password_reset',
        to: user.email,
        subject: 'Reset your SoftEX password',
        text: `Hi ${user.name.split(' ')[0]},\n\nSomeone asked to reset the password for your SoftEX account. The link below works for one hour. If this wasn’t you, you can ignore this email — your password stays the same.`,
        action: { label: 'Choose a new password', url: `${ctx.config.publicUrl}/reset-password/${token}` },
      });
    }
    // Same answer either way so the endpoint cannot be used to discover accounts.
    res.json({ ok: true });
  });

  r.post('/auth/reset', async (req, res) => {
    const body = parse(z.object({ token: z.string().min(10), password: Password }), req.body);
    rateLimit(`reset:${req.ip}`, 20);
    const reset = await db.get('SELECT * FROM password_resets WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?', sha256(body.token), now());
    if (!reset) throw new HttpError(400, 'This reset link has expired or was already used. Request a new one.');
    await db.transaction(async () => {
      await db.run('UPDATE password_resets SET used_at = ? WHERE token_hash = ?', now(), reset.token_hash);
      await db.update('users', reset.user_id, { password_hash: hashPassword(body.password) });
      // The reset link reached this inbox, which proves the address.
      await db.run('UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?', now(), reset.user_id);
      await db.run('DELETE FROM sessions WHERE user_id = ?', reset.user_id);
      for (const m of await db.all('SELECT workspace_id FROM memberships WHERE user_id = ?', reset.user_id)) {
        await audit(ctx, m.workspace_id, reset.user_id, 'user.password_reset', 'user', reset.user_id);
      }
    });
    res.json({ ok: true });
  });

  // ----- Invitations (public: token is the credential) -----

  const loadInvitation = async (token: string) => {
    const invite = await db.get(
      `SELECT i.*, w.name AS workspace_name, u.name AS inviter_name FROM invitations i
         JOIN workspaces w ON w.id = i.workspace_id JOIN users u ON u.id = i.invited_by
        WHERE i.token_hash = ? AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > ?`,
      sha256(token),
      now(),
    );
    if (!invite) throw new HttpError(404, 'This invitation is no longer valid');
    return invite;
  };

  r.get('/invitations/:token', async (req, res) => {
    const invite = await loadInvitation(req.params.token);
    const existing = !!await db.get('SELECT 1 FROM users WHERE email = ?', invite.email);
    res.json({
      email: invite.email,
      role: invite.role,
      workspace_name: invite.workspace_name,
      inviter_name: invite.inviter_name,
      existing_account: existing,
    });
  });

  r.post('/invitations/:token/accept', async (req, res) => {
    const invite = await loadInvitation(req.params.token);
    const target = (await db.get('SELECT suspended_at FROM workspaces WHERE id = ?', invite.workspace_id))!;
    if (target.suspended_at) throw new HttpError(403, 'This workspace has been suspended.', { code: 'workspace_suspended' });
    const alreadyActive = await db.get(
      `SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? AND u.email = ? AND m.deactivated_at IS NULL`,
      invite.workspace_id,
      invite.email,
    );
    if (!alreadyActive) await requireMemberCapacity(ctx, invite.workspace_id, 1, invite.role);
    const body = parse(z.object({ name: Name.optional(), password: z.string().min(1).max(200), acceptTerms: z.boolean().optional() }), req.body);
    let user = await db.get('SELECT * FROM users WHERE email = ?', invite.email);
    if (user) {
      if (!verifyPassword(body.password, user.password_hash)) throw new HttpError(401, 'Password is incorrect');
    } else {
      if (!body.name) throw badRequest('name: Required');
      if (isSaas(ctx) && !body.acceptTerms) throw badRequest('Please accept the Terms of Service and Privacy Policy to continue');
      parse(Password, body.password);
      const id = newId();
      await db.insert('users', {
        id,
        email: invite.email,
        name: body.name,
        password_hash: hashPassword(body.password),
        color: pickColor(invite.email),
        // The invitation link was emailed to this address.
        email_verified_at: now(),
        terms_accepted_at: body.acceptTerms ? now() : null,
        terms_version: body.acceptTerms ? TERMS_VERSION : null,
        created_at: now(),
      });
      user = (await db.get('SELECT * FROM users WHERE id = ?', id))!;
    }
    const userId = user.id as string;
    await db.run('UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?', now(), userId);
    await db.transaction(async () => {
      const guestExpires =
        invite.role === 'guest' ? new Date(Date.now() + (invite.guest_days ?? 30) * 86_400_000).toISOString() : null;
      const existing = await db.get('SELECT * FROM memberships WHERE workspace_id = ? AND user_id = ?', invite.workspace_id, userId);
      if (existing) {
        await db.run(
          `UPDATE memberships SET role = ?, deactivated_at = NULL, guest_expires_at = ?, sponsor_id = ?
            WHERE workspace_id = ? AND user_id = ?`,
          invite.role,
          guestExpires,
          invite.role === 'guest' ? invite.invited_by : null,
          invite.workspace_id,
          userId,
        );
      } else {
        await db.insert('memberships', {
          workspace_id: invite.workspace_id,
          user_id: userId,
          role: invite.role,
          sponsor_id: invite.role === 'guest' ? invite.invited_by : null,
          guest_expires_at: guestExpires,
          created_at: now(),
        });
      }
      if (invite.role !== 'guest') {
        const defaults = await db.all(
          `SELECT id FROM channels WHERE workspace_id = ? AND kind IN ('public','announcement') AND name IN ('general','announcements')`,
          invite.workspace_id,
        );
        for (const c of defaults) {
          await db.run('INSERT OR IGNORE INTO channel_members (channel_id, user_id, joined_at) VALUES (?, ?, ?)', c.id, userId, now());
        }
      }
      for (const channelId of parseJson<string[]>(invite.channel_ids, [])) {
        if (await db.get('SELECT 1 FROM channels WHERE id = ? AND workspace_id = ?', channelId, invite.workspace_id)) {
          await db.run('INSERT OR IGNORE INTO channel_members (channel_id, user_id, joined_at) VALUES (?, ?, ?)', channelId, userId, now());
        }
      }
      for (const projectId of parseJson<string[]>(invite.project_ids, [])) {
        if (await db.get('SELECT 1 FROM projects WHERE id = ? AND workspace_id = ?', projectId, invite.workspace_id)) {
          await db.run('INSERT OR IGNORE INTO project_members (project_id, user_id) VALUES (?, ?)', projectId, userId);
        }
      }
      await db.run('UPDATE invitations SET accepted_at = ? WHERE id = ?', now(), invite.id);
      await audit(ctx, invite.workspace_id, userId, 'invitation.accepted', 'invitation', invite.id, { role: invite.role });
    });
    await startSession(ctx, res, userId, invite.workspace_id);
    res.json(await mePayload(ctx, { userId, workspaceId: invite.workspace_id, role: invite.role }));
  });

  return r;
}

/** Routes for the signed-in user's own account. Mounted behind requireAuth. */
export function meRouter(ctx: Ctx) {
  const r = Router();
  const { db } = ctx;

  r.get('/me', async (req, res) => res.json(await mePayload(ctx, authOf(req))));

  r.patch('/me', async (req, res) => {
    const auth = authOf(req);
    const Time = z.string().regex(/^\d{2}:\d{2}$/).nullable();
    const body = parse(
      z.object({
        name: Name.optional(),
        title: z.string().max(80).optional(),
        timezone: z.string().max(60).optional(),
        working_hours: z.string().max(40).optional(),
        expertise: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
        status: z.enum(['available', 'focus', 'away', 'busy']).optional(),
        status_text: z.string().max(100).optional(),
        focus_until: z.string().datetime().nullable().optional(),
        quiet_start: Time.optional(),
        quiet_end: Time.optional(),
        email_digest: z.boolean().optional(),
        email_urgent: z.boolean().optional(),
      }),
      req.body,
    );
    if (body.timezone) {
      try {
        new Intl.DateTimeFormat('en', { timeZone: body.timezone });
      } catch {
        throw badRequest('timezone: Unknown time zone');
      }
    }
    await db.update('users', auth.userId, body);
    const payload = await mePayload(ctx, auth);
    await ctx.hub.publish(auth.workspaceId, {
      type: 'user.updated',
      user: { id: auth.userId, name: payload.user.name, status: payload.user.status, status_text: payload.user.status_text, color: payload.user.color },
    });
    res.json(payload);
  });

  r.post('/me/verify-email/resend', async (req, res) => {
    const auth = authOf(req);
    rateLimit(`verify-resend:${auth.userId}`, 5, 60 * 60_000);
    const user = (await db.get('SELECT id, name, email, email_verified_at FROM users WHERE id = ?', auth.userId))!;
    if (user.email_verified_at) throw badRequest('Your email address is already confirmed');
    await sendVerificationEmail(ctx, user as { id: string; name: string; email: string });
    res.json({ ok: true, email: user.email });
  });

  r.post('/me/password', async (req, res) => {
    const auth = authOf(req);
    const body = parse(z.object({ current: z.string(), next: Password }), req.body);
    const user = (await db.get('SELECT password_hash FROM users WHERE id = ?', auth.userId))!;
    if (!verifyPassword(body.current, user.password_hash)) throw new HttpError(401, 'Current password is incorrect');
    await db.update('users', auth.userId, { password_hash: hashPassword(body.next) });
    const keep = sha256(tokenFrom(req) ?? '');
    await db.run('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?', auth.userId, keep);
    await audit(ctx, auth.workspaceId, auth.userId, 'user.password_changed', 'user', auth.userId);
    res.json({ ok: true });
  });

  r.post('/me/mfa/setup', async (req, res) => {
    const auth = authOf(req);
    const user = (await db.get('SELECT email, mfa_enabled FROM users WHERE id = ?', auth.userId))!;
    if (user.mfa_enabled) throw badRequest('Multifactor authentication is already enabled');
    const secret = generateSecret();
    await db.update('users', auth.userId, { mfa_secret: secret });
    res.json({ secret, otpauth_url: otpauthUrl(secret, user.email) });
  });

  r.post('/me/mfa/enable', async (req, res) => {
    const auth = authOf(req);
    const { code } = parse(z.object({ code: z.string() }), req.body);
    const user = (await db.get('SELECT mfa_secret FROM users WHERE id = ?', auth.userId))!;
    if (!user.mfa_secret || !verifyTotp(user.mfa_secret, code)) throw badRequest('That code is not valid. Try the next one.');
    await db.update('users', auth.userId, { mfa_enabled: 1 });
    await audit(ctx, auth.workspaceId, auth.userId, 'user.mfa_enabled', 'user', auth.userId);
    res.json(await mePayload(ctx, auth));
  });

  r.post('/me/mfa/disable', async (req, res) => {
    const auth = authOf(req);
    const { password } = parse(z.object({ password: z.string() }), req.body);
    const user = (await db.get('SELECT password_hash FROM users WHERE id = ?', auth.userId))!;
    if (!verifyPassword(password, user.password_hash)) throw new HttpError(401, 'Password is incorrect');
    const ws = (await db.get('SELECT require_mfa FROM workspaces WHERE id = ?', auth.workspaceId))!;
    if (ws.require_mfa) throw badRequest('Your workspace requires multifactor authentication');
    await db.update('users', auth.userId, { mfa_enabled: 0, mfa_secret: null });
    await audit(ctx, auth.workspaceId, auth.userId, 'user.mfa_disabled', 'user', auth.userId);
    res.json(await mePayload(ctx, auth));
  });

  // Delete your own account. Content you wrote stays with your workspaces, attributed to "Deleted user";
  // your name, email, credentials and personal settings are erased.
  r.delete('/me', async (req, res) => {
    const auth = authOf(req);
    if (auth.tokenScope) throw new HttpError(403, 'API tokens cannot delete accounts');
    const body = parse(z.object({ password: z.string().min(1).max(200), code: z.string().max(10).optional() }), req.body);
    const user = (await db.get('SELECT * FROM users WHERE id = ?', auth.userId))!;
    if (!verifyPassword(body.password, user.password_hash)) throw new HttpError(401, 'Password is incorrect');
    if (user.mfa_enabled && (!body.code || !verifyTotp(user.mfa_secret, body.code))) throw new HttpError(401, 'Enter a valid code from your authenticator app', { code: 'mfa_required' });
    const soleOwner = await db.all(
      `SELECT w.name FROM memberships m JOIN workspaces w ON w.id = m.workspace_id
        WHERE m.user_id = ? AND m.role = 'owner' AND m.deactivated_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM memberships o WHERE o.workspace_id = m.workspace_id AND o.role = 'owner' AND o.deactivated_at IS NULL AND o.user_id != m.user_id)`,
      auth.userId,
    );
    if (soleOwner.length) {
      throw new HttpError(
        409,
        `You are the only owner of ${soleOwner.map((w) => w.name).join(', ')}. Make someone else an owner, or delete the workspace, before deleting your account.`,
        { code: 'sole_owner', workspaces: soleOwner.map((w) => w.name) },
      );
    }
    const workspaces = await db.all('SELECT m.workspace_id, w.name FROM memberships m JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = ?', auth.userId);
    await db.transaction(async () => {
      for (const table of ['sessions', 'email_verifications', 'password_resets', 'saved_messages', 'notifications', 'reminders', 'channel_members']) {
        await db.run(`DELETE FROM ${table} WHERE user_id = ?`, auth.userId);
      }
      await db.run('DELETE FROM scheduled_messages WHERE user_id = ? AND sent_message_id IS NULL', auth.userId);
      await db.run('UPDATE api_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE user_id = ?', now(), auth.userId);
      await db.run('UPDATE memberships SET deactivated_at = COALESCE(deactivated_at, ?) WHERE user_id = ?', now(), auth.userId);
      await db.update('users', auth.userId, {
        email: `deleted-${auth.userId}@deleted.invalid`,
        name: 'Deleted user',
        password_hash: hashPassword(randomToken()),
        title: '',
        expertise: '[]',
        status: 'away',
        status_text: '',
        focus_until: null,
        mfa_secret: null,
        mfa_enabled: 0,
        email_verified_at: null,
        email_digest: 0,
        email_urgent: 0,
      });
      for (const w of workspaces) await audit(ctx, w.workspace_id, null, 'user.account_deleted', 'user', auth.userId);
      await platformEvent(ctx, user.email, 'account.deleted', null, { workspaces: workspaces.length });
    });
    for (const w of workspaces) ctx.hub.disconnect(w.workspace_id, auth.userId);
    res.clearCookie(COOKIE, { path: '/' });
    res.json({ deleted: true });
  });

  r.post('/me/switch-workspace', async (req, res) => {
    const auth = authOf(req);
    const { workspaceId } = parse(z.object({ workspaceId: z.string() }), req.body);
    const m = await db.get(
      `SELECT m.role FROM memberships m JOIN workspaces w ON w.id = m.workspace_id
        WHERE m.workspace_id = ? AND m.user_id = ? AND m.deactivated_at IS NULL AND w.suspended_at IS NULL
         AND (m.guest_expires_at IS NULL OR m.guest_expires_at > ?)`,
      workspaceId,
      auth.userId,
      now(),
    );
    if (!m) throw new HttpError(404, 'Workspace not found');
    const token = tokenFrom(req);
    if (token) await db.run('DELETE FROM sessions WHERE token_hash = ?', sha256(token));
    await startSession(ctx, res, auth.userId, workspaceId);
    res.json(await mePayload(ctx, { userId: auth.userId, workspaceId, role: m.role }));
  });

  return r;
}
