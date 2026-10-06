import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { api, qs, type Channel, type Priority, type Task, type TaskStatus } from '../lib/api';
import { STATUS_LABEL, timeAgo } from '../lib/format';
import { useApi, useRealtime } from '../lib/hooks';
import { useSession } from '../lib/session';
import { useTheme } from '../lib/theme';
import { Avatar, Button, Card, confirm, Empty, ErrorState, Field, IconButton, Input, ListRow, Loading, Muted, Pill, Row, Select, Sheet, T, Toggle, useAction } from './kit';
import { DateField, PeopleField } from './pickers';

const DAY = 86_400_000;
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const parseDay = (s: string) => new Date(`${s}T00:00:00Z`);
const addDays = (s: string, n: number) => isoDay(new Date(parseDay(s).getTime() + n * DAY));
const daysBetween = (a: string, b: string) => Math.round((parseDay(b).getTime() - parseDay(a).getTime()) / DAY);
export const shortDate = (s: string) => parseDay(s).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });

export const STATUS_COLOR = (c: ReturnType<typeof useTheme>['c']): Record<string, string> => ({ todo: c.dotAway, in_progress: c.blue, blocked: c.red, review: c.amber, done: c.green });

// ======================= Project timeline =======================

interface Milestone {
  id: string;
  name: string;
  due_date: string | null;
  done_at: string | null;
}

