import { Router } from 'express';
import { z } from 'zod';
import {
  accessibleProjectIds,
  canManageProject,
  canPostChannel,
  canViewChannel,
  canViewTask,
  loadChannel,
  loadProject,
  loadTask,
  requireRole,
  type Auth,
  type Role,
} from '../access.js';
import { ActionConfig, ACTIONS, runAutomations, TriggerConfig, TRIGGERS } from '../automations.js';
import type { Row } from '../db.js';
import { audit, authOf, notify, type Ctx } from '../context.js';
import { badRequest, forbidden, HttpError, newId, notFound, now, parse, parseJson, today } from '../util.js';
import { hasFeature, requireFeature } from '../plans.js';
import { postMessage } from './channels.js';

const Iso = z.string().datetime({ offset: true });

export function productivityRouter(ctx: Ctx) {
  const r = Router();
  const { db } = ctx;

  // ======================= Automations =======================

  const ruleSummary = (a: Row) => ({
    id: a.id,
    project_id: a.project_id,
    name: a.name,
    trigger_type: a.trigger_type,
    trigger_config: parseJson(a.trigger_config, {}),
    action_type: a.action_type,
    action_config: parseJson(a.action_config, {}),
    enabled: !!a.enabled,
    run_count: a.run_count,
    last_run_at: a.last_run_at,
    created_by: db.get('SELECT id, name FROM users WHERE id = ?', a.created_by) ?? null,
    created_at: a.created_at,
  });

  const RuleBody = z.object({
    name: z.string().trim().min(1).max(100),
    triggerType: z.enum(TRIGGERS),
    triggerConfig: TriggerConfig.default({}),
    actionType: z.enum(ACTIONS),
    actionConfig: ActionConfig.default({}),
    enabled: z.boolean().default(true),
  });

  const validateAction = (auth: Auth, projectId: string, type: string, cfg: z.infer<typeof ActionConfig>) => {
    if ((type === 'assign' || type === 'notify') && (cfg.target ?? 'user') === 'user') {
      if (!cfg.user_id || !db.get('SELECT 1 FROM memberships WHERE workspace_id = ? AND user_id = ? AND deactivated_at IS NULL', auth.workspaceId, cfg.user_id)) {
        throw badRequest('Choose a person for this action');
      }
    }
    if (type === 'set_priority' && !cfg.priority) throw badRequest('Choose a priority');
    if (type === 'add_checklist' && !cfg.items?.length) throw badRequest('Add at least one checklist item');
    if (type === 'post_message') {
      if (!cfg.channel_id) throw badRequest('Choose a channel');
      const channel = loadChannel(db, auth, cfg.channel_id);
      if (!canPostChannel(db, auth, channel)) throw forbidden('You cannot post in that channel');
      if (channel.kind === 'dm') throw badRequest('Choose a channel, not a direct message');
      if (channel.kind !== 'public' && channel.project_id !== projectId) {
        throw badRequest('Private channels can only be used by automations in their own project');
      }
    }
  };

  r.get('/projects/:id/automations', (req, res) => {
    const auth = authOf(req);
    const project = loadProject(db, auth, req.params.id);
    res.json({
      triggers: TRIGGERS,
      actions: ACTIONS,
      can_manage: canManageProject(db, auth, project),
      automations: db.all('SELECT * FROM automations WHERE project_id = ? ORDER BY created_at', project.id).map(ruleSummary),
    });
  });

  r.post('/projects/:id/automations', (req, res) => {
    const auth = authOf(req);
    const project = loadProject(db, auth, req.params.id);
    if (!canManageProject(db, auth, project)) throw forbidden('Only the project owner, a project lead or an admin can add automations');
    const body = parse(RuleBody, req.body);
    requireFeature(ctx, auth.workspaceId, 'automations');
    validateAction(auth, project.id, body.actionType, body.actionConfig);
    const id = newId();
    db.insert('automations', {
      id,
      workspace_id: auth.workspaceId,
      project_id: project.id,
      name: body.name,
      trigger_type: body.triggerType,
      trigger_config: body.triggerConfig,
      action_type: body.actionType,
      action_config: body.actionConfig,
      enabled: body.enabled,
      created_by: auth.userId,
      created_at: now(),
    });
    audit(ctx, auth.workspaceId, auth.userId, 'automation.created', 'automation', id, { project: project.id, trigger: body.triggerType, action: body.actionType });
    res.status(201).json(ruleSummary(db.get('SELECT * FROM automations WHERE id = ?', id)!));
  });

  const loadRule = (auth: Auth, id: string) => {
    const rule = db.get('SELECT * FROM automations WHERE id = ? AND workspace_id = ?', id, auth.workspaceId);
    if (!rule) throw notFound('Automation');
    const project = loadProject(db, auth, rule.project_id);
    return { rule, project };
  };

  r.patch('/automations/:id', (req, res) => {
    const auth = authOf(req);
    requireFeature(ctx, auth.workspaceId, 'automations');
    const { rule, project } = loadRule(auth, req.params.id);
    if (!canManageProject(db, auth, project)) throw forbidden();
    const body = parse(RuleBody.partial(), req.body);
    if (body.actionType || body.actionConfig) {
      validateAction(auth, project.id, body.actionType ?? rule.action_type, body.actionConfig ?? parseJson(rule.action_config, {}));
    }
    db.update('automations', rule.id, {
      name: body.name,
      trigger_type: body.triggerType,
      trigger_config: body.triggerConfig,
      action_type: body.actionType,
      action_config: body.actionConfig,
      enabled: body.enabled,
    });
    audit(ctx, auth.workspaceId, auth.userId, 'automation.updated', 'automation', rule.id, { enabled: body.enabled });
    res.json(ruleSummary(db.get('SELECT * FROM automations WHERE id = ?', rule.id)!));
  });

  r.delete('/automations/:id', (req, res) => {
    const auth = authOf(req);
    const { rule, project } = loadRule(auth, req.params.id);
    if (!canManageProject(db, auth, project)) throw forbidden();
    db.run('DELETE FROM automations WHERE id = ?', rule.id);
    audit(ctx, auth.workspaceId, auth.userId, 'automation.deleted', 'automation', rule.id, { name: rule.name });
    res.json({ ok: true });
  });

  r.get('/automations/:id/runs', (req, res) => {
    const auth = authOf(req);
    const { rule } = loadRule(auth, req.params.id);
    res.json(
      db
        .all(
          `SELECT r.*, t.title AS task_title, t.workspace_id, t.project_id, t.owner_id, t.created_by, t.reviewer_id FROM automation_runs r
             LEFT JOIN tasks t ON t.id = r.task_id WHERE r.automation_id = ? ORDER BY r.created_at DESC LIMIT 50`,
          rule.id,
        )
        .map((run) => ({ id: run.id, outcome: run.outcome, detail: run.detail, created_at: run.created_at, task: run.task_id && run.task_title ? { id: run.task_id, title: run.task_title } : null })),
    );
  });

  // ======================= Reminders =======================

  r.get('/reminders', (req, res) => {
    const auth = authOf(req);
    res.json(
      db.all(
        `SELECT r.*, t.title AS task_title, m.body AS message_body, m.channel_id FROM reminders r
           LEFT JOIN tasks t ON t.id = r.task_id LEFT JOIN messages m ON m.id = r.message_id
          WHERE r.user_id = ? AND r.workspace_id = ? AND r.sent_at IS NULL ORDER BY r.remind_at`,
        auth.userId,
        auth.workspaceId,
      ),
    );
  });

  r.post('/reminders', (req, res) => {
    const auth = authOf(req);
    const body = parse(
      z.object({ remindAt: Iso, note: z.string().max(500).default(''), messageId: z.string().nullish(), taskId: z.string().nullish() }),
      req.body,
    );
    if (new Date(body.remindAt).getTime() < Date.now() - 60_000) throw badRequest('Choose a time in the future');
    if (body.messageId) {
      const message = db.get('SELECT * FROM messages WHERE id = ?', body.messageId);
      if (!message) throw notFound('Message');
      loadChannel(db, auth, message.channel_id);
    }
    if (body.taskId) loadTask(db, auth, body.taskId);
    if (!body.messageId && !body.taskId && !body.note.trim()) throw badRequest('Add a note for the reminder');
    const id = newId();
    db.insert('reminders', {
      id,
      workspace_id: auth.workspaceId,
      user_id: auth.userId,
      message_id: body.messageId ?? null,
      task_id: body.taskId ?? null,
      note: body.note,
      remind_at: new Date(body.remindAt).toISOString(),
      created_at: now(),
    });
    res.status(201).json(db.get('SELECT * FROM reminders WHERE id = ?', id));
  });

  r.delete('/reminders/:id', (req, res) => {
    const auth = authOf(req);
    const changed = db.run('DELETE FROM reminders WHERE id = ? AND user_id = ?', req.params.id, auth.userId);
    if (!changed.changes) throw notFound('Reminder');
    res.json({ ok: true });
  });

  // ======================= Scheduled messages =======================

  r.get('/scheduled-messages', (req, res) => {
    const auth = authOf(req);
    res.json(
      db.all(
        `SELECT s.*, c.name AS channel_name, c.kind AS channel_kind FROM scheduled_messages s JOIN channels c ON c.id = s.channel_id
          WHERE s.user_id = ? AND s.workspace_id = ? AND s.sent_message_id IS NULL ORDER BY s.send_at`,
        auth.userId,
        auth.workspaceId,
      ),
    );
  });

  r.post('/channels/:id/scheduled-messages', (req, res) => {
    const auth = authOf(req);
    const channel = loadChannel(db, auth, req.params.id);
    const body = parse(z.object({ body: z.string().trim().min(1).max(10_000), sendAt: Iso, parentId: z.string().nullish() }), req.body);
    if (!canPostChannel(db, auth, channel)) throw forbidden('You cannot post here');
    const when = new Date(body.sendAt);
    if (when.getTime() < Date.now() + 30_000) throw badRequest('Choose a time at least a minute from now');
    if (when.getTime() > Date.now() + 366 * 86_400_000) throw badRequest('Messages can be scheduled up to a year ahead');
    if (body.parentId && !db.get('SELECT 1 FROM messages WHERE id = ? AND channel_id = ? AND parent_id IS NULL', body.parentId, channel.id)) {
      throw badRequest('Replies must target a top-level message in this channel');
    }
    const id = newId();
    db.insert('scheduled_messages', {
      id,
      workspace_id: auth.workspaceId,
      channel_id: channel.id,
      user_id: auth.userId,
      parent_id: body.parentId ?? null,
      body: body.body,
      send_at: when.toISOString(),
      created_at: now(),
    });
    res.status(201).json(db.get('SELECT * FROM scheduled_messages WHERE id = ?', id));
  });

  r.patch('/scheduled-messages/:id', (req, res) => {
    const auth = authOf(req);
    const item = db.get('SELECT * FROM scheduled_messages WHERE id = ? AND user_id = ? AND sent_message_id IS NULL', req.params.id, auth.userId);
    if (!item) throw notFound('Scheduled message');
    const body = parse(z.object({ body: z.string().trim().min(1).max(10_000).optional(), sendAt: Iso.optional() }), req.body);
    if (body.sendAt && new Date(body.sendAt).getTime() < Date.now() + 30_000) throw badRequest('Choose a time at least a minute from now');
    db.update('scheduled_messages', item.id, { body: body.body, send_at: body.sendAt ? new Date(body.sendAt).toISOString() : undefined, failed_reason: null });
    res.json(db.get('SELECT * FROM scheduled_messages WHERE id = ?', item.id));
  });

  r.delete('/scheduled-messages/:id', (req, res) => {
    const auth = authOf(req);
    const changed = db.run('DELETE FROM scheduled_messages WHERE id = ? AND user_id = ? AND sent_message_id IS NULL', req.params.id, auth.userId);
    if (!changed.changes) throw notFound('Scheduled message');
    res.json({ ok: true });
  });

  // ======================= Workload (§5.2 "workload views") =======================

  r.get('/workload', (req, res) => {
    const auth = authOf(req);
    requireFeature(ctx, auth.workspaceId, 'planning');
    const q = parse(z.object({ weeks: z.coerce.number().int().min(1).max(12).default(4), projectId: z.string().optional(), teamId: z.string().optional() }), req.query);
    let projects = accessibleProjectIds(db, auth);
    if (q.projectId) {
      loadProject(db, auth, q.projectId);
      projects = [q.projectId];
    }
    // Monday of the current week (UTC) as the first bucket.
    const start = new Date(`${today()}T00:00:00Z`);
    start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
    const weeks = Array.from({ length: q.weeks }, (_, i) => {
      const d = new Date(start);
      d.setUTCDate(d.getUTCDate() + i * 7);
      return d.toISOString().slice(0, 10);
    });
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + q.weeks * 7);
    const endStr = end.toISOString().slice(0, 10);
    const tasks = projects.length
      ? db
          .all(
            `SELECT t.*, p.name AS project_name, p.color AS project_color FROM tasks t JOIN projects p ON p.id = t.project_id
              WHERE t.project_id IN (${projects.map(() => '?').join(',')}) AND t.status != 'done' AND t.owner_id IS NOT NULL
                AND (t.due_date IS NULL OR t.due_date < ?)`,
            ...projects,
            endStr,
          )
          .filter((t) => canViewTask(db, auth, t))
      : [];
    let people = db.all(
      `SELECT u.id, u.name, u.color, u.title FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.workspace_id = ? AND m.deactivated_at IS NULL AND m.role != 'guest' ORDER BY u.name`,
      auth.workspaceId,
    );
    if (q.teamId) {
      const members = new Set(db.all('SELECT user_id FROM team_members WHERE team_id = ?', q.teamId).map((m) => m.user_id));
      people = people.filter((p) => members.has(p.id));
    }
    const bucketOf = (t: Row) => {
      if (!t.due_date) return 'unscheduled';
      if (t.due_date < weeks[0]) return 'overdue';
      return [...weeks].reverse().find((w) => t.due_date >= w) ?? weeks[0];
    };
    const rows = people
      .map((p) => {
        const mine = tasks.filter((t) => t.owner_id === p.id);
        const buckets: Record<string, { tasks: number; hours: number; items: { id: string; title: string; due_date: string | null; project: string; color: string; estimate_hours: number | null }[] }> = {};
        for (const key of ['overdue', ...weeks, 'unscheduled']) buckets[key] = { tasks: 0, hours: 0, items: [] };
        for (const t of mine) {
          const b = buckets[bucketOf(t)];
          b.tasks += 1;
          b.hours += t.estimate_hours ?? 0;
          b.items.push({ id: t.id, title: t.title, due_date: t.due_date, project: t.project_name, color: t.project_color, estimate_hours: t.estimate_hours });
        }
        return { person: p, total: mine.length, buckets };
      })
      .filter((row) => row.total > 0 || !q.projectId);
    res.json({ weeks, capacity_hours_per_week: 32, rows });
  });

  // ======================= Workspace insights (§2 success measures) =======================

  r.get('/admin/insights', (req, res) => {
    const auth = authOf(req);
    requireRole(auth, 'lead');
    requireFeature(ctx, auth.workspaceId, 'insights');
    const ws = auth.workspaceId;
    const t0 = today();
    const weekStarts = Array.from({ length: 8 }, (_, i) => new Date(Date.now() - (8 - i) * 7 * 86_400_000));
    const weekly = weekStarts.map((from) => {
      const to = new Date(from.getTime() + 7 * 86_400_000);
      const a = from.toISOString();
      const b = to.toISOString();
      const active = db.get(
        `SELECT COUNT(DISTINCT user_id) AS n FROM (
           SELECT user_id FROM sessions WHERE workspace_id = ? AND created_at >= ? AND created_at < ?
           UNION SELECT actor_id AS user_id FROM activity WHERE workspace_id = ? AND created_at >= ? AND created_at < ?
           UNION SELECT m.user_id FROM messages m JOIN channels c ON c.id = m.channel_id WHERE c.workspace_id = ? AND m.created_at >= ? AND m.created_at < ?)`,
        ws, a, b, ws, a, b, ws, a, b,
      )!.n;
      const messages = db.get(
        `SELECT COUNT(*) AS n FROM messages m JOIN channels c ON c.id = m.channel_id WHERE c.workspace_id = ? AND m.created_at >= ? AND m.created_at < ?`,
        ws, a, b,
      )!.n;
      const completed = db.get(`SELECT COUNT(*) AS n FROM tasks WHERE workspace_id = ? AND completed_at >= ? AND completed_at < ?`, ws, a, b)!.n;
      const decisions = db.get(`SELECT COUNT(*) AS n FROM decisions WHERE workspace_id = ? AND created_at >= ? AND created_at < ?`, ws, a, b)!.n;
      return { week_of: a.slice(0, 10), active_people: active, messages, tasks_completed: completed, decisions };
    });
    const members = db.get(`SELECT COUNT(*) AS n FROM memberships WHERE workspace_id = ? AND deactivated_at IS NULL`, ws)!.n;
    const openProjectTasks = db.get(
      `SELECT COUNT(*) AS total, SUM(t.owner_id IS NOT NULL) AS owned, SUM(t.due_date IS NOT NULL) AS dated, SUM(t.due_date < ?) AS overdue
         FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.workspace_id = ? AND t.status != 'done' AND p.archived_at IS NULL`,
      t0,
      ws,
    )!;
    const activeProjects = db.get(`SELECT COUNT(*) AS n FROM projects WHERE workspace_id = ? AND archived_at IS NULL`, ws)!.n;
    const since30 = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const projectsWithDecisions = db.get(
      `SELECT COUNT(DISTINCT project_id) AS n FROM decisions WHERE workspace_id = ? AND project_id IS NOT NULL AND created_at >= ?`,
      ws,
      since30,
    )!.n;
    const projectsWithUpdates = db.get(
      `SELECT COUNT(DISTINCT s.project_id) AS n FROM status_updates s JOIN projects p ON p.id = s.project_id WHERE p.workspace_id = ? AND s.created_at >= ?`,
      ws,
      new Date(Date.now() - 14 * 86_400_000).toISOString(),
    )!.n;
    const endedMeetings = db.get(`SELECT COUNT(*) AS n FROM meetings WHERE workspace_id = ? AND ended_at >= ?`, ws, since30)!.n;
    const meetingsWithOutcomes = db.get(
      `SELECT COUNT(*) AS n FROM meetings m WHERE m.workspace_id = ? AND m.ended_at >= ?
         AND (EXISTS (SELECT 1 FROM decisions d WHERE d.meeting_id = m.id) OR EXISTS (SELECT 1 FROM tasks t WHERE t.meeting_id = m.id))`,
      ws,
      since30,
    )!.n;
    const cycle = db.get(
      `SELECT AVG(julianday(completed_at) - julianday(created_at)) AS days FROM tasks WHERE workspace_id = ? AND completed_at >= ?`,
      ws,
      since30,
    )!.days;
    const interruptions = db.get(
      `SELECT COUNT(*) * 1.0 / MAX(1, (SELECT COUNT(*) FROM memberships WHERE workspace_id = ? AND deactivated_at IS NULL)) / 7 AS per_day
         FROM notifications WHERE workspace_id = ? AND created_at >= ?`,
      ws,
      ws,
      new Date(Date.now() - 7 * 86_400_000).toISOString(),
    )!.per_day;
    const pct = (n: number, d: number) => (d ? Math.round((n / d) * 100) : null);
    const lastWeek = weekly[weekly.length - 1];
    res.json({
      generated_at: now(),
      members,
      weekly,
      measures: [
        { id: 'wau', label: 'Weekly active people', value: pct(lastWeek.active_people, members), unit: '%', target: 75, detail: `${lastWeek.active_people} of ${members} people active in the last 7 days` },
        { id: 'ownership', label: 'Open project tasks with one owner', value: pct(openProjectTasks.owned ?? 0, openProjectTasks.total), unit: '%', target: 90, detail: `${openProjectTasks.owned ?? 0} of ${openProjectTasks.total} open tasks` },
        { id: 'decisions', label: 'Active projects that recorded a decision (30 days)', value: pct(projectsWithDecisions, activeProjects), unit: '%', target: 70, detail: `${projectsWithDecisions} of ${activeProjects} projects` },
        { id: 'status', label: 'Projects with a status update (14 days)', value: pct(projectsWithUpdates, activeProjects), unit: '%', target: 80, detail: `${projectsWithUpdates} of ${activeProjects} projects` },
        { id: 'meetings', label: 'Meetings ending with decisions or follow-ups (30 days)', value: pct(meetingsWithOutcomes, endedMeetings), unit: '%', target: 80, detail: `${meetingsWithOutcomes} of ${endedMeetings} meetings` },
        { id: 'overdue', label: 'Open project tasks overdue', value: pct(openProjectTasks.overdue ?? 0, openProjectTasks.total), unit: '%', target: 10, lower_is_better: true, detail: `${openProjectTasks.overdue ?? 0} overdue` },
        { id: 'cycle', label: 'Average days from task created to done (30 days)', value: cycle == null ? null : Math.round(cycle * 10) / 10, unit: 'days', lower_is_better: true },
        { id: 'interruptions', label: 'Notifications per person per day (7 days)', value: interruptions == null ? null : Math.round(interruptions * 10) / 10, unit: '', target: 15, lower_is_better: true },
      ],
    });
  });

  return r;
}

