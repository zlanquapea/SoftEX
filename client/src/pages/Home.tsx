import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Activity, type Decision, type Notification, type Project, type Task } from '../api';
import { Avatar, AvatarStack } from '../components/Avatar';
import { Icon } from '../components/Icon';
import { useShell } from '../components/Layout';
import { TaskRow } from '../components/TaskDrawer';
import { ErrorState, Field, HealthPill, Loading, Modal, useAction } from '../components/ui';
import { plainMentions, timeAgo, timeOf } from '../format';
import { useApi, useRealtime } from '../hooks';
import { useSession } from '../session';

interface HomeData {
  since: string;
  focus: Task[];
  up_next: Task[];
  blocked: Task[];
  meetings: {
    id: string;
    title: string;
    starts_at: string;
    duration_min: number;
    location: string;
    video_url: string;
    started_at: string | null;
    participants: { id: string; name: string; color: string }[];
  }[];
  mentions: (Notification & { actor_name: string; actor_color: string })[];
  decisions: (Decision & { project_name: string | null })[];
  changes: Activity[];
  projects: { id: string; name: string; color: string; health: string; progress: number; members: { id: string; name: string; color: string }[]; member_count: number }[];
  onboarding: { total: number; done: number };
  pending_approvals: number;
  checked_in_today: boolean;
  reviews_due: { id: string; title: string; review_date: string }[];
  counts: { open_tasks: number; overdue: number; unread: number };
}

const OPTIONAL = [
  { id: 'projects', label: 'Active projects' },
  { id: 'decisions', label: 'Recent decisions' },
  { id: 'changes', label: 'What changed' },
  { id: 'upnext', label: 'Up next tasks' },
] as const;
type Section = (typeof OPTIONAL)[number]['id'];

function loadHidden(): Section[] {
  try {
    return JSON.parse(localStorage.getItem('softex.home.hidden') ?? '[]');
  } catch {
    return [];
  }
}

