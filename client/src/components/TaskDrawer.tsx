import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, qs, type Task } from '../api';
import { bytes, dueLabel, plainMentions, STATUS_LABEL, timeAgo } from '../format';
import { useApi, useRealtime } from '../hooks';
import { useSession } from '../session';
import { Avatar } from './Avatar';
import { Icon } from './Icon';
import { Markdown } from './Markdown';
import { NewTaskForm } from './QuickCreate';
import { ErrorState, Loading, StatusPill, useAction } from './ui';

/** Side drawer wrapper around TaskDetail, opened from any list. */
export function TaskDrawer({ taskId, onClose }: { taskId: string | null; onClose: () => void }) {
  useEffect(() => {
    if (!taskId) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [taskId, onClose]);
  if (!taskId) return null;
  return (
    <>
      <div className="scrim drawer-scrim" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label="Task details">
        <div className="drawer-head">
          <Link to={`/tasks/${taskId}`} onClick={onClose} className="muted small">
            Open full page <Icon name="arrow" size={14} />
          </Link>
          <button className="icon-btn" onClick={onClose} aria-label="Close task">
            <Icon name="x" />
          </button>
        </div>
        <TaskDetail taskId={taskId} onDeleted={onClose} />
      </aside>
    </>
  );
}

interface TaskFull extends Task {
  checklist_items?: never;
  checklist: any;
  comments: { id: string; user_id: string; user_name: string; user_color: string; body: string; created_at: string }[];
  collaborators: { id: string; name: string; color: string }[];
  subtask_list: Task[];
  depends_on: { id: string; title: string; status: string }[];
  blocking: { id: string; title: string; status: string }[];
  activity: { id: string; actor_name: string; summary: string; created_at: string }[];
  source_message: { id: string; channel_id: string; body: string; channel_name: string; kind: string } | null;
  meeting: { id: string; title: string; starts_at: string } | null;
  milestones: { id: string; name: string }[];
  files: { id: string; name: string; external_url: string | null; mime: string | null; size: number | null }[];
  can_edit: boolean;
  creator: { id: string; name: string } | null;
}

export function TaskDetail({ taskId, onDeleted }: { taskId: string; onDeleted?: () => void }) {
  const { people, me } = useSession();
  const act = useAction();
  const { data: task, error, reload, setData } = useApi<TaskFull>(`/tasks/${taskId}`);
  const [newItem, setNewItem] = useState('');
  const [comment, setComment] = useState('');
  const [editingDesc, setEditingDesc] = useState(false);
  const [desc, setDesc] = useState('');
  const [addingSub, setAddingSub] = useState(false);
  const [depQuery, setDepQuery] = useState('');
  const [depOptions, setDepOptions] = useState<{ id: string; title: string; status: string }[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);

  useRealtime((e) => {
    if (e.type === 'task.updated' && e.taskId === taskId && !e.deleted) reload();
  });

  useEffect(() => {
    if (depQuery.length < 2) return setDepOptions([]);
    const t = window.setTimeout(async () => setDepOptions(await api.get(`/tasks-lookup${qs({ q: depQuery })}`)), 200);
    return () => window.clearTimeout(t);
  }, [depQuery]);

  if (error) return <ErrorState error={error} retry={reload} />;
  if (!task) return <Loading />;

  const update = async (patch: Record<string, unknown>) => {
    const updated = await act(() => api.patch<Task>(`/tasks/${task.id}`, patch));
    if (updated) setData({ ...task, ...updated });
  };
  const disabled = !task.can_edit;

  return (
    <div className="task-detail">
      <div className="task-detail-top">
        {task.project ? (
          <Link to={`/projects/${task.project.id}`} className="crumb">
            <span className={`project-dot bg-${task.project.color}`} /> {task.project.name}
          </Link>
        ) : (
          <span className="crumb muted">Personal task</span>
        )}
        {task.recurrence && (
          <span className="pill">
            <Icon name="refresh" size={12} /> Repeats {task.recurrence}
          </span>
        )}
      </div>
      <input
        className="title-input"
        defaultValue={task.title}
        key={task.title}
        disabled={disabled}
        aria-label="Task title"
        onBlur={(e) => e.target.value.trim() && e.target.value !== task.title && update({ title: e.target.value.trim() })}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />

      <div className="status-steps" role="group" aria-label="Status">
        {(['todo', 'in_progress', 'blocked', 'review', 'done'] as const).map((s) => (
          <button key={s} disabled={disabled} className={`step status-${s} ${task.status === s ? 'active' : ''}`} onClick={() => update({ status: s })} aria-pressed={task.status === s}>
            {STATUS_LABEL[s]}
          </button>
        ))}
      </div>
      {task.status === 'blocked' && (
        <input
          className="blocked-reason"
          placeholder="What is blocking this? (visible to the team)"
          defaultValue={task.blocked_reason}
          disabled={disabled}
          onBlur={(e) => e.target.value !== task.blocked_reason && update({ blockedReason: e.target.value })}
        />
      )}
      {task.waiting_on > 0 && (
        <p className="hint-box warn">
          <Icon name="alert" size={15} /> Waiting on {task.waiting_on} unfinished prerequisite task{task.waiting_on > 1 ? 's' : ''}.
        </p>
      )}

      <dl className="props">
        <dt>Owner</dt>
        <dd>
          <select value={task.owner?.id ?? ''} disabled={disabled} onChange={(e) => update({ ownerId: e.target.value || null })} aria-label="Owner">
            <option value="">Unassigned</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </dd>
        <dt>Due</dt>
        <dd>
          <input type="date" value={task.due_date ?? ''} disabled={disabled} onChange={(e) => update({ dueDate: e.target.value || null })} aria-label="Due date" />
          {task.overdue && <span className="due overdue">Overdue</span>}
        </dd>
        <dt>Priority</dt>
        <dd>
          <select value={task.priority} disabled={disabled} onChange={(e) => update({ priority: e.target.value })} aria-label="Priority">
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
            <option value="urgent">Urgent</option>
          </select>
        </dd>
        <dt>Reviewer</dt>
        <dd>
          <select value={task.reviewer?.id ?? ''} disabled={disabled} onChange={(e) => update({ reviewerId: e.target.value || null })} aria-label="Reviewer">
            <option value="">None</option>
            {people
              .filter((p) => p.id !== task.owner?.id)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
          </select>
        </dd>
        {task.milestones.length > 0 && (
          <>
            <dt>Milestone</dt>
            <dd>
              <select value={task.milestone_id ?? ''} disabled={disabled} onChange={(e) => update({ milestoneId: e.target.value || null })} aria-label="Milestone">
                <option value="">None</option>
                {task.milestones.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </dd>
          </>
        )}
        <dt>Repeats</dt>
        <dd>
          <select value={task.recurrence ?? ''} disabled={disabled} onChange={(e) => update({ recurrence: e.target.value || null })} aria-label="Repeats">
            <option value="">Never</option>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
          </select>
        </dd>
      </dl>

      {(task.source_message || task.meeting) && (
        <div className="linked">
          {task.source_message && (
            <Link to={`/channels/${task.source_message.channel_id}?message=${task.source_message.id}`} className="linked-item">
              <Icon name="chat" size={15} /> From a message in {task.source_message.kind === 'dm' ? 'a direct message' : `#${task.source_message.channel_name}`}
            </Link>
          )}
          {task.meeting && (
            <Link to={`/meetings/${task.meeting.id}`} className="linked-item">
              <Icon name="video" size={15} /> Follow-up from {task.meeting.title}
            </Link>
          )}
        </div>
      )}

      <section className="detail-section">
        <div className="section-title">
          <h3>Description</h3>
          {!disabled && !editingDesc && (
            <button
              className="link-btn"
              onClick={() => {
                setDesc(task.description);
                setEditingDesc(true);
              }}
            >
              Edit
            </button>
          )}
        </div>
        {editingDesc ? (
          <div>
            <textarea rows={6} value={desc} onChange={(e) => setDesc(e.target.value)} autoFocus aria-label="Description" />
            <div className="form-actions">
              <button className="btn sm" onClick={() => setEditingDesc(false)}>
                Cancel
              </button>
              <button
                className="btn primary sm"
                onClick={async () => {
                  await update({ description: desc });
                  setEditingDesc(false);
                }}
              >
                Save
              </button>
            </div>
          </div>
        ) : task.description ? (
          <Markdown text={task.description} />
        ) : (
          <p className="muted">No description.</p>
        )}
      </section>

      <section className="detail-section">
        <div className="section-title">
          <h3>
            Checklist {task.checklist.length ? `${task.checklist.filter((c: any) => c.done).length}/${task.checklist.length}` : ''}
          </h3>
        </div>
        {task.checklist.map((item: { id: string; text: string; done: number }) => (
          <label key={item.id} className="check-row">
            <input
              type="checkbox"
              checked={!!item.done}
              disabled={disabled}
              onChange={async (e) => {
                await act(() => api.patch(`/checklist/${item.id}`, { done: e.target.checked }));
                reload();
              }}
            />
            <span className={item.done ? 'done' : ''}>{item.text}</span>
            {!disabled && (
              <button
                className="icon-btn xs"
                aria-label={`Remove ${item.text}`}
                onClick={async (e) => {
                  e.preventDefault();
                  await act(() => api.del(`/checklist/${item.id}`));
                  reload();
                }}
              >
                <Icon name="x" size={12} />
              </button>
            )}
          </label>
        ))}
        {!disabled && (
          <form
            className="inline-add"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!newItem.trim()) return;
              await act(() => api.post(`/tasks/${task.id}/checklist`, { text: newItem }));
              setNewItem('');
              reload();
            }}
          >
            <input value={newItem} onChange={(e) => setNewItem(e.target.value)} placeholder="Add a checklist item" aria-label="New checklist item" />
          </form>
        )}
      </section>

      {!task.parent_id && (
        <section className="detail-section">
          <div className="section-title">
            <h3>Subtasks</h3>
            {!disabled && (
              <button className="link-btn" onClick={() => setAddingSub((v) => !v)}>
                {addingSub ? 'Cancel' : 'Add'}
              </button>
            )}
          </div>
          {task.subtask_list.map((s) => (
            <Link key={s.id} to={`/tasks/${s.id}`} className="mini-task">
              <StatusPill status={s.status} /> {s.title}
              {s.owner && <Avatar user={s.owner} size="xs" />}
            </Link>
          ))}
          {!task.subtask_list.length && !addingSub && <p className="muted">No subtasks.</p>}
          {addingSub && (
            <NewTaskForm
              projectId={task.project?.id}
              defaults={{ parentId: task.id, ownerId: task.owner?.id }}
              onDone={() => {
                setAddingSub(false);
                reload();
              }}
            />
          )}
        </section>
      )}

      <section className="detail-section">
        <div className="section-title">
          <h3>Dependencies</h3>
        </div>
        {task.depends_on.map((d) => (
          <div key={d.id} className="mini-task">
            <span className="muted small">Waits on</span>
            <Link to={`/tasks/${d.id}`}>{d.title}</Link>
            <StatusPill status={d.status} />
            {!disabled && (
              <button
                className="icon-btn xs"
                aria-label="Remove dependency"
                onClick={async () => {
                  await act(() => api.del(`/tasks/${task.id}/dependencies/${d.id}`));
                  reload();
                }}
              >
                <Icon name="x" size={12} />
              </button>
            )}
          </div>
        ))}
        {task.blocking.map((d) => (
          <div key={d.id} className="mini-task">
            <span className="muted small">Blocks</span>
            <Link to={`/tasks/${d.id}`}>{d.title}</Link>
            <StatusPill status={d.status} />
          </div>
        ))}
        {!disabled && (
          <div className="dep-search">
            <input value={depQuery} onChange={(e) => setDepQuery(e.target.value)} placeholder="This task waits on… (search tasks)" aria-label="Add dependency" />
            {depOptions.length > 0 && (
              <div className="picker-options">
                {depOptions
                  .filter((o) => o.id !== task.id)
                  .map((o) => (
                    <button
                      key={o.id}
                      onClick={async () => {
                        await act(() => api.post(`/tasks/${task.id}/dependencies`, { dependsOnId: o.id }));
                        setDepQuery('');
                        reload();
                      }}
                    >
                      {o.title} <StatusPill status={o.status} />
                    </button>
                  ))}
              </div>
            )}
          </div>
        )}
      </section>

      <section className="detail-section">
        <div className="section-title">
          <h3>Attachments</h3>
          {!disabled && (
            <button className="link-btn" onClick={() => fileInput.current?.click()}>
              Upload
            </button>
          )}
          <input
            ref={fileInput}
            type="file"
            hidden
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              const form = new FormData();
              form.append('file', file);
              form.append('taskId', task.id);
              await act(() => api.upload('/files', form), 'File attached');
              e.target.value = '';
              reload();
            }}
          />
        </div>
        {task.files.map((f) => (
          <Link key={f.id} to={`/files/${f.id}`} className="file-chip">
            <Icon name={f.external_url ? 'link' : 'file'} size={15} /> {f.name} <small className="muted">{bytes(f.size)}</small>
          </Link>
        ))}
        {!task.files.length && <p className="muted">No attachments.</p>}
      </section>

      <section className="detail-section">
        <div className="section-title">
          <h3>Comments</h3>
        </div>
        {task.comments.map((c) => (
          <div key={c.id} className="comment">
            <Avatar user={{ id: c.user_id, name: c.user_name, color: c.user_color }} size="sm" />
            <div>
              <strong>{c.user_name}</strong> <small className="muted">{timeAgo(c.created_at)}</small>
              <Markdown text={c.body} compact />
            </div>
          </div>
        ))}
        <form
          className="comment-form"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!comment.trim()) return;
            await act(() => api.post(`/tasks/${task.id}/comments`, { body: comment }));
            setComment('');
            reload();
          }}
        >
          <Avatar user={me!.user} size="sm" />
          <input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Write a comment…" aria-label="Comment" />
          <button className="btn sm" disabled={!comment.trim()}>
            Post
          </button>
        </form>
      </section>

      <section className="detail-section">
        <div className="section-title">
          <h3>Activity</h3>
        </div>
        <ul className="timeline">
          {task.activity.map((a) => (
            <li key={a.id}>
              <strong>{a.actor_name}</strong> {a.summary} <small className="muted">{timeAgo(a.created_at)}</small>
            </li>
          ))}
          <li>
            <strong>{task.creator?.name}</strong> created this task <small className="muted">{timeAgo(task.created_at)}</small>
          </li>
        </ul>
      </section>

      {!disabled && (task.created_by === me!.user.id || task.owner?.id === me!.user.id || me!.role === 'admin' || me!.role === 'owner') && (
        <button
          className="btn danger-text"
          onClick={async () => {
            if (!confirm('Delete this task? This cannot be undone.')) return;
            const ok = await act(() => api.del(`/tasks/${task.id}`), 'Task deleted');
            if (ok) onDeleted?.();
          }}
        >
          <Icon name="trash" size={15} /> Delete task
        </button>
      )}
    </div>
  );
}