// ======================= Background jobs =======================

const roleOf = (ctx: Ctx, workspaceId: string, userId: string) =>
  ctx.db.get('SELECT role FROM memberships WHERE workspace_id = ? AND user_id = ? AND deactivated_at IS NULL', workspaceId, userId)?.role as Role | undefined;

/** Deliver due personal reminders. */
export function processReminders(ctx: Ctx) {
  const { db } = ctx;
  const due = db.all(`SELECT * FROM reminders WHERE sent_at IS NULL AND remind_at <= ? LIMIT 100`, now());
  for (const r of due) {
    db.run('UPDATE reminders SET sent_at = ? WHERE id = ?', now(), r.id);
    const role = roleOf(ctx, r.workspace_id, r.user_id);
    if (!role) continue;
    const auth: Auth = { userId: r.user_id, workspaceId: r.workspace_id, role };
    let link = '/inbox';
    let title = r.note ? `Reminder: ${r.note}` : 'Reminder';
    if (r.message_id) {
      const m = db.get('SELECT * FROM messages WHERE id = ?', r.message_id);
      const c = m && db.get('SELECT * FROM channels WHERE id = ?', m.channel_id);
      if (!m || !c || !canViewChannel(db, auth, c)) continue;
      link = `/channels/${c.id}?message=${m.parent_id ?? m.id}`;
      if (!r.note) title = `Reminder about a message in ${c.kind === 'dm' ? 'a direct message' : `#${c.name}`}`;
    }
    if (r.task_id) {
      const t = db.get('SELECT * FROM tasks WHERE id = ?', r.task_id);
      if (!t || !canViewTask(db, auth, t)) continue;
      link = `/tasks/${t.id}`;
      if (!r.note) title = `Reminder: “${t.title}”`;
    }
    notify(ctx, r.workspace_id, { userId: r.user_id, kind: 'reminder', title, link, urgent: false });
  }
  return due.length;
}

