import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, type CustomField, type Feature, type Project } from '../api';
import { BarChart, DonutChart, LineChart, type SeriesItem } from '../components/Charts';
import { FavoriteButton } from '../components/Favorites';
import { Icon } from '../components/Icon';
import { useShell } from '../components/Layout';
import { Markdown } from '../components/Markdown';
import { UpgradeNotice, usePlan } from '../components/Plan';
import { Empty, ErrorState, Field, HealthPill, Loading, Modal, StatusPill, useAction } from '../components/ui';
import { dueLabel, timeAgo } from '../format';
import { useApi, useRealtime } from '../hooks';

type WidgetType = 'number' | 'status' | 'priority' | 'owner' | 'label' | 'field' | 'trend' | 'time' | 'goals' | 'projects' | 'due' | 'note';
type Metric = 'open' | 'overdue' | 'blocked' | 'done_week' | 'due_week' | 'hours_week' | 'field_sum';

export interface Widget {
  id: string;
  type: WidgetType;
  title: string;
  size: 'half' | 'full';
  chart?: 'bar' | 'donut';
  projectIds: string[];
  metric?: Metric;
  fieldId?: string;
  weeks?: number;
  text?: string;
}

interface Dashboard {
  id: string;
  name: string;
  description: string;
  visibility: 'private' | 'workspace';
  owner: { id: string; name: string } | null;
  widgets: Widget[];
  can_edit: boolean;
  updated_at: string;
}

type WidgetData =
  | { kind: 'number'; value: number; unit: string; tone?: 'good' | 'bad' | 'warn'; note?: string }
  | { kind: 'series'; items: SeriesItem[]; unit?: string }
  | { kind: 'trend'; labels: string[]; series: { key: string; label: string; values: number[] }[] }
  | {
      kind: 'list';
      items: { id: string; title: string; link?: string; task?: boolean; progress?: number; status?: string; owner?: string | null; color?: string; detail?: string; due_date?: string; overdue?: boolean }[];
    }
  | { kind: 'note' }
  | { kind: 'locked'; feature: Feature }
  | { kind: 'empty'; reason?: string };

export const WIDGET_LABEL: Record<WidgetType, string> = {
  number: 'Number',
  status: 'Tasks by status',
  priority: 'Open tasks by priority',
  owner: 'Open tasks by owner',
  label: 'Open tasks by label',
  field: 'Open tasks by a dropdown field',
  trend: 'Created vs completed (weekly)',
  time: 'Hours logged by person',
  goals: 'Goal progress',
  projects: 'Project progress and health',
  due: 'Due soon and overdue',
  note: 'Text note',
};

const METRIC_LABEL: Record<Metric, string> = {
  open: 'Open tasks',
  overdue: 'Overdue tasks',
  blocked: 'Blocked tasks',
  done_week: 'Completed this week',
  due_week: 'Due this week',
  hours_week: 'Hours logged this week',
  field_sum: 'Sum of a number field',
};

const CHARTABLE: WidgetType[] = ['status', 'priority', 'owner', 'label', 'field', 'time'];

