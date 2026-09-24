import { Router, type NextFunction, type Request, type Response } from 'express';
import type { IncomingMessage } from 'node:http';
import { z } from 'zod';
import type { Auth, Role } from '../access.js';
import type { Row } from '../db.js';
import { audit, authOf, type Ctx } from '../context.js';
import { generateSecret, otpauthUrl, verifyTotp } from '../totp.js';
import { queueEmail } from '../mailer.js';
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
export function authenticate(ctx: Ctx, req: IncomingMessage): Auth | null {
  const token = tokenFrom(req);
  if (!token) return null;
  if (token.startsWith('sx_')) return authenticateApiToken(ctx, token);
  const row = ctx.db.get(
    `SELECT s.user_id, s.workspace_id, m.role FROM sessions s
       JOIN memberships m ON m.workspace_id = s.workspace_id AND m.user_id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ? AND m.deactivated_at IS NULL
        AND (m.guest_expires_at IS NULL OR m.guest_expires_at > ?)`,
    sha256(token),
    now(),
    now(),
  );
  if (!row) return null;
  return { userId: row.user_id, workspaceId: row.workspace_id, role: row.role as Role };
}

/** Personal API tokens (§5.7 public API): act as the user, limited by the token's scope. */
function authenticateApiToken(ctx: Ctx, token: string): Auth | null {
  const row = ctx.db.get(
    `SELECT t.id, t.user_id, t.workspace_id, t.scope, m.role FROM api_tokens t
       JOIN memberships m ON m.workspace_id = t.workspace_id AND m.user_id = t.user_id
      WHERE t.token_hash = ? AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > ?)
        AND m.deactivated_at IS NULL AND (m.guest_expires_at IS NULL OR m.guest_expires_at > ?)`,
    sha256(token),
    now(),
    now(),
  );
  if (!row) return null;
  ctx.db.run('UPDATE api_tokens SET last_used_at = ? WHERE id = ?', now(), row.id);
  return { userId: row.user_id, workspaceId: row.workspace_id, role: row.role as Role, tokenScope: row.scope };
}

const tokenWindows = new Map<string, { count: number; reset: number }>();

