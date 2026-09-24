import { Router } from 'express';
import { z } from 'zod';
import {
  accessibleProjectIds,
  canContributeProject,
  canManageProject,
  canViewDecision,
  canViewMeeting,
  canViewChannel,
  isAdmin,
  isActiveMember,
  isGuest,
  isProjectMember,
  loadChannel,
  loadProject,
  type Auth,
} from '../access.js';
import type { Database, Row } from '../db.js';
import { audit, authOf, notify, recordActivity, userSummary, type Ctx } from '../context.js';
import { emitEvent } from '../webhooks.js';
import { badRequest, forbidden, newId, notFound, now, parse, today } from '../util.js';

const DateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD');
const Color = z.enum(['purple', 'blue', 'green', 'coral', 'gold', 'sky', 'mint', 'lilac', 'orange']);

const TEMPLATES: Record<string, { milestones: string[]; tasks: { title: string; milestone: number }[] }> = {
  product_launch: {
    milestones: ['Discovery', 'Build', 'Launch'],
    tasks: [
      { title: 'Define launch goals and success measures', milestone: 0 },
      { title: 'Interview five representative customers', milestone: 0 },
      { title: 'Agree scope and owners', milestone: 1 },
      { title: 'Prepare launch messaging', milestone: 2 },
      { title: 'Run launch readiness review', milestone: 2 },
    ],
  },
  client_onboarding: {
    milestones: ['Kickoff', 'Setup', 'Handover'],
    tasks: [
      { title: 'Schedule kickoff meeting', milestone: 0 },
      { title: 'Collect client requirements', milestone: 0 },
      { title: 'Configure access for client guests', milestone: 1 },
      { title: 'Deliver training session', milestone: 2 },
    ],
  },
  weekly_ops: {
    milestones: [],
    tasks: [
      { title: 'Review weekly metrics', milestone: -1 },
      { title: 'Share weekly status update', milestone: -1 },
    ],
  },
};

export function projectStats(db: Database, projectId: string) {
  const counts = db.get(
    `SELECT COUNT(*) AS total,
            SUM(status = 'done') AS done,
            SUM(status = 'blocked') AS blocked,
            SUM(status != 'done' AND due_date IS NOT NULL AND due_date < ?) AS overdue
       FROM tasks WHERE project_id = ? AND parent_id IS NULL`,
    today(),
    projectId,
  )!;
  const total = counts.total ?? 0;
  const done = counts.done ?? 0;
  return {
    total,
    done,
    blocked: counts.blocked ?? 0,
    overdue: counts.overdue ?? 0,
    progress: total ? Math.round((done / total) * 100) : 0,
  };
}

function projectSummary(db: Database, auth: Auth, p: Row) {
  const members = db.all(
    `SELECT u.id, u.name, u.color FROM project_members m JOIN users u ON u.id = m.user_id WHERE m.project_id = ? ORDER BY u.name`,
    p.id,
  );
  const nextMilestone = db.get(
    'SELECT id, name, due_date FROM milestones WHERE project_id = ? AND done_at IS NULL ORDER BY due_date IS NULL, due_date LIMIT 1',
    p.id,
  );
  const team = p.team_id ? db.get('SELECT id, name FROM teams WHERE id = ?', p.team_id) : null;
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    color: p.color,
    visibility: p.visibility,
    health: p.health,
    due_date: p.due_date,
    archived_at: p.archived_at,
    created_at: p.created_at,
    updated_at: p.updated_at,
    owner: userSummary(db, p.owner_id),
    team,
    members,
    member_count: members.length,
    is_member: members.some((m) => m.id === auth.userId),
    next_milestone: nextMilestone ?? null,
    stats: projectStats(db, p.id),
  };
}