/** Dashboards: pages of charts over the work you can see (Monday, Asana, ClickUp dashboards). */
export function Dashboards() {
  const plan = usePlan();
  const navigate = useNavigate();
  const act = useAction();
  const { data, error, reload } = useApi<(Omit<Dashboard, 'widgets' | 'owner'> & { owner_name: string })[]>('/dashboards');
  // Without the feature, dashboards made earlier stay viewable.
  const readOnly = !plan.has('insights');
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [visibility, setVisibility] = useState<'workspace' | 'private'>('workspace');
  if (readOnly && data && !data.length) {
    return (
      <div className="page">
        <h1>Dashboards</h1>
        <UpgradeNotice feature="insights" />
      </div>
    );
  }
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Dashboards</h1>
          <p className="muted">Charts over tasks, time and goals. Everyone sees numbers from the projects they can open, so sharing a dashboard never shares private work.</p>
        </div>
        {!readOnly && (
          <button className="btn primary" onClick={() => setCreating(true)}>
            <Icon name="plus" size={16} /> New dashboard
          </button>
        )}
      </div>
      {readOnly && <UpgradeNotice feature="insights" compact readOnly />}
      {error ? (
        <ErrorState error={error} retry={reload} />
      ) : !data ? (
        <Loading />
      ) : !data.length ? (
        <Empty
          icon="chart"
          title="No dashboards yet"
          action={
            <button className="btn primary" onClick={() => setCreating(true)}>
              <Icon name="plus" size={16} /> New dashboard
            </button>
          }
        >
          Create one to see open work, overdue tasks, progress and trends at a glance. It starts with useful charts you can change.
        </Empty>
      ) : (
        <div className="card-list">
          {data.map((d) => (
            <Link key={d.id} to={`/dashboards/${d.id}`} className="card pad dash-card">
              <div className="row-gap">
                <Icon name="chart" size={18} />
                <strong className="grow">{d.name}</strong>
                {d.visibility === 'private' && <Icon name="lock" size={14} />}
              </div>
              {d.description && <p className="muted small">{d.description}</p>}
              <small className="muted">
                {d.owner_name} · updated {timeAgo(d.updated_at)}
              </small>
            </Link>
          ))}
        </div>
      )}
      <Modal open={creating} onClose={() => setCreating(false)} title="New dashboard">
        <form
          className="stack"
          onSubmit={async (e) => {
            e.preventDefault();
            const d = await act(() => api.post<Dashboard>('/dashboards', { name, visibility }));
            if (d) navigate(`/dashboards/${d.id}`);
          }}
        >
          <Field label="Name">
            <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} placeholder="Operations this quarter" autoFocus />
          </Field>
          <Field label="Who can open it">
            <select value={visibility} onChange={(e) => setVisibility(e.target.value as 'workspace' | 'private')}>
              <option value="workspace">Everyone in the workspace (each sees their own data)</option>
              <option value="private">Only me</option>
            </select>
          </Field>
          <div className="form-actions">
            <button type="button" className="btn" onClick={() => setCreating(false)}>
              Cancel
            </button>
            <button className="btn primary" disabled={!name.trim()}>
              Create
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

