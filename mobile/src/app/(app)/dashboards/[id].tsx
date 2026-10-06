import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { api, type CustomField, type Feature, type Project } from '@/lib/api';
import { dueLabel, timeAgo } from '@/lib/format';
import { useApi, useRealtime } from '@/lib/hooks';
import { useShell } from '@/lib/shell';
import { swatch, useTheme } from '@/lib/theme';
import { FavoriteButton } from '@/ui/chat';
import { BarChart, DonutChart, LineChart, type SeriesItem } from '@/ui/charts';
import { Button, Card, Checkbox, confirm, Empty, ErrorState, Eyebrow, Field, H1, HealthPill, IconButton, Input, ListRow, Loading, Muted, Pill, ProgressBar, Row, Screen, Select, Sheet, StatusPill, T, useAction } from '@/ui/kit';
import { Markdown } from '@/ui/Markdown';
import { UpgradeNotice } from '@/ui/plan';

type WidgetType = 'number' | 'status' | 'priority' | 'owner' | 'label' | 'field' | 'trend' | 'time' | 'goals' | 'projects' | 'due' | 'note';
type Metric = 'open' | 'overdue' | 'blocked' | 'done_week' | 'due_week' | 'hours_week' | 'field_sum';

interface Widget {
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
  | { kind: 'list'; items: { id: string; title: string; link?: string; task?: boolean; progress?: number; status?: string; owner?: string | null; color?: string; detail?: string; due_date?: string; overdue?: boolean }[] }
  | { kind: 'note' }
  | { kind: 'locked'; feature: Feature }
  | { kind: 'empty'; reason?: string };

const WIDGET_LABEL: Record<WidgetType, string> = {
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

export default function DashboardView() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { c } = useTheme();
  const act = useAction();
  const { data: dash, error, reload, setData } = useApi<Dashboard>(`/dashboards/${id}`);
  const { data: values, reload: reloadData, refresh, refreshing } = useApi<{ computed_at: string; widgets: Record<string, WidgetData> }>(`/dashboards/${id}/data`);
  const [editing, setEditing] = useState(false);
  const [editWidget, setEditWidget] = useState<Widget | 'new' | null>(null);
  const [renaming, setRenaming] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useRealtime((e) => {
    if (e.type !== 'task.updated' && e.type !== 'reconnected') return;
    clearTimeout(timer.current);
    timer.current = setTimeout(reloadData, 1500);
  });
  useEffect(() => () => clearTimeout(timer.current), []);
  if (error && !dash) return <ErrorState error={error} retry={reload} />;
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

  // Half-width number widgets sit two to a row; everything else is full width on a phone.
  return (
    <>
      <Stack.Screen
        options={{
          title: 'Dashboard',
          headerRight: () => (
            <Row gap={0}>
              <FavoriteButton kind="dashboard" id={dash.id} />
              {dash.can_edit && <IconButton name={editing ? 'check' : 'edit'} label={editing ? 'Done editing' : 'Edit dashboard'} color={editing ? c.accent : undefined} onPress={() => setEditing((e) => !e)} />}
            </Row>
          ),
        }}
      />
      <Screen refreshing={refreshing} onRefresh={refresh}>
        {dash.visibility === 'private' && <Eyebrow>Private</Eyebrow>}
        <H1>{dash.name}</H1>
        {!!dash.description && <Muted size={14}>{dash.description}</Muted>}
        <Muted size={12}>Updated {values ? timeAgo(values.computed_at) : '…'} · numbers reflect the projects you can open</Muted>
        {editing && (
          <Card style={{ gap: 10 }}>
            <Row wrap>
              <Button small variant="primary" icon="plus" title="Add widget" onPress={() => setEditWidget('new')} />
              <Button small title="Rename or share" onPress={() => setRenaming(true)} />
              <Button
                small
                variant="danger"
                icon="trash"
                title="Delete"
                onPress={async () => {
                  if (!(await confirm('Delete this dashboard?', 'The work it shows is not affected.', 'Delete'))) return;
                  if (await act(() => api.del(`/dashboards/${dash.id}`), 'Dashboard deleted')) router.back();
                }}
              />
            </Row>
          </Card>
        )}
        {!dash.widgets.length && <Empty icon="chart" title="This dashboard is empty">{dash.can_edit ? 'Tap Edit, then Add widget.' : 'Its owner has not added any charts yet.'}</Empty>}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
          {dash.widgets.map((w, i) => (
            <Card key={w.id} style={{ width: w.type === 'number' && w.size === 'half' ? '47%' : '100%', flexGrow: 1, gap: 10 }}>
              <Row style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <T weight="display" size={15} style={{ flex: 1 }}>
                  {w.title || (w.type === 'number' ? METRIC_LABEL[w.metric ?? 'open'] : WIDGET_LABEL[w.type])}
                </T>
                {editing && (
                  <Row gap={0}>
                    <IconButton name="chevronLeft" size={14} label="Move earlier" onPress={() => i > 0 && move(i, -1)} />
                    <IconButton name="chevronRight" size={14} label="Move later" onPress={() => i < dash.widgets.length - 1 && move(i, 1)} />
                    <IconButton name="edit" size={14} label="Edit widget" onPress={() => setEditWidget(w)} />
                    <IconButton name="x" size={14} label="Remove widget" onPress={() => save(dash.widgets.filter((x) => x.id !== w.id))} />
                  </Row>
                )}
              </Row>
              <WidgetBody widget={w} data={values?.widgets[w.id]} />
            </Card>
          ))}
        </View>
      </Screen>
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
    </>
  );
}

function WidgetBody({ widget: w, data }: { widget: Widget; data: WidgetData | undefined }) {
  const { c } = useTheme();
  const { openTask } = useShell();
  if (w.type === 'note') return w.text ? <Markdown text={w.text} compact size={14} /> : <Muted>Empty note.</Muted>;
  if (!data) return <Loading inline />;
  switch (data.kind) {
    case 'number':
      return (
        <View>
          <T size={34} weight="displayHeavy" style={{ color: data.tone === 'bad' ? c.red : data.tone === 'warn' ? c.amberInk : data.tone === 'good' ? c.green : c.ink, lineHeight: 40 }}>
            {data.value.toLocaleString()}
          </T>
          <Muted size={12}>
            {data.unit}
            {data.note ? ` · ${data.note}` : ''}
          </Muted>
        </View>
      );
    case 'series': {
      const total = data.items.reduce((s, i) => s + i.value, 0);
      if (!total) return <Muted>Nothing to show yet.</Muted>;
      const donut = (w.chart ?? (w.type === 'status' || w.type === 'field' ? 'donut' : 'bar')) === 'donut';
      return donut ? <DonutChart items={data.items} label={data.unit ?? 'tasks'} /> : <BarChart items={data.items} unit={data.unit} />;
    }
    case 'trend':
      return <LineChart labels={data.labels} series={data.series} />;
    case 'list':
      if (!data.items.length) return <Muted>Nothing here.</Muted>;
      return (
        <View>
          {data.items.map((item) =>
            item.task ? (
              <ListRow
                key={item.id}
                title={item.title}
                subtitle={[item.owner, item.due_date ? dueLabel(item.due_date) : null].filter(Boolean).join(' · ')}
                right={item.overdue ? <Pill label="Overdue" tone="red" /> : item.status && item.status !== 'todo' ? <StatusPill status={item.status} /> : undefined}
                onPress={() => openTask(item.id)}
              />
            ) : (
              <ListRow
                key={item.id}
                left={item.color ? <View style={{ width: 10, height: 10, borderRadius: 3, backgroundColor: swatch(item.color) }} /> : undefined}
                title={item.title}
                subtitle={
                  <View style={{ gap: 4, marginTop: 2 }}>
                    {!!item.detail && <Muted size={12}>{item.detail}</Muted>}
                    {item.progress !== undefined && (
                      <Row>
                        <View style={{ flex: 1 }}>
                          <ProgressBar value={item.progress * 100} />
                        </View>
                        <T size={12} weight="bold">
                          {Math.round(item.progress * 100)}%
                        </T>
                      </Row>
                    )}
                  </View>
                }
                right={item.status ? item.status === 'done' ? <Pill label="Achieved" tone="green" /> : <HealthPill health={item.status} /> : undefined}
                onPress={item.link ? () => router.push(item.link as never) : undefined}
              />
            ),
          )}
        </View>
      );
    case 'locked':
      return <UpgradeNotice feature={data.feature} />;
    case 'empty':
      return <Muted>{data.reason ?? 'Nothing to show.'}</Muted>;
    default:
      return null;
  }
}

function WidgetEditor({ widget, onClose, onSave }: { widget: Widget | null; onClose: () => void; onSave: (w: Widget) => void }) {
  const { data: projects } = useApi<Project[]>('/projects');
  const [w, setW] = useState<Widget>(widget ?? { id: `w${Date.now().toString(36)}`, type: 'status', title: '', size: 'full', projectIds: [] });
  const [fields, setFields] = useState<CustomField[]>([]);
  const set = (patch: Partial<Widget>) => setW((x) => ({ ...x, ...patch }));
  const needsField = w.type === 'field' || (w.type === 'number' && w.metric === 'field_sum');
  useEffect(() => {
    if (!needsField || !w.projectIds.length) return setFields([]);
    let live = true;
    Promise.all(w.projectIds.map((p) => api.get<CustomField[]>(`/projects/${p}/fields`).catch(() => [] as CustomField[])))
      .then((lists) => live && setFields(lists.flat()))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [needsField, w.projectIds]);
  const fieldOptions = fields.filter((f) => (w.type === 'field' ? f.type === 'select' : f.type === 'number'));
  return (
    <Sheet
      open
      onClose={onClose}
      title={widget ? 'Edit widget' : 'Add widget'}
      full
      footer={
        <Button
          title={widget ? 'Save widget' : 'Add widget'}
          variant="primary"
          full
          disabled={needsField && !w.fieldId}
          onPress={() =>
            onSave({
              ...w,
              chart: CHARTABLE.includes(w.type) ? w.chart : undefined,
              metric: w.type === 'number' ? w.metric ?? 'open' : undefined,
              fieldId: needsField ? w.fieldId : undefined,
              weeks: w.type === 'trend' || w.type === 'time' ? w.weeks ?? (w.type === 'trend' ? 8 : 4) : undefined,
              text: w.type === 'note' ? w.text ?? '' : undefined,
            })
          }
        />
      }
    >
      <Field label="Show">
        <Select title="Show" value={w.type} onChange={(t) => set({ type: t, size: t === 'number' ? 'half' : 'full' })} options={(Object.keys(WIDGET_LABEL) as WidgetType[]).map((t) => ({ id: t, label: WIDGET_LABEL[t] }))} />
      </Field>
      {w.type === 'number' && (
        <Field label="Measure">
          <Select title="Measure" value={w.metric ?? 'open'} onChange={(m) => set({ metric: m })} options={(Object.keys(METRIC_LABEL) as Metric[]).map((m) => ({ id: m, label: METRIC_LABEL[m] }))} />
        </Field>
      )}
      <Field label="Title" hint="Leave empty to use the default.">
        <Input value={w.title} onChangeText={(v) => set({ title: v })} maxLength={80} />
      </Field>
      {w.type === 'note' && (
        <Field label="Text" hint="Markdown works.">
          <Input multiline value={w.text ?? ''} onChangeText={(v) => set({ text: v })} maxLength={4000} />
        </Field>
      )}
      {w.type !== 'note' && (
        <Field label="Projects" hint={needsField ? 'Pick the project that has the field.' : 'None selected means every project you can open.'}>
          <View style={{ gap: 10 }}>
            {(projects ?? [])
              .filter((p) => !p.archived_at)
              .map((p) => (
                <Checkbox key={p.id} checked={w.projectIds.includes(p.id)} onChange={(v) => set({ projectIds: v ? [...w.projectIds, p.id] : w.projectIds.filter((x) => x !== p.id) })} label={p.name} />
              ))}
          </View>
        </Field>
      )}
      {needsField && (
        <Field label="Field">
          <Select
            title="Field"
            value={w.fieldId ?? ''}
            placeholder={w.projectIds.length ? (fieldOptions.length ? 'Choose a field…' : 'No suitable fields in these projects') : 'Choose a project first'}
            onChange={(v) => set({ fieldId: v || undefined })}
            options={fieldOptions.map((f) => ({ id: f.id, label: f.name }))}
          />
        </Field>
      )}
      {CHARTABLE.includes(w.type) && (
        <Field label="Chart">
          <Select
            title="Chart"
            value={w.chart ?? (w.type === 'status' || w.type === 'field' ? 'donut' : 'bar')}
            onChange={(v) => set({ chart: v })}
            options={[
              { id: 'bar', label: 'Bars' },
              { id: 'donut', label: 'Donut' },
            ]}
          />
        </Field>
      )}
      {(w.type === 'trend' || w.type === 'time') && (
        <Field label="Weeks">
          <Select title="Weeks" value={String(w.weeks ?? (w.type === 'trend' ? 8 : 4))} onChange={(v) => set({ weeks: Number(v) })} options={[2, 4, 6, 8, 12, 26].map((n) => ({ id: String(n), label: `${n} weeks` }))} />
        </Field>
      )}
      <Field label="Width" hint="On a phone, half-width numbers sit two to a row.">
        <Select
          title="Width"
          value={w.size}
          onChange={(v) => set({ size: v })}
          options={[
            { id: 'half', label: 'Half' },
            { id: 'full', label: 'Full' },
          ]}
        />
      </Field>
    </Sheet>
  );
}

function DashboardSettings({ dash, onClose, onSaved }: { dash: Dashboard; onClose: () => void; onSaved: (d: Dashboard) => void }) {
  const act = useAction();
  const [name, setName] = useState(dash.name);
  const [description, setDescription] = useState(dash.description);
  const [visibility, setVisibility] = useState(dash.visibility);
  return (
    <Sheet
      open
      onClose={onClose}
      title="Dashboard settings"
      footer={
        <Button
          title="Save"
          variant="primary"
          full
          disabled={!name.trim()}
          onPress={async () => {
            const d = await act(() => api.patch<Dashboard>(`/dashboards/${dash.id}`, { name, description, visibility }), 'Saved');
            if (d) onSaved(d);
          }}
        />
      }
    >
      <Field label="Name">
        <Input value={name} onChangeText={setName} maxLength={100} />
      </Field>
      <Field label="Description">
        <Input multiline value={description} onChangeText={setDescription} maxLength={1000} />
      </Field>
      <Field label="Who can open it">
        <Select
          title="Who can open it"
          value={visibility}
          onChange={setVisibility}
          options={[
            { id: 'workspace', label: 'Everyone in the workspace', hint: 'Each sees their own data' },
            { id: 'private', label: 'Only me' },
          ]}
        />
      </Field>
    </Sheet>
  );
}
