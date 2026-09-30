import { Router } from 'express';
import { z } from 'zod';
import { accessibleProjectIds, isAdmin, isActiveMember, isGuest, type Auth } from '../access.js';
import { authOf, notify, recordActivity, type Ctx } from '../context.js';
import type { Database, Row } from '../db.js';
import { requireFeature, hasFeature } from '../plans.js';
import { badRequest, forbidden, newId, notFound, now, parse, parsePatch } from '../util.js';

/**
 * Goals and key results (OKRs), as in Asana Goals, Monday and ClickUp: what the team is
 * aiming for, who owns it, and how far along it is. A key result is either a number
 * moved by hand ("sign 20 clients") or the share of done tasks in a project.
 */

const DateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const GoalStatus = z.enum(['on_track', 'at_risk', 'off_track', 'done']);

/** Goal progress and serialization, shared by the goals API and dashboards. */
function goalTools(db: Database) {
  const canEditGoal = (auth: Auth, goal: Row) => goal.owner_id === auth.userId || goal.created_by === auth.userId || isAdmin(auth);

  /** Progress of one key result, 0–1. */
  const krProgress = async (kr: Row) => {
    if (kr.kind === 'tasks' && kr.project_id) {
      const t = (await db.get<{ total: number; done: number }>(
        `SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done FROM tasks WHERE project_id = ? AND parent_id IS NULL`,
        kr.project_id,
      ))!;
      const total = Number(t.total) || 0;
      return { progress: total ? (Number(t.done) || 0) / total : 0, current: Number(t.done) || 0, target: total };
    }
    const span = kr.target_value - kr.start_value;
    const progress = span === 0 ? (kr.current_value >= kr.target_value ? 1 : 0) : (kr.current_value - kr.start_value) / span;
    return { progress: Math.max(0, Math.min(1, progress)), current: kr.current_value, target: kr.target_value };
  };

  const serialize = async (auth: Auth, goal: Row, visible: Set<string>) => {
    const krs = await db.all('SELECT * FROM key_results WHERE goal_id = ? ORDER BY position, id', goal.id);
    const keyResults = await Promise.all(
      krs.map(async (kr) => {
        const p = await krProgress(kr);
        const project = kr.project_id && visible.has(kr.project_id) ? await db.get('SELECT id, name, color FROM projects WHERE id = ?', kr.project_id) : null;
        return {
          id: kr.id,
          title: kr.title,
          kind: kr.kind,
          start_value: kr.start_value,
          target_value: kr.kind === 'tasks' ? p.target : kr.target_value,
          current_value: kr.kind === 'tasks' ? p.current : kr.current_value,
          unit: kr.unit,
          project,
          progress: p.progress,
        };
      }),
    );
    const projects = (await db.all('SELECT p.id, p.name, p.color, p.health FROM goal_projects gp JOIN projects p ON p.id = gp.project_id WHERE gp.goal_id = ?', goal.id)).filter((p) =>
      visible.has(p.id),
    );
    let progress = 0;
    if (goal.status === 'done') progress = 1;
    else if (keyResults.length) progress = keyResults.reduce((s, k) => s + k.progress, 0) / keyResults.length;
    else if (projects.length) {
      const ratios = await Promise.all(projects.map(async (p) => (await krProgress({ kind: 'tasks', project_id: p.id })).progress));
      progress = ratios.reduce((s, x) => s + x, 0) / ratios.length;
    }
    return {
      id: goal.id,
      parent_id: goal.parent_id,
      title: goal.title,
      description: goal.description,
      owner: await db.get('SELECT id, name, color FROM users WHERE id = ?', goal.owner_id),
      due_date: goal.due_date,
      status: goal.status,
      progress,
      key_results: keyResults,
      projects,
      can_edit: canEditGoal(auth, goal),
      created_at: goal.created_at,
      updated_at: goal.updated_at,
      archived_at: goal.archived_at,
    };
  };
  return { canEditGoal, krProgress, serialize };
}

/** Active goals as the viewer sees them (for dashboards). */
export async function listGoals(db: Database, auth: Auth) {
  const { serialize } = goalTools(db);
  const visible = new Set(await accessibleProjectIds(db, auth));
  const rows = await db.all('SELECT * FROM goals WHERE workspace_id = ? AND archived_at IS NULL ORDER BY due_date IS NULL, due_date, created_at', auth.workspaceId);
  return Promise.all(rows.map((g) => serialize(auth, g, visible)));
}

