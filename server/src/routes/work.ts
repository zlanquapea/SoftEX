import { Router } from 'express';
import { z } from 'zod';
import { canEditTask, canManageProject, canViewTask, isActiveMember, isAdmin, isGuest, loadProject, loadTask, requireRole, type Auth } from '../access.js';
import { authOf, type Ctx } from '../context.js';
import type { Database, Row } from '../db.js';
import { requireFeature } from '../plans.js';
import { badRequest, filterAsync, forbidden, newId, notFound, now, parse, parseJson } from '../util.js';

/**
 * Work management on top of tasks, as in Monday, Asana and ClickUp:
 * - labels shared across the workspace,
 * - custom fields per project (text, number, date, select, person, checkbox, link),
 * - time tracking with a timer or manual entries.
 */

export const LABEL_COLORS = ['purple', 'blue', 'green', 'coral', 'gold', 'sky', 'mint', 'lilac', 'orange'] as const;
export const FIELD_TYPES = ['text', 'number', 'date', 'select', 'person', 'checkbox', 'url'] as const;
type FieldType = (typeof FIELD_TYPES)[number];

const Color = z.enum(LABEL_COLORS);
const DateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const SelectOption = z.object({ label: z.string().trim().min(1).max(60), color: Color.default('blue') });

/** Check a custom field value against its type; returns the value to store, or throws. */
export async function validateFieldValue(db: Database, workspaceId: string, field: Row, value: unknown): Promise<unknown> {
  const type = field.type as FieldType;
  const bad = (why: string) => badRequest(`${field.name}: ${why}`);
  switch (type) {
    case 'text':
      if (typeof value !== 'string' || value.length > 2000) throw bad('enter up to 2,000 characters');
      return value;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) throw bad('enter a number');
      return value;
    case 'date':
      if (typeof value !== 'string' || !DateStr.safeParse(value).success) throw bad('enter a date as YYYY-MM-DD');
      return value;
    case 'checkbox':
      if (typeof value !== 'boolean') throw bad('must be true or false');
      return value;
    case 'url': {
      if (typeof value !== 'string' || value.length > 2000) throw bad('enter a link');
      let u: URL;
      try {
        u = new URL(value);
      } catch {
        throw bad('enter a full link starting with https://');
      }
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw bad('only web links are allowed');
      return u.toString();
    }
    case 'select': {
      const options = parseJson<{ label: string }[]>(field.options, []);
      if (typeof value !== 'string' || !options.some((o) => o.label === value)) throw bad('choose one of the options');
      return value;
    }
    case 'person':
      if (typeof value !== 'string' || !await isActiveMember(db, workspaceId, value)) throw bad('choose someone in this workspace');
      return value;
    default:
      throw bad('unknown field type');
  }
}

/** Labels, custom field values and logged minutes for a batch of tasks (used by serializeTasks). */
export async function taskExtras(db: Database, taskIds: string[]) {
  const labels = new Map<string, { id: string; name: string; color: string }[]>();
  const fields = new Map<string, Record<string, unknown>>();
  const minutes = new Map<string, number>();
  if (!taskIds.length) return { labels, fields, minutes };
  const marks = taskIds.map(() => '?').join(',');
  for (const row of await db.all(
    `SELECT tl.task_id, l.id, l.name, l.color FROM task_labels tl JOIN labels l ON l.id = tl.label_id WHERE tl.task_id IN (${marks}) ORDER BY l.name`,
    ...taskIds,
  )) {
    labels.set(row.task_id, [...(labels.get(row.task_id) ?? []), { id: row.id, name: row.name, color: row.color }]);
  }
  for (const row of await db.all(`SELECT task_id, field_id, value FROM task_field_values WHERE task_id IN (${marks})`, ...taskIds)) {
    fields.set(row.task_id, { ...(fields.get(row.task_id) ?? {}), [row.field_id]: parseJson(row.value, null) });
  }
  for (const row of await db.all(`SELECT task_id, SUM(minutes) AS m FROM time_entries WHERE task_id IN (${marks}) AND ended_at IS NOT NULL GROUP BY task_id`, ...taskIds)) {
    minutes.set(row.task_id, Number(row.m) || 0);
  }
  return { labels, fields, minutes };
}

