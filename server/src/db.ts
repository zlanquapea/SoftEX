import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { PeerLink } from './realtime.js';

/**
 * Relational schema for the Küü core records (see §4 and §12 of the product
 * documentation). The same portable SQL runs on SQLite (the default: a single
 * file, nothing to install) and on PostgreSQL (set SOFTEX_DATABASE_URL), which
 * lets several Küü servers share one database.
 */
const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  message_edit_policy TEXT NOT NULL DEFAULT 'author',  -- author | admins | none
  guest_default_days INTEGER NOT NULL DEFAULT 30,
  require_mfa INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  timezone TEXT NOT NULL DEFAULT 'UTC',
  working_hours TEXT NOT NULL DEFAULT '09:00-17:00',
  expertise TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'available',        -- available | focus | away | busy
  status_text TEXT NOT NULL DEFAULT '',
  focus_until TEXT,
  quiet_start TEXT,
  quiet_end TEXT,
  color TEXT NOT NULL DEFAULT 'purple',
  mfa_secret TEXT,
  mfa_enabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memberships (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL,                                -- owner | admin | lead | member | guest
  sponsor_id TEXT REFERENCES users(id),
  guest_expires_at TEXT,
  deactivated_at TEXT,
  last_seen_home_at TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS invitations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  invited_by TEXT NOT NULL REFERENCES users(id),
  guest_days INTEGER,
  channel_ids TEXT NOT NULL DEFAULT '[]',
  project_ids TEXT NOT NULL DEFAULT '[]',
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS team_members (
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (team_id, user_id)
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  team_id TEXT REFERENCES teams(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT 'purple',
  visibility TEXT NOT NULL DEFAULT 'workspace',     -- workspace | private
  health TEXT NOT NULL DEFAULT 'on_track',          -- on_track | at_risk | off_track
  owner_id TEXT NOT NULL REFERENCES users(id),
  due_date TEXT,
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_members (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (project_id, user_id)
);

CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  team_id TEXT REFERENCES teams(id) ON DELETE SET NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  topic TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,                               -- public | private | announcement | dm
  created_by TEXT NOT NULL REFERENCES users(id),
  archived_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS channel_members (
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_at TEXT,
  notify TEXT NOT NULL DEFAULT 'all',               -- all | mentions | none
  joined_at TEXT NOT NULL,
  PRIMARY KEY (channel_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  parent_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  urgent INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  edited_at TEXT,
  deleted_at TEXT,
  pinned_at TEXT,
  pinned_by TEXT REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_parent ON messages(parent_id);

CREATE TABLE IF NOT EXISTS reactions (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL,
  PRIMARY KEY (message_id, user_id, emoji)
);

CREATE TABLE IF NOT EXISTS saved_messages (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, message_id)
);

CREATE TABLE IF NOT EXISTS acknowledgements (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (message_id, user_id)
);

CREATE TABLE IF NOT EXISTS milestones (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  due_date TEXT,
  done_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meetings (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  channel_id TEXT REFERENCES channels(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  agenda TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  starts_at TEXT NOT NULL,
  duration_min INTEGER NOT NULL DEFAULT 30,
  location TEXT NOT NULL DEFAULT '',
  video_url TEXT NOT NULL DEFAULT '',
  organizer_id TEXT NOT NULL REFERENCES users(id),
  started_at TEXT,
  ended_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meeting_participants (
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  response TEXT NOT NULL DEFAULT 'pending',         -- pending | accepted | declined
  PRIMARY KEY (meeting_id, user_id)
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  milestone_id TEXT REFERENCES milestones(id) ON DELETE SET NULL,
  parent_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  owner_id TEXT REFERENCES users(id),
  reviewer_id TEXT REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'todo',              -- todo | in_progress | blocked | review | done
  priority TEXT NOT NULL DEFAULT 'medium',          -- low | medium | high | urgent
  due_date TEXT,
  blocked_reason TEXT NOT NULL DEFAULT '',
  recurrence TEXT,                                  -- null | daily | weekly | monthly
  position REAL NOT NULL DEFAULT 0,
  source_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  meeting_id TEXT REFERENCES meetings(id) ON DELETE SET NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_owner ON tasks(owner_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id, status);

CREATE TABLE IF NOT EXISTS task_collaborators (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, user_id)
);

CREATE TABLE IF NOT EXISTS task_dependencies (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, depends_on_id)
);

CREATE TABLE IF NOT EXISTS checklist_items (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS task_comments (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS status_updates (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  health TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS risks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  impact TEXT NOT NULL DEFAULT 'medium',            -- low | medium | high
  mitigation TEXT NOT NULL DEFAULT '',
  owner_id TEXT REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'open',              -- open | mitigated | closed
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  channel_id TEXT REFERENCES channels(id) ON DELETE SET NULL,
  message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  meeting_id TEXT REFERENCES meetings(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  rationale TEXT NOT NULL DEFAULT '',
  decided_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  channel_id TEXT REFERENCES channels(id) ON DELETE CASCADE,
  message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  owner_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  external_url TEXT,
  current_version INTEGER NOT NULL DEFAULT 1,
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS file_versions (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  storage_key TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  uploaded_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pages (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft',             -- draft | approved
  owner_id TEXT NOT NULL REFERENCES users(id),
  review_date TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS page_versions (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  edited_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS checkins (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  done TEXT NOT NULL DEFAULT '',
  next TEXT NOT NULL DEFAULT '',
  blockers TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                               -- access | purchase | leave | support | other
  title TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  requester_id TEXT NOT NULL REFERENCES users(id),
  approver_id TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'pending',           -- pending | approved | rejected | cancelled
  resolution_note TEXT NOT NULL DEFAULT '',
  decided_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS onboarding_items (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  role TEXT,                                        -- null applies to everyone
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  link TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS onboarding_progress (
  item_id TEXT NOT NULL REFERENCES onboarding_items(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  done_at TEXT NOT NULL,
  PRIMARY KEY (item_id, user_id)
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                               -- mention | assigned | status | meeting | comment | request | decision | announcement | dm
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  link TEXT NOT NULL DEFAULT '',
  actor_id TEXT REFERENCES users(id),
  urgent INTEGER NOT NULL DEFAULT 0,
  read_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read_at);

CREATE TABLE IF NOT EXISTS activity (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL REFERENCES users(id),
  verb TEXT NOT NULL,
  object_type TEXT NOT NULL,
  object_id TEXT NOT NULL,
  project_id TEXT,
  channel_id TEXT,
  summary TEXT NOT NULL,
  link TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activity_ws ON activity(workspace_id, created_at);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_id TEXT REFERENCES users(id),
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_ws ON audit_events(workspace_id, created_at);
CREATE TABLE IF NOT EXISTS outbound_emails (
  id TEXT PRIMARY KEY,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  text TEXT NOT NULL,
  html TEXT NOT NULL DEFAULT '',
  attachments TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'queued',            -- queued | sent | failed | logged (no SMTP configured)
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  next_attempt_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  sent_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_outbound_status ON outbound_emails(status, next_attempt_at);

CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sso_states (
  state TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  nonce TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_tokens (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'read',               -- read | write
  last_used_at TEXT,
  expires_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS webhooks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  events TEXT NOT NULL DEFAULT '[]',
  secret TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  description TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id TEXT PRIMARY KEY,
  webhook_id TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',           -- pending | delivered | failed
  attempts INTEGER NOT NULL DEFAULT 0,
  response_status INTEGER,
  last_error TEXT,
  next_attempt_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  delivered_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries ON webhook_deliveries(status, next_attempt_at);

CREATE TABLE IF NOT EXISTS automations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  trigger_type TEXT NOT NULL,                       -- task.status_changed | task.created | task.overdue
  trigger_config TEXT NOT NULL DEFAULT '{}',
  action_type TEXT NOT NULL,                        -- assign | set_priority | notify | post_message | add_checklist
  action_config TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  run_count INTEGER NOT NULL DEFAULT 0,
  last_run_at TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS automation_runs (
  id TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  task_id TEXT,
  outcome TEXT NOT NULL,                            -- done | skipped | error
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reminders (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  note TEXT NOT NULL DEFAULT '',
  remind_at TEXT NOT NULL,
  sent_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(sent_at, remind_at);

CREATE TABLE IF NOT EXISTS scheduled_messages (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  send_at TEXT NOT NULL,
  sent_message_id TEXT,
  failed_reason TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scheduled_due ON scheduled_messages(sent_message_id, send_at);

CREATE TABLE IF NOT EXISTS email_verifications (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_usage (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT,
  feature TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_usage ON ai_usage(workspace_id, created_at);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  submitted_by TEXT NOT NULL REFERENCES users(id),
  plan TEXT NOT NULL,                               -- standard | business
  months INTEGER NOT NULL,
  seats INTEGER NOT NULL,
  amount REAL NOT NULL,                             -- USD
  method TEXT NOT NULL,                             -- orange_money | mtn_momo | bank | other
  reference TEXT NOT NULL,
  payer_name TEXT NOT NULL DEFAULT '',
  payer_phone TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',           -- pending | approved | rejected | cancelled
  decided_by TEXT,
  decided_at TEXT,
  decision_note TEXT NOT NULL DEFAULT '',
  period_start TEXT,
  period_end TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status, created_at);

CREATE TABLE IF NOT EXISTS billing_notices (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  ref TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, kind, ref)
);

-- Large realtime events passed between servers by reference (kept for an hour).
CREATE TABLE IF NOT EXISTS realtime_events (
  id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Sign-in and similar attempt counters, shared by every server (keys are hashes).
CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  reset_at TEXT NOT NULL
);

-- Service-level log kept by the operator; outlives deleted workspaces on purpose.
CREATE TABLE IF NOT EXISTS platform_events (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  workspace_id TEXT,
  workspace_name TEXT,
  detail TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

-- Server-wide values shared by every Küü server, such as the Web Push key pair.
CREATE TABLE IF NOT EXISTS server_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Devices that receive push notifications; each belongs to a browser session.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  created_at TEXT NOT NULL,
  last_success_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id);

-- Private calendar subscription links ("add Küü meetings to Google Calendar / Outlook").
CREATE TABLE IF NOT EXISTS calendar_feeds (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  UNIQUE (user_id, workspace_id)
);

CREATE TABLE IF NOT EXISTS deadline_reminders (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  due_date TEXT NOT NULL,
  kind TEXT NOT NULL,                               -- due_soon | overdue
  created_at TEXT NOT NULL,
  PRIMARY KEY (task_id, due_date, kind)
);
`;

/**
 * Columns added after the first release. Applied idempotently on start-up so
 * existing databases upgrade in place without a separate migration step. A
 * backfill runs once, only when the column is first added.
 */
type Backfill = string | { sqlite: string; postgres: string };
const ADDED_COLUMNS: [table: string, column: string, definition: string, backfill?: Backfill][] = [
  ['users', 'email_digest', 'INTEGER NOT NULL DEFAULT 1'],
  ['users', 'email_urgent', 'INTEGER NOT NULL DEFAULT 1'],
  ['users', 'last_digest_at', 'TEXT'],
  ['workspaces', 'sso_enabled', 'INTEGER NOT NULL DEFAULT 0'],
  ['workspaces', 'sso_issuer', 'TEXT'],
  ['workspaces', 'sso_client_id', 'TEXT'],
  ['workspaces', 'sso_client_secret', 'TEXT'],
  ['workspaces', 'sso_domain', 'TEXT'],
  ['workspaces', 'sso_required', 'INTEGER NOT NULL DEFAULT 0'],
  ['workspaces', 'sso_auto_provision', 'INTEGER NOT NULL DEFAULT 1'],
  ['workspaces', 'ai_enabled', 'INTEGER NOT NULL DEFAULT 0'],
  ['channels', 'ai_excluded', 'INTEGER NOT NULL DEFAULT 0'],
  ['projects', 'ai_excluded', 'INTEGER NOT NULL DEFAULT 0'],
  ['files', 'content_text', 'TEXT'],
  ['tasks', 'start_date', 'TEXT'],
  ['tasks', 'estimate_hours', 'REAL'],
  ['workspaces', 'retention_days', 'INTEGER'],
  ['workspaces', 'legal_hold', 'INTEGER NOT NULL DEFAULT 0'],
  ['workspaces', 'scim_token_hash', 'TEXT'],
  ['memberships', 'scim_external_id', 'TEXT'],
  // Accounts that existed before email verification count as verified.
  ['users', 'email_verified_at', 'TEXT', 'UPDATE users SET email_verified_at = created_at'],
  ['workspaces', 'plan', "TEXT NOT NULL DEFAULT 'free'"],
  // Workspaces that existed before plans get a fresh 30-day trial when a server switches to SaaS mode.
  [
    'workspaces',
    'trial_ends_at',
    'TEXT',
    {
      sqlite: "UPDATE workspaces SET trial_ends_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+30 days')",
      postgres: `UPDATE workspaces SET trial_ends_at = to_char((now() AT TIME ZONE 'UTC') + interval '30 days', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
    },
  ],
  ['workspaces', 'paid_through', 'TEXT'],
  ['workspaces', 'suspended_at', 'TEXT'],
  ['workspaces', 'suspended_reason', 'TEXT'],
  ['users', 'terms_accepted_at', 'TEXT'],
  ['users', 'terms_version', 'TEXT'],
  // Sessions get a public id (never the token hash itself) and device details for "Where you're signed in".
  ['sessions', 'id', 'TEXT', "UPDATE sessions SET id = substr(token_hash, 1, 24)"],
  ['sessions', 'user_agent', 'TEXT'],
  ['sessions', 'ip', 'TEXT'],
  ['sessions', 'last_seen_at', 'TEXT', 'UPDATE sessions SET last_seen_at = created_at'],
];

export type Row = Record<string, any>;
export type SqlValue = string | number | bigint | boolean | null | Uint8Array | Record<string, unknown> | unknown[];

/**
 * Async access to the database. All queries use `?` placeholders and SQLite-flavoured
 * SQL; the PostgreSQL engine translates placeholders, `INSERT OR IGNORE` and
 * case-insensitive `LIKE`. Inside `transaction(fn)`, every query made by `fn` (and
 * anything it awaits) runs in the same transaction.
 */
export interface Database {
  readonly dialect: 'sqlite' | 'postgres';
  /** Resolves once the schema is in place (queries wait for it automatically). */
  readonly ready: Promise<void>;
  all<T = Row>(sql: string, ...params: SqlValue[]): Promise<T[]>;
  get<T = Row>(sql: string, ...params: SqlValue[]): Promise<T | undefined>;
  run(sql: string, ...params: SqlValue[]): Promise<{ changes: number }>;
  /** Insert a row from an object; undefined values are skipped. */
  insert(table: string, values: Row): Promise<{ changes: number }>;
  /** Update whitelisted columns on a row by id. */
  update(table: string, id: string, values: Row): Promise<void>;
  transaction<T>(fn: () => Promise<T>): Promise<T>;
  /**
   * Run `fn` only if no other Küü server is running the same job right now
   * (a PostgreSQL advisory lock; always runs on SQLite, which has one server).
   */
  exclusive<T>(key: string, fn: () => Promise<T>): Promise<T | undefined>;
  /**
   * Run `fn` once the current transaction commits (dropped if it rolls back), or now when
   * there is no transaction. Used for side effects such as realtime events.
   */
  afterCommit(fn: () => Promise<unknown>): Promise<void>;
  /** Messaging between servers that share this database (PostgreSQL only). */
  peerLink(): PeerLink | undefined;
  close(): Promise<void>;
}

/**
 * SQL for "start plus N minutes, compared with an ISO timestamp parameter", which the two
 * engines write differently. Returns [endExpression, parameterExpression].
 */
export function minutesAfter(db: Database, start: string, minutes: string): [end: string, param: string] {
  return db.dialect === 'postgres'
    ? [`(${start}::timestamptz + ${minutes} * interval '1 minute')`, '?::timestamptz']
    : [`datetime(${start}, '+' || ${minutes} || ' minutes')`, 'datetime(?)'];
}

/** SQL for the number of days between two ISO timestamp columns. */
export function daysBetween(db: Database, from: string, to: string) {
  return db.dialect === 'postgres' ? `(EXTRACT(EPOCH FROM (${to}::timestamptz - ${from}::timestamptz)) / 86400)` : `(julianday(${to}) - julianday(${from}))`;
}

/** Open SQLite (a file path or ':memory:') or PostgreSQL (a postgres:// URL). */
export function openDatabase(target: string): Database {
  return /^postgres(ql)?:\/\//.test(target) ? new PostgresDatabase(target) : new SqliteDatabase(target);
}

function toSql(value: unknown): SqlValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'object' && !(value instanceof Uint8Array)) return JSON.stringify(value);
  return value as SqlValue;
}

abstract class BaseDatabase implements Database {
  abstract readonly dialect: 'sqlite' | 'postgres';
  abstract readonly ready: Promise<void>;
  abstract all<T = Row>(sql: string, ...params: SqlValue[]): Promise<T[]>;
  abstract run(sql: string, ...params: SqlValue[]): Promise<{ changes: number }>;
  abstract transaction<T>(fn: () => Promise<T>): Promise<T>;
  abstract exclusive<T>(key: string, fn: () => Promise<T>): Promise<T | undefined>;
  abstract close(): Promise<void>;
  protected abstract pending(): (() => Promise<unknown>)[] | undefined;

  async afterCommit(fn: () => Promise<unknown>) {
    const queue = this.pending();
    if (queue) queue.push(fn);
    else await fn();
  }

  /** Run queued after-commit work outside the finished transaction; failures are logged. */
  protected async flush(queue: (() => Promise<unknown>)[]) {
    for (const fn of queue) await fn().catch((error) => console.error('After-commit task failed', error));
  }

  peerLink(): PeerLink | undefined {
    return undefined;
  }

  async get<T = Row>(sql: string, ...params: SqlValue[]): Promise<T | undefined> {
    return (await this.all<T>(sql, ...params))[0];
  }

  insert(table: string, values: Row) {
    const entries = Object.entries(values).filter(([, v]) => v !== undefined);
    const cols = entries.map(([k]) => k).join(', ');
    const marks = entries.map(() => '?').join(', ');
    return this.run(`INSERT INTO ${table} (${cols}) VALUES (${marks})`, ...entries.map(([, v]) => toSql(v)));
  }

  async update(table: string, id: string, values: Row) {
    const entries = Object.entries(values).filter(([, v]) => v !== undefined);
    if (!entries.length) return;
    const set = entries.map(([k]) => `${k} = ?`).join(', ');
    await this.run(`UPDATE ${table} SET ${set} WHERE id = ?`, ...entries.map(([, v]) => toSql(v)), id);
  }
}

// ======================= SQLite =======================

/**
 * One connection, used by one server. Statements are synchronous; a transaction
 * that awaits in the middle holds a lock so queries from other requests wait
 * instead of slipping into it.
 */
class SqliteDatabase extends BaseDatabase {
  readonly dialect = 'sqlite' as const;
  readonly ready = Promise.resolve();
  private readonly raw: DatabaseSync;
  private readonly inTx = new AsyncLocalStorage<{ after: (() => Promise<unknown>)[] }>();
  private active: Promise<void> | null = null;

  constructor(path: string) {
    super();
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path);
    this.raw.exec('PRAGMA journal_mode = WAL;');
    this.raw.exec('PRAGMA busy_timeout = 5000;');
    this.raw.exec(SCHEMA);
    for (const [table, column, definition, backfill] of ADDED_COLUMNS) {
      const exists = (this.raw.prepare(`PRAGMA table_info(${table})`).all() as Row[]).some((c) => c.name === column);
      if (!exists) {
        this.raw.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
        if (backfill) this.raw.exec(typeof backfill === 'string' ? backfill : backfill.sqlite);
      }
    }
  }

  /** Wait while another request's transaction is open. */
  private async turn() {
    while (this.active && !this.inTx.getStore()) await this.active;
  }

  async all<T = Row>(sql: string, ...params: SqlValue[]): Promise<T[]> {
    await this.turn();
    return this.raw.prepare(sql).all(...(params.map(toSql) as SQLInputValue[])) as T[];
  }

  async run(sql: string, ...params: SqlValue[]) {
    await this.turn();
    const res = this.raw.prepare(sql).run(...(params.map(toSql) as SQLInputValue[]));
    return { changes: Number(res.changes) };
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    if (this.inTx.getStore()) return fn();
    await this.turn();
    let release!: () => void;
    this.active = new Promise((resolve) => (release = resolve));
    const store = { after: [] as (() => Promise<unknown>)[] };
    this.raw.exec('BEGIN');
    let result: T;
    try {
      result = await this.inTx.run(store, fn);
      this.raw.exec('COMMIT');
    } catch (error) {
      this.raw.exec('ROLLBACK');
      throw error;
    } finally {
      this.active = null;
      release();
    }
    await this.flush(store.after);
    return result;
  }

  protected pending() {
    return this.inTx.getStore()?.after;
  }

  async exclusive<T>(_key: string, fn: () => Promise<T>) {
    return fn();
  }

  async close() {
    this.raw.close();
  }
}

// ======================= PostgreSQL =======================

// COUNT(*) and SUM() come back as int8/numeric strings; Küü's values fit in a JS number.
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));

const translations = new Map<string, string>();

/** Translate Küü's SQLite-flavoured SQL to PostgreSQL. */
export function toPostgres(sql: string) {
  let out = translations.get(sql);
  if (out) return out;
  // Null-safe comparison with a parameter: SQLite's `IS ?` is PostgreSQL's `IS NOT DISTINCT FROM`.
  let source = sql.replace(/\bIS\s+NOT\s+\?/gi, 'IS DISTINCT FROM ?').replace(/\bIS\s+\?/gi, 'IS NOT DISTINCT FROM ?');
  // Functions with different names: instr → strpos (same argument order), GROUP_CONCAT → string_agg.
  source = source.replace(/\binstr\(/gi, 'strpos(').replace(/\bGROUP_CONCAT\(([^()]*)\)/gi, "string_agg($1, ',')");
  let n = 0;
  let text = '';
  let quoted = false;
  for (const ch of source) {
    if (ch === "'") quoted = !quoted;
    text += ch === '?' && !quoted ? `$${++n}` : ch;
  }
  if (/\bINSERT\s+OR\s+IGNORE\s+INTO\b/i.test(text)) {
    text = `${text.replace(/\bINSERT\s+OR\s+IGNORE\s+INTO\b/i, 'INSERT INTO')} ON CONFLICT DO NOTHING`;
  }
  // SQLite's LIKE ignores case (for ASCII); PostgreSQL's ILIKE does the same.
  text = text.replace(/\bLIKE\b/g, 'ILIKE');
  out = text;
  translations.set(sql, out);
  return out;
}

/** The shared schema with PostgreSQL types: 64-bit integers and double-precision reals. */
const pgType = (definition: string) => definition.replace(/\bINTEGER\b/g, 'BIGINT').replace(/\bREAL\b/g, 'DOUBLE PRECISION');

const lockId = (key: string) => {
  let h = 0;
  for (const ch of key) h = (Math.imul(h, 31) + ch.charCodeAt(0)) | 0;
  return h;
};

class PostgresDatabase extends BaseDatabase {
  readonly dialect = 'postgres' as const;
  readonly ready: Promise<void>;
  private readonly pool: pg.Pool;
  private readonly tx = new AsyncLocalStorage<{ client: pg.PoolClient; after: (() => Promise<unknown>)[] }>();
  private readonly url: string;

  private readonly schema?: string;

  constructor(url: string) {
    super();
    // Optional ?schema=name keeps Küü's tables in their own PostgreSQL schema.
    const parsed = new URL(url);
    const schema = parsed.searchParams.get('schema') ?? undefined;
    if (schema && !/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error('schema must be lowercase letters, digits and underscores');
    parsed.searchParams.delete('schema');
    this.schema = schema;
    this.url = parsed.toString();
    this.pool = new pg.Pool({
      connectionString: parsed.toString(),
      max: Number(process.env.SOFTEX_DB_POOL_SIZE ?? 10),
      options: schema ? `-c search_path=${schema}` : undefined,
    });
    this.pool.on('error', (error) => console.error('PostgreSQL connection error', error));
    this.ready = this.migrate();
    // Avoid an unhandled rejection before the first query; callers see the error from `ready`.
    this.ready.catch(() => {});
  }

  private async migrate() {
    const client = await this.pool.connect();
    try {
      // Several servers may start at once; only one migrates at a time.
      await client.query('SELECT pg_advisory_lock($1)', [lockId('softex:migrate')]);
      if (this.schema) await client.query(`CREATE SCHEMA IF NOT EXISTS ${this.schema}`);
      await client.query(pgType(SCHEMA.replace(/PRAGMA[^;]*;/g, '')));
      const existing = new Set(
        (await client.query(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema()`)).rows.map(
          (r) => `${r.table_name}.${r.column_name}`,
        ),
      );
      for (const [table, column, definition, backfill] of ADDED_COLUMNS) {
        if (existing.has(`${table}.${column}`)) continue;
        await client.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${pgType(definition)}`);
        if (backfill) await client.query(typeof backfill === 'string' ? backfill : backfill.postgres);
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [lockId('softex:migrate')]).catch(() => {});
      client.release();
    }
  }

  private async query(sql: string, params: SqlValue[]) {
    await this.ready;
    const client = this.tx.getStore()?.client ?? this.pool;
    return client.query(toPostgres(sql), params.map(toSql));
  }

  async all<T = Row>(sql: string, ...params: SqlValue[]): Promise<T[]> {
    return (await this.query(sql, params)).rows as T[];
  }

  async run(sql: string, ...params: SqlValue[]) {
    return { changes: (await this.query(sql, params)).rowCount ?? 0 };
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    if (this.tx.getStore()) return fn();
    await this.ready;
    const client = await this.pool.connect();
    const store = { client, after: [] as (() => Promise<unknown>)[] };
    let result: T;
    try {
      await client.query('BEGIN');
      result = await this.tx.run(store, fn);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    await this.flush(store.after);
    return result;
  }

  protected pending() {
    return this.tx.getStore()?.after;
  }

  /**
   * LISTEN/NOTIFY between servers on this database. Payloads over NOTIFY's size limit are
   * stored in realtime_events and passed by reference. The listener reconnects on its own.
   */
  peerLink(): PeerLink {
    const channel = `softex_rt_${this.schema ?? 'public'}`;
    const options = this.schema ? `-c search_path=${this.schema}` : undefined;
    return {
      publish: async (payload) => {
        let message = payload;
        if (Buffer.byteLength(payload) > 7000) {
          const id = randomUUID();
          await this.run('INSERT INTO realtime_events (id, payload, created_at) VALUES (?, ?, ?)', id, payload, new Date().toISOString());
          message = JSON.stringify({ ref: id });
        }
        await this.ready;
        await this.pool.query('SELECT pg_notify($1, $2)', [channel, message]);
      },
      subscribe: async (handler) => {
        await this.ready;
        let client: pg.Client | undefined;
        let closed = false;
        let delay = 1000;
        const connect = async (): Promise<void> => {
          const c = new pg.Client({ connectionString: this.url, options });
          client = c;
          c.on('notification', (n) => {
            if (n.channel !== channel || !n.payload) return;
            const ref = n.payload.startsWith('{"ref":') ? (JSON.parse(n.payload) as { ref: string }).ref : null;
            if (!ref) return handler(n.payload);
            this.get<{ payload: string }>('SELECT payload FROM realtime_events WHERE id = ?', ref)
              .then((row) => row && handler(row.payload))
              .catch((error) => console.error('Could not load realtime event', error));
          });
          const retry = () => {
            if (closed || client !== c) return;
            client = undefined;
            setTimeout(() => void connect().catch(() => {}), delay).unref();
            delay = Math.min(delay * 2, 30_000);
          };
          c.on('error', (error) => {
            console.error('Realtime listener lost its connection', error.message);
            retry();
          });
          c.on('end', retry);
          try {
            await c.connect();
            await c.query(`LISTEN ${channel}`);
            delay = 1000;
          } catch (error) {
            retry();
            throw error;
          }
        };
        await connect();
        return async () => {
          closed = true;
          await client?.end().catch(() => {});
        };
      },
    };
  }

  async exclusive<T>(key: string, fn: () => Promise<T>) {
    await this.ready;
    const client = await this.pool.connect();
    try {
      const got = (await client.query('SELECT pg_try_advisory_lock($1) AS ok', [lockId(key)])).rows[0].ok;
      if (!got) return undefined;
      try {
        return await fn();
      } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [lockId(key)]);
      }
    } finally {
      client.release();
    }
  }

  async close() {
    await this.pool.end();
  }
}
