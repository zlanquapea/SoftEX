import { useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, qs, type Channel, type Priority, type Task, type TaskStatus } from '../api';
import { Avatar } from '../components/Avatar';
import { Icon } from '../components/Icon';
import { useShell } from '../components/Layout';
import { WhenModal } from '../components/Later';
import { UpgradeNotice, usePlan } from '../components/Plan';
import { Empty, ErrorState, Field, Loading, Modal, Tabs, useAction } from '../components/ui';
import { dateTime, plainMentions, STATUS_LABEL, timeAgo } from '../format';
import { useApi, useRealtime } from '../hooks';
import { useSession } from '../session';

const DAY = 86_400_000;
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const parseDay = (s: string) => new Date(`${s}T00:00:00Z`);
const addDays = (s: string, n: number) => isoDay(new Date(parseDay(s).getTime() + n * DAY));
const daysBetween = (a: string, b: string) => Math.round((parseDay(b).getTime() - parseDay(a).getTime()) / DAY);
const shortDate = (s: string) => parseDay(s).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });

// ======================= Workload =======================

interface WorkloadItem {
  id: string;
  title: string;
  due_date: string | null;
  project: string;
  color: string;
  estimate_hours: number | null;
}
interface WorkloadData {
  weeks: string[];
  capacity_hours_per_week: number;
  rows: { person: { id: string; name: string; color: string; title: string }; total: number; buckets: Record<string, { tasks: number; hours: number; items: WorkloadItem[] }> }[];
}

export function Workload() {
  const { has } = usePlan();
  if (!has('planning')) {
    return (
      <div className="page">
        <div className="page-head">
          <div>
            <p className="eyebrow">PLANNING</p>
            <h1>Workload</h1>
          </div>
        </div>
        <UpgradeNotice feature="planning" />
      </div>
    );
  }
  return <WorkloadView />;
}

