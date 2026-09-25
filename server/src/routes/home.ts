import { Router } from 'express';
import { z } from 'zod';
import { minutesAfter } from '../db.js';
import {
  accessibleChannelIds,
  accessibleProjectIds,
  canContributeProject,
  canViewActivity,
  canViewDecision,
  canViewFile,
  canViewMeeting,
  canViewPage,
  canViewTask,
  isGuest,
  loadProject,
} from '../access.js';
import { authOf, notify, recordActivity, type Ctx } from '../context.js';
import { forbidden, likePattern, newId, now, parse, parseJson, today, filterAsync } from '../util.js';
import { serializeTasks } from './tasks.js';

export function homeRouter(ctx: Ctx) {
  const r = Router();
  const { db } = ctx;

  /** Home answers: what matters today, what is blocked, what changed since I last checked (§11). */
  r.get('/home', async (req, res) => {
    const auth = authOf(req);
    const t0 = today();
    const membership = (await db.get('SELECT last_seen_home_at FROM memberships WHERE workspace_id = ? AND user_id = ?', auth.workspaceId, auth.userId))!;
    const since = membership.last_seen_home_at ?? new Date(Date.now() - 3 * 86_400_000).toISOString();
    const projects = await accessibleProjectIds(db, auth);
    const projectSet = new Set(projects);
    const channelSet = new Set(await accessibleChannelIds(db, auth));

    const myOpen = (await filterAsync((await db
      .all(
        `SELECT * FROM tasks WHERE workspace_id = ? AND owner_id = ? AND status != 'done'
          ORDER BY due_date IS NULL, due_date, CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END`,
        auth.workspaceId,
        auth.userId,
      )), (t) => canViewTask(db, auth, t)));
    const focus = myOpen.filter((t) => (t.due_date && t.due_date <= t0) || t.priority === 'urgent');
    const upNextTasks = myOpen.filter((t) => !focus.includes(t) && t.status !== 'blocked').slice(0, 5);
    const memberProjects = (await db.all('SELECT project_id FROM project_members WHERE user_id = ?', auth.userId)).map((p) => p.project_id).filter((p) => projectSet.has(p));
    const blocked = (await filterAsync((await db
      .all(
        `SELECT * FROM tasks WHERE workspace_id = ? AND status = 'blocked' AND (owner_id = ? OR created_by = ?
           OR project_id IN (${memberProjects.map(() => '?').join(',') || "''"})) ORDER BY updated_at DESC LIMIT 20`,
        auth.workspaceId,
        auth.userId,
        auth.userId,
        ...memberProjects,
      )), (t) => canViewTask(db, auth, t)));

    const dayEnd = new Date(Date.now() + 36 * 3_600_000).toISOString();
    const [ends, at] = minutesAfter(db, 'm.starts_at', 'm.duration_min');
    const meetings = (await Promise.all((await db
      .all(
        `SELECT m.*, p.response FROM meetings m JOIN meeting_participants p ON p.meeting_id = m.id AND p.user_id = ?
          WHERE m.workspace_id = ? AND m.ended_at IS NULL AND ${ends} >= ${at}
            AND m.starts_at <= ? AND p.response != 'declined' ORDER BY m.starts_at LIMIT 6`,
        auth.userId,
        auth.workspaceId,
        now(),
        dayEnd,
      )).map(async (m) => ({
        id: m.id,
        title: m.title,
        starts_at: m.starts_at,
        duration_min: m.duration_min,
        location: m.location,
        video_url: m.video_url,
        started_at: m.started_at,
        response: m.response,
        participants: await db.all(`SELECT u.id, u.name, u.color FROM meeting_participants mp JOIN users u ON u.id = mp.user_id WHERE mp.meeting_id = ? LIMIT 5`, m.id),
      }))));

    const mentions = await db.all(
      `SELECT n.*, u.name AS actor_name, u.color AS actor_color FROM notifications n LEFT JOIN users u ON u.id = n.actor_id
        WHERE n.user_id = ? AND n.workspace_id = ? AND n.read_at IS NULL AND n.kind IN ('mention', 'dm', 'urgent', 'thread')
        ORDER BY n.created_at DESC LIMIT 6`,
      auth.userId,
      auth.workspaceId,
    );

    const decisions = (await filterAsync((await db
      .all(
        `SELECT d.*, u.name AS decided_by_name, p.name AS project_name FROM decisions d JOIN users u ON u.id = d.decided_by
           LEFT JOIN projects p ON p.id = d.project_id WHERE d.workspace_id = ? ORDER BY d.created_at DESC LIMIT 40`,
        auth.workspaceId,
      )), (d) => canViewDecision(db, auth, d)))
      .slice(0, 5);

    const changes = (await db
      .all(
        `SELECT a.*, u.name AS actor_name, u.color AS actor_color FROM activity a JOIN users u ON u.id = a.actor_id
          WHERE a.workspace_id = ? AND a.created_at > ? AND a.actor_id != ? ORDER BY a.created_at DESC LIMIT 200`,
        auth.workspaceId,
        since,
        auth.userId,
      ))
      .filter((a) => canViewActivity(auth, a, projectSet, channelSet))
      .slice(0, 12);

    const activeProjects = memberProjects.length
      ? (await Promise.all((await db
          .all(
            `SELECT * FROM projects WHERE id IN (${memberProjects.map(() => '?').join(',')}) AND archived_at IS NULL ORDER BY updated_at DESC LIMIT 4`,
            ...memberProjects,
          )).map(async (p) => {
            const counts = (await db.get(
              `SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done FROM tasks WHERE project_id = ? AND parent_id IS NULL`,
              p.id,
            ))!;
            return {
              id: p.id,
              name: p.name,
              color: p.color,
              health: p.health,
              progress: counts.total ? Math.round(((counts.done ?? 0) / counts.total) * 100) : 0,
              members: await db.all(`SELECT u.id, u.name, u.color FROM project_members m JOIN users u ON u.id = m.user_id WHERE m.project_id = ? LIMIT 4`, p.id),
              member_count: (await db.get('SELECT COUNT(*) AS n FROM project_members WHERE project_id = ?', p.id))!.n,
            };
          })))
      : [];

    const onboarding = (await db.get(
      `SELECT COUNT(*) AS total, SUM(CASE WHEN p.done_at IS NOT NULL THEN 1 ELSE 0 END) AS done FROM onboarding_items i
         LEFT JOIN onboarding_progress p ON p.item_id = i.id AND p.user_id = ?
        WHERE i.workspace_id = ? AND (i.role IS NULL OR i.role = ?)`,
      auth.userId,
      auth.workspaceId,
      auth.role,
    ))!;
    const pendingApprovals = (await db.get(`SELECT COUNT(*) AS n FROM requests WHERE approver_id = ? AND workspace_id = ? AND status = 'pending'`, auth.userId, auth.workspaceId))!.n;
    const checkedInToday = !!await db.get('SELECT 1 FROM checkins WHERE user_id = ? AND workspace_id = ? AND created_at >= ?', auth.userId, auth.workspaceId, `${t0}T00:00:00`);
    const reviewsDue = (await db
      .all(`SELECT * FROM pages WHERE owner_id = ? AND workspace_id = ? AND archived_at IS NULL AND review_date IS NOT NULL AND review_date <= ?`, auth.userId, auth.workspaceId, t0))
      .map((p) => ({ id: p.id, title: p.title, review_date: p.review_date }));

    res.json({
      since,
      focus: await serializeTasks(db, focus),
      up_next: await serializeTasks(db, upNextTasks),
      blocked: await serializeTasks(db, blocked),
      meetings,
      mentions,
      decisions,
      changes,
      projects: activeProjects,
      onboarding: { total: onboarding.total ?? 0, done: onboarding.done ?? 0 },
      pending_approvals: pendingApprovals,
      checked_in_today: checkedInToday,
      reviews_due: reviewsDue,
      counts: {
        open_tasks: myOpen.length,
        overdue: myOpen.filter((t) => t.due_date && t.due_date < t0).length,
        unread: (await db.get('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND workspace_id = ? AND read_at IS NULL', auth.userId, auth.workspaceId))!.n,
      },
    });
  });

  r.post('/home/seen', async (req, res) => {
    const auth = authOf(req);
    await db.run('UPDATE memberships SET last_seen_home_at = ? WHERE workspace_id = ? AND user_id = ?', now(), auth.workspaceId, auth.userId);
    res.json({ ok: true });
  });

  // ======================= Inbox =======================

  r.get('/notifications', async (req, res) => {
    const auth = authOf(req);
    const q = parse(
      z.object({ filter: z.enum(['all', 'unread', 'mentions', 'assigned', 'meetings']).default('all'), before: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }),
      req.query,
    );
    const where = ['n.user_id = ?', 'n.workspace_id = ?'];
    const params: (string | number)[] = [auth.userId, auth.workspaceId];
    if (q.filter === 'unread') where.push('n.read_at IS NULL');
    if (q.filter === 'mentions') where.push(`n.kind IN ('mention', 'dm', 'thread', 'urgent')`);
    if (q.filter === 'assigned') where.push(`n.kind IN ('assigned', 'review', 'handoff', 'status', 'comment')`);
    if (q.filter === 'meetings') where.push(`n.kind = 'meeting'`);
    if (q.before) {
      where.push('n.created_at < ?');
      params.push(q.before);
    }
    params.push(q.limit);
    const rows = await db.all(
      `SELECT n.*, u.name AS actor_name, u.color AS actor_color FROM notifications n LEFT JOIN users u ON u.id = n.actor_id
        WHERE ${where.join(' AND ')} ORDER BY n.created_at DESC LIMIT ?`,
      ...params,
    );
    const unread = (await db.get('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND workspace_id = ? AND read_at IS NULL', auth.userId, auth.workspaceId))!.n;
    res.json({ notifications: rows, unread });
  });

  r.post('/notifications/:id/read', async (req, res) => {
    const auth = authOf(req);
    const { read } = parse(z.object({ read: z.boolean().default(true) }), req.body ?? {});
    await db.run('UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ?', read ? now() : null, req.params.id, auth.userId);
    res.json({ ok: true });
  });

  r.post('/notifications/read-all', async (req, res) => {
    const auth = authOf(req);
    await db.run('UPDATE notifications SET read_at = ? WHERE user_id = ? AND workspace_id = ? AND read_at IS NULL', now(), auth.userId, auth.workspaceId);
    res.json({ ok: true });
  });

  /** Digest of the last day, grouped by kind, to reduce interruption load (§5.5). */
  r.get('/notifications/digest', async (req, res) => {
    const auth = authOf(req);
    const since = new Date(Date.now() - 86_400_000).toISOString();
    res.json(
      await db.all(
        `SELECT kind, COUNT(*) AS count, SUM(CASE WHEN read_at IS NULL THEN 1 ELSE 0 END) AS unread, MAX(created_at) AS latest FROM notifications
          WHERE user_id = ? AND workspace_id = ? AND created_at >= ? GROUP BY kind ORDER BY latest DESC`,
        auth.userId,
        auth.workspaceId,
        since,
      ),
    );
  });

  r.get('/activity', async (req, res) => {
    const auth = authOf(req);
    const q = parse(z.object({ before: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).default(40) }), req.query);
    const projectSet = new Set(await accessibleProjectIds(db, auth));
    const channelSet = new Set(await accessibleChannelIds(db, auth));
    const rows = (await db
      .all(
        `SELECT a.*, u.name AS actor_name, u.color AS actor_color FROM activity a JOIN users u ON u.id = a.actor_id
          WHERE a.workspace_id = ? ${q.before ? 'AND a.created_at < ?' : ''} ORDER BY a.created_at DESC LIMIT 500`,
        ...(q.before ? [auth.workspaceId, q.before] : [auth.workspaceId]),
      ))
      .filter((a) => canViewActivity(auth, a, projectSet, channelSet))
      .slice(0, q.limit);
    res.json(rows);
  });

  // ======================= Check-ins (§5.5) =======================

  r.get('/checkins', async (req, res) => {
    const auth = authOf(req);
    const q = parse(z.object({ projectId: z.string().optional() }), req.query);
    if (q.projectId) await loadProject(db, auth, q.projectId);
    const projects = new Set(await accessibleProjectIds(db, auth));
    const rows = (await db
      .all(
        `SELECT c.*, u.name AS user_name, u.color AS user_color, p.name AS project_name FROM checkins c JOIN users u ON u.id = c.user_id
           LEFT JOIN projects p ON p.id = c.project_id WHERE c.workspace_id = ? ${q.projectId ? 'AND c.project_id = ?' : ''}
          ORDER BY c.created_at DESC LIMIT 200`,
        ...(q.projectId ? [auth.workspaceId, q.projectId] : [auth.workspaceId]),
      ))
      .filter((c) => (c.project_id ? projects.has(c.project_id) : !isGuest(auth) || c.user_id === auth.userId));
    res.json(rows.slice(0, 60));
  });

  r.post('/checkins', async (req, res) => {
    const auth = authOf(req);
    const body = parse(
      z.object({ projectId: z.string().nullish(), done: z.string().max(2000).default(''), next: z.string().max(2000).default(''), blockers: z.string().max(2000).default('') }),
      req.body,
    );
    let project = null;
    if (body.projectId) {
      project = await loadProject(db, auth, body.projectId);
      if (!await canContributeProject(db, auth, project)) throw forbidden();
    }
    const id = newId();
    await db.insert('checkins', { id, workspace_id: auth.workspaceId, project_id: body.projectId ?? null, user_id: auth.userId, done: body.done, next: body.next, blockers: body.blockers, created_at: now() });
    if (project) {
      await recordActivity(ctx, auth.workspaceId, { actorId: auth.userId, verb: 'checked in', objectType: 'checkin', objectId: id, projectId: project.id, summary: `checked in on ${project.name}`, link: `/projects/${project.id}?tab=checkins` });
      if (body.blockers.trim()) {
        const name = (await db.get('SELECT name FROM users WHERE id = ?', auth.userId))!.name;
        await notify(ctx, auth.workspaceId, { userId: project.owner_id, kind: 'status', title: `${name} reported a blocker on ${project.name}`, body: body.blockers, link: `/projects/${project.id}?tab=checkins`, actorId: auth.userId });
      }
    }
    res.status(201).json(await db.get('SELECT * FROM checkins WHERE id = ?', id));
  });

  // ======================= Search (§5.1, §5.3, §9) =======================

  /**
   * Permission-aware global search. Candidate rows are restricted in SQL to the
   * channels and projects the user can access, then re-checked with the same
   * access functions used by the item routes so nothing private can leak.
   */
  r.get('/search', async (req, res) => {
    const auth = authOf(req);
    const q = parse(
      z.object({
        q: z.string().trim().max(200).default(''),
        type: z.enum(['all', 'messages', 'tasks', 'projects', 'pages', 'files', 'people', 'decisions', 'meetings']).default('all'),
        from: z.string().optional(),
        channelId: z.string().optional(),
        projectId: z.string().optional(),
        after: z.string().optional(),
        before: z.string().optional(),
        hasFile: z.enum(['true', 'false']).optional(),
        limit: z.coerce.number().int().min(1).max(50).default(8),
      }),
      req.query,
    );
    const empty = { messages: [], tasks: [], projects: [], pages: [], files: [], people: [], decisions: [], meetings: [] };
    if (q.q.length < 2 && !q.from && !q.channelId && !q.hasFile) return res.json(empty);
    const like = likePattern(q.q);
    const want = (t: string) => q.type === 'all' || q.type === t;
    const channels = (await accessibleChannelIds(db, auth)).filter((c) => !q.channelId || c === q.channelId);
    const projects = (await accessibleProjectIds(db, auth)).filter((p) => !q.projectId || p === q.projectId);
    const marks = (ids: string[]) => (ids.length ? ids.map(() => '?').join(',') : "''");
    const result: Record<string, unknown[]> = { ...empty };

    if (want('messages') && channels.length) {
      const where = [`m.channel_id IN (${marks(channels)})`, 'm.deleted_at IS NULL', `m.body LIKE ? ESCAPE '\\'`];
      const params: (string | number)[] = [...channels, like];
      if (q.from) {
        where.push('m.user_id = ?');
        params.push(q.from);
      }
      if (q.after) {
        where.push('m.created_at >= ?');
        params.push(q.after);
      }
      if (q.before) {
        where.push('m.created_at <= ?');
        params.push(q.before);
      }
      if (q.projectId) {
        where.push('c.project_id = ?');
        params.push(q.projectId);
      }
      if (q.hasFile === 'true') where.push('EXISTS (SELECT 1 FROM files f WHERE f.message_id = m.id)');
      params.push(q.limit);
      result.messages = await db.all(
        `SELECT m.id, m.body, m.created_at, m.channel_id, m.parent_id, c.name AS channel_name, c.kind AS channel_kind, u.name AS user_name, u.color AS user_color
           FROM messages m JOIN channels c ON c.id = m.channel_id JOIN users u ON u.id = m.user_id
          WHERE ${where.join(' AND ')} ORDER BY m.created_at DESC LIMIT ?`,
        ...params,
      );
    }
    if (q.q.length >= 2) {
      if (want('tasks')) {
        result.tasks = await serializeTasks(
          db,
          (await filterAsync((await db
            .all(
              `SELECT * FROM tasks WHERE workspace_id = ? AND (title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')
                 ${q.projectId ? 'AND project_id = ?' : ''} ${q.from ? 'AND owner_id = ?' : ''} ORDER BY updated_at DESC LIMIT 200`,
              ...[auth.workspaceId, like, like, ...(q.projectId ? [q.projectId] : []), ...(q.from ? [q.from] : [])],
            )), (t) => canViewTask(db, auth, t)))
            .slice(0, q.limit),
        );
      }
      if (want('projects') && projects.length) {
        result.projects = await db.all(
          `SELECT id, name, description, color, health FROM projects WHERE id IN (${marks(projects)}) AND (name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\') LIMIT ?`,
          ...projects,
          like,
          like,
          q.limit,
        );
      }
      if (want('pages')) {
        result.pages = (await filterAsync((await db
          .all(
            `SELECT p.*, u.name AS owner_name FROM pages p JOIN users u ON u.id = p.owner_id WHERE p.workspace_id = ? AND p.archived_at IS NULL
               AND (p.title LIKE ? ESCAPE '\\' OR p.body LIKE ? ESCAPE '\\') ${q.projectId ? 'AND p.project_id = ?' : ''}
             ORDER BY p.status = 'approved' DESC, p.updated_at DESC LIMIT 200`,
            ...[auth.workspaceId, like, like, ...(q.projectId ? [q.projectId] : [])],
          )), (p) => canViewPage(db, auth, p)))
          .slice(0, q.limit)
          .map((p) => {
            const idx = p.body.toLowerCase().indexOf(q.q.toLowerCase());
            return {
              id: p.id,
              title: p.title,
              status: p.status,
              owner_name: p.owner_name,
              review_date: p.review_date,
              updated_at: p.updated_at,
              snippet: idx >= 0 ? p.body.slice(Math.max(0, idx - 60), idx + 120) : p.body.slice(0, 160),
            };
          });
      }
      if (want('files')) {
        result.files = (await filterAsync((await db
          .all(
            `SELECT f.*, u.name AS owner_name FROM files f JOIN users u ON u.id = f.owner_id WHERE f.workspace_id = ? AND f.archived_at IS NULL
               AND (f.name LIKE ? ESCAPE '\\' OR f.label LIKE ? ESCAPE '\\' OR f.content_text LIKE ? ESCAPE '\\') ${q.projectId ? 'AND f.project_id = ?' : ''}
             ORDER BY f.name LIKE ? ESCAPE '\\' DESC, f.updated_at DESC LIMIT 200`,
            ...[auth.workspaceId, like, like, like, ...(q.projectId ? [q.projectId] : []), like],
          )), (f) => canViewFile(db, auth, f)))
          .slice(0, q.limit)
          .map((f) => {
            const idx = (f.content_text ?? '').toLowerCase().indexOf(q.q.toLowerCase());
            return {
              id: f.id,
              name: f.name,
              label: f.label,
              owner_name: f.owner_name,
              updated_at: f.updated_at,
              external_url: f.external_url,
              snippet: idx >= 0 ? f.content_text.slice(Math.max(0, idx - 60), idx + 120) : null,
            };
          });
      }
      if (want('decisions')) {
        result.decisions = (await filterAsync((await db
          .all(
            `SELECT d.*, u.name AS decided_by_name, p.name AS project_name FROM decisions d JOIN users u ON u.id = d.decided_by LEFT JOIN projects p ON p.id = d.project_id
              WHERE d.workspace_id = ? AND (d.title LIKE ? ESCAPE '\\' OR d.rationale LIKE ? ESCAPE '\\') ORDER BY d.created_at DESC LIMIT 200`,
            auth.workspaceId,
            like,
            like,
          )), (d) => canViewDecision(db, auth, d)))
          .slice(0, q.limit);
      }
      if (want('meetings')) {
        result.meetings = (await filterAsync((await db
          .all(
            `SELECT * FROM meetings WHERE workspace_id = ? AND (title LIKE ? ESCAPE '\\' OR agenda LIKE ? ESCAPE '\\' OR notes LIKE ? ESCAPE '\\') ORDER BY starts_at DESC LIMIT 200`,
            auth.workspaceId,
            like,
            like,
            like,
          )), (m) => canViewMeeting(db, auth, m)))
          .slice(0, q.limit)
          .map((m) => ({ id: m.id, title: m.title, starts_at: m.starts_at, ended_at: m.ended_at }));
      }
      if (want('people')) {
        let people = await db.all(
          `SELECT u.id, u.name, u.title, u.color, u.expertise, m.role FROM memberships m JOIN users u ON u.id = m.user_id
            WHERE m.workspace_id = ? AND m.deactivated_at IS NULL AND (u.name LIKE ? ESCAPE '\\' OR u.title LIKE ? ESCAPE '\\' OR u.expertise LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\')
            ORDER BY u.name LIMIT 50`,
          auth.workspaceId,
          like,
          like,
          like,
          like,
        );
        if (isGuest(auth)) {
          const shared = new Set(
            (await db
              .all(
                `SELECT b.user_id FROM channel_members a JOIN channel_members b ON a.channel_id = b.channel_id WHERE a.user_id = ?
                 UNION SELECT b.user_id FROM project_members a JOIN project_members b ON a.project_id = b.project_id WHERE a.user_id = ?`,
                auth.userId,
                auth.userId,
              ))
              .map((r) => r.user_id),
          );
          people = people.filter((p) => shared.has(p.id));
        }
        result.people = people.slice(0, q.limit).map((p) => ({ ...p, expertise: parseJson<string[]>(p.expertise, []) }));
      }
    }
    res.json(result);
  });

  return r;
}