export function DashboardView() {
  const { id } = useParams();
  const act = useAction();
  const navigate = useNavigate();
  const { data: dash, error, reload, setData } = useApi<Dashboard>(`/dashboards/${id}`);
  const { data: values, reload: reloadData } = useApi<{ computed_at: string; widgets: Record<string, WidgetData> }>(`/dashboards/${id}/data`);
  const [editing, setEditing] = useState(false);
  const [editWidget, setEditWidget] = useState<Widget | 'new' | null>(null);
  const [renaming, setRenaming] = useState(false);
  const refresh = useRef<number | undefined>(undefined);

  // Keep numbers current as work changes, without refetching on every single event.
  useRealtime((e) => {
    if (e.type !== 'task.updated' && e.type !== 'reconnected') return;
    window.clearTimeout(refresh.current);
    refresh.current = window.setTimeout(reloadData, 1500);
  });
  useEffect(() => () => window.clearTimeout(refresh.current), []);

  if (error) return <ErrorState error={error} retry={reload} />;
  if (!dash) return <Loading />;

  const save = async (widgets: Widget[]) => {
    setData({ ...dash, widgets });
    const saved = await act(() => api.patch<Dashboard>(`/dashboards/${dash.id}`, { widgets }));
    if (saved) setData(saved);
    reloadData();
  };
  const move = (i: number, by: number) => {
    const next = [...dash.widgets];
    const [w] = next.splice(i, 1);
    next.splice(Math.max(0, Math.min(next.length, i + by)), 0, w);
    save(next);
  };

  return (
    <div className="page wide">
      <div className="page-head">
        <div className="grow">
          <p className="eyebrow">
            <Link to="/dashboards">Dashboards</Link> {dash.visibility === 'private' && '· PRIVATE'}
          </p>
          <h1>
            {dash.name} <FavoriteButton kind="dashboard" id={dash.id} />
          </h1>
          {dash.description && <p className="muted">{dash.description}</p>}
          <small className="muted">Updated {values ? timeAgo(values.computed_at) : '…'} · numbers reflect the projects you can open</small>
        </div>
        <div className="row-gap wrap">
          <button className="btn" onClick={reloadData} aria-label="Refresh numbers" title="Refresh">
            <Icon name="refresh" size={15} />
          </button>
          {dash.can_edit && (
            <>
              {editing && (
                <button className="btn" onClick={() => setEditWidget('new')}>
                  <Icon name="plus" size={15} /> Add widget
                </button>
              )}
              <button className={`btn ${editing ? 'primary' : ''}`} onClick={() => setEditing((e) => !e)}>
                <Icon name={editing ? 'check' : 'edit'} size={15} /> {editing ? 'Done' : 'Edit'}
              </button>
            </>
          )}
        </div>
      </div>

      {editing && (
        <div className="card pad row-gap wrap dash-settings">
          <button className="link-btn" onClick={() => setRenaming(true)}>
            Rename or share
          </button>
          <span className="grow" />
          <button
            className="btn sm danger-text"
            onClick={async () => {
              if (!confirm('Delete this dashboard? The work it shows is not affected.')) return;
              if (await act(() => api.del(`/dashboards/${dash.id}`), 'Dashboard deleted')) navigate('/dashboards');
            }}
          >
            <Icon name="trash" size={14} /> Delete dashboard
          </button>
        </div>
      )}

      {!dash.widgets.length && (
        <Empty icon="chart" title="This dashboard is empty">
          {dash.can_edit ? 'Choose Edit, then Add widget.' : 'Its owner has not added any charts yet.'}
        </Empty>
      )}
      <div className="dash-grid">
        {dash.widgets.map((w, i) => (
          <section key={w.id} className={`card dash-widget ${w.size === 'full' ? 'full' : ''} ${w.type === 'number' ? 'metric' : ''}`} aria-label={w.title || WIDGET_LABEL[w.type]}>
            <header className="dash-widget-head">
              <h3>{w.title || (w.type === 'number' ? METRIC_LABEL[w.metric ?? 'open'] : WIDGET_LABEL[w.type])}</h3>
              {editing && (
                <span className="row-gap">
                  <button className="icon-btn xs" aria-label="Move earlier" disabled={i === 0} onClick={() => move(i, -1)}>
                    <Icon name="chevronLeft" size={13} />
                  </button>
                  <button className="icon-btn xs" aria-label="Move later" disabled={i === dash.widgets.length - 1} onClick={() => move(i, 1)}>
                    <Icon name="chevronRight" size={13} />
                  </button>
                  <button className="icon-btn xs" aria-label={`Edit ${w.title || WIDGET_LABEL[w.type]}`} onClick={() => setEditWidget(w)}>
                    <Icon name="edit" size={13} />
                  </button>
                  <button className="icon-btn xs" aria-label="Remove widget" onClick={() => save(dash.widgets.filter((x) => x.id !== w.id))}>
                    <Icon name="x" size={13} />
                  </button>
                </span>
              )}
            </header>
            <WidgetBody widget={w} data={values?.widgets[w.id]} />
          </section>
        ))}
      </div>

      {editWidget && (
        <WidgetEditor
          widget={editWidget === 'new' ? null : editWidget}
          onClose={() => setEditWidget(null)}
          onSave={(w) => {
            setEditWidget(null);
            const exists = dash.widgets.some((x) => x.id === w.id);
            save(exists ? dash.widgets.map((x) => (x.id === w.id ? w : x)) : [...dash.widgets, w]);
          }}
        />
      )}
      {renaming && (
        <DashboardSettings
          dash={dash}
          onClose={() => setRenaming(false)}
          onSaved={(d) => {
            setData(d);
            setRenaming(false);
          }}
        />
      )}
    </div>
  );
}

