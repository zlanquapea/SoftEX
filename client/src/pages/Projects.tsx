import { useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, qs, type Decision, type Project, type Task, type TaskStatus } from '../api';
import { useAiEnabled } from '../components/Ai';
import { Avatar, AvatarStack } from '../components/Avatar';
import { Icon } from '../components/Icon';
import { useShell } from '../components/Layout';
import { Markdown } from '../components/Markdown';
import { NewMeetingForm, NewTaskForm } from '../components/QuickCreate';
import { TaskRow } from '../components/TaskDrawer';
import { ProjectAutomations, ProjectTimeline } from './Planning';
import { Empty, ErrorState, Field, HealthPill, Loading, Modal, PeoplePicker, Tabs, useAction } from '../components/ui';
import { bytes, dateTime, dueLabel, HEALTH_LABEL, STATUS_LABEL, timeAgo } from '../format';
import { useApi, useRealtime } from '../hooks';
import { useSession } from '../session';
import { CheckinModal } from './Home';

export function Projects() {
  const { openCreate } = useShell();
  const { me } = useSession();
  const [scope, setScope] = useState<'mine' | 'all' | 'archived'>('mine');
  const { data, error, reload } = useApi<Project[]>(`/projects${qs({ archived: scope === 'archived' ? 'true' : undefined })}`);
  const list = (data ?? []).filter((p) => scope !== 'mine' || p.is_member);
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Projects</h1>
          <p className="muted">Plans, owners, progress and health for every initiative you can see.</p>
        </div>
        {me!.role !== 'guest' && (
          <button className="btn primary" onClick={() => openCreate('project')}>
            <Icon name="plus" size={16} /> New project
          </button>
        )}
      </div>
      <Tabs
        value={scope}
        onChange={setScope}
        tabs={[
          { id: 'mine', label: 'My projects' },
          { id: 'all', label: 'All visible' },
          { id: 'archived', label: 'Archived' },
        ]}
      />
      {error && <ErrorState error={error} retry={reload} />}
      {!data && !error && <Loading />}
      {data && !list.length && (
        <Empty icon="folder" title="No projects here">
          {scope === 'mine' ? 'Projects you are a member of appear here.' : 'Nothing to show.'}
        </Empty>
      )}
      <div className="project-grid wide">
        {list.map((p) => (
          <Link key={p.id} to={`/projects/${p.id}`} className="project-card">
            <div className="project-top">
              <span className={`project-icon bg-${p.color}`}>
                <Icon name="folder" />
              </span>
              {p.visibility === 'private' && (
                <span className="pill">
                  <Icon name="lock" size={11} /> Private
                </span>
              )}
            </div>
            <h3>{p.name}</h3>
            <p>
              {p.team?.name ?? 'No team'} · {p.member_count} member{p.member_count === 1 ? '' : 's'}
            </p>
            <div className="progress-label">
              <span>
                {p.stats.done}/{p.stats.total} tasks
              </span>
              <b>{p.stats.progress}%</b>
            </div>
            <div className={`progress fg-${p.color}`}>
              <i style={{ width: `${p.stats.progress}%` }} />
            </div>
            {(p.stats.overdue > 0 || p.stats.blocked > 0) && (
              <p className="small warn-text">
                {p.stats.overdue > 0 && `${p.stats.overdue} overdue`}
                {p.stats.overdue > 0 && p.stats.blocked > 0 && ' · '}
                {p.stats.blocked > 0 && `${p.stats.blocked} blocked`}
              </p>
            )}
            <div className="project-footer">
              <AvatarStack users={p.members} total={p.member_count} />
              <HealthPill health={p.health} />
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}

interface ProjectFull extends Project {
  milestones: { id: string; name: string; due_date: string | null; done_at: string | null; task_count: number; done_count: number }[];
  channels: { id: string; name: string; kind: string }[];
  latest_update: { id: string; health: string; body: string; user_name: string; user_color: string; created_at: string } | null;
  can_contribute: boolean;
  can_manage: boolean;
  ai_excluded: boolean;
}

type Tab = 'overview' | 'tasks' | 'timeline' | 'automations' | 'decisions' | 'risks' | 'resources' | 'checkins' | 'activity';

export function ProjectDetail() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) ?? 'overview';
  const setTab = (t: Tab) => setParams(t === 'overview' ? {} : { tab: t });
  const { data: project, error, reload } = useApi<ProjectFull>(`/projects/${id}`);
  const [settings, setSettings] = useState(false);
  useRealtime((e) => e.type === 'task.updated' && e.projectId === id && reload());

  if (error) return <ErrorState error={error} retry={reload} />;
  if (!project) return <Loading />;

  return (
    <div className="page">
      <div className="project-head">
        <span className={`project-icon lg bg-${project.color}`}>
          <Icon name="folder" size={22} />
        </span>
        <div className="grow">
          <p className="eyebrow">
            {project.team?.name ?? 'PROJECT'} {project.visibility === 'private' && '· PRIVATE'} {project.archived_at && '· ARCHIVED'}
          </p>
          <h1>{project.name}</h1>
          <div className="project-meta">
            <HealthPill health={project.health} />
            <span>
              Owner: <strong>{project.owner?.name}</strong>
            </span>
            {project.due_date && <span>Target: {new Date(`${project.due_date}T00:00`).toLocaleDateString()}</span>}
            <AvatarStack users={project.members} max={5} total={project.member_count} />
            {project.channels.map((c) => (
              <Link key={c.id} to={`/channels/${c.id}`} className="pill">
                <Icon name={c.kind === 'private' ? 'lock' : 'hash'} size={11} /> {c.name}
              </Link>
            ))}
          </div>
        </div>
        {project.can_manage && (
          <button className="btn" onClick={() => setSettings(true)}>
            <Icon name="settings" size={16} /> Settings
          </button>
        )}
      </div>
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'overview', label: 'Overview' },
          { id: 'tasks', label: 'Tasks', count: project.stats.total - project.stats.done },
          { id: 'timeline', label: 'Timeline' },
          { id: 'automations', label: 'Automations' },
          { id: 'decisions', label: 'Decisions' },
          { id: 'risks', label: 'Risks' },
          { id: 'resources', label: 'Resources' },
          { id: 'checkins', label: 'Check-ins' },
          { id: 'activity', label: 'Activity' },
        ]}
      />
      {tab === 'overview' && <Overview project={project} reload={reload} />}
      {tab === 'tasks' && <ProjectTasks project={project} />}
      {tab === 'timeline' && <ProjectTimeline projectId={project.id} milestones={project.milestones} canEdit={project.can_contribute} />}
      {tab === 'automations' && <ProjectAutomations projectId={project.id} />}
      {tab === 'decisions' && <ProjectDecisions project={project} />}
      {tab === 'risks' && <Risks project={project} />}
      {tab === 'resources' && <Resources project={project} />}
      {tab === 'checkins' && <Checkins project={project} />}
      {tab === 'activity' && <ProjectActivity projectId={project.id} />}
      {project.can_manage && <ProjectSettings open={settings} onClose={() => setSettings(false)} project={project} onSaved={reload} />}
    </div>
  );
}

