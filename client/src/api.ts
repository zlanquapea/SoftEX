/** Typed client for the SoftEX REST API. All requests use the session cookie. */

export class ApiError extends Error {
  constructor(public status: number, message: string, public details?: any) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, credentials: 'same-origin', headers: {} };
  if (body instanceof FormData) {
    init.body = body;
  } else if (body !== undefined) {
    (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`/api${path}`, init);
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = new ApiError(res.status, data?.error ?? res.statusText, data?.details);
    if (res.status === 401 && !path.startsWith('/auth') && !path.startsWith('/invitations')) {
      window.dispatchEvent(new CustomEvent('softex:unauthorized'));
    }
    if (res.status === 403 && data?.details?.code === 'mfa_setup_required') {
      window.dispatchEvent(new CustomEvent('softex:mfa-required'));
    }
    throw err;
  }
  return data as T;
}

export const api = {
  get: <T = any>(path: string) => request<T>('GET', path),
  post: <T = any>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  patch: <T = any>(path: string, body: unknown) => request<T>('PATCH', path, body),
  put: <T = any>(path: string, body: unknown) => request<T>('PUT', path, body),
  del: <T = any>(path: string) => request<T>('DELETE', path),
  upload: <T = any>(path: string, form: FormData) => request<T>('POST', path, form),
};

export const qs = (params: Record<string, string | number | boolean | undefined | null>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') s.set(k, String(v));
  const str = s.toString();
  return str ? `?${str}` : '';
};

// ---------- Shared types ----------

export type Role = 'owner' | 'admin' | 'lead' | 'member' | 'guest';

export interface UserRef {
  id: string;
  name: string;
  color: string;
  title?: string;
  status?: string;
}

export interface Me {
  user: {
    id: string;
    name: string;
    email: string;
    title: string;
    timezone: string;
    working_hours: string;
    expertise: string[];
    status: string;
    status_text: string;
    focus_until: string | null;
    quiet_start: string | null;
    quiet_end: string | null;
    color: string;
    mfa_enabled: boolean;
  };
  workspace: {
    id: string;
    name: string;
    message_edit_policy: 'author' | 'admins' | 'none';
    guest_default_days: number;
    require_mfa: boolean;
    member_count: number;
  };
  role: Role;
  guest_expires_at: string | null;
  mfa_setup_required: boolean;
  workspaces: { id: string; name: string; role: Role }[];
}

export interface Channel {
  id: string;
  name: string;
  topic: string;
  kind: 'public' | 'private' | 'announcement' | 'dm';
  project_id: string | null;
  project_name: string | null;
  joined: boolean;
  notify: 'all' | 'mentions' | 'none';
  unread: number;
  mentions: number;
  members?: (UserRef & { status: string })[];
  last_message_at: string | null;
}

export interface Message {
  id: string;
  channel_id: string;
  parent_id: string | null;
  user: UserRef | null;
  body: string;
  urgent: boolean;
  created_at: string;
  edited_at: string | null;
  deleted: boolean;
  pinned: boolean;
  saved: boolean;
  reactions: { emoji: string; count: number; mine: boolean }[];
  reply_count: number;
  last_reply_at: string | null;
  ack_count: number;
  acked: boolean;
  files: { id: string; name: string; mime: string; size: number }[];
  tasks: { id: string; title: string; status: TaskStatus }[];
  decisions: { id: string; title: string }[];
}

export type TaskStatus = 'todo' | 'in_progress' | 'blocked' | 'review' | 'done';
export type Priority = 'low' | 'medium' | 'high' | 'urgent';

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: Priority;
  due_date: string | null;
  overdue: boolean;
  blocked_reason: string;
  recurrence: string | null;
  position: number;
  project: { id: string; name: string; color: string } | null;
  milestone_id: string | null;
  parent_id: string | null;
  owner: UserRef | null;
  reviewer: UserRef | null;
  source_message_id: string | null;
  meeting_id: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  checklist: { total: number; done: number };
  subtasks: { total: number; done: number };
  comment_count: number;
  waiting_on: number;
}

export type Health = 'on_track' | 'at_risk' | 'off_track';

export interface Project {
  id: string;
  name: string;
  description: string;
  color: string;
  visibility: 'workspace' | 'private';
  health: Health;
  due_date: string | null;
  archived_at: string | null;
  owner: UserRef | null;
  team: { id: string; name: string } | null;
  members: UserRef[];
  member_count: number;
  is_member: boolean;
  next_milestone: { id: string; name: string; due_date: string | null } | null;
  stats: { total: number; done: number; blocked: number; overdue: number; progress: number };
  updated_at: string;
}

export interface Person extends UserRef {
  email: string;
  timezone: string;
  working_hours: string;
  expertise: string[];
  status: string;
  status_text: string;
  focus_until: string | null;
  role: Role;
  guest_expires_at: string | null;
  sponsor_name: string | null;
  online: boolean;
  teams: { id: string; name: string }[];
}

export interface Notification {
  id: string;
  kind: string;
  title: string;
  body: string;
  link: string;
  actor_id: string | null;
  actor_name?: string;
  actor_color?: string;
  urgent: number;
  read_at: string | null;
  created_at: string;
}

export interface Meeting {
  id: string;
  title: string;
  starts_at: string;
  ends_at: string;
  duration_min: number;
  location: string;
  video_url: string;
  project: { id: string; name: string; color: string } | null;
  channel_id: string | null;
  organizer: UserRef | null;
  started_at: string | null;
  ended_at: string | null;
  participants: (UserRef & { response: string; timezone: string })[];
}

export interface Decision {
  id: string;
  title: string;
  rationale: string;
  project_id: string | null;
  project_name?: string | null;
  channel_id: string | null;
  channel_name?: string | null;
  message_id: string | null;
  meeting_id: string | null;
  meeting_title?: string | null;
  decided_by: string;
  decided_by_name: string;
  created_at: string;
}

export interface Activity {
  id: string;
  actor_id: string;
  actor_name: string;
  actor_color: string;
  verb: string;
  object_type: string;
  summary: string;
  link: string;
  created_at: string;
}
