import { Router } from 'express';
import { z } from 'zod';
import { accessibleProjectIds, isAdmin, isGuest, type Auth } from '../access.js';
import { authOf, type Ctx } from '../context.js';
import type { Database, Row } from '../db.js';
import { hasFeature, requireFeature } from '../plans.js';
import { badRequest, forbidden, newId, notFound, now, parse, parseJson, parsePatch } from '../util.js';
import { listGoals } from './goals.js';

/**
 * Dashboards, as in Monday, Asana and ClickUp: a page of chart widgets over tasks, time and goals.
 * A dashboard can be shared with the workspace, but every number is computed for the person
 * looking at it, from the projects they can open, so sharing a dashboard never shares data.
 */

export const WIDGET_TYPES = ['number', 'status', 'priority', 'owner', 'label', 'field', 'trend', 'time', 'goals', 'projects', 'due', 'note'] as const;
export const METRICS = ['open', 'overdue', 'blocked', 'done_week', 'due_week', 'hours_week', 'field_sum'] as const;

const Widget = z.object({
  id: z.string().regex(/^[a-z0-9_-]{1,40}$/i),
  type: z.enum(WIDGET_TYPES),
  title: z.string().trim().max(80).default(''),
  size: z.enum(['half', 'full']).default('half'),
  chart: z.enum(['bar', 'donut']).optional(),
  projectIds: z.array(z.string().max(64)).max(50).default([]),
  metric: z.enum(METRICS).optional(),
  fieldId: z.string().max(64).optional(),
  weeks: z.number().int().min(2).max(26).optional(),
  text: z.string().max(4000).optional(),
});
type Widget = z.infer<typeof Widget>;

const STATUS = ['todo', 'in_progress', 'blocked', 'review', 'done'] as const;
const STATUS_LABEL: Record<string, string> = { todo: 'To do', in_progress: 'In progress', blocked: 'Blocked', review: 'In review', done: 'Done' };
const PRIORITY = ['urgent', 'high', 'medium', 'low'] as const;
const DAY = 86_400_000;

/** A starting layout so a new dashboard is useful straight away. */
const starter = (): Widget[] => [
  { id: 'w1', type: 'number', title: 'Open tasks', size: 'half', metric: 'open', projectIds: [] },
  { id: 'w2', type: 'number', title: 'Overdue', size: 'half', metric: 'overdue', projectIds: [] },
  { id: 'w3', type: 'number', title: 'Done this week', size: 'half', metric: 'done_week', projectIds: [] },
  { id: 'w4', type: 'number', title: 'Blocked', size: 'half', metric: 'blocked', projectIds: [] },
  { id: 'w5', type: 'status', title: 'Tasks by status', size: 'half', chart: 'donut', projectIds: [] },
  { id: 'w6', type: 'owner', title: 'Open tasks by owner', size: 'half', chart: 'bar', projectIds: [] },
  { id: 'w7', type: 'trend', title: 'Created and completed per week', size: 'full', weeks: 8, projectIds: [] },
  { id: 'w8', type: 'due', title: 'Due soon and overdue', size: 'half', projectIds: [] },
  { id: 'w9', type: 'projects', title: 'Projects', size: 'half', projectIds: [] },
];

const dateOnly = (d: Date) => d.toISOString().slice(0, 10);
const mondayOf = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7)));