export function requireAuth(ctx: Ctx) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const auth = authenticate(ctx, req);
    if (!auth) return next(new HttpError(401, 'Please sign in'));
    req.auth = auth;
    if (auth.tokenScope) {
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
    const needsMfa = ctx.db.get(
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

export function startSession(ctx: Ctx, res: Response, userId: string, workspaceId: string) {
  const token = randomToken();
  const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  ctx.db.insert('sessions', {
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

export function mePayload(ctx: Ctx, auth: Auth) {
  const user = ctx.db.get(
    `SELECT id, name, email, title, timezone, working_hours, expertise, status, status_text, focus_until,
            quiet_start, quiet_end, color, mfa_enabled, email_digest, email_urgent FROM users WHERE id = ?`,
    auth.userId,
  )!;
  const workspace = ctx.db.get('SELECT * FROM workspaces WHERE id = ?', auth.workspaceId)!;
  const membership = ctx.db.get(
    'SELECT role, guest_expires_at, sponsor_id FROM memberships WHERE workspace_id = ? AND user_id = ?',
    auth.workspaceId,
    auth.userId,
  )!;
  const workspaces = ctx.db.all(
    `SELECT w.id, w.name, m.role FROM workspaces w JOIN memberships m ON m.workspace_id = w.id
      WHERE m.user_id = ? AND m.deactivated_at IS NULL ORDER BY w.name`,
    auth.userId,
  );
  const memberCount = ctx.db.get(
    'SELECT COUNT(*) AS n FROM memberships WHERE workspace_id = ? AND deactivated_at IS NULL',
    auth.workspaceId,
  )!.n;
  return {
    user: {
      ...user,
      expertise: parseJson<string[]>(user.expertise, []),
      mfa_enabled: !!user.mfa_enabled,
      email_digest: !!user.email_digest,
      email_urgent: !!user.email_urgent,
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
      ai_available: !!ctx.ai,
    },
    role: membership.role,
    guest_expires_at: membership.guest_expires_at,
    mfa_setup_required: !!workspace.require_mfa && !user.mfa_enabled,
    workspaces,
  };
}

export function authRouter(ctx: Ctx) {
  const r = Router();
  const { db } = ctx;

  r.post('/auth/register', (req, res) => {
    const body = parse(
      z.object({ name: Name, email: Email, password: Password, workspaceName: z.string().trim().min(2).max(80) }),
      req.body,
    );
    rateLimit(`register:${req.ip}`, 20);
    if (db.get('SELECT 1 FROM users WHERE email = ?', body.email)) {
      throw new HttpError(409, 'An account with this email already exists. Sign in instead.');
    }
    const userId = newId();
    const workspaceId = newId();
    db.transaction(() => {
      db.insert('users', {
        id: userId,
        email: body.email,
        name: body.name,
        password_hash: hashPassword(body.password),
        color: pickColor(body.email),
        created_at: now(),
      });
      db.insert('workspaces', { id: workspaceId, name: body.workspaceName, created_at: now() });
      db.insert('memberships', { workspace_id: workspaceId, user_id: userId, role: 'owner', created_at: now() });
      const generalId = newId();
      db.insert('channels', {
        id: generalId,
        workspace_id: workspaceId,
        name: 'general',
        topic: 'Company-wide conversation',
        kind: 'public',
        created_by: userId,
        created_at: now(),
      });
      db.insert('channel_members', { channel_id: generalId, user_id: userId, joined_at: now() });
      const annId = newId();
      db.insert('channels', {
        id: annId,
        workspace_id: workspaceId,
        name: 'announcements',
        topic: 'Important notices. Leads and admins can post.',
        kind: 'announcement',
        created_by: userId,
        created_at: now(),
      });
      db.insert('channel_members', { channel_id: annId, user_id: userId, joined_at: now() });
      audit(ctx, workspaceId, userId, 'workspace.created', 'workspace', workspaceId, { name: body.workspaceName });
    });
    startSession(ctx, res, userId, workspaceId);
    res.status(201).json(mePayload(ctx, { userId, workspaceId, role: 'owner' }));
  });

  r.post('/auth/login', (req, res) => {
    const body = parse(
      z.object({ email: Email, password: z.string().min(1).max(200), code: z.string().optional(), workspaceId: z.string().optional() }),
      req.body,
    );
    rateLimit(`login:${req.ip}:${body.email}`);
    const user = db.get('SELECT * FROM users WHERE email = ?', body.email);
    if (!user || !verifyPassword(body.password, user.password_hash)) {
      throw new HttpError(401, 'Email or password is incorrect');
    }
    if (user.mfa_enabled) {
      if (!body.code) throw new HttpError(401, 'Enter the code from your authenticator app', { code: 'mfa_required' });
      if (!verifyTotp(user.mfa_secret, body.code)) throw new HttpError(401, 'That code is not valid', { code: 'mfa_required' });
    }
    const memberships = db.all(
      `SELECT workspace_id, role FROM memberships WHERE user_id = ? AND deactivated_at IS NULL
         AND (guest_expires_at IS NULL OR guest_expires_at > ?) ORDER BY created_at`,
      user.id,
      now(),
    );
    const membership = memberships.find((m) => m.workspace_id === body.workspaceId) ?? memberships[0];
    if (!membership) throw new HttpError(403, 'Your access to SoftEX has ended. Contact your workspace administrator.');
    const ws = db.get('SELECT sso_enabled, sso_required FROM workspaces WHERE id = ?', membership.workspace_id)!;
    if (ws.sso_enabled && ws.sso_required && membership.role !== 'owner') {
      throw new HttpError(403, 'Your workspace requires single sign-on. Use “Sign in with SSO”.', { code: 'sso_required' });
    }
    startSession(ctx, res, user.id, membership.workspace_id);
    audit(ctx, membership.workspace_id, user.id, 'auth.login', 'user', user.id, { ip: req.ip });
    res.json(mePayload(ctx, { userId: user.id, workspaceId: membership.workspace_id, role: membership.role }));
  });

  r.post('/auth/logout', (req, res) => {
    const token = tokenFrom(req);
    if (token) db.run('DELETE FROM sessions WHERE token_hash = ?', sha256(token));
    res.clearCookie(COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  // ----- Password reset by email -----

  r.post('/auth/forgot', (req, res) => {
    const { email } = parse(z.object({ email: Email }), req.body);
    rateLimit(`forgot:${req.ip}`, 10);
    const user = db.get('SELECT id, name, email FROM users WHERE email = ?', email);
    if (user) {
      const token = randomToken();
      db.insert('password_resets', { token_hash: sha256(token), user_id: user.id, expires_at: new Date(Date.now() + 3_600_000).toISOString(), created_at: now() });
      queueEmail(ctx, {
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

  r.post('/auth/reset', (req, res) => {
    const body = parse(z.object({ token: z.string().min(10), password: Password }), req.body);
    rateLimit(`reset:${req.ip}`, 20);
    const reset = db.get('SELECT * FROM password_resets WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?', sha256(body.token), now());
    if (!reset) throw new HttpError(400, 'This reset link has expired or was already used. Request a new one.');
    db.transaction(() => {
      db.run('UPDATE password_resets SET used_at = ? WHERE token_hash = ?', now(), reset.token_hash);
      db.update('users', reset.user_id, { password_hash: hashPassword(body.password) });
      db.run('DELETE FROM sessions WHERE user_id = ?', reset.user_id);
      for (const m of db.all('SELECT workspace_id FROM memberships WHERE user_id = ?', reset.user_id)) {
        audit(ctx, m.workspace_id, reset.user_id, 'user.password_reset', 'user', reset.user_id);
      }
    });
    res.json({ ok: true });
  });

  // ----- Invitations (public: token is the credential) -----

  const loadInvitation = (token: string) => {
    const invite = db.get(
      `SELECT i.*, w.name AS workspace_name, u.name AS inviter_name FROM invitations i
         JOIN workspaces w ON w.id = i.workspace_id JOIN users u ON u.id = i.invited_by
        WHERE i.token_hash = ? AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > ?`,
      sha256(token),
      now(),
    );
    if (!invite) throw new HttpError(404, 'This invitation is no longer valid');
    return invite;
  };

  r.get('/invitations/:token', (req, res) => {
    const invite = loadInvitation(req.params.token);
    const existing = !!db.get('SELECT 1 FROM users WHERE email = ?', invite.email);
    res.json({
      email: invite.email,
      role: invite.role,
      workspace_name: invite.workspace_name,
      inviter_name: invite.inviter_name,
      existing_account: existing,
    });
  });

  r.post('/invitations/:token/accept', (req, res) => {
    const invite = loadInvitation(req.params.token);
    const body = parse(z.object({ name: Name.optional(), password: z.string().min(1).max(200) }), req.body);
    let user = db.get('SELECT * FROM users WHERE email = ?', invite.email);
    if (user) {
      if (!verifyPassword(body.password, user.password_hash)) throw new HttpError(401, 'Password is incorrect');
    } else {
      if (!body.name) throw badRequest('name: Required');
      parse(Password, body.password);
      const id = newId();
      db.insert('users', {
        id,
        email: invite.email,
        name: body.name,
        password_hash: hashPassword(body.password),
        color: pickColor(invite.email),
        created_at: now(),
      });
      user = db.get('SELECT * FROM users WHERE id = ?', id)!;
    }
    const userId = user.id as string;
    db.transaction(() => {
      const guestExpires =
        invite.role === 'guest' ? new Date(Date.now() + (invite.guest_days ?? 30) * 86_400_000).toISOString() : null;
      const existing = db.get('SELECT * FROM memberships WHERE workspace_id = ? AND user_id = ?', invite.workspace_id, userId);
      if (existing) {
        db.run(
          `UPDATE memberships SET role = ?, deactivated_at = NULL, guest_expires_at = ?, sponsor_id = ?
            WHERE workspace_id = ? AND user_id = ?`,
          invite.role,
          guestExpires,
          invite.role === 'guest' ? invite.invited_by : null,
          invite.workspace_id,
          userId,
        );
      } else {
        db.insert('memberships', {
          workspace_id: invite.workspace_id,
          user_id: userId,
          role: invite.role,
          sponsor_id: invite.role === 'guest' ? invite.invited_by : null,
          guest_expires_at: guestExpires,
          created_at: now(),
        });
      }
      if (invite.role !== 'guest') {
        const defaults = db.all(
          `SELECT id FROM channels WHERE workspace_id = ? AND kind IN ('public','announcement') AND name IN ('general','announcements')`,
          invite.workspace_id,
        );
        for (const c of defaults) {
          db.run('INSERT OR IGNORE INTO channel_members (channel_id, user_id, joined_at) VALUES (?, ?, ?)', c.id, userId, now());
        }
      }
      for (const channelId of parseJson<string[]>(invite.channel_ids, [])) {
        if (db.get('SELECT 1 FROM channels WHERE id = ? AND workspace_id = ?', channelId, invite.workspace_id)) {
          db.run('INSERT OR IGNORE INTO channel_members (channel_id, user_id, joined_at) VALUES (?, ?, ?)', channelId, userId, now());
        }
      }
      for (const projectId of parseJson<string[]>(invite.project_ids, [])) {
        if (db.get('SELECT 1 FROM projects WHERE id = ? AND workspace_id = ?', projectId, invite.workspace_id)) {
          db.run('INSERT OR IGNORE INTO project_members (project_id, user_id) VALUES (?, ?)', projectId, userId);
        }
      }
      db.run('UPDATE invitations SET accepted_at = ? WHERE id = ?', now(), invite.id);
      audit(ctx, invite.workspace_id, userId, 'invitation.accepted', 'invitation', invite.id, { role: invite.role });
    });
    startSession(ctx, res, userId, invite.workspace_id);
    res.json(mePayload(ctx, { userId, workspaceId: invite.workspace_id, role: invite.role }));
  });

  return r;
}

/** Routes for the signed-in user's own account. Mounted behind requireAuth. */
export function meRouter(ctx: Ctx) {
  const r = Router();
  const { db } = ctx;

  r.get('/me', (req, res) => res.json(mePayload(ctx, authOf(req))));

  r.patch('/me', (req, res) => {
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
    db.update('users', auth.userId, body);
    const payload = mePayload(ctx, auth);
    ctx.hub.publish(auth.workspaceId, {
      type: 'user.updated',
      user: { id: auth.userId, name: payload.user.name, status: payload.user.status, status_text: payload.user.status_text, color: payload.user.color },
    });
    res.json(payload);
  });

  r.post('/me/password', (req, res) => {
    const auth = authOf(req);
    const body = parse(z.object({ current: z.string(), next: Password }), req.body);
    const user = db.get('SELECT password_hash FROM users WHERE id = ?', auth.userId)!;
    if (!verifyPassword(body.current, user.password_hash)) throw new HttpError(401, 'Current password is incorrect');
    db.update('users', auth.userId, { password_hash: hashPassword(body.next) });
    const keep = sha256(tokenFrom(req) ?? '');
    db.run('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?', auth.userId, keep);
    audit(ctx, auth.workspaceId, auth.userId, 'user.password_changed', 'user', auth.userId);
    res.json({ ok: true });
  });

  r.post('/me/mfa/setup', (req, res) => {
    const auth = authOf(req);
    const user = db.get('SELECT email, mfa_enabled FROM users WHERE id = ?', auth.userId)!;
    if (user.mfa_enabled) throw badRequest('Multifactor authentication is already enabled');
    const secret = generateSecret();
    db.update('users', auth.userId, { mfa_secret: secret });
    res.json({ secret, otpauth_url: otpauthUrl(secret, user.email) });
  });

  r.post('/me/mfa/enable', (req, res) => {
    const auth = authOf(req);
    const { code } = parse(z.object({ code: z.string() }), req.body);
    const user = db.get('SELECT mfa_secret FROM users WHERE id = ?', auth.userId)!;
    if (!user.mfa_secret || !verifyTotp(user.mfa_secret, code)) throw badRequest('That code is not valid. Try the next one.');
    db.update('users', auth.userId, { mfa_enabled: 1 });
    audit(ctx, auth.workspaceId, auth.userId, 'user.mfa_enabled', 'user', auth.userId);
    res.json(mePayload(ctx, auth));
  });

  r.post('/me/mfa/disable', (req, res) => {
    const auth = authOf(req);
    const { password } = parse(z.object({ password: z.string() }), req.body);
    const user = db.get('SELECT password_hash FROM users WHERE id = ?', auth.userId)!;
    if (!verifyPassword(password, user.password_hash)) throw new HttpError(401, 'Password is incorrect');
    const ws = db.get('SELECT require_mfa FROM workspaces WHERE id = ?', auth.workspaceId)!;
    if (ws.require_mfa) throw badRequest('Your workspace requires multifactor authentication');
    db.update('users', auth.userId, { mfa_enabled: 0, mfa_secret: null });
    audit(ctx, auth.workspaceId, auth.userId, 'user.mfa_disabled', 'user', auth.userId);
    res.json(mePayload(ctx, auth));
  });

  r.post('/me/switch-workspace', (req, res) => {
    const auth = authOf(req);
    const { workspaceId } = parse(z.object({ workspaceId: z.string() }), req.body);
    const m = db.get(
      `SELECT role FROM memberships WHERE workspace_id = ? AND user_id = ? AND deactivated_at IS NULL
         AND (guest_expires_at IS NULL OR guest_expires_at > ?)`,
      workspaceId,
      auth.userId,
      now(),
    );
    if (!m) throw new HttpError(404, 'Workspace not found');
    const token = tokenFrom(req);
    if (token) db.run('DELETE FROM sessions WHERE token_hash = ?', sha256(token));
    startSession(ctx, res, auth.userId, workspaceId);
    res.json(mePayload(ctx, { userId: auth.userId, workspaceId, role: m.role }));
  });

  return r;
}