export function goalsRouter(ctx: Ctx) {
  const r = Router();
  const { db } = ctx;

  /** Guests never see goals. After a downgrade, existing goals stay readable (and can be deleted); creating and changing them needs the plan. */
  const guard = async (auth: Auth, changing = true) => {
    if (isGuest(auth)) throw forbidden('Guests cannot see goals');
    if (changing) await requireFeature(ctx, auth.workspaceId, 'goals');
  };

  const loadGoal = async (auth: Auth, id: string) => {
    const goal = await db.get('SELECT * FROM goals WHERE id = ? AND workspace_id = ?', id, auth.workspaceId);
    if (!goal) throw notFound('Goal');
    return goal;
  };

  const { canEditGoal, serialize } = goalTools(db);

  r.get('/goals', async (req, res) => {
    const auth = authOf(req);
    await guard(auth, false);
    const q = parse(z.object({ archived: z.enum(['true', 'false']).default('false') }), req.query);
    const visible = new Set(await accessibleProjectIds(db, auth));
    const rows = await db.all(
      `SELECT * FROM goals WHERE workspace_id = ? AND archived_at IS ${q.archived === 'true' ? 'NOT NULL' : 'NULL'} ORDER BY due_date IS NULL, due_date, created_at`,
      auth.workspaceId,
    );
    const entitled = await hasFeature(ctx, auth.workspaceId, 'goals');
    res.json((await Promise.all(rows.map((g) => serialize(auth, g, visible)))).map((g) => ({ ...g, can_edit: g.can_edit && entitled })));
  });

  r.get('/goals/:id', async (req, res) => {
    const auth = authOf(req);
    await guard(auth, false);
    const goal = await loadGoal(auth, req.params.id);
    const out = await serialize(auth, goal, new Set(await accessibleProjectIds(db, auth)));
    res.json({ ...out, can_edit: out.can_edit && (await hasFeature(ctx, auth.workspaceId, 'goals')) });
  });

  const GoalInput = z.object({
    title: z.string().trim().min(1).max(200),
    description: z.string().max(5000).default(''),
    ownerId: z.string().optional(),
    dueDate: DateStr.nullish(),
    parentId: z.string().nullish(),
    projectIds: z.array(z.string()).max(20).default([]),
  });

  const checkProjects = async (auth: Auth, ids: string[]) => {
    const visible = new Set(await accessibleProjectIds(db, auth));
    if (ids.some((id) => !visible.has(id))) throw forbidden('You can only link projects you can see');
  };

  r.post('/goals', async (req, res) => {
    const auth = authOf(req);
    await guard(auth);
    const body = parse(GoalInput, req.body);
    const ownerId = body.ownerId ?? auth.userId;
    if (!await isActiveMember(db, auth.workspaceId, ownerId)) throw badRequest('The owner must be in this workspace');
    if (body.parentId) await loadGoal(auth, body.parentId);
    await checkProjects(auth, body.projectIds);
    const id = newId();
    await db.transaction(async () => {
      await db.insert('goals', {
        id,
        workspace_id: auth.workspaceId,
        parent_id: body.parentId ?? null,
        title: body.title,
        description: body.description,
        owner_id: ownerId,
        due_date: body.dueDate ?? null,
        status: 'on_track',
        created_by: auth.userId,
        created_at: now(),
        updated_at: now(),
      });
      for (const p of body.projectIds) await db.run('INSERT OR IGNORE INTO goal_projects (goal_id, project_id) VALUES (?, ?)', id, p);
    });
    await recordActivity(ctx, auth.workspaceId, { actorId: auth.userId, verb: 'created', objectType: 'goal', objectId: id, summary: `set the goal “${body.title}”`, link: `/goals/${id}` });
    if (ownerId !== auth.userId) {
      await notify(ctx, auth.workspaceId, { userId: ownerId, kind: 'assigned', title: `You own the goal “${body.title}”`, link: `/goals/${id}`, actorId: auth.userId });
    }
    res.status(201).json(await serialize(auth, (await db.get('SELECT * FROM goals WHERE id = ?', id))!, new Set(await accessibleProjectIds(db, auth))));
  });

  r.patch('/goals/:id', async (req, res) => {
    const auth = authOf(req);
    await guard(auth);
    const goal = await loadGoal(auth, req.params.id);
    if (!canEditGoal(auth, goal)) throw forbidden('Only the goal’s owner or an admin can change it');
    const body = parsePatch(GoalInput.partial().extend({ status: GoalStatus.optional(), archived: z.boolean().optional() }), req.body);
    if (body.ownerId && !await isActiveMember(db, auth.workspaceId, body.ownerId)) throw badRequest('The owner must be in this workspace');
    if (body.parentId) {
      if (body.parentId === goal.id) throw badRequest('A goal can’t be its own parent');
      // Refuse cycles: walk up from the new parent.
      let cursor: string | null = body.parentId;
      for (let i = 0; cursor && i < 50; i++) {
        if (cursor === goal.id) throw badRequest('That would put the goal inside itself');
        cursor = ((await db.get('SELECT parent_id FROM goals WHERE id = ? AND workspace_id = ?', cursor, auth.workspaceId)) as Row | undefined)?.parent_id ?? null;
      }
    }
    if (body.projectIds) await checkProjects(auth, body.projectIds);
    await db.transaction(async () => {
      await db.update('goals', goal.id, {
        title: body.title,
        description: body.description,
        owner_id: body.ownerId,
        due_date: body.dueDate,
        parent_id: body.parentId,
        status: body.status,
        archived_at: body.archived === undefined ? undefined : body.archived ? now() : null,
        updated_at: now(),
      });
      if (body.projectIds) {
        await db.run('DELETE FROM goal_projects WHERE goal_id = ?', goal.id);
        for (const p of body.projectIds) await db.run('INSERT OR IGNORE INTO goal_projects (goal_id, project_id) VALUES (?, ?)', goal.id, p);
      }
    });
    res.json(await serialize(auth, (await db.get('SELECT * FROM goals WHERE id = ?', goal.id))!, new Set(await accessibleProjectIds(db, auth))));
  });

  r.delete('/goals/:id', async (req, res) => {
    const auth = authOf(req);
    await guard(auth, false);
    const goal = await loadGoal(auth, req.params.id);
    if (!canEditGoal(auth, goal)) throw forbidden('Only the goal’s owner or an admin can delete it');
    await db.run('DELETE FROM goals WHERE id = ?', goal.id);
    res.json({ ok: true });
  });

  const KrInput = z.object({
    title: z.string().trim().min(1).max(200),
    kind: z.enum(['number', 'tasks']).default('number'),
    startValue: z.number().finite().default(0),
    targetValue: z.number().finite().default(100),
    currentValue: z.number().finite().optional(),
    unit: z.string().max(20).default(''),
    projectId: z.string().nullish(),
  });

  r.post('/goals/:id/key-results', async (req, res) => {
    const auth = authOf(req);
    await guard(auth);
    const goal = await loadGoal(auth, req.params.id);
    if (!canEditGoal(auth, goal)) throw forbidden('Only the goal’s owner or an admin can change it');
    const body = parse(KrInput, req.body);
    if (body.kind === 'tasks') {
      if (!body.projectId) throw badRequest('Choose the project whose tasks measure this result');
      await checkProjects(auth, [body.projectId]);
    }
    const count = (await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM key_results WHERE goal_id = ?', goal.id))!.n;
    const id = newId();
    await db.insert('key_results', {
      id,
      goal_id: goal.id,
      title: body.title,
      kind: body.kind,
      start_value: body.startValue,
      target_value: body.targetValue,
      current_value: body.currentValue ?? body.startValue,
      unit: body.unit,
      project_id: body.kind === 'tasks' ? body.projectId : null,
      position: count,
    });
    await db.update('goals', goal.id, { updated_at: now() });
    res.status(201).json(await serialize(auth, (await db.get('SELECT * FROM goals WHERE id = ?', goal.id))!, new Set(await accessibleProjectIds(db, auth))));
  });

  const loadKr = async (auth: Auth, id: string) => {
    const kr = await db.get('SELECT k.*, g.workspace_id FROM key_results k JOIN goals g ON g.id = k.goal_id WHERE k.id = ?', id);
    if (!kr || kr.workspace_id !== auth.workspaceId) throw notFound('Key result');
    return { kr, goal: await loadGoal(auth, kr.goal_id) };
  };

  r.patch('/key-results/:id', async (req, res) => {
    const auth = authOf(req);
    await guard(auth);
    const { kr, goal } = await loadKr(auth, req.params.id);
    // Anyone on the team may record progress; changing the definition is for the owner.
    const body = parsePatch(KrInput.omit({ kind: true, projectId: true }).partial(), req.body);
    const definitionChange = body.title !== undefined || body.startValue !== undefined || body.targetValue !== undefined || body.unit !== undefined;
    if (definitionChange && !canEditGoal(auth, goal)) throw forbidden('Only the goal’s owner or an admin can change key results');
    await db.update('key_results', kr.id, {
      title: body.title,
      start_value: body.startValue,
      target_value: body.targetValue,
      current_value: body.currentValue,
      unit: body.unit,
    });
    await db.update('goals', goal.id, { updated_at: now() });
    res.json(await serialize(auth, (await db.get('SELECT * FROM goals WHERE id = ?', goal.id))!, new Set(await accessibleProjectIds(db, auth))));
  });

  r.delete('/key-results/:id', async (req, res) => {
    const auth = authOf(req);
    await guard(auth, false);
    const { kr, goal } = await loadKr(auth, req.params.id);
    if (!canEditGoal(auth, goal)) throw forbidden('Only the goal’s owner or an admin can change key results');
    await db.run('DELETE FROM key_results WHERE id = ?', kr.id);
    res.json({ ok: true });
  });

  return r;
}