/** Send scheduled messages as their author, re-checking access at send time. */
export function processScheduledMessages(ctx: Ctx) {
  const { db } = ctx;
  const due = db.all(`SELECT * FROM scheduled_messages WHERE sent_message_id IS NULL AND failed_reason IS NULL AND send_at <= ? LIMIT 100`, now());
  for (const s of due) {
    const role = roleOf(ctx, s.workspace_id, s.user_id);
    const channel = db.get('SELECT * FROM channels WHERE id = ?', s.channel_id);
    const auth: Auth | null = role ? { userId: s.user_id, workspaceId: s.workspace_id, role } : null;
    try {
      if (!auth || !channel) throw new HttpError(403, 'You no longer have access to this conversation');
      const message = postMessage(ctx, auth, channel, { body: s.body, parentId: s.parent_id });
      db.run('UPDATE scheduled_messages SET sent_message_id = ? WHERE id = ?', message.id, s.id);
    } catch (error) {
      db.run('UPDATE scheduled_messages SET failed_reason = ? WHERE id = ?', (error as Error).message.slice(0, 200), s.id);
      if (auth) notify(ctx, s.workspace_id, { userId: s.user_id, kind: 'reminder', title: 'A scheduled message could not be sent', body: (error as Error).message, link: '/later' });
    }
  }
  return due.length;
}

