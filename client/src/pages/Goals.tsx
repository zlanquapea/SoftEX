import { useState } from 'react';
import { dateLabel } from '../format';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, type Project, type UserRef } from '../api';
import { Avatar } from '../components/Avatar';
import { FavoriteButton } from '../components/Favorites';
import { Icon } from '../components/Icon';
import { UpgradeNotice, usePlan } from '../components/Plan';
import { Empty, ErrorState, Field, HealthPill, Loading, Modal, Tabs, useAction } from '../components/ui';
import { useApi } from '../hooks';
import { useSession } from '../session';

type GoalStatus = 'on_track' | 'at_risk' | 'off_track' | 'done';
interface KeyResult {
  id: string;
  title: string;
  kind: 'number' | 'tasks';
  start_value: number;
  target_value: number;
  current_value: number;
  unit: string;
  project: { id: string; name: string; color: string } | null;
  progress: number;
}
export interface Goal {
  id: string;
  parent_id: string | null;
  title: string;
  description: string;
  owner: UserRef | null;
  due_date: string | null;
  status: GoalStatus;
  progress: number;
  key_results: KeyResult[];
  projects: { id: string; name: string; color: string; health: string }[];
  can_edit: boolean;
  created_at: string;
  archived_at: string | null;
}

const STATUS_LABEL: Record<GoalStatus, string> = { on_track: 'On track', at_risk: 'At risk', off_track: 'Off track', done: 'Achieved' };
const pct = (p: number) => `${Math.round(p * 100)}%`;

function GoalStatusPill({ status }: { status: GoalStatus }) {
  return status === 'done' ? <span className="pill status-done">Achieved</span> : <HealthPill health={status} />;
}

function Progress({ value, big = false }: { value: number; big?: boolean }) {
  return (
    <div className={`progress ${big ? 'big' : ''}`} role="progressbar" aria-valuenow={Math.round(value * 100)} aria-valuemin={0} aria-valuemax={100}>
      <i style={{ width: pct(Math.min(1, Math.max(0, value))) }} />
    </div>
  );
}

/** Company and team goals with measurable key results (Asana Goals, Monday OKRs, ClickUp Goals). */
export function Goals() {
  const plan = usePlan();
  const [tab, setTab] = useState<'active' | 'archived'>('active');
  const [creating, setCreating] = useState(false);
  const { data, error, reload } = useApi<Goal[]>(`/goals?archived=${tab === 'archived'}`);
  // Without the feature, goals made earlier (on a trial or a higher plan) stay readable.
  const readOnly = !plan.has('goals');
  if (readOnly && data && !data.length && tab === 'active') {
    return (
      <div className="page">
        <h1>Goals</h1>
        <UpgradeNotice feature="goals" />
      </div>
    );
  }
  const ids = new Set(data?.map((g) => g.id));
  const roots = (data ?? []).filter((g) => !g.parent_id || !ids.has(g.parent_id));
  const children = (id: string) => (data ?? []).filter((g) => g.parent_id === id);
  const counts = (data ?? []).reduce<Record<string, number>>((acc, g) => ({ ...acc, [g.status]: (acc[g.status] ?? 0) + 1 }), {});

  const renderGoal = (g: Goal, depth: number): React.ReactNode => (
    <div key={g.id}>
      <Link to={`/goals/${g.id}`} className="goal-row" style={{ paddingLeft: 12 + depth * 22 }}>
        <Icon name={depth ? 'chevronRight' : 'target'} size={16} />
        <span className="goal-title">
          <strong>{g.title}</strong>
          <small className="muted">
            {g.key_results.length} key result{g.key_results.length === 1 ? '' : 's'}
            {g.due_date && <> · due {dateLabel(g.due_date)}</>}
          </small>
        </span>
        <span className="goal-progress">
          <Progress value={g.progress} />
          <small>{pct(g.progress)}</small>
        </span>
        <GoalStatusPill status={g.status} />
        <Avatar user={g.owner} size="sm" />
      </Link>
      {children(g.id).map((c) => renderGoal(c, depth + 1))}
    </div>
  );

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Goals</h1>
          <p className="muted">What the organisation is aiming for this season, how far along it is, and the projects that get it there.</p>
        </div>
        {!readOnly && (
          <button className="btn primary" onClick={() => setCreating(true)}>
            <Icon name="plus" size={16} /> New goal
          </button>
        )}
      </div>
      {readOnly && <UpgradeNotice feature="goals" compact readOnly />}
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'active', label: 'Active' },
          { id: 'archived', label: 'Archived' },
        ]}
      />
      {error ? (
        <ErrorState error={error} retry={reload} />
      ) : !data ? (
        <Loading />
      ) : !data.length ? (
        <Empty
          icon="target"
          title={tab === 'active' ? 'No goals yet' : 'Nothing archived'}
          action={
            tab === 'active' &&
            !readOnly && (
              <button className="btn primary" onClick={() => setCreating(true)}>
                <Icon name="plus" size={16} /> New goal
              </button>
            )
          }
        >
          {tab === 'active' && 'Set a goal, add key results you can measure, and link the projects that move it.'}
        </Empty>
      ) : (
        <>
          {tab === 'active' && (
            <div className="summary-pills">
              {(['on_track', 'at_risk', 'off_track', 'done'] as GoalStatus[]).map((s) => (
                <span key={s} className="pill">
                  {counts[s] ?? 0} {STATUS_LABEL[s].toLowerCase()}
                </span>
              ))}
            </div>
          )}
          <div className="card goal-list">{roots.map((g) => renderGoal(g, 0))}</div>
        </>
      )}
      {creating && (
        <GoalForm
          goals={data ?? []}
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            reload();
          }}
        />
      )}
    </div>
  );
}