function WidgetBody({ widget: w, data }: { widget: Widget; data: WidgetData | undefined }) {
  const { openTask } = useShell();
  if (w.type === 'note') return w.text ? <Markdown text={w.text} compact /> : <p className="muted">Empty note.</p>;
  if (!data) return <div className="dash-loading" aria-busy="true" />;
  switch (data.kind) {
    case 'number':
      return (
        <div className={`big-metric ${data.tone ?? ''}`}>
          <strong>{data.value.toLocaleString()}</strong>
          <small className="muted">
            {data.unit}
            {data.note && ` · ${data.note}`}
          </small>
        </div>
      );
    case 'series': {
      const total = data.items.reduce((s, i) => s + i.value, 0);
      if (!total) return <p className="muted">Nothing to show yet.</p>;
      const donut = (w.chart ?? (w.type === 'status' || w.type === 'field' ? 'donut' : 'bar')) === 'donut';
      return donut ? <DonutChart items={data.items} label={data.unit ?? 'tasks'} /> : <BarChart items={data.items} unit={data.unit} />;
    }
    case 'trend':
      return <LineChart labels={data.labels} series={data.series} />;
    case 'list':
      if (!data.items.length) return <p className="muted">Nothing here.</p>;
      return (
        <ul className="dash-list">
          {data.items.map((item) =>
            item.task ? (
              <li key={item.id}>
                <button className="link-btn text-left grow" onClick={() => openTask(item.id)}>
                  {item.title}
                </button>
                {item.owner && <small className="muted">{item.owner}</small>}
                {item.status && item.status !== 'todo' && <StatusPill status={item.status} />}
                <small className={`due ${item.overdue ? 'overdue' : ''}`}>{dueLabel(item.due_date ?? null)}</small>
              </li>
            ) : (
              <li key={item.id}>
                <Link to={item.link ?? '#'} className="grow dash-list-link">
                  {item.color && <span className={`project-dot bg-${item.color}`} />} {item.title}
                  {item.detail && <small className="muted"> · {item.detail}</small>}
                </Link>
                {item.progress !== undefined && (
                  <span className="dash-progress">
                    <span className="progress">
                      <i style={{ width: `${Math.round(item.progress * 100)}%` }} />
                    </span>
                    <small>{Math.round(item.progress * 100)}%</small>
                  </span>
                )}
                {item.status && (item.status === 'done' ? <span className="pill status-done">Achieved</span> : <HealthPill health={item.status} />)}
              </li>
            ),
          )}
        </ul>
      );
    case 'locked':
      return <UpgradeNotice feature={data.feature} compact />;
    case 'empty':
      return <p className="muted">{data.reason ?? 'Nothing to show.'}</p>;
    default:
      return null;
  }
}