export function projectsRouter(ctx: Ctx) {
  const r = Router();
  const { db } = ctx;

  const addMember = (projectId: string, userId: string) =>
    db.run('INSERT OR IGNORE INTO project_members (project_id, user_id) VALUES (?, ?)', projectId, userId);

  r.get('/projects', (req, res) => {
    const auth = authOf(req);
    const q = parse(z.object({ archived: z.enum(['true', 'false']).default('false') }), req.query);
    const ids = accessibleProjectIds(db, auth);
    if (!ids.length) return res.json([]);
    const rows = db.all(
      `SELECT * FROM projects WHERE id IN (${ids.map(() => '?').join(',')}) AND archived_at IS ${q.archived === 'true' ? 'NOT NULL' : 'NULL'}
        ORDER BY updated_at DESC`,
      ...ids,
    );
    res.json(rows.map((p) => projectSummary(db, auth, p)));
  });

  r.post('/projects', (req, res) => {
    const auth = authOf(req);
    if (isGuest(auth)) throw forbidden('Guests cannot create projects');
    const body = parse(
      z.object({
        name: z.string().trim().min(2).max(100),
        description: z.string().max(2000).default(''),
        color: Color.default('purple'),
        visibility: z.enum(['workspace', 'private']).default('workspace'),
        teamId: z.string().nullish(),
        dueDate: DateStr.nullish(),
        memberIds: z.array(z.string()).max(500).default([]),
        createChannel: z.boolean().default(true),
        template: z.enum(['blank', 'product_launch', 'client_onboarding', 'weekly_ops']).default('blank'),
      }),
      req.body,
    );
    if (body.teamId && !db.get('SELECT 1 FROM teams WHERE id = ? AND workspace_id = ?', body.teamId, auth.workspaceId)) throw notFound('Team');
    const id = newId();
    let channelId: string | null = null;
    db.transaction(() => {
      db.insert('projects', {
        id,
        workspace_id: auth.workspaceId,
        team_id: body.teamId ?? null,
        name: body.name,
        description: body.description,
        color: body.color,
        visibility: body.visibility,
        owner_id: auth.userId,
        due_date: body.dueDate ?? null,
        created_at: now(),
        updated_at: now(),
      });
      const memberIds = [...new Set([auth.userId, ...body.memberIds])].filter((m) => isActiveMember(db, auth.workspaceId, m));
      for (const m of memberIds) addMember(id, m);
      if (body.createChannel) {
        channelId = newId();
        let name = body.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'project';
        if (db.get('SELECT 1 FROM channels WHERE workspace_id = ? AND name = ?', auth.workspaceId, name)) name = `${name}-${id.slice(0, 4)}`;
        db.insert('channels', {
          id: channelId,
          workspace_id: auth.workspaceId,
          project_id: id,
          team_id: body.teamId ?? null,
          name,
          topic: `Discussion for the ${body.name} project`,
          kind: body.visibility === 'private' ? 'private' : 'public',
          created_by: auth.userId,
          created_at: now(),
        });
        for (const m of memberIds) {
          db.run('INSERT OR IGNORE INTO channel_members (channel_id, user_id, joined_at) VALUES (?, ?, ?)', channelId, m, now());
        }
      }
      const template = TEMPLATES[body.template];
      if (template) {
        const milestoneIds = template.milestones.map((name, i) => {
          const mid = newId();
          db.insert('milestones', { id: mid, project_id: id, name, created_at: now() });
          return { mid, i };
        });
        template.tasks.forEach((t, i) => {
          db.insert('tasks', {
            id: newId(),
            workspace_id: auth.workspaceId,
            project_id: id,
            milestone_id: t.milestone >= 0 ? milestoneIds[t.milestone].mid : null,
            title: t.title,
            owner_id: auth.userId,
            recurrence: body.template === 'weekly_ops' ? 'weekly' : null,
            position: i,
            created_by: auth.userId,
            created_at: now(),
            updated_at: now(),
          });
        });
      }
    });
    recordActivity(ctx, auth.workspaceId, {
      actorId: auth.userId,
      verb: 'created',
      objectType: 'project',
      objectId: id,
      projectId: id,
      summary: `created the project ${body.name}`,
      link: `/projects/${id}`,
    });
    for (const m of body.memberIds) {
      notify(ctx, auth.workspaceId, { userId: m, kind: 'project', title: `You were added to the project ${body.name}`, link: `/projects/${id}`, actorId: auth.userId });
    }
    audit(ctx, auth.workspaceId, auth.userId, 'project.created', 'project', id, { visibility: body.visibility });
    emitEvent(ctx, auth.workspaceId, 'project.created', { id, name: body.name, owner_id: auth.userId, due_date: body.dueDate ?? null }, { projectId: id });
    res.status(201).json({ ...projectSummary(db, auth, db.get('SELECT * FROM projects WHERE id = ?', id)!), channel_id: channelId });
  });

  r.get('/projects/:id', (req, res) => {
    const auth = authOf(req);
    const project = loadProject(db, auth, req.params.id);
    const milestones = db.all(
      `SELECT m.*, (SELECT COUNT(*) FROM tasks t WHERE t.milestone_id = m.id) AS task_count,
              (SELECT COUNT(*) FROM tasks t WHERE t.milestone_id = m.id AND t.status = 'done') AS done_count
         FROM milestones m WHERE project_id = ? ORDER BY due_date IS NULL, due_date, created_at`,
      project.id,
    );
    const channels = db
      .all('SELECT * FROM channels WHERE project_id = ? AND archived_at IS NULL', project.id)
      .filter((c) => canViewChannel(db, auth, c))
      .map((c) => ({ id: c.id, name: c.name, kind: c.kind }));
    const latestUpdate = db.get(
      `SELECT s.*, u.name AS user_name, u.color AS user_color FROM status_updates s JOIN users u ON u.id = s.user_id
        WHERE project_id = ? ORDER BY created_at DESC LIMIT 1`,
      project.id,
    );
    res.json({
      ...projectSummary(db, auth, project),
      milestones,
      channels,
      latest_update: latestUpdate ?? null,
      can_contribute: canContributeProject(db, auth, project),
      can_manage: canManageProject(db, auth, project),
      ai_excluded: !!project.ai_excluded,
    });
  });

  r.patch('/projects/:id', (req, res) => {
    const auth = authOf(req);
    const project = loadProject(db, auth, req.params.id);
    if (!canManageProject(db, auth, project)) throw forbidden('Only the project owner, a project lead or an admin can change project settings');
    const body = parse(
      z.object({
        name: z.string().trim().min(2).max(100).optional(),
        description: z.string().max(2000).optional(),
        color: Color.optional(),
        visibility: z.enum(['workspace', 'private']).optional(),
        health: z.enum(['on_track', 'at_risk', 'off_track']).optional(),
        dueDate: DateStr.nullable().optional(),
        ownerId: z.string().optional(),
        teamId: z.string().nullable().optional(),
        archived: z.boolean().optional(),
      }),
      req.body,
    );
    if (body.ownerId && !isActiveMember(db, auth.workspaceId, body.ownerId)) throw notFound('Person');
    db.update('projects', project.id, {
      name: body.name,
      description: body.description,
      color: body.color,
      visibility: body.visibility,
      health: body.health,
      due_date: body.dueDate,
      owner_id: body.ownerId,
      team_id: body.teamId,
      archived_at: body.archived === undefined ? undefined : body.archived ? now() : null,
      updated_at: now(),
    });
    if (body.ownerId) addMember(project.id, body.ownerId);
    if (body.visibility && body.visibility !== project.visibility) {
      audit(ctx, auth.workspaceId, auth.userId, 'project.visibility_changed', 'project', project.id, { from: project.visibility, to: body.visibility });
    }
    if (body.archived !== undefined) {
      audit(ctx, auth.workspaceId, auth.userId, body.archived ? 'project.archived' : 'project.restored', 'project', project.id);
    }
    res.json(projectSummary(db, auth, db.get('SELECT * FROM projects WHERE id = ?', project.id)!));
  });

  r.post('/projects/:id/members', (req, res) => {
    const auth = authOf(req);
    const project = loadProject(db, auth, req.params.id);
    if (!canContributeProject(db, auth, project) || isGuest(auth)) throw forbidden('You cannot add people to this project');
    const { userIds } = parse(z.object({ userIds: z.array(z.string()).min(1).max(500) }), req.body);
    for (const userId of userIds) {
      if (!isActiveMember(db, auth.workspaceId, userId) || isProjectMember(db, project.id, userId)) continue;
      addMember(project.id, userId);
      for (const c of db.all('SELECT id FROM channels WHERE project_id = ?', project.id)) {
        db.run('INSERT OR IGNORE INTO channel_members (channel_id, user_id, joined_at) VALUES (?, ?, ?)', c.id, userId, now());
      }
      notify(ctx, auth.workspaceId, { userId, kind: 'project', title: `You were added to the project ${project.name}`, link: `/projects/${project.id}`, actorId: auth.userId });
    }
    audit(ctx, auth.workspaceId, auth.userId, 'project.members_added', 'project', project.id, { userIds });
    res.json({ ok: true });
  });

  r.delete('/projects/:id/members/:userId', (req, res) => {
    const auth = authOf(req);
    const project = loadProject(db, auth, req.params.id);
    if (req.params.userId !== auth.userId && !canManageProject(db, auth, project)) throw forbidden();
    if (req.params.userId === project.owner_id) throw badRequest('Transfer project ownership before removing the owner');
    db.run('DELETE FROM project_members WHERE project_id = ? AND user_id = ?', project.id, req.params.userId);
    if (project.visibility === 'private') {
      for (const c of db.all(`SELECT id FROM channels WHERE project_id = ? AND kind = 'private'`, project.id)) {
        db.run('DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?', c.id, req.params.userId);
      }
    }
    audit(ctx, auth.workspaceId, auth.userId, 'project.member_removed', 'project', project.id, { userId: req.params.userId });
    res.json({ ok: true });
  });

  // ----- Milestones -----

  r.post('/projects/:id/milestones', (req, res) => {
    const auth = authOf(req);
    const project = loadProject(db, auth, req.params.id);
    if (!canContributeProject(db, auth, project)) throw forbidden();
    const body = parse(z.object({ name: z.string().trim().min(1).max(100), dueDate: DateStr.nullish() }), req.body);
    const id = newId();
    db.insert('milestones', { id, project_id: project.id, name: body.name, due_date: body.dueDate ?? null, created_at: now() });
    res.status(201).json(db.get('SELECT * FROM milestones WHERE id = ?', id));
  });

  const loadMilestone = (auth: Auth, id: string) => {
    const m = db.get('SELECT * FROM milestones WHERE id = ?', id);
    if (!m) throw notFound('Milestone');
    const project = loadProject(db, auth, m.project_id);
    if (!canContributeProject(db, auth, project)) throw forbidden();
    return { m, project };
  };

  r.patch('/milestones/:id', (req, res) => {
    const auth = authOf(req);
    const { m, project } = loadMilestone(auth, req.params.id);
    const body = parse(z.object({ name: z.string().trim().min(1).max(100).optional(), dueDate: DateStr.nullable().optional(), done: z.boolean().optional() }), req.body);
    db.update('milestones', m.id, { name: body.name, due_date: body.dueDate, done_at: body.done === undefined ? undefined : body.done ? now() : null });
    if (body.done) {
      recordActivity(ctx, auth.workspaceId, { actorId: auth.userId, verb: 'completed', objectType: 'milestone', objectId: m.id, projectId: project.id, summary: `completed the milestone ${m.name}`, link: `/projects/${project.id}` });
    }
    res.json(db.get('SELECT * FROM milestones WHERE id = ?', m.id));
  });

  r.delete('/milestones/:id', (req, res) => {
    const { m } = loadMilestone(authOf(req), req.params.id);
    db.run('DELETE FROM milestones WHERE id = ?', m.id);
    res.json({ ok: true });
  });

  // ----- Status updates, weekly summary, risks -----

  r.get('/projects/:id/updates', (req, res) => {
    const auth = authOf(req);
    const project = loadProject(db, auth, req.params.id);
    res.json(
      db.all(
        `SELECT s.*, u.name AS user_name, u.color AS user_color FROM status_updates s JOIN users u ON u.id = s.user_id
          WHERE project_id = ? ORDER BY created_at DESC LIMIT 50`,
        project.id,
      ),
    );
  });

  r.post('/projects/:id/updates', (req, res) => {
    const auth = authOf(req);
    const project = loadProject(db, auth, req.params.id);
    if (!canContributeProject(db, auth, project)) throw forbidden();
    const body = parse(z.object({ health: z.enum(['on_track', 'at_risk', 'off_track']), body: z.string().trim().min(1).max(5000) }), req.body);
    const id = newId();
    db.insert('status_updates', { id, project_id: project.id, user_id: auth.userId, health: body.health, body: body.body, created_at: now() });
    db.update('projects', project.id, { health: body.health, updated_at: now() });
    recordActivity(ctx, auth.workspaceId, {
      actorId: auth.userId,
      verb: 'posted',
      objectType: 'status_update',
      objectId: id,
      projectId: project.id,
      summary: `posted a status update on ${project.name} (${body.health.replace('_', ' ')})`,
      link: `/projects/${project.id}`,
    });
    for (const m of db.all('SELECT user_id FROM project_members WHERE project_id = ?', project.id)) {
      notify(ctx, auth.workspaceId, { userId: m.user_id, kind: 'status', title: `New status update on ${project.name}`, body: body.body, link: `/projects/${project.id}`, actorId: auth.userId });
    }
    res.status(201).json(db.get('SELECT * FROM status_updates WHERE id = ?', id));
  });

  /** Rule-based weekly brief built from project records; transparent and reviewable before sharing. */
  r.get('/projects/:id/summary', (req, res) => {
    const auth = authOf(req);
    const project = loadProject(db, auth, req.params.id);
    const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const completed = db.all(`SELECT id, title, completed_at FROM tasks WHERE project_id = ? AND completed_at >= ? ORDER BY completed_at DESC`, project.id, since);
    const created = db.get(`SELECT COUNT(*) AS n FROM tasks WHERE project_id = ? AND created_at >= ?`, project.id, since)!.n;
    const blocked = db.all(`SELECT id, title, blocked_reason FROM tasks WHERE project_id = ? AND status = 'blocked'`, project.id);
    const overdue = db.all(`SELECT id, title, due_date FROM tasks WHERE project_id = ? AND status != 'done' AND due_date < ? ORDER BY due_date`, project.id, today());
    const decisions = db.all(`SELECT id, title, created_at FROM decisions WHERE project_id = ? AND created_at >= ? ORDER BY created_at DESC`, project.id, since);
    const upcoming = db.all(
      `SELECT id, name, due_date FROM milestones WHERE project_id = ? AND done_at IS NULL AND due_date IS NOT NULL ORDER BY due_date LIMIT 3`,
      project.id,
    );
    const risks = db.all(`SELECT id, title, impact FROM risks WHERE project_id = ? AND status = 'open' AND impact = 'high'`, project.id);
    const lines = [
      `Weekly summary for ${project.name}`,
      '',
      `Completed: ${completed.length} task(s)${completed.length ? ` — ${completed.slice(0, 5).map((t) => t.title).join('; ')}` : ''}.`,
      `New tasks added: ${created}.`,
      `Decisions recorded: ${decisions.length}${decisions.length ? ` — ${decisions.map((d) => d.title).join('; ')}` : ''}.`,
      `Blocked: ${blocked.length}${blocked.length ? ` — ${blocked.map((t) => t.title + (t.blocked_reason ? ` (${t.blocked_reason})` : '')).join('; ')}` : ''}.`,
      `Overdue: ${overdue.length}${overdue.length ? ` — ${overdue.slice(0, 5).map((t) => `${t.title} (due ${t.due_date})`).join('; ')}` : ''}.`,
      upcoming.length ? `Next milestones: ${upcoming.map((m) => `${m.name} (${m.due_date})`).join('; ')}.` : 'No dated milestones ahead.',
      risks.length ? `Open high-impact risks: ${risks.map((r) => r.title).join('; ')}.` : 'No open high-impact risks.',
    ];
    const suggestedHealth = overdue.length > 3 || risks.length > 1 ? 'off_track' : overdue.length || blocked.length || risks.length ? 'at_risk' : 'on_track';
    res.json({ completed, created, blocked, overdue, decisions, upcoming, risks, suggested_health: suggestedHealth, draft: lines.join('\n') });
  });

  r.get('/projects/:id/risks', (req, res) => {
    const auth = authOf(req);
    const project = loadProject(db, auth, req.params.id);
    res.json(
      db.all(
        `SELECT r.*, u.name AS owner_name FROM risks r LEFT JOIN users u ON u.id = r.owner_id WHERE project_id = ?
          ORDER BY status = 'open' DESC, CASE impact WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, created_at DESC`,
        project.id,
      ),
    );
  });

  const RiskBody = z.object({
    title: z.string().trim().min(1).max(200),
    impact: z.enum(['low', 'medium', 'high']).default('medium'),
    mitigation: z.string().max(2000).default(''),
    ownerId: z.string().nullish(),
    status: z.enum(['open', 'mitigated', 'closed']).default('open'),
  });

  r.post('/projects/:id/risks', (req, res) => {
    const auth = authOf(req);
    const project = loadProject(db, auth, req.params.id);
    if (!canContributeProject(db, auth, project)) throw forbidden();
    const body = parse(RiskBody, req.body);
    const id = newId();
    db.insert('risks', { id, project_id: project.id, title: body.title, impact: body.impact, mitigation: body.mitigation, owner_id: body.ownerId ?? null, status: body.status, created_at: now() });
    res.status(201).json(db.get('SELECT * FROM risks WHERE id = ?', id));
  });

  r.patch('/risks/:id', (req, res) => {
    const auth = authOf(req);
    const risk = db.get('SELECT * FROM risks WHERE id = ?', req.params.id);
    if (!risk) throw notFound('Risk');
    const project = loadProject(db, auth, risk.project_id);
    if (!canContributeProject(db, auth, project)) throw forbidden();
    const body = parse(RiskBody.partial(), req.body);
    db.update('risks', risk.id, { title: body.title, impact: body.impact, mitigation: body.mitigation, owner_id: body.ownerId, status: body.status });
    res.json(db.get('SELECT * FROM risks WHERE id = ?', risk.id));
  });

  r.delete('/risks/:id', (req, res) => {
    const auth = authOf(req);
    const risk = db.get('SELECT * FROM risks WHERE id = ?', req.params.id);
    if (!risk) throw notFound('Risk');
    const project = loadProject(db, auth, risk.project_id);
    if (!canContributeProject(db, auth, project)) throw forbidden();
    db.run('DELETE FROM risks WHERE id = ?', risk.id);
    res.json({ ok: true });
  });

  // ----- Resources & activity -----

  r.get('/projects/:id/resources', (req, res) => {
    const auth = authOf(req);
    const project = loadProject(db, auth, req.params.id);
    const files = db.all(
      `SELECT f.id, f.name, f.label, f.external_url, f.current_version, f.updated_at, v.mime, v.size, u.name AS owner_name
         FROM files f LEFT JOIN file_versions v ON v.file_id = f.id AND v.version = f.current_version JOIN users u ON u.id = f.owner_id
        WHERE f.project_id = ? AND f.archived_at IS NULL ORDER BY f.updated_at DESC`,
      project.id,
    );
    const pages = db.all(
      `SELECT p.id, p.title, p.status, p.review_date, p.updated_at, u.name AS owner_name FROM pages p JOIN users u ON u.id = p.owner_id
        WHERE p.project_id = ? AND p.archived_at IS NULL ORDER BY p.updated_at DESC`,
      project.id,
    );
    const meetings = db
      .all('SELECT id, title, starts_at, ended_at, workspace_id, organizer_id, project_id, channel_id FROM meetings WHERE project_id = ? ORDER BY starts_at DESC', project.id)
      .filter((m) => canViewMeeting(db, auth, m))
      .map(({ id, title, starts_at, ended_at }) => ({ id, title, starts_at, ended_at }));
    const decisions = db
      .all(
        `SELECT d.*, u.name AS decided_by_name FROM decisions d JOIN users u ON u.id = d.decided_by WHERE d.project_id = ? ORDER BY d.created_at DESC`,
        project.id,
      )
      .filter((d) => canViewDecision(db, auth, d));
    res.json({ files, pages, meetings, decisions });
  });

  r.get('/projects/:id/activity', (req, res) => {
    const auth = authOf(req);
    const project = loadProject(db, auth, req.params.id);
    res.json(
      db.all(
        `SELECT a.*, u.name AS actor_name, u.color AS actor_color FROM activity a JOIN users u ON u.id = a.actor_id
          WHERE a.project_id = ? ORDER BY a.created_at DESC LIMIT 50`,
        project.id,
      ),
    );
  });

  // ----- Decisions (§5.2 decision log, §6 "record the decision") -----

  r.get('/decisions', (req, res) => {
    const auth = authOf(req);
    const q = parse(z.object({ projectId: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }), req.query);
    if (q.projectId) loadProject(db, auth, q.projectId);
    const rows = db.all(
      `SELECT d.*, u.name AS decided_by_name, u.color AS decided_by_color, p.name AS project_name, c.name AS channel_name, m.title AS meeting_title
         FROM decisions d JOIN users u ON u.id = d.decided_by
         LEFT JOIN projects p ON p.id = d.project_id LEFT JOIN channels c ON c.id = d.channel_id LEFT JOIN meetings m ON m.id = d.meeting_id
        WHERE d.workspace_id = ? ${q.projectId ? 'AND d.project_id = ?' : ''} ORDER BY d.created_at DESC LIMIT 500`,
      ...(q.projectId ? [auth.workspaceId, q.projectId] : [auth.workspaceId]),
    );
    res.json(rows.filter((d) => canViewDecision(db, auth, d)).slice(0, q.limit));
  });

  r.post('/decisions', (req, res) => {
    const auth = authOf(req);
    const body = parse(
      z.object({
        title: z.string().trim().min(1).max(300),
        rationale: z.string().max(5000).default(''),
        projectId: z.string().nullish(),
        channelId: z.string().nullish(),
        messageId: z.string().nullish(),
        meetingId: z.string().nullish(),
      }),
      req.body,
    );
    let projectId = body.projectId ?? null;
    let channelId = body.channelId ?? null;
    if (body.messageId) {
      const message = db.get('SELECT * FROM messages WHERE id = ?', body.messageId);
      if (!message) throw notFound('Message');
      const channel = loadChannel(db, auth, message.channel_id);
      channelId = channel.id;
      projectId ??= channel.project_id;
    }
    if (channelId) {
      const channel = loadChannel(db, auth, channelId);
      projectId ??= channel.project_id;
    }
    if (body.meetingId) {
      const meeting = db.get('SELECT * FROM meetings WHERE id = ?', body.meetingId);
      if (!meeting || !canViewMeeting(db, auth, meeting)) throw notFound('Meeting');
      projectId ??= meeting.project_id;
    }
    if (projectId) {
      const project = loadProject(db, auth, projectId);
      if (!canContributeProject(db, auth, project)) throw forbidden();
    } else if (isGuest(auth) && !channelId && !body.meetingId) {
      throw forbidden('Guests must record decisions in a shared channel or project');
    }
    const id = newId();
    db.insert('decisions', {
      id,
      workspace_id: auth.workspaceId,
      project_id: projectId,
      channel_id: channelId,
      message_id: body.messageId ?? null,
      meeting_id: body.meetingId ?? null,
      title: body.title,
      rationale: body.rationale,
      decided_by: auth.userId,
      created_at: now(),
    });
    recordActivity(ctx, auth.workspaceId, {
      actorId: auth.userId,
      verb: 'recorded',
      objectType: 'decision',
      objectId: id,
      projectId,
      channelId,
      summary: `recorded the decision “${body.title}”`,
      link: projectId ? `/projects/${projectId}?tab=decisions` : `/decisions`,
    });
    emitEvent(ctx, auth.workspaceId, 'decision.recorded', { id, title: body.title, rationale: body.rationale, project_id: projectId, channel_id: channelId, meeting_id: body.meetingId ?? null, decided_by: auth.userId }, { projectId, channelId });
    if (channelId) {
      const channel = db.get('SELECT * FROM channels WHERE id = ?', channelId)!;
      ctx.hub.publish(auth.workspaceId, { type: 'message.updated', messageId: body.messageId, channelId }, (a) => canViewChannel(db, a, channel));
    }
    res.status(201).json(db.get('SELECT * FROM decisions WHERE id = ?', id));
  });

  r.delete('/decisions/:id', (req, res) => {
    const auth = authOf(req);
    const d = db.get('SELECT * FROM decisions WHERE id = ?', req.params.id);
    if (!d || !canViewDecision(db, auth, d)) throw notFound('Decision');
    if (d.decided_by !== auth.userId && !isAdmin(auth)) throw forbidden('Only the person who recorded this decision or an admin can remove it');
    db.run('DELETE FROM decisions WHERE id = ?', d.id);
    audit(ctx, auth.workspaceId, auth.userId, 'decision.deleted', 'decision', d.id, { title: d.title });
    res.json({ ok: true });
  });

  return r;
}
