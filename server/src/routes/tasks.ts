import { Router } from 'express';
import { z } from 'zod';
import {
  canContributeProject,
  canEditTask,
  canViewMeeting,
  canViewTask,
  isActiveMember,
  isAdmin,
  isGuest,
  isProjectMember,
  loadChannel,
  loadProject,
  loadTask,
  accessibleProjectIds,
  type Auth,
} from '../access.js';
import type { Database, Row } from '../db.js';
import { authOf, notify, recordActivity, userSummary, type Ctx } from '../context.js';
import { emitEvent } from '../webhooks.js';
import { runAutomations } from '../automations.js';
import { badRequest, forbidden, newId, notFound, now, parse, today } from '../util.js';

const DateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD');
const Status = z.enum(['todo', 'in_progress', 'blocked', 'review', 'done']);
const Priority = z.enum(['low', 'medium', 'high', 'urgent']);

export function serializeTasks(db: Database, rows: Row[]) {
  if (!rows.length) return [];
  const ids = rows.map((t) => t.id);
  const marks = ids.map(() => '?').join(',');
  const checklist = db.all(
    `SELECT task_id, COUNT(*) AS total, SUM(done) AS done FROM checklist_items WHERE task_id IN (${marks}) GROUP BY task_id`,
    ...ids,
  );
  const comments = db.all(`SELECT task_id, COUNT(*) AS n FROM task_comments WHERE task_id IN (${marks}) GROUP BY task_id`, ...ids);
  const subtasks = db.all(
    `SELECT parent_id, COUNT(*) AS total, SUM(status = 'done') AS done FROM tasks WHERE parent_id IN (${marks}) GROUP BY parent_id`,
    ...ids,
  );
  const openDeps = db.all(
    `SELECT d.task_id, COUNT(*) AS n FROM task_dependencies d JOIN tasks t ON t.id = d.depends_on_id
      WHERE d.task_id IN (${marks}) AND t.status != 'done' GROUP BY d.task_id`,
    ...ids,
  );
  const projectIds = [...new Set(rows.map((t) => t.project_id).filter(Boolean))];
  const projects = new Map(
    projectIds.length
      ? db.all(`SELECT id, name, color FROM projects WHERE id IN (${projectIds.map(() => '?').join(',')})`, ...projectIds).map((p) => [p.id, p])
      : [],
  );
  const userIds = [...new Set(rows.flatMap((t) => [t.owner_id, t.reviewer_id]).filter(Boolean))];
  const users = new Map(
    userIds.length ? db.all(`SELECT id, name, color FROM users WHERE id IN (${userIds.map(() => '?').join(',')})`, ...userIds).map((u) => [u.id, u]) : [],
  );
  const t0 = today();
  return rows.map((t) => {
    const c = checklist.find((x) => x.task_id === t.id);
    const s = subtasks.find((x) => x.parent_id === t.id);
    return {
      id: t.id,
      title: t.title,
      description: t.description,
      status: t.status,
      priority: t.priority,
      due_date: t.due_date,
      start_date: t.start_date ?? null,
      estimate_hours: t.estimate_hours ?? null,
      overdue: !!t.due_date && t.due_date < t0 && t.status !== 'done',
      blocked_reason: t.blocked_reason,
      recurrence: t.recurrence,
      position: t.position,
      project: t.project_id ? projects.get(t.project_id) ?? null : null,
      milestone_id: t.milestone_id,
      parent_id: t.parent_id,
      owner: t.owner_id ? users.get(t.owner_id) ?? null : null,
      reviewer: t.reviewer_id ? users.get(t.reviewer_id) ?? null : null,
      source_message_id: t.source_message_id,
      meeting_id: t.meeting_id,
      created_by: t.created_by,
      created_at: t.created_at,
      updated_at: t.updated_at,
      completed_at: t.completed_at,
      checklist: { total: c?.total ?? 0, done: c?.done ?? 0 },
      subtasks: { total: s?.total ?? 0, done: s?.done ?? 0 },
      comment_count: comments.find((x) => x.task_id === t.id)?.n ?? 0,
      waiting_on: openDeps.find((x) => x.task_id === t.id)?.n ?? 0,
    };
  });
}