/** Compact task row used in lists across the app. */
export function TaskRow({ task, onOpen, onToggle, showProject = true }: { task: Task; onOpen: () => void; onToggle?: (done: boolean) => void; showProject?: boolean }) {
  return (
    <div className={`task ${task.status === 'done' ? 'is-done' : ''}`}>
      <input
        type="checkbox"
        className="task-check"
        checked={task.status === 'done'}
        onChange={(e) => onToggle?.(e.target.checked)}
        aria-label={`Mark ${task.title} ${task.status === 'done' ? 'not done' : 'done'}`}
        disabled={!onToggle}
      />
      <button className="task-body" onClick={onOpen}>
        <strong>{task.title}</strong>
        <small>
          {showProject && (task.project ? <><span className={`project-dot bg-${task.project.color}`} />{task.project.name}</> : 'Personal')}
          {task.status !== 'todo' && task.status !== 'done' && <StatusPill status={task.status} />}
          {task.priority === 'urgent' || task.priority === 'high' ? <span className={`pill prio-${task.priority}`}>{task.priority}</span> : null}
          {task.checklist.total > 0 && (
            <span className="meta">
              <Icon name="check" size={12} /> {task.checklist.done}/{task.checklist.total}
            </span>
          )}
          {task.comment_count > 0 && (
            <span className="meta">
              <Icon name="chat" size={12} /> {task.comment_count}
            </span>
          )}
          {task.status === 'blocked' && task.blocked_reason && <span className="meta">— {plainMentions(task.blocked_reason)}</span>}
        </small>
      </button>
      <span className="task-meta">
        {task.due_date && <small className={`due ${task.overdue ? 'overdue' : dueLabel(task.due_date) === 'Today' ? 'today' : ''}`}>{dueLabel(task.due_date)}</small>}
        <Avatar user={task.owner} size="sm" />
      </span>
    </div>
  );
}
