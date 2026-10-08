import { File } from 'expo-file-system';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Platform, Pressable, ScrollView, View } from 'react-native';
import { api, formWith, qs, type Decision, type Label, type Project, type Task, type TaskStatus } from '@/lib/api';
import { pickDocuments, pickMedia } from '@/lib/files';
import { bytes, dateLabel, dateTime, dueLabel, duration, HEALTH_LABEL, STATUS_LABEL, timeAgo } from '@/lib/format';
import { useApi, useRealtime, useReloadOnFocus } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { useShell } from '@/lib/shell';
import { storage } from '@/lib/storage';
import { swatch, useTheme } from '@/lib/theme';
import { ProjectBoards } from '@/ui/boards';
import { FavoriteButton, useAiEnabled } from '@/ui/chat';
import { CheckinSheet } from '@/ui/checkin';
import { ColourPicker, NewMeetingForm, NewTaskForm } from '@/ui/create';
import { ProjectForms } from '@/ui/forms';
import { Icon } from '@/ui/Icon';
import {
  ActionSheet,
  Avatar,
  AvatarStack,
  Button,
  Card,
  Checkbox,
  confirm,
  Empty,
  ErrorState,
  Eyebrow,
  Field,
  H1,
  HealthPill,
  IconButton,
  Input,
  LinkText,
  ListRow,
  Loading,
  Muted,
  Pill,
  ProgressBar,
  Row,
  Screen,
  Section,
  Segmented,
  Select,
  Sheet,
  T,
  Tabs,
  Toggle,
  useAction,
} from '@/ui/kit';
import { Markdown } from '@/ui/Markdown';
import { DateField, PeopleField } from '@/ui/pickers';
import { UpgradeNotice, usePlan } from '@/ui/plan';
import { ProjectAutomations, ProjectTimeline } from '@/ui/planning';
import { STATUSES, TaskBoard, TaskCalendar, TaskTable } from '@/ui/projectViews';
import { FieldsManager, TaskList, useProjectFields } from '@/ui/work';

interface ProjectFull extends Project {
  milestones: { id: string; name: string; due_date: string | null; done_at: string | null; task_count: number; done_count: number }[];
  channels: { id: string; name: string; kind: string }[];
  latest_update: { id: string; health: string; body: string; user_name: string; user_color: string; created_at: string } | null;
  can_contribute: boolean;
  can_manage: boolean;
  ai_excluded: boolean;
}

type Tab = 'overview' | 'tasks' | 'timeline' | 'automations' | 'forms' | 'boards' | 'time' | 'decisions' | 'risks' | 'resources' | 'checkins' | 'activity';

export default function ProjectDetail() {
  const { id, tab: initialTab } = useLocalSearchParams<{ id: string; tab?: Tab }>();
  const { c } = useTheme();
  const { has } = usePlan();
  const [tab, setTab] = useState<Tab>(initialTab ?? 'overview');
  const { data: project, error, reload, refresh, refreshing } = useApi<ProjectFull>(`/projects/${id}`);
  const [settings, setSettings] = useState(false);
  const [importing, setImporting] = useState(false);
  const [fieldsOpen, setFieldsOpen] = useState(false);
  const [menu, setMenu] = useState(false);
  useRealtime((e) => e.type === 'task.updated' && e.projectId === id && reload());
  useReloadOnFocus(reload);

  if (error && !project) return <ErrorState error={error} retry={reload} />;
  if (!project) return <Loading />;

  return (
    <>
      <Stack.Screen
        options={{
          title: project.name,
          headerRight: () => (
            <Row gap={0}>
              <FavoriteButton kind="project" id={project.id} />
              {(project.can_contribute || project.can_manage) && <IconButton name="more" label="Project options" onPress={() => setMenu(true)} />}
            </Row>
          ),
        }}
      />
      <Screen refreshing={refreshing} onRefresh={refresh}>
        <Row gap={12} style={{ alignItems: 'flex-start' }}>
          <View style={{ width: 48, height: 48, borderRadius: 14, backgroundColor: swatch(project.color), alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="folder" size={22} color="#fff" />
          </View>
          <View style={{ flex: 1, gap: 4 }}>
            <Eyebrow>
              {project.team?.name ?? 'Project'}
              {project.visibility === 'private' ? ' · Private' : ''}
              {project.archived_at ? ' · Archived' : ''}
            </Eyebrow>
            <H1 style={{ fontSize: 23, lineHeight: 28 }}>{project.name}</H1>
          </View>
        </Row>
        <Row wrap gap={10}>
          <HealthPill health={project.health} />
          <Muted size={13}>
            Owner: <T size={13} weight="bold">{project.owner?.name}</T>
          </Muted>
          {project.due_date && <Muted size={13}>Target: {dateLabel(project.due_date)}</Muted>}
          <AvatarStack users={project.members} max={5} total={project.member_count} />
        </Row>
        {project.channels.length > 0 && (
          <Row wrap gap={6}>
            {project.channels.map((ch) => (
              <Pressable key={ch.id} onPress={() => router.push(`/channels/${ch.id}`)} accessibilityRole="link">
                <Pill label={ch.name} icon={ch.kind === 'private' ? 'lock' : 'hash'} tone="accent" />
              </Pressable>
            ))}
          </Row>
        )}
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { id: 'overview', label: 'Overview' },
            { id: 'tasks', label: 'Tasks', count: project.stats.total - project.stats.done },
            { id: 'timeline', label: 'Timeline' },
            { id: 'automations', label: 'Automations' },
            { id: 'forms', label: 'Forms' },
            { id: 'boards', label: 'Whiteboards' },
            { id: 'time', label: 'Time' },
            { id: 'decisions', label: 'Decisions' },
            { id: 'risks', label: 'Risks' },
            { id: 'resources', label: 'Resources' },
            { id: 'checkins', label: 'Check-ins' },
            { id: 'activity', label: 'Activity' },
          ]}
        />
        {tab === 'overview' && <Overview project={project} reload={reload} />}
        {tab === 'tasks' && <ProjectTasks project={project} />}
        {tab === 'timeline' && (has('planning') ? <ProjectTimeline projectId={project.id} milestones={project.milestones} canEdit={project.can_contribute} /> : <UpgradeNotice feature="planning" />)}
        {tab === 'automations' && (has('automations') ? <ProjectAutomations projectId={project.id} /> : <UpgradeNotice feature="automations" />)}
        {tab === 'forms' && (has('goals') ? <ProjectForms projectId={project.id} canManage={project.can_manage} /> : <UpgradeNotice feature="goals" />)}
        {tab === 'boards' && <ProjectBoards projectId={project.id} />}
        {tab === 'time' && <ProjectTime projectId={project.id} />}
        {tab === 'decisions' && <ProjectDecisions project={project} />}
        {tab === 'risks' && <Risks project={project} />}
        {tab === 'resources' && <Resources project={project} />}
        {tab === 'checkins' && <Checkins project={project} />}
        {tab === 'activity' && <ProjectActivity projectId={project.id} />}
      </Screen>
      <ActionSheet
        open={menu}
        onClose={() => setMenu(false)}
        title={project.name}
        actions={[
          { label: 'Import tasks from CSV', icon: 'upload', onPress: () => setImporting(true), hidden: !project.can_contribute },
          { label: 'Custom fields', icon: 'list', onPress: () => setFieldsOpen(true), hidden: !project.can_manage },
          { label: 'Project settings', icon: 'settings', onPress: () => setSettings(true), hidden: !project.can_manage },
        ]}
      />
      {project.can_contribute && <ImportTasks open={importing} onClose={() => setImporting(false)} projectId={project.id} onDone={reload} />}
      {project.can_manage && <FieldsManager projectId={project.id} open={fieldsOpen} onClose={() => setFieldsOpen(false)} />}
      {project.can_manage && settings && <ProjectSettings onClose={() => setSettings(false)} project={project} onSaved={reload} />}
    </>
  );
}