/** A scrollable Gantt chart. Tap a bar to open the task; long-press it to change its dates. */
export function ProjectTimeline({ projectId, milestones, canEdit }: { projectId: string; milestones: Milestone[]; canEdit: boolean }) {
  const { c } = useTheme();
  const act = useAction();
  const [showDone, setShowDone] = useState(false);
  const [editing, setEditing] = useState<Task | null>(null);
  const [dates, setDates] = useState<{ start: string | null; due: string | null }>({ start: null, due: null });
  const { data: tasks, error, reload } = useApi<Task[]>(`/tasks${qs({ projectId })}`);
  useRealtime((e) => e.type === 'task.updated' && e.projectId === projectId && reload());
  const PX = 22;
  const ROW = 36;
  const colors = STATUS_COLOR(c);

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
    const all = [today, ...visible.flatMap((t) => [t.start_date ?? t.due_date!, t.due_date!]), ...milestones.flatMap((m) => (m.due_date ? [m.due_date] : []))];
    let from = addDays(all.reduce((a, b) => (a < b ? a : b)), -3);
    let to = addDays(all.reduce((a, b) => (a > b ? a : b)), 7);
    if (daysBetween(from, to) < 35) to = addDays(from, 35);
    if (daysBetween(from, to) > 240) from = addDays(to, -240);
    return { from, to, days: daysBetween(from, to) + 1, today };
  }, [visible, milestones]);
  const x = (d: string) => Math.max(0, Math.min(range.days, daysBetween(range.from, d))) * PX;

  if (error && !tasks) return <ErrorState error={error} retry={reload} />;
  if (!tasks) return <Loading inline />;
  const dated = milestones.filter((m) => m.due_date);

  return (
    <View style={{ gap: 10 }}>
      <Muted>{canEdit ? 'Tap a bar to open the task. Long-press it to change its dates.' : 'Tap a bar to open the task.'}</Muted>
      <Toggle label="Show done" value={showDone} onChange={setShowDone} />
      {!visible.length && !dated.length ? (
        <Empty icon="calendar" title="Nothing on the timeline yet">
          Give tasks a due date (and optionally a start date) to see them here.
        </Empty>
      ) : (
        <Card padded={false} style={{ overflow: 'hidden' }}>
          <ScrollView horizontal showsHorizontalScrollIndicator contentOffset={{ x: Math.max(0, x(range.today) - 60), y: 0 }}>
            <View style={{ width: range.days * PX, paddingBottom: 10 }}>
              <View style={{ height: 34, flexDirection: 'row', borderBottomWidth: 1, borderColor: c.line }}>
                {Array.from({ length: range.days }, (_, i) => {
                  const d = addDays(range.from, i);
                  const dow = parseDay(d).getUTCDay();
                  return (
                    <View key={d} style={{ width: PX, alignItems: 'center', justifyContent: 'flex-end', paddingBottom: 3, backgroundColor: dow === 0 || dow === 6 ? c.surface2 : 'transparent' }}>
                      {(i === 0 || d.endsWith('-01')) && (
                        <T size={10} weight="bold" tone="muted" style={{ position: 'absolute', top: 2, left: 2, width: 80 }}>
                          {parseDay(d).toLocaleDateString(undefined, { month: 'short', timeZone: 'UTC' })}
                        </T>
                      )}
                      <T size={10} tone="muted">
                        {d.slice(8)}
                      </T>
                    </View>
                  );
                })}
              </View>
              <View style={{ position: 'absolute', top: 34, bottom: 0, left: x(range.today) + PX / 2, width: 2, backgroundColor: c.accent, opacity: 0.6 }} />
              {dated.length > 0 && (
                <View style={{ height: ROW }}>
                  {dated.map((m) => (
                    <View key={m.id} style={{ position: 'absolute', left: x(m.due_date!) + PX / 2 - 6, top: 10, flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                      <View style={{ width: 12, height: 12, transform: [{ rotate: '45deg' }], backgroundColor: m.done_at ? c.green : c.amber }} />
                      <T size={11} weight="bold" tone="ink2" numberOfLines={1} style={{ maxWidth: 140 }}>
                        {m.name}
                      </T>
                    </View>
                  ))}
                </View>
              )}
              {visible.map((t) => {
                const start = t.start_date ?? t.due_date!;
                const s = start > t.due_date! ? t.due_date! : start;
                const width = (daysBetween(s, t.due_date!) + 1) * PX - 4;
                return (
                  <View key={t.id} style={{ height: ROW, justifyContent: 'center' }}>
                    <Pressable
                      onPress={() => router.push(`/tasks/${t.id}`)}
                      onLongPress={() => {
                        if (!canEdit) return;
                        setDates({ start: t.start_date, due: t.due_date });
                        setEditing(t);
                      }}
                      accessibilityRole="button"
                      accessibilityLabel={`${t.title}, ${shortDate(s)} to ${shortDate(t.due_date!)}, ${STATUS_LABEL[t.status]}`}
                      style={{
                        position: 'absolute',
                        left: x(s) + 2,
                        width: Math.max(width, 18),
                        height: 26,
                        borderRadius: 7,
                        backgroundColor: `${colors[t.status]}33`,
                        borderWidth: 1,
                        borderColor: t.overdue ? c.red : colors[t.status],
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 4,
                        paddingHorizontal: 4,
                      }}
                    >
                      {t.owner && <Avatar user={t.owner} size="xs" />}
                    </Pressable>
                    <T size={12} weight="semibold" numberOfLines={1} style={{ position: 'absolute', left: x(s) + Math.max(width, 18) + 8, width: 200 }}>
                      {t.title}
                    </T>
                  </View>
                );
              })}
            </View>
          </ScrollView>
        </Card>
      )}
      {undated.length > 0 && (
        <Muted size={12}>
          {undated.length} open task{undated.length === 1 ? ' has' : 's have'} no due date and {undated.length === 1 ? 'is' : 'are'} not shown.
        </Muted>
      )}
      <Sheet
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing?.title ?? ''}
        eyebrow="Reschedule"
        footer={
          <Button
            title="Save dates"
            variant="primary"
            full
            disabled={!dates.due}
            onPress={async () => {
              const ok = await act(() => api.patch(`/tasks/${editing!.id}`, { startDate: dates.start && dates.due && dates.start > dates.due ? null : dates.start, dueDate: dates.due }), 'Rescheduled');
              if (ok) {
                setEditing(null);
                reload();
              }
            }}
          />
        }
      >
        <Field label="Start">
          <DateField value={dates.start} onChange={(v) => setDates({ ...dates, start: v })} label="Start date" />
        </Field>
        <Field label="Due">
          <DateField value={dates.due} onChange={(v) => setDates({ ...dates, due: v })} label="Due date" clearable={false} />
        </Field>
      </Sheet>
    </View>
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
const EMPTY: RuleDraft = { name: '', triggerType: 'task.created', toStatus: '', fromStatus: '', priorityFilter: '', actionType: 'notify', target: 'owner', userId: '', priority: 'high', channelId: '', text: '', items: '' };

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
  { name: 'Overdue is urgent', description: 'Raise priority to urgent when a task slips past its due date.', rule: { name: 'Overdue tasks are urgent', triggerType: 'task.overdue', actionType: 'set_priority', priority: 'urgent' } },
  {
    name: 'Definition of done',
    description: 'Add a standard checklist to every new task.',
    rule: { name: 'Definition of done', triggerType: 'task.created', actionType: 'add_checklist', items: 'Acceptance criteria agreed\nReviewed by a teammate\nDocs updated' },
  },
];

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
  const a = r.action_config;
  const then =
    r.action_type === 'assign'
      ? `assign it to ${who(a.target, a.user_id)}`
      : r.action_type === 'set_priority'
        ? `set priority to ${a.priority}`
        : r.action_type === 'notify'
          ? `notify ${who(a.target, a.user_id)}`
          : r.action_type === 'post_message'
            ? `post in #${channels.find((ch) => ch.id === a.channel_id)?.name ?? 'a channel'}`
            : `add ${a.items?.length ?? 0} checklist item${a.items?.length === 1 ? '' : 's'}`;
  return `When ${when}${r.trigger_config.priority ? ` (priority ${r.trigger_config.priority})` : ''}, ${then}.`;
}