function Overview({ project, reload }: { project: ProjectFull; reload: () => void }) {
  const act = useAction();
  const [updating, setUpdating] = useState(false);
  const [summary, setSummary] = useState<{ draft: string; suggested_health: string } | null>(null);
  const [milestone, setMilestone] = useState({ name: '', dueDate: '' });
  const { data: updates, reload: reloadUpdates } = useApi<{ id: string; health: string; body: string; user_name: string; user_color: string; created_at: string }[]>(
    `/projects/${project.id}/updates`,
  );
  const [update, setUpdate] = useState({ health: project.health as string, body: '' });

  const aiEnabled = useAiEnabled();
  const [aiBusy, setAiBusy] = useState(false);
  const aiBrief = async () => {
    setAiBusy(true);
    const res = await act(() => api.post<{ brief: string }>(`/ai/projects/${project.id}/brief`));
    setAiBusy(false);
    if (res) {
      setSummary({ draft: res.brief, suggested_health: project.health });
      setUpdate({ health: project.health, body: res.brief });
      setUpdating(true);
    }
  };
  const draftSummary = async () => {
    const s = await act(() => api.get(`/projects/${project.id}/summary`));
    if (s) {
      setSummary(s);
      setUpdate({ health: s.suggested_health, body: s.draft });
      setUpdating(true);
    }
  };

  return (
    <div className="dashboard-grid">
      <div className="main-column">
        <article className="card">
          <div className="stats-row">
            <div className="stat">
              <b>{project.stats.progress}%</b>
              <span>Complete</span>
            </div>
            <div className="stat">
              <b>{project.stats.total - project.stats.done}</b>
              <span>Open tasks</span>
            </div>
            <div className={`stat ${project.stats.overdue ? 'danger' : ''}`}>
              <b>{project.stats.overdue}</b>
              <span>Overdue</span>
            </div>
            <div className={`stat ${project.stats.blocked ? 'warn' : ''}`}>
              <b>{project.stats.blocked}</b>
              <span>Blocked</span>
            </div>
          </div>
          <div className={`progress big fg-${project.color}`}>
            <i style={{ width: `${project.stats.progress}%` }} />
          </div>
          {project.description ? <Markdown text={project.description} /> : <p className="muted">No description yet.</p>}
        </article>

        <article className="card">
          <div className="section-heading">
            <div>
              <h2>Status updates</h2>
              <p>How the project is going, in the team’s words</p>
            </div>
            {project.can_contribute && (
              <div className="row-gap">
                <button className="btn sm" onClick={draftSummary} title="Build a draft from this week's tasks, decisions and risks">
                  <Icon name="list" size={15} /> Draft weekly summary
                </button>
                {aiEnabled && !project.ai_excluded && (
                  <button className="btn sm" onClick={aiBrief} disabled={aiBusy} title="Draft a readable brief with AI from this week's project records">
                    <Icon name="spark" size={15} /> {aiBusy ? 'Drafting…' : 'AI brief'}
                  </button>
                )}
                <button className="btn primary sm" onClick={() => setUpdating(true)}>
                  Post update
                </button>
              </div>
            )}
          </div>
          {updating && (
            <form
              className="form update-form"
              onSubmit={async (e) => {
                e.preventDefault();
                const ok = await act(() => api.post(`/projects/${project.id}/updates`, update), 'Status update posted');
                if (ok) {
                  setUpdating(false);
                  setSummary(null);
                  setUpdate({ health: update.health, body: '' });
                  reload();
                  reloadUpdates();
                }
              }}
            >
              {summary && <p className="hint-box">This draft was built from project records. Review and edit it before sharing.</p>}
              <div className="health-choice" role="radiogroup" aria-label="Project health">
                {(['on_track', 'at_risk', 'off_track'] as const).map((h) => (
                  <label key={h} className={`health-option health-${h} ${update.health === h ? 'active' : ''}`}>
                    <input type="radio" name="health" checked={update.health === h} onChange={() => setUpdate({ ...update, health: h })} />
                    {HEALTH_LABEL[h]}
                  </label>
                ))}
              </div>
              <textarea rows={6} required value={update.body} onChange={(e) => setUpdate({ ...update, body: e.target.value })} placeholder="What moved, what is at risk, what is next?" />
              <div className="form-actions">
                <button type="button" className="btn" onClick={() => setUpdating(false)}>
                  Cancel
                </button>
                <button className="btn primary">Share with project</button>
              </div>
            </form>
          )}
          {(updates ?? []).slice(0, 5).map((u) => (
            <div key={u.id} className="update">
              <div className="update-head">
                <Avatar user={{ name: u.user_name, color: u.user_color }} size="sm" />
                <strong>{u.user_name}</strong>
                <HealthPill health={u.health} />
                <small className="muted">{timeAgo(u.created_at)}</small>
              </div>
              <Markdown text={u.body} />
            </div>
          ))}
          {updates && !updates.length && !updating && <p className="muted">No status updates yet.</p>}
        </article>
      </div>
      <aside className="right-column">
        <article className="card">
          <div className="section-heading compact">
            <div>
              <h2>Milestones</h2>
            </div>
          </div>
          {project.milestones.map((m) => (
            <div key={m.id} className={`milestone ${m.done_at ? 'done' : ''}`}>
              <input
                type="checkbox"
                checked={!!m.done_at}
                disabled={!project.can_contribute}
                onChange={async (e) => {
                  await act(() => api.patch(`/milestones/${m.id}`, { done: e.target.checked }));
                  reload();
                }}
                aria-label={`Mark ${m.name} complete`}
              />
              <div className="grow">
                <strong>{m.name}</strong>
                <small className="muted block">
                  {m.due_date ? dueLabel(m.due_date) : 'No date'} · {m.done_count}/{m.task_count} tasks
                </small>
              </div>
              {project.can_contribute && (
                <button
                  className="icon-btn xs"
                  aria-label={`Delete ${m.name}`}
                  onClick={async () => {
                    if (!confirm(`Delete milestone ${m.name}?`)) return;
                    await act(() => api.del(`/milestones/${m.id}`));
                    reload();
                  }}
                >
                  <Icon name="x" size={12} />
                </button>
              )}
            </div>
          ))}
          {!project.milestones.length && <p className="muted">No milestones.</p>}
          {project.can_contribute && (
            <form
              className="inline-add"
              onSubmit={async (e) => {
                e.preventDefault();
                if (!milestone.name.trim()) return;
                await act(() => api.post(`/projects/${project.id}/milestones`, { name: milestone.name, dueDate: milestone.dueDate || null }));
                setMilestone({ name: '', dueDate: '' });
                reload();
              }}
            >
              <input value={milestone.name} onChange={(e) => setMilestone({ ...milestone, name: e.target.value })} placeholder="Add milestone" aria-label="Milestone name" />
              <input type="date" value={milestone.dueDate} onChange={(e) => setMilestone({ ...milestone, dueDate: e.target.value })} aria-label="Milestone date" />
            </form>
          )}
        </article>
        <Members project={project} reload={reload} />
      </aside>
    </div>
  );
}