// ---------- Overview ----------

function Stat({ value, label, tone }: { value: number | string; label: string; tone?: 'red' | 'amber' }) {
  const { c } = useTheme();
  return (
    <View style={{ flex: 1, alignItems: 'center', gap: 2 }}>
      <T size={22} weight="displayHeavy" style={{ color: tone === 'red' ? c.red : tone === 'amber' ? c.amberInk : c.ink }}>
        {value}
      </T>
      <Muted size={11}>{label}</Muted>
    </View>
  );
}

type Update = { id: string; health: string; body: string; user_name: string; user_color: string; created_at: string };

function Overview({ project, reload }: { project: ProjectFull; reload: () => void }) {
  const { c } = useTheme();
  const act = useAction();
  const aiEnabled = useAiEnabled();
  const [updating, setUpdating] = useState(false);
  const [fromDraft, setFromDraft] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [milestone, setMilestone] = useState<{ name: string; dueDate: string | null }>({ name: '', dueDate: null });
  const { data: updates, reload: reloadUpdates } = useApi<Update[]>(`/projects/${project.id}/updates`);
  const [update, setUpdate] = useState({ health: project.health as string, body: '' });

  const draftSummary = async () => {
    const s = await act(() => api.get<{ draft: string; suggested_health: string }>(`/projects/${project.id}/summary`));
    if (s) {
      setFromDraft(true);
      setUpdate({ health: s.suggested_health, body: s.draft });
      setUpdating(true);
    }
  };
  const aiBrief = async () => {
    setAiBusy(true);
    const res = await act(() => api.post<{ brief: string }>(`/ai/projects/${project.id}/brief`));
    setAiBusy(false);
    if (res) {
      setFromDraft(true);
      setUpdate({ health: project.health, body: res.brief });
      setUpdating(true);
    }
  };

  return (
    <>
      <Card style={{ gap: 12 }}>
        <Row>
          <Stat value={`${project.stats.progress}%`} label="Complete" />
          <Stat value={project.stats.total - project.stats.done} label="Open tasks" />
          <Stat value={project.stats.overdue} label="Overdue" tone={project.stats.overdue ? 'red' : undefined} />
          <Stat value={project.stats.blocked} label="Blocked" tone={project.stats.blocked ? 'amber' : undefined} />
        </Row>
        <ProgressBar value={project.stats.progress} color={swatch(project.color)} height={8} />
        {project.description ? <Markdown text={project.description} /> : <Muted>No description yet.</Muted>}
      </Card>

      <Section title="Status updates">
        <Muted style={{ marginTop: -6, marginBottom: 8 }}>How the project is going, in the team’s words</Muted>
        {project.can_contribute && (
          <Row wrap style={{ marginBottom: 8 }}>
            <Button small icon="list" title="Draft weekly summary" onPress={draftSummary} />
            {aiEnabled && !project.ai_excluded && <Button small icon="spark" title={aiBusy ? 'Drafting…' : 'AI brief'} disabled={aiBusy} onPress={aiBrief} />}
            <Button
              small
              variant="primary"
              title="Post update"
              onPress={() => {
                setFromDraft(false);
                setUpdating(true);
              }}
            />
          </Row>
        )}
        {(updates ?? []).slice(0, 5).map((u) => (
          <View key={u.id} style={{ gap: 6, paddingVertical: 10, borderTopWidth: 1, borderColor: c.line2 }}>
            <Row gap={8}>
              <Avatar user={{ name: u.user_name, color: u.user_color }} size="sm" />
              <T size={14} weight="bold">
                {u.user_name}
              </T>
              <HealthPill health={u.health} />
              <Muted size={12}>{timeAgo(u.created_at)}</Muted>
            </Row>
            <Markdown text={u.body} size={14} />
          </View>
        ))}
        {updates && !updates.length && <Muted>No status updates yet.</Muted>}
      </Section>

      <Section title="Milestones">
        {project.milestones.map((m) => (
          <Row key={m.id} gap={10} style={{ paddingVertical: 8 }}>
            <Checkbox
              checked={!!m.done_at}
              disabled={!project.can_contribute}
              onChange={async (v) => {
                await act(() => api.patch(`/milestones/${m.id}`, { done: v }));
                reload();
              }}
            />
            <View style={{ flex: 1 }}>
              <T weight="semibold" style={m.done_at ? { textDecorationLine: 'line-through', color: c.muted } : undefined}>
                {m.name}
              </T>
              <Muted size={12}>
                {m.due_date ? dueLabel(m.due_date) : 'No date'} · {m.done_count}/{m.task_count} tasks
              </Muted>
            </View>
            {project.can_contribute && (
              <IconButton
                name="x"
                size={14}
                label={`Delete ${m.name}`}
                onPress={async () => {
                  if (!(await confirm(`Delete milestone ${m.name}?`, undefined, 'Delete'))) return;
                  await act(() => api.del(`/milestones/${m.id}`));
                  reload();
                }}
              />
            )}
          </Row>
        ))}
        {!project.milestones.length && <Muted>No milestones.</Muted>}
        {project.can_contribute && (
          <View style={{ gap: 8, marginTop: 8 }}>
            <Input value={milestone.name} onChangeText={(v) => setMilestone({ ...milestone, name: v })} placeholder="Add milestone" accessibilityLabel="Milestone name" />
            {!!milestone.name.trim() && (
              <Row>
                <View style={{ flex: 1 }}>
                  <DateField value={milestone.dueDate} onChange={(v) => setMilestone({ ...milestone, dueDate: v })} label="Milestone date" />
                </View>
                <Button
                  variant="primary"
                  title="Add"
                  onPress={async () => {
                    await act(() => api.post(`/projects/${project.id}/milestones`, { name: milestone.name, dueDate: milestone.dueDate }));
                    setMilestone({ name: '', dueDate: null });
                    reload();
                  }}
                />
              </Row>
            )}
          </View>
        )}
      </Section>

      <Members project={project} reload={reload} />

      <Sheet
        open={updating}
        onClose={() => setUpdating(false)}
        title="Post a status update"
        full
        footer={
          <Button
            title="Share with project"
            variant="primary"
            full
            disabled={!update.body.trim()}
            onPress={async () => {
              const ok = await act(() => api.post(`/projects/${project.id}/updates`, update), 'Status update posted');
              if (ok) {
                setUpdating(false);
                setUpdate({ health: update.health, body: '' });
                reload();
                reloadUpdates();
              }
            }}
          />
        }
      >
        {fromDraft && <Muted>This draft was built from project records. Review and edit it before sharing.</Muted>}
        <Segmented value={update.health} onChange={(h) => setUpdate({ ...update, health: h })} options={(['on_track', 'at_risk', 'off_track'] as const).map((h) => ({ id: h, label: HEALTH_LABEL[h] }))} />
        <Input multiline value={update.body} onChangeText={(v) => setUpdate({ ...update, body: v })} placeholder="What moved, what is at risk, what is next?" style={{ minHeight: 200 }} />
      </Sheet>
    </>
  );
}

