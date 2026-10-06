/** Shared types, kept in step with the web app's client/src/api.ts. */


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
    email_digest: boolean;
    email_urgent: boolean;
    email_verified: boolean;
  };
  workspace: {
    id: string;
    name: string;
    message_edit_policy: 'author' | 'admins' | 'none';
    guest_default_days: number;
    require_mfa: boolean;
    member_count: number;
    sso_enabled: boolean;
    sso_required: boolean;
    ai_enabled: boolean;
    ai_available: boolean;
    retention_days: number | null;
    legal_hold: boolean;
    plan: PlanInfo;
  };
  mode: 'self_hosted' | 'saas';
  operator: boolean;
  role: Role;
  guest_expires_at: string | null;
  mfa_setup_required: boolean;
  workspaces: { id: string; name: string; role: Role }[];
}

export type Feature = 'ai' | 'automations' | 'planning' | 'insights' | 'guests' | 'api' | 'sso' | 'scim' | 'retention' | 'fields' | 'goals' | 'recordings';

export type PlanId = 'free' | 'starter' | 'team' | 'organization' | 'enterprise';

export interface PlanInfo {
  id: PlanId | 'unlimited';
  name: string;
  status: 'self_hosted' | 'trial' | 'active' | 'grace' | 'free';
  trial_ends_at: string | null;
  paid_through: string | null;
  features: Feature[];
  member_limit: number | null;
  priority_support: boolean;
}

export interface PublicPlan {
  id: PlanId;
  name: string;
  /** Per workspace per month in USD; null means priced by quote. */
  price: number | null;
  member_limit: number | null;
  storage_gb: number;
  ai_per_month: number;
  recording_hours: number | null;
  priority_support: boolean;
  /** Can an admin pay for it from the billing screen? */
  self_serve: boolean;
  features: Feature[];
  tagline: string;
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
  last_message?: { text: string; mine: boolean };
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
  poll?: MessagePoll | null;
  forwarded?: ForwardedMessage | null;
}

export interface MessagePoll {
  id: string;
  question: string;
  multiple: boolean;
  anonymous: boolean;
  closed: boolean;
  voters: number;
  options: { label: string; votes: number; voters: string[] }[];
  my_votes: number[];
}

export interface ForwardedMessage {
  id?: string;
  deleted: boolean;
  body?: string;
  created_at?: string;
  channel_id?: string;
  channel_name?: string | null;
  user?: { name: string; color: string };
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
  start_date: string | null;
  estimate_hours: number | null;
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
  labels?: Label[];
  fields?: Record<string, unknown>;
  time_minutes?: number;
}

export type LabelColor = 'purple' | 'blue' | 'green' | 'coral' | 'gold' | 'sky' | 'mint' | 'lilac' | 'orange';
export const LABEL_COLORS: LabelColor[] = ['purple', 'blue', 'green', 'coral', 'gold', 'sky', 'mint', 'lilac', 'orange'];

export interface Label {
  id: string;
  name: string;
  color: LabelColor;
  task_count?: number;
}

export type FieldType = 'text' | 'number' | 'date' | 'select' | 'person' | 'checkbox' | 'url';

export interface CustomField {
  id: string;
  project_id: string;
  name: string;
  type: FieldType;
  options: { label: string; color: LabelColor }[];
  position: number;
}

export interface TimeEntry {
  id: string;
  task_id: string;
  user: UserRef | null;
  started_at: string;
  ended_at: string | null;
  minutes: number;
  running: boolean;
  note: string;
  task_title?: string;
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