/**
 * Deadline reminders: owners hear about tasks due tomorrow and, once, about
 * tasks that became overdue. Overdue tasks also fire "task.overdue" automations.
 */
export function processDeadlines(ctx: Ctx, at = new Date()) {
  const { db } = ctx;
  const t0 = at.toISOString().slice(0, 10);
  const tomorrow = new Date(at.getTime() + 86_400_000).toISOString().slice(0, 10);
  const once = (taskId: string, due: string, kind: string) => {
    const res = db.run('INSERT OR IGNORE INTO deadline_reminders (task_id, due_date, kind, created_at) VALUES (?, ?, ?, ?)', taskId, due, kind, now());
    return res.changes > 0;
  };
  let sent = 0;
  for (const t of db.all(`SELECT * FROM tasks WHERE status != 'done' AND owner_id IS NOT NULL AND due_date = ?`, tomorrow)) {
    if (!once(t.id, t.due_date, 'due_soon')) continue;
    notify(ctx, t.workspace_id, { userId: t.owner_id, kind: 'deadline', title: `“${t.title}” is due tomorrow`, link: `/tasks/${t.id}` });
    sent += 1;
  }
  for (const t of db.all(`SELECT * FROM tasks WHERE status != 'done' AND due_date IS NOT NULL AND due_date < ?`, t0)) {
    if (!once(t.id, t.due_date, 'overdue')) continue;
    if (t.owner_id) notify(ctx, t.workspace_id, { userId: t.owner_id, kind: 'deadline', title: `“${t.title}” is overdue`, body: `It was due ${t.due_date}.`, link: `/tasks/${t.id}` });
    runAutomations(ctx, 'task.overdue', t);
    sent += 1;
  }
  return sent;
}

