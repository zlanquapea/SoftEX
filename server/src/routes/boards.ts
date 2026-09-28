import { Router } from 'express';
import { z } from 'zod';
import { accessibleProjectIds, canContributeProject, canEditBoard, canViewBoard, isAdmin, isGuest, loadProject, type Auth } from '../access.js';
import { collabRouter, docKey, dropDoc } from '../collab.js';
import { authOf, recordActivity, type Ctx } from '../context.js';
import type { Row } from '../db.js';
import { forbidden, newId, notFound, now, parse, parsePatch } from '../util.js';

/**
 * Whiteboards (Miro, FigJam, Teams Whiteboard): an infinite canvas of sticky notes, shapes,
 * text, arrows and drawings that several people edit at once. The drawing itself lives in the
 * live-collaboration store; this router keeps the list of boards and who may open them.
 */
export function boardsRouter(ctx: Ctx) {
  const r = Router();
  const { db } = ctx;

  const load = async (auth: Auth, id: string) => {
    const board = await db.get('SELECT * FROM boards WHERE id = ?', id);
    if (!board || !await canViewBoard(db, auth, board)) throw notFound('Whiteboard');
    return board;
  };
  const serialize = async (auth: Auth, b: Row) => ({
    id: b.id,
    title: b.title,
    project: b.project_id ? await db.get('SELECT id, name, color FROM projects WHERE id = ?', b.project_id) : null,
    owner: await db.get('SELECT id, name, color FROM users WHERE id = ?', b.owner_id),
    can_edit: !b.archived_at && await canEditBoard(db, auth, b),
    can_delete: b.owner_id === auth.userId || isAdmin(auth),
    created_at: b.created_at,
    updated_at: b.updated_at,
    archived_at: b.archived_at,
  });

  r.get('/boards', async (req, res) => {
    const auth = authOf(req);
    const q = parse(z.object({ projectId: z.string().optional(), archived: z.enum(['true', 'false']).default('false') }), req.query);
    const visible = new Set(await accessibleProjectIds(db, auth));
    const rows = await db.all(
      `SELECT * FROM boards WHERE workspace_id = ? AND archived_at IS ${q.archived === 'true' ? 'NOT NULL' : 'NULL'} ${q.projectId ? 'AND project_id = ?' : ''} ORDER BY updated_at DESC`,
      auth.workspaceId,
      ...(q.projectId ? [q.projectId] : []),
    );
    const mine = rows.filter((b) => (b.project_id ? visible.has(b.project_id) : !isGuest(auth)));
    res.json(await Promise.all(mine.map((b) => serialize(auth, b))));
  });

  const Body = z.object({ title: z.string().trim().min(1).max(120), projectId: z.string().nullish() });

  const checkProject = async (auth: Auth, projectId: string | null | undefined) => {
    if (projectId) {
      if (!await canContributeProject(db, auth, await loadProject(db, auth, projectId))) throw forbidden('You cannot add whiteboards to this project');
    } else if (isGuest(auth)) {
      throw forbidden('Guests can only use whiteboards inside their projects');
    }
  };

  r.post('/boards', async (req, res) => {
    const auth = authOf(req);
    const body = parse(Body, req.body);
    await checkProject(auth, body.projectId);
    const id = newId();
    await db.insert('boards', { id, workspace_id: auth.workspaceId, project_id: body.projectId ?? null, title: body.title, owner_id: auth.userId, created_at: now(), updated_at: now() });
    await recordActivity(ctx, auth.workspaceId, {
      actorId: auth.userId,
      verb: 'created',
      objectType: 'board',
      objectId: id,
      projectId: body.projectId ?? null,
      summary: `started the whiteboard “${body.title}”`,
      link: `/boards/${id}`,
    });
    res.status(201).json(await serialize(auth, (await db.get('SELECT * FROM boards WHERE id = ?', id))!));
  });

  r.get('/boards/:id', async (req, res) => {
    const auth = authOf(req);
    res.json(await serialize(auth, await load(auth, req.params.id)));
  });

  r.patch('/boards/:id', async (req, res) => {
    const auth = authOf(req);
    const board = await load(auth, req.params.id);
    const body = parsePatch(Body.partial().extend({ archived: z.boolean().optional() }), req.body);
    if (body.archived !== undefined ? board.owner_id !== auth.userId && !isAdmin(auth) : !await canEditBoard(db, auth, board)) {
      throw forbidden('You cannot change this whiteboard');
    }
    if (body.projectId !== undefined) await checkProject(auth, body.projectId);
    await db.update('boards', board.id, {
      title: body.title,
      project_id: body.projectId === undefined ? undefined : body.projectId ?? null,
      archived_at: body.archived === undefined ? undefined : body.archived ? now() : null,
      updated_at: now(),
    });
    res.json(await serialize(auth, (await db.get('SELECT * FROM boards WHERE id = ?', board.id))!));
  });

  r.delete('/boards/:id', async (req, res) => {
    const auth = authOf(req);
    const board = await load(auth, req.params.id);
    if (board.owner_id !== auth.userId && !isAdmin(auth)) throw forbidden('Only the owner or an admin can delete a whiteboard');
    await db.run('DELETE FROM boards WHERE id = ?', board.id);
    await dropDoc(db, docKey('board', board.id));
    await db.run("DELETE FROM favorites WHERE kind = 'board' AND object_id = ?", board.id);
    res.json({ ok: true });
  });

  // Live drawing, plus a "last changed" time for the list (at most every half minute).
  r.use(
    collabRouter(ctx, async (_auth, board) => {
      if (Date.now() - Date.parse(board.updated_at) > 30_000) await db.run('UPDATE boards SET updated_at = ? WHERE id = ?', now(), board.id);
    }),
  );

  return r;
}