export function Home() {
  const { me } = useSession();
  const { openTask, openCreate } = useShell();
  const act = useAction();
  const { data, error, reload } = useApi<HomeData>('/home');
  const [hidden, setHidden] = useState<Section[]>(loadHidden);
  const [tuning, setTuning] = useState(false);
  const [checkin, setCheckin] = useState(false);

  useRealtime((e) => {
    if (['task.updated', 'notification', 'meeting.updated', 'reconnected'].includes(e.type)) reload();
  });

  // Mark "since you last checked" after the user has seen the page for a moment.
  useEffect(() => {
    const t = window.setTimeout(() => api.post('/home/seen').catch(() => {}), 5000);
    return () => window.clearTimeout(t);
  }, []);

  const toggleSection = (id: Section) => {
    const next = hidden.includes(id) ? hidden.filter((h) => h !== id) : [...hidden, id];
    setHidden(next);
    try {
      localStorage.setItem('softex.home.hidden', JSON.stringify(next));
    } catch {
      /* storage unavailable */
    }
  };

  if (error) return <ErrorState error={error} retry={reload} />;
  if (!data) return <Loading />;

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const first = me!.user.name.split(' ')[0];
  const complete = async (t: Task, done: boolean) => {
    await act(() => api.patch(`/tasks/${t.id}`, { status: done ? 'done' : 'todo' }), done ? 'Task marked complete' : 'Task reopened');
    reload();
  };
  const show = (id: Section) => !hidden.includes(id);

  return (
    <div className="page">
      <div className="welcome">
        <div>
          <p className="eyebrow">{new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }).toUpperCase()}</p>
          <h1>
            {greeting}, {first} <span aria-hidden="true">👋</span>
          </h1>
          <p className="muted">
            {data.counts.open_tasks} open task{data.counts.open_tasks === 1 ? '' : 's'}
            {data.counts.overdue ? `, ${data.counts.overdue} overdue` : ''} · {data.meetings.length} meeting{data.meetings.length === 1 ? '' : 's'} coming up ·{' '}
            {data.counts.unread} unread
          </p>
        </div>
        <div className="welcome-actions">
          <button className="btn" onClick={() => setTuning(true)}>
            <Icon name="settings" size={16} /> Customize
          </button>
          <button className="btn primary" onClick={() => openCreate()}>
            <Icon name="plus" size={16} /> Create new
          </button>
        </div>
      </div>

      <div className="nudges">
        {data.onboarding.total > 0 && data.onboarding.done < data.onboarding.total && (
          <Link to="/settings?tab=onboarding" className="nudge">
            <Icon name="flag" size={16} /> Onboarding: {data.onboarding.done} of {data.onboarding.total} steps done
          </Link>
        )}
        {data.pending_approvals > 0 && (
          <Link to="/requests" className="nudge warn">
            <Icon name="inboxCheck" size={16} /> {data.pending_approvals} request{data.pending_approvals > 1 ? 's' : ''} waiting for your approval
          </Link>
        )}
        {!data.checked_in_today && me!.role !== 'guest' && (
          <button className="nudge" onClick={() => setCheckin(true)}>
            <Icon name="target" size={16} /> Share today’s check-in
          </button>
        )}
        {data.reviews_due.map((p) => (
          <Link key={p.id} to={`/knowledge/${p.id}`} className="nudge warn">
            <Icon name="book" size={16} /> “{p.title}” is due for review
          </Link>
        ))}
      </div>

      <div className="dashboard-grid">
        <div className="main-column">
          <article className="card">
            <div className="section-heading">
              <div>
                <h2>Today’s focus</h2>
                <p>{data.focus.length ? `${data.focus.length} task${data.focus.length > 1 ? 's' : ''} need your attention` : 'Nothing due today. Nice.'}</p>
              </div>
              <Link to="/my-work">
                View all <Icon name="arrow" size={15} />
              </Link>
            </div>
            <div className="task-list">
              {data.focus.map((t) => (
                <TaskRow key={t.id} task={t} onOpen={() => openTask(t.id)} onToggle={(d) => complete(t, d)} />
              ))}
            </div>
            <button className="add-task" onClick={() => openCreate('task')}>
              <Icon name="plus" size={16} /> Add a task
            </button>
          </article>

          {data.blocked.length > 0 && (
            <article className="card attention">
              <div className="section-heading">
                <div>
                  <h2>
                    <Icon name="alert" size={18} /> Blocked
                  </h2>
                  <p>Work that cannot move until something changes</p>
                </div>
              </div>
              <div className="task-list">
                {data.blocked.map((t) => (
                  <TaskRow key={t.id} task={t} onOpen={() => openTask(t.id)} />
                ))}
              </div>
            </article>
          )}

          {show('upnext') && data.up_next.length > 0 && (
            <article className="card">
              <div className="section-heading">
                <div>
                  <h2>Up next</h2>
                  <p>Your next open tasks</p>
                </div>
              </div>
              <div className="task-list">
                {data.up_next.map((t) => (
                  <TaskRow key={t.id} task={t} onOpen={() => openTask(t.id)} onToggle={(d) => complete(t, d)} />
                ))}
              </div>
            </article>
          )}

          {show('projects') && (
            <article className="card">
              <div className="section-heading">
                <div>
                  <h2>Active projects</h2>
                  <p>Projects you are part of</p>
                </div>
                <Link to="/projects">
                  All projects <Icon name="arrow" size={15} />
                </Link>
              </div>
              {data.projects.length ? (
                <div className="project-grid">
                  {data.projects.map((p) => (
                    <Link key={p.id} to={`/projects/${p.id}`} className="project-card">
                      <div className="project-top">
                        <span className={`project-icon bg-${p.color}`}>
                          <Icon name="folder" />
                        </span>
                      </div>
                      <h3>{p.name}</h3>
                      <p>
                        {p.member_count} member{p.member_count === 1 ? '' : 's'}
                      </p>
                      <div className="progress-label">
                        <span>Progress</span>
                        <b>{p.progress}%</b>
                      </div>
                      <div className={`progress fg-${p.color}`}>
                        <i style={{ width: `${p.progress}%` }} />
                      </div>
                      <div className="project-footer">
                        <AvatarStack users={p.members} total={p.member_count} />
                        <HealthPill health={p.health} />
                      </div>
                    </Link>
                  ))}
                </div>
              ) : (
                <p className="muted">
                  You are not in any projects yet.{' '}
                  {me!.role !== 'guest' && (
                    <button className="link-btn" onClick={() => openCreate('project')}>
                      Start one
                    </button>
                  )}
                </p>
              )}
            </article>
          )}
        </div>

        <aside className="right-column">
          <article className="card">
            <div className="section-heading compact">
              <div>
                <h2>Meetings</h2>
                <p>Next 36 hours</p>
              </div>
            </div>
            {data.meetings.map((m) => (
              <Link key={m.id} to={`/meetings/${m.id}`} className="meeting">
                <div className="time">
                  <strong>{timeOf(m.starts_at).replace(/\s?[AP]M/i, '')}</strong>
                  <small>{timeOf(m.starts_at).match(/[AP]M/i)?.[0] ?? ''}</small>
                </div>
                <div className={`meeting-line ${m.started_at ? 'live' : ''}`} />
                <div>
                  <h3>{m.title}</h3>
                  <p>
                    <Icon name={m.video_url ? 'video' : 'calendar'} size={14} />
                    {m.started_at ? 'Live now' : new Date(m.starts_at).toDateString() === new Date().toDateString() ? 'Today' : 'Tomorrow'} · {m.duration_min} min
                  </p>
                  <AvatarStack users={m.participants} />
                </div>
              </Link>
            ))}
            {!data.meetings.length && <p className="muted">No meetings coming up.</p>}
            <Link className="card-link" to="/meetings">
              Open meetings <Icon name="arrow" size={15} />
            </Link>
          </article>

          <article className="card">
            <div className="section-heading compact">
              <div>
                <h2>Mentions & messages</h2>
                <p>Unread</p>
              </div>
            </div>
            {data.mentions.map((n) => (
              <Link key={n.id} to={n.link} className="activity" onClick={() => api.post(`/notifications/${n.id}/read`)}>
                <Avatar user={{ name: n.actor_name ?? '?', color: n.actor_color }} size="sm" />
                <div>
                  <p>{n.title}</p>
                  {n.body && <small>“{plainMentions(n.body).slice(0, 90)}”</small>}
                  <time>{timeAgo(n.created_at)}</time>
                </div>
              </Link>
            ))}
            {!data.mentions.length && <p className="muted">You are all caught up.</p>}
          </article>

          {show('decisions') && (
            <article className="card">
              <div className="section-heading compact">
                <div>
                  <h2>Recent decisions</h2>
                  <p>Across your projects</p>
                </div>
                <Link to="/decisions">All</Link>
              </div>
              {data.decisions.map((d) => (
                <div key={d.id} className="activity">
                  <span className="activity-icon decision">
                    <Icon name="gavel" size={15} />
                  </span>
                  <div>
                    <p>
                      <strong>{d.title}</strong>
                    </p>
                    <small>
                      {d.decided_by_name} · {d.project_name ?? 'Workspace'}
                    </small>
                    <time>{timeAgo(d.created_at)}</time>
                  </div>
                </div>
              ))}
              {!data.decisions.length && <p className="muted">No decisions recorded yet.</p>}
            </article>
          )}

          {show('changes') && (
            <article className="card">
              <div className="section-heading compact">
                <div>
                  <h2>What changed</h2>
                  <p>Since you last checked · {timeAgo(data.since)}</p>
                </div>
              </div>
              {data.changes.map((a) => (
                <Link key={a.id} to={a.link || '#'} className="activity">
                  <Avatar user={{ id: a.actor_id, name: a.actor_name, color: a.actor_color }} size="sm" />
                  <div>
                    <p>
                      <strong>{a.actor_name.split(' ')[0]}</strong> {a.summary}
                    </p>
                    <time>{timeAgo(a.created_at)}</time>
                  </div>
                </Link>
              ))}
              {!data.changes.length && <p className="muted">Nothing new since your last visit.</p>}
            </article>
          )}
        </aside>
      </div>

      <Modal open={tuning} onClose={() => setTuning(false)} title="Customize Home" eyebrow="YOUR VIEW">
        <p className="muted">Choose what Home shows. Today’s focus, blocked work, meetings and unread mentions always stay visible.</p>
        {OPTIONAL.map((o) => (
          <label key={o.id} className="check-row">
            <input type="checkbox" checked={!hidden.includes(o.id)} onChange={() => toggleSection(o.id)} /> {o.label}
          </label>
        ))}
      </Modal>
      <CheckinModal open={checkin} onClose={() => setCheckin(false)} onDone={reload} />
    </div>
  );
}