function Members({ project, reload }: { project: ProjectFull; reload: () => void }) {
  const { c } = useTheme();
  const { me } = useSession();
  const act = useAction();
  const [ids, setIds] = useState<string[]>([]);
  return (
    <Section title="Members" count={project.member_count}>
      {project.members.map((m) => (
        <ListRow
          key={m.id}
          left={<Avatar user={m} size="sm" presence />}
          title={m.name}
          right={
            <Row>
              {m.id === project.owner?.id && <Pill label="Owner" />}
              {(project.can_manage || m.id === me!.user.id) && m.id !== project.owner?.id && (
                <IconButton
                  name="x"
                  size={14}
                  color={c.muted}
                  label={`Remove ${m.name}`}
                  onPress={async () => {
                    await act(() => api.del(`/projects/${project.id}/members/${m.id}`), 'Removed from project');
                    reload();
                  }}
                />
              )}
            </Row>
          }
          onPress={() => router.push(`/people/${m.id}`)}
        />
      ))}
      {project.can_contribute && me!.role !== 'guest' && (
        <View style={{ gap: 8, marginTop: 8 }}>
          <PeopleField value={ids} onChange={setIds} exclude={project.members.map((m) => m.id)} placeholder="Add members" title="Add members" />
          {ids.length > 0 && (
            <Button
              variant="primary"
              small
              title={`Add ${ids.length}`}
              onPress={async () => {
                await act(() => api.post(`/projects/${project.id}/members`, { userIds: ids }), 'Members added');
                setIds([]);
                reload();
              }}
            />
          )}
        </View>
      )}
    </Section>
  );
}