function WorkloadView() {
  const { openTask } = useShell();
  const [weeks, setWeeks] = useState(4);
  const [projectId, setProjectId] = useState('');
  const [teamId, setTeamId] = useState('');
  const [cell, setCell] = useState<{ person: string; key: string; items: WorkloadItem[] } | null>(null);
  const { data: projects } = useApi<{ id: string; name: string }[]>('/projects');
  const { data: teams } = useApi<{ id: string; name: string }[]>('/teams');
  const { data, error, reload } = useApi<WorkloadData>(`/workload${qs({ weeks, projectId, teamId })}`);
  useRealtime((e) => e.type === 'task.updated' && reload());

  const keys = data ? ['overdue', ...data.weeks, 'unscheduled'] : [];
  const label = (k: string) => (k === 'overdue' ? 'Overdue' : k === 'unscheduled' ? 'No date' : `Week of ${shortDate(k)}`);
  // Without estimates, assume a task is about a day's work so the heat map still says something useful.
  const load = (b: { tasks: number; hours: number }) => (b.hours || b.tasks * 6) / (data?.capacity_hours_per_week ?? 32);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <p className="eyebrow">PLANNING</p>
          <h1>Workload</h1>
          <p className="muted">Open tasks per person by due week. Use it to spot overload before it becomes a missed deadline.</p>
        </div>
      </div>
      <div className="row-gap wrap toolbar">
        <select value={projectId} onChange={(e) => setProjectId(e.target.value)} aria-label="Project">
          <option value="">All projects</option>
          {(projects ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <select value={teamId} onChange={(e) => setTeamId(e.target.value)} aria-label="Team">
          <option value="">Everyone</option>
          {(teams ?? []).map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        <select value={weeks} onChange={(e) => setWeeks(Number(e.target.value))} aria-label="Weeks shown">
          {[2, 4, 6, 8, 12].map((n) => (
            <option key={n} value={n}>
              {n} weeks
            </option>
          ))}
        </select>
        <span className="grow" />
        <span className="legend">
          <i className="load-0" /> Light <i className="load-2" /> Full <i className="load-3" /> Over capacity
        </span>
      </div>
      {error && <ErrorState error={error} retry={reload} />}
      {!data && !error && <Loading />}
      {data && !data.rows.length && <Empty icon="users" title="No one has open work here" />}
      {data && data.rows.length > 0 && (
        <div className="table-scroll">
          <table className="workload">
            <thead>
              <tr>
                <th scope="col">Person</th>
                {keys.map((k) => (
                  <th scope="col" key={k}>
                    {label(k)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row) => (
                <tr key={row.person.id}>
                  <th scope="row">
                    <Link to={`/people/${row.person.id}`} className="row-gap">
                      <Avatar user={row.person} size="sm" />
                      <span>
                        <strong>{row.person.name}</strong>
                        <small className="muted">{row.total} open</small>
                      </span>
                    </Link>
                  </th>
                  {keys.map((k) => {
                    const b = row.buckets[k];
                    const level = k === 'unscheduled' ? 0 : Math.min(3, Math.floor(load(b) * 2.2));
                    return (
                      <td key={k}>
                        {b.tasks > 0 ? (
                          <button
                            className={`load-cell load-${k === 'overdue' ? 'late' : level}`}
                            onClick={() => setCell({ person: row.person.name, key: k, items: b.items })}
                            aria-label={`${row.person.name}, ${label(k)}: ${b.tasks} tasks`}
                          >
                            <strong>{b.tasks}</strong>
                            {b.hours > 0 && <small>{b.hours}h</small>}
                          </button>
                        ) : (
                          <span className="load-cell none">·</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Modal open={!!cell} onClose={() => setCell(null)} title={cell ? `${cell.person} · ${label(cell.key)}` : ''}>
        {cell?.items.map((t) => (
          <button
            key={t.id}
            className="search-result"
            onClick={() => {
              setCell(null);
              openTask(t.id);
            }}
          >
            <span className={`dot bg-${t.color}`} />
            <span>
              <strong>{t.title}</strong>
              <small>
                {t.project} · {t.due_date ? `due ${shortDate(t.due_date)}` : 'no due date'}
                {t.estimate_hours ? ` · ${t.estimate_hours}h` : ''}
              </small>
            </span>
          </button>
        ))}
      </Modal>
    </div>
  );
}

// ======================= Later: reminders and scheduled messages =======================

interface Reminder {
  id: string;
  remind_at: string;
  note: string;
  task_id: string | null;
  task_title: string | null;
  message_id: string | null;
  message_body: string | null;
  channel_id: string | null;
}
interface Scheduled {
  id: string;
  channel_id: string;
  channel_name: string;
  channel_kind: string;
  parent_id: string | null;
  body: string;
  send_at: string;
  failed_reason: string | null;
}

export function Later() {
  const act = useAction();
  const [tab, setTab] = useState<'reminders' | 'scheduled'>('reminders');
  const [adding, setAdding] = useState(false);
  const [moving, setMoving] = useState<Scheduled | null>(null);
  const reminders = useApi<Reminder[]>('/reminders');
  const scheduled = useApi<Scheduled[]>('/scheduled-messages');
  useRealtime((e) => {
    if (e.type === 'notification' || e.type === 'message.created') {
      reminders.reload();
      scheduled.reload();
    }
  });

  return (
    <div className="page narrow">
      <div className="page-head">
        <div>
          <p className="eyebrow">LATER</p>
          <h1>Reminders and scheduled messages</h1>
          <p className="muted">Nudges for your future self, and messages that go out at a better time for the people receiving them.</p>
        </div>
        <button className="btn primary" onClick={() => setAdding(true)}>
          <Icon name="plus" size={16} /> Reminder
        </button>
      </div>
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'reminders', label: 'Reminders', count: reminders.data?.length },
          { id: 'scheduled', label: 'Scheduled messages', count: scheduled.data?.length },
        ]}
      />
      {tab === 'reminders' && (
        <>
          {reminders.error && <ErrorState error={reminders.error} retry={reminders.reload} />}
          {!reminders.data && !reminders.error && <Loading />}
          {reminders.data && !reminders.data.length && (
            <Empty icon="clock" title="No reminders">
              Use “Remind me” on a message or task, or add a note here.
            </Empty>
          )}
          <ul className="later-list">
            {reminders.data?.map((r) => (
              <li key={r.id} className="card later-item">
                <Icon name="clock" />
                <div className="grow">
                  <strong>{dateTime(r.remind_at)}</strong>
                  <p>
                    {r.note && <span>{r.note} </span>}
                    {r.task_id && <Link to={`/tasks/${r.task_id}`}>Task: {r.task_title}</Link>}
                    {r.message_id && r.channel_id && <Link to={`/channels/${r.channel_id}?message=${r.message_id}`}>“{plainMentions(r.message_body ?? '').slice(0, 120)}”</Link>}
                  </p>
                </div>
                <button
                  className="icon-btn"
                  aria-label="Delete reminder"
                  onClick={async () => (await act(() => api.del(`/reminders/${r.id}`), 'Reminder removed')) && reminders.reload()}
                >
                  <Icon name="trash" size={16} />
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {tab === 'scheduled' && (
        <>
          {scheduled.error && <ErrorState error={scheduled.error} retry={scheduled.reload} />}
          {!scheduled.data && !scheduled.error && <Loading />}
          {scheduled.data && !scheduled.data.length && (
            <Empty icon="send" title="Nothing scheduled">
              Write a message, then choose the clock next to Send.
            </Empty>
          )}
          <ul className="later-list">
            {scheduled.data?.map((s) => (
              <li key={s.id} className={`card later-item ${s.failed_reason ? 'failed' : ''}`}>
                <Icon name="send" />
                <div className="grow">
                  <strong>
                    {dateTime(s.send_at)} · <Link to={`/channels/${s.channel_id}`}>{s.channel_kind === 'dm' ? 'Direct message' : `#${s.channel_name}`}</Link>
                    {s.parent_id && <small className="muted"> (thread reply)</small>}
                  </strong>
                  <p>{plainMentions(s.body).slice(0, 280)}</p>
                  {s.failed_reason && <p className="danger-text small">Not sent: {s.failed_reason}</p>}
                </div>
                <button className="btn sm" onClick={() => setMoving(s)}>
                  Reschedule
                </button>
                <button
                  className="icon-btn"
                  aria-label="Cancel scheduled message"
                  onClick={async () => (await act(() => api.del(`/scheduled-messages/${s.id}`), 'Scheduled message cancelled')) && scheduled.reload()}
                >
                  <Icon name="trash" size={16} />
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      <WhenModal
        open={adding}
        onClose={() => setAdding(false)}
        eyebrow="REMINDER"
        title="New reminder"
        confirmLabel="Set reminder"
        withNote
        onPick={async (iso, note) => {
          const ok = await act(() => api.post('/reminders', { remindAt: iso, note }), 'Reminder set');
          if (ok) reminders.reload();
          return ok;
        }}
      />
      <WhenModal
        open={!!moving}
        onClose={() => setMoving(null)}
        eyebrow="SEND LATER"
        title="Reschedule message"
        confirmLabel="Reschedule"
        onPick={async (iso) => {
          const ok = await act(() => api.patch(`/scheduled-messages/${moving!.id}`, { sendAt: iso }), 'Rescheduled');
          if (ok) scheduled.reload();
          return ok;
        }}
      />
    </div>
  );
}

// ======================= Project timeline (Gantt) =======================

interface Milestone {
  id: string;
  name: string;
  due_date: string | null;
  done_at: string | null;
}

export function ProjectTimeline({ projectId, milestones, canEdit }: { projectId: string; milestones: Milestone[]; canEdit: boolean }) {
  const { openTask } = useShell();
  const act = useAction();
  const [showDone, setShowDone] = useState(false);
  const { data: tasks, error, reload, setData } = useApi<Task[]>(`/tasks${qs({ projectId })}`);
  useRealtime((e) => e.type === 'task.updated' && e.projectId === projectId && reload());
  const drag = useRef<{ id: string; x: number; mode: 'move' | 'end'; start: string; due: string } | null>(null);
  const [preview, setPreview] = useState<{ id: string; start: string; due: string } | null>(null);
  const PX = 28;

  const visible = useMemo(
    () =>
      (tasks ?? [])
        .filter((t) => showDone || t.status !== 'done')
        .filter((t) => t.due_date)
        .sort((a, b) => (a.start_date ?? a.due_date!).localeCompare(b.start_date ?? b.due_date!)),
    [tasks, showDone],
  );
  const undated = (tasks ?? []).filter((t) => !t.due_date && t.status !== 'done');

  const range = useMemo(() => {
    const today = isoDay(new Date());
    const dates = [today, ...visible.flatMap((t) => [t.start_date ?? t.due_date!, t.due_date!]), ...milestones.flatMap((m) => (m.due_date ? [m.due_date] : []))];
    let from = addDays(dates.reduce((a, b) => (a < b ? a : b)), -3);
    let to = addDays(dates.reduce((a, b) => (a > b ? a : b)), 7);
    if (daysBetween(from, to) < 35) to = addDays(from, 35);
    if (daysBetween(from, to) > 240) from = addDays(to, -240);
    return { from, to, days: daysBetween(from, to) + 1, today };
  }, [visible, milestones]);

  const x = (d: string) => Math.max(0, Math.min(range.days, daysBetween(range.from, d))) * PX;
  const months = useMemo(() => {
    const out: { label: string; left: number }[] = [];
    for (let i = 0; i < range.days; i++) {
      const d = addDays(range.from, i);
      if (i === 0 || d.endsWith('-01')) out.push({ label: parseDay(d).toLocaleDateString(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' }), left: i * PX });
    }
    return out;
  }, [range]);

  const onPointerDown = (e: React.PointerEvent, t: Task, mode: 'move' | 'end') => {
    if (!canEdit) return;
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { id: t.id, x: e.clientX, mode, start: t.start_date ?? t.due_date!, due: t.due_date! };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const delta = Math.round((e.clientX - d.x) / PX);
    if (d.mode === 'move') setPreview({ id: d.id, start: addDays(d.start, delta), due: addDays(d.due, delta) });
    else {
      const due = addDays(d.due, delta);
      setPreview({ id: d.id, start: d.start, due: due < d.start ? d.start : due });
    }
  };
  const onPointerUp = async (t: Task) => {
    const p = preview;
    drag.current = null;
    setPreview(null);
    if (!p || p.id !== t.id || (p.due === t.due_date && p.start === (t.start_date ?? t.due_date))) {
      if (!p) openTask(t.id);
      return;
    }
    setData((prev) => prev?.map((x) => (x.id === t.id ? { ...x, start_date: p.start === p.due ? x.start_date : p.start, due_date: p.due } : x)));
    await act(() => api.patch(`/tasks/${t.id}`, { dueDate: p.due, startDate: p.start === p.due && !t.start_date ? null : p.start }), 'Rescheduled');
    reload();
  };

  if (error) return <ErrorState error={error} retry={reload} />;
  if (!tasks) return <Loading />;

  return (
    <div className="timeline-wrap">
      <div className="row-gap wrap toolbar">
        <span className="muted small">
          {canEdit ? 'Drag a bar to move it, or its right edge to change the due date. Click to open.' : 'Click a bar to open the task.'}
        </span>
        <span className="grow" />
        <label className="check-inline">
          <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} /> Show done
        </label>
      </div>
      {!visible.length && !milestones.some((m) => m.due_date) ? (
        <Empty icon="calendar" title="Nothing on the timeline yet">
          Give tasks a due date (and optionally a start date) to see them here.
        </Empty>
      ) : (
        <div className="timeline" role="figure" aria-label="Project timeline">
          <div className="tl-labels">
            <div className="tl-head" />
            {milestones.some((m) => m.due_date) && <div className="tl-row tl-label muted">Milestones</div>}
            {visible.map((t) => (
              <button key={t.id} className="tl-row tl-label" onClick={() => openTask(t.id)} title={t.title}>
                <span className={`dot status-${t.status}`} aria-label={STATUS_LABEL[t.status]} />
                <span className="ellipsis">{t.title}</span>
              </button>
            ))}
          </div>
          <div className="tl-scroll">
            <div className="tl-canvas" style={{ width: range.days * PX }}>
              <div className="tl-head">
                {months.map((m) => (
                  <span key={m.left} className="tl-month" style={{ left: m.left }}>
                    {m.label}
                  </span>
                ))}
                {Array.from({ length: range.days }, (_, i) => {
                  const d = addDays(range.from, i);
                  const dow = parseDay(d).getUTCDay();
                  return (
                    <span key={d} className={`tl-day ${dow === 0 || dow === 6 ? 'weekend' : ''}`} style={{ left: i * PX, width: PX }}>
                      {d.slice(8)}
                    </span>
                  );
                })}
              </div>
              <div className="tl-today" style={{ left: x(range.today) + PX / 2 }} aria-hidden="true" />
              {milestones.some((m) => m.due_date) && (
                <div className="tl-row">
                  {milestones
                    .filter((m) => m.due_date)
                    .map((m) => (
                      <span key={m.id} className={`tl-milestone ${m.done_at ? 'done' : ''}`} style={{ left: x(m.due_date!) + PX / 2 }} title={`${m.name} · ${shortDate(m.due_date!)}`}>
                        <i />
                        <small>{m.name}</small>
                      </span>
                    ))}
                </div>
              )}
              {visible.map((t) => {
                const p = preview?.id === t.id ? preview : null;
                const start = p?.start ?? t.start_date ?? t.due_date!;
                const due = p?.due ?? t.due_date!;
                const s = start > due ? due : start;
                return (
                  <div key={t.id} className="tl-row">
                    <div
                      className={`tl-bar status-${t.status} ${t.overdue ? 'overdue' : ''} ${canEdit ? 'editable' : ''} ${daysBetween(s, due) < 4 ? 'short' : ''}`}
                      style={{ left: x(s), width: (daysBetween(s, due) + 1) * PX - 4 }}
                      onPointerDown={(e) => onPointerDown(e, t, 'move')}
                      onPointerMove={onPointerMove}
                      onPointerUp={() => onPointerUp(t)}
                      title={`${t.title}\n${shortDate(s)} → ${shortDate(due)}${t.owner ? `\n${t.owner.name}` : ''}`}
                    >
                      {t.owner && <Avatar user={t.owner} size="xs" />}
                      <span className="ellipsis">{t.title}</span>
                      {canEdit && <i className="tl-handle" onPointerDown={(e) => onPointerDown(e, t, 'end')} />}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
      {undated.length > 0 && (
        <p className="muted small pad">
          {undated.length} open task{undated.length === 1 ? ' has' : 's have'} no due date and {undated.length === 1 ? 'is' : 'are'} not shown.
        </p>
      )}
    </div>
  );
}

// ======================= Project automations =======================

interface Rule {
  id: string;
  name: string;
  trigger_type: string;
  trigger_config: { to_status?: TaskStatus; from_status?: TaskStatus; priority?: Priority };
  action_type: string;
  action_config: { user_id?: string; target?: string; priority?: Priority; channel_id?: string; text?: string; items?: string[] };
  enabled: boolean;
  run_count: number;
  last_run_at: string | null;
  created_by: { id: string; name: string } | null;
}

const TRIGGER_LABEL: Record<string, string> = {
  'task.created': 'A task is created',
  'task.status_changed': 'A task changes status',
  'task.overdue': 'A task becomes overdue',
};
const ACTION_LABEL: Record<string, string> = {
  assign: 'Assign it to someone',
  set_priority: 'Set its priority',
  notify: 'Notify someone',
  post_message: 'Post in a channel',
  add_checklist: 'Add checklist items',
};
const TARGET_LABEL: Record<string, string> = { owner: 'the task owner', reviewer: 'the reviewer', project_owner: 'the project owner', user: 'a specific person' };

const TEMPLATES: { name: string; description: string; rule: Partial<RuleDraft> }[] = [
  {
    name: 'Review handoff',
    description: 'When a task moves to review, notify the reviewer.',
    rule: { name: 'Hand off to reviewer', triggerType: 'task.status_changed', toStatus: 'review', actionType: 'notify', target: 'reviewer', text: '“{{task}}” is ready for your review.' },
  },
  {
    name: 'Blocked escalation',
    description: 'When a task becomes blocked, tell the project owner.',
    rule: { name: 'Escalate blockers', triggerType: 'task.status_changed', toStatus: 'blocked', actionType: 'notify', target: 'project_owner', text: '“{{task}}” in {{project}} is blocked.' },
  },
  {
    name: 'Overdue is urgent',
    description: 'Raise priority to urgent when a task slips past its due date.',
    rule: { name: 'Overdue tasks are urgent', triggerType: 'task.overdue', actionType: 'set_priority', priority: 'urgent' },
  },
  {
    name: 'Definition of done',
    description: 'Add a standard checklist to every new task.',
    rule: { name: 'Definition of done', triggerType: 'task.created', actionType: 'add_checklist', items: 'Acceptance criteria agreed\nReviewed by a teammate\nDocs updated' },
  },
];

interface RuleDraft {
  name: string;
  triggerType: string;
  toStatus: string;
  fromStatus: string;
  priorityFilter: string;
  actionType: string;
  target: string;
  userId: string;
  priority: string;
  channelId: string;
  text: string;
  items: string;
}
const EMPTY: RuleDraft = {
  name: '',
  triggerType: 'task.created',
  toStatus: '',
  fromStatus: '',
  priorityFilter: '',
  actionType: 'notify',
  target: 'owner',
  userId: '',
  priority: 'high',
  channelId: '',
  text: '',
  items: '',
};

const toDraft = (r: Rule): RuleDraft => ({
  name: r.name,
  triggerType: r.trigger_type,
  toStatus: r.trigger_config.to_status ?? '',
  fromStatus: r.trigger_config.from_status ?? '',
  priorityFilter: r.trigger_config.priority ?? '',
  actionType: r.action_type,
  target: r.action_config.target ?? 'user',
  userId: r.action_config.user_id ?? '',
  priority: r.action_config.priority ?? 'high',
  channelId: r.action_config.channel_id ?? '',
  text: r.action_config.text ?? '',
  items: (r.action_config.items ?? []).join('\n'),
});

function describe(r: Rule, people: { id: string; name: string }[], channels: Channel[]) {
  const when =
    r.trigger_type === 'task.status_changed'
      ? `a task moves${r.trigger_config.from_status ? ` from ${STATUS_LABEL[r.trigger_config.from_status]}` : ''}${r.trigger_config.to_status ? ` to ${STATUS_LABEL[r.trigger_config.to_status]}` : ''}`
      : TRIGGER_LABEL[r.trigger_type].replace(/^A /, 'a ');
  const who = (target?: string, userId?: string) => (target && target !== 'user' ? TARGET_LABEL[target] : people.find((p) => p.id === userId)?.name ?? 'someone');
  const c = r.action_config;
  const then =
    r.action_type === 'assign'
      ? `assign it to ${who(c.target, c.user_id)}`
      : r.action_type === 'set_priority'
        ? `set priority to ${c.priority}`
        : r.action_type === 'notify'
          ? `notify ${who(c.target, c.user_id)}`
          : r.action_type === 'post_message'
            ? `post in #${channels.find((ch) => ch.id === c.channel_id)?.name ?? 'a channel'}`
            : `add ${c.items?.length ?? 0} checklist item${c.items?.length === 1 ? '' : 's'}`;
  return `When ${when}${r.trigger_config.priority ? ` (priority ${r.trigger_config.priority})` : ''}, ${then}.`;
}

export function ProjectAutomations({ projectId }: { projectId: string }) {
  const act = useAction();
  const { people } = useSession();
  const { data, error, reload } = useApi<{ can_manage: boolean; automations: Rule[] }>(`/projects/${projectId}/automations`);
  const { data: channels } = useApi<Channel[]>('/channels');
  const [editing, setEditing] = useState<{ id?: string; draft: RuleDraft } | null>(null);
  const [runsFor, setRunsFor] = useState<Rule | null>(null);

  if (error) return <ErrorState error={error} retry={reload} />;
  if (!data) return <Loading />;
  const postable = (channels ?? []).filter((c) => c.kind !== 'dm' && c.joined && (c.kind === 'public' || c.project_id === projectId));

  const save = async () => {
    if (!editing) return;
    const d = editing.draft;
    const triggerConfig: Record<string, string> = {};
    if (d.triggerType === 'task.status_changed') {
      if (d.toStatus) triggerConfig.to_status = d.toStatus;
      if (d.fromStatus) triggerConfig.from_status = d.fromStatus;
    }
    if (d.priorityFilter) triggerConfig.priority = d.priorityFilter;
    const actionConfig: Record<string, unknown> = {};
    if (d.actionType === 'assign' || d.actionType === 'notify') {
      actionConfig.target = d.actionType === 'assign' && d.target !== 'project_owner' ? 'user' : d.target;
      if (actionConfig.target === 'user') actionConfig.user_id = d.userId;
      if (d.actionType === 'notify' && d.text) actionConfig.text = d.text;
    }
    if (d.actionType === 'set_priority') actionConfig.priority = d.priority;
    if (d.actionType === 'post_message') Object.assign(actionConfig, { channel_id: d.channelId, text: d.text || undefined });
    if (d.actionType === 'add_checklist') actionConfig.items = d.items.split('\n').map((s) => s.trim()).filter(Boolean);
    const body = { name: d.name || TRIGGER_LABEL[d.triggerType], triggerType: d.triggerType, triggerConfig, actionType: d.actionType, actionConfig };
    const ok = await act(
      () => (editing.id ? api.patch(`/automations/${editing.id}`, body) : api.post(`/projects/${projectId}/automations`, body)),
      editing.id ? 'Automation updated' : 'Automation created',
    );
    if (ok) {
      setEditing(null);
      reload();
    }
  };

  const set = (patch: Partial<RuleDraft>) => setEditing((e) => (e ? { ...e, draft: { ...e.draft, ...patch } } : e));
  const d = editing?.draft;

  return (
    <div className="automations">
      <div className="row-gap wrap toolbar">
        <p className="muted grow">
          Automations run “when this happens, do that” for tasks in this project. They act with their creator’s access, never trigger each other, and every run is logged.
        </p>
        {data.can_manage && (
          <button className="btn primary" onClick={() => setEditing({ draft: { ...EMPTY } })}>
            <Icon name="plus" size={16} /> New automation
          </button>
        )}
      </div>
      {!data.automations.length && (
        <>
          <Empty icon="refresh" title="No automations yet">
            {data.can_manage ? 'Start from a template or build your own.' : 'Project managers can add automations.'}
          </Empty>
          {data.can_manage && (
            <div className="template-grid">
              {TEMPLATES.map((t) => (
                <button key={t.name} className="card template" onClick={() => setEditing({ draft: { ...EMPTY, ...t.rule } })}>
                  <strong>{t.name}</strong>
                  <small className="muted">{t.description}</small>
                </button>
              ))}
            </div>
          )}
        </>
      )}
      <ul className="rule-list">
        {data.automations.map((r) => (
          <li key={r.id} className={`card rule ${r.enabled ? '' : 'disabled'}`}>
            <div className="grow">
              <strong>{r.name}</strong>
              <p>{describe(r, people, channels ?? [])}</p>
              <small className="muted">
                Ran {r.run_count} time{r.run_count === 1 ? '' : 's'}
                {r.last_run_at && `, last ${timeAgo(r.last_run_at)}`} · by {r.created_by?.name ?? 'a former member'}
              </small>
            </div>
            <button className="btn sm" onClick={() => setRunsFor(r)}>
              Run log
            </button>
            {data.can_manage && (
              <>
                <label className="switch" title={r.enabled ? 'Turn off' : 'Turn on'}>
                  <input
                    type="checkbox"
                    checked={r.enabled}
                    aria-label={`${r.name} enabled`}
                    onChange={async (e) => (await act(() => api.patch(`/automations/${r.id}`, { enabled: e.target.checked }))) && reload()}
                  />
                  <span />
                </label>
                <button className="icon-btn" aria-label={`Edit ${r.name}`} onClick={() => setEditing({ id: r.id, draft: toDraft(r) })}>
                  <Icon name="edit" size={16} />
                </button>
                <button
                  className="icon-btn"
                  aria-label={`Delete ${r.name}`}
                  onClick={async () => confirm(`Delete “${r.name}”?`) && (await act(() => api.del(`/automations/${r.id}`), 'Automation deleted')) && reload()}
                >
                  <Icon name="trash" size={16} />
                </button>
              </>
            )}
          </li>
        ))}
      </ul>

      <Modal open={!!editing} onClose={() => setEditing(null)} title={editing?.id ? 'Edit automation' : 'New automation'} eyebrow="AUTOMATION" wide>
        {d && (
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              save();
            }}
          >
            <Field label="Name">
              <input value={d.name} onChange={(e) => set({ name: e.target.value })} maxLength={100} placeholder="e.g. Hand off to reviewer" />
            </Field>
            <fieldset className="rule-step">
              <legend>When</legend>
              <select value={d.triggerType} onChange={(e) => set({ triggerType: e.target.value })} aria-label="Trigger">
                {Object.entries(TRIGGER_LABEL).map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </select>
              {d.triggerType === 'task.status_changed' && (
                <div className="row-gap wrap">
                  <Field label="From">
                    <select value={d.fromStatus} onChange={(e) => set({ fromStatus: e.target.value })}>
                      <option value="">Any status</option>
                      {Object.entries(STATUS_LABEL).map(([id, l]) => (
                        <option key={id} value={id}>
                          {l}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="To">
                    <select value={d.toStatus} onChange={(e) => set({ toStatus: e.target.value })}>
                      <option value="">Any status</option>
                      {Object.entries(STATUS_LABEL).map(([id, l]) => (
                        <option key={id} value={id}>
                          {l}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
              )}
              <Field label="Only for priority">
                <select value={d.priorityFilter} onChange={(e) => set({ priorityFilter: e.target.value })}>
                  <option value="">Any priority</option>
                  {['low', 'medium', 'high', 'urgent'].map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </Field>
            </fieldset>
            <fieldset className="rule-step">
              <legend>Then</legend>
              <select value={d.actionType} onChange={(e) => set({ actionType: e.target.value })} aria-label="Action">
                {Object.entries(ACTION_LABEL).map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </select>
              {(d.actionType === 'assign' || d.actionType === 'notify') && (
                <div className="row-gap wrap">
                  <Field label={d.actionType === 'assign' ? 'Assign to' : 'Who'}>
                    <select value={d.target} onChange={(e) => set({ target: e.target.value })}>
                      {(d.actionType === 'assign' ? ['project_owner', 'user'] : ['owner', 'reviewer', 'project_owner', 'user']).map((t) => (
                        <option key={t} value={t}>
                          {TARGET_LABEL[t]}
                        </option>
                      ))}
                    </select>
                  </Field>
                  {(d.target === 'user' || (d.actionType === 'assign' && d.target !== 'project_owner')) && (
                    <Field label="Person">
                      <select value={d.userId} onChange={(e) => set({ userId: e.target.value })} required>
                        <option value="">Choose…</option>
                        {people.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                    </Field>
                  )}
                </div>
              )}
              {d.actionType === 'set_priority' && (
                <Field label="Priority">
                  <select value={d.priority} onChange={(e) => set({ priority: e.target.value })}>
                    {['low', 'medium', 'high', 'urgent'].map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              {d.actionType === 'post_message' && (
                <Field label="Channel" hint="Public channels, or private channels that belong to this project.">
                  <select value={d.channelId} onChange={(e) => set({ channelId: e.target.value })} required>
                    <option value="">Choose…</option>
                    {postable.map((c) => (
                      <option key={c.id} value={c.id}>
                        #{c.name}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              {(d.actionType === 'notify' || d.actionType === 'post_message') && (
                <Field label="Message" hint="Placeholders: {{task}}, {{project}}, {{status}}, {{due}}, {{link}}">
                  <textarea rows={2} value={d.text} onChange={(e) => set({ text: e.target.value })} maxLength={1000} />
                </Field>
              )}
              {d.actionType === 'add_checklist' && (
                <Field label="Checklist items" hint="One per line, up to 20.">
                  <textarea rows={4} value={d.items} onChange={(e) => set({ items: e.target.value })} required />
                </Field>
              )}
            </fieldset>
            <div className="row-gap">
              <span className="grow" />
              <button type="button" className="btn" onClick={() => setEditing(null)}>
                Cancel
              </button>
              <button className="btn primary">{editing?.id ? 'Save' : 'Create automation'}</button>
            </div>
          </form>
        )}
      </Modal>
      <Modal open={!!runsFor} onClose={() => setRunsFor(null)} title={runsFor ? `Run log · ${runsFor.name}` : ''}>
        {runsFor && <RunLog ruleId={runsFor.id} />}
      </Modal>
    </div>
  );
}

function RunLog({ ruleId }: { ruleId: string }) {
  const { data, error } = useApi<{ id: string; outcome: string; detail: string; created_at: string; task: { id: string; title: string } | null }[]>(`/automations/${ruleId}/runs`);
  if (error) return <ErrorState error={error} />;
  if (!data) return <Loading />;
  if (!data.length) return <p className="muted">This automation has not run yet.</p>;
  return (
    <ul className="run-log">
      {data.map((r) => (
        <li key={r.id}>
          <span className={`pill run-${r.outcome}`}>{r.outcome}</span>
          <span className="grow">
            {r.task ? <Link to={`/tasks/${r.task.id}`}>{r.task.title}</Link> : <span className="muted">Deleted task</span>}
            {r.detail && <small className="muted"> — {r.detail}</small>}
          </span>
          <small className="muted">{timeAgo(r.created_at)}</small>
        </li>
      ))}
    </ul>
  );
}

// ======================= Workspace insights =======================

interface Insights {
  generated_at: string;
  members: number;
  weekly: { week_of: string; active_people: number; messages: number; tasks_completed: number; decisions: number }[];
  measures: { id: string; label: string; value: number | null; unit: string; target?: number; lower_is_better?: boolean; detail?: string }[];
}

export function WorkspaceInsights() {
  const { data, error, reload } = useApi<Insights>('/admin/insights');
  if (error) return <ErrorState error={error} retry={reload} />;
  if (!data) return <Loading />;
  const good = (m: Insights['measures'][number]) => (m.value == null || m.target == null ? null : m.lower_is_better ? m.value <= m.target : m.value >= m.target);
  const series: { key: keyof Insights['weekly'][number]; label: string }[] = [
    { key: 'active_people', label: 'Active people' },
    { key: 'messages', label: 'Messages' },
    { key: 'tasks_completed', label: 'Tasks completed' },
    { key: 'decisions', label: 'Decisions recorded' },
  ];
  return (
    <div className="stack">
      <p className="muted">
        How well SoftEX is working for the team, measured against the product’s success targets. Aggregated counts only; no individual is ranked. Updated {timeAgo(data.generated_at)}.
      </p>
      <div className="measure-grid">
        {data.measures.map((m) => {
          const ok = good(m);
          return (
            <div key={m.id} className={`card measure ${ok === true ? 'good' : ok === false ? 'bad' : ''}`}>
              <small className="muted">{m.label}</small>
              <strong className="measure-value">
                {m.value == null ? '—' : m.value}
                {m.value != null && m.unit && <span>{m.unit === '%' ? '%' : ` ${m.unit}`}</span>}
              </strong>
              {m.target != null && (
                <small>
                  Target {m.lower_is_better ? '≤' : '≥'} {m.target}
                  {m.unit === '%' ? '%' : ''}
                </small>
              )}
              {m.detail && <small className="muted">{m.detail}</small>}
            </div>
          );
        })}
      </div>
      <div className="spark-grid">
        {series.map((s) => {
          const values = data.weekly.map((w) => Number(w[s.key]));
          const max = Math.max(1, ...values);
          return (
            <div key={s.key} className="card spark-card">
              <div className="row-gap">
                <strong className="grow">{s.label}</strong>
                <span className="muted small">last 8 weeks</span>
              </div>
              <div className="bars" role="img" aria-label={`${s.label}: ${values.join(', ')}`}>
                {data.weekly.map((w, i) => (
                  <span key={w.week_of} title={`Week of ${shortDate(w.week_of)}: ${values[i]}`}>
                    <i style={{ height: `${Math.max(4, (values[i] / max) * 100)}%` }} />
                  </span>
                ))}
              </div>
              <small className="muted">This week: {values[values.length - 1]}</small>
            </div>
          );
        })}
      </div>
    </div>
  );
}
