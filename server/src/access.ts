import type { Database, Row } from './db.js';
import { forbidden, notFound } from './util.js';

/**
 * Central authorization. Every route, search result, activity feed entry,
 * notification link and export goes through these checks so that private
 * content never leaks through a derived surface (§3, §9, §14).
 */
export type Role = 'owner' | 'admin' | 'lead' | 'member' | 'guest';

export interface Auth {
  userId: string;
  workspaceId: string;
  role: Role;
  /** Set when the request is authenticated with a personal API token rather than a browser session. */
  tokenScope?: 'read' | 'write';
  /** The browser session behind the request (absent for API tokens). */
  sessionId?: string;
}

const RANK: Record<Role, number> = { guest: 0, member: 1, lead: 2, admin: 3, owner: 4 };

export const atLeast = (auth: Auth, role: Role) => RANK[auth.role] >= RANK[role];
export const isGuest = (auth: Auth) => auth.role === 'guest';
export const isAdmin = (auth: Auth) => atLeast(auth, 'admin');

export function requireRole(auth: Auth, role: Role) {
  if (!atLeast(auth, role)) throw forbidden(`This action requires the ${role} role or higher`);
}

export async function isActiveMember(db: Database, workspaceId: string, userId: string) {
  return !!await db.get(
    `SELECT 1 FROM memberships WHERE workspace_id = ? AND user_id = ? AND deactivated_at IS NULL
       AND (guest_expires_at IS NULL OR guest_expires_at > ?)`,
    workspaceId,
    userId,
    new Date().toISOString(),
  );
}

// ---------- Channels ----------

export async function isChannelMember(db: Database, channelId: string, userId: string) {
  return !!await db.get('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?', channelId, userId);
}

export function canViewChannel(db: Database, auth: Auth, channel: Row) {
  if (channel.workspace_id !== auth.workspaceId) return false;
  if (channel.kind === 'private' || channel.kind === 'dm' || isGuest(auth)) {
    return isChannelMember(db, channel.id, auth.userId);
  }
  return true;
}

export async function canPostChannel(db: Database, auth: Auth, channel: Row) {
  if (!await canViewChannel(db, auth, channel) || channel.archived_at) return false;
  if (channel.kind === 'announcement') return atLeast(auth, 'lead') || channel.created_by === auth.userId;
  return true;
}

export async function loadChannel(db: Database, auth: Auth, channelId: string) {
  const channel = await db.get('SELECT * FROM channels WHERE id = ?', channelId);
  if (!channel || !await canViewChannel(db, auth, channel)) throw notFound('Channel');
  return channel;
}

export async function accessibleChannelIds(db: Database, auth: Auth): Promise<string[]> {
  const rows = isGuest(auth)
    ? await db.all(
        `SELECT c.id FROM channels c JOIN channel_members m ON m.channel_id = c.id AND m.user_id = ?
          WHERE c.workspace_id = ?`,
        auth.userId,
        auth.workspaceId,
      )
    : await db.all(
        `SELECT c.id FROM channels c WHERE c.workspace_id = ? AND (
           c.kind IN ('public', 'announcement')
           OR EXISTS (SELECT 1 FROM channel_members m WHERE m.channel_id = c.id AND m.user_id = ?))`,
        auth.workspaceId,
        auth.userId,
      );
  return rows.map((r) => r.id);
}

// ---------- Projects ----------

export async function isProjectMember(db: Database, projectId: string, userId: string) {
  return !!await db.get('SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?', projectId, userId);
}

export function canViewProject(db: Database, auth: Auth, project: Row) {
  if (project.workspace_id !== auth.workspaceId) return false;
  if (project.visibility === 'private' || isGuest(auth)) return isProjectMember(db, project.id, auth.userId);
  return true;
}

/** Contribute to a project: create and update tasks, files, pages, updates. */
export async function canContributeProject(db: Database, auth: Auth, project: Row) {
  if (!await canViewProject(db, auth, project) || project.archived_at) return false;
  return !isGuest(auth) || await isProjectMember(db, project.id, auth.userId);
}

/** Manage a project: settings, membership, archive. */
export async function canManageProject(db: Database, auth: Auth, project: Row) {
  if (!await canViewProject(db, auth, project)) return false;
  if (project.owner_id === auth.userId || isAdmin(auth)) return true;
  return atLeast(auth, 'lead') && await isProjectMember(db, project.id, auth.userId);
}

export async function loadProject(db: Database, auth: Auth, projectId: string) {
  const project = await db.get('SELECT * FROM projects WHERE id = ?', projectId);
  if (!project || !await canViewProject(db, auth, project)) throw notFound('Project');
  return project;
}