// ---------- Tasks ----------

type View_ = 'list' | 'board' | 'table' | 'calendar';
const VIEWS: View_[] = ['list', 'board', 'table', 'calendar'];

function ProjectTasks({ project }: { project: ProjectFull }) {
  const { openTask } = useShell();
  const act = useAction();
  const [view, setView] = useState<View_>('list');
  const [owner, setOwner] = useState('');
  const [milestone, setMilestone] = useState('');
  const [label, setLabel] = useState('');
  const [showDone, setShowDone] = useState(false);
  const [adding, setAdding] = useState<TaskStatus | null>(null);
  const { data: labels } = useApi<Label[]>('/labels');
  const { data: fields } = useProjectFields(project.id);
  const { data: tasks, error, reload, setData } = useApi<Task[]>(`/tasks${qs({ projectId: project.id, milestoneId: milestone || undefined, labelId: label || undefined })}`);
  useRealtime((e) => e.type === 'task.updated' && e.projectId === project.id && reload());
  useEffect(() => {
    storage.get('kuu.project.view').then((v) => v && VIEWS.includes(v as View_) && setView(v as View_));
  }, []);
  const changeView = (v: View_) => {
    setView(v);
    storage.set('kuu.project.view', v);
  };
  const move = async (taskId: string, status: TaskStatus) => {
    setData(tasks?.map((t) => (t.id === taskId ? { ...t, status } : t)));
    await act(() => api.patch(`/tasks/${taskId}`, { status }));
    reload();
  };
  const replace = (task: Task) => setData(tasks?.map((t) => (t.id === task.id ? task : t)));
  if (error && !tasks) return <ErrorState error={error} retry={reload} />;
  if (!tasks) return <Loading inline />;
  const filtered = tasks.filter((t) => !owner || t.owner?.id === owner);
  const owners = [...new Map(tasks.filter((t) => t.owner).map((t) => [t.owner!.id, t.owner!])).values()];
  return (
    <View style={{ gap: 12 }}>
      <Segmented
        value={view}
        onChange={changeView}
        options={[
          { id: 'list', label: 'List' },
          { id: 'board', label: 'Board' },
          { id: 'table', label: 'Table' },
          { id: 'calendar', label: 'Calendar' },
        ]}
      />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
        <View style={{ width: 150 }}>
          <Select title="Owner" value={owner} onChange={setOwner} options={[{ id: '', label: 'Everyone' }, ...owners.map((o) => ({ id: o.id, label: o.name }))]} />
        </View>
        {project.milestones.length > 0 && (
          <View style={{ width: 170 }}>
            <Select title="Milestone" value={milestone} onChange={setMilestone} options={[{ id: '', label: 'All milestones' }, ...project.milestones.map((m) => ({ id: m.id, label: m.name }))]} />
          </View>
        )}
        {!!labels?.length && (
          <View style={{ width: 150 }}>
            <Select title="Label" value={label} onChange={setLabel} options={[{ id: '', label: 'Any label' }, ...labels.map((l) => ({ id: l.id, label: l.name }))]} />
          </View>
        )}
      </ScrollView>
      <Row style={{ justifyContent: 'space-between' }}>
        {view === 'list' ? (
          <View style={{ width: 160 }}>
            <Toggle label="Show done" value={showDone} onChange={setShowDone} />
          </View>
        ) : (
          <View />
        )}
        {project.can_contribute && <Button small variant="primary" icon="plus" title="Add task" onPress={() => setAdding('todo')} />}
      </Row>
      {view === 'table' ? (
        <TaskTable tasks={filtered} fields={fields ?? []} canEdit={project.can_contribute} onOpen={openTask} onChanged={replace} />
      ) : view === 'calendar' ? (
        <TaskCalendar tasks={filtered} canEdit={project.can_contribute} onOpen={openTask} onChanged={replace} />
      ) : view === 'board' ? (
        <TaskBoard tasks={filtered} canEdit={project.can_contribute} onOpen={openTask} onMove={move} onAdd={setAdding} />
      ) : (
        <>
          {STATUSES.filter((s) => showDone || s !== 'done').map((status) => {
            const group = filtered.filter((t) => t.status === status);
            if (!group.length) return null;
            return (
              <Section key={status} title={STATUS_LABEL[status]} count={group.length}>
                <TaskList tasks={group} showProject={false} onOpen={(t) => openTask(t.id)} onToggle={project.can_contribute ? (t, d) => move(t.id, d ? 'done' : 'todo') : undefined} />
              </Section>
            );
          })}
          {!filtered.filter((t) => showDone || t.status !== 'done').length && <Empty icon="task" title="No open tasks" />}
        </>
      )}
      <Sheet open={!!adding} onClose={() => setAdding(null)} title={`New task in ${project.name}`} full>
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
      </Sheet>
    </View>
  );
}

// ---------- Import ----------

interface ImportPreview {
  columns: Record<string, string | null>;
  rows: { line: number; title: string; status: string; priority: string; due_date: string | null; owner: { id: string; name: string } | null; warnings: string[] }[];
  errors: { line: number; message: string }[];
}