const STATUS_OPTIONS = [{ id: '', label: 'Any status' }, ...Object.entries(STATUS_LABEL).map(([id, label]) => ({ id, label }))];
const PRIORITY_OPTIONS = ['low', 'medium', 'high', 'urgent'].map((p) => ({ id: p, label: p[0].toUpperCase() + p.slice(1) }));

export function ProjectAutomations({ projectId }: { projectId: string }) {
  const { c } = useTheme();
  const act = useAction();
  const { people } = useSession();
  const { data, error, reload } = useApi<{ can_manage: boolean; automations: Rule[] }>(`/projects/${projectId}/automations`);
  const { data: channels } = useApi<Channel[]>('/channels');
  const [editing, setEditing] = useState<{ id?: string; draft: RuleDraft } | null>(null);
  const [runsFor, setRunsFor] = useState<Rule | null>(null);
  if (error && !data) return <ErrorState error={error} retry={reload} />;
  if (!data) return <Loading inline />;
  const postable = (channels ?? []).filter((ch) => ch.kind !== 'dm' && ch.joined && (ch.kind === 'public' || ch.project_id === projectId));
  const set = (patch: Partial<RuleDraft>) => setEditing((e) => (e ? { ...e, draft: { ...e.draft, ...patch } } : e));
  const d = editing?.draft;

  const save = async () => {
    if (!editing) return;
    const dr = editing.draft;
    const triggerConfig: Record<string, string> = {};
    if (dr.triggerType === 'task.status_changed') {
      if (dr.toStatus) triggerConfig.to_status = dr.toStatus;
      if (dr.fromStatus) triggerConfig.from_status = dr.fromStatus;
    }
    if (dr.priorityFilter) triggerConfig.priority = dr.priorityFilter;
    const actionConfig: Record<string, unknown> = {};
    if (dr.actionType === 'assign' || dr.actionType === 'notify') {
      actionConfig.target = dr.actionType === 'assign' && dr.target !== 'project_owner' ? 'user' : dr.target;
      if (actionConfig.target === 'user') actionConfig.user_id = dr.userId;
      if (dr.actionType === 'notify' && dr.text) actionConfig.text = dr.text;
    }
    if (dr.actionType === 'set_priority') actionConfig.priority = dr.priority;
    if (dr.actionType === 'post_message') Object.assign(actionConfig, { channel_id: dr.channelId, text: dr.text || undefined });
    if (dr.actionType === 'add_checklist')
      actionConfig.items = dr.items
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
    const body = { name: dr.name || TRIGGER_LABEL[dr.triggerType], triggerType: dr.triggerType, triggerConfig, actionType: dr.actionType, actionConfig };
    const ok = await act(() => (editing.id ? api.patch(`/automations/${editing.id}`, body) : api.post(`/projects/${projectId}/automations`, body)), editing.id ? 'Automation updated' : 'Automation created');
    if (ok) {
      setEditing(null);
      reload();
    }
  };

  return (
    <View style={{ gap: 12 }}>
      <Muted>Automations run “when this happens, do that” for tasks in this project. They act with their creator’s access, never trigger each other, and every run is logged.</Muted>
      {data.can_manage && <Button variant="primary" icon="plus" title="New automation" onPress={() => setEditing({ draft: { ...EMPTY } })} />}
      {!data.automations.length && (
        <>
          <Empty icon="refresh" title="No automations yet">
            {data.can_manage ? 'Start from a template or build your own.' : 'Project managers can add automations.'}
          </Empty>
          {data.can_manage &&
            TEMPLATES.map((t) => (
              <Card key={t.name} onPress={() => setEditing({ draft: { ...EMPTY, ...t.rule } })}>
                <T weight="bold">{t.name}</T>
                <Muted>{t.description}</Muted>
              </Card>
            ))}
        </>
      )}
      {data.automations.map((r) => (
        <Card key={r.id} style={{ gap: 6, opacity: r.enabled ? 1 : 0.6 }}>
          <Row style={{ justifyContent: 'space-between' }}>
            <T weight="bold" style={{ flex: 1 }}>
              {r.name}
            </T>
            {data.can_manage && (
              <Row gap={0}>
                <IconButton name="edit" label={`Edit ${r.name}`} onPress={() => setEditing({ id: r.id, draft: toDraft(r) })} />
                <IconButton
                  name="trash"
                  label={`Delete ${r.name}`}
                  color={c.red}
                  onPress={async () => (await confirm(`Delete “${r.name}”?`, undefined, 'Delete')) && (await act(() => api.del(`/automations/${r.id}`), 'Automation deleted')) && reload()}
                />
              </Row>
            )}
          </Row>
          <T size={14}>{describe(r, people, channels ?? [])}</T>
          <Muted size={12}>
            Ran {r.run_count} time{r.run_count === 1 ? '' : 's'}
            {r.last_run_at && `, last ${timeAgo(r.last_run_at)}`} · by {r.created_by?.name ?? 'a former member'}
          </Muted>
          <Row style={{ justifyContent: 'space-between' }}>
            <Button small title="Run log" onPress={() => setRunsFor(r)} />
            {data.can_manage && (
              <View style={{ width: 160 }}>
                <Toggle label={r.enabled ? 'On' : 'Off'} value={r.enabled} onChange={async (v) => (await act(() => api.patch(`/automations/${r.id}`, { enabled: v }))) && reload()} />
              </View>
            )}
          </Row>
        </Card>
      ))}

      <Sheet open={!!editing} onClose={() => setEditing(null)} title={editing?.id ? 'Edit automation' : 'New automation'} eyebrow="Automation" full footer={<Button title={editing?.id ? 'Save' : 'Create automation'} variant="primary" full onPress={save} />}>
        {d && (
          <>
            <Field label="Name">
              <Input value={d.name} onChangeText={(v) => set({ name: v })} maxLength={100} placeholder="e.g. Hand off to reviewer" />
            </Field>
            <T weight="display" size={16}>
              When
            </T>
            <Select title="Trigger" value={d.triggerType} onChange={(v) => set({ triggerType: v })} options={Object.entries(TRIGGER_LABEL).map(([id, label]) => ({ id, label }))} />
            {d.triggerType === 'task.status_changed' && (
              <Row>
                <Field label="From" style={{ flex: 1 }}>
                  <Select title="From" value={d.fromStatus} onChange={(v) => set({ fromStatus: v })} options={STATUS_OPTIONS} />
                </Field>
                <Field label="To" style={{ flex: 1 }}>
                  <Select title="To" value={d.toStatus} onChange={(v) => set({ toStatus: v })} options={STATUS_OPTIONS} />
                </Field>
              </Row>
            )}
            <Field label="Only for priority">
              <Select title="Priority" value={d.priorityFilter} onChange={(v) => set({ priorityFilter: v })} options={[{ id: '', label: 'Any priority' }, ...PRIORITY_OPTIONS]} />
            </Field>
            <T weight="display" size={16}>
              Then
            </T>
            <Select title="Action" value={d.actionType} onChange={(v) => set({ actionType: v })} options={Object.entries(ACTION_LABEL).map(([id, label]) => ({ id, label }))} />
            {(d.actionType === 'assign' || d.actionType === 'notify') && (
              <Field label={d.actionType === 'assign' ? 'Assign to' : 'Who'}>
                <Select title="Who" value={d.target} onChange={(v) => set({ target: v })} options={(d.actionType === 'assign' ? ['project_owner', 'user'] : ['owner', 'reviewer', 'project_owner', 'user']).map((t) => ({ id: t, label: TARGET_LABEL[t] }))} />
              </Field>
            )}
            {(d.actionType === 'assign' || d.actionType === 'notify') && (d.target === 'user' || (d.actionType === 'assign' && d.target !== 'project_owner')) && (
              <Field label="Person">
                <PeopleField multiple={false} title="Person" placeholder="Choose…" value={d.userId ? [d.userId] : []} onChange={(ids) => set({ userId: ids[0] ?? '' })} />
              </Field>
            )}
            {d.actionType === 'set_priority' && (
              <Field label="Priority">
                <Select title="Priority" value={d.priority} onChange={(v) => set({ priority: v })} options={PRIORITY_OPTIONS} />
              </Field>
            )}
            {d.actionType === 'post_message' && (
              <Field label="Channel" hint="Public channels, or private channels that belong to this project.">
                <Select title="Channel" value={d.channelId} placeholder="Choose…" onChange={(v) => set({ channelId: v })} options={postable.map((ch) => ({ id: ch.id, label: `#${ch.name}` }))} />
              </Field>
            )}
            {(d.actionType === 'notify' || d.actionType === 'post_message') && (
              <Field label="Message" hint="Placeholders: {{task}}, {{project}}, {{status}}, {{due}}, {{link}}">
                <Input multiline value={d.text} onChangeText={(v) => set({ text: v })} maxLength={1000} />
              </Field>
            )}
            {d.actionType === 'add_checklist' && (
              <Field label="Checklist items" hint="One per line, up to 20.">
                <Input multiline value={d.items} onChangeText={(v) => set({ items: v })} />
              </Field>
            )}
          </>
        )}
      </Sheet>
      <Sheet open={!!runsFor} onClose={() => setRunsFor(null)} title={runsFor ? `Run log · ${runsFor.name}` : ''}>
        {runsFor && <RunLog ruleId={runsFor.id} />}
      </Sheet>
    </View>
  );
}

