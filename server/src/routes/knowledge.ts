import { Router } from 'express';
import multer from 'multer';
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import { extname, join } from 'node:path';
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
import { audit, authOf, notify, recordActivity, userSummary, type Ctx } from '../context.js';
import { HttpError, badRequest, forbidden, newId, notFound, now, parse, today } from '../util.js';

const DateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD');

/** Upload restrictions (§5.3, §9): executable and script types are refused outright. */
const BLOCKED_EXTENSIONS = new Set([
  '.exe', '.msi', '.bat', '.cmd', '.com', '.scr', '.ps1', '.vbs', '.vbe', '.jse', '.wsf', '.jar', '.dll', '.sh', '.app', '.dmg', '.hta', '.cpl', '.lnk', '.reg',
]);
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
};
const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

/**
 * Pluggable content scan. The default implementation rejects the EICAR test
 * signature and executable headers; production deployments should call out to
 * a real scanning service here before the file becomes visible.
 */
function scanUpload(path: string, originalName: string) {
  const ext = extname(originalName).toLowerCase();
  if (BLOCKED_EXTENSIONS.has(ext)) throw badRequest(`Files of type ${ext} are not allowed`);
  const head = readFileSync(path).subarray(0, 4096);
  if (head.includes(Buffer.from(EICAR))) throw badRequest('This file was flagged by the malware scanner');
  if (head.subarray(0, 2).toString('latin1') === 'MZ' || head.subarray(0, 4).toString('latin1') === '\x7fELF') {
    throw badRequest('Executable files are not allowed');
  }
}

