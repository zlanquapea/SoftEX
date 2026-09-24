import { z } from 'zod';
import { canViewChannel, canViewProject, isActiveMember, type Auth, type Role } from './access.js';
import type { Ctx } from './context.js';
import { notify } from './context.js';
import type { Row } from './db.js';
import { newId, now, parseJson } from './util.js';
import { postMessage } from './routes/channels.js';

/**
 * Project automations (§5.2 "automations such as deadline reminders and handoff
 * notifications, with transparent rules"). Each rule is "when <trigger> then
 * <action>", scoped to one project, with a visible run log. Actions run as the
 * rule's creator and are re-checked against their current access every time.
 * Actions never re-trigger automations, so rules cannot loop.
 */

export const TRIGGERS = ['task.created', 'task.status_changed', 'task.overdue'] as const;
export const ACTIONS = ['assign', 'set_priority', 'notify', 'post_message', 'add_checklist'] as const;

const Status = z.enum(['todo', 'in_progress', 'blocked', 'review', 'done']);
const Priority = z.enum(['low', 'medium', 'high', 'urgent']);

export const TriggerConfig = z.object({
  to_status: Status.optional(),
  from_status: Status.optional(),
  priority: Priority.optional(),
});

export const ActionConfig = z.object({
  user_id: z.string().optional(),
  target: z.enum(['owner', 'reviewer', 'project_owner', 'user']).optional(),
  priority: Priority.optional(),
  channel_id: z.string().optional(),
  text: z.string().max(1000).optional(),
  items: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
});

export type TriggerType = (typeof TRIGGERS)[number];

const render = (template: string, task: Row, project: Row) =>
  template
    .replace(/\{\{\s*task\s*\}\}/g, task.title)
    .replace(/\{\{\s*project\s*\}\}/g, project.name)
    .replace(/\{\{\s*status\s*\}\}/g, String(task.status).replace('_', ' '))
    .replace(/\{\{\s*due\s*\}\}/g, task.due_date ?? 'no due date')
    .replace(/\{\{\s*link\s*\}\}/g, `/tasks/${task.id}`);

function creatorAuth(ctx: Ctx, rule: Row): Auth | null {
  const m = ctx.db.get(
    'SELECT role FROM memberships WHERE workspace_id = ? AND user_id = ? AND deactivated_at IS NULL',
    rule.workspace_id,
    rule.created_by,
  );
  return m ? { userId: rule.created_by, workspaceId: rule.workspace_id, role: m.role as Role } : null;
}

/** Run every enabled rule in the task's project that matches this trigger. */
export function runAutomations(ctx: Ctx, trigger: TriggerType, task: Row, previousStatus?: string) {
  if (!task.project_id) return;
  const { db } = ctx;
  const rules = db.all('SELECT * FROM automations WHERE project_id = ? AND trigger_type = ? AND enabled = 1', task.project_id, trigger);
  for (const rule of rules) {
    const cfg = parseJson<z.infer<typeof TriggerConfig>>(rule.trigger_config, {});
    if (cfg.to_status && cfg.to_status !== task.status) continue;
    if (cfg.from_status && cfg.from_status !== previousStatus) continue;
    if (cfg.priority && cfg.priority !== task.priority) continue;
    let outcome: 'done' | 'skipped' | 'error' = 'done';
    let detail = '';
    try {
      detail = applyAction(ctx, rule, db.get('SELECT * FROM tasks WHERE id = ?', task.id)!);
    } catch (error) {
      outcome = error instanceof SkipError ? 'skipped' : 'error';
      detail = (error as Error).message;
    }
    db.insert('automation_runs', { id: newId(), automation_id: rule.id, task_id: task.id, outcome, detail: detail.slice(0, 300), created_at: now() });
    db.run('UPDATE automations SET run_count = run_count + 1, last_run_at = ? WHERE id = ?', now(), rule.id);
    db.run(
      `DELETE FROM automation_runs WHERE automation_id = ? AND id NOT IN (SELECT id FROM automation_runs WHERE automation_id = ? ORDER BY created_at DESC LIMIT 100)`,
      rule.id,
      rule.id,
    );
  }
}

