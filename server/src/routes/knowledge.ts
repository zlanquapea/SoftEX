import { Router } from 'express';
import multer from 'multer';
import { mkdirSync, unlinkSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { z } from 'zod';
import {
  accessibleChannelIds,
  accessibleProjectIds,
  canContributeProject,
  canEditTask,
  canPostChannel,
  canViewFile,
  canViewPage,
  isAdmin,
  isGuest,
  loadChannel,
  loadProject,
  loadTask,
  type Auth,
} from '../access.js';
import type { Row } from '../db.js';
import { extractText } from '../extract.js';
import { scanUpload } from '../scanner.js';
import { audit, authOf, notify, recordActivity, userSummary, type Ctx } from '../context.js';
import { emitEvent } from '../webhooks.js';
import { HttpError, badRequest, forbidden, newId, notFound, now, parse, today, filterAsync } from '../util.js';
import { requireStorage } from '../plans.js';

const DateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD');

const INLINE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.csv': 'text/plain; charset=utf-8',
  // Video and audio play in the browser (messages show a player).
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wav': 'audio/wav',
};

/**
 * Parse a single-range "Range: bytes=…" header against a file size. Returns the byte range,
 * 'invalid' when it can't be satisfied, or null for no (or an unsupported multi-) range.
 */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | 'invalid' | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  let start: number;
  let end: number;
  if (m[1] === '' && m[2] === '') return 'invalid';
  if (m[1] === '') {
    // Suffix range: the last N bytes.
    const n = Number(m[2]);
    if (n === 0) return 'invalid';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return 'invalid';
  return { start, end };
}
export function knowledgeRouter(ctx: Ctx) {
  const r = Router();
  const { db } = ctx;
  mkdirSync(ctx.config.uploadDir, { recursive: true });
  const incomingDir = resolve(ctx.config.uploadDir, 'incoming');
  const upload = multer({ dest: incomingDir, limits: { fileSize: ctx.config.maxUploadBytes, files: 1 } });
  /** Multer picks a random temporary name; still, only ever touch files inside the incoming folder. */
  const tempPath = (file: Express.Multer.File) => {
    const path = resolve(file.path);
    if (!path.startsWith(incomingDir + sep)) throw badRequest('Invalid upload');
    return path;
  };

  // ======================= Knowledge pages =======================

  const loadPage = async (auth: Auth, id: string) => {
    const page = await db.get('SELECT * FROM pages WHERE id = ?', id);
    if (!page || !await canViewPage(db, auth, page)) throw notFound('Page');
    return page;
  };

  const canEditPage = async (auth: Auth, page: Row) => {
    if (page.project_id) return canContributeProject(db, auth, (await db.get('SELECT * FROM projects WHERE id = ?', page.project_id))!);
    return !isGuest(auth);
  };

  const pageSummary = async (p: Row) => ({
    id: p.id,
    title: p.title,
    status: p.status,
    project_id: p.project_id,
    project_name: p.project_name ?? null,
    review_date: p.review_date,
    needs_review: !!p.review_date && p.review_date <= today(),
    version: p.version,
    owner: await userSummary(db, p.owner_id),
    updated_at: p.updated_at,
    updated_by: await userSummary(db, p.updated_by),
    excerpt: p.body.replace(/[#*_>`[\]()-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 180),
    archived_at: p.archived_at,
  });

  r.get('/pages', async (req, res) => {
    const auth = authOf(req);
    const q = parse(z.object({ projectId: z.string().optional(), archived: z.enum(['true', 'false']).default('false') }), req.query);
    if (q.projectId) await loadProject(db, auth, q.projectId);
    const rows = (await filterAsync((await db
      .all(
        `SELECT p.*, pr.name AS project_name FROM pages p LEFT JOIN projects pr ON pr.id = p.project_id
          WHERE p.workspace_id = ? ${q.projectId ? 'AND p.project_id = ?' : ''} AND p.archived_at IS ${q.archived === 'true' ? 'NOT NULL' : 'NULL'}
          ORDER BY p.updated_at DESC`,
        ...(q.projectId ? [auth.workspaceId, q.projectId] : [auth.workspaceId]),
      )), (p) => canViewPage(db, auth, p)));
    res.json((await Promise.all(rows.map(pageSummary))));
  });

  const PageBody = z.object({
    title: z.string().trim().min(1).max(200),
    body: z.string().max(200_000).default(''),
    projectId: z.string().nullish(),
    reviewDate: DateStr.nullish(),
    status: z.enum(['draft', 'approved']).default('draft'),
    ownerId: z.string().optional(),
  });

  r.post('/pages', async (req, res) => {
    const auth = authOf(req);
    const body = parse(PageBody, req.body);
    if (body.projectId) {
      const project = await loadProject(db, auth, body.projectId);
      if (!await canContributeProject(db, auth, project)) throw forbidden();
    } else if (isGuest(auth)) {
      throw forbidden('Guests can only create pages inside shared projects');
    }
    const id = newId();
    await db.insert('pages', {
      id,
      workspace_id: auth.workspaceId,
      project_id: body.projectId ?? null,
      title: body.title,
      body: body.body,
      status: body.status,
      owner_id: auth.userId,
      review_date: body.reviewDate ?? null,
      created_at: now(),
      updated_at: now(),
      updated_by: auth.userId,
    });
    await db.insert('page_versions', { id: newId(), page_id: id, version: 1, title: body.title, body: body.body, edited_by: auth.userId, created_at: now() });
    await recordActivity(ctx, auth.workspaceId, {
      actorId: auth.userId,
      verb: 'created',
      objectType: 'page',
      objectId: id,
      projectId: body.projectId,
      summary: `created the page “${body.title}”`,
      link: `/knowledge/${id}`,
    });
    res.status(201).json(await pageSummary((await db.get('SELECT * FROM pages WHERE id = ?', id))!));
  });

  r.get('/pages/:id', async (req, res) => {
    const auth = authOf(req);
    const page = await loadPage(auth, req.params.id);
    const project = page.project_id ? await db.get('SELECT id, name, color FROM projects WHERE id = ?', page.project_id) : null;
    const versions = await db.all(
      `SELECT v.version, v.title, v.created_at, u.name AS edited_by_name FROM page_versions v JOIN users u ON u.id = v.edited_by
        WHERE page_id = ? ORDER BY version DESC`,
      page.id,
    );
    // Related discussions: messages that link to this page in channels the reader can see.
    const channels = await accessibleChannelIds(db, auth);
    const discussions = channels.length
      ? await db.all(
          `SELECT m.id, m.body, m.created_at, m.channel_id, c.name AS channel_name, u.name AS user_name FROM messages m
             JOIN channels c ON c.id = m.channel_id JOIN users u ON u.id = m.user_id
            WHERE instr(m.body, ?) > 0 AND m.deleted_at IS NULL AND m.channel_id IN (${channels.map(() => '?').join(',')})
            ORDER BY m.created_at DESC LIMIT 10`,
          `/knowledge/${page.id}`,
          ...channels,
        )
      : [];
    res.json({ ...await pageSummary(page), body: page.body, project, versions, discussions, can_edit: await canEditPage(auth, page) });
  });

  r.patch('/pages/:id', async (req, res) => {
    const auth = authOf(req);
    const page = await loadPage(auth, req.params.id);
    if (!await canEditPage(auth, page)) throw forbidden('You cannot edit this page');
    const body = parse(PageBody.partial().extend({ reviewDate: DateStr.nullable().optional(), projectId: z.string().nullable().optional() }), req.body);
    if (body.projectId) {
      const project = await loadProject(db, auth, body.projectId);
      if (!await canContributeProject(db, auth, project)) throw forbidden();
    }
    if (body.ownerId && !await db.get('SELECT 1 FROM memberships WHERE workspace_id = ? AND user_id = ? AND deactivated_at IS NULL', auth.workspaceId, body.ownerId)) {
      throw notFound('Person');
    }
    const contentChanged = (body.title !== undefined && body.title !== page.title) || (body.body !== undefined && body.body !== page.body);
    const version = contentChanged ? page.version + 1 : page.version;
    await db.transaction(async () => {
      await db.update('pages', page.id, {
        title: body.title,
        body: body.body,
        status: body.status,
        review_date: body.reviewDate,
        project_id: body.projectId,
        owner_id: body.ownerId,
        version,
        updated_at: now(),
        updated_by: auth.userId,
      });
      if (contentChanged) {
        await db.insert('page_versions', {
          id: newId(),
          page_id: page.id,
          version,
          title: body.title ?? page.title,
          body: body.body ?? page.body,
          edited_by: auth.userId,
          created_at: now(),
        });
      }
    });
    if (contentChanged || body.status) {
      await recordActivity(ctx, auth.workspaceId, {
        actorId: auth.userId,
        verb: body.status === 'approved' && page.status !== 'approved' ? 'approved' : 'updated',
        objectType: 'page',
        objectId: page.id,
        projectId: body.projectId === undefined ? page.project_id : body.projectId,
        summary: `${body.status === 'approved' && page.status !== 'approved' ? 'approved' : 'updated'} the page “${body.title ?? page.title}”`,
        link: `/knowledge/${page.id}`,
      });
      if (page.owner_id !== auth.userId) {
        await notify(ctx, auth.workspaceId, { userId: page.owner_id, kind: 'page', title: `“${page.title}” was updated`, link: `/knowledge/${page.id}`, actorId: auth.userId });
      }
    }
    res.json(await pageSummary((await db.get('SELECT * FROM pages WHERE id = ?', page.id))!));
  });

  r.get('/pages/:id/versions/:version', async (req, res) => {
    const auth = authOf(req);
    const page = await loadPage(auth, req.params.id);
    const v = await db.get('SELECT * FROM page_versions WHERE page_id = ? AND version = ?', page.id, Number(req.params.version));
    if (!v) throw notFound('Version');
    res.json(v);
  });

  r.post('/pages/:id/restore-version', async (req, res) => {
    const auth = authOf(req);
    const page = await loadPage(auth, req.params.id);
    if (!await canEditPage(auth, page)) throw forbidden();
    const { version } = parse(z.object({ version: z.number().int() }), req.body);
    const v = await db.get('SELECT * FROM page_versions WHERE page_id = ? AND version = ?', page.id, version);
    if (!v) throw notFound('Version');
    const next = page.version + 1;
    await db.update('pages', page.id, { title: v.title, body: v.body, version: next, updated_at: now(), updated_by: auth.userId });
    await db.insert('page_versions', { id: newId(), page_id: page.id, version: next, title: v.title, body: v.body, edited_by: auth.userId, created_at: now() });
    res.json({ ok: true, version: next });
  });

  r.post('/pages/:id/archive', async (req, res) => {
    const auth = authOf(req);
    const page = await loadPage(auth, req.params.id);
    if (page.owner_id !== auth.userId && !isAdmin(auth)) throw forbidden('Only the page owner or an admin can archive it');
    const { archived } = parse(z.object({ archived: z.boolean().default(true) }), req.body ?? {});
    await db.update('pages', page.id, { archived_at: archived ? now() : null });
    await audit(ctx, auth.workspaceId, auth.userId, archived ? 'page.archived' : 'page.restored', 'page', page.id, { title: page.title });
    res.json({ ok: true });
  });

  // ======================= Files =======================

  const loadFile = async (auth: Auth, id: string) => {
    const file = await db.get('SELECT * FROM files WHERE id = ?', id);
    if (!file || !await canViewFile(db, auth, file)) throw notFound('File');
    return file;
  };

  /** Where a new file may be placed, checked against the uploader's rights. */
  const checkPlacement = async (auth: Auth, target: { projectId?: string | null; channelId?: string | null; taskId?: string | null }) => {
    let projectId = target.projectId ?? null;
    if (target.taskId) {
      const task = await loadTask(db, auth, target.taskId);
      if (!await canEditTask(db, auth, task)) throw forbidden('You cannot attach files to this task');
      projectId = task.project_id;
    }
    if (projectId) {
      const project = await loadProject(db, auth, projectId);
      if (!await canContributeProject(db, auth, project)) throw forbidden('You cannot add files to this project');
    }
    if (target.channelId) {
      const channel = await loadChannel(db, auth, target.channelId);
      if (!await canPostChannel(db, auth, channel) && channel.kind !== 'announcement') throw forbidden('You cannot share files here');
    }
    return projectId;
  };

  const fileSummary = async (f: Row) => {
    const v = await db.get('SELECT mime, size FROM file_versions WHERE file_id = ? AND version = ?', f.id, f.current_version);
    return {
      id: f.id,
      name: f.name,
      label: f.label,
      external_url: f.external_url,
      project_id: f.project_id,
      channel_id: f.channel_id,
      task_id: f.task_id,
      version: f.current_version,
      mime: v?.mime ?? null,
      size: v?.size ?? null,
      owner: await userSummary(db, f.owner_id),
      created_at: f.created_at,
      updated_at: f.updated_at,
      archived_at: f.archived_at,
    };
  };

  const storeUpload = async (auth: Auth, file: Express.Multer.File) => {
    try {
      await requireStorage(ctx, auth.workspaceId, file.size);
    } catch (e) {
      unlinkSync(tempPath(file));
      throw e;
    }
    try {
      await scanUpload(ctx.config, tempPath(file), file.originalname);
    } catch (e) {
      unlinkSync(tempPath(file));
      await audit(ctx, auth.workspaceId, auth.userId, 'file.upload_rejected', 'file', 'n/a', { name: file.originalname, reason: (e as Error).message });
      throw e;
    }
    const key = newId();
    const text = await extractText(tempPath(file), file.originalname);
    const ext = extname(file.originalname).toLowerCase();
    const mime = INLINE_TYPES[ext]?.split(';')[0] ?? (file.mimetype || 'application/octet-stream');
    await ctx.files.put(key, tempPath(file), mime);
    return { key, mime, size: file.size, text };
  };

  r.post('/files', upload.single('file'), async (req, res) => {
    const auth = authOf(req);
    if (!req.file) throw badRequest('Attach a file');
    const body = parse(
      z.object({ projectId: z.string().optional(), channelId: z.string().optional(), taskId: z.string().optional(), label: z.string().max(60).default('') }),
      req.body,
    );
    let projectId: string | null;
    try {
      projectId = await checkPlacement(auth, body);
    } catch (e) {
      unlinkSync(tempPath(req.file));
      throw e;
    }
    const stored = await storeUpload(auth, req.file);
    const id = newId();
    const name = req.file.originalname.slice(0, 200);
    await db.transaction(async () => {
      await db.insert('files', {
        id,
        workspace_id: auth.workspaceId,
        project_id: projectId,
        channel_id: body.channelId ?? null,
        task_id: body.taskId ?? null,
        owner_id: auth.userId,
        name,
        label: body.label,
        content_text: stored.text,
        created_at: now(),
        updated_at: now(),
      });
      await db.insert('file_versions', { id: newId(), file_id: id, version: 1, storage_key: stored.key, mime: stored.mime, size: stored.size, uploaded_by: auth.userId, created_at: now() });
    });
    await emitEvent(ctx, auth.workspaceId, 'document.version_added', { file_id: id, name, version: 1, project_id: projectId, channel_id: body.channelId ?? null }, { projectId, channelId: body.channelId });
    if (projectId || !body.channelId) {
      await recordActivity(ctx, auth.workspaceId, {
        actorId: auth.userId,
        verb: 'shared',
        objectType: 'file',
        objectId: id,
        projectId,
        summary: `shared the file ${name}`,
        link: `/files/${id}`,
      });
    }
    res.status(201).json(await fileSummary((await db.get('SELECT * FROM files WHERE id = ?', id))!));
  });

  r.post('/files/link', async (req, res) => {
    const auth = authOf(req);
    const body = parse(
      z.object({
        name: z.string().trim().min(1).max(200),
        url: z.string().url().refine((u) => /^https?:\/\//i.test(u), 'must be an http(s) link'),
        projectId: z.string().nullish(),
        channelId: z.string().nullish(),
        taskId: z.string().nullish(),
        label: z.string().max(60).default(''),
      }),
      req.body,
    );
    const projectId = await checkPlacement(auth, body);
    if (!projectId && isGuest(auth) && !body.channelId) throw forbidden();
    const id = newId();
    await db.insert('files', {
      id,
      workspace_id: auth.workspaceId,
      project_id: projectId,
      channel_id: body.channelId ?? null,
      task_id: body.taskId ?? null,
      owner_id: auth.userId,
      name: body.name,
      label: body.label,
      external_url: body.url,
      current_version: 0,
      created_at: now(),
      updated_at: now(),
    });
    await recordActivity(ctx, auth.workspaceId, { actorId: auth.userId, verb: 'linked', objectType: 'file', objectId: id, projectId, summary: `linked ${body.name}`, link: `/files/${id}` });
    res.status(201).json(await fileSummary((await db.get('SELECT * FROM files WHERE id = ?', id))!));
  });

  r.get('/files', async (req, res) => {
    const auth = authOf(req);
    const q = parse(z.object({ projectId: z.string().optional(), archived: z.enum(['true', 'false']).default('false') }), req.query);
    if (q.projectId) await loadProject(db, auth, q.projectId);
    const projects = new Set(await accessibleProjectIds(db, auth));
    const rows = (await filterAsync((await db
      .all(
        `SELECT * FROM files WHERE workspace_id = ? ${q.projectId ? 'AND project_id = ?' : ''} AND archived_at IS ${q.archived === 'true' ? 'NOT NULL' : 'NULL'}
          ORDER BY updated_at DESC LIMIT 1000`,
        ...(q.projectId ? [auth.workspaceId, q.projectId] : [auth.workspaceId]),
      )), async (f) => (f.project_id ? projects.has(f.project_id) : await canViewFile(db, auth, f))));
    if (q.archived === 'true' && !isAdmin(auth)) return res.json((await Promise.all(rows.filter((f) => f.owner_id === auth.userId).map(fileSummary))));
    res.json((await Promise.all(rows.map(fileSummary))));
  });

  r.get('/files/:id', async (req, res) => {
    const auth = authOf(req);
    const file = await loadFile(auth, req.params.id);
    const versions = await db.all(
      `SELECT v.version, v.mime, v.size, v.created_at, u.name AS uploaded_by_name FROM file_versions v JOIN users u ON u.id = v.uploaded_by
        WHERE file_id = ? ORDER BY version DESC`,
      file.id,
    );
    const project = file.project_id ? await db.get('SELECT id, name, color FROM projects WHERE id = ?', file.project_id) : null;
    const channel = file.channel_id ? await db.get('SELECT id, name, kind FROM channels WHERE id = ?', file.channel_id) : null;
    const task = file.task_id ? await db.get('SELECT id, title FROM tasks WHERE id = ?', file.task_id) : null;
    res.json({ ...await fileSummary(file), versions, project, channel, task, can_edit: file.owner_id === auth.userId || isAdmin(auth) || (!!file.project_id && await canContributeProject(db, auth, (await db.get('SELECT * FROM projects WHERE id = ?', file.project_id))!)) });
  });

  r.post('/files/:id/versions', upload.single('file'), async (req, res) => {
    const auth = authOf(req);
    if (!req.file) throw badRequest('Attach a file');
    let file: Row;
    try {
      file = await loadFile(auth, String(req.params.id));
      if (file.external_url) throw badRequest('Linked files are versioned in their own service');
      if (file.project_id && !await canContributeProject(db, auth, (await db.get('SELECT * FROM projects WHERE id = ?', file.project_id))!)) throw forbidden();
      if (!file.project_id && file.owner_id !== auth.userId && !isAdmin(auth)) throw forbidden('Only the owner can add versions');
    } catch (e) {
      unlinkSync(tempPath(req.file));
      throw e;
    }
    const stored = await storeUpload(auth, req.file);
    const version = file.current_version + 1;
    await db.insert('file_versions', { id: newId(), file_id: file.id, version, storage_key: stored.key, mime: stored.mime, size: stored.size, uploaded_by: auth.userId, created_at: now() });
    await db.update('files', file.id, { current_version: version, content_text: stored.text, updated_at: now() });
    await emitEvent(ctx, auth.workspaceId, 'document.version_added', { file_id: file.id, name: file.name, version, project_id: file.project_id, channel_id: file.channel_id }, { projectId: file.project_id, channelId: file.channel_id });
    await recordActivity(ctx, auth.workspaceId, {
      actorId: auth.userId,
      verb: 'versioned',
      objectType: 'file',
      objectId: file.id,
      projectId: file.project_id,
      channelId: file.project_id ? null : file.channel_id,
      summary: `uploaded version ${version} of ${file.name}`,
      link: `/files/${file.id}`,
    });
    if (file.owner_id !== auth.userId) {
      await notify(ctx, auth.workspaceId, { userId: file.owner_id, kind: 'file', title: `New version of ${file.name}`, link: `/files/${file.id}`, actorId: auth.userId });
    }
    res.status(201).json(await fileSummary((await db.get('SELECT * FROM files WHERE id = ?', file.id))!));
  });

  r.get('/files/:id/download', async (req, res) => {
    const auth = authOf(req);
    const file = await loadFile(auth, req.params.id);
    if (file.external_url) return res.redirect(file.external_url);
    const q = parse(z.object({ version: z.coerce.number().int().optional(), inline: z.enum(['1', '0']).default('0') }), req.query);
    const v = await db.get('SELECT * FROM file_versions WHERE file_id = ? AND version = ?', file.id, q.version ?? file.current_version);
    if (!v) throw notFound('Version');
    // Byte ranges let videos start quickly and seek (iPhones require them to play video at all).
    const range = parseRange(req.get('range'), v.size);
    if (range === 'invalid') {
      res.setHeader('Content-Range', `bytes */${v.size}`);
      return res.status(416).end();
    }
    const stream = await ctx.files.open(v.storage_key, range ?? undefined);
    if (!stream) throw new HttpError(410, 'The stored file is no longer available');
    const inlineType = INLINE_TYPES[extname(file.name).toLowerCase()];
    const inline = q.inline === '1' && !!inlineType;
    res.setHeader('Content-Type', inline ? inlineType : 'application/octet-stream');
    res.setHeader('Accept-Ranges', 'bytes');
    if (range) {
      res.status(206);
      res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${v.size}`);
      res.setHeader('Content-Length', String(range.end - range.start + 1));
    } else {
      res.setHeader('Content-Length', String(v.size));
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox");
    res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`);
    stream.on('error', (error) => {
      console.error('File download failed', error);
      res.destroy(error);
    });
    stream.pipe(res);
  });

  r.patch('/files/:id', async (req, res) => {
    const auth = authOf(req);
    const file = await loadFile(auth, req.params.id);
    if (file.owner_id !== auth.userId && !isAdmin(auth)) throw forbidden('Only the owner or an admin can change this file');
    const body = parse(z.object({ name: z.string().trim().min(1).max(200).optional(), label: z.string().max(60).optional(), projectId: z.string().nullable().optional(), ownerId: z.string().optional() }), req.body);
    if (body.projectId) await checkPlacement(auth, { projectId: body.projectId });
    if (body.ownerId && !await db.get('SELECT 1 FROM memberships WHERE workspace_id = ? AND user_id = ? AND deactivated_at IS NULL', auth.workspaceId, body.ownerId)) throw notFound('Person');
    await db.update('files', file.id, { name: body.name, label: body.label, project_id: body.projectId, owner_id: body.ownerId, updated_at: now() });
    if (body.ownerId) await audit(ctx, auth.workspaceId, auth.userId, 'file.ownership_transferred', 'file', file.id, { to: body.ownerId });
    res.json(await fileSummary((await db.get('SELECT * FROM files WHERE id = ?', file.id))!));
  });

  r.post('/files/:id/archive', async (req, res) => {
    const auth = authOf(req);
    const file = await loadFile(auth, req.params.id);
    if (file.owner_id !== auth.userId && !isAdmin(auth)) throw forbidden('Only the owner or an admin can archive this file');
    const { archived } = parse(z.object({ archived: z.boolean().default(true) }), req.body ?? {});
    await db.update('files', file.id, { archived_at: archived ? now() : null });
    await audit(ctx, auth.workspaceId, auth.userId, archived ? 'file.archived' : 'file.restored', 'file', file.id, { name: file.name });
    res.json({ ok: true });
  });

  return r;
}