export function CheckinModal({ open, onClose, onDone, projectId }: { open: boolean; onClose: () => void; onDone: () => void; projectId?: string }) {
  const act = useAction();
  const { data: projects } = useApi<Project[]>(open && !projectId ? '/projects' : null);
  const [form, setForm] = useState({ projectId: projectId ?? '', done: '', next: '', blockers: '' });
  return (
    <Modal open={open} onClose={onClose} title="Daily check-in" eyebrow="ASYNC UPDATE">
      <form
        className="form"
        onSubmit={async (e) => {
          e.preventDefault();
          const ok = await act(() => api.post('/checkins', { ...form, projectId: form.projectId || null }), 'Check-in shared');
          if (ok) {
            setForm({ projectId: projectId ?? '', done: '', next: '', blockers: '' });
            onClose();
            onDone();
          }
        }}
      >
        {!projectId && (
          <Field label="Project">
            <select value={form.projectId} onChange={(e) => setForm({ ...form, projectId: e.target.value })}>
              <option value="">General</option>
              {(projects ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="What did you get done?">
          <textarea rows={2} value={form.done} onChange={(e) => setForm({ ...form, done: e.target.value })} />
        </Field>
        <Field label="What are you working on next?">
          <textarea rows={2} value={form.next} onChange={(e) => setForm({ ...form, next: e.target.value })} />
        </Field>
        <Field label="Anything blocking you?" hint="Blockers notify the project owner.">
          <textarea rows={2} value={form.blockers} onChange={(e) => setForm({ ...form, blockers: e.target.value })} />
        </Field>
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!form.done && !form.next && !form.blockers}>
            Share check-in
          </button>
        </div>
      </form>
    </Modal>
  );
}