function nextDue(due: string | null, recurrence: string) {
  const d = due ? new Date(`${due}T00:00:00Z`) : new Date(`${today()}T00:00:00Z`);
  if (recurrence === 'daily') d.setUTCDate(d.getUTCDate() + 1);
  if (recurrence === 'weekly') d.setUTCDate(d.getUTCDate() + 7);
  if (recurrence === 'monthly') d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().slice(0, 10);
}

const TaskInput = z.object({
  title: z.string().trim().min(1).max(300),
  description: z.string().max(20_000).default(''),
  projectId: z.string().nullish(),
  milestoneId: z.string().nullish(),
  parentId: z.string().nullish(),
  ownerId: z.string().nullish(),
  reviewerId: z.string().nullish(),
  status: Status.default('todo'),
  priority: Priority.default('medium'),
  dueDate: DateStr.nullish(),
  startDate: DateStr.nullish(),
  estimateHours: z.number().min(0).max(1000).nullish(),
  recurrence: z.enum(['daily', 'weekly', 'monthly']).nullish(),
  sourceMessageId: z.string().nullish(),
  meetingId: z.string().nullish(),
  collaboratorIds: z.array(z.string()).max(50).default([]),
});

export function tasksRouter(ctx: Ctx) {
  const r = Router();
  const { db } = ctx;

  /** Validate that a person may own a task in the given project (they must be able to see it). */
  const checkAssignee = (auth: Auth, userId: string | null | undefined, project: Row | null) => {
    if (!userId) return;
    const m = db.get(
      'SELECT role FROM memberships WHERE workspace_id = ? AND user_id = ? AND deactivated_at IS NULL',
      auth.workspaceId,
      userId,
    );
    if (!m) throw notFound('Person');
    if (project && (project.visibility === 'private' || m.role === 'guest') && !isProjectMember(db, project.id, userId)) {
      throw badRequest('That person is not a member of this project. Add them to the project first.');
    }
  };

  const createTask = (auth: Auth, body: z.infer<typeof TaskInput>) => {
    let project: Row | null = null;
    if (body.parentId) {
      const parent = loadTask(db, auth, body.parentId);
      body.projectId = parent.project_id;
    }
    if (body.projectId) {
      project = loadProject(db, auth, body.projectId);
      if (!canContributeProject(db, auth, project)) throw forbidden('You cannot add tasks to this project');
    } else if (isGuest(auth) && body.ownerId && body.ownerId !== auth.userId) {
      throw forbidden('Guests can only create personal tasks for themselves');
    }
    if (body.milestoneId && !db.get('SELECT 1 FROM milestones WHERE id = ? AND project_id = ?', body.milestoneId, body.projectId ?? '')) {
      throw badRequest('Milestone does not belong to this project');
    }
    const ownerId = body.ownerId === undefined ? auth.userId : body.ownerId;
    checkAssignee(auth, ownerId, project);
    checkAssignee(auth, body.reviewerId, project);
    if (body.sourceMessageId) {
      const message = db.get('SELECT * FROM messages WHERE id = ?', body.sourceMessageId);
      if (!message) throw notFound('Message');
      loadChannel(db, auth, message.channel_id);
    }
    if (body.meetingId) {
      const meeting = db.get('SELECT * FROM meetings WHERE id = ?', body.meetingId);
      if (!meeting || !canViewMeeting(db, auth, meeting)) throw notFound('Meeting');
    }
    const id = newId();
    const position = (db.get('SELECT MAX(position) AS p FROM tasks WHERE project_id IS ? AND status = ?', body.projectId ?? null, body.status)?.p ?? 0) + 1;
    db.transaction(() => {
      db.insert('tasks', {
        id,
        workspace_id: auth.workspaceId,
        project_id: body.projectId ?? null,
        milestone_id: body.milestoneId ?? null,
        parent_id: body.parentId ?? null,
        title: body.title,
        description: body.description,
        owner_id: ownerId ?? null,
        reviewer_id: body.reviewerId ?? null,
        status: body.status,
        priority: body.priority,
        due_date: body.dueDate ?? null,
        start_date: body.startDate ?? null,
        estimate_hours: body.estimateHours ?? null,
        recurrence: body.recurrence ?? null,
        position,
        source_message_id: body.sourceMessageId ?? null,
        meeting_id: body.meetingId ?? null,
        created_by: auth.userId,
        created_at: now(),
        updated_at: now(),
        completed_at: body.status === 'done' ? now() : null,
      });
      for (const c of body.collaboratorIds) {
        if (isActiveMember(db, auth.workspaceId, c)) db.run('INSERT OR IGNORE INTO task_collaborators (task_id, user_id) VALUES (?, ?)', id, c);
      }
      if (project) db.update('projects', project.id, { updated_at: now() });
    });
    recordActivity(ctx, auth.workspaceId, {
      actorId: auth.userId,
      verb: 'created',
      objectType: 'task',
      objectId: id,
      projectId: project?.id,
      summary: `created the task “${body.title}”`,
      link: `/tasks/${id}`,
    });
    const eventData = { id, title: body.title, project_id: body.projectId ?? null, owner_id: ownerId ?? null, status: body.status, priority: body.priority, due_date: body.dueDate ?? null };
    emitEvent(ctx, auth.workspaceId, 'task.created', eventData, { projectId: body.projectId });
    if (ownerId) emitEvent(ctx, auth.workspaceId, 'task.assigned', eventData, { projectId: body.projectId });
    if (ownerId && ownerId !== auth.userId) {
      notify(ctx, auth.workspaceId, {
        userId: ownerId,
        kind: 'assigned',
        title: `You were assigned “${body.title}”`,
        body: project ? `In ${project.name}${body.dueDate ? ` · due ${body.dueDate}` : ''}` : body.dueDate ? `Due ${body.dueDate}` : '',
        link: `/tasks/${id}`,
        actorId: auth.userId,
        urgent: body.priority === 'urgent',
      });
    }
    if (body.sourceMessageId) {
      const message = db.get('SELECT * FROM messages WHERE id = ?', body.sourceMessageId)!;
      ctx.hub.publish(auth.workspaceId, { type: 'message.updated', messageId: message.id, channelId: message.channel_id, parentId: message.parent_id });
    }
    runAutomations(ctx, 'task.created', db.get('SELECT * FROM tasks WHERE id = ?', id)!);
    publishTask(auth, id);
    return id;
  };

  const publishTask = (auth: Auth, taskId: string) => {
    const task = db.get('SELECT * FROM tasks WHERE id = ?', taskId);
    if (!task) return;
    ctx.hub.publish(auth.workspaceId, { type: 'task.updated', taskId, projectId: task.project_id }, (a) => canViewTask(db, a, task));
  };

  r.get('/tasks', (req, res) => {
    const auth = authOf(req);
    const q = parse(
      z.object({
        projectId: z.string().optional(),
        ownerId: z.string().optional(),
        status: Status.optional(),
        milestoneId: z.string().optional(),
        includeSubtasks: z.enum(['true', 'false']).default('false'),
      }),
      req.query,
    );
    const where: string[] = ['t.workspace_id = ?'];
    const params: string[] = [auth.workspaceId];
    if (q.projectId) {
      loadProject(db, auth, q.projectId);
      where.push('t.project_id = ?');
      params.push(q.projectId);
    }
    if (q.ownerId) {
      where.push('t.owner_id = ?');
      params.push(q.ownerId);
    }
    if (q.status) {
      where.push('t.status = ?');
      params.push(q.status);
    }
    if (q.milestoneId) {
      where.push('t.milestone_id = ?');
      params.push(q.milestoneId);
    }
    if (q.includeSubtasks === 'false') where.push('t.parent_id IS NULL');
    const rows = db
      .all(`SELECT t.* FROM tasks t WHERE ${where.join(' AND ')} ORDER BY t.position, t.created_at LIMIT 2000`, ...params)
      .filter((t) => canViewTask(db, auth, t));
    res.json(serializeTasks(db, rows));
  });

  /** "My work" (§5.2): today, upcoming, overdue, blocked, and assigned-for-review. */
  r.get('/my-work', (req, res) => {
    const auth = authOf(req);
    const t0 = today();
    const weekAhead = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
    const mine = db
      .all(
        `SELECT * FROM tasks WHERE workspace_id = ? AND (owner_id = ? OR reviewer_id = ?) AND (status != 'done' OR completed_at >= ?)
          ORDER BY due_date IS NULL, due_date, CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, created_at`,
        auth.workspaceId,
        auth.userId,
        auth.userId,
        new Date(Date.now() - 86_400_000).toISOString(),
      )
      .filter((t) => canViewTask(db, auth, t));
    const tasks = serializeTasks(db, mine);
    const owned = tasks.filter((t) => t.owner?.id === auth.userId);
    const open = owned.filter((t) => t.status !== 'done');
    res.json({
      overdue: open.filter((t) => t.due_date && t.due_date < t0),
      today: open.filter((t) => t.due_date === t0 && t.status !== 'blocked'),
      upcoming: open.filter((t) => t.due_date && t.due_date > t0 && t.due_date <= weekAhead && t.status !== 'blocked'),
      later: open.filter((t) => (!t.due_date || t.due_date > weekAhead) && t.status !== 'blocked'),
      blocked: open.filter((t) => t.status === 'blocked'),
      review: tasks.filter((t) => t.reviewer?.id === auth.userId && t.status === 'review'),
      done_recently: owned.filter((t) => t.status === 'done'),
    });
  });

  r.post('/tasks', (req, res) => {
    const auth = authOf(req);
    const id = createTask(auth, parse(TaskInput, req.body));
    res.status(201).json(serializeTasks(db, [db.get('SELECT * FROM tasks WHERE id = ?', id)!])[0]);
  });

  /** Convert a message into a task (§5.1). */
  r.post('/messages/:id/task', (req, res) => {
    const auth = authOf(req);
    const message = db.get('SELECT * FROM messages WHERE id = ?', req.params.id);
    if (!message || message.deleted_at) throw notFound('Message');
    const channel = loadChannel(db, auth, message.channel_id);
    const body = parse(TaskInput.partial({ title: true }), req.body);
    const plain = message.body.replace(/@\[([^\]]+)\]\([0-9a-f-]{36}\)/g, '@$1');
    const input = parse(TaskInput, {
      ...req.body,
      title: body.title ?? (plain.split('\n')[0].slice(0, 200) || 'Follow up'),
      projectId: body.projectId === undefined ? channel.project_id : body.projectId,
      description: body.description || `From a message in ${channel.kind === 'dm' ? 'a direct message' : `#${channel.name}`}:\n\n> ${plain}`,
      sourceMessageId: message.id,
    });
    const id = createTask(auth, input);
    res.status(201).json(serializeTasks(db, [db.get('SELECT * FROM tasks WHERE id = ?', id)!])[0]);
  });

  r.get('/tasks/:id', (req, res) => {
    const auth = authOf(req);
    const task = loadTask(db, auth, req.params.id);
    const [base] = serializeTasks(db, [task]);
    const checklist = db.all('SELECT * FROM checklist_items WHERE task_id = ? ORDER BY position, rowid', task.id);
    const comments = db.all(
      `SELECT c.*, u.name AS user_name, u.color AS user_color FROM task_comments c JOIN users u ON u.id = c.user_id WHERE task_id = ? ORDER BY created_at`,
      task.id,
    );
    const collaborators = db.all(
      `SELECT u.id, u.name, u.color FROM task_collaborators c JOIN users u ON u.id = c.user_id WHERE c.task_id = ?`,
      task.id,
    );
    const subtasks = serializeTasks(db, db.all('SELECT * FROM tasks WHERE parent_id = ? ORDER BY position, created_at', task.id));
    const dependsOn = db
      .all(`SELECT t.* FROM task_dependencies d JOIN tasks t ON t.id = d.depends_on_id WHERE d.task_id = ?`, task.id)
      .filter((t) => canViewTask(db, auth, t))
      .map((t) => ({ id: t.id, title: t.title, status: t.status }));
    const blocking = db
      .all(`SELECT t.* FROM task_dependencies d JOIN tasks t ON t.id = d.task_id WHERE d.depends_on_id = ?`, task.id)
      .filter((t) => canViewTask(db, auth, t))
      .map((t) => ({ id: t.id, title: t.title, status: t.status }));
    const activity = db.all(
      `SELECT a.*, u.name AS actor_name FROM activity a JOIN users u ON u.id = a.actor_id
        WHERE a.object_type = 'task' AND a.object_id = ? ORDER BY a.created_at DESC LIMIT 50`,
      task.id,
    );
    let source = null;
    if (task.source_message_id) {
      const m = db.get('SELECT m.id, m.channel_id, m.body, c.name AS channel_name, c.kind FROM messages m JOIN channels c ON c.id = m.channel_id WHERE m.id = ?', task.source_message_id);
      if (m) {
        try {
          loadChannel(db, auth, m.channel_id);
          source = m;
        } catch {
          source = null;
        }
      }
    }
    const meeting = task.meeting_id ? db.get('SELECT * FROM meetings WHERE id = ?', task.meeting_id) : null;
    const milestones = task.project_id ? db.all('SELECT id, name FROM milestones WHERE project_id = ? ORDER BY due_date', task.project_id) : [];
    const files = db.all(
      `SELECT f.id, f.name, f.external_url, v.mime, v.size FROM files f
         LEFT JOIN file_versions v ON v.file_id = f.id AND v.version = f.current_version
        WHERE f.task_id = ? AND f.archived_at IS NULL ORDER BY f.created_at`,
      task.id,
    );
    res.json({
      ...base,
      checklist,
      comments,
      collaborators,
      subtask_list: subtasks,
      depends_on: dependsOn,
      blocking,
      activity,
      source_message: source,
      meeting: meeting && canViewMeeting(db, auth, meeting) ? { id: meeting.id, title: meeting.title, starts_at: meeting.starts_at } : null,
      milestones,
      files,
      can_edit: canEditTask(db, auth, task),
      creator: userSummary(db, task.created_by),
    });
  });

  r.patch('/tasks/:id', (req, res) => {
    const auth = authOf(req);
    const task = loadTask(db, auth, req.params.id);
    if (!canEditTask(db, auth, task)) throw forbidden('You cannot edit this task');
    const body = parse(
      z.object({
        title: z.string().trim().min(1).max(300).optional(),
        description: z.string().max(20_000).optional(),
        ownerId: z.string().nullable().optional(),
        reviewerId: z.string().nullable().optional(),
        status: Status.optional(),
        priority: Priority.optional(),
        dueDate: DateStr.nullable().optional(),
        startDate: DateStr.nullable().optional(),
        estimateHours: z.number().min(0).max(1000).nullable().optional(),
        milestoneId: z.string().nullable().optional(),
        blockedReason: z.string().max(500).optional(),
        recurrence: z.enum(['daily', 'weekly', 'monthly']).nullable().optional(),
        position: z.number().optional(),
      }),
      req.body,
    );
    const project = task.project_id ? db.get('SELECT * FROM projects WHERE id = ?', task.project_id)! : null;
    if (body.ownerId !== undefined) checkAssignee(auth, body.ownerId, project);
    if (body.reviewerId !== undefined) checkAssignee(auth, body.reviewerId, project);
    if (body.milestoneId && !db.get('SELECT 1 FROM milestones WHERE id = ? AND project_id = ?', body.milestoneId, task.project_id ?? '')) {
      throw badRequest('Milestone does not belong to this project');
    }
    const statusChanged = body.status && body.status !== task.status;
    db.update('tasks', task.id, {
      title: body.title,
      description: body.description,
      owner_id: body.ownerId,
      reviewer_id: body.reviewerId,
      status: body.status,
      priority: body.priority,
      due_date: body.dueDate,
      start_date: body.startDate,
      estimate_hours: body.estimateHours,
      milestone_id: body.milestoneId,
      blocked_reason: body.blockedReason ?? (body.status && body.status !== 'blocked' ? '' : undefined),
      recurrence: body.recurrence,
      position: body.position,
      completed_at: statusChanged ? (body.status === 'done' ? now() : null) : undefined,
      updated_at: now(),
    });
    if (project) db.update('projects', project.id, { updated_at: now() });

    const actor = db.get('SELECT name FROM users WHERE id = ?', auth.userId)!;
    const link = `/tasks/${task.id}`;
    const fresh = db.get('SELECT * FROM tasks WHERE id = ?', task.id)!;
    const eventData = { id: task.id, title: fresh.title, project_id: fresh.project_id, owner_id: fresh.owner_id, status: fresh.status, previous_status: task.status, priority: fresh.priority, due_date: fresh.due_date };
    if (statusChanged) emitEvent(ctx, auth.workspaceId, 'task.status_changed', eventData, { projectId: task.project_id });
    if (body.ownerId && body.ownerId !== task.owner_id) emitEvent(ctx, auth.workspaceId, 'task.assigned', eventData, { projectId: task.project_id });
    if (statusChanged) {
      const label = body.status!.replace('_', ' ');
      recordActivity(ctx, auth.workspaceId, {
        actorId: auth.userId,
        verb: body.status === 'done' ? 'completed' : 'moved',
        objectType: 'task',
        objectId: task.id,
        projectId: task.project_id,
        summary: body.status === 'done' ? `completed “${task.title}”` : `moved “${task.title}” to ${label}`,
        link,
      });
      const watchers = new Set<string>([task.owner_id, task.created_by, ...db.all('SELECT user_id FROM task_collaborators WHERE task_id = ?', task.id).map((c) => c.user_id)].filter(Boolean));
      for (const userId of watchers) {
        notify(ctx, auth.workspaceId, { userId, kind: 'status', title: `${actor.name} moved “${task.title}” to ${label}`, link, actorId: auth.userId });
      }
      const reviewer = body.reviewerId ?? task.reviewer_id;
      if (body.status === 'review' && reviewer) {
        notify(ctx, auth.workspaceId, { userId: reviewer, kind: 'review', title: `“${task.title}” is ready for your review`, link, actorId: auth.userId });
      }
      if (body.status === 'done') {
        // Handoff: let owners of dependent tasks know they are unblocked.
        const dependents = db.all(
          `SELECT t.* FROM task_dependencies d JOIN tasks t ON t.id = d.task_id WHERE d.depends_on_id = ? AND t.status != 'done'`,
          task.id,
        );
        for (const dep of dependents) {
          if (dep.owner_id) notify(ctx, auth.workspaceId, { userId: dep.owner_id, kind: 'handoff', title: `“${task.title}” is done — “${dep.title}” can move forward`, link: `/tasks/${dep.id}`, actorId: auth.userId });
        }
        if (task.recurrence) {
          const nextId = newId();
          db.insert('tasks', {
            ...task,
            id: nextId,
            status: 'todo',
            due_date: nextDue(task.due_date, task.recurrence),
            completed_at: null,
            created_at: now(),
            updated_at: now(),
            source_message_id: null,
          });
        }
      }
    }
    if (body.ownerId && body.ownerId !== task.owner_id) {
      recordActivity(ctx, auth.workspaceId, {
        actorId: auth.userId,
        verb: 'assigned',
        objectType: 'task',
        objectId: task.id,
        projectId: task.project_id,
        summary: `assigned “${task.title}” to ${db.get('SELECT name FROM users WHERE id = ?', body.ownerId)!.name}`,
        link,
      });
      notify(ctx, auth.workspaceId, { userId: body.ownerId, kind: 'assigned', title: `${actor.name} assigned you “${task.title}”`, link, actorId: auth.userId });
    }
    if (body.dueDate !== undefined && body.dueDate !== task.due_date && task.owner_id) {
      notify(ctx, auth.workspaceId, { userId: task.owner_id, kind: 'status', title: `Due date for “${task.title}” changed to ${body.dueDate ?? 'none'}`, link, actorId: auth.userId });
    }
    if (statusChanged) runAutomations(ctx, 'task.status_changed', db.get('SELECT * FROM tasks WHERE id = ?', task.id)!, task.status);
    publishTask(auth, task.id);
    res.json(serializeTasks(db, [db.get('SELECT * FROM tasks WHERE id = ?', task.id)!])[0]);
  });

  r.delete('/tasks/:id', (req, res) => {
    const auth = authOf(req);
    const task = loadTask(db, auth, req.params.id);
    if (task.created_by !== auth.userId && task.owner_id !== auth.userId && !isAdmin(auth)) {
      const project = task.project_id ? db.get('SELECT * FROM projects WHERE id = ?', task.project_id) : null;
      if (!project || project.owner_id !== auth.userId) throw forbidden('Only the creator, owner, project owner or an admin can delete this task');
    }
    db.run('DELETE FROM tasks WHERE id = ?', task.id);
    ctx.hub.publish(auth.workspaceId, { type: 'task.updated', taskId: task.id, projectId: task.project_id, deleted: true });
    res.json({ ok: true });
  });

  // ----- Checklist, comments, collaborators, dependencies -----

  const editable = (auth: Auth, id: string) => {
    const task = loadTask(db, auth, id);
    if (!canEditTask(db, auth, task)) throw forbidden('You cannot edit this task');
    return task;
  };

  r.post('/tasks/:id/checklist', (req, res) => {
    const task = editable(authOf(req), req.params.id);
    const { text } = parse(z.object({ text: z.string().trim().min(1).max(300) }), req.body);
    const id = newId();
    const pos = (db.get('SELECT MAX(position) AS p FROM checklist_items WHERE task_id = ?', task.id)?.p ?? 0) + 1;
    db.insert('checklist_items', { id, task_id: task.id, text, position: pos });
    res.status(201).json(db.get('SELECT * FROM checklist_items WHERE id = ?', id));
  });

  r.patch('/checklist/:id', (req, res) => {
    const item = db.get('SELECT * FROM checklist_items WHERE id = ?', req.params.id);
    if (!item) throw notFound('Checklist item');
    editable(authOf(req), item.task_id);
    const body = parse(z.object({ text: z.string().trim().min(1).max(300).optional(), done: z.boolean().optional() }), req.body);
    db.update('checklist_items', item.id, { text: body.text, done: body.done });
    res.json(db.get('SELECT * FROM checklist_items WHERE id = ?', item.id));
  });

  r.delete('/checklist/:id', (req, res) => {
    const item = db.get('SELECT * FROM checklist_items WHERE id = ?', req.params.id);
    if (!item) throw notFound('Checklist item');
    editable(authOf(req), item.task_id);
    db.run('DELETE FROM checklist_items WHERE id = ?', item.id);
    res.json({ ok: true });
  });

  r.post('/tasks/:id/comments', (req, res) => {
    const auth = authOf(req);
    const task = loadTask(db, auth, req.params.id);
    const { body } = parse(z.object({ body: z.string().trim().min(1).max(5000) }), req.body);
    const id = newId();
    db.insert('task_comments', { id, task_id: task.id, user_id: auth.userId, body, created_at: now() });
    const actor = db.get('SELECT name FROM users WHERE id = ?', auth.userId)!;
    const people = new Set<string>([
      task.owner_id,
      task.created_by,
      task.reviewer_id,
      ...db.all('SELECT user_id FROM task_collaborators WHERE task_id = ?', task.id).map((c) => c.user_id),
      ...db.all('SELECT DISTINCT user_id FROM task_comments WHERE task_id = ?', task.id).map((c) => c.user_id),
    ].filter(Boolean));
    for (const userId of people) {
      notify(ctx, auth.workspaceId, { userId, kind: 'comment', title: `${actor.name} commented on “${task.title}”`, body, link: `/tasks/${task.id}`, actorId: auth.userId });
    }
    publishTask(auth, task.id);
    res.status(201).json(db.get('SELECT * FROM task_comments WHERE id = ?', id));
  });

  r.put('/tasks/:id/collaborators', (req, res) => {
    const auth = authOf(req);
    const task = editable(auth, req.params.id);
    const { userIds } = parse(z.object({ userIds: z.array(z.string()).max(50) }), req.body);
    const project = task.project_id ? db.get('SELECT * FROM projects WHERE id = ?', task.project_id)! : null;
    for (const u of userIds) checkAssignee(auth, u, project);
    db.transaction(() => {
      db.run('DELETE FROM task_collaborators WHERE task_id = ?', task.id);
      for (const u of userIds) db.run('INSERT OR IGNORE INTO task_collaborators (task_id, user_id) VALUES (?, ?)', task.id, u);
    });
    res.json({ ok: true });
  });

  r.post('/tasks/:id/dependencies', (req, res) => {
    const auth = authOf(req);
    const task = editable(auth, req.params.id);
    const { dependsOnId } = parse(z.object({ dependsOnId: z.string() }), req.body);
    if (dependsOnId === task.id) throw badRequest('A task cannot depend on itself');
    loadTask(db, auth, dependsOnId);
    // Reject cycles: walk the dependency graph from the prerequisite.
    const seen = new Set<string>();
    const stack = [dependsOnId];
    while (stack.length) {
      const current = stack.pop()!;
      if (current === task.id) throw badRequest('That would create a circular dependency');
      if (seen.has(current)) continue;
      seen.add(current);
      stack.push(...db.all('SELECT depends_on_id FROM task_dependencies WHERE task_id = ?', current).map((d) => d.depends_on_id));
    }
    db.run('INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_id) VALUES (?, ?)', task.id, dependsOnId);
    res.status(201).json({ ok: true });
  });

  r.delete('/tasks/:id/dependencies/:dependsOnId', (req, res) => {
    const task = editable(authOf(req), req.params.id);
    db.run('DELETE FROM task_dependencies WHERE task_id = ? AND depends_on_id = ?', task.id, req.params.dependsOnId);
    res.json({ ok: true });
  });

  /** Tasks visible to the user for dependency pickers. */
  r.get('/tasks-lookup', (req, res) => {
    const auth = authOf(req);
    const q = parse(z.object({ q: z.string().max(100).default('') }), req.query);
    const projects = accessibleProjectIds(db, auth);
    const rows = db
      .all(
        `SELECT * FROM tasks WHERE workspace_id = ? AND title LIKE ? ORDER BY updated_at DESC LIMIT 200`,
        auth.workspaceId,
        `%${q.q}%`,
      )
      .filter((t) => (t.project_id ? projects.includes(t.project_id) : canViewTask(db, auth, t)))
      .slice(0, 20);
    res.json(rows.map((t) => ({ id: t.id, title: t.title, status: t.status })));
  });

  return r;
}