function ImportTasks({ open, onClose, projectId, onDone }: { open: boolean; onClose: () => void; projectId: string; onDone: () => void }) {
  const act = useAction();
  const [csv, setCsv] = useState('');
  const [fileName, setFileName] = useState('');
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const close = () => {
    setCsv('');
    setFileName('');
    setPreview(null);
    onClose();
  };
  const run = (dryRun: boolean) => act(() => api.post(`/projects/${projectId}/import/tasks`, { csv, dryRun }));
  const warnings = preview?.rows.filter((r) => r.warnings.length).length ?? 0;
  return (
    <Sheet open={open} onClose={close} title="Import tasks" full>
      {!preview ? (
        <>
          <Muted>
            Choose a CSV exported from Trello, Asana, Jira, Monday or a spreadsheet. Küü recognises columns such as Title, Description, Status, Priority, Due date, Start date, Assignee (email or full name) and Estimate. You’ll see a
            preview before anything is created. Up to 500 tasks at a time.
          </Muted>
          <Button
            icon="file"
            title={fileName || 'Choose CSV file'}
            onPress={() =>
              act(async () => {
                const [f] = await pickDocuments();
                if (!f) return;
                const text = f.file ? await (f.file as Blob).text() : await new File(f.uri).text();
                if (text.length > 900_000) throw new Error('That file is too large. Split it into smaller files of up to 500 tasks.');
                setFileName(f.name);
                setCsv(text);
              })
            }
          />
          <Button
            variant="primary"
            title="Preview"
            disabled={!csv}
            onPress={async () => {
              const res = await run(true);
              if (res) setPreview(res as ImportPreview);
            }}
          />
        </>
      ) : (
        <>
          <T>
            <T weight="bold">{preview.rows.length}</T> task{preview.rows.length === 1 ? '' : 's'} ready to import from {fileName || 'your file'}
            {warnings > 0 ? ` · ${warnings} with notes below` : ''}
            {preview.errors.length > 0 ? ` · ${preview.errors.length} row${preview.errors.length === 1 ? '' : 's'} skipped` : ''}
          </T>
          <View>
            {preview.rows.slice(0, 100).map((r) => (
              <ListRow
                key={r.line}
                left={<Muted size={12}>{r.line}</Muted>}
                title={r.title}
                subtitle={[r.status.replace('_', ' '), r.priority, r.due_date ?? 'no date', r.owner?.name ?? 'unassigned', ...r.warnings.map((w) => `⚠ ${w}`)].join(' · ')}
              />
            ))}
            {preview.errors.map((e) => (
              <ListRow key={`e${e.line}`} left={<Muted size={12}>{e.line}</Muted>} title={<Muted>Skipped: {e.message}</Muted>} />
            ))}
          </View>
          {preview.rows.length > 100 && <Muted size={12}>Showing the first 100 rows.</Muted>}
          <Row>
            <Button title="Back" onPress={() => setPreview(null)} />
            <Button
              variant="primary"
              title={`Import ${preview.rows.length} task${preview.rows.length === 1 ? '' : 's'}`}
              disabled={!preview.rows.length}
              onPress={async () => {
                const res = await run(false);
                if (res) {
                  onDone();
                  close();
                }
              }}
            />
          </Row>
        </>
      )}
    </Sheet>
  );
}

// ---------- Time, decisions, risks ----------

function ProjectTime({ projectId }: { projectId: string }) {
  const { c } = useTheme();
  const { openTask } = useShell();
  const { data, error, reload } = useApi<{
    total_minutes: number;
    by_person: { id: string; name: string; color: string; minutes: number }[];
    by_task: { id: string; title: string; estimate_hours: number | null; minutes: number }[];
  }>(`/projects/${projectId}/time`);
  if (error && !data) return <ErrorState error={error} retry={reload} />;
  if (!data) return <Loading inline />;
  if (!data.total_minutes)
    return (
      <Empty icon="clock" title="No time logged yet">
        Start a timer or log time from any task in this project.
      </Empty>
    );
  const max = Math.max(...data.by_person.map((p) => p.minutes), 1);
  return (
    <>
      <Section title={`By person · ${duration(data.total_minutes)}`}>
        {data.by_person.map((p) => (
          <Row key={p.id} gap={8} style={{ paddingVertical: 6 }}>
            <Avatar user={p} size="xs" />
            <T size={14} style={{ width: 100 }} numberOfLines={1}>
              {p.name}
            </T>
            <View style={{ flex: 1 }}>
              <ProgressBar value={(p.minutes / max) * 100} />
            </View>
            <T size={13} weight="bold">
              {duration(p.minutes)}
            </T>
          </Row>
        ))}
      </Section>
      <Section title="By task">
        {data.by_task.map((t) => (
          <ListRow
            key={t.id}
            title={t.title}
            right={
              <T size={13} weight="bold" style={{ color: t.estimate_hours && t.minutes > t.estimate_hours * 60 ? c.amberInk : c.ink }}>
                {duration(t.minutes)}
                {t.estimate_hours ? <T size={12} tone="muted">{` / ${t.estimate_hours}h`}</T> : null}
              </T>
            }
            onPress={() => openTask(t.id)}
          />
        ))}
      </Section>
    </>
  );
}

