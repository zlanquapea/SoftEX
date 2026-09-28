import { useState } from 'react';
import { api, type CustomField, type Task, type TaskStatus } from '../api';
import { dueLabel, localToday, STATUS_LABEL, duration } from '../format';
import { useSession } from '../session';
import { Avatar } from './Avatar';
import { Icon } from './Icon';
import { FieldInput, FieldValue, LabelChips } from './Work';
import { useAction } from './ui';

const STATUSES: TaskStatus[] = ['todo', 'in_progress', 'blocked', 'review', 'done'];

type SortKey = 'title' | 'status' | 'owner' | 'due_date' | 'priority' | `f:${string}`;
const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };

/** Spreadsheet-style view (Monday/Airtable): every task a row, inline editing, custom fields as columns. */
export function TaskTable({
  tasks,
  fields,
  canEdit,
  onOpen,
  onChanged,
}: {
  tasks: Task[];
  fields: CustomField[];
  canEdit: boolean;
  onOpen: (id: string) => void;
  onChanged: (task: Task) => void;
}) {
  const { people } = useSession();
  const act = useAction();
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'status', dir: 1 });

  const patch = async (task: Task, body: Record<string, unknown>) => {
    const updated = await act(() => api.patch<Task>(`/tasks/${task.id}`, body));
    if (updated) onChanged({ ...task, ...updated });
  };
  const setField = async (task: Task, field: CustomField, value: unknown) => {
    const res = await act(() => api.put<{ fields: Record<string, unknown> }>(`/tasks/${task.id}/fields/${field.id}`, { value }));
    if (res) onChanged({ ...task, fields: res.fields });
  };

  const valueOf = (t: Task, key: SortKey): string | number => {
    if (key.startsWith('f:')) {
      const v = t.fields?.[key.slice(2)];
      return v === undefined || v === null ? '' : typeof v === 'number' ? v : String(v);
    }
    switch (key) {
      case 'status':
        return STATUSES.indexOf(t.status);
      case 'owner':
        return t.owner?.name ?? '~';
      case 'priority':
        return PRIORITY_RANK[t.priority] ?? 9;
      case 'due_date':
        return t.due_date ?? '9999';
      default:
        return t.title.toLowerCase();
    }
  };
  const rows = [...tasks].sort((a, b) => {
    const x = valueOf(a, sort.key);
    const y = valueOf(b, sort.key);
    return (x < y ? -1 : x > y ? 1 : 0) * sort.dir;
  });
  const header = (key: SortKey, label: string) => (
    <th key={key} aria-sort={sort.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
      <button className="th-sort" onClick={() => setSort((s) => ({ key, dir: s.key === key ? ((-s.dir) as 1 | -1) : 1 }))}>
        {label} {sort.key === key && <Icon name={sort.dir === 1 ? 'chevronDown' : 'chevronRight'} size={12} />}
      </button>
    </th>
  );

  return (
    <div className="table-wrap card">
      <table className="task-table">
        <thead>
          <tr>
            {header('title', 'Task')}
            {header('status', 'Status')}
            {header('owner', 'Owner')}
            {header('due_date', 'Due')}
            {header('priority', 'Priority')}
            <th>Labels</th>
            <th>Time</th>
            {fields.map((f) => header(`f:${f.id}`, f.name))}
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.id} className={t.status === 'done' ? 'is-done' : ''}>
              <td className="cell-title">
                <button className="link-btn" onClick={() => onOpen(t.id)}>
                  {t.title}
                </button>
              </td>
              <td>
                <select className={`cell-select status-${t.status}`} value={t.status} disabled={!canEdit} onChange={(e) => patch(t, { status: e.target.value })} aria-label={`Status of ${t.title}`}>
                  {STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {STATUS_LABEL[s]}
                    </option>
                  ))}
                </select>
              </td>
              <td>
                <select className="cell-select" value={t.owner?.id ?? ''} disabled={!canEdit} onChange={(e) => patch(t, { ownerId: e.target.value || null })} aria-label={`Owner of ${t.title}`}>
                  <option value="">Unassigned</option>
                  {people.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </td>
              <td>
                <input
                  type="date"
                  className={`cell-input ${t.overdue ? 'overdue' : ''}`}
                  value={t.due_date ?? ''}
                  disabled={!canEdit}
                  onChange={(e) => patch(t, { dueDate: e.target.value || null })}
                  aria-label={`Due date of ${t.title}`}
                />
              </td>
              <td>
                <select className={`cell-select prio-${t.priority}`} value={t.priority} disabled={!canEdit} onChange={(e) => patch(t, { priority: e.target.value })} aria-label={`Priority of ${t.title}`}>
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                  <option value="urgent">Urgent</option>
                </select>
              </td>
              <td>
                <LabelChips labels={t.labels} />
              </td>
              <td className="muted">{t.time_minutes ? duration(t.time_minutes) : '—'}</td>
              {fields.map((f) => (
                <td key={f.id}>{canEdit ? <FieldInput field={f} value={t.fields?.[f.id]} onSave={(v) => setField(t, f, v)} /> : <FieldValue field={f} value={t.fields?.[f.id]} />}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length && <p className="muted pad">No tasks match.</p>}
    </div>
  );
}

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Month grid of tasks by due date; drag a task to another day to reschedule. */
export function TaskCalendar({ tasks, canEdit, onOpen, onChanged }: { tasks: Task[]; canEdit: boolean; onOpen: (id: string) => void; onChanged: (task: Task) => void }) {
  const act = useAction();
  const [month, setMonth] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const [dragged, setDragged] = useState<string | null>(null);
  const first = new Date(month);
  first.setDate(1 - ((month.getDay() + 6) % 7)); // back to Monday
  const days = Array.from({ length: 42 }, (_, i) => new Date(first.getFullYear(), first.getMonth(), first.getDate() + i));
  const today = localToday();
  const byDay = new Map<string, Task[]>();
  for (const t of tasks) if (t.due_date) byDay.set(t.due_date, [...(byDay.get(t.due_date) ?? []), t]);
  const undated = tasks.filter((t) => !t.due_date && t.status !== 'done');

  const reschedule = async (taskId: string, date: string) => {
    const task = tasks.find((t) => t.id === taskId);
    if (!task || task.due_date === date) return;
    const updated = await act(() => api.patch<Task>(`/tasks/${taskId}`, { dueDate: date, ...(task.start_date && task.start_date > date ? { startDate: null } : {}) }));
    if (updated) onChanged({ ...task, ...updated });
  };

  return (
    <div className="calendar card">
      <div className="calendar-head">
        <button className="icon-btn" aria-label="Previous month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}>
          <Icon name="chevronLeft" />
        </button>
        <h3>{month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</h3>
        <button className="icon-btn" aria-label="Next month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}>
          <Icon name="chevronRight" />
        </button>
        <button className="btn sm" onClick={() => setMonth(new Date(new Date().getFullYear(), new Date().getMonth(), 1))}>
          Today
        </button>
      </div>
      <div className="calendar-grid" role="grid">
        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
          <div key={d} className="calendar-dow" role="columnheader">
            {d}
          </div>
        ))}
        {days.map((d) => {
          const key = iso(d);
          const items = byDay.get(key) ?? [];
          return (
            <div
              key={key}
              role="gridcell"
              aria-label={d.toDateString()}
              className={`calendar-day ${d.getMonth() !== month.getMonth() ? 'other' : ''} ${key === today ? 'today' : ''}`}
              onDragOver={(e) => canEdit && dragged && e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                if (dragged) reschedule(dragged, key);
                setDragged(null);
              }}
            >
              <span className="calendar-date">{d.getDate()}</span>
              {items.slice(0, 4).map((t) => (
                <button
                  key={t.id}
                  className={`calendar-task status-${t.status} ${t.overdue ? 'overdue' : ''}`}
                  draggable={canEdit}
                  onDragStart={() => setDragged(t.id)}
                  onClick={() => onOpen(t.id)}
                  title={`${t.title} · ${STATUS_LABEL[t.status]}${t.owner ? ` · ${t.owner.name}` : ''}`}
                >
                  {t.owner && <Avatar user={t.owner} size="xs" />}
                  <span>{t.title}</span>
                </button>
              ))}
              {items.length > 4 && <small className="muted">+{items.length - 4} more</small>}
            </div>
          );
        })}
      </div>
      {undated.length > 0 && (
        <details className="calendar-undated">
          <summary>
            {undated.length} open task{undated.length === 1 ? '' : 's'} without a due date {canEdit && <small className="muted">— drag one onto a day</small>}
          </summary>
          <div className="row-gap wrap">
            {undated.map((t) => (
              <button key={t.id} className="calendar-task" draggable={canEdit} onDragStart={() => setDragged(t.id)} onClick={() => onOpen(t.id)}>
                <span>{t.title}</span> {t.due_date && <small>{dueLabel(t.due_date)}</small>}
              </button>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
