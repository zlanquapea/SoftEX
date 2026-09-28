import { Router } from 'express';
import { z } from 'zod';
import { canContributeProject, canViewChannel, canViewPage, canViewProject, isAdmin, isGuest, type Auth } from '../access.js';
import { authOf, notify, type Ctx } from '../context.js';
import type { Row } from '../db.js';
import { badRequest, extractMentionIds, forbidden, notFound, now, newId, parse, randomToken } from '../util.js';

/**
 * Notion-style additions to knowledge pages and a personal "Favorites" list:
 * - discussion on a page (comments with @mentions, resolvable),
 * - publishing a page to the web as a read-only link,
 * - starring pages, projects, channels and goals so they show in the sidebar.
 */
export function pagesRouter(ctx: Ctx) {
  const r = Router();
  const { db } = ctx;

  const loadPage = async (auth: Auth, id: string) => {
    const page = await db.get('SELECT * FROM pages WHERE id = ?', id);
    if (!page || !await canViewPage(db, auth, page)) throw notFound('Page');
    return page;
  };
  const canEditPage = async (auth: Auth, page: Row) => {
    if (page.project_id) return canContributeProject(db, auth, (await db.get('SELECT * FROM projects WHERE id = ?', page.project_id))!);
    return !isGuest(auth);
  };

  // ---------- Comments ----------

  r.get('/pages/:id/comments', async (req, res) => {
    const auth = authOf(req);
    const page = await loadPage(auth, req.params.id);
    res.json(
      await db.all(
        `SELECT c.id, c.body, c.created_at, c.resolved_at, c.user_id, u.name AS user_name, u.color AS user_color
           FROM page_comments c JOIN users u ON u.id = c.user_id WHERE c.page_id = ? ORDER BY c.created_at`,
        page.id,
      ),
    );
  });

  r.post('/pages/:id/comments', async (req, res) => {
    const auth = authOf(req);
    const page = await loadPage(auth, req.params.id);
    const { body } = parse(z.object({ body: z.string().trim().min(1).max(5000) }), req.body);
    const id = newId();
    await db.insert('page_comments', { id, page_id: page.id, user_id: auth.userId, body, created_at: now() });
    const actor = (await db.get('SELECT name FROM users WHERE id = ?', auth.userId))!;
    // The page owner hears about discussion; mentioned people hear if they can open the page.
    const notified = new Set<string>();
    for (const userId of extractMentionIds(body)) {
      const member = await db.get('SELECT role FROM memberships WHERE workspace_id = ? AND user_id = ? AND deactivated_at IS NULL', auth.workspaceId, userId);
      if (!member || !await canViewPage(db, { userId, workspaceId: auth.workspaceId, role: member.role }, page)) continue;
      notified.add(userId);
      await notify(ctx, auth.workspaceId, { userId, kind: 'mention', title: `${actor.name} mentioned you on “${page.title}”`, body, link: `/knowledge/${page.id}#comments`, actorId: auth.userId });
    }
    if (!notified.has(page.owner_id)) {
      await notify(ctx, auth.workspaceId, { userId: page.owner_id, kind: 'comment', title: `${actor.name} commented on “${page.title}”`, body, link: `/knowledge/${page.id}#comments`, actorId: auth.userId });
    }
    await ctx.hub.publish(auth.workspaceId, { type: 'page.comment', pageId: page.id }, { kind: 'workspace' });
    res.status(201).json({ id });
  });

  const loadComment = async (auth: Auth, id: string) => {
    const comment = await db.get('SELECT * FROM page_comments WHERE id = ?', id);
    if (!comment) throw notFound('Comment');
    const page = await loadPage(auth, comment.page_id);
    return { comment, page };
  };

  r.patch('/page-comments/:id', async (req, res) => {
    const auth = authOf(req);
    const { comment, page } = await loadComment(auth, req.params.id);
    const { resolved } = parse(z.object({ resolved: z.boolean() }), req.body);
    if (comment.user_id !== auth.userId && !await canEditPage(auth, page)) throw forbidden('You cannot resolve this comment');
    await db.run('UPDATE page_comments SET resolved_at = ? WHERE id = ?', resolved ? now() : null, comment.id);
    res.json({ ok: true });
  });

  r.delete('/page-comments/:id', async (req, res) => {
    const auth = authOf(req);
    const { comment } = await loadComment(auth, req.params.id);
    if (comment.user_id !== auth.userId && !isAdmin(auth)) throw forbidden('You can only delete your own comments');
    await db.run('DELETE FROM page_comments WHERE id = ?', comment.id);
    res.json({ ok: true });
  });

  // ---------- Publish to the web ----------

  r.post('/pages/:id/publish', async (req, res) => {
    const auth = authOf(req);
    const page = await loadPage(auth, req.params.id);
    if (isGuest(auth) || !await canEditPage(auth, page)) throw forbidden('You cannot publish this page');
    const { public: makePublic, newLink } = parse(z.object({ public: z.boolean(), newLink: z.boolean().default(false) }), req.body);
    const token = makePublic ? (page.public_token && !newLink ? page.public_token : randomToken()) : null;
    await db.run('UPDATE pages SET public_token = ? WHERE id = ?', token, page.id);
    res.json({ public: !!token, public_url: token ? `${ctx.config.publicUrl}/p/${token}` : null });
  });

  // ---------- Favorites ----------

  const favoriteTarget = async (auth: Auth, kind: string, id: string) => {
    switch (kind) {
      case 'page': {
        const p = await db.get('SELECT * FROM pages WHERE id = ?', id);
        return p && !p.archived_at && await canViewPage(db, auth, p) ? { id, title: p.title as string, icon: p.icon as string | null, link: `/knowledge/${id}` } : null;
      }
      case 'project': {
        const p = await db.get('SELECT * FROM projects WHERE id = ? AND workspace_id = ?', id, auth.workspaceId);
        return p && await canViewProject(db, auth, p) ? { id, title: p.name as string, icon: null, color: p.color as string, link: `/projects/${id}` } : null;
      }
      case 'channel': {
        const c = await db.get('SELECT * FROM channels WHERE id = ? AND workspace_id = ?', id, auth.workspaceId);
        return c && await canViewChannel(db, auth, c) ? { id, title: c.kind === 'dm' ? 'Direct message' : `#${c.name}`, icon: null, link: `/channels/${id}` } : null;
      }
      case 'goal': {
        if (isGuest(auth)) return null;
        const g = await db.get('SELECT * FROM goals WHERE id = ? AND workspace_id = ?', id, auth.workspaceId);
        return g && !g.archived_at ? { id, title: g.title as string, icon: null, link: `/goals/${id}` } : null;
      }
      default:
        return null;
    }
  };

  r.get('/favorites', async (req, res) => {
    const auth = authOf(req);
    const rows = await db.all('SELECT kind, object_id FROM favorites WHERE user_id = ? AND workspace_id = ? ORDER BY created_at', auth.userId, auth.workspaceId);
    const items = [];
    for (const row of rows) {
      const target = await favoriteTarget(auth, row.kind, row.object_id);
      if (target) items.push({ kind: row.kind, ...target });
    }
    res.json(items);
  });

  r.put('/favorites', async (req, res) => {
    const auth = authOf(req);
    const body = parse(z.object({ kind: z.enum(['page', 'project', 'channel', 'goal']), id: z.string().max(64), on: z.boolean() }), req.body);
    if (body.on) {
      if (!await favoriteTarget(auth, body.kind, body.id)) throw notFound('Item');
      const count = (await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM favorites WHERE user_id = ? AND workspace_id = ?', auth.userId, auth.workspaceId))!.n;
      if (count >= 50) throw badRequest('You can have up to 50 favorites');
      await db.run(
        'INSERT OR IGNORE INTO favorites (user_id, workspace_id, kind, object_id, created_at) VALUES (?, ?, ?, ?, ?)',
        auth.userId,
        auth.workspaceId,
        body.kind,
        body.id,
        now(),
      );
    } else {
      await db.run('DELETE FROM favorites WHERE user_id = ? AND kind = ? AND object_id = ?', auth.userId, body.kind, body.id);
    }
    res.json({ ok: true });
  });

  return r;
}

/** Read-only published pages (no sign-in). */
export function publicPagesRouter(ctx: Ctx) {
  const r = Router();
  r.get('/public/pages/:token', async (req, res) => {
    const page = await ctx.db.get(
      `SELECT p.title, p.body, p.icon, p.updated_at, w.name AS workspace_name FROM pages p JOIN workspaces w ON w.id = p.workspace_id
        WHERE p.public_token = ? AND p.archived_at IS NULL AND w.suspended_at IS NULL`,
      String(req.params.token),
    );
    if (!page) throw notFound('Page');
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.setHeader('X-Robots-Tag', 'noindex');
    res.json(page);
  });
  return r;
}