function ProjectDecisions({ project }: { project: ProjectFull }) {
  const { c } = useTheme();
  const act = useAction();
  const { me } = useSession();
  const { data, reload } = useApi<Decision[]>(`/decisions${qs({ projectId: project.id, limit: 200 })}`);
  const [form, setForm] = useState({ title: '', rationale: '' });
  return (
    <>
      <Section title="Decision log">
        {!data && <Loading inline />}
        {data && !data.length && <Muted>No decisions recorded yet. Record them from messages, meetings or here.</Muted>}
        {data?.map((d) => (
          <Row key={d.id} gap={10} style={{ paddingVertical: 10, borderTopWidth: 1, borderColor: c.line2, alignItems: 'flex-start' }}>
            <View style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: c.amberSoft, alignItems: 'center', justifyContent: 'center' }}>
              <Icon name="gavel" size={15} color={c.amberInk} />
            </View>
            <View style={{ flex: 1, gap: 4 }}>
              <T weight="bold">{d.title}</T>
              {!!d.rationale && <Markdown text={d.rationale} compact size={14} />}
              <Muted size={12}>
                {d.decided_by_name} · {dateTime(d.created_at)}
              </Muted>
              <Row>
                {d.channel_id && d.message_id && (
                  <LinkText size={13} onPress={() => router.push(`/channels/${d.channel_id}?message=${d.message_id}`)}>
                    View discussion
                  </LinkText>
                )}
                {d.meeting_id && (
                  <LinkText size={13} onPress={() => router.push(`/meetings/${d.meeting_id}`)}>
                    From meeting
                  </LinkText>
                )}
              </Row>
            </View>
            {(d.decided_by === me!.user.id || me!.role === 'admin' || me!.role === 'owner') && (
              <IconButton
                name="x"
                size={14}
                label="Remove decision"
                onPress={async () => {
                  if (!(await confirm('Remove this decision from the log?', undefined, 'Remove'))) return;
                  await act(() => api.del(`/decisions/${d.id}`));
                  reload();
                }}
              />
            )}
          </Row>
        ))}
      </Section>
      {project.can_contribute && (
        <Section title="Record a decision">
          <View style={{ gap: 10 }}>
            <Field label="Decision">
              <Input value={form.title} onChangeText={(v) => setForm({ ...form, title: v })} />
            </Field>
            <Field label="Rationale">
              <Input multiline value={form.rationale} onChangeText={(v) => setForm({ ...form, rationale: v })} />
            </Field>
            <Button
              variant="primary"
              title="Record"
              disabled={!form.title.trim()}
              onPress={async () => {
                const ok = await act(() => api.post('/decisions', { ...form, projectId: project.id }), 'Decision recorded');
                if (ok) {
                  setForm({ title: '', rationale: '' });
                  reload();
                }
              }}
            />
          </View>
        </Section>
      )}
    </>
  );
}

function Risks({ project }: { project: ProjectFull }) {
  const { c } = useTheme();
  const act = useAction();
  const { data, reload } = useApi<{ id: string; title: string; impact: string; mitigation: string; owner_id: string | null; owner_name: string | null; status: string }[]>(`/projects/${project.id}/risks`);
  const [form, setForm] = useState({ title: '', impact: 'medium', mitigation: '', ownerId: '' });
  return (
    <>
      <Section title="Risk register">
        {!data && <Loading inline />}
        {data && !data.length && <Muted>No risks recorded.</Muted>}
        {data?.map((r) => (
          <View key={r.id} style={{ gap: 6, paddingVertical: 10, borderTopWidth: 1, borderColor: c.line2 }}>
            <Row style={{ alignItems: 'flex-start' }}>
              <T weight="bold" style={{ flex: 1 }}>
                {r.title}
              </T>
              <Pill label={r.impact} tone={r.impact === 'high' ? 'red' : r.impact === 'medium' ? 'amber' : 'neutral'} />
            </Row>
            {!!r.mitigation && <Muted>Mitigation: {r.mitigation}</Muted>}
            <Row>
              <Muted size={12} style={{ flex: 1 }}>
                Owner: {r.owner_name ?? '—'}
              </Muted>
              <View style={{ width: 150 }}>
                <Select
                  title={`Status of ${r.title}`}
                  disabled={!project.can_contribute}
                  value={r.status}
                  onChange={async (v) => {
                    await act(() => api.patch(`/risks/${r.id}`, { status: v }));
                    reload();
                  }}
                  options={[
                    { id: 'open', label: 'Open' },
                    { id: 'mitigated', label: 'Mitigated' },
                    { id: 'closed', label: 'Closed' },
                  ]}
                />
              </View>
            </Row>
          </View>
        ))}
      </Section>
      {project.can_contribute && (
        <Section title="Add a risk">
          <View style={{ gap: 10 }}>
            <Field label="Risk">
              <Input value={form.title} onChangeText={(v) => setForm({ ...form, title: v })} />
            </Field>
            <Field label="Impact">
              <Segmented
                value={form.impact}
                onChange={(v) => setForm({ ...form, impact: v })}
                options={[
                  { id: 'low', label: 'Low' },
                  { id: 'medium', label: 'Medium' },
                  { id: 'high', label: 'High' },
                ]}
              />
            </Field>
            <Field label="Owner">
              <PeopleField multiple={false} title="Owner" allowNone="None" placeholder="None" value={form.ownerId ? [form.ownerId] : []} onChange={(ids) => setForm({ ...form, ownerId: ids[0] ?? '' })} />
            </Field>
            <Field label="Mitigation">
              <Input multiline value={form.mitigation} onChangeText={(v) => setForm({ ...form, mitigation: v })} />
            </Field>
            <Button
              variant="primary"
              title="Add risk"
              disabled={!form.title.trim()}
              onPress={async () => {
                const ok = await act(() => api.post(`/projects/${project.id}/risks`, { ...form, ownerId: form.ownerId || null }), 'Risk added');
                if (ok) {
                  setForm({ title: '', impact: 'medium', mitigation: '', ownerId: '' });
                  reload();
                }
              }}
            />
          </View>
        </Section>
      )}
    </>
  );
}

// ---------- Resources, check-ins, activity ----------

