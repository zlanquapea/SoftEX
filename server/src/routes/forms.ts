import { Router, type Request } from 'express';
import { z } from 'zod';
import { canManageProject, isActiveMember, isGuest, loadProject, type Auth } from '../access.js';
import { authOf, notify, recordActivity, type Ctx } from '../context.js';
import type { Row } from '../db.js';
import { hasFeature, requireFeature } from '../plans.js';
import { emitEvent } from '../webhooks.js';
import { HttpError, badRequest, forbidden, newId, notFound, now, parse, parsePatch, parseJson, randomToken } from '../util.js';
import { rateLimit } from './auth.js';
import { validateFieldValue } from './work.js';

/**
 * Intake forms (Monday/Asana/ClickUp forms): a project publishes a form, and every
 * response becomes a task there. Forms are either for workspace members only or open to
 * anyone with the link (for clients and the public); open forms are rate limited and
 * carry a hidden "honeypot" field that bots fill in.
 */

const QuestionType = z.enum(['short', 'long', 'email', 'number', 'date', 'select']);
const Question = z.object({
  id: z.string().regex(/^[a-z0-9_-]{1,40}$/i),
  label: z.string().trim().min(1).max(200),
  type: QuestionType,
  required: z.boolean().default(false),
  options: z.array(z.string().trim().min(1).max(100)).max(30).default([]),
  // Where the answer goes on the task: its title, description, due date, priority, or a custom field id.
  maps: z.string().max(60).nullish(),
});
type Question = z.infer<typeof Question>;

const FormInput = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(5000).default(''),
  questions: z.array(Question).min(1).max(40),
  public: z.boolean().default(false),
  ownerId: z.string().nullish(),
});

/** Turn validated answers into a task in the form's project. */
async function submitFormResponse(ctx: Ctx, form: Row, answers: Record<string, unknown>, submittedBy: string | null, submitterLabel: string) {
  const { db } = ctx;
  if (form.closed) throw new HttpError(410, 'This form is no longer accepting responses');
  if (!await hasFeature(ctx, form.workspace_id, 'goals')) throw new HttpError(410, 'This form is not accepting responses right now');
  const questions = parseJson<Question[]>(form.fields, []);
  const task: Row = { title: '', description: '', due_date: null, priority: 'medium' };
  const lines: string[] = [];
  const fieldValues: [Row, unknown][] = [];
  for (const q of questions) {
    const raw = answers[q.id];
    const value = typeof raw === 'string' ? raw.trim() : raw;
    if (value === undefined || value === null || value === '') {
      if (q.required) throw badRequest(`Please answer “${q.label}”`);
      continue;
    }
    let clean: string | number;
    switch (q.type) {
      case 'short':
      case 'long':
        if (typeof value !== 'string' || value.length > (q.type === 'short' ? 300 : 5000)) throw badRequest(`“${q.label}” is too long`);
        clean = value;
        break;
      case 'email':
        if (typeof value !== 'string' || !z.string().email().max(200).safeParse(value).success) throw badRequest(`“${q.label}” needs an email address`);
        clean = value;
        break;
      case 'number': {
        const n = typeof value === 'number' ? value : Number(value);
        if (!Number.isFinite(n)) throw badRequest(`“${q.label}” needs a number`);
        clean = n;
        break;
      }
      case 'date':
        if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw badRequest(`“${q.label}” needs a date`);
        clean = value;
        break;
      case 'select':
        if (typeof value !== 'string' || !q.options.includes(value)) throw badRequest(`Choose an option for “${q.label}”`);
        clean = value;
        break;
    }
    lines.push(`**${q.label}**\n${String(clean)}`);
    if (q.maps === 'title') task.title = String(clean).slice(0, 300);
    else if (q.maps === 'description') task.description = String(clean);
    else if (q.maps === 'due_date' && q.type === 'date') task.due_date = clean;
    else if (q.maps === 'priority') {
      const p = String(clean).toLowerCase();
      if (['low', 'medium', 'high', 'urgent'].includes(p)) task.priority = p;
    } else if (q.maps) {
      const field = await db.get('SELECT * FROM custom_fields WHERE id = ? AND project_id = ?', q.maps, form.project_id);
      if (field) fieldValues.push([field, clean]);
    }
  }
  const title = task.title || `${form.title}: response from ${submitterLabel}`;
  const description = [task.description, `---\n*Submitted through the form “${form.title}” by ${submitterLabel}.*`, ...lines].filter(Boolean).join('\n\n');
  const id = newId();
  const creator = submittedBy ?? form.created_by;
  await db.transaction(async () => {
    const position = ((await db.get('SELECT MAX(position) AS p FROM tasks WHERE project_id = ? AND status = ?', form.project_id, 'todo'))?.p ?? 0) + 1;
    await db.insert('tasks', {
      id,
      workspace_id: form.workspace_id,
      project_id: form.project_id,
      title,
      description: description.slice(0, 20_000),
      owner_id: form.owner_id,
      status: 'todo',
      priority: task.priority,
      due_date: task.due_date,
      position,
      created_by: creator,
      created_at: now(),
      updated_at: now(),
      form_id: form.id,
    });
    for (const [field, value] of fieldValues) {
      try {
        const stored = await validateFieldValue(db, form.workspace_id, field, value);
        await db.run('INSERT INTO task_field_values (task_id, field_id, value) VALUES (?, ?, ?)', id, field.id, JSON.stringify(stored));
      } catch {
        /* an answer that doesn't fit the field stays in the description */
      }
    }
  });
  await recordActivity(ctx, form.workspace_id, {
    actorId: creator,
    verb: 'created',
    objectType: 'task',
    objectId: id,
    projectId: form.project_id,
    summary: `received a response to “${form.title}”`,
    link: `/tasks/${id}`,
  });
  if (form.owner_id && form.owner_id !== submittedBy) {
    await notify(ctx, form.workspace_id, { userId: form.owner_id, kind: 'assigned', title: `New response to “${form.title}”`, body: title, link: `/tasks/${id}`, actorId: submittedBy ?? undefined });
  }
  await emitEvent(ctx, form.workspace_id, 'task.created', { id, title, project_id: form.project_id, owner_id: form.owner_id, status: 'todo', priority: task.priority, due_date: task.due_date }, { projectId: form.project_id });
  await ctx.hub.publish(form.workspace_id, { type: 'task.updated', taskId: id, projectId: form.project_id }, { kind: 'task', taskId: id });
  return id;
  }