export function knowledgeRouter(ctx: Ctx) {
  const r = Router();
  const { db } = ctx;
  mkdirSync(ctx.config.uploadDir, { recursive: true });
  const upload = multer({ dest: join(ctx.config.uploadDir, 'incoming'), limits: { fileSize: ctx.config.maxUploadBytes, files: 1 } });

  // ======================= Knowledge pages =======================

  const loadPage = (auth: Auth, id: string) => {
    const page = db.get('SELECT * FROM pages WHERE id = ?', id);
    if (!page || !canViewPage(db, auth, page)) throw notFound('Page');
    return page;
  };

  const canEditPage = (auth: Auth, page: Row) => {
    if (page.project_id) return canContributeProject(db, auth, db.get('SELECT * FROM projects WHERE id = ?', page.project_id)!);
    return !isGuest(auth);
  };

  const pageSummary = (p: Row) => ({
    id: p.id,
    title: p.title,
    status: p.status,
    project_id: p.project_id,
    project_name: p.project_name ?? null,
    review_date: p.review_date,
    needs_review: !!p.review_date && p.review_date <= today(),
    version: p.version,
    owner: userSummary(db, p.owner_id),
    updated_at: p.updated_at,
    updated_by: userSummary(db, p.updated_by),
    excerpt: p.body.replace(/[#*_>`[\]()-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 180),
    archived_at: p.archived_at,
  });

  r.get('/pages', (req, res) => {
    const auth = authOf(req);
    const q = parse(z.object({ projectId: z.string().optional(), archived: z.enum(['true', 'false']).default('false') }), req.query);
    if (q.projectId) loadProject(db, auth, q.projectId);
    const rows = db
      .all(
        `SELECT p.*, pr.name AS project_name FROM pages p LEFT JOIN projects pr ON pr.id = p.project_id
          WHERE p.workspace_id = ? ${q.projectId ? 'AND p.project_id = ?' : ''} AND p.archived_at IS ${q.archived === 'true' ? 'NOT NULL' : 'NULL'}
          ORDER BY p.updated_at DESC`,
        ...(q.projectId ? [auth.workspaceId, q.projectId] : [auth.workspaceId]),
      )
      .filter((p) => canViewPage(db, auth, p));
    res.json(rows.map(pageSummary));
  });

  const PageBody = z.object({
    title: z.string().trim().min(1).max(200),
    body: z.string().max(200_000).default(''),
    projectId: z.string().nullish(),
    reviewDate: DateStr.nullish(),
    status: z.enum(['draft', 'approved']).default('draft'),
    ownerId: z.string().optional(),
  });

  r.post('/pages', (req, res) => {
    const auth = authOf(req);
    const body = parse(PageBody, req.body);
    if (body.projectId) {
      const project = loadProject(db, auth, body.projectId);
      if (!canContributeProject(db, auth, project)) throw forbidden();
    } else if (isGuest(auth)) {
      throw forbidden('Guests can only create pages inside shared projects');
    }
    const id = newId();
    db.insert('pages', {
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
    db.insert('page_versions', { id: newId(), page_id: id, version: 1, title: body.title, body: body.body, edited_by: auth.userId, created_at: now() });
    recordActivity(ctx, auth.workspaceId, {
      actorId: auth.userId,
      verb: 'created',
      objectType: 'page',
      objectId: id,
      projectId: body.projectId,
      summary: `created the page “${body.title}”`,
      link: `/knowledge/${id}`,
    });
    res.status(201).json(pageSummary(db.get('SELECT * FROM pages WHERE id = ?', id)!));
  });

  r.get('/pages/:id', (req, res) => {
    const auth = authOf(req);
    const page = loadPage(auth, req.params.id);
    const project = page.project_id ? db.get('SELECT id, name, color FROM projects WHERE id = ?', page.project_id) : null;
    const versions = db.all(
      `SELECT v.version, v.title, v.created_at, u.name AS edited_by_name FROM page_versions v JOIN users u ON u.id = v.edited_by
        WHERE page_id = ? ORDER BY version DESC`,
      page.id,
    );
    // Related discussions: messages that link to this page in channels the reader can see.
    const channels = accessibleChannelIds(db, auth);
    const discussions = channels.length
      ? db.all(
          `SELECT m.id, m.body, m.created_at, m.channel_id, c.name AS channel_name, u.name AS user_name FROM messages m
             JOIN channels c ON c.id = m.channel_id JOIN users u ON u.id = m.user_id
            WHERE instr(m.body, ?) > 0 AND m.deleted_at IS NULL AND m.channel_id IN (${channels.map(() => '?').join(',')})
            ORDER BY m.created_at DESC LIMIT 10`,
          `/knowledge/${page.id}`,
          ...channels,
        )
      : [];
    res.json({ ...pageSummary(page), body: page.body, project, versions, discussions, can_edit: canEditPage(auth, page) });
  });

  r.patch('/pages/:id', (req, res) => {
    const auth = authOf(req);
    const page = loadPage(auth, req.params.id);
    if (!canEditPage(auth, page)) throw forbidden('You cannot edit this page');
    const body = parse(PageBody.partial().extend({ reviewDate: DateStr.nullable().optional(), projectId: z.string().nullable().optional() }), req.body);
    if (body.projectId) {
      const project = loadProject(db, auth, body.projectId);
      if (!canContributeProject(db, auth, project)) throw forbidden();
    }
    if (body.ownerId && !db.get('SELECT 1 FROM memberships WHERE workspace_id = ? AND user_id = ? AND deactivated_at IS NULL', auth.workspaceId, body.ownerId)) {
      throw notFound('Person');
    }
    const contentChanged = (body.title !== undefined && body.title !== page.title) || (body.body !== undefined && body.body !== page.body);
    const version = contentChanged ? page.version + 1 : page.version;
    db.transaction(() => {
      db.update('pages', page.id, {
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
        db.insert('page_versions', {
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
      recordActivity(ctx, auth.workspaceId, {
        actorId: auth.userId,
        verb: body.status === 'approved' && page.status !== 'approved' ? 'approved' : 'updated',
        objectType: 'page',
        objectId: page.id,
        projectId: body.projectId === undefined ? page.project_id : body.projectId,
        summary: `${body.status === 'approved' && page.status !== 'approved' ? 'approved' : 'updated'} the page “${body.title ?? page.title}”`,
        link: `/knowledge/${page.id}`,
      });
      if (page.owner_id !== auth.userId) {
        notify(ctx, auth.workspaceId, { userId: page.owner_id, kind: 'page', title: `“${page.title}” was updated`, link: `/knowledge/${page.id}`, actorId: auth.userId });
      }
    }
    res.json(pageSummary(db.get('SELECT * FROM pages WHERE id = ?', page.id)!));
  });

  r.get('/pages/:id/versions/:version', (req, res) => {
    const auth = authOf(req);
    const page = loadPage(auth, req.params.id);
    const v = db.get('SELECT * FROM page_versions WHERE page_id = ? AND version = ?', page.id, Number(req.params.version));
    if (!v) throw notFound('Version');
    res.json(v);
  });

  r.post('/pages/:id/restore-version', (req, res) => {
    const auth = authOf(req);
    const page = loadPage(auth, req.params.id);
    if (!canEditPage(auth, page)) throw forbidden();
    const { version } = parse(z.object({ version: z.number().int() }), req.body);
    const v = db.get('SELECT * FROM page_versions WHERE page_id = ? AND version = ?', page.id, version);
    if (!v) throw notFound('Version');
    const next = page.version + 1;
    db.update('pages', page.id, { title: v.title, body: v.body, version: next, updated_at: now(), updated_by: auth.userId });
    db.insert('page_versions', { id: newId(), page_id: page.id, version: next, title: v.title, body: v.body, edited_by: auth.userId, created_at: now() });
    res.json({ ok: true, version: next });
  });

  r.post('/pages/:id/archive', (req, res) => {
    const auth = authOf(req);
    const page = loadPage(auth, req.params.id);
    if (page.owner_id !== auth.userId && !isAdmin(auth)) throw forbidden('Only the page owner or an admin can archive it');
    const { archived } = parse(z.object({ archived: z.boolean().default(true) }), req.body ?? {});
    db.update('pages', page.id, { archived_at: archived ? now() : null });
    audit(ctx, auth.workspaceId, auth.userId, archived ? 'page.archived' : 'page.restored', 'page', page.id, { title: page.title });
    res.json({ ok: true });
  });

  // ======================= Files =======================

  const loadFile = (auth: Auth, id: string) => {
    const file = db.get('SELECT * FROM files WHERE id = ?', id);
    if (!file || !canViewFile(db, auth, file)) throw notFound('File');
    return file;
  };

  /** Where a new file may be placed, checked against the uploader's rights. */
  const checkPlacement = (auth: Auth, target: { projectId?: string | null; channelId?: string | null; taskId?: string | null }) => {
    let projectId = target.projectId ?? null;
    if (target.taskId) {
      const task = loadTask(db, auth, target.taskId);
      if (!canEditTask(db, auth, task)) throw forbidden('You cannot attach files to this task');
      projectId = task.project_id;
    }
    if (projectId) {
      const project = loadProject(db, auth, projectId);
      if (!canContributeProject(db, auth, project)) throw forbidden('You cannot add files to this project');
    }
    if (target.channelId) {
      const channel = loadChannel(db, auth, target.channelId);
      if (!canPostChannel(db, auth, channel) && channel.kind !== 'announcement') throw forbidden('You cannot share files here');
    }
    return projectId;
  };

  const fileSummary = (f: Row) => {
    const v = db.get('SELECT mime, size FROM file_versions WHERE file_id = ? AND version = ?', f.id, f.current_version);
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
      owner: userSummary(db, f.owner_id),
      created_at: f.created_at,
      updated_at: f.updated_at,
      archived_at: f.archived_at,
    };
  };

  const storeUpload = (auth: Auth, file: Express.Multer.File) => {
    try {
      scanUpload(file.path, file.originalname);
    } catch (e) {
      unlinkSync(file.path);
      audit(ctx, auth.workspaceId, auth.userId, 'file.upload_rejected', 'file', 'n/a', { name: file.originalname, reason: (e as Error).message });
      throw e;
    }
    const key = newId();
    renameSync(file.path, join(ctx.config.uploadDir, key));
    const ext = extname(file.originalname).toLowerCase();
    const mime = INLINE_TYPES[ext]?.split(';')[0] ?? (file.mimetype || 'application/octet-stream');
    return { key, mime, size: file.size };
  };

  r.post('/files', upload.single('file'), (req, res) => {
    const auth = authOf(req);
    if (!req.file) throw badRequest('Attach a file');
    const body = parse(
      z.object({ projectId: z.string().optional(), channelId: z.string().optional(), taskId: z.string().optional(), label: z.string().max(60).default('') }),
      req.body,
    );
    let projectId: string | null;
    try {
      projectId = checkPlacement(auth, body);
    } catch (e) {
      unlinkSync(req.file.path);
      throw e;
    }
    const stored = storeUpload(auth, req.file);
    const id = newId();
    const name = req.file.originalname.slice(0, 200);
    db.transaction(() => {
      db.insert('files', {
        id,
        workspace_id: auth.workspaceId,
        project_id: projectId,
        channel_id: body.channelId ?? null,
        task_id: body.taskId ?? null,
        owner_id: auth.userId,
        name,
        label: body.label,
        created_at: now(),
        updated_at: now(),
      });
      db.insert('file_versions', { id: newId(), file_id: id, version: 1, storage_key: stored.key, mime: stored.mime, size: stored.size, uploaded_by: auth.userId, created_at: now() });
    });
    if (projectId || !body.channelId) {
      recordActivity(ctx, auth.workspaceId, {
        actorId: auth.userId,
        verb: 'shared',
        objectType: 'file',
        objectId: id,
        projectId,
        summary: `shared the file ${name}`,
        link: `/files/${id}`,
      });
    }
    res.status(201).json(fileSummary(db.get('SELECT * FROM files WHERE id = ?', id)!));
  });

  r.post('/files/link', (req, res) => {
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
    const projectId = checkPlacement(auth, body);
    if (!projectId && isGuest(auth) && !body.channelId) throw forbidden();
    const id = newId();
    db.insert('files', {
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
    recordActivity(ctx, auth.workspaceId, { actorId: auth.userId, verb: 'linked', objectType: 'file', objectId: id, projectId, summary: `linked ${body.name}`, link: `/files/${id}` });
    res.status(201).json(fileSummary(db.get('SELECT * FROM files WHERE id = ?', id)!));
  });

  r.get('/files', (req, res) => {
    const auth = authOf(req);
    const q = parse(z.object({ projectId: z.string().optional(), archived: z.enum(['true', 'false']).default('false') }), req.query);
    if (q.projectId) loadProject(db, auth, q.projectId);
    const projects = new Set(accessibleProjectIds(db, auth));
    const rows = db
      .all(
        `SELECT * FROM files WHERE workspace_id = ? ${q.projectId ? 'AND project_id = ?' : ''} AND archived_at IS ${q.archived === 'true' ? 'NOT NULL' : 'NULL'}
          ORDER BY updated_at DESC LIMIT 1000`,
        ...(q.projectId ? [auth.workspaceId, q.projectId] : [auth.workspaceId]),
      )
      .filter((f) => (f.project_id ? projects.has(f.project_id) : canViewFile(db, auth, f)));
    if (q.archived === 'true' && !isAdmin(auth)) return res.json(rows.filter((f) => f.owner_id === auth.userId).map(fileSummary));
    res.json(rows.map(fileSummary));
  });

  r.get('/files/:id', (req, res) => {
    const auth = authOf(req);
    const file = loadFile(auth, req.params.id);
    const versions = db.all(
      `SELECT v.version, v.mime, v.size, v.created_at, u.name AS uploaded_by_name FROM file_versions v JOIN users u ON u.id = v.uploaded_by
        WHERE file_id = ? ORDER BY version DESC`,
      file.id,
    );
    const project = file.project_id ? db.get('SELECT id, name, color FROM projects WHERE id = ?', file.project_id) : null;
    const channel = file.channel_id ? db.get('SELECT id, name, kind FROM channels WHERE id = ?', file.channel_id) : null;
    const task = file.task_id ? db.get('SELECT id, title FROM tasks WHERE id = ?', file.task_id) : null;
    res.json({ ...fileSummary(file), versions, project, channel, task, can_edit: file.owner_id === auth.userId || isAdmin(auth) || (!!file.project_id && canContributeProject(db, auth, db.get('SELECT * FROM projects WHERE id = ?', file.project_id)!)) });
  });

  r.post('/files/:id/versions', upload.single('file'), (req, res) => {
    const auth = authOf(req);
    if (!req.file) throw badRequest('Attach a file');
    let file: Row;
    try {
      file = loadFile(auth, String(req.params.id));
      if (file.external_url) throw badRequest('Linked files are versioned in their own service');
      if (file.project_id && !canContributeProject(db, auth, db.get('SELECT * FROM projects WHERE id = ?', file.project_id)!)) throw forbidden();
      if (!file.project_id && file.owner_id !== auth.userId && !isAdmin(auth)) throw forbidden('Only the owner can add versions');
    } catch (e) {
      unlinkSync(req.file.path);
      throw e;
    }
    const stored = storeUpload(auth, req.file);
    const version = file.current_version + 1;
    db.insert('file_versions', { id: newId(), file_id: file.id, version, storage_key: stored.key, mime: stored.mime, size: stored.size, uploaded_by: auth.userId, created_at: now() });
    db.update('files', file.id, { current_version: version, updated_at: now() });
    recordActivity(ctx, auth.workspaceId, {
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
      notify(ctx, auth.workspaceId, { userId: file.owner_id, kind: 'file', title: `New version of ${file.name}`, link: `/files/${file.id}`, actorId: auth.userId });
    }
    res.status(201).json(fileSummary(db.get('SELECT * FROM files WHERE id = ?', file.id)!));
  });

  r.get('/files/:id/download', (req, res) => {
    const auth = authOf(req);
    const file = loadFile(auth, req.params.id);
    if (file.external_url) return res.redirect(file.external_url);
    const q = parse(z.object({ version: z.coerce.number().int().optional(), inline: z.enum(['1', '0']).default('0') }), req.query);
    const v = db.get('SELECT * FROM file_versions WHERE file_id = ? AND version = ?', file.id, q.version ?? file.current_version);
    if (!v) throw notFound('Version');
    const path = join(ctx.config.uploadDir, v.storage_key);
    if (!existsSync(path)) throw new HttpError(410, 'The stored file is no longer available');
    const inlineType = INLINE_TYPES[extname(file.name).toLowerCase()];
    const inline = q.inline === '1' && !!inlineType;
    res.setHeader('Content-Type', inline ? inlineType : 'application/octet-stream');
    res.setHeader('Content-Length', String(v.size));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
    res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`);
    createReadStream(path).pipe(res);
  });

  r.patch('/files/:id', (req, res) => {
    const auth = authOf(req);
    const file = loadFile(auth, req.params.id);
    if (file.owner_id !== auth.userId && !isAdmin(auth)) throw forbidden('Only the owner or an admin can change this file');
    const body = parse(z.object({ name: z.string().trim().min(1).max(200).optional(), label: z.string().max(60).optional(), projectId: z.string().nullable().optional(), ownerId: z.string().optional() }), req.body);
    if (body.projectId) checkPlacement(auth, { projectId: body.projectId });
    if (body.ownerId && !db.get('SELECT 1 FROM memberships WHERE workspace_id = ? AND user_id = ? AND deactivated_at IS NULL', auth.workspaceId, body.ownerId)) throw notFound('Person');
    db.update('files', file.id, { name: body.name, label: body.label, project_id: body.projectId, owner_id: body.ownerId, updated_at: now() });
    if (body.ownerId) audit(ctx, auth.workspaceId, auth.userId, 'file.ownership_transferred', 'file', file.id, { to: body.ownerId });
    res.json(fileSummary(db.get('SELECT * FROM files WHERE id = ?', file.id)!));
  });

  r.post('/files/:id/archive', (req, res) => {
    const auth = authOf(req);
    const file = loadFile(auth, req.params.id);
    if (file.owner_id !== auth.userId && !isAdmin(auth)) throw forbidden('Only the owner or an admin can archive this file');
    const { archived } = parse(z.object({ archived: z.boolean().default(true) }), req.body ?? {});
    db.update('files', file.id, { archived_at: archived ? now() : null });
    audit(ctx, auth.workspaceId, auth.userId, archived ? 'file.archived' : 'file.restored', 'file', file.id, { name: file.name });
    res.json({ ok: true });
  });

  return r;
}