/**
 * Retention (§5.3, §5.7): permanently delete messages older than the
 * workspace's retention period, unless a legal hold is in place.
 */
export function applyRetention(ctx: Ctx, at = new Date()) {
  const { db } = ctx;
  let total = 0;
  for (const ws of db.all('SELECT id, retention_days FROM workspaces WHERE retention_days IS NOT NULL AND legal_hold = 0')) {
    // A workspace that no longer has retention on its plan keeps everything (never delete because of a downgrade).
    if (!hasFeature(ctx, ws.id, 'retention')) continue;
    const cutoff = new Date(at.getTime() - ws.retention_days * 86_400_000).toISOString();
    const res = db.run(
      // A thread is kept while any reply is newer than the cutoff; old replies inside it are still removed.
      `DELETE FROM messages WHERE created_at < ? AND channel_id IN (SELECT id FROM channels WHERE workspace_id = ?)
         AND (parent_id IS NOT NULL OR NOT EXISTS (SELECT 1 FROM messages r WHERE r.parent_id = messages.id AND r.created_at >= ?))`,
      cutoff,
      ws.id,
      cutoff,
    );
    if (res.changes) {
      audit(ctx, ws.id, null, 'retention.messages_deleted', 'workspace', ws.id, { count: Number(res.changes), before: cutoff.slice(0, 10) });
      total += Number(res.changes);
    }
  }
  return total;
}