function WidgetEditor({ widget, onClose, onSave }: { widget: Widget | null; onClose: () => void; onSave: (w: Widget) => void }) {
  const { data: projects } = useApi<Project[]>('/projects');
  const [w, setW] = useState<Widget>(widget ?? { id: `w${Date.now().toString(36)}`, type: 'status', title: '', size: 'half', projectIds: [] });
  const [fields, setFields] = useState<CustomField[]>([]);
  const set = (patch: Partial<Widget>) => setW((x) => ({ ...x, ...patch }));
  const needsField = w.type === 'field' || (w.type === 'number' && w.metric === 'field_sum');

  // Fields come from the chosen projects.
  useEffect(() => {
    if (!needsField || !w.projectIds.length) return setFields([]);
    let live = true;
    Promise.all(w.projectIds.map((p) => api.get<CustomField[]>(`/projects/${p}/fields`).catch(() => [])))
      .then((lists) => live && setFields(lists.flat()))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [needsField, w.projectIds]);
  const fieldOptions = fields.filter((f) => (w.type === 'field' ? f.type === 'select' : f.type === 'number'));

  return (
    <Modal open onClose={onClose} title={widget ? 'Edit widget' : 'Add widget'}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          onSave({
            ...w,
            chart: CHARTABLE.includes(w.type) ? w.chart : undefined,
            metric: w.type === 'number' ? w.metric ?? 'open' : undefined,
            fieldId: needsField ? w.fieldId : undefined,
            weeks: w.type === 'trend' || w.type === 'time' ? w.weeks ?? (w.type === 'trend' ? 8 : 4) : undefined,
            text: w.type === 'note' ? w.text ?? '' : undefined,
          });
        }}
      >
        <Field label="Show">
          <select value={w.type} onChange={(e) => set({ type: e.target.value as WidgetType, size: e.target.value === 'trend' ? 'full' : w.size })}>
            {(Object.keys(WIDGET_LABEL) as WidgetType[]).map((t) => (
              <option key={t} value={t}>
                {WIDGET_LABEL[t]}
              </option>
            ))}
          </select>
        </Field>
        {w.type === 'number' && (
          <Field label="Measure">
            <select value={w.metric ?? 'open'} onChange={(e) => set({ metric: e.target.value as Metric })}>
              {(Object.keys(METRIC_LABEL) as Metric[]).map((m) => (
                <option key={m} value={m}>
                  {METRIC_LABEL[m]}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Title" hint="Leave empty to use the default.">
          <input value={w.title} onChange={(e) => set({ title: e.target.value })} maxLength={80} />
        </Field>
        {w.type === 'note' && (
          <Field label="Text" hint="Markdown works.">
            <textarea rows={5} value={w.text ?? ''} onChange={(e) => set({ text: e.target.value })} maxLength={4000} />
          </Field>
        )}
        {w.type !== 'note' && (
          <Field label="Projects" hint={needsField ? 'Pick the project that has the field.' : 'None selected means every project you can open.'}>
            <div className="chips-select">
              {(projects ?? [])
                .filter((p) => !p.archived_at)
                .map((p) => (
                  <label key={p.id} className="check-inline">
                    <input
                      type="checkbox"
                      checked={w.projectIds.includes(p.id)}
                      onChange={(e) => set({ projectIds: e.target.checked ? [...w.projectIds, p.id] : w.projectIds.filter((x) => x !== p.id) })}
                    />
                    <span className={`project-dot bg-${p.color}`} /> {p.name}
                  </label>
                ))}
            </div>
          </Field>
        )}
        {needsField && (
          <Field label="Field">
            <select value={w.fieldId ?? ''} onChange={(e) => set({ fieldId: e.target.value || undefined })} required>
              <option value="">{w.projectIds.length ? (fieldOptions.length ? 'Choose a field…' : 'No suitable fields in these projects') : 'Choose a project first'}</option>
              {fieldOptions.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <div className="grid-2">
          {CHARTABLE.includes(w.type) && (
            <Field label="Chart">
              <select value={w.chart ?? (w.type === 'status' || w.type === 'field' ? 'donut' : 'bar')} onChange={(e) => set({ chart: e.target.value as 'bar' | 'donut' })}>
                <option value="bar">Bars</option>
                <option value="donut">Donut</option>
              </select>
            </Field>
          )}
          {(w.type === 'trend' || w.type === 'time') && (
            <Field label="Weeks">
              <input type="number" min={2} max={26} value={w.weeks ?? (w.type === 'trend' ? 8 : 4)} onChange={(e) => set({ weeks: Number(e.target.value) })} />
            </Field>
          )}
          <Field label="Width">
            <select value={w.size} onChange={(e) => set({ size: e.target.value as 'half' | 'full' })}>
              <option value="half">Half</option>
              <option value="full">Full</option>
            </select>
          </Field>
        </div>
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary">{widget ? 'Save widget' : 'Add widget'}</button>
        </div>
      </form>
    </Modal>
  );
}

function DashboardSettings({ dash, onClose, onSaved }: { dash: Dashboard; onClose: () => void; onSaved: (d: Dashboard) => void }) {
  const act = useAction();
  const [name, setName] = useState(dash.name);
  const [description, setDescription] = useState(dash.description);
  const [visibility, setVisibility] = useState(dash.visibility);
  return (
    <Modal open onClose={onClose} title="Dashboard settings">
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          const d = await act(() => api.patch<Dashboard>(`/dashboards/${dash.id}`, { name, description, visibility }), 'Saved');
          if (d) onSaved(d);
        }}
      >
        <Field label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} />
        </Field>
        <Field label="Description">
          <textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={1000} />
        </Field>
        <Field label="Who can open it">
          <select value={visibility} onChange={(e) => setVisibility(e.target.value as 'workspace' | 'private')}>
            <option value="workspace">Everyone in the workspace (each sees their own data)</option>
            <option value="private">Only me</option>
          </select>
        </Field>
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!name.trim()}>
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}