const fieldRow = (f: Row) => ({ id: f.id, project_id: f.project_id, name: f.name, type: f.type, options: parseJson(f.options, []), position: f.position });

export function workRouter(ctx: Ctx) {
  const r = Router();
  const { db } = ctx;

  // ---------- Labels ----------

  r.get('/labels', async (req, res) => {
    const auth = authOf(req);
    res.json(
      await db.all(
        `SELECT l.id, l.name, l.color, (SELECT COUNT(*) FROM task_labels tl WHERE tl.label_id = l.id) AS task_count
           FROM labels l WHERE l.workspace_id = ? ORDER BY l.name`,
        auth.workspaceId,
      ),
    );
  });

  r.post('/labels', async (req, res) => {
    const auth = authOf(req);
    if (isGuest(auth)) throw forbidden('Guests cannot create labels');
    const body = parse(z.object({ name: z.string().trim().min(1).max(40), color: Color.default('blue') }), req.body);
    const existing = await db.get('SELECT id, name, color FROM labels WHERE workspace_id = ? AND lower(name) = lower(?)', auth.workspaceId, body.name);
    if (existing) return res.json(existing);
    const id = newId();
    await db.insert('labels', { id, workspace_id: auth.workspaceId, name: body.name, color: body.color, created_at: now() });
    res.status(201).json({ id, name: body.name, color: body.color });
  });

  const loadLabel = async (auth: Auth, id: string) => {
    const label = await db.get('SELECT * FROM labels WHERE id = ? AND workspace_id = ?', id, auth.workspaceId);
    if (!label) throw notFound('Label');
    return label;
  };

  r.patch('/labels/:id', async (req, res) => {
    const auth = authOf(req);
    requireRole(auth, 'lead');
    const label = await loadLabel(auth, req.params.id);
    const body = parse(z.object({ name: z.string().trim().min(1).max(40).optional(), color: Color.optional() }), req.body);
    await db.run('UPDATE labels SET name = COALESCE(?, name), color = COALESCE(?, color) WHERE id = ?', body.name ?? null, body.color ?? null, label.id);
    res.json(await db.get('SELECT id, name, color FROM labels WHERE id = ?', label.id));
  });

  r.delete('/labels/:id', async (req, res) => {
    const auth = authOf(req);
    requireRole(auth, 'lead');
    const label = await loadLabel(auth, req.params.id);
    await db.run('DELETE FROM labels WHERE id = ?', label.id);
    res.json({ ok: true });
  });

  r.put('/tasks/:id/labels', async (req, res) => {
    const auth = authOf(req);
    const task = await loadTask(db, auth, req.params.id);
    if (!await canEditTask(db, auth, task)) throw forbidden('You cannot edit this task');
    const { labelIds } = parse(z.object({ labelIds: z.array(z.string()).max(20) }), req.body);
    const valid = labelIds.length
      ? (await db.all(`SELECT id FROM labels WHERE workspace_id = ? AND id IN (${labelIds.map(() => '?').join(',')})`, auth.workspaceId, ...labelIds)).map((l) => l.id as string)
      : [];
    await db.transaction(async () => {
      await db.run('DELETE FROM task_labels WHERE task_id = ?', task.id);
      for (const id of valid) await db.run('INSERT OR IGNORE INTO task_labels (task_id, label_id) VALUES (?, ?)', task.id, id);
    });
    await ctx.hub.publish(auth.workspaceId, { type: 'task.updated', taskId: task.id, projectId: task.project_id }, { kind: 'task', taskId: task.id });
    res.json((await taskExtras(db, [task.id])).labels.get(task.id) ?? []);
  });

  // ---------- Custom fields ----------

  r.get('/projects/:id/fields', async (req, res) => {
    const auth = authOf(req);
    const project = await loadProject(db, auth, req.params.id);
    res.json((await db.all('SELECT * FROM custom_fields WHERE project_id = ? ORDER BY position, created_at', project.id)).map(fieldRow));
  });

  const FieldInput = z.object({
    name: z.string().trim().min(1).max(60),
    type: z.enum(FIELD_TYPES),
    options: z.array(SelectOption).max(30).default([]),
  });

  r.post('/projects/:id/fields', async (req, res) => {
    const auth = authOf(req);
    const project = await loadProject(db, auth, req.params.id);
    if (!await canManageProject(db, auth, project)) throw forbidden('Only project leads can add fields');
    await requireFeature(ctx, auth.workspaceId, 'fields');
    const body = parse(FieldInput, req.body);
    if (body.type === 'select' && !body.options.length) throw badRequest('Add at least one option');
    const count = (await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM custom_fields WHERE project_id = ?', project.id))!.n;
    if (count >= 30) throw badRequest('A project can have up to 30 fields');
    const id = newId();
    await db.insert('custom_fields', {
      id,
      workspace_id: auth.workspaceId,
      project_id: project.id,
      name: body.name,
      type: body.type,
      options: body.type === 'select' ? body.options : [],
      position: count,
      created_at: now(),
    });
    res.status(201).json(fieldRow((await db.get('SELECT * FROM custom_fields WHERE id = ?', id))!));
  });

  const loadField = async (auth: Auth, id: string) => {
    const field = await db.get('SELECT * FROM custom_fields WHERE id = ? AND workspace_id = ?', id, auth.workspaceId);
    if (!field) throw notFound('Field');
    const project = await loadProject(db, auth, field.project_id);
    return { field, project };
  };

  r.patch('/fields/:id', async (req, res) => {
    const auth = authOf(req);
    const { field, project } = await loadField(auth, req.params.id);
    if (!await canManageProject(db, auth, project)) throw forbidden('Only project leads can change fields');
    const body = parse(FieldInput.pick({ name: true, options: true }).partial().extend({ position: z.number().int().min(0).max(100).optional() }), req.body);
    await db.update('custom_fields', field.id, {
      name: body.name,
      options: field.type === 'select' && body.options ? body.options : undefined,
      position: body.position,
    });
    res.json(fieldRow((await db.get('SELECT * FROM custom_fields WHERE id = ?', field.id))!));
  });

  r.delete('/fields/:id', async (req, res) => {
    const auth = authOf(req);
    const { field, project } = await loadField(auth, req.params.id);
    if (!await canManageProject(db, auth, project)) throw forbidden('Only project leads can remove fields');
    await db.run('DELETE FROM custom_fields WHERE id = ?', field.id);
    res.json({ ok: true });
  });

  r.put('/tasks/:id/fields/:fieldId', async (req, res) => {
    const auth = authOf(req);
    const task = await loadTask(db, auth, req.params.id);
    if (!await canEditTask(db, auth, task)) throw forbidden('You cannot edit this task');
    const field = await db.get('SELECT * FROM custom_fields WHERE id = ? AND project_id = ?', req.params.fieldId, task.project_id ?? '');
    if (!field) throw notFound('Field');
    await requireFeature(ctx, auth.workspaceId, 'fields');
    const { value } = parse(z.object({ value: z.unknown() }), req.body);
    if (value === null || value === '' || value === undefined) {
      await db.run('DELETE FROM task_field_values WHERE task_id = ? AND field_id = ?', task.id, field.id);
    } else {
      const stored = await validateFieldValue(db, auth.workspaceId, field, value);
      await db.run(
        'INSERT INTO task_field_values (task_id, field_id, value) VALUES (?, ?, ?) ON CONFLICT (task_id, field_id) DO UPDATE SET value = excluded.value',
        task.id,
        field.id,
        JSON.stringify(stored),
      );
    }
    await db.update('tasks', task.id, { updated_at: now() });
    await ctx.hub.publish(auth.workspaceId, { type: 'task.updated', taskId: task.id, projectId: task.project_id }, { kind: 'task', taskId: task.id });
    res.json({ ok: true, fields: (await taskExtras(db, [task.id])).fields.get(task.id) ?? {} });
  });

  // ---------- Time tracking ----------

  const entryRow = async (e: Row) => ({
    id: e.id,
    task_id: e.task_id,
    user: await db.get('SELECT id, name, color FROM users WHERE id = ?', e.user_id),
    started_at: e.started_at,
    ended_at: e.ended_at,
    minutes: e.ended_at ? e.minutes : Math.max(0, Math.round((Date.now() - Date.parse(e.started_at)) / 60_000)),
    running: !e.ended_at,
    note: e.note,
  });

  const stopRunning = async (userId: string) => {
    for (const e of await db.all('SELECT * FROM time_entries WHERE user_id = ? AND ended_at IS NULL', userId)) {
      const minutes = Math.max(1, Math.round((Date.now() - Date.parse(e.started_at)) / 60_000));
      await db.run('UPDATE time_entries SET ended_at = ?, minutes = ? WHERE id = ?', now(), Math.min(minutes, 24 * 60), e.id);
    }
  };

  r.get('/tasks/:id/time', async (req, res) => {
    const auth = authOf(req);
    const task = await loadTask(db, auth, req.params.id);
    const rows = await db.all('SELECT * FROM time_entries WHERE task_id = ? ORDER BY started_at DESC LIMIT 200', task.id);
    const entries = await Promise.all(rows.map(entryRow));
    res.json({
      entries,
      total_minutes: entries.reduce((sum, e) => sum + e.minutes, 0),
      running: entries.find((e) => e.running && e.user?.id === auth.userId) ?? null,
    });
  });

  const requireTimeAccess = async (auth: Auth, taskId: string) => {
    const task = await loadTask(db, auth, taskId);
    if (!await canEditTask(db, auth, task)) throw forbidden('You can only log time on tasks you work on');
    await requireFeature(ctx, auth.workspaceId, 'fields');
    return task;
  };

  r.post('/tasks/:id/time/start', async (req, res) => {
    const auth = authOf(req);
    const task = await requireTimeAccess(auth, req.params.id);
    // One timer at a time: starting a new one stops the old.
    await stopRunning(auth.userId);
    const id = newId();
    await db.insert('time_entries', { id, workspace_id: auth.workspaceId, task_id: task.id, user_id: auth.userId, started_at: now(), ended_at: null, minutes: 0, note: '', created_at: now() });
    res.status(201).json(await entryRow((await db.get('SELECT * FROM time_entries WHERE id = ?', id))!));
  });

  r.post('/time/stop', async (req, res) => {
    const auth = authOf(req);
    await stopRunning(auth.userId);
    res.json({ ok: true });
  });

  r.post('/tasks/:id/time', async (req, res) => {
    const auth = authOf(req);
    const task = await requireTimeAccess(auth, req.params.id);
    const body = parse(z.object({ minutes: z.number().int().min(1).max(24 * 60), date: DateStr.optional(), note: z.string().max(500).default('') }), req.body);
    const started = body.date ? `${body.date}T09:00:00.000Z` : new Date(Date.now() - body.minutes * 60_000).toISOString();
    const id = newId();
    await db.insert('time_entries', {
      id,
      workspace_id: auth.workspaceId,
      task_id: task.id,
      user_id: auth.userId,
      started_at: started,
      ended_at: new Date(Date.parse(started) + body.minutes * 60_000).toISOString(),
      minutes: body.minutes,
      note: body.note,
      created_at: now(),
    });
    res.status(201).json(await entryRow((await db.get('SELECT * FROM time_entries WHERE id = ?', id))!));
  });

  r.delete('/time/:id', async (req, res) => {
    const auth = authOf(req);
    const entry = await db.get('SELECT * FROM time_entries WHERE id = ? AND workspace_id = ?', req.params.id, auth.workspaceId);
    if (!entry) throw notFound('Time entry');
    if (entry.user_id !== auth.userId && !isAdmin(auth)) throw forbidden('You can only remove your own time');
    await db.run('DELETE FROM time_entries WHERE id = ?', entry.id);
    res.json({ ok: true });
  });

  /** My timesheet: a week of entries (Monday to Sunday) with daily totals. */
  r.get('/time/me', async (req, res) => {
    const auth = authOf(req);
    const q = parse(z.object({ week: DateStr.optional() }), req.query);
    const base = q.week ? new Date(`${q.week}T00:00:00Z`) : new Date();
    const monday = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() - ((base.getUTCDay() + 6) % 7)));
    const end = new Date(monday.getTime() + 7 * 86_400_000);
    const rows = await db.all(
      `SELECT e.*, t.title AS task_title, t.project_id FROM time_entries e JOIN tasks t ON t.id = e.task_id
        WHERE e.user_id = ? AND e.workspace_id = ? AND e.started_at >= ? AND e.started_at < ? ORDER BY e.started_at`,
      auth.userId,
      auth.workspaceId,
      monday.toISOString(),
      end.toISOString(),
    );
    const visible = await filterAsync(rows, async (e) => canViewTask(db, auth, (await db.get('SELECT * FROM tasks WHERE id = ?', e.task_id))!));
    const entries = await Promise.all(visible.map(async (e) => ({ ...(await entryRow(e)), task_title: e.task_title, project_id: e.project_id })));
    const days = Array.from({ length: 7 }, (_, i) => {
      const day = new Date(monday.getTime() + i * 86_400_000).toISOString().slice(0, 10);
      return { date: day, minutes: entries.filter((e) => e.started_at.slice(0, 10) === day).reduce((s, e) => s + e.minutes, 0) };
    });
    const running = await db.get('SELECT e.*, t.title AS task_title FROM time_entries e JOIN tasks t ON t.id = e.task_id WHERE e.user_id = ? AND e.ended_at IS NULL', auth.userId);
    res.json({
      week: monday.toISOString().slice(0, 10),
      entries,
      days,
      total_minutes: days.reduce((s, d) => s + d.minutes, 0),
      running: running ? { ...(await entryRow(running)), task_title: running.task_title } : null,
    });
  });

  /** Time logged on a project, per person and per task. */
  r.get('/projects/:id/time', async (req, res) => {
    const auth = authOf(req);
    const project = await loadProject(db, auth, req.params.id);
    const byPerson = await db.all(
      `SELECT u.id, u.name, u.color, SUM(e.minutes) AS minutes FROM time_entries e JOIN tasks t ON t.id = e.task_id JOIN users u ON u.id = e.user_id
        WHERE t.project_id = ? AND e.ended_at IS NOT NULL GROUP BY u.id, u.name, u.color ORDER BY minutes DESC`,
      project.id,
    );
    const byTask = await db.all(
      `SELECT t.id, t.title, t.estimate_hours, SUM(e.minutes) AS minutes FROM time_entries e JOIN tasks t ON t.id = e.task_id
        WHERE t.project_id = ? AND e.ended_at IS NOT NULL GROUP BY t.id, t.title, t.estimate_hours ORDER BY minutes DESC LIMIT 50`,
      project.id,
    );
    const visibleTasks = await filterAsync(byTask, async (t) => canViewTask(db, auth, (await db.get('SELECT * FROM tasks WHERE id = ?', t.id))!));
    res.json({
      total_minutes: byPerson.reduce((s, p) => s + Number(p.minutes), 0),
      by_person: byPerson.map((p) => ({ ...p, minutes: Number(p.minutes) })),
      by_task: visibleTasks.map((t) => ({ ...t, minutes: Number(t.minutes) })),
    });
  });

  return r;
}

