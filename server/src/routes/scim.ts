import { Router, type NextFunction, type Request, type Response } from 'express';
import { requireRole } from '../access.js';
import { hasFeature, requireFeature, requireMemberCapacity } from '../plans.js';
import { audit, authOf, type Ctx } from '../context.js';
import type { Row } from '../db.js';
import { hashPassword, newId, now, pickColor, randomToken, sha256 } from '../util.js';

/**
 * SCIM 2.0 user provisioning (RFC 7643/7644), §5.7 "automated provisioning".
 * Identity providers (Okta, Microsoft Entra ID, OneLogin, JumpCloud…) create,
 * update and deactivate Küü members automatically. Authenticated with a
 * per-workspace bearer token that admins generate; only its hash is stored.
 */

const USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
const LIST_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
const ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error';
const PATCH_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';

class ScimError extends Error {
  constructor(public status: number, message: string, public scimType?: string) {
    super(message);
  }
}

interface ScimRequest extends Request {
  scimWorkspace?: string;
}

export function scimAdminRouter(ctx: Ctx) {
  const r = Router();
  r.get('/admin/scim', async (req, res) => {
    const auth = authOf(req);
    requireRole(auth, 'admin');
    const ws = (await ctx.db.get('SELECT scim_token_hash FROM workspaces WHERE id = ?', auth.workspaceId))!;
    res.json({ enabled: !!ws.scim_token_hash, base_url: `${ctx.config.publicUrl}/scim/v2` });
  });
  r.post('/admin/scim/token', async (req, res) => {
    const auth = authOf(req);
    requireRole(auth, 'admin');
    await requireFeature(ctx, auth.workspaceId, 'scim');
    const token = `scim_${randomToken()}`;
    await ctx.db.update('workspaces', auth.workspaceId, { scim_token_hash: sha256(token) });
    await audit(ctx, auth.workspaceId, auth.userId, 'scim.token_generated', 'workspace', auth.workspaceId);
    res.status(201).json({ token, base_url: `${ctx.config.publicUrl}/scim/v2` });
  });
  r.delete('/admin/scim/token', async (req, res) => {
    const auth = authOf(req);
    requireRole(auth, 'admin');
    await ctx.db.update('workspaces', auth.workspaceId, { scim_token_hash: null });
    await audit(ctx, auth.workspaceId, auth.userId, 'scim.disabled', 'workspace', auth.workspaceId);
    res.json({ ok: true });
  });
  return r;
}