export async function accessibleProjectIds(db: Database, auth: Auth): Promise<string[]> {
  const rows = isGuest(auth)
    ? await db.all(
        `SELECT p.id FROM projects p JOIN project_members m ON m.project_id = p.id AND m.user_id = ?
          WHERE p.workspace_id = ?`,
        auth.userId,
        auth.workspaceId,
      )
    : await db.all(
        `SELECT p.id FROM projects p WHERE p.workspace_id = ? AND (
           p.visibility = 'workspace'
           OR EXISTS (SELECT 1 FROM project_members m WHERE m.project_id = p.id AND m.user_id = ?))`,
        auth.workspaceId,
        auth.userId,
      );
  return rows.map((r) => r.id);
}

// ---------- Tasks ----------

export async function canViewTask(db: Database, auth: Auth, task: Row) {
  if (task.workspace_id !== auth.workspaceId) return false;
  if (task.project_id) {
    const project = await db.get('SELECT * FROM projects WHERE id = ?', task.project_id);
    return !!project && await canViewProject(db, auth, project);
  }
  return (
    task.owner_id === auth.userId ||
    task.created_by === auth.userId ||
    task.reviewer_id === auth.userId ||
    !!await db.get('SELECT 1 FROM task_collaborators WHERE task_id = ? AND user_id = ?', task.id, auth.userId)
  );
}

export async function canEditTask(db: Database, auth: Auth, task: Row) {
  if (!await canViewTask(db, auth, task)) return false;
  if (!task.project_id) return true;
  const project = (await db.get('SELECT * FROM projects WHERE id = ?', task.project_id))!;
  return await canContributeProject(db, auth, project) || task.owner_id === auth.userId;
}

export async function loadTask(db: Database, auth: Auth, taskId: string) {
  const task = await db.get('SELECT * FROM tasks WHERE id = ?', taskId);
  if (!task || !await canViewTask(db, auth, task)) throw notFound('Task');
  return task;
}

// ---------- Knowledge, files, meetings, decisions ----------

export async function canViewPage(db: Database, auth: Auth, page: Row) {
  if (page.workspace_id !== auth.workspaceId) return false;
  if (page.project_id) {
    const project = await db.get('SELECT * FROM projects WHERE id = ?', page.project_id);
    return !!project && await canViewProject(db, auth, project);
  }
  return !isGuest(auth);
}

export async function canViewFile(db: Database, auth: Auth, file: Row) {
  if (file.workspace_id !== auth.workspaceId) return false;
  if (file.project_id) {
    const project = await db.get('SELECT * FROM projects WHERE id = ?', file.project_id);
    return !!project && await canViewProject(db, auth, project);
  }
  if (file.channel_id) {
    const channel = await db.get('SELECT * FROM channels WHERE id = ?', file.channel_id);
    return !!channel && await canViewChannel(db, auth, channel);
  }
  if (file.task_id) {
    const task = await db.get('SELECT * FROM tasks WHERE id = ?', file.task_id);
    return !!task && await canViewTask(db, auth, task);
  }
  return !isGuest(auth) || file.owner_id === auth.userId;
}

export async function canViewMeeting(db: Database, auth: Auth, meeting: Row) {
  if (meeting.workspace_id !== auth.workspaceId) return false;
  if (meeting.organizer_id === auth.userId) return true;
  if (await db.get('SELECT 1 FROM meeting_participants WHERE meeting_id = ? AND user_id = ?', meeting.id, auth.userId)) {
    return true;
  }
  if (meeting.project_id) {
    const project = await db.get('SELECT * FROM projects WHERE id = ?', meeting.project_id);
    if (project && await canViewProject(db, auth, project)) return true;
  }
  if (meeting.channel_id) {
    const channel = await db.get('SELECT * FROM channels WHERE id = ?', meeting.channel_id);
    if (channel && await canViewChannel(db, auth, channel)) return true;
  }
  return false;
}

export async function canViewDecision(db: Database, auth: Auth, decision: Row) {
  if (decision.workspace_id !== auth.workspaceId) return false;
  if (decision.project_id) {
    const project = await db.get('SELECT * FROM projects WHERE id = ?', decision.project_id);
    return !!project && await canViewProject(db, auth, project);
  }
  if (decision.channel_id) {
    const channel = await db.get('SELECT * FROM channels WHERE id = ?', decision.channel_id);
    return !!channel && await canViewChannel(db, auth, channel);
  }
  if (decision.meeting_id) {
    const meeting = await db.get('SELECT * FROM meetings WHERE id = ?', decision.meeting_id);
    return !!meeting && await canViewMeeting(db, auth, meeting);
  }
  return !isGuest(auth);
}

/** Activity entries inherit the visibility of the project or channel they belong to. */
export function canViewActivity(auth: Auth, entry: Row, projects: Set<string>, channels: Set<string>) {
  if (entry.project_id) return projects.has(entry.project_id);
  if (entry.channel_id) return channels.has(entry.channel_id);
  if (entry.object_type === 'task' || entry.object_type === 'meeting') return entry.actor_id === auth.userId;
  return !isGuest(auth);
}