function Members({ project, reload }: { project: ProjectFull; reload: () => void }) {
  const { people, me } = useSession();
  const act = useAction();
  const [ids, setIds] = useState<string[]>([]);
  return (
    <article className="card">
      <div className="section-heading compact">
        <div>
          <h2>Members</h2>
          <p>{project.member_count} people</p>
        </div>
      </div>
      {project.members.map((m) => (
        <div key={m.id} className="list-row">
          <Avatar user={m} size="sm" showPresence />
          <Link to={`/people/${m.id}`} className="grow">
            {m.name} {m.id === project.owner?.id && <span className="pill">Owner</span>}
          </Link>
          {(project.can_manage || m.id === me!.user.id) && m.id !== project.owner?.id && (
            <button
              className="icon-btn xs"
              aria-label={`Remove ${m.name}`}
              onClick={async () => {
                await act(() => api.del(`/projects/${project.id}/members/${m.id}`), 'Removed from project');
                reload();
              }}
            >
              <Icon name="x" size={12} />
            </button>
          )}
        </div>
      ))}
      {project.can_contribute && me!.role !== 'guest' && (
        <div className="add-members">
          <PeoplePicker people={people} value={ids} onChange={setIds} exclude={project.members.map((m) => m.id)} placeholder="Add members…" />
          {ids.length > 0 && (
            <button
              className="btn primary sm"
              onClick={async () => {
                await act(() => api.post(`/projects/${project.id}/members`, { userIds: ids }), 'Members added');
                setIds([]);
                reload();
              }}
            >
              Add {ids.length}
            </button>
          )}
        </div>
      )}
    </article>
  );
}

