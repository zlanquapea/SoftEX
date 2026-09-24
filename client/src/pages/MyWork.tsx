import { useState, type FormEvent } from 'react';
import { api, type Task } from '../api';
import { Icon } from '../components/Icon';
import { useShell } from '../components/Layout';
import { TaskRow } from '../components/TaskDrawer';
import { Empty, ErrorState, Loading, useAction } from '../components/ui';
import { localToday } from '../format';
import { useApi, useRealtime } from '../hooks';

interface MyWorkData {
  overdue: Task[];
  today: Task[];
  upcoming: Task[];
  later: Task[];
  blocked: Task[];
  review: Task[];
  done_recently: Task[];
}

const SECTIONS: { id: keyof MyWorkData; title: string; hint: string; tone?: string }[] = [
  { id: 'overdue', title: 'Overdue', hint: 'Past their due date', tone: 'danger' },
  { id: 'today', title: 'Today', hint: 'Due today or urgent' },
  { id: 'blocked', title: 'Blocked', hint: 'Waiting on something', tone: 'warn' },
  { id: 'review', title: 'Assigned for review', hint: 'Waiting on your review' },
  { id: 'upcoming', title: 'Next 7 days', hint: 'Coming up soon' },
  { id: 'later', title: 'Later', hint: 'No date or further out' },
  { id: 'done_recently', title: 'Done recently', hint: 'Completed in the last day' },
];

export function MyWork() {
  const { openTask } = useShell();
  const act = useAction();
  const { data, error, reload } = useApi<MyWorkData>('/my-work');
  const [title, setTitle] = useState('');
  const [due, setDue] = useState(localToday());
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({ done_recently: true });
  useRealtime((e) => (e.type === 'task.updated' || e.type === 'reconnected') && reload());

  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    await act(() => api.post('/tasks', { title, dueDate: due || null }), 'Task added');
    setTitle('');
    reload();
  };
  const toggle = async (t: Task, done: boolean) => {
    await act(() => api.patch(`/tasks/${t.id}`, { status: done ? 'done' : 'todo' }), done ? 'Nice work — task completed' : 'Task reopened');
    reload();
  };

  if (error) return <ErrorState error={error} retry={reload} />;
  if (!data) return <Loading />;
  const total = SECTIONS.filter((s) => s.id !== 'done_recently').reduce((n, s) => n + data[s.id].length, 0);

  return (
    <div className="page narrow">
      <div className="page-head">
        <div>
          <h1>My work</h1>
          <p className="muted">Everything you own or need to review, across every project.</p>
        </div>
      </div>
      <form className="quick-add card" onSubmit={add}>
        <Icon name="plus" />
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Add a personal task and press Enter" aria-label="New task title" />
        <input type="date" value={due} onChange={(e) => setDue(e.target.value)} aria-label="Due date" />
        <button className="btn primary sm" disabled={!title.trim()}>
          Add
        </button>
      </form>
      {total === 0 && (
        <Empty icon="check" title="You are all clear">
          Nothing assigned to you right now.
        </Empty>
      )}
      {SECTIONS.map((s) =>
        data[s.id].length ? (
          <section key={s.id} className={`card work-section ${s.tone ?? ''}`}>
            <button className="section-toggle" onClick={() => setCollapsed({ ...collapsed, [s.id]: !collapsed[s.id] })} aria-expanded={!collapsed[s.id]}>
              <Icon name={collapsed[s.id] ? 'chevronRight' : 'chevronDown'} size={16} />
              <h2>{s.title}</h2>
              <span className="count">{data[s.id].length}</span>
              <span className="muted small">{s.hint}</span>
            </button>
            {!collapsed[s.id] && (
              <div className="task-list">
                {data[s.id].map((t) => (
                  <TaskRow key={t.id} task={t} onOpen={() => openTask(t.id)} onToggle={(d) => toggle(t, d)} />
                ))}
              </div>
            )}
          </section>
        ) : null,
      )}
    </div>
  );
}