function RunLog({ ruleId }: { ruleId: string }) {
  const { data, error } = useApi<{ id: string; outcome: string; detail: string; created_at: string; task: { id: string; title: string } | null }[]>(`/automations/${ruleId}/runs`);
  if (error) return <Muted>{error.message}</Muted>;
  if (!data) return <Loading inline />;
  if (!data.length) return <Muted>This automation has not run yet.</Muted>;
  return (
    <View>
      {data.map((r) => (
        <ListRow
          key={r.id}
          left={<Pill label={r.outcome} tone={r.outcome === 'done' ? 'green' : r.outcome === 'skipped' ? 'neutral' : 'red'} />}
          title={r.task?.title ?? 'Deleted task'}
          subtitle={`${r.detail ? `${r.detail} · ` : ''}${timeAgo(r.created_at)}`}
          onPress={r.task ? () => router.push(`/tasks/${r.task!.id}`) : undefined}
        />
      ))}
    </View>
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
  const { c } = useTheme();
  const { data, error, reload } = useApi<Insights>('/admin/insights');
  if (error && !data) return <ErrorState error={error} retry={reload} />;
  if (!data) return <Loading inline />;
  const good = (m: Insights['measures'][number]) => (m.value == null || m.target == null ? null : m.lower_is_better ? m.value <= m.target : m.value >= m.target);
  const series: { key: keyof Insights['weekly'][number]; label: string }[] = [
    { key: 'active_people', label: 'Active people' },
    { key: 'messages', label: 'Messages' },
    { key: 'tasks_completed', label: 'Tasks completed' },
    { key: 'decisions', label: 'Decisions recorded' },
  ];
  return (
    <View style={{ gap: 12 }}>
      <Muted>How well Küü is working for the team, measured against the product’s success targets. Aggregated counts only; no individual is ranked. Updated {timeAgo(data.generated_at)}.</Muted>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        {data.measures.map((m) => {
          const ok = good(m);
          return (
            <Card key={m.id} style={{ width: '47%', flexGrow: 1, gap: 4, borderColor: ok === true ? c.greenLine : ok === false ? c.redLine : c.line }}>
              <Muted size={12}>{m.label}</Muted>
              <T size={24} weight="displayHeavy" style={{ color: ok === true ? c.green : ok === false ? c.red : c.ink }}>
                {m.value == null ? '—' : m.value}
                {m.value != null && m.unit ? (m.unit === '%' ? '%' : ` ${m.unit}`) : ''}
              </T>
              {m.target != null && (
                <T size={12} tone="ink2">
                  Target {m.lower_is_better ? '≤' : '≥'} {m.target}
                  {m.unit === '%' ? '%' : ''}
                </T>
              )}
              {!!m.detail && <Muted size={11}>{m.detail}</Muted>}
            </Card>
          );
        })}
      </View>
      {series.map((s) => {
        const values = data.weekly.map((w) => Number(w[s.key]));
        const max = Math.max(1, ...values);
        return (
          <Card key={s.key} style={{ gap: 8 }}>
            <Row style={{ justifyContent: 'space-between' }}>
              <T weight="bold">{s.label}</T>
              <Muted size={12}>last 8 weeks</Muted>
            </Row>
            <View style={{ flexDirection: 'row', alignItems: 'flex-end', height: 60, gap: 4 }} accessibilityLabel={`${s.label}: ${values.join(', ')}`}>
              {values.map((v, i) => (
                <View key={i} style={{ flex: 1, height: `${Math.max(4, (v / max) * 100)}%`, borderRadius: 3, backgroundColor: c.accent }} />
              ))}
            </View>
            <Muted size={12}>This week: {values[values.length - 1]}</Muted>
          </Card>
        );
      })}
    </View>
  );
}