export function formsRouter(ctx: Ctx) {
  const r = Router();
  const { db } = ctx;

  const serialize = async (form: Row, withLink: boolean) => ({
    id: form.id,
    project_id: form.project_id,
    title: form.title,
    description: form.description,
    questions: parseJson<Question[]>(form.fields, []),
    public: !!form.public_token,
    public_url: withLink && form.public_token ? `${ctx.config.publicUrl}/f/${form.public_token}` : null,
    owner: form.owner_id ? await db.get('SELECT id, name, color FROM users WHERE id = ?', form.owner_id) : null,
    closed: !!form.closed,
    responses: (await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM tasks WHERE form_id = ?', form.id))!.n,
    created_at: form.created_at,
  });

  const checkMappings = async (projectId: string, questions: Question[]) => {
    const fields = new Set((await db.all('SELECT id FROM custom_fields WHERE project_id = ?', projectId)).map((f) => f.id as string));
    const ids = new Set<string>();
    for (const q of questions) {
      if (ids.has(q.id)) throw badRequest('Each question needs its own id');
      ids.add(q.id);
      if (q.type === 'select' && !q.options.length) throw badRequest(`“${q.label}” needs options to choose from`);
      if (q.maps && !['title', 'description', 'due_date', 'priority'].includes(q.maps) && !fields.has(q.maps)) throw badRequest(`“${q.label}” maps to an unknown field`);
    }
  };

  r.get('/projects/:id/forms', async (req, res) => {
    const auth = authOf(req);
    const project = await loadProject(db, auth, req.params.id);
    const manage = await canManageProject(db, auth, project);
    const rows = await db.all('SELECT * FROM forms WHERE project_id = ? ORDER BY created_at DESC', project.id);
    res.json(await Promise.all(rows.map((f) => serialize(f, manage))));
  });

  r.post('/projects/:id/forms', async (req, res) => {
    const auth = authOf(req);
    const project = await loadProject(db, auth, req.params.id);
    if (!await canManageProject(db, auth, project)) throw forbidden('Only project leads can create forms');
    await requireFeature(ctx, auth.workspaceId, 'goals');
    const body = parse(FormInput, req.body);
    await checkMappings(project.id, body.questions);
    if (body.ownerId && !await isActiveMember(db, auth.workspaceId, body.ownerId)) throw badRequest('The assignee must be in this workspace');
    const id = newId();
    await db.insert('forms', {
      id,
      workspace_id: auth.workspaceId,
      project_id: project.id,
      title: body.title,
      description: body.description,
      fields: body.questions,
      public_token: body.public ? randomToken() : null,
      owner_id: body.ownerId ?? auth.userId,
      closed: 0,
      created_by: auth.userId,
      created_at: now(),
    });
    res.status(201).json(await serialize((await db.get('SELECT * FROM forms WHERE id = ?', id))!, true));
  });

  const loadForm = async (auth: Auth, id: string) => {
    const form = await db.get('SELECT * FROM forms WHERE id = ? AND workspace_id = ?', id, auth.workspaceId);
    if (!form) throw notFound('Form');
    const project = await loadProject(db, auth, form.project_id);
    return { form, project };
  };

  r.get('/forms/:id', async (req, res) => {
    const auth = authOf(req);
    if (isGuest(auth)) throw notFound('Form');
    const form = await db.get('SELECT * FROM forms WHERE id = ? AND workspace_id = ?', req.params.id, auth.workspaceId);
    if (!form) throw notFound('Form');
    const project = await db.get('SELECT * FROM projects WHERE id = ?', form.project_id);
    const manage = !!project && await canManageProject(db, auth, project);
    res.json({ ...(await serialize(form, manage)), project: project ? { id: project.id, name: project.name } : null, can_manage: manage });
  });

  r.patch('/forms/:id', async (req, res) => {
    const auth = authOf(req);
    const { form, project } = await loadForm(auth, req.params.id);
    if (!await canManageProject(db, auth, project)) throw forbidden('Only project leads can change forms');
    const body = parsePatch(FormInput.partial().extend({ closed: z.boolean().optional(), newLink: z.boolean().optional() }), req.body);
    if (body.questions) await checkMappings(project.id, body.questions);
    if (body.ownerId && !await isActiveMember(db, auth.workspaceId, body.ownerId)) throw badRequest('The assignee must be in this workspace');
    let token: string | null | undefined;
    if (body.public === false) token = null;
    else if ((body.public === true && !form.public_token) || (body.newLink && form.public_token)) token = randomToken();
    await db.update('forms', form.id, {
      title: body.title,
      description: body.description,
      fields: body.questions,
      owner_id: body.ownerId,
      closed: body.closed === undefined ? undefined : body.closed ? 1 : 0,
      public_token: token,
    });
    res.json(await serialize((await db.get('SELECT * FROM forms WHERE id = ?', form.id))!, true));
  });

  r.delete('/forms/:id', async (req, res) => {
    const auth = authOf(req);
    const { form, project } = await loadForm(auth, req.params.id);
    if (!await canManageProject(db, auth, project)) throw forbidden('Only project leads can delete forms');
    await db.run('DELETE FROM forms WHERE id = ?', form.id);
    res.json({ ok: true });
  });

  // Members fill in a form from inside Küü.
  r.post('/forms/:id/responses', async (req, res) => {
    const auth = authOf(req);
    if (isGuest(auth)) throw notFound('Form');
    const form = await db.get('SELECT * FROM forms WHERE id = ? AND workspace_id = ?', req.params.id, auth.workspaceId);
    if (!form) throw notFound('Form');
    const { answers } = parse(z.object({ answers: z.record(z.string(), z.unknown()) }), req.body);
    const me = (await db.get('SELECT name FROM users WHERE id = ?', auth.userId))!;
    const taskId = await submitFormResponse(ctx, form, answers, auth.userId, me.name);
    res.status(201).json({ ok: true, taskId });
  });

  return r;
}

/** Forms open to anyone with the link (no sign-in). */
export function publicFormsRouter(ctx: Ctx) {
  const r = Router();
  const { db } = ctx;
  const load = async (token: string) => {
    const form = await db.get(
      `SELECT f.*, w.name AS workspace_name FROM forms f JOIN workspaces w ON w.id = f.workspace_id
        WHERE f.public_token = ? AND w.suspended_at IS NULL`,
      token,
    );
    if (!form) throw notFound('Form');
    return form;
  };

  r.get('/public/forms/:token', async (req, res) => {
    const form = await load(String(req.params.token));
    res.json({
      title: form.title,
      description: form.description,
      workspace_name: form.workspace_name,
      questions: parseJson<Question[]>(form.fields, []).map(({ maps: _maps, ...q }) => q),
      closed: !!form.closed || !(await hasFeature(ctx, form.workspace_id, 'goals')),
    });
  });

  r.post('/public/forms/:token', async (req: Request, res) => {
    const form = await load(String(req.params.token));
    const body = parse(
      z.object({ answers: z.record(z.string(), z.unknown()), name: z.string().trim().max(100).default(''), email: z.string().trim().max(200).default(''), website: z.string().optional() }),
      req.body,
    );
    // Bots fill in every field, including this hidden one; pretend it worked.
    if (body.website) return res.status(201).json({ ok: true });
    await rateLimit(ctx, `form:${form.id}:${req.ip}`, 10, 60 * 60_000);
    await rateLimit(ctx, `form:${form.id}`, 300, 60 * 60_000);
    const label = [body.name, body.email && z.string().email().safeParse(body.email).success ? `<${body.email}>` : ''].filter(Boolean).join(' ') || 'someone outside the workspace';
    await submitFormResponse(ctx, form, body.answers, null, label);
    // The task id is internal; the person filling in the form only needs to know it arrived.
    res.status(201).json({ ok: true });
  });

  return r;
}