const COLUMNS: TaskStatus[] = ['todo', 'in_progress', 'blocked', 'review', 'done'];

function ProjectTasks({ project }: { project: ProjectFull }) {
  const { openTask } = useShell();
  const act = useAction();
  const [view, setView] = useState<'list' | 'board'>(() => {
    try {
      return (localStorage.getItem('softex.project.view') as 'list' | 'board') ?? 'list';
    } catch {
      return 'list';
    }
  });
  const [owner, setOwner] = useState('');
  const [milestone, setMilestone] = useState('');
  const [adding, setAdding] = useState<TaskStatus | null>(null);
  const [showDone, setShowDone] = useState(false);
  const dragged = useRef<string | null>(null);
  const { data: tasks, error, reload, setData } = useApi<Task[]>(`/tasks${qs({ projectId: project.id, milestoneId: milestone || undefined })}`);
  useRealtime((e) => e.type === 'task.updated' && e.projectId === project.id && reload());

  const changeView = (v: 'list' | 'board') => {
    setView(v);
    try {
      localStorage.setItem('softex.project.view', v);
    } catch {
      /* ignore */
    }
  };
  const move = async (taskId: string, status: TaskStatus) => {
    setData(tasks?.map((t) => (t.id === taskId ? { ...t, status } : t)));
    await act(() => api.patch(`/tasks/${taskId}`, { status }));
    reload();
  };

  if (error) return <ErrorState error={error} retry={reload} />;
  if (!tasks) return <Loading />;
  const filtered = tasks.filter((t) => !owner || t.owner?.id === owner);
  const owners = [...new Map(tasks.filter((t) => t.owner).map((t) => [t.owner!.id, t.owner!])).values()];

  return (
    <div>
      <div className="toolbar">
        <div className="segmented" role="group" aria-label="View">
          <button className={view === 'list' ? 'active' : ''} onClick={() => changeView('list')}>
            <Icon name="list" size={15} /> List
          </button>
          <button className={view === 'board' ? 'active' : ''} onClick={() => changeView('board')}>
            <Icon name="board" size={15} /> Board
          </button>
        </div>
        <select value={owner} onChange={(e) => setOwner(e.target.value)} aria-label="Filter by owner">
          <option value="">Everyone</option>
          {owners.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
        {project.milestones.length > 0 && (
          <select value={milestone} onChange={(e) => setMilestone(e.target.value)} aria-label="Filter by milestone">
            <option value="">All milestones</option>
            {project.milestones.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        )}
        {view === 'list' && (
          <label className="check-inline">
            <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} /> Show done
          </label>
        )}
        <span className="grow" />
        {project.can_contribute && (
          <button className="btn primary sm" onClick={() => setAdding('todo')}>
            <Icon name="plus" size={15} /> Add task
          </button>
        )}
      </div>

      {view === 'list' ? (
        <div className="card">
          {COLUMNS.filter((s) => showDone || s !== 'done').map((status) => {
            const group = filtered.filter((t) => t.status === status);
            if (!group.length) return null;
            return (
              <section key={status} className="list-group">
                <h3>
                  {STATUS_LABEL[status]} <span className="count">{group.length}</span>
                </h3>
                <div className="task-list">
                  {group.map((t) => (
                    <TaskRow key={t.id} task={t} showProject={false} onOpen={() => openTask(t.id)} onToggle={project.can_contribute ? (d) => move(t.id, d ? 'done' : 'todo') : undefined} />
                  ))}
                </div>
              </section>
            );
          })}
          {!filtered.filter((t) => showDone || t.status !== 'done').length && <Empty icon="task" title="No open tasks" />}
        </div>
      ) : (
        <div className="board">
          {COLUMNS.map((status) => {
            const group = filtered.filter((t) => t.status === status);
            return (
              <section
                key={status}
                className={`board-col col-${status}`}
                onDragOver={(e) => project.can_contribute && e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  e.currentTarget.classList.remove('drop');
                  if (dragged.current) move(dragged.current, status);
                  dragged.current = null;
                }}
                onDragEnter={(e) => e.currentTarget.classList.add('drop')}
                onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && e.currentTarget.classList.remove('drop')}
                aria-label={STATUS_LABEL[status]}
              >
                <h3>
                  <i className={`dot status-${status}`} /> {STATUS_LABEL[status]} <span className="count">{group.length}</span>
                </h3>
                {group.map((t) => (
                  <div
                    key={t.id}
                    className="board-card"
                    draggable={project.can_contribute}
                    onDragStart={() => (dragged.current = t.id)}
                    onClick={() => openTask(t.id)}
                    onKeyDown={(e) => e.key === 'Enter' && openTask(t.id)}
                    tabIndex={0}
                    role="button"
                    aria-label={`${t.title}, ${STATUS_LABEL[t.status]}`}
                  >
                    <strong>{t.title}</strong>
                    {t.status === 'blocked' && t.blocked_reason && <small className="warn-text">{t.blocked_reason}</small>}
                    <div className="board-card-meta">
                      {t.priority === 'urgent' || t.priority === 'high' ? <span className={`pill prio-${t.priority}`}>{t.priority}</span> : null}
                      {t.due_date && <small className={`due ${t.overdue ? 'overdue' : ''}`}>{dueLabel(t.due_date)}</small>}
                      {t.checklist.total > 0 && (
                        <small className="muted">
                          <Icon name="check" size={11} /> {t.checklist.done}/{t.checklist.total}
                        </small>
                      )}
                      <span className="grow" />
                      <Avatar user={t.owner} size="xs" />
                    </div>
                    {project.can_contribute && (
                      <select
                        className="board-move"
                        value={t.status}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => move(t.id, e.target.value as TaskStatus)}
                        aria-label={`Move ${t.title}`}
                      >
                        {COLUMNS.map((c) => (
                          <option key={c} value={c}>
                            {STATUS_LABEL[c]}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                ))}
                {project.can_contribute && (
                  <button className="add-task" onClick={() => setAdding(status)}>
                    <Icon name="plus" size={14} /> Add
                  </button>
                )}
              </section>
            );
          })}
        </div>
      )}
      <Modal open={!!adding} onClose={() => setAdding(null)} title={`New task in ${project.name}`}>
        {adding && (
          <NewTaskForm
            projectId={project.id}
            defaults={{ status: adding, milestoneId: milestone || undefined }}
            onDone={() => {
              setAdding(null);
              reload();
            }}
          />
        )}
      </Modal>
    </div>
  );
}

function ProjectDecisions({ project }: { project: ProjectFull }) {
  const act = useAction();
  const { me } = useSession();
  const { data, reload } = useApi<Decision[]>(`/decisions${qs({ projectId: project.id, limit: 200 })}`);
  const [form, setForm] = useState({ title: '', rationale: '' });
  return (
    <div className="two-col">
      <div className="card">
        <h2>Decision log</h2>
        {!data && <Loading />}
        {data && !data.length && <p className="muted">No decisions recorded yet. Record them from messages, meetings or here.</p>}
        <ul className="decision-list">
          {data?.map((d) => (
            <li key={d.id}>
              <span className="activity-icon decision">
                <Icon name="gavel" size={15} />
              </span>
              <div className="grow">
                <strong>{d.title}</strong>
                {d.rationale && <Markdown text={d.rationale} compact />}
                <small className="muted">
                  {d.decided_by_name} · {dateTime(d.created_at)}
                  {d.channel_id && d.message_id && (
                    <>
                      {' · '}
                      <Link to={`/channels/${d.channel_id}?message=${d.message_id}`}>View discussion</Link>
                    </>
                  )}
                  {d.meeting_id && (
                    <>
                      {' · '}
                      <Link to={`/meetings/${d.meeting_id}`}>From meeting</Link>
                    </>
                  )}
                </small>
              </div>
              {(d.decided_by === me!.user.id || me!.role === 'admin' || me!.role === 'owner') && (
                <button
                  className="icon-btn xs"
                  aria-label="Remove decision"
                  onClick={async () => {
                    if (!confirm('Remove this decision from the log?')) return;
                    await act(() => api.del(`/decisions/${d.id}`));
                    reload();
                  }}
                >
                  <Icon name="x" size={12} />
                </button>
              )}
            </li>
          ))}
        </ul>
      </div>
      {project.can_contribute && (
        <form
          className="card form"
          onSubmit={async (e: FormEvent) => {
            e.preventDefault();
            const ok = await act(() => api.post('/decisions', { ...form, projectId: project.id }), 'Decision recorded');
            if (ok) {
              setForm({ title: '', rationale: '' });
              reload();
            }
          }}
        >
          <h2>Record a decision</h2>
          <Field label="Decision">
            <input required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          </Field>
          <Field label="Rationale">
            <textarea rows={4} value={form.rationale} onChange={(e) => setForm({ ...form, rationale: e.target.value })} />
          </Field>
          <button className="btn primary">Record</button>
        </form>
      )}
    </div>
  );
}

function Risks({ project }: { project: ProjectFull }) {
  const act = useAction();
  const { people } = useSession();
  const { data, reload } = useApi<{ id: string; title: string; impact: string; mitigation: string; owner_id: string | null; owner_name: string | null; status: string }[]>(
    `/projects/${project.id}/risks`,
  );
  const [form, setForm] = useState({ title: '', impact: 'medium', mitigation: '', ownerId: '' });
  return (
    <div className="two-col">
      <div className="card">
        <h2>Risk register</h2>
        {!data && <Loading />}
        {data && !data.length && <p className="muted">No risks recorded.</p>}
        <table className="table">
          <thead>
            <tr>
              <th>Risk</th>
              <th>Impact</th>
              <th>Owner</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {data?.map((r) => (
              <tr key={r.id}>
                <td>
                  <strong>{r.title}</strong>
                  {r.mitigation && <small className="muted block">Mitigation: {r.mitigation}</small>}
                </td>
                <td>
                  <span className={`pill impact-${r.impact}`}>{r.impact}</span>
                </td>
                <td>{r.owner_name ?? '—'}</td>
                <td>
                  <select
                    value={r.status}
                    disabled={!project.can_contribute}
                    onChange={async (e) => {
                      await act(() => api.patch(`/risks/${r.id}`, { status: e.target.value }));
                      reload();
                    }}
                    aria-label={`Status of ${r.title}`}
                  >
                    <option value="open">Open</option>
                    <option value="mitigated">Mitigated</option>
                    <option value="closed">Closed</option>
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {project.can_contribute && (
        <form
          className="card form"
          onSubmit={async (e) => {
            e.preventDefault();
            const ok = await act(() => api.post(`/projects/${project.id}/risks`, { ...form, ownerId: form.ownerId || null }), 'Risk added');
            if (ok) {
              setForm({ title: '', impact: 'medium', mitigation: '', ownerId: '' });
              reload();
            }
          }}
        >
          <h2>Add a risk</h2>
          <Field label="Risk">
            <input required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          </Field>
          <div className="form-row">
            <Field label="Impact">
              <select value={form.impact} onChange={(e) => setForm({ ...form, impact: e.target.value })}>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </Field>
            <Field label="Owner">
              <select value={form.ownerId} onChange={(e) => setForm({ ...form, ownerId: e.target.value })}>
                <option value="">None</option>
                {people.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field label="Mitigation">
            <textarea rows={3} value={form.mitigation} onChange={(e) => setForm({ ...form, mitigation: e.target.value })} />
          </Field>
          <button className="btn primary">Add risk</button>
        </form>
      )}
    </div>
  );
}

function Resources({ project }: { project: ProjectFull }) {
  const act = useAction();
  const navigate = useNavigate();
  const fileInput = useRef<HTMLInputElement>(null);
  const [linking, setLinking] = useState(false);
  const [meeting, setMeeting] = useState(false);
  const [link, setLink] = useState({ name: '', url: '' });
  const { data, reload } = useApi<{
    files: { id: string; name: string; label: string; external_url: string | null; current_version: number; size: number | null; owner_name: string; updated_at: string }[];
    pages: { id: string; title: string; status: string; review_date: string | null; owner_name: string; updated_at: string }[];
    meetings: { id: string; title: string; starts_at: string; ended_at: string | null }[];
    decisions: Decision[];
  }>(`/projects/${project.id}/resources`);
  if (!data) return <Loading />;
  return (
    <div className="resource-grid">
      <article className="card">
        <div className="section-heading compact">
          <h2>Files & links</h2>
          {project.can_contribute && (
            <div className="row-gap">
              <button className="btn sm" onClick={() => setLinking(true)}>
                <Icon name="link" size={14} /> Link
              </button>
              <button className="btn sm" onClick={() => fileInput.current?.click()}>
                <Icon name="upload" size={14} /> Upload
              </button>
              <input
                ref={fileInput}
                type="file"
                hidden
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  const form = new FormData();
                  form.append('file', f);
                  form.append('projectId', project.id);
                  await act(() => api.upload('/files', form), 'File uploaded');
                  e.target.value = '';
                  reload();
                }}
              />
            </div>
          )}
        </div>
        {data.files.map((f) => (
          <Link key={f.id} to={`/files/${f.id}`} className="list-row">
            <Icon name={f.external_url ? 'link' : 'file'} />
            <span className="grow">
              <strong>{f.name}</strong> {f.label && <span className="pill">{f.label}</span>}
              <small className="muted block">
                {f.owner_name} · {f.external_url ? 'External link' : `v${f.current_version} · ${bytes(f.size)}`} · {timeAgo(f.updated_at)}
              </small>
            </span>
          </Link>
        ))}
        {!data.files.length && <p className="muted">No files yet.</p>}
      </article>
      <article className="card">
        <div className="section-heading compact">
          <h2>Knowledge pages</h2>
          {project.can_contribute && (
            <button
              className="btn sm"
              onClick={async () => {
                const page = await act(() => api.post('/pages', { title: 'Untitled page', projectId: project.id }));
                if (page) navigate(`/knowledge/${page.id}?edit=1`);
              }}
            >
              <Icon name="plus" size={14} /> Page
            </button>
          )}
        </div>
        {data.pages.map((p) => (
          <Link key={p.id} to={`/knowledge/${p.id}`} className="list-row">
            <Icon name="book" />
            <span className="grow">
              <strong>{p.title}</strong> {p.status === 'approved' && <span className="pill status-done">Approved</span>}
              <small className="muted block">
                {p.owner_name} · updated {timeAgo(p.updated_at)}
              </small>
            </span>
          </Link>
        ))}
        {!data.pages.length && <p className="muted">No pages yet.</p>}
      </article>
      <article className="card">
        <div className="section-heading compact">
          <h2>Meetings</h2>
          {project.can_contribute && (
            <button className="btn sm" onClick={() => setMeeting(true)}>
              <Icon name="plus" size={14} /> Schedule
            </button>
          )}
        </div>
        {data.meetings.map((m) => (
          <Link key={m.id} to={`/meetings/${m.id}`} className="list-row">
            <Icon name="video" />
            <span className="grow">
              <strong>{m.title}</strong>
              <small className="muted block">
                {dateTime(m.starts_at)} {m.ended_at && '· notes available'}
              </small>
            </span>
          </Link>
        ))}
        {!data.meetings.length && <p className="muted">No meetings yet.</p>}
      </article>
      <article className="card">
        <div className="section-heading compact">
          <h2>Decisions</h2>
        </div>
        {data.decisions.slice(0, 8).map((d) => (
          <div key={d.id} className="list-row">
            <Icon name="gavel" />
            <span className="grow">
              <strong>{d.title}</strong>
              <small className="muted block">
                {d.decided_by_name} · {timeAgo(d.created_at)}
              </small>
            </span>
          </div>
        ))}
        {!data.decisions.length && <p className="muted">No decisions yet.</p>}
      </article>
      <Modal open={linking} onClose={() => setLinking(false)} title="Link an external file">
        <form
          className="form"
          onSubmit={async (e) => {
            e.preventDefault();
            const ok = await act(() => api.post('/files/link', { ...link, projectId: project.id }), 'Link added');
            if (ok) {
              setLinking(false);
              setLink({ name: '', url: '' });
              reload();
            }
          }}
        >
          <Field label="Name">
            <input required value={link.name} onChange={(e) => setLink({ ...link, name: e.target.value })} placeholder="e.g. Budget spreadsheet" />
          </Field>
          <Field label="URL" hint="Links to Google Drive, OneDrive, Dropbox, Figma or any https address.">
            <input required type="url" value={link.url} onChange={(e) => setLink({ ...link, url: e.target.value })} placeholder="https://…" />
          </Field>
          <div className="form-actions">
            <button className="btn primary">Add link</button>
          </div>
        </form>
      </Modal>
      <Modal open={meeting} onClose={() => setMeeting(false)} title={`Schedule a meeting for ${project.name}`} wide>
        <NewMeetingForm projectId={project.id} onDone={() => setMeeting(false)} />
      </Modal>
    </div>
  );
}

function Checkins({ project }: { project: ProjectFull }) {
  const [open, setOpen] = useState(false);
  const { data, reload } = useApi<{ id: string; user_name: string; user_color: string; done: string; next: string; blockers: string; created_at: string }[]>(
    `/checkins${qs({ projectId: project.id })}`,
  );
  return (
    <div className="card">
      <div className="section-heading">
        <div>
          <h2>Check-ins</h2>
          <p>Short async updates instead of a status meeting</p>
        </div>
        {project.can_contribute && (
          <button className="btn primary sm" onClick={() => setOpen(true)}>
            Check in
          </button>
        )}
      </div>
      {!data && <Loading />}
      {data && !data.length && <p className="muted">No check-ins yet.</p>}
      {data?.map((c) => (
        <div key={c.id} className="checkin">
          <div className="update-head">
            <Avatar user={{ name: c.user_name, color: c.user_color }} size="sm" />
            <strong>{c.user_name}</strong>
            <small className="muted">{timeAgo(c.created_at)}</small>
          </div>
          <dl>
            {c.done && (
              <>
                <dt>Done</dt>
                <dd>{c.done}</dd>
              </>
            )}
            {c.next && (
              <>
                <dt>Next</dt>
                <dd>{c.next}</dd>
              </>
            )}
            {c.blockers && (
              <>
                <dt className="warn-text">Blockers</dt>
                <dd>{c.blockers}</dd>
              </>
            )}
          </dl>
        </div>
      ))}
      <CheckinModal open={open} onClose={() => setOpen(false)} onDone={reload} projectId={project.id} />
    </div>
  );
}

function ProjectActivity({ projectId }: { projectId: string }) {
  const { data } = useApi<{ id: string; actor_name: string; actor_color: string; summary: string; link: string; created_at: string }[]>(`/projects/${projectId}/activity`);
  if (!data) return <Loading />;
  return (
    <div className="card">
      {!data.length && <p className="muted">No activity yet.</p>}
      <ul className="timeline">
        {data.map((a) => (
          <li key={a.id}>
            <Avatar user={{ name: a.actor_name, color: a.actor_color }} size="xs" /> <strong>{a.actor_name}</strong>{' '}
            {a.link ? <Link to={a.link}>{a.summary}</Link> : a.summary} <small className="muted">{timeAgo(a.created_at)}</small>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ProjectSettings({ open, onClose, project, onSaved }: { open: boolean; onClose: () => void; project: ProjectFull; onSaved: () => void }) {
  const act = useAction();
  const navigate = useNavigate();
  const [form, setForm] = useState({
    name: project.name,
    description: project.description,
    visibility: project.visibility,
    dueDate: project.due_date ?? '',
    ownerId: project.owner?.id ?? '',
    color: project.color,
  });
  return (
    <Modal open={open} onClose={onClose} title="Project settings" wide>
      <form
        className="form"
        onSubmit={async (e) => {
          e.preventDefault();
          const ok = await act(() => api.patch(`/projects/${project.id}`, { ...form, dueDate: form.dueDate || null }), 'Project updated');
          if (ok) {
            onClose();
            onSaved();
          }
        }}
      >
        <Field label="Name">
          <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label="Description">
          <textarea rows={4} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </Field>
        <div className="form-row">
          <Field label="Visibility" hint="Private projects are only visible to members, including in search.">
            <select value={form.visibility} onChange={(e) => setForm({ ...form, visibility: e.target.value as 'workspace' | 'private' })}>
              <option value="workspace">Everyone in the workspace</option>
              <option value="private">Private to members</option>
            </select>
          </Field>
          <Field label="Target date">
            <input type="date" value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} />
          </Field>
        </div>
        <div className="form-row">
          <Field label="Owner (accountable)">
            <select value={form.ownerId} onChange={(e) => setForm({ ...form, ownerId: e.target.value })}>
              {project.members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Colour">
            <div className="color-row">
              {['purple', 'blue', 'green', 'coral', 'gold', 'sky', 'mint', 'orange'].map((c) => (
                <button type="button" key={c} className={`swatch bg-${c} ${form.color === c ? 'active' : ''}`} onClick={() => setForm({ ...form, color: c })} aria-label={c} aria-pressed={form.color === c} />
              ))}
            </div>
          </Field>
        </div>
        <label className="check-row">
          <input
            type="checkbox"
            checked={!project.ai_excluded}
            onChange={async (e) => {
              await act(() => api.patch('/ai/exclusions', { projectId: project.id, excluded: !e.target.checked }), e.target.checked ? 'AI assistance allowed' : 'AI assistance turned off for this project');
              onSaved();
            }}
          />
          <span>
            <strong>Allow AI assistance</strong>
            <small className="muted block">When off, AI summaries and briefs never read this project’s content.</small>
          </span>
        </label>
        <div className="form-actions spread">
          <button
            type="button"
            className="btn danger-text"
            onClick={async () => {
              const archiving = !project.archived_at;
              if (archiving && !confirm('Archive this project? It will be hidden from active lists but kept for reference.')) return;
              await act(() => api.patch(`/projects/${project.id}`, { archived: archiving }), archiving ? 'Project archived' : 'Project restored');
              onClose();
              archiving ? navigate('/projects') : onSaved();
            }}
          >
            {project.archived_at ? 'Restore project' : 'Archive project'}
          </button>
          <button className="btn primary">Save changes</button>
        </div>
      </form>
    </Modal>
  );
}
