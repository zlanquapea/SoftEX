import { Router } from 'express';
import { z } from 'zod';
import {
  accessibleChannelIds,
  accessibleProjectIds,
  atLeast,
  canViewDecision,
  canViewFile,
  canViewMeeting,
  canViewPage,
  canViewTask,
  isGuest,
  requireRole,
  type Auth,
  type Role,
} from '../access.js';
import { audit, authOf, notify, platformEvent, type Ctx } from '../context.js';
import { mePayload, startSession } from './auth.js';
import { verifyTotp } from '../totp.js';
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { queueEmail } from '../mailer.js';
import { requireFeature, requireMemberCapacity, requireVerifiedEmail } from '../plans.js';
import { HttpError, badRequest, forbidden, newId, notFound, now, parse, parseJson, randomToken, sha256, verifyPassword, filterAsync } from '../util.js';

const RoleEnum = z.enum(['owner', 'admin', 'lead', 'member', 'guest']);

export function workspaceRouter(ctx: Ctx) {
  const r = Router();
  const { db } = ctx;

  /** People a user may see. Guests only see people they share a channel or project with (§3). */
  const visibleUserIds = async (auth: Auth): Promise<Set<string> | null> => {
    if (!isGuest(auth)) return null;
    const rows = await db.all(
      `SELECT b.user_id FROM channel_members a JOIN channel_members b ON a.channel_id = b.channel_id WHERE a.user_id = ?
       UNION SELECT b.user_id FROM project_members a JOIN project_members b ON a.project_id = b.project_id WHERE a.user_id = ?
       UNION SELECT sponsor_id FROM memberships WHERE workspace_id = ? AND user_id = ?`,
      auth.userId,
      auth.userId,
      auth.workspaceId,
      auth.userId,
    );
    return new Set(rows.map((r) => r.user_id).filter(Boolean).concat(auth.userId));
  };

  // ======================= Directory =======================

  r.get('/people', async (req, res) => {
    const auth = authOf(req);
    const visible = await visibleUserIds(auth);
    const people = (await db
      .all(
        `SELECT u.id, u.name, u.email, u.title, u.timezone, u.working_hours, u.expertise, u.status, u.status_text, u.focus_until, u.color,
                m.role, m.guest_expires_at, m.created_at AS joined_at, s.name AS sponsor_name
           FROM memberships m JOIN users u ON u.id = m.user_id LEFT JOIN users s ON s.id = m.sponsor_id
          WHERE m.workspace_id = ? AND m.deactivated_at IS NULL ORDER BY u.name`,
        auth.workspaceId,
      ))
      .filter((p) => !visible || visible.has(p.id));
    const teams = await db.all(
      `SELECT tm.user_id, t.id, t.name FROM team_members tm JOIN teams t ON t.id = tm.team_id WHERE t.workspace_id = ?`,
      auth.workspaceId,
    );
    res.json(
      people.map((p) => ({
        ...p,
        expertise: parseJson<string[]>(p.expertise, []),
        online: ctx.hub.isOnline(auth.workspaceId, p.id),
        teams: teams.filter((t) => t.user_id === p.id).map(({ id, name }) => ({ id, name })),
      })),
    );
  });

  r.get('/people/:id', async (req, res) => {
    const auth = authOf(req);
    const visible = await visibleUserIds(auth);
    if (visible && !visible.has(req.params.id)) throw notFound('Person');
    const person = await db.get(
      `SELECT u.id, u.name, u.email, u.title, u.timezone, u.working_hours, u.expertise, u.status, u.status_text, u.focus_until, u.color,
              m.role, m.guest_expires_at, m.created_at AS joined_at, s.name AS sponsor_name, u.mfa_enabled
         FROM memberships m JOIN users u ON u.id = m.user_id LEFT JOIN users s ON s.id = m.sponsor_id
        WHERE m.workspace_id = ? AND u.id = ? AND m.deactivated_at IS NULL`,
      auth.workspaceId,
      req.params.id,
    );
    if (!person) throw notFound('Person');
    const projects = new Set(await accessibleProjectIds(db, auth));
    const sharedProjects = (await db
      .all(`SELECT p.id, p.name, p.color FROM project_members pm JOIN projects p ON p.id = pm.project_id WHERE pm.user_id = ? AND p.archived_at IS NULL`, person.id))
      .filter((p) => projects.has(p.id));
    const teams = await db.all(`SELECT t.id, t.name FROM team_members tm JOIN teams t ON t.id = tm.team_id WHERE tm.user_id = ? AND t.workspace_id = ?`, person.id, auth.workspaceId);
    res.json({
      ...person,
      mfa_enabled: atLeast(auth, 'admin') ? !!person.mfa_enabled : undefined,
      expertise: parseJson<string[]>(person.expertise, []),
      online: ctx.hub.isOnline(auth.workspaceId, person.id),
      projects: sharedProjects,
      teams,
    });
  });

  // ======================= Teams =======================

  r.get('/teams', async (req, res) => {
    const auth = authOf(req);
    const teams = await db.all('SELECT * FROM teams WHERE workspace_id = ? ORDER BY name', auth.workspaceId);
    res.json(
      (await Promise.all(teams.map(async (t) => ({
        ...t,
        members: await db.all(`SELECT u.id, u.name, u.color FROM team_members tm JOIN users u ON u.id = tm.user_id WHERE tm.team_id = ? ORDER BY u.name`, t.id),
      })))),
    );
  });

  r.post('/teams', async (req, res) => {
    const auth = authOf(req);
    requireRole(auth, 'lead');
    const body = parse(z.object({ name: z.string().trim().min(2).max(80), description: z.string().max(500).default(''), memberIds: z.array(z.string()).default([]) }), req.body);
    const id = newId();
    await db.insert('teams', { id, workspace_id: auth.workspaceId, name: body.name, description: body.description, created_at: now() });
    for (const u of new Set([auth.userId, ...body.memberIds])) {
      if (await db.get('SELECT 1 FROM memberships WHERE workspace_id = ? AND user_id = ?', auth.workspaceId, u)) {
        await db.run('INSERT OR IGNORE INTO team_members (team_id, user_id) VALUES (?, ?)', id, u);
      }
    }
    await audit(ctx, auth.workspaceId, auth.userId, 'team.created', 'team', id, { name: body.name });
    res.status(201).json(await db.get('SELECT * FROM teams WHERE id = ?', id));
  });

  r.patch('/teams/:id', async (req, res) => {
    const auth = authOf(req);
    requireRole(auth, 'lead');
    const team = await db.get('SELECT * FROM teams WHERE id = ? AND workspace_id = ?', req.params.id, auth.workspaceId);
    if (!team) throw notFound('Team');
    const body = parse(z.object({ name: z.string().trim().min(2).max(80).optional(), description: z.string().max(500).optional(), memberIds: z.array(z.string()).optional() }), req.body);
    await db.update('teams', team.id, { name: body.name, description: body.description });
    if (body.memberIds) {
      await db.transaction(async () => {
        await db.run('DELETE FROM team_members WHERE team_id = ?', team.id);
        for (const u of body.memberIds!) {
          if (await db.get('SELECT 1 FROM memberships WHERE workspace_id = ? AND user_id = ?', auth.workspaceId, u)) {
            await db.run('INSERT OR IGNORE INTO team_members (team_id, user_id) VALUES (?, ?)', team.id, u);
          }
        }
      });
    }
    res.json({ ok: true });
  });

  r.delete('/teams/:id', async (req, res) => {
    const auth = authOf(req);
    requireRole(auth, 'admin');
    const team = await db.get('SELECT * FROM teams WHERE id = ? AND workspace_id = ?', req.params.id, auth.workspaceId);
    if (!team) throw notFound('Team');
    await db.run('DELETE FROM teams WHERE id = ?', team.id);
    await audit(ctx, auth.workspaceId, auth.userId, 'team.deleted', 'team', team.id, { name: team.name });
    res.json({ ok: true });
  });

  // ======================= Onboarding checklist (§5.5) =======================

  r.get('/onboarding', async (req, res) => {
    const auth = authOf(req);
    const items = await db.all(
      `SELECT i.*, p.done_at FROM onboarding_items i LEFT JOIN onboarding_progress p ON p.item_id = i.id AND p.user_id = ?
        WHERE i.workspace_id = ? AND (i.role IS NULL OR i.role = ?) ORDER BY i.position, i.id`,
      auth.userId,
      auth.workspaceId,
      auth.role,
    );
    res.json(items);
  });

  r.get('/onboarding/items', async (req, res) => {
    const auth = authOf(req);
    requireRole(auth, 'admin');
    res.json(await db.all('SELECT * FROM onboarding_items WHERE workspace_id = ? ORDER BY position, id', auth.workspaceId));
  });

  r.post('/onboarding/items', async (req, res) => {
    const auth = authOf(req);
    requireRole(auth, 'admin');
    const body = parse(z.object({ title: z.string().trim().min(1).max(200), description: z.string().max(1000).default(''), link: z.string().max(500).default(''), role: RoleEnum.nullish() }), req.body);
    const id = newId();
    const pos = ((await db.get('SELECT MAX(position) AS p FROM onboarding_items WHERE workspace_id = ?', auth.workspaceId))?.p ?? 0) + 1;
    await db.insert('onboarding_items', { id, workspace_id: auth.workspaceId, title: body.title, description: body.description, link: body.link, role: body.role ?? null, position: pos });
    res.status(201).json(await db.get('SELECT * FROM onboarding_items WHERE id = ?', id));
  });

  r.delete('/onboarding/items/:id', async (req, res) => {
    const auth = authOf(req);
    requireRole(auth, 'admin');
    await db.run('DELETE FROM onboarding_items WHERE id = ? AND workspace_id = ?', req.params.id, auth.workspaceId);
    res.json({ ok: true });
  });

  r.post('/onboarding/:id/toggle', async (req, res) => {
    const auth = authOf(req);
    const item = await db.get('SELECT * FROM onboarding_items WHERE id = ? AND workspace_id = ?', req.params.id, auth.workspaceId);
    if (!item) throw notFound('Checklist item');
    const done = await db.get('SELECT 1 FROM onboarding_progress WHERE item_id = ? AND user_id = ?', item.id, auth.userId);
    if (done) await db.run('DELETE FROM onboarding_progress WHERE item_id = ? AND user_id = ?', item.id, auth.userId);
    else await db.insert('onboarding_progress', { item_id: item.id, user_id: auth.userId, done_at: now() });
    res.json({ done: !done });
  });

  // ======================= Administration (§5.7) =======================

  r.get('/admin/members', async (req, res) => {
    const auth = authOf(req);
    requireRole(auth, 'admin');
    res.json(
      await db.all(
        `SELECT u.id, u.name, u.email, u.title, u.color, u.mfa_enabled, m.role, m.deactivated_at, m.guest_expires_at, m.created_at AS joined_at,
                s.name AS sponsor_name, (SELECT MAX(created_at) FROM sessions WHERE user_id = u.id AND workspace_id = m.workspace_id) AS last_session_at
           FROM memberships m JOIN users u ON u.id = m.user_id LEFT JOIN users s ON s.id = m.sponsor_id
          WHERE m.workspace_id = ? ORDER BY m.deactivated_at IS NOT NULL, u.name`,
        auth.workspaceId,
      ),
    );
  });

  r.patch('/admin/members/:userId', async (req, res) => {
    const auth = authOf(req);
    requireRole(auth, 'admin');
    const target = await db.get('SELECT * FROM memberships WHERE workspace_id = ? AND user_id = ?', auth.workspaceId, req.params.userId);
    if (!target) throw notFound('Member');
    const body = parse(z.object({ role: RoleEnum.optional(), deactivated: z.boolean().optional(), guestExpiresAt: z.string().datetime().optional() }), req.body);
    if (target.role === 'owner' && auth.role !== 'owner') throw forbidden('Only an owner can change another owner');
    if (body.role === 'owner' && auth.role !== 'owner') throw forbidden('Only an owner can appoint another owner');
    const demotingOwner = target.role === 'owner' && ((body.role && body.role !== 'owner') || body.deactivated);
    if (demotingOwner) {
      const owners = (await db.get(`SELECT COUNT(*) AS n FROM memberships WHERE workspace_id = ? AND role = 'owner' AND deactivated_at IS NULL`, auth.workspaceId))!.n;
      if (owners <= 1) throw badRequest('A workspace must keep at least one owner');
    }
    if (req.params.userId === auth.userId && body.deactivated) throw badRequest('You cannot deactivate yourself');
    if (body.deactivated === false && target.deactivated_at) await requireMemberCapacity(ctx, auth.workspaceId, 1, body.role ?? target.role);
    else if (body.role === 'guest' && target.role !== 'guest') await requireMemberCapacity(ctx, auth.workspaceId, 0, 'guest');
    const role = body.role as Role | undefined;
    const changes: Record<string, unknown> = {};
    if (role) changes.role = role;
    if (body.deactivated !== undefined) changes.deactivated_at = body.deactivated ? now() : null;
    if (role && role !== 'guest') {
      changes.guest_expires_at = null;
      changes.sponsor_id = null;
    }
    if (role === 'guest' && target.role !== 'guest') {
      const days = (await db.get('SELECT guest_default_days FROM workspaces WHERE id = ?', auth.workspaceId))!.guest_default_days;
      changes.guest_expires_at = new Date(Date.now() + days * 86_400_000).toISOString();
      changes.sponsor_id = target.sponsor_id ?? auth.userId;
    }
    if (body.guestExpiresAt !== undefined) {
      if ((role ?? target.role) !== 'guest') throw badRequest('Only guests have an access expiry date');
      changes.guest_expires_at = body.guestExpiresAt;
    }
    const entries = Object.entries(changes);
    if (entries.length) {
      await db.run(
        `UPDATE memberships SET ${entries.map(([k]) => `${k} = ?`).join(', ')} WHERE workspace_id = ? AND user_id = ?`,
        ...(entries.map(([, v]) => v) as (string | null)[]),
        auth.workspaceId,
        req.params.userId,
      );
    }
    if (body.deactivated) {
      await db.run('DELETE FROM sessions WHERE user_id = ? AND workspace_id = ?', req.params.userId, auth.workspaceId);
      ctx.hub.disconnect(auth.workspaceId, req.params.userId);
    }
    if (role && role !== target.role) await audit(ctx, auth.workspaceId, auth.userId, 'member.role_changed', 'user', req.params.userId, { from: target.role, to: role });
    if (body.deactivated !== undefined) await audit(ctx, auth.workspaceId, auth.userId, body.deactivated ? 'member.deactivated' : 'member.reactivated', 'user', req.params.userId);
    if (body.guestExpiresAt !== undefined) await audit(ctx, auth.workspaceId, auth.userId, 'guest.expiry_changed', 'user', req.params.userId, { to: body.guestExpiresAt });
    res.json({ ok: true });
  });

  r.get('/admin/invitations', async (req, res) => {
    const auth = authOf(req);
    requireRole(auth, 'lead');
    res.json(
      await db.all(
        `SELECT i.id, i.email, i.role, i.guest_days, i.expires_at, i.accepted_at, i.revoked_at, i.created_at, u.name AS invited_by_name
           FROM invitations i JOIN users u ON u.id = i.invited_by WHERE i.workspace_id = ? ORDER BY i.created_at DESC LIMIT 200`,
        auth.workspaceId,
      ),
    );
  });

  r.post('/admin/invitations', async (req, res) => {
    const auth = authOf(req);
    const body = parse(
      z.object({
        email: z.string().trim().toLowerCase().email(),
        role: RoleEnum.exclude(['owner']).default('member'),
        guestDays: z.number().int().min(1).max(365).optional(),
        channelIds: z.array(z.string()).default([]),
        projectIds: z.array(z.string()).default([]),
      }),
      req.body,
    );
    // Leads may invite members and guests; admins may invite anyone except owners.
    if (body.role === 'admin' || body.role === 'lead') requireRole(auth, 'admin');
    else requireRole(auth, 'lead');
    if (body.role === 'guest' && !body.channelIds.length && !body.projectIds.length) {
      throw badRequest('Guests need at least one channel or project to access');
    }
    const existing = await db.get(
      `SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? AND u.email = ? AND m.deactivated_at IS NULL`,
      auth.workspaceId,
      body.email,
    );
    if (existing) throw badRequest('This person is already a member of the workspace');
    await requireVerifiedEmail(ctx, auth);
    await requireMemberCapacity(ctx, auth.workspaceId, 1, body.role);
    const channels = await accessibleChannelIds(db, auth);
    const projects = await accessibleProjectIds(db, auth);
    if (body.channelIds.some((c) => !channels.includes(c)) || body.projectIds.some((p) => !projects.includes(p))) {
      throw forbidden('You can only share channels and projects you can access');
    }
    const token = randomToken();
    const id = newId();
    const guestDays = body.role === 'guest' ? body.guestDays ?? (await db.get('SELECT guest_default_days FROM workspaces WHERE id = ?', auth.workspaceId))!.guest_default_days : null;
    await db.insert('invitations', {
      id,
      workspace_id: auth.workspaceId,
      email: body.email,
      role: body.role,
      token_hash: sha256(token),
      invited_by: auth.userId,
      guest_days: guestDays,
      channel_ids: body.channelIds,
      project_ids: body.projectIds,
      expires_at: new Date(Date.now() + 14 * 86_400_000).toISOString(),
      created_at: now(),
    });
    await audit(ctx, auth.workspaceId, auth.userId, 'invitation.created', 'invitation', id, { email: body.email, role: body.role, guestDays });
    await sendInvitationEmail(auth, body.email, body.role, token, guestDays);
    // The link is also returned once so it can be shared directly (e.g. when email is not configured).
    res.status(201).json({ id, token, url: `/invite/${token}`, emailed: true });
  });

  const sendInvitationEmail = async (auth: Auth, email: string, role: string, token: string, guestDays: number | null) => {
    const inviter = (await db.get('SELECT name FROM users WHERE id = ?', auth.userId))!.name;
    const workspace = (await db.get('SELECT name FROM workspaces WHERE id = ?', auth.workspaceId))!.name;
    await queueEmail(ctx, {
      workspaceId: auth.workspaceId,
      kind: 'invitation',
      to: email,
      subject: `${inviter} invited you to ${workspace} on SoftEX`,
      text:
        `${inviter} invited you to join ${workspace} on SoftEX${role === 'guest' ? ' as a guest' : ''}.\n\n` +
        `SoftEX keeps your team’s conversations, projects, knowledge and meetings in one place.` +
        (guestDays ? `\n\nYour guest access lasts ${guestDays} days and covers only what was shared with you.` : '') +
        `\n\nThis invitation expires in 14 days.`,
      action: { label: 'Accept invitation', url: `${ctx.config.publicUrl}/invite/${token}` },
    });
  };

  r.post('/admin/invitations/:id/resend', async (req, res) => {
    const auth = authOf(req);
    requireRole(auth, 'lead');
    const invite = await db.get('SELECT * FROM invitations WHERE id = ? AND workspace_id = ? AND accepted_at IS NULL AND revoked_at IS NULL', req.params.id, auth.workspaceId);
    if (!invite) throw notFound('Invitation');
    // Only token hashes are stored, so resending issues a fresh link and invalidates the old one.
    const token = randomToken();
    await db.update('invitations', invite.id, { token_hash: sha256(token), expires_at: new Date(Date.now() + 14 * 86_400_000).toISOString() });
    await sendInvitationEmail(auth, invite.email, invite.role, token, invite.guest_days);
    await audit(ctx, auth.workspaceId, auth.userId, 'invitation.resent', 'invitation', invite.id, { email: invite.email });
    res.json({ id: invite.id, token, url: `/invite/${token}`, emailed: true });
  });

  r.delete('/admin/invitations/:id', async (req, res) => {
    const auth = authOf(req);
    requireRole(auth, 'lead');
    const invite = await db.get('SELECT * FROM invitations WHERE id = ? AND workspace_id = ?', req.params.id, auth.workspaceId);
    if (!invite) throw notFound('Invitation');
    await db.update('invitations', invite.id, { revoked_at: now() });
    await audit(ctx, auth.workspaceId, auth.userId, 'invitation.revoked', 'invitation', invite.id, { email: invite.email });
    res.json({ ok: true });
  });

  r.patch('/admin/workspace', async (req, res) => {
    const auth = authOf(req);
    requireRole(auth, 'admin');
    const body = parse(
      z.object({
        name: z.string().trim().min(2).max(80).optional(),
        messageEditPolicy: z.enum(['author', 'admins', 'none']).optional(),
        guestDefaultDays: z.number().int().min(1).max(365).optional(),
        requireMfa: z.boolean().optional(),
        aiEnabled: z.boolean().optional(),
        retentionDays: z.number().int().min(30).max(3650).nullable().optional(),
        legalHold: z.boolean().optional(),
      }),
      req.body,
    );
    if (body.aiEnabled) await requireFeature(ctx, auth.workspaceId, 'ai');
    if (body.retentionDays != null || body.legalHold === true) await requireFeature(ctx, auth.workspaceId, 'retention');
    if (body.requireMfa) {
      const me = (await db.get('SELECT mfa_enabled FROM users WHERE id = ?', auth.userId))!;
      if (!me.mfa_enabled) throw badRequest('Enable multifactor authentication on your own account before requiring it');
    }
    await db.update('workspaces', auth.workspaceId, {
      name: body.name,
      message_edit_policy: body.messageEditPolicy,
      guest_default_days: body.guestDefaultDays,
      require_mfa: body.requireMfa,
      ai_enabled: body.aiEnabled,
      retention_days: body.retentionDays,
      legal_hold: body.legalHold,
    });
    await audit(ctx, auth.workspaceId, auth.userId, 'workspace.settings_changed', 'workspace', auth.workspaceId, body);
    res.json({ ok: true });
  });

  // Permanently delete the workspace and everything in it. Owners only, with password (and MFA code) re-entry.
  r.delete('/admin/workspace', async (req, res) => {
    const auth = authOf(req);
    if (auth.tokenScope) throw forbidden('API tokens cannot delete workspaces');
    requireRole(auth, 'owner');
    const body = parse(z.object({ password: z.string().min(1).max(200), confirmName: z.string().max(200), code: z.string().max(10).optional() }), req.body);
    const ws = (await db.get('SELECT * FROM workspaces WHERE id = ?', auth.workspaceId))!;
    const user = (await db.get('SELECT email, password_hash, mfa_enabled, mfa_secret FROM users WHERE id = ?', auth.userId))!;
    if (!verifyPassword(body.password, user.password_hash)) throw new HttpError(401, 'Password is incorrect');
    if (user.mfa_enabled && (!body.code || !verifyTotp(user.mfa_secret, body.code))) throw new HttpError(401, 'Enter a valid code from your authenticator app', { code: 'mfa_required' });
    if (body.confirmName.trim() !== ws.name) throw badRequest('Type the workspace name exactly to confirm');
    const members = (await db.all('SELECT user_id FROM memberships WHERE workspace_id = ?', ws.id)).map((m) => m.user_id as string);
    const keys = (await db.all(`SELECT v.storage_key FROM file_versions v JOIN files f ON f.id = v.file_id WHERE f.workspace_id = ?`, ws.id)).map((v) => v.storage_key as string);
    await db.transaction(async () => {
      await platformEvent(ctx, user.email, 'workspace.deleted', { id: ws.id, name: ws.name }, { members: members.length, files: keys.length });
      await db.run('DELETE FROM workspaces WHERE id = ?', ws.id);
    });
    for (const key of keys) {
      try {
        unlinkSync(join(ctx.config.uploadDir, key));
      } catch {
        /* already gone */
      }
    }
    for (const userId of members) ctx.hub.disconnect(ws.id, userId);
    // Continue in another workspace if the owner has one; otherwise sign out.
    const next = await db.get(
      `SELECT m.workspace_id, m.role FROM memberships m JOIN workspaces w ON w.id = m.workspace_id
        WHERE m.user_id = ? AND m.deactivated_at IS NULL AND w.suspended_at IS NULL ORDER BY m.created_at LIMIT 1`,
      auth.userId,
    );
    if (next) {
      await startSession(ctx, res, auth.userId, next.workspace_id);
      return res.json({ deleted: true, me: await mePayload(ctx, { userId: auth.userId, workspaceId: next.workspace_id, role: next.role }) });
    }
    res.clearCookie('softex_session', { path: '/' });
    res.json({ deleted: true, me: null });
  });

  r.get('/admin/audit', async (req, res) => {
    const auth = authOf(req);
    requireRole(auth, 'admin');
    const q = parse(z.object({ action: z.string().max(60).optional(), before: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }), req.query);
    const where = ['a.workspace_id = ?'];
    const params: (string | number)[] = [auth.workspaceId];
    if (q.action) {
      where.push('a.action LIKE ?');
      params.push(`${q.action}%`);
    }
    if (q.before) {
      where.push('a.created_at < ?');
      params.push(q.before);
    }
    params.push(q.limit);
    res.json(
      (await db
        .all(
          `SELECT a.*, u.name AS actor_name FROM audit_events a LEFT JOIN users u ON u.id = a.actor_id
            WHERE ${where.join(' AND ')} ORDER BY a.created_at DESC LIMIT ?`,
          ...params,
        ))
        .map((e) => ({ ...e, detail: parseJson(e.detail, {}) })),
    );
  });

  /**
   * Data portability (§10): export the records the requesting user is allowed to
   * see, in a documented JSON format. Admin exports still respect privacy of
   * private channels and projects they are not a member of.
   */
  r.get('/export', async (req, res) => {
    const auth = authOf(req);
    const channels = await accessibleChannelIds(db, auth);
    const projects = await accessibleProjectIds(db, auth);
    const inList = (ids: string[]) => (ids.length ? ids.map(() => '?').join(',') : "''");
    const data = {
      format: 'softex-export/v1',
      exported_at: now(),
      exported_by: auth.userId,
      workspace: await db.get('SELECT id, name, created_at FROM workspaces WHERE id = ?', auth.workspaceId),
      channels: await db.all(`SELECT id, name, topic, kind, project_id, created_at FROM channels WHERE id IN (${inList(channels)})`, ...channels),
      messages: await db.all(
        `SELECT id, channel_id, user_id, parent_id, body, created_at, edited_at FROM messages WHERE deleted_at IS NULL AND channel_id IN (${inList(channels)}) ORDER BY created_at`,
        ...channels,
      ),
      projects: await db.all(`SELECT * FROM projects WHERE id IN (${inList(projects)})`, ...projects),
      tasks: (await filterAsync((await db.all('SELECT * FROM tasks WHERE workspace_id = ?', auth.workspaceId)), (t) => canViewTask(db, auth, t))),
      pages: (await filterAsync((await db.all('SELECT * FROM pages WHERE workspace_id = ?', auth.workspaceId)), (p) => canViewPage(db, auth, p))),
      files: (await filterAsync((await db
        .all('SELECT id, name, label, project_id, channel_id, task_id, owner_id, external_url, current_version, created_at FROM files WHERE workspace_id = ?', auth.workspaceId)), (f) => canViewFile(db, auth, f))),
      meetings: (await filterAsync((await db.all('SELECT * FROM meetings WHERE workspace_id = ?', auth.workspaceId)), (m) => canViewMeeting(db, auth, m))),
      decisions: (await filterAsync((await db.all('SELECT * FROM decisions WHERE workspace_id = ?', auth.workspaceId)), (d) => canViewDecision(db, auth, d))),
    };
    await audit(ctx, auth.workspaceId, auth.userId, 'data.exported', 'workspace', auth.workspaceId, {
      messages: data.messages.length,
      tasks: data.tasks.length,
    });
    res.setHeader('Content-Disposition', `attachment; filename="softex-export-${now().slice(0, 10)}.json"`);
    res.json(data);
  });

  // ======================= Requests & approvals (§5.5) =======================

  r.get('/requests', async (req, res) => {
    const auth = authOf(req);
    const rows = await db.all(
      `SELECT r.*, a.name AS requester_name, a.color AS requester_color, b.name AS approver_name FROM requests r
         JOIN users a ON a.id = r.requester_id JOIN users b ON b.id = r.approver_id
        WHERE r.workspace_id = ? AND (r.requester_id = ? OR r.approver_id = ?) ORDER BY r.status = 'pending' DESC, r.created_at DESC`,
      auth.workspaceId,
      auth.userId,
      auth.userId,
    );
    res.json(rows);
  });

  r.post('/requests', async (req, res) => {
    const auth = authOf(req);
    const body = parse(
      z.object({
        kind: z.enum(['access', 'purchase', 'leave', 'support', 'other']),
        title: z.string().trim().min(1).max(200),
        details: z.string().max(5000).default(''),
        approverId: z.string(),
      }),
      req.body,
    );
    if (body.approverId === auth.userId) throw badRequest('Choose someone else to approve your request');
    const approver = await db.get('SELECT role FROM memberships WHERE workspace_id = ? AND user_id = ? AND deactivated_at IS NULL', auth.workspaceId, body.approverId);
    if (!approver || approver.role === 'guest') throw badRequest('Choose an active workspace member as approver');
    const id = newId();
    await db.insert('requests', { id, workspace_id: auth.workspaceId, kind: body.kind, title: body.title, details: body.details, requester_id: auth.userId, approver_id: body.approverId, created_at: now() });
    const requester = (await db.get('SELECT name FROM users WHERE id = ?', auth.userId))!;
    await notify(ctx, auth.workspaceId, { userId: body.approverId, kind: 'request', title: `${requester.name} requested approval: ${body.title}`, body: body.details, link: '/requests', actorId: auth.userId });
    res.status(201).json(await db.get('SELECT * FROM requests WHERE id = ?', id));
  });

  r.post('/requests/:id/decide', async (req, res) => {
    const auth = authOf(req);
    const request = await db.get('SELECT * FROM requests WHERE id = ? AND workspace_id = ?', req.params.id, auth.workspaceId);
    if (!request) throw notFound('Request');
    const body = parse(z.object({ status: z.enum(['approved', 'rejected', 'cancelled']), note: z.string().max(1000).default('') }), req.body);
    if (body.status === 'cancelled' ? request.requester_id !== auth.userId : request.approver_id !== auth.userId) {
      throw forbidden(body.status === 'cancelled' ? 'Only the requester can cancel' : 'Only the approver can decide');
    }
    if (request.status !== 'pending') throw new HttpError(409, 'This request has already been resolved');
    await db.update('requests', request.id, { status: body.status, resolution_note: body.note, decided_at: now() });
    await audit(ctx, auth.workspaceId, auth.userId, `request.${body.status}`, 'request', request.id, { kind: request.kind, title: request.title });
    if (body.status !== 'cancelled') {
      await notify(ctx, auth.workspaceId, { userId: request.requester_id, kind: 'request', title: `Your request “${request.title}” was ${body.status}`, body: body.note, link: '/requests', actorId: auth.userId });
    }
    res.json(await db.get('SELECT * FROM requests WHERE id = ?', request.id));
  });

  return r;
}