/** Compute one widget's data for the viewer. `scope` is the projects this viewer may count. */
async function widgetData(ctx: Ctx, auth: Auth, w: Widget, visible: string[], cache: Map<string, Row[]>) {
  const { db } = ctx;
  if (w.type === 'note') return { kind: 'note' };
  const scope = w.projectIds.length ? w.projectIds.filter((id) => visible.includes(id)) : visible;
  const tasksIn = async () => {
    const key = scope.join(',');
    if (!cache.has(key)) {
      cache.set(
        key,
        scope.length
          ? await db.all(
              `SELECT t.id, t.title, t.status, t.priority, t.owner_id, t.due_date, t.created_at, t.completed_at, t.project_id, t.parent_id
                 FROM tasks t JOIN projects p ON p.id = t.project_id
                WHERE t.project_id IN (${scope.map(() => '?').join(',')}) AND p.archived_at IS NULL`,
              ...scope,
            )
          : [],
      );
    }
    return cache.get(key)!;
  };
  const today = dateOnly(new Date());
  const weekStart = mondayOf(new Date());
  const weekEnd = new Date(weekStart.getTime() + 7 * DAY);

  switch (w.type) {
    case 'number': {
      const tasks = await tasksIn();
      const open = tasks.filter((t) => t.status !== 'done');
      switch (w.metric ?? 'open') {
        case 'open':
          return { kind: 'number', value: open.length, unit: 'tasks' };
        case 'overdue':
          return { kind: 'number', value: open.filter((t) => t.due_date && t.due_date < today).length, unit: 'tasks', tone: 'bad' };
        case 'blocked':
          return { kind: 'number', value: open.filter((t) => t.status === 'blocked').length, unit: 'tasks', tone: 'warn' };
        case 'due_week':
          return { kind: 'number', value: open.filter((t) => t.due_date && t.due_date >= today && t.due_date < dateOnly(weekEnd)).length, unit: 'tasks' };
        case 'done_week':
          return { kind: 'number', value: tasks.filter((t) => t.completed_at && t.completed_at >= weekStart.toISOString()).length, unit: 'tasks', tone: 'good' };
        case 'hours_week': {
          if (!await hasFeature(ctx, auth.workspaceId, 'fields')) return { kind: 'locked', feature: 'fields' };
          const ids = tasks.map((t) => t.id);
          if (!ids.length) return { kind: 'number', value: 0, unit: 'hours' };
          const row = await db.get<{ m: number }>(
            `SELECT SUM(minutes) AS m FROM time_entries WHERE ended_at IS NOT NULL AND started_at >= ? AND task_id IN (${ids.map(() => '?').join(',')})`,
            weekStart.toISOString(),
            ...ids,
          );
          return { kind: 'number', value: Math.round(((Number(row?.m) || 0) / 60) * 10) / 10, unit: 'hours' };
        }
        case 'field_sum': {
          const field = await fieldIn(db, w.fieldId, scope);
          if (!field || field.type !== 'number') return { kind: 'empty', reason: 'Choose a number field from a project in this widget.' };
          const ids = tasks.filter((t) => t.project_id === field.project_id && t.status !== 'done').map((t) => t.id);
          const values = ids.length
            ? await db.all(`SELECT value FROM task_field_values WHERE field_id = ? AND task_id IN (${ids.map(() => '?').join(',')})`, field.id, ...ids)
            : [];
          const sum = values.reduce((s, v) => s + (Number(parseJson(v.value, 0)) || 0), 0);
          return { kind: 'number', value: Math.round(sum * 100) / 100, unit: field.name, note: 'open tasks' };
        }
      }
      return { kind: 'empty' };
    }
    case 'status': {
      const tasks = await tasksIn();
      return { kind: 'series', items: STATUS.map((s) => ({ key: s, label: STATUS_LABEL[s], value: tasks.filter((t) => t.status === s).length })) };
    }
    case 'priority': {
      const open = (await tasksIn()).filter((t) => t.status !== 'done');
      return { kind: 'series', items: PRIORITY.map((p) => ({ key: p, label: p[0].toUpperCase() + p.slice(1), value: open.filter((t) => t.priority === p).length })) };
    }
    case 'owner': {
      const open = (await tasksIn()).filter((t) => t.status !== 'done');
      const counts = new Map<string, number>();
      for (const t of open) counts.set(t.owner_id ?? '', (counts.get(t.owner_id ?? '') ?? 0) + 1);
      const ids = [...counts.keys()].filter(Boolean);
      const users = new Map(
        ids.length ? (await db.all(`SELECT id, name, color FROM users WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids)).map((u) => [u.id, u]) : [],
      );
      const items = [...counts.entries()]
        .map(([id, value]) => ({ key: id || 'none', label: id ? users.get(id)?.name ?? 'Former member' : 'Unassigned', color: id ? users.get(id)?.color : undefined, value }))
        .sort((a, b) => b.value - a.value)
        .slice(0, 12);
      return { kind: 'series', items };
    }
    case 'label': {
      const tasks = (await tasksIn()).filter((t) => t.status !== 'done');
      const ids = tasks.map((t) => t.id);
      const rows = ids.length
        ? await db.all(
            `SELECT l.id, l.name, l.color, COUNT(*) AS n FROM task_labels tl JOIN labels l ON l.id = tl.label_id
              WHERE tl.task_id IN (${ids.map(() => '?').join(',')}) GROUP BY l.id, l.name, l.color ORDER BY n DESC`,
            ...ids,
          )
        : [];
      return { kind: 'series', items: rows.slice(0, 12).map((r) => ({ key: r.id, label: r.name, color: r.color, value: Number(r.n) })) };
    }
    case 'field': {
      if (!await hasFeature(ctx, auth.workspaceId, 'fields')) return { kind: 'locked', feature: 'fields' };
      const field = await fieldIn(db, w.fieldId, scope);
      if (!field || field.type !== 'select') return { kind: 'empty', reason: 'Choose a dropdown field from a project in this widget.' };
      const ids = (await tasksIn()).filter((t) => t.project_id === field.project_id && t.status !== 'done').map((t) => t.id);
      const values = ids.length ? await db.all(`SELECT value FROM task_field_values WHERE field_id = ? AND task_id IN (${ids.map(() => '?').join(',')})`, field.id, ...ids) : [];
      const counts = new Map<string, number>();
      for (const v of values) {
        const label = String(parseJson(v.value, ''));
        counts.set(label, (counts.get(label) ?? 0) + 1);
      }
      const options = parseJson<{ label: string; color: string }[]>(field.options, []);
      const items: { key: string; label: string; color?: string; value: number }[] = options.map((o) => ({ key: o.label, label: o.label, color: o.color, value: counts.get(o.label) ?? 0 }));
      const unset = ids.length - values.length;
      if (unset > 0) items.push({ key: '', label: 'Not set', value: unset });
      return { kind: 'series', items, title: field.name };
    }
    case 'trend': {
      const tasks = await tasksIn();
      const weeks = w.weeks ?? 8;
      const first = new Date(weekStart.getTime() - (weeks - 1) * 7 * DAY);
      const buckets = Array.from({ length: weeks }, (_, i) => new Date(first.getTime() + i * 7 * DAY));
      const bucketOf = (iso: string | null) => {
        if (!iso) return -1;
        const i = Math.floor((Date.parse(iso) - first.getTime()) / (7 * DAY));
        return i >= 0 && i < weeks ? i : -1;
      };
      const created = new Array(weeks).fill(0);
      const completed = new Array(weeks).fill(0);
      for (const t of tasks) {
        const c = bucketOf(t.created_at);
        if (c >= 0) created[c] += 1;
        const d = bucketOf(t.completed_at);
        if (d >= 0) completed[d] += 1;
      }
      return {
        kind: 'trend',
        labels: buckets.map((b) => dateOnly(b)),
        series: [
          { key: 'created', label: 'Created', values: created },
          { key: 'completed', label: 'Completed', values: completed },
        ],
      };
    }
    case 'time': {
      if (!await hasFeature(ctx, auth.workspaceId, 'fields')) return { kind: 'locked', feature: 'fields' };
      const ids = (await tasksIn()).map((t) => t.id);
      const since = new Date(weekStart.getTime() - ((w.weeks ?? 4) - 1) * 7 * DAY).toISOString();
      const rows = ids.length
        ? await db.all(
            `SELECT u.id, u.name, u.color, SUM(e.minutes) AS m FROM time_entries e JOIN users u ON u.id = e.user_id
              WHERE e.ended_at IS NOT NULL AND e.started_at >= ? AND e.task_id IN (${ids.map(() => '?').join(',')})
              GROUP BY u.id, u.name, u.color ORDER BY m DESC`,
            since,
            ...ids,
          )
        : [];
      return { kind: 'series', unit: 'hours', items: rows.slice(0, 12).map((r) => ({ key: r.id, label: r.name, color: r.color, value: Math.round((Number(r.m) / 60) * 10) / 10 })) };
    }
    case 'goals': {
      if (isGuest(auth)) return { kind: 'empty', reason: 'Goals are not shared with guests.' };
      if (!await hasFeature(ctx, auth.workspaceId, 'goals')) return { kind: 'locked', feature: 'goals' };
      const goals = await listGoals(db, auth);
      const inScope = w.projectIds.length ? goals.filter((g) => g.projects.some((p) => scope.includes(p.id as string))) : goals;
      return {
        kind: 'list',
        items: inScope.slice(0, 10).map((g) => ({ id: g.id, title: g.title, link: `/goals/${g.id}`, progress: g.progress, status: g.status, owner: g.owner?.name ?? null })),
      };
    }
    case 'projects': {
      if (!scope.length) return { kind: 'list', items: [] };
      const rows = await db.all(
        `SELECT p.id, p.name, p.color, p.health, p.due_date,
                (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.parent_id IS NULL) AS total,
                (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.parent_id IS NULL AND t.status = 'done') AS done
           FROM projects p WHERE p.id IN (${scope.map(() => '?').join(',')}) AND p.archived_at IS NULL ORDER BY p.name`,
        ...scope,
      );
      return {
        kind: 'list',
        items: rows.slice(0, 12).map((p) => ({
          id: p.id,
          title: p.name,
          link: `/projects/${p.id}`,
          color: p.color,
          status: p.health,
          progress: Number(p.total) ? Number(p.done) / Number(p.total) : 0,
          detail: `${Number(p.done)}/${Number(p.total)} tasks done`,
        })),
      };
    }
    case 'due': {
      const soon = dateOnly(new Date(Date.now() + 7 * DAY));
      const tasks = (await tasksIn())
        .filter((t) => t.status !== 'done' && t.due_date && t.due_date <= soon)
        .sort((a, b) => (a.due_date < b.due_date ? -1 : 1))
        .slice(0, 10);
      const owners = new Map(
        tasks.length
          ? (await db.all(`SELECT id, name FROM users WHERE id IN (${tasks.map(() => '?').join(',')})`, ...tasks.map((t) => t.owner_id ?? ''))).map((u) => [u.id, u.name])
          : [],
      );
      return {
        kind: 'list',
        items: tasks.map((t) => ({ id: t.id, title: t.title, task: true, due_date: t.due_date, overdue: t.due_date < today, owner: owners.get(t.owner_id) ?? null, status: t.status })),
      };
    }
  }
  return { kind: 'empty' };
}

/** A custom field, only when it belongs to one of the widget's projects. */
async function fieldIn(db: Database, fieldId: string | undefined, scope: string[]) {
  if (!fieldId) return undefined;
  const field = await db.get('SELECT * FROM custom_fields WHERE id = ?', fieldId);
  return field && scope.includes(field.project_id) ? field : undefined;
}

export function dashboardsRouter(ctx: Ctx) {
  const r = Router();
  const { db } = ctx;

  const guard = async (auth: Auth) => {
    if (isGuest(auth)) throw forbidden('Guests cannot use dashboards');
    await requireFeature(ctx, auth.workspaceId, 'insights');
  };
  const canSee = (auth: Auth, d: Row) => d.visibility === 'workspace' || d.owner_id === auth.userId;
  const canEdit = (auth: Auth, d: Row) => d.owner_id === auth.userId || isAdmin(auth);
  const load = async (auth: Auth, id: string) => {
    const d = await db.get('SELECT * FROM dashboards WHERE id = ? AND workspace_id = ?', id, auth.workspaceId);
    if (!d || !canSee(auth, d)) throw notFound('Dashboard');
    return d;
  };
  const serialize = async (auth: Auth, d: Row) => ({
    id: d.id,
    name: d.name,
    description: d.description,
    visibility: d.visibility,
    owner: await db.get('SELECT id, name, color FROM users WHERE id = ?', d.owner_id),
    widgets: parseJson<Widget[]>(d.widgets, []),
    can_edit: canEdit(auth, d),
    updated_at: d.updated_at,
  });

  r.get('/dashboards', async (req, res) => {
    const auth = authOf(req);
    await guard(auth);
    const rows = await db.all(
      `SELECT d.id, d.name, d.description, d.visibility, d.owner_id, d.updated_at, u.name AS owner_name FROM dashboards d JOIN users u ON u.id = d.owner_id
        WHERE d.workspace_id = ? AND (d.visibility = 'workspace' OR d.owner_id = ?) ORDER BY d.name`,
      auth.workspaceId,
      auth.userId,
    );
    res.json(rows.map((d) => ({ ...d, can_edit: canEdit(auth, d) })));
  });

  const Body = z.object({
    name: z.string().trim().min(1).max(100),
    description: z.string().max(1000).default(''),
    visibility: z.enum(['private', 'workspace']).default('workspace'),
    widgets: z.array(Widget).max(24).optional(),
  });
  const checkWidgets = (widgets: Widget[]) => {
    if (new Set(widgets.map((w) => w.id)).size !== widgets.length) throw badRequest('Each widget needs its own id');
  };

  r.post('/dashboards', async (req, res) => {
    const auth = authOf(req);
    await guard(auth);
    const body = parse(Body, req.body);
    const widgets = body.widgets ?? starter();
    checkWidgets(widgets);
    const id = newId();
    await db.insert('dashboards', {
      id,
      workspace_id: auth.workspaceId,
      name: body.name,
      description: body.description,
      owner_id: auth.userId,
      visibility: body.visibility,
      widgets: JSON.stringify(widgets),
      created_at: now(),
      updated_at: now(),
    });
    res.status(201).json(await serialize(auth, (await db.get('SELECT * FROM dashboards WHERE id = ?', id))!));
  });

  r.get('/dashboards/:id', async (req, res) => {
    const auth = authOf(req);
    await guard(auth);
    res.json(await serialize(auth, await load(auth, req.params.id)));
  });

  r.patch('/dashboards/:id', async (req, res) => {
    const auth = authOf(req);
    await guard(auth);
    const d = await load(auth, req.params.id);
    if (!canEdit(auth, d)) throw forbidden('Only the dashboard’s owner or an admin can change it');
    const body = parsePatch(Body.partial(), req.body);
    if (body.widgets) checkWidgets(body.widgets);
    await db.update('dashboards', d.id, {
      name: body.name,
      description: body.description,
      visibility: body.visibility,
      widgets: body.widgets ? JSON.stringify(body.widgets) : undefined,
      updated_at: now(),
    });
    res.json(await serialize(auth, (await db.get('SELECT * FROM dashboards WHERE id = ?', d.id))!));
  });

  r.delete('/dashboards/:id', async (req, res) => {
    const auth = authOf(req);
    await guard(auth);
    const d = await load(auth, req.params.id);
    if (!canEdit(auth, d)) throw forbidden('Only the dashboard’s owner or an admin can delete it');
    await db.run('DELETE FROM dashboards WHERE id = ?', d.id);
    await db.run("DELETE FROM favorites WHERE kind = 'dashboard' AND object_id = ?", d.id);
    res.json({ ok: true });
  });

  /** Every widget's numbers, computed from what this viewer can open. */
  r.get('/dashboards/:id/data', async (req, res) => {
    const auth = authOf(req);
    await guard(auth);
    const d = await load(auth, req.params.id);
    const visible = await accessibleProjectIds(db, auth);
    const cache = new Map<string, Row[]>();
    const out: Record<string, unknown> = {};
    for (const w of parseJson<Widget[]>(d.widgets, [])) out[w.id] = await widgetData(ctx, auth, w, visible, cache);
    res.setHeader('Cache-Control', 'private, no-cache');
    res.json({ computed_at: now(), widgets: out });
  });

  return r;
}