class SkipError extends Error {}

function applyAction(ctx: Ctx, rule: Row, task: Row): string {
  const { db } = ctx;
  const auth = creatorAuth(ctx, rule);
  const project = db.get('SELECT * FROM projects WHERE id = ?', task.project_id)!;
  if (!auth || !canViewProject(db, auth, project)) throw new SkipError('The rule’s creator no longer has access to this project');
  if (project.archived_at) throw new SkipError('Project is archived');
  const cfg = parseJson<z.infer<typeof ActionConfig>>(rule.action_config, {});
  const label = `⚙ ${rule.name}`;
  const resolveUser = () => {
    switch (cfg.target ?? 'user') {
      case 'owner':
        return task.owner_id;
      case 'reviewer':
        return task.reviewer_id;
      case 'project_owner':
        return project.owner_id;
      default:
        return cfg.user_id;
    }
  };

  switch (rule.action_type) {
    case 'assign': {
      const userId = resolveUser();
      if (!userId || !isActiveMember(db, rule.workspace_id, userId)) throw new SkipError('No active person to assign');
      if (task.owner_id === userId) throw new SkipError('Already assigned');
      const person = db.get('SELECT m.role FROM memberships m WHERE m.workspace_id = ? AND m.user_id = ?', rule.workspace_id, userId)!;
      if (!canViewProject(db, { userId, workspaceId: rule.workspace_id, role: person.role }, project)) throw new SkipError('That person cannot see this project');
      db.update('tasks', task.id, { owner_id: userId, updated_at: now() });
      notify(ctx, rule.workspace_id, { userId, kind: 'assigned', title: `${label} assigned you “${task.title}”`, link: `/tasks/${task.id}` });
      return `Assigned to ${db.get('SELECT name FROM users WHERE id = ?', userId)!.name}`;
    }
    case 'set_priority': {
      if (!cfg.priority || cfg.priority === task.priority) throw new SkipError('Priority unchanged');
      db.update('tasks', task.id, { priority: cfg.priority, updated_at: now() });
      return `Priority set to ${cfg.priority}`;
    }
    case 'notify': {
      const userId = resolveUser();
      if (!userId) throw new SkipError('Nobody to notify');
      notify(ctx, rule.workspace_id, {
        userId,
        kind: 'automation',
        title: cfg.text ? render(cfg.text, task, project) : `${label}: “${task.title}” is ${String(task.status).replace('_', ' ')}`,
        link: `/tasks/${task.id}`,
      });
      return 'Notification sent';
    }
    case 'post_message': {
      const channel = cfg.channel_id ? db.get('SELECT * FROM channels WHERE id = ?', cfg.channel_id) : undefined;
      if (!channel || channel.archived_at || !canViewChannel(db, auth, channel)) throw new SkipError('Channel unavailable');
      if (channel.kind === 'dm' || (channel.kind !== 'public' && channel.project_id !== rule.project_id)) throw new SkipError('Private channels outside this project are not allowed');
      const text = render(cfg.text || '{{task}} is now {{status}} — [open task]({{link}})', task, project);
      postMessage(ctx, auth, channel, { body: `${label}: ${text}` });
      return `Posted in #${channel.name}`;
    }
    case 'add_checklist': {
      const items = cfg.items ?? [];
      if (!items.length) throw new SkipError('No checklist items configured');
      const start = db.get('SELECT COALESCE(MAX(position), 0) AS p FROM checklist_items WHERE task_id = ?', task.id)!.p;
      items.forEach((text, i) => db.insert('checklist_items', { id: newId(), task_id: task.id, text, position: start + i + 1 }));
      return `Added ${items.length} checklist item(s)`;
    }
    default:
      throw new Error(`Unknown action ${rule.action_type}`);
  }
}