function Resources({ project }: { project: ProjectFull }) {
  const { c } = useTheme();
  const act = useAction();
  const [linking, setLinking] = useState(false);
  const [upload, setUpload] = useState(false);
  const [meeting, setMeeting] = useState(false);
  const [link, setLink] = useState({ name: '', url: '' });
  const { data, reload } = useApi<{
    files: { id: string; name: string; label: string; external_url: string | null; current_version: number; size: number | null; owner_name: string; updated_at: string }[];
    pages: { id: string; title: string; status: string; review_date: string | null; owner_name: string; updated_at: string }[];
    meetings: { id: string; title: string; starts_at: string; ended_at: string | null }[];
    decisions: Decision[];
  }>(`/projects/${project.id}/resources`);
  if (!data) return <Loading inline />;
  const send = async (files: { uri: string; name: string; type: string; file?: Blob }[]) => {
    for (const f of files) await act(() => api.upload('/files', formWith({ file: f, projectId: project.id })), 'File uploaded');
    reload();
  };
  return (
    <>
      <Section
        title="Files & links"
        action={
          project.can_contribute ? (
            <Row gap={6}>
              <Button small icon="link" title="Link" onPress={() => setLinking(true)} />
              <Button small icon="upload" title="Upload" onPress={() => setUpload(true)} />
            </Row>
          ) : undefined
        }
      >
        {data.files.map((f) => (
          <ListRow
            key={f.id}
            left={<Icon name={f.external_url ? 'link' : 'file'} size={18} color={c.ink2} />}
            title={f.name}
            subtitle={`${f.label ? `${f.label} · ` : ''}${f.owner_name} · ${f.external_url ? 'External link' : `v${f.current_version} · ${bytes(f.size)}`} · ${timeAgo(f.updated_at)}`}
            onPress={() => router.push(`/files/${f.id}`)}
          />
        ))}
        {!data.files.length && <Muted>No files yet.</Muted>}
      </Section>
      <Section
        title="Knowledge pages"
        action={
          project.can_contribute ? (
            <Button
              small
              icon="plus"
              title="Page"
              onPress={async () => {
                const page = await act(() => api.post<{ id: string }>('/pages', { title: 'Untitled page', projectId: project.id }));
                if (page) router.push(`/knowledge/${page.id}?edit=1`);
              }}
            />
          ) : undefined
        }
      >
        {data.pages.map((p) => (
          <ListRow
            key={p.id}
            left={<Icon name="book" size={18} color={c.ink2} />}
            title={p.title}
            subtitle={`${p.owner_name} · updated ${timeAgo(p.updated_at)}`}
            right={p.status === 'approved' ? <Pill label="Approved" tone="green" /> : undefined}
            onPress={() => router.push(`/knowledge/${p.id}`)}
          />
        ))}
        {!data.pages.length && <Muted>No pages yet.</Muted>}
      </Section>
      <Section title="Meetings" action={project.can_contribute ? <Button small icon="plus" title="Schedule" onPress={() => setMeeting(true)} /> : undefined}>
        {data.meetings.map((m) => (
          <ListRow key={m.id} left={<Icon name="video" size={18} color={c.ink2} />} title={m.title} subtitle={`${dateTime(m.starts_at)}${m.ended_at ? ' · notes available' : ''}`} onPress={() => router.push(`/meetings/${m.id}`)} />
        ))}
        {!data.meetings.length && <Muted>No meetings yet.</Muted>}
      </Section>
      <Section title="Decisions">
        {data.decisions.slice(0, 8).map((d) => (
          <ListRow key={d.id} left={<Icon name="gavel" size={18} color={c.ink2} />} title={d.title} subtitle={`${d.decided_by_name} · ${timeAgo(d.created_at)}`} />
        ))}
        {!data.decisions.length && <Muted>No decisions yet.</Muted>}
      </Section>
      <ActionSheet
        open={upload}
        onClose={() => setUpload(false)}
        title="Upload"
        actions={[
          { label: 'Photo or video', icon: 'upload', onPress: () => act(async () => send(await pickMedia('library', true))) },
          { label: 'Take a photo', icon: 'eye', onPress: () => act(async () => send(await pickMedia('camera'))), hidden: Platform.OS === 'web' },
          { label: 'File', icon: 'file', onPress: () => act(async () => send(await pickDocuments(true))) },
        ]}
      />
      <Sheet
        open={linking}
        onClose={() => setLinking(false)}
        title="Link an external file"
        footer={
          <Button
            title="Add link"
            variant="primary"
            full
            disabled={!link.name.trim() || !/^https:\/\//.test(link.url)}
            onPress={async () => {
              const ok = await act(() => api.post('/files/link', { ...link, projectId: project.id }), 'Link added');
              if (ok) {
                setLinking(false);
                setLink({ name: '', url: '' });
                reload();
              }
            }}
          />
        }
      >
        <Field label="Name">
          <Input value={link.name} onChangeText={(v) => setLink({ ...link, name: v })} placeholder="e.g. Budget spreadsheet" />
        </Field>
        <Field label="URL" hint="Links to Google Drive, OneDrive, Dropbox, Figma or any https address.">
          <Input value={link.url} onChangeText={(v) => setLink({ ...link, url: v })} placeholder="https://…" keyboardType="url" autoCapitalize="none" />
        </Field>
      </Sheet>
      <Sheet open={meeting} onClose={() => setMeeting(false)} title={`Schedule a meeting for ${project.name}`} full>
        <NewMeetingForm projectId={project.id} onDone={() => setMeeting(false)} />
      </Sheet>
    </>
  );
}

function Checkins({ project }: { project: ProjectFull }) {
  const { c } = useTheme();
  const [open, setOpen] = useState(false);
  const { data, reload } = useApi<{ id: string; user_name: string; user_color: string; done: string; next: string; blockers: string; created_at: string }[]>(`/checkins${qs({ projectId: project.id })}`);
  return (
    <Section title="Check-ins" action={project.can_contribute ? <Button small variant="primary" title="Check in" onPress={() => setOpen(true)} /> : undefined}>
      <Muted style={{ marginTop: -6, marginBottom: 6 }}>Short async updates instead of a status meeting</Muted>
      {!data && <Loading inline />}
      {data && !data.length && <Muted>No check-ins yet.</Muted>}
      {data?.map((ci) => (
        <View key={ci.id} style={{ gap: 6, paddingVertical: 10, borderTopWidth: 1, borderColor: c.line2 }}>
          <Row gap={8}>
            <Avatar user={{ name: ci.user_name, color: ci.user_color }} size="sm" />
            <T size={14} weight="bold">
              {ci.user_name}
            </T>
            <Muted size={12}>{timeAgo(ci.created_at)}</Muted>
          </Row>
          {!!ci.done && (
            <T size={14}>
              <T size={14} weight="bold">
                Done:{' '}
              </T>
              {ci.done}
            </T>
          )}
          {!!ci.next && (
            <T size={14}>
              <T size={14} weight="bold">
                Next:{' '}
              </T>
              {ci.next}
            </T>
          )}
          {!!ci.blockers && (
            <T size={14}>
              <T size={14} weight="bold" tone="amber">
                Blockers:{' '}
              </T>
              {ci.blockers}
            </T>
          )}
        </View>
      ))}
      <CheckinSheet open={open} onClose={() => setOpen(false)} onDone={reload} projectId={project.id} />
    </Section>
  );
}

function ProjectActivity({ projectId }: { projectId: string }) {
  const { data } = useApi<{ id: string; actor_name: string; actor_color: string; summary: string; link: string; created_at: string }[]>(`/projects/${projectId}/activity`);
  if (!data) return <Loading inline />;
  return (
    <Card padded={false} style={{ paddingHorizontal: 14 }}>
      {!data.length && <Muted style={{ paddingVertical: 12 }}>No activity yet.</Muted>}
      {data.map((a) => (
        <ListRow
          key={a.id}
          left={<Avatar user={{ name: a.actor_name, color: a.actor_color }} size="xs" />}
          title={
            <T size={14}>
              <T size={14} weight="bold">
                {a.actor_name}
              </T>{' '}
              {a.summary}
            </T>
          }
          subtitle={timeAgo(a.created_at)}
          onPress={a.link ? () => router.push(a.link as never) : undefined}
        />
      ))}
    </Card>
  );
}

function ProjectSettings({ onClose, project, onSaved }: { onClose: () => void; project: ProjectFull; onSaved: () => void }) {
  const act = useAction();
  const [form, setForm] = useState({
    name: project.name,
    description: project.description,
    visibility: project.visibility,
    dueDate: project.due_date,
    ownerId: project.owner?.id ?? '',
    color: project.color,
  });
  return (
    <Sheet
      open
      onClose={onClose}
      title="Project settings"
      full
      footer={
        <Button
          title="Save changes"
          variant="primary"
          full
          disabled={!form.name.trim()}
          onPress={async () => {
            const ok = await act(() => api.patch(`/projects/${project.id}`, form), 'Project updated');
            if (ok) {
              onClose();
              onSaved();
            }
          }}
        />
      }
    >
      <Field label="Name">
        <Input value={form.name} onChangeText={(v) => setForm({ ...form, name: v })} />
      </Field>
      <Field label="Description">
        <Input multiline value={form.description} onChangeText={(v) => setForm({ ...form, description: v })} />
      </Field>
      <Field label="Visibility" hint="Private projects are only visible to members, including in search.">
        <Select
          title="Visibility"
          value={form.visibility}
          onChange={(v) => setForm({ ...form, visibility: v })}
          options={[
            { id: 'workspace', label: 'Everyone in the workspace' },
            { id: 'private', label: 'Private to members' },
          ]}
        />
      </Field>
      <Field label="Target date">
        <DateField value={form.dueDate} onChange={(v) => setForm({ ...form, dueDate: v })} label="Target date" />
      </Field>
      <Field label="Owner (accountable)">
        <PeopleField multiple={false} title="Owner" people={project.members} value={form.ownerId ? [form.ownerId] : []} onChange={(ids) => ids[0] && setForm({ ...form, ownerId: ids[0] })} />
      </Field>
      <Field label="Colour">
        <ColourPicker value={form.color} onChange={(v) => setForm({ ...form, color: v })} />
      </Field>
      <Toggle
        label="Allow AI assistance"
        hint="When off, AI summaries and briefs never read this project’s content."
        value={!project.ai_excluded}
        onChange={async (v) => {
          await act(() => api.patch('/ai/exclusions', { projectId: project.id, excluded: !v }), v ? 'AI assistance allowed' : 'AI assistance turned off for this project');
          onSaved();
        }}
      />
      <Button
        variant="danger"
        title={project.archived_at ? 'Restore project' : 'Archive project'}
        onPress={async () => {
          const archiving = !project.archived_at;
          if (archiving && !(await confirm('Archive this project?', 'It will be hidden from active lists but kept for reference.', 'Archive'))) return;
          await act(() => api.patch(`/projects/${project.id}`, { archived: archiving }), archiving ? 'Project archived' : 'Project restored');
          onClose();
          if (archiving) router.back();
          else onSaved();
        }}
      />
    </Sheet>
  );
}