function GoalForm({ goal, goals, onClose, onSaved }: { goal?: Goal; goals: Goal[]; onClose: () => void; onSaved: (g: Goal) => void }) {
  const act = useAction();
  const { people, me } = useSession();
  const { data: projects } = useApi<Project[]>('/projects');
  const [title, setTitle] = useState(goal?.title ?? '');
  const [description, setDescription] = useState(goal?.description ?? '');
  const [ownerId, setOwnerId] = useState(goal?.owner?.id ?? me!.user.id);
  const [dueDate, setDueDate] = useState(goal?.due_date ?? '');
  const [parentId, setParentId] = useState(goal?.parent_id ?? '');
  const [projectIds, setProjectIds] = useState<string[]>(goal?.projects.map((p) => p.id) ?? []);
  return (
    <Modal open onClose={onClose} title={goal ? 'Edit goal' : 'New goal'}>
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          const body = { title, description, ownerId, dueDate: dueDate || null, parentId: parentId || null, projectIds };
          const saved = await act(() => (goal ? api.patch<Goal>(`/goals/${goal.id}`, body) : api.post<Goal>('/goals', body)), goal ? 'Goal saved' : 'Goal created');
          if (saved) onSaved(saved);
        }}
      >
        <Field label="Goal">
          <input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} placeholder="Reach 5,000 active customers this year" autoFocus />
        </Field>
        <Field label="Why it matters">
          <textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={5000} />
        </Field>
        <div className="grid-2">
          <Field label="Owner">
            <select value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Due">
            <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </Field>
        </div>
        <Field label="Part of" hint="Nest team goals under a company goal.">
          <select value={parentId} onChange={(e) => setParentId(e.target.value)}>
            <option value="">Top-level goal</option>
            {goals
              .filter((g) => g.id !== goal?.id)
              .map((g) => (
                <option key={g.id} value={g.id}>
                  {g.title}
                </option>
              ))}
          </select>
        </Field>
        <Field label="Supporting projects">
          <div className="chips-select">
            {(projects ?? [])
              .filter((p) => !p.archived_at)
              .map((p) => (
                <label key={p.id} className="check-inline">
                  <input type="checkbox" checked={projectIds.includes(p.id)} onChange={(e) => setProjectIds(e.target.checked ? [...projectIds, p.id] : projectIds.filter((x) => x !== p.id))} />
                  <span className={`project-dot bg-${p.color}`} /> {p.name}
                </label>
              ))}
          </div>
        </Field>
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!title.trim()}>
            {goal ? 'Save' : 'Create goal'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function GoalDetail() {
  const { id } = useParams();
  const act = useAction();
  const navigate = useNavigate();
  const { data: goal, error, reload, setData } = useApi<Goal>(`/goals/${id}`);
  const { data: all } = useApi<Goal[]>('/goals');
  const { data: projects } = useApi<Project[]>('/projects');
  const [editing, setEditing] = useState(false);
  const [addingKr, setAddingKr] = useState(false);
  if (error) return <ErrorState error={error} retry={reload} />;
  if (!goal) return <Loading />;
  const parent = all?.find((g) => g.id === goal.parent_id);
  const subGoals = (all ?? []).filter((g) => g.parent_id === goal.id);
  const update = async (patch: Record<string, unknown>) => {
    const saved = await act(() => api.patch<Goal>(`/goals/${goal.id}`, patch));
    if (saved) setData(saved);
  };

  return (
    <div className="page narrow">
      <p className="eyebrow">
        <Link to="/goals">Goals</Link>
        {parent && (
          <>
            {' '}
            / <Link to={`/goals/${parent.id}`}>{parent.title}</Link>
          </>
        )}
      </p>
      <div className="page-head">
        <div className="grow">
          <h1>
            {goal.title} <FavoriteButton kind="goal" id={goal.id} />
          </h1>
          <div className="project-meta">
            <GoalStatusPill status={goal.status} />
            <span>
              Owner: <strong>{goal.owner?.name}</strong>
            </span>
            {goal.due_date && <span>Due {dateLabel(goal.due_date)}</span>}
            {goal.archived_at && <span className="pill">Archived</span>}
          </div>
        </div>
        {goal.can_edit && (
          <button className="btn" onClick={() => setEditing(true)}>
            <Icon name="edit" size={15} /> Edit
          </button>
        )}
      </div>

      <section className="card pad stack">
        <div className="row-gap">
          <strong className="big-number">{pct(goal.progress)}</strong>
          <div className="grow">
            <Progress value={goal.progress} big />
          </div>
        </div>
        {goal.can_edit && (
          <div className="segmented" role="group" aria-label="Status">
            {(['on_track', 'at_risk', 'off_track', 'done'] as GoalStatus[]).map((s) => (
              <button key={s} className={goal.status === s ? 'active' : ''} onClick={() => update({ status: s })}>
                {STATUS_LABEL[s]}
              </button>
            ))}
          </div>
        )}
        {goal.description && <p className="pre-wrap">{goal.description}</p>}
      </section>

      <section className="detail-section">
        <div className="section-title">
          <h3>Key results</h3>
          {goal.can_edit && (
            <button className="link-btn" onClick={() => setAddingKr(true)}>
              Add
            </button>
          )}
        </div>
        {!goal.key_results.length && <p className="muted">No key results yet. {goal.projects.length ? 'Progress follows the linked projects’ tasks.' : ''}</p>}
        {goal.key_results.map((kr) => (
          <KeyResultRow key={kr.id} kr={kr} canEdit={goal.can_edit} onChanged={reload} />
        ))}
      </section>

      <section className="detail-section">
        <div className="section-title">
          <h3>Supporting projects</h3>
        </div>
        {!goal.projects.length && <p className="muted">No linked projects.</p>}
        {goal.projects.map((p) => (
          <Link key={p.id} to={`/projects/${p.id}`} className="mini-task">
            <span className={`project-dot bg-${p.color}`} /> {p.name} <HealthPill health={p.health} />
          </Link>
        ))}
      </section>

      {subGoals.length > 0 && (
        <section className="detail-section">
          <div className="section-title">
            <h3>Sub-goals</h3>
          </div>
          {subGoals.map((g) => (
            <Link key={g.id} to={`/goals/${g.id}`} className="mini-task">
              <Icon name="target" size={14} /> {g.title} <small className="muted">{pct(g.progress)}</small> <GoalStatusPill status={g.status} />
            </Link>
          ))}
        </section>
      )}

      {goal.can_edit && (
        <div className="row-gap">
          <button className="btn" onClick={() => update({ archived: !goal.archived_at })}>
            {goal.archived_at ? 'Restore' : 'Archive'}
          </button>
          <button
            className="btn danger-text"
            onClick={async () => {
              if (!confirm('Delete this goal and its key results?')) return;
              if (await act(() => api.del(`/goals/${goal.id}`), 'Goal deleted')) navigate('/goals');
            }}
          >
            <Icon name="trash" size={15} /> Delete
          </button>
        </div>
      )}

      {editing && (
        <GoalForm
          goal={goal}
          goals={all ?? []}
          onClose={() => setEditing(false)}
          onSaved={(g) => {
            setData(g);
            setEditing(false);
          }}
        />
      )}
      {addingKr && <KeyResultForm goalId={goal.id} projects={projects ?? []} onClose={() => setAddingKr(false)} onSaved={(g) => { setData(g); setAddingKr(false); }} />}
    </div>
  );
}

function KeyResultRow({ kr, canEdit, onChanged }: { kr: KeyResult; canEdit: boolean; onChanged: () => void }) {
  const act = useAction();
  const fmt = (n: number) => `${Number(n).toLocaleString()}${kr.unit ? ` ${kr.unit}` : ''}`;
  return (
    <div className="kr-row">
      <div className="grow">
        <strong>{kr.title}</strong>
        <small className="muted">
          {kr.kind === 'tasks' ? (
            <>
              {kr.current_value} of {kr.target_value} tasks done {kr.project && <>in <Link to={`/projects/${kr.project.id}`}>{kr.project.name}</Link></>}
            </>
          ) : (
            <>
              {fmt(kr.current_value)} of {fmt(kr.target_value)} (from {fmt(kr.start_value)})
            </>
          )}
        </small>
        <Progress value={kr.progress} />
      </div>
      {kr.kind === 'number' && (
        <input
          type="number"
          className="narrow-input"
          defaultValue={kr.current_value}
          key={kr.current_value}
          aria-label={`Current value of ${kr.title}`}
          onBlur={async (e) => {
            const v = Number(e.target.value);
            if (e.target.value === '' || v === kr.current_value) return;
            await act(() => api.patch(`/key-results/${kr.id}`, { currentValue: v }), 'Progress updated');
            onChanged();
          }}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
      )}
      <strong className="kr-pct">{pct(kr.progress)}</strong>
      {canEdit && (
        <button
          className="icon-btn xs"
          aria-label={`Delete ${kr.title}`}
          onClick={async () => {
            if (!confirm('Delete this key result?')) return;
            await act(() => api.del(`/key-results/${kr.id}`));
            onChanged();
          }}
        >
          <Icon name="x" size={12} />
        </button>
      )}
    </div>
  );
}

function KeyResultForm({ goalId, projects, onClose, onSaved }: { goalId: string; projects: Project[]; onClose: () => void; onSaved: (g: Goal) => void }) {
  const act = useAction();
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<'number' | 'tasks'>('number');
  const [start, setStart] = useState('0');
  const [target, setTarget] = useState('100');
  const [unit, setUnit] = useState('');
  const [projectId, setProjectId] = useState('');
  return (
    <Modal open onClose={onClose} title="New key result">
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          const body = kind === 'tasks' ? { title, kind, projectId } : { title, kind, startValue: Number(start), targetValue: Number(target), unit };
          const g = await act(() => api.post<Goal>(`/goals/${goalId}/key-results`, body), 'Key result added');
          if (g) onSaved(g);
        }}
      >
        <Field label="Key result">
          <input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} placeholder="Sign 40 new schools" autoFocus />
        </Field>
        <div className="segmented" role="group" aria-label="Measured by">
          <button type="button" className={kind === 'number' ? 'active' : ''} onClick={() => setKind('number')}>
            A number
          </button>
          <button type="button" className={kind === 'tasks' ? 'active' : ''} onClick={() => setKind('tasks')}>
            Tasks done in a project
          </button>
        </div>
        {kind === 'number' ? (
          <div className="grid-3">
            <Field label="Start">
              <input type="number" value={start} onChange={(e) => setStart(e.target.value)} required />
            </Field>
            <Field label="Target">
              <input type="number" value={target} onChange={(e) => setTarget(e.target.value)} required />
            </Field>
            <Field label="Unit">
              <input value={unit} onChange={(e) => setUnit(e.target.value)} maxLength={20} placeholder="schools, %, US$" />
            </Field>
          </div>
        ) : (
          <Field label="Project">
            <select value={projectId} onChange={(e) => setProjectId(e.target.value)} required>
              <option value="">Choose a project…</option>
              {projects
                .filter((p) => !p.archived_at)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </select>
          </Field>
        )}
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!title.trim()}>
            Add
          </button>
        </div>
      </form>
    </Modal>
  );
}