export function scimRouter(ctx: Ctx) {
  const r = Router();
  const { db } = ctx;

  r.use(async (req: ScimRequest, _res, next) => {
    const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    const ws = token ? await db.get('SELECT id, suspended_at FROM workspaces WHERE scim_token_hash = ?', sha256(token)) : undefined;
    if (!ws) return next(new ScimError(401, 'Invalid or missing SCIM token'));
    if (ws.suspended_at) return next(new ScimError(403, 'This workspace has been suspended'));
    if (!await hasFeature(ctx, ws.id, 'scim')) return next(new ScimError(403, 'User provisioning is available on the Business plan'));
    req.scimWorkspace = ws.id;
    next();
  });

  const toScim = (workspaceId: string, u: Row) => {
    const [givenName, ...rest] = u.name.split(' ');
    return {
      schemas: [USER_SCHEMA],
      id: u.id,
      externalId: u.scim_external_id ?? undefined,
      userName: u.email,
      name: { formatted: u.name, givenName, familyName: rest.join(' ') || undefined },
      displayName: u.name,
      title: u.title || undefined,
      emails: [{ value: u.email, primary: true, type: 'work' }],
      active: !u.deactivated_at,
      meta: { resourceType: 'User', created: u.joined_at, location: `${ctx.config.publicUrl}/scim/v2/Users/${u.id}` },
    };
  };

  const loadMember = async (workspaceId: string, id: string) => {
    const u = await db.get(
      `SELECT u.*, m.deactivated_at, m.scim_external_id, m.created_at AS joined_at, m.role FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.workspace_id = ? AND u.id = ?`,
      workspaceId,
      id,
    );
    if (!u) throw new ScimError(404, 'User not found');
    return u;
  };

  const nameFrom = (body: Record<string, any>) =>
    (body.name?.formatted || [body.name?.givenName, body.name?.familyName].filter(Boolean).join(' ') || body.displayName || '').trim();
  const emailFrom = (body: Record<string, any>) =>
    String(body.emails?.find((e: any) => e.primary)?.value ?? body.emails?.[0]?.value ?? body.userName ?? '')
      .trim()
      .toLowerCase();

  const setActive = async (workspaceId: string, userId: string, active: boolean, role: string) => {
    if (!active && role === 'owner') throw new ScimError(400, 'Workspace owners cannot be deactivated by provisioning', 'mutability');
    if (active) await requireMemberCapacity(ctx, workspaceId, 1);
    await db.run('UPDATE memberships SET deactivated_at = ? WHERE workspace_id = ? AND user_id = ?', active ? null : now(), workspaceId, userId);
    if (!active) {
      await db.run('DELETE FROM sessions WHERE user_id = ? AND workspace_id = ?', userId, workspaceId);
      await db.run('UPDATE api_tokens SET revoked_at = ? WHERE user_id = ? AND workspace_id = ? AND revoked_at IS NULL', now(), userId, workspaceId);
      ctx.hub.disconnect(workspaceId, userId);
    }
    await audit(ctx, workspaceId, null, active ? 'scim.user_reactivated' : 'scim.user_deactivated', 'user', userId);
  };

  r.get('/ServiceProviderConfig', (_req, res) => {
    res.json({
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
      patch: { supported: true },
      bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
      filter: { supported: true, maxResults: 200 },
      changePassword: { supported: false },
      sort: { supported: false },
      etag: { supported: false },
      authenticationSchemes: [{ type: 'oauthbearertoken', name: 'Bearer token', description: 'Token generated in Küü Administration → Single sign-on', primary: true }],
    });
  });

  r.get('/ResourceTypes', (_req, res) => {
    res.json({
      schemas: [LIST_SCHEMA],
      totalResults: 1,
      Resources: [{ schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'], id: 'User', name: 'User', endpoint: '/Users', schema: USER_SCHEMA }],
    });
  });

  r.get('/Users', async (req: ScimRequest, res) => {
    const ws = req.scimWorkspace!;
    const filter = String(req.query.filter ?? '');
    const startIndex = Math.max(1, Number(req.query.startIndex ?? 1) || 1);
    const count = Math.min(200, Math.max(0, Number(req.query.count ?? 100) || 100));
    const eq = filter.match(/^(userName|externalId|emails(?:\.value)?)\s+eq\s+"([^"]*)"$/i);
    if (filter && !eq) throw new ScimError(400, 'Only "userName eq", "externalId eq" and "emails eq" filters are supported', 'invalidFilter');
    // The filter value is always a bound parameter; `IS NULL OR` makes an absent filter match everyone.
    const byExternalId = eq && /^externalId$/i.test(eq[1]) ? eq[2] : null;
    const byEmail = eq && !byExternalId ? eq[2].toLowerCase() : null;
    const where = `m.workspace_id = ? AND (CAST(? AS TEXT) IS NULL OR m.scim_external_id = ?) AND (CAST(? AS TEXT) IS NULL OR u.email = ?)`;
    const total = (await db.get(`SELECT COUNT(*) AS n FROM memberships m JOIN users u ON u.id = m.user_id WHERE ${where}`, ws, byExternalId, byExternalId, byEmail, byEmail))!.n;
    const rows = await db.all(
      `SELECT u.*, m.deactivated_at, m.scim_external_id, m.created_at AS joined_at FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE ${where} ORDER BY m.created_at LIMIT ? OFFSET ?`,
      ws,
      byExternalId,
      byExternalId,
      byEmail,
      byEmail,
      count,
      startIndex - 1,
    );
    res.json({ schemas: [LIST_SCHEMA], totalResults: total, startIndex, itemsPerPage: rows.length, Resources: rows.map((u) => toScim(ws, u)) });
  });

  r.get('/Users/:id', async (req: ScimRequest, res) => {
    res.json(toScim(req.scimWorkspace!, await loadMember(req.scimWorkspace!, String(req.params.id))));
  });

  r.post('/Users', async (req: ScimRequest, res) => {
    const ws = req.scimWorkspace!;
    const email = emailFrom(req.body ?? {});
    if (!looksLikeEmail(email)) throw new ScimError(400, 'userName must be an email address', 'invalidValue');
    const name = nameFrom(req.body) || email.split('@')[0];
    let user = await db.get('SELECT * FROM users WHERE email = ?', email);
    if (user && await db.get('SELECT 1 FROM memberships WHERE workspace_id = ? AND user_id = ?', ws, user.id)) {
      throw new ScimError(409, 'User already exists', 'uniqueness');
    }
    if (req.body.active !== false) await requireMemberCapacity(ctx, ws, 1);
    await db.transaction(async () => {
      if (!user) {
        const id = newId();
        await db.insert('users', {
          id,
          email,
          name: name.slice(0, 80),
          title: String(req.body.title ?? '').slice(0, 80),
          password_hash: hashPassword(randomToken()),
          color: pickColor(email),
          // Addresses come from the organisation's identity provider.
          email_verified_at: now(),
          created_at: now(),
        });
        user = (await db.get('SELECT * FROM users WHERE id = ?', id))!;
      }
      await db.insert('memberships', {
        workspace_id: ws,
        user_id: user!.id,
        role: 'member',
        scim_external_id: externalIdOf(req.body.externalId),
        deactivated_at: req.body.active === false ? now() : null,
        created_at: now(),
      });
      for (const c of await db.all(`SELECT id FROM channels WHERE workspace_id = ? AND kind IN ('public','announcement') AND name IN ('general','announcements')`, ws)) {
        await db.run('INSERT OR IGNORE INTO channel_members (channel_id, user_id, joined_at) VALUES (?, ?, ?)', c.id, user!.id, now());
      }
    });
    await audit(ctx, ws, null, 'scim.user_created', 'user', user!.id, { email });
    res.status(201).location(`${ctx.config.publicUrl}/scim/v2/Users/${user!.id}`).json(toScim(ws, await loadMember(ws, user!.id)));
  });

  r.put('/Users/:id', async (req: ScimRequest, res) => {
    const ws = req.scimWorkspace!;
    const u = await loadMember(ws, String(req.params.id));
    const name = nameFrom(req.body ?? {});
    if (name) await db.update('users', u.id, { name: name.slice(0, 80) });
    if (typeof req.body.title === 'string') await db.update('users', u.id, { title: req.body.title.slice(0, 80) });
    if (req.body.externalId !== undefined) await db.run('UPDATE memberships SET scim_external_id = ? WHERE workspace_id = ? AND user_id = ?', externalIdOf(req.body.externalId), ws, u.id);
    if (typeof req.body.active === 'boolean' && req.body.active === !!u.deactivated_at) await setActive(ws, u.id, req.body.active, u.role);
    res.json(toScim(ws, await loadMember(ws, u.id)));
  });

  r.patch('/Users/:id', async (req: ScimRequest, res) => {
    const ws = req.scimWorkspace!;
    const u = await loadMember(ws, String(req.params.id));
    if (!Array.isArray(req.body?.schemas) || !req.body.schemas.includes(PATCH_SCHEMA)) throw new ScimError(400, 'Expected a PatchOp request', 'invalidSyntax');
    for (const op of req.body.Operations ?? []) {
      const kind = String(op.op ?? '').toLowerCase();
      if (kind !== 'replace' && kind !== 'add') continue;
      const updates: [string, unknown][] = op.path ? [[String(op.path), op.value]] : op.value && typeof op.value === 'object' ? Object.entries(op.value) : [];
      for (const [path, value] of updates) {
        if (/^active$/i.test(path)) {
          const active = value === true || value === 'True' || value === 'true';
          if (active === !!(await loadMember(ws, u.id)).deactivated_at) await setActive(ws, u.id, active, u.role);
        } else if (/^(displayName|name\.formatted)$/i.test(path) && typeof value === 'string') {
          await db.update('users', u.id, { name: value.slice(0, 80) });
        } else if (/^title$/i.test(path) && typeof value === 'string') {
          await db.update('users', u.id, { title: value.slice(0, 80) });
        } else if (/^externalId$/i.test(path)) {
          await db.run('UPDATE memberships SET scim_external_id = ? WHERE workspace_id = ? AND user_id = ?', externalIdOf(value), ws, u.id);
        }
      }
    }
    res.json(toScim(ws, await loadMember(ws, u.id)));
  });

  r.delete('/Users/:id', async (req: ScimRequest, res) => {
    const ws = req.scimWorkspace!;
    const u = await loadMember(ws, String(req.params.id));
    // Deprovisioning deactivates rather than erases, so content and audit history stay intact.
    if (!u.deactivated_at) await setActive(ws, u.id, false, u.role);
    res.status(204).end();
  });

  r.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    // Plan limits (HTTP 402 elsewhere in the API) are reported as 403, which identity providers understand.
    const status = (err as any)?.status === 402 ? 403 : ((err as any)?.status ?? 500);
    const e = err instanceof ScimError ? err : new ScimError(status, (err as Error)?.message ?? 'Server error');
    if (e.status >= 500) console.error(err);
    res.status(e.status).type('application/scim+json').json({ schemas: [ERROR_SCHEMA], status: String(e.status), scimType: e.scimType, detail: e.message });
  });

  return r;
}

/** Linear-time email shape check: one @, no whitespace, a dot inside the domain. */
function looksLikeEmail(email: string) {
  if (!email || email.length > 254 || /\s/.test(email)) return false;
  const at = email.indexOf('@');
  if (at < 1 || at !== email.lastIndexOf('@')) return false;
  const domain = email.slice(at + 1);
  const dot = domain.lastIndexOf('.');
  return dot > 0 && dot < domain.length - 1;
}

const externalIdOf = (value: unknown) => (typeof value === 'string' || typeof value === 'number' ? String(value).slice(0, 200) : null);
