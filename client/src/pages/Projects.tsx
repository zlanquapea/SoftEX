import { useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, qs, type Decision, type Label, type Project, type Task, type TaskStatus } from '../api';
import { useAiEnabled } from '../components/Ai';
import { Avatar, AvatarStack } from '../components/Avatar';
import { Icon } from '../components/Icon';
import { useShell } from '../components/Layout';
import { Markdown } from '../components/Markdown';
import { NewMeetingForm, NewTaskForm } from '../components/QuickCreate';
import { TaskRow } from '../components/TaskDrawer';
import { TaskCalendar, TaskTable } from '../components/ProjectViews';
import { FieldsManager, LabelChips, useProjectFields } from '../components/Work';
import { ProjectForms } from './Forms';
import { Boards } from './Boards';
import { FavoriteButton } from '../components/Favorites';
import { ProjectAutomations, ProjectTimeline } from './Planning';
import { LimitNotice, UpgradeNotice, usePlan, usePlanUsage } from '../components/Plan';
import {
  Callout,
  ColorSwatches,
  DatePicker,
  EmptyState,
  ErrorState,
  FilterBar,
  FormField,
  HealthPill,
  Hint,
  IconButton,
  Loading,
  LoadingRows,
  Modal,
  notify,
  Page,
  PageHeader,
  Panel,
  PeoplePicker,
  Pill,
  PriorityPill,
  Segmented,
  StatCard,
  StatGrid,
  SwitchField,
  TabBar,
  toneFor,
  useAction,
  useConfirm,
} from '@/components/kit';
import { BarChart } from '../components/Charts';
import { ProjectCard } from '../components/ProjectCard';
import { DueLabel } from '../components/TaskDrawer';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Spinner } from '@/components/ui/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { bytes, dateTime, dueLabel, duration, HEALTH_LABEL, STATUS_LABEL, timeAgo, dateLabel } from '../format';
import { useApi, useRealtime } from '../hooks';
import { usePeople, useSession } from '../session';
import { CheckinModal } from './Home';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Checkbox } from '@/components/ui/checkbox';
import { Label as UILabel } from '@/components/ui/label';

export function Projects() {
  const { openCreate } = useShell();
  const { me } = useSession();
  const [scope, setScope] = useState<'mine' | 'all' | 'archived'>('mine');
  const { data, error, reload } = useApi<Project[]>(`/projects${qs({ archived: scope === 'archived' ? 'true' : undefined })}`);
  const list = (data ?? []).filter((p) => scope !== 'mine' || p.is_member);
  const { usage } = usePlanUsage();
  return (
    <Page width="full" className="max-w-7xl">
      <PageHeader
        title="Projects"
        description="Plans, owners, progress and health for every initiative you can see."
        actions={
          me!.role !== 'guest' && (
            <Button onClick={() => openCreate('project')}>
              <Icon name="plus" data-icon="inline-start" /> New project
            </Button>
          )
        }
      />
      <TabBar
        value={scope}
        onChange={setScope}
        tabs={[
          { id: 'mine', label: 'My projects' },
          { id: 'all', label: 'All visible' },
          { id: 'archived', label: 'Archived' },
        ]}
      />
      {me!.role !== 'guest' && <LimitNotice kind="projects" usage={usage} />}
      {error && <ErrorState error={error} retry={reload} />}
      {!data && !error && <Loading />}
      {data && !list.length && (
        <EmptyState
          icon="folder"
          title={scope === 'archived' ? 'No archived projects' : 'No projects here yet'}
          action={
            scope !== 'archived' &&
            me!.role !== 'guest' && (
              <Button onClick={() => openCreate('project')}>
                <Icon name="plus" data-icon="inline-start" /> New project
              </Button>
            )
          }
        >
          {scope === 'archived' ? 'Projects you archive appear here.' : 'A project keeps one piece of work together: its tasks, owners, dates, chat and files.'}
        </EmptyState>
      )}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {list.map((p) => (
          <ProjectCard
            key={p.id}
            project={{ ...p, progress: p.stats.progress }}
            description={`${p.team ? `${p.team.name} · ` : ''}${p.member_count} member${p.member_count === 1 ? '' : 's'}`}
            progressLabel={`${p.stats.done}/${p.stats.total} tasks`}
            badges={
              p.visibility === 'private' && (
                <Pill>
                  <Icon name="lock" /> Private
                </Pill>
              )
            }
          >
            {(p.stats.overdue > 0 || p.stats.blocked > 0) && (
              <p className="text-xs text-warning">
                {p.stats.overdue > 0 && `${p.stats.overdue} overdue`}
                {p.stats.overdue > 0 && p.stats.blocked > 0 && ' · '}
                {p.stats.blocked > 0 && `${p.stats.blocked} blocked`}
              </p>
            )}
          </ProjectCard>
        ))}
      </div>
    </Page>
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

type Tab = 'overview' | 'tasks' | 'timeline' | 'automations' | 'forms' | 'boards' | 'time' | 'decisions' | 'risks' | 'resources' | 'checkins' | 'activity';

interface ImportPreview {
  columns: Record<string, string | null>;
  rows: { line: number; title: string; status: string; priority: string; due_date: string | null; owner: { id: string; name: string } | null; warnings: string[] }[];
  errors: { line: number; message: string }[];
}

/** Bring tasks in from a CSV (Trello, Asana, Jira, Monday or a spreadsheet): preview first, then import. */
function ImportTasks({ open, onClose, projectId, onDone }: { open: boolean; onClose: () => void; projectId: string; onDone: () => void }) {
  const act = useAction();
  const [csv, setCsv] = useState('');
  const [fileName, setFileName] = useState('');
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const close = () => {
    setCsv('');
    setFileName('');
    setPreview(null);
    onClose();
  };
  const run = async (dryRun: boolean) => {
    setBusy(true);
    try {
      return await act(() => api.post(`/projects/${projectId}/import/tasks`, { csv, dryRun }));
    } finally {
      setBusy(false);
    }
  };
  const warnings = preview?.rows.filter((r) => r.warnings.length).length ?? 0;
  return (
    <Modal open={open} onClose={close} title="Import tasks" wide>
      {!preview ? (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            Upload a CSV exported from Trello, Asana, Jira, Monday or a spreadsheet. Küü recognises columns such as <em>Title</em>, <em>Description</em>,{' '}
            <em>Status</em>, <em>Priority</em>, <em>Due date</em>, <em>Start date</em>, <em>Assignee</em> (email or full name) and <em>Estimate</em>. You’ll see a
            preview before anything is created. Up to 500 tasks at a time.
          </p>
          <FormField label="CSV file">
            <Input
              type="file"
              accept=".csv,text/csv"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                if (file.size > 900_000) {
                  notify('That file is too large. Split it into smaller files of up to 500 tasks.', 'error');
                  return;
                }
                setFileName(file.name);
                setCsv(await file.text());
              }}
            />
          </FormField>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button
              disabled={!csv || busy}
              onClick={async () => {
                const res = await run(true);
                if (res) setPreview(res);
              }}>
              Preview
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <p className="text-sm">
            <strong>{preview.rows.length}</strong> task{preview.rows.length === 1 ? '' : 's'} ready to import from {fileName || 'your file'}
            {warnings > 0 && <span className="text-muted-foreground"> · {warnings} with notes below</span>}
            {preview.errors.length > 0 && <span className="text-muted-foreground"> · {preview.errors.length} row{preview.errors.length === 1 ? '' : 's'} skipped</span>}
          </p>
          <div className="max-h-96 overflow-auto rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Row</TableHead>
                  <TableHead>Title</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Priority</TableHead>
                  <TableHead>Due</TableHead>
                  <TableHead>Owner</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {preview.rows.slice(0, 100).map((r) => (
                  <TableRow key={r.line}>
                    <TableCell className="text-muted-foreground">{r.line}</TableCell>
                    <TableCell className="whitespace-normal">
                      {r.title}
                      {r.warnings.map((w) => (
                        <span key={w} className="block text-xs text-warning">
                          ⚠ {w}
                        </span>
                      ))}
                    </TableCell>
                    <TableCell className="capitalize">{r.status.replace('_', ' ')}</TableCell>
                    <TableCell className="capitalize">{r.priority}</TableCell>
                    <TableCell>{r.due_date ?? '—'}</TableCell>
                    <TableCell>{r.owner?.name ?? '—'}</TableCell>
                  </TableRow>
                ))}
                {preview.errors.map((e) => (
                  <TableRow key={`e${e.line}`}>
                    <TableCell className="text-muted-foreground">{e.line}</TableCell>
                    <TableCell colSpan={5} className="text-destructive">
                      Skipped: {e.message}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {preview.rows.length > 100 && <p className="text-muted-foreground text-xs">Showing the first 100 rows.</p>}
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button variant="outline" onClick={() => setPreview(null)}>
              Back
            </Button>
            <Button
              disabled={busy || !preview.rows.length}
              onClick={async () => {
                const res = await run(false);
                if (res) {
                  onDone();
                  close();
                }
              }}>
              Import {preview.rows.length} task{preview.rows.length === 1 ? '' : 's'}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

export function ProjectDetail() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) ?? 'overview';
  const setTab = (t: Tab) => setParams(t === 'overview' ? {} : { tab: t });
  const { data: project, error, reload } = useApi<ProjectFull>(`/projects/${id}`);
  const [settings, setSettings] = useState(false);
  const [importing, setImporting] = useState(false);
  const [fieldsOpen, setFieldsOpen] = useState(false);
  const { has } = usePlan();
  useRealtime((e) => e.type === 'task.updated' && e.projectId === id && reload());

  if (error) return <ErrorState error={error} retry={reload} />;
  if (!project) return <Loading />;

  return (
    <Page width="full" className="max-w-7xl">
      <div className="flex flex-wrap items-start gap-4">
        <span className="flex size-12 shrink-0 items-center justify-center rounded-2xl text-white" style={{ background: `var(--c-${project.color})` }} aria-hidden="true">
          <Icon name="folder" size={22} />
        </span>
        <div className="flex min-w-0 flex-1 basis-72 flex-col gap-1.5">
          <p className="text-xs font-semibold tracking-wide text-primary uppercase">
            {project.team?.name ?? 'Project'} {project.visibility === 'private' && '· Private'} {project.archived_at && '· Archived'}
          </p>
          <h1 className="flex flex-wrap items-center gap-2 font-heading text-2xl font-semibold tracking-tight">
            {project.name} <FavoriteButton kind="project" id={project.id} />
          </h1>
          <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
            <HealthPill health={project.health} />
            <span>
              Owner: <strong className="text-foreground">{project.owner?.name}</strong>
            </span>
            {project.due_date && <span>Target: {dateLabel(project.due_date)}</span>}
            <AvatarStack users={project.members} max={5} total={project.member_count} />
            {project.channels.map((c) => (
              <Badge key={c.id} variant="outline" className="max-w-full" title={c.name} render={<Link to={`/channels/${c.id}`} />}>
                <Icon name={c.kind === 'private' ? 'lock' : 'hash'} /> <span className="truncate">{c.name}</span>
              </Badge>
            ))}
          </div>
        </div>
        {(project.can_contribute || project.can_manage) && (
          <div className="flex flex-wrap items-center gap-2">
            {project.can_contribute && (
              <Button variant="outline" onClick={() => setImporting(true)}>
                <Icon name="upload" data-icon="inline-start" /> Import tasks
              </Button>
            )}
            {project.can_manage && (
              <Button variant="outline" onClick={() => setFieldsOpen(true)}>
                <Icon name="list" data-icon="inline-start" /> Fields
              </Button>
            )}
            {project.can_manage && (
              <Button variant="outline" onClick={() => setSettings(true)}>
                <Icon name="settings" data-icon="inline-start" /> Settings
              </Button>
            )}
          </div>
        )}
      </div>
      {project.can_contribute && <ImportTasks open={importing} onClose={() => setImporting(false)} projectId={project.id} onDone={reload} />}
      <TabBar
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
      {tab === 'boards' && <Boards projectId={project.id} />}
      {tab === 'time' && <ProjectTime projectId={project.id} />}
      {tab === 'decisions' && <ProjectDecisions project={project} />}
      {tab === 'risks' && <Risks project={project} />}
      {tab === 'resources' && <Resources project={project} />}
      {tab === 'checkins' && <Checkins project={project} />}
      {tab === 'activity' && <ProjectActivity projectId={project.id} />}
      {project.can_manage && <FieldsManager projectId={project.id} open={fieldsOpen} onClose={() => setFieldsOpen(false)} />}
      {project.can_manage && <ProjectSettings open={settings} onClose={() => setSettings(false)} project={project} onSaved={reload} />}
    </Page>
  );
}

function Overview({ project, reload }: { project: ProjectFull; reload: () => void }) {
  const act = useAction();
  const confirm = useConfirm();
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
    <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="flex min-w-0 flex-col gap-4">
        <StatGrid>
          <StatCard label="Complete" value={`${project.stats.progress}%`} />
          <StatCard label="Open tasks" value={project.stats.total - project.stats.done} />
          <StatCard label="Overdue" value={project.stats.overdue} tone={project.stats.overdue ? 'danger' : undefined} />
          <StatCard label="Blocked" value={project.stats.blocked} tone={project.stats.blocked ? 'warning' : undefined} />
        </StatGrid>
        <Panel title="About this project" contentClassName="flex flex-col gap-4">
          <Progress value={project.stats.progress} aria-label="Project progress" className="h-2.5" />
          {project.description ? <Markdown text={project.description} /> : <p className="text-sm text-muted-foreground">No description yet.</p>}
        </Panel>

        <Panel
          title="Status updates"
          description="How the project is going, in the team’s words"
          action={
            project.can_contribute && (
              <div className="flex flex-wrap items-center gap-2">
                <Hint label="Build a draft from this week's tasks, decisions and risks">
                  <Button variant="outline" size="sm" onClick={draftSummary}>
                    <Icon name="list" data-icon="inline-start" /> Draft weekly summary
                  </Button>
                </Hint>
                {aiEnabled && !project.ai_excluded && (
                  <Hint label="Draft a readable brief with AI from this week's project records">
                    <Button variant="outline" size="sm" onClick={aiBrief} disabled={aiBusy}>
                      {aiBusy ? <Spinner data-icon="inline-start" /> : <Icon name="spark" data-icon="inline-start" />} {aiBusy ? 'Drafting…' : 'AI brief'}
                    </Button>
                  </Hint>
                )}
                <Button size="sm" onClick={() => setUpdating(true)}>
                  Post update
                </Button>
              </div>
            )
          }
          contentClassName="flex flex-col gap-4"
        >
          {updating && (
            <form
              className="flex flex-col gap-4 rounded-xl border bg-muted/30 p-4"
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
              {summary && <Callout tone="info">This draft was built from project records. Review and edit it before sharing.</Callout>}
              <RadioGroup value={update.health} onValueChange={(v) => setUpdate({ ...update, health: v as string })} aria-label="Project health" className="flex flex-wrap gap-2">
                {(['on_track', 'at_risk', 'off_track'] as const).map((h) => (
                  <UILabel
                    key={h}
                    className={cn('flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 font-normal hover:bg-muted', update.health === h && 'border-primary bg-accent/50')}
                  >
                    <RadioGroupItem value={h} />
                    <HealthPill health={h} />
                  </UILabel>
                ))}
              </RadioGroup>
              <Textarea rows={6} required value={update.body} onChange={(e) => setUpdate({ ...update, body: e.target.value })} placeholder="What moved, what is at risk, what is next?" aria-label="Update" />
              <div className="flex justify-end gap-2">
                <Button variant="outline" type="button" onClick={() => setUpdating(false)}>
                  Cancel
                </Button>
                <Button type="submit">Share with project</Button>
              </div>
            </form>
          )}
          {(updates ?? []).slice(0, 5).map((u) => (
            <div key={u.id} className="flex flex-col gap-2 border-t pt-4 first:border-t-0 first:pt-0">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Avatar user={{ name: u.user_name, color: u.user_color }} size="sm" />
                <strong className="font-semibold">{u.user_name}</strong>
                <HealthPill health={u.health} />
                <span className="text-xs text-muted-foreground">{timeAgo(u.created_at)}</span>
              </div>
              <Markdown text={u.body} />
            </div>
          ))}
          {updates && !updates.length && !updating && <p className="text-sm text-muted-foreground">No status updates yet.</p>}
        </Panel>
      </div>
      <aside className="flex flex-col gap-4">
        <Panel title="Milestones" contentClassName="flex flex-col gap-2">
          {project.milestones.map((m) => (
            <div key={m.id} className="flex items-center gap-3 py-1">
              <Checkbox
                checked={!!m.done_at}
                disabled={!project.can_contribute}
                onCheckedChange={async (checked) => {
                  await act(() => api.patch(`/milestones/${m.id}`, { done: checked }));
                  reload();
                }}
                aria-label={`Mark ${m.name} complete`}
              />
              <div className="flex min-w-0 flex-1 flex-col text-sm">
                <strong className={cn('font-medium', m.done_at && 'text-muted-foreground line-through')}>{m.name}</strong>
                <span className="text-xs text-muted-foreground">
                  {m.due_date ? dueLabel(m.due_date) : 'No date'} · {m.done_count}/{m.task_count} tasks
                </span>
              </div>
              {project.can_contribute && (
                <IconButton
                  label={`Delete ${m.name}`}
                  size="icon-xs"
                  onClick={async () => {
                    if (!(await confirm({ title: `Delete milestone ${m.name}?`, confirmLabel: 'Delete', destructive: true }))) return;
                    await act(() => api.del(`/milestones/${m.id}`));
                    reload();
                  }}
                >
                  <Icon name="x" />
                </IconButton>
              )}
            </div>
          ))}
          {!project.milestones.length && <p className="text-sm text-muted-foreground">No milestones.</p>}
          {project.can_contribute && (
            <form
              className="flex flex-wrap items-center gap-2 pt-1"
              onSubmit={async (e) => {
                e.preventDefault();
                if (!milestone.name.trim()) return;
                await act(() => api.post(`/projects/${project.id}/milestones`, { name: milestone.name, dueDate: milestone.dueDate || null }));
                setMilestone({ name: '', dueDate: '' });
                reload();
              }}
            >
              <Input className="min-w-32 flex-1" value={milestone.name} onChange={(e) => setMilestone({ ...milestone, name: e.target.value })} placeholder="Add milestone" aria-label="Milestone name" />
              <DatePicker size="sm" value={milestone.dueDate} onChange={(v) => setMilestone({ ...milestone, dueDate: v ?? '' })} aria-label="Milestone date" placeholder="Date" />
              <Button size="sm" type="submit" disabled={!milestone.name.trim()}>
                Add
              </Button>
            </form>
          )}
        </Panel>
        <Members project={project} reload={reload} />
      </aside>
    </div>
  );
}

function Members({ project, reload }: { project: ProjectFull; reload: () => void }) {
  const { me } = useSession();
  const people = usePeople();
  const act = useAction();
  const [ids, setIds] = useState<string[]>([]);
  return (
    <Panel title="Members" description={`${project.member_count} people`} contentClassName="flex flex-col gap-1">
      {project.members.map((m) => (
        <div key={m.id} className="flex items-center gap-2.5 py-1">
          <Avatar user={m} size="sm" showPresence />
          <Link to={`/people/${m.id}`} className="flex min-w-0 flex-1 items-center gap-2 text-sm hover:underline">
            <span className="truncate">{m.name}</span> {m.id === project.owner?.id && <Pill tone="brand">Owner</Pill>}
          </Link>
          {(project.can_manage || m.id === me!.user.id) && m.id !== project.owner?.id && (
            <IconButton
              label={`Remove ${m.name}`}
              size="icon-xs"
              onClick={async () => {
                await act(() => api.del(`/projects/${project.id}/members/${m.id}`), 'Removed from project');
                reload();
              }}
            >
              <Icon name="x" />
            </IconButton>
          )}
        </div>
      ))}
      {project.can_contribute && me!.role !== 'guest' && (
        <div className="flex flex-col gap-2 pt-2">
          <PeoplePicker people={people} value={ids} onChange={setIds} exclude={project.members.map((m) => m.id)} placeholder="Add members…" />
          {ids.length > 0 && (
            <Button
              size="sm"
              className="self-end"
              onClick={async () => {
                await act(() => api.post(`/projects/${project.id}/members`, { userIds: ids }), 'Members added');
                setIds([]);
                reload();
              }}
            >
              Add {ids.length}
            </Button>
          )}
        </div>
      )}
    </Panel>
  );
}

const COLUMNS: TaskStatus[] = ['todo', 'in_progress', 'blocked', 'review', 'done'];
type View = 'list' | 'board' | 'table' | 'calendar';
const VIEWS: View[] = ['list', 'board', 'table', 'calendar'];

/** Hours logged on the project, by person and by task. */
function ProjectTime({ projectId }: { projectId: string }) {
  const { data, error, reload } = useApi<{
    total_minutes: number;
    by_person: { id: string; name: string; color: string; minutes: number }[];
    by_task: { id: string; title: string; estimate_hours: number | null; minutes: number }[];
  }>(`/projects/${projectId}/time`);
  const { openTask } = useShell();
  if (error) return <ErrorState error={error} retry={reload} />;
  if (!data) return <Loading />;
  if (!data.total_minutes) return <EmptyState icon="clock" title="No time logged yet">Start a timer or log time from any task in this project.</EmptyState>;
  const chart = data.by_person.map((p, i) => ({ key: p.id, label: p.name, value: Math.round((p.minutes / 60) * 10) / 10, color: p.color, i }));
  return (
    <div className="grid items-start gap-4 lg:grid-cols-2">
      <Panel title="By person" description={`${duration(data.total_minutes)} logged in total`}>
        <BarChart items={chart.map(({ key, label, value, color }) => ({ key, label, value, color }))} unit="h" />
      </Panel>
      <Panel title="By task" contentClassName="flex flex-col">
        {data.by_task.map((t) => (
          <button key={t.id} className="flex items-center gap-3 rounded-lg px-2 py-2 text-left text-sm hover:bg-muted" onClick={() => openTask(t.id)}>
            <span className="min-w-0 flex-1 truncate">{t.title}</span>
            <strong className={cn('tabular-nums', t.estimate_hours && t.minutes > t.estimate_hours * 60 && 'text-warning')}>
              {duration(t.minutes)}
              {t.estimate_hours ? <span className="font-normal text-muted-foreground"> / {t.estimate_hours}h</span> : null}
            </strong>
          </button>
        ))}
      </Panel>
    </div>
  );
}

function ProjectTasks({ project }: { project: ProjectFull }) {
  const { openTask } = useShell();
  const act = useAction();
  const [view, setView] = useState<View>(() => {
    try {
      const saved = localStorage.getItem('softex.project.view') as View | null;
      return saved && VIEWS.includes(saved) ? saved : 'list';
    } catch {
      return 'list';
    }
  });
  const [owner, setOwner] = useState('');
  const [milestone, setMilestone] = useState('');
  const [label, setLabel] = useState('');
  const { data: labels } = useApi<Label[]>('/labels');
  const { data: fields } = useProjectFields(project.id);
  const [adding, setAdding] = useState<TaskStatus | null>(null);
  const [showDone, setShowDone] = useState(false);
  const dragged = useRef<string | null>(null);
  const { data: tasks, error, reload, setData } = useApi<Task[]>(`/tasks${qs({ projectId: project.id, milestoneId: milestone || undefined, labelId: label || undefined })}`);
  useRealtime((e) => e.type === 'task.updated' && e.projectId === project.id && reload());

  const changeView = (v: View) => {
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
    // Waited for, so the ticked box doesn't flick back before the fresh list arrives.
    await reload();
  };

  const replace = (task: Task) => setData(tasks?.map((t) => (t.id === task.id ? task : t)));

  if (error) return <ErrorState error={error} retry={reload} />;
  if (!tasks) return <Loading />;
  const filtered = tasks.filter((t) => !owner || t.owner?.id === owner);
  const owners = [...new Map(tasks.filter((t) => t.owner).map((t) => [t.owner!.id, t.owner!])).values()];

  const statusDot = (st: TaskStatus) =>
    st === 'done' ? 'bg-success' : st === 'blocked' ? 'bg-destructive' : st === 'in_progress' ? 'bg-info' : st === 'review' ? 'bg-warning' : 'bg-muted-foreground/50';
  return (
    <div className="flex flex-col gap-4">
      <FilterBar>
        <Segmented
          aria-label="View"
          value={view}
          onChange={changeView}
          options={[
            {
              value: 'list',
              label: (
                <>
                  <Icon name="list" /> List
                </>
              ),
            },
            {
              value: 'board',
              label: (
                <>
                  <Icon name="board" /> Board
                </>
              ),
            },
            {
              value: 'table',
              label: (
                <>
                  <Icon name="table" /> Table
                </>
              ),
            },
            {
              value: 'calendar',
              label: (
                <>
                  <Icon name="calendar" /> Calendar
                </>
              ),
            },
          ]}
        />
        <NativeSelect size="sm" value={owner} onChange={(e) => setOwner(e.target.value)} aria-label="Filter by owner">
          <NativeSelectOption value="">Everyone</NativeSelectOption>
          {owners.map((o) => (
            <NativeSelectOption key={o.id} value={o.id}>
              {o.name}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        {project.milestones.length > 0 && (
          <NativeSelect size="sm" value={milestone} onChange={(e) => setMilestone(e.target.value)} aria-label="Filter by milestone">
            <NativeSelectOption value="">All milestones</NativeSelectOption>
            {project.milestones.map((m) => (
              <NativeSelectOption key={m.id} value={m.id}>
                {m.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        )}
        {!!labels?.length && (
          <NativeSelect size="sm" value={label} onChange={(e) => setLabel(e.target.value)} aria-label="Filter by label">
            <NativeSelectOption value="">Any label</NativeSelectOption>
            {labels.map((l) => (
              <NativeSelectOption key={l.id} value={l.id}>
                {l.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        )}
        {view === 'list' && <SwitchField label="Show done" checked={showDone} onCheckedChange={setShowDone} className="w-auto" />}
        <span className="flex-1" />
        {project.can_contribute && (
          <Button size="sm" onClick={() => setAdding('todo')}>
            <Icon name="plus" data-icon="inline-start" /> Add task
          </Button>
        )}
      </FilterBar>

      {view === 'table' ? (
        <TaskTable tasks={filtered} fields={fields ?? []} canEdit={project.can_contribute} onOpen={openTask} onChanged={replace} />
      ) : view === 'calendar' ? (
        <TaskCalendar tasks={filtered} canEdit={project.can_contribute} onOpen={openTask} onChanged={replace} />
      ) : view === 'list' ? (
        <Card className="gap-4 px-3">
          {COLUMNS.filter((s) => showDone || s !== 'done').map((status) => {
            const group = filtered.filter((t) => t.status === status);
            if (!group.length) return null;
            return (
              <section key={status} className="flex flex-col" aria-label={STATUS_LABEL[status]}>
                <h3 className="flex items-center gap-2 px-2 pb-1 text-sm font-semibold">
                  <i className={cn('size-2 rounded-full', statusDot(status))} aria-hidden="true" /> {STATUS_LABEL[status]} <Pill>{group.length}</Pill>
                </h3>
                {group.map((t) => (
                  <TaskRow key={t.id} task={t} showProject={false} onOpen={() => openTask(t.id)} onToggle={project.can_contribute ? (d) => move(t.id, d ? 'done' : 'todo') : undefined} />
                ))}
              </section>
            );
          })}
          {!filtered.filter((t) => showDone || t.status !== 'done').length && <EmptyState icon="task" title="No open tasks" />}
        </Card>
      ) : (
        <div className="flex gap-3 overflow-x-auto pb-2">
          {COLUMNS.map((status) => {
            const group = filtered.filter((t) => t.status === status);
            return (
              <section
                key={status}
                className="flex w-72 shrink-0 flex-col gap-2 rounded-2xl bg-muted/60 p-2 transition-colors data-[drop=true]:bg-accent"
                onDragOver={(e) => project.can_contribute && e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  e.currentTarget.dataset.drop = 'false';
                  if (dragged.current) move(dragged.current, status);
                  dragged.current = null;
                }}
                onDragEnter={(e) => (e.currentTarget.dataset.drop = 'true')}
                onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && (e.currentTarget.dataset.drop = 'false')}
                aria-label={STATUS_LABEL[status]}
              >
                <h3 className="flex items-center gap-2 px-1.5 pt-1 text-sm font-semibold">
                  <i className={cn('size-2 rounded-full', statusDot(status))} aria-hidden="true" /> {STATUS_LABEL[status]}{' '}
                  <span className="text-xs font-normal text-muted-foreground tabular-nums">{group.length}</span>
                </h3>
                {group.map((t) => (
                  <Card
                    key={t.id}
                    size="sm"
                    className="cursor-pointer gap-2 transition-shadow hover:shadow-md focus-visible:ring-3 focus-visible:ring-ring/40 focus-visible:outline-none"
                    draggable={project.can_contribute}
                    onDragStart={() => (dragged.current = t.id)}
                    onClick={() => openTask(t.id)}
                    onKeyDown={(e) => e.key === 'Enter' && openTask(t.id)}
                    tabIndex={0}
                    role="button"
                    aria-label={`${t.title}, ${STATUS_LABEL[t.status]}`}
                  >
                    <CardContent className="flex flex-col gap-2">
                      <strong className="text-sm font-medium">{t.title}</strong>
                      {t.status === 'blocked' && t.blocked_reason && <span className="text-xs text-warning">{t.blocked_reason}</span>}
                      <LabelChips labels={t.labels} />
                      <div className="flex items-center gap-2 text-xs">
                        <PriorityPill priority={t.priority} />
                        {t.due_date && <DueLabel due={t.due_date} overdue={t.overdue} />}
                        {t.checklist.total > 0 && (
                          <span className="inline-flex items-center gap-1 text-muted-foreground">
                            <Icon name="check" size={11} /> {t.checklist.done}/{t.checklist.total}
                          </span>
                        )}
                        <span className="flex-1" />
                        <Avatar user={t.owner} size="xs" />
                      </div>
                      {project.can_contribute && (
                        <NativeSelect
                          size="sm"
                          className="w-full md:hidden"
                          value={t.status}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => move(t.id, e.target.value as TaskStatus)}
                          aria-label={`Move ${t.title}`}
                        >
                          {COLUMNS.map((c) => (
                            <NativeSelectOption key={c} value={c}>
                              {STATUS_LABEL[c]}
                            </NativeSelectOption>
                          ))}
                        </NativeSelect>
                      )}
                    </CardContent>
                  </Card>
                ))}
                {project.can_contribute && (
                  <Button variant="ghost" size="sm" className="justify-start text-muted-foreground" onClick={() => setAdding(status)}>
                    <Icon name="plus" data-icon="inline-start" /> Add
                  </Button>
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
  const confirm = useConfirm();
  const { me } = useSession();
  const { data, reload } = useApi<Decision[]>(`/decisions${qs({ projectId: project.id, limit: 200 })}`);
  const [form, setForm] = useState({ title: '', rationale: '' });
  return (
    <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
      <Panel title="Decision log" contentClassName="flex flex-col">
        {!data && <LoadingRows rows={3} />}
        {data && !data.length && <p className="text-sm text-muted-foreground">No decisions recorded yet. Record them from messages, meetings or here.</p>}
        {data?.map((d) => (
          <div key={d.id} className="flex items-start gap-3 border-t py-3 first:border-t-0 first:pt-0">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground">
              <Icon name="gavel" size={15} />
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
              <strong className="font-semibold">{d.title}</strong>
              {d.rationale && (
                <div className="text-muted-foreground">
                  <Markdown text={d.rationale} compact />
                </div>
              )}
              <span className="text-xs text-muted-foreground">
                {d.decided_by_name} · {dateTime(d.created_at)}
                {d.channel_id && d.message_id && (
                  <>
                    {' · '}
                    <Link className="text-primary hover:underline" to={`/channels/${d.channel_id}?message=${d.message_id}`}>
                      View discussion
                    </Link>
                  </>
                )}
                {d.meeting_id && (
                  <>
                    {' · '}
                    <Link className="text-primary hover:underline" to={`/meetings/${d.meeting_id}`}>
                      From meeting
                    </Link>
                  </>
                )}
              </span>
            </div>
            {(d.decided_by === me!.user.id || me!.role === 'admin' || me!.role === 'owner') && (
              <IconButton
                label="Remove decision"
                size="icon-xs"
                onClick={async () => {
                  if (!(await confirm({ title: 'Remove this decision from the log?', confirmLabel: 'Remove', destructive: true }))) return;
                  await act(() => api.del(`/decisions/${d.id}`));
                  reload();
                }}
              >
                <Icon name="x" />
              </IconButton>
            )}
          </div>
        ))}
      </Panel>
      {project.can_contribute && (
        <Panel title="Record a decision">
          <form
            className="flex flex-col gap-4"
            onSubmit={async (e: FormEvent) => {
              e.preventDefault();
              const ok = await act(() => api.post('/decisions', { ...form, projectId: project.id }), 'Decision recorded');
              if (ok) {
                setForm({ title: '', rationale: '' });
                reload();
              }
            }}
          >
            <FormField label="Decision">
              <Input required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
            </FormField>
            <FormField label="Rationale">
              <Textarea rows={4} value={form.rationale} onChange={(e) => setForm({ ...form, rationale: e.target.value })} />
            </FormField>
            <Button type="submit" className="self-end">
              Record
            </Button>
          </form>
        </Panel>
      )}
    </div>
  );
}

function Risks({ project }: { project: ProjectFull }) {
  const act = useAction();
  const people = usePeople();
  const { data, reload } = useApi<{ id: string; title: string; impact: string; mitigation: string; owner_id: string | null; owner_name: string | null; status: string }[]>(
    `/projects/${project.id}/risks`,
  );
  const [form, setForm] = useState({ title: '', impact: 'medium', mitigation: '', ownerId: '' });
  return (
    <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
      <Panel title="Risk register">
        {!data && <LoadingRows rows={3} />}
        {data && !data.length && <p className="text-sm text-muted-foreground">No risks recorded.</p>}
        {!!data?.length && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Risk</TableHead>
                <TableHead>Impact</TableHead>
                <TableHead>Owner</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="max-w-72 whitespace-normal">
                    <strong className="font-medium">{r.title}</strong>
                    {r.mitigation && <span className="block text-xs text-muted-foreground">Mitigation: {r.mitigation}</span>}
                  </TableCell>
                  <TableCell>
                    <Pill tone={toneFor(r.impact)} className="capitalize">
                      {r.impact}
                    </Pill>
                  </TableCell>
                  <TableCell>{r.owner_name ?? '—'}</TableCell>
                  <TableCell>
                    <NativeSelect
                      size="sm"
                      value={r.status}
                      disabled={!project.can_contribute}
                      onChange={async (e) => {
                        await act(() => api.patch(`/risks/${r.id}`, { status: e.target.value }));
                        reload();
                      }}
                      aria-label={`Status of ${r.title}`}
                    >
                      <NativeSelectOption value="open">Open</NativeSelectOption>
                      <NativeSelectOption value="mitigated">Mitigated</NativeSelectOption>
                      <NativeSelectOption value="closed">Closed</NativeSelectOption>
                    </NativeSelect>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Panel>
      {project.can_contribute && (
        <Panel title="Add a risk">
          <form
            className="flex flex-col gap-4"
            onSubmit={async (e) => {
              e.preventDefault();
              const ok = await act(() => api.post(`/projects/${project.id}/risks`, { ...form, ownerId: form.ownerId || null }), 'Risk added');
              if (ok) {
                setForm({ title: '', impact: 'medium', mitigation: '', ownerId: '' });
                reload();
              }
            }}
          >
            <FormField label="Risk">
              <Input required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
            </FormField>
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label="Impact">
                <NativeSelect value={form.impact} onChange={(e) => setForm({ ...form, impact: e.target.value })}>
                  <NativeSelectOption value="low">Low</NativeSelectOption>
                  <NativeSelectOption value="medium">Medium</NativeSelectOption>
                  <NativeSelectOption value="high">High</NativeSelectOption>
                </NativeSelect>
              </FormField>
              <FormField label="Owner">
                <NativeSelect value={form.ownerId} onChange={(e) => setForm({ ...form, ownerId: e.target.value })}>
                  <NativeSelectOption value="">None</NativeSelectOption>
                  {people.map((p) => (
                    <NativeSelectOption key={p.id} value={p.id}>
                      {p.name}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </FormField>
            </div>
            <FormField label="Mitigation">
              <Textarea rows={3} value={form.mitigation} onChange={(e) => setForm({ ...form, mitigation: e.target.value })} />
            </FormField>
            <Button type="submit" className="self-end">
              Add risk
            </Button>
          </form>
        </Panel>
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
  const row = 'flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-muted';
  return (
    <div className="grid items-start gap-4 md:grid-cols-2">
      <Panel
        title="Files & links"
        action={
          project.can_contribute && (
            <div className="flex items-center gap-1">
              <Button variant="outline" size="sm" onClick={() => setLinking(true)}>
                <Icon name="link" data-icon="inline-start" /> Link
              </Button>
              <Button variant="outline" size="sm" onClick={() => fileInput.current?.click()}>
                <Icon name="upload" data-icon="inline-start" /> Upload
              </Button>
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
          )
        }
        contentClassName="flex flex-col"
      >
        {data.files.map((f) => (
          <Link key={f.id} to={`/files/${f.id}`} className={row}>
            <Icon name={f.external_url ? 'link' : 'file'} size={16} className="text-muted-foreground" />
            <span className="flex min-w-0 flex-1 flex-col text-sm">
              <span className="flex flex-wrap items-center gap-2">
                <strong className="truncate font-medium">{f.name}</strong> {f.label && <Pill>{f.label}</Pill>}
              </span>
              <span className="text-xs text-muted-foreground">
                {f.owner_name} · {f.external_url ? 'External link' : `v${f.current_version} · ${bytes(f.size)}`} · {timeAgo(f.updated_at)}
              </span>
            </span>
          </Link>
        ))}
        {!data.files.length && <p className="text-sm text-muted-foreground">No files yet.</p>}
      </Panel>
      <Panel
        title="Knowledge pages"
        action={
          project.can_contribute && (
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                const page = await act(() => api.post('/pages', { title: 'Untitled page', projectId: project.id }));
                if (page) navigate(`/knowledge/${page.id}?edit=1`);
              }}
            >
              <Icon name="plus" data-icon="inline-start" /> Page
            </Button>
          )
        }
        contentClassName="flex flex-col"
      >
        {data.pages.map((p) => (
          <Link key={p.id} to={`/knowledge/${p.id}`} className={row}>
            <Icon name="book" size={16} className="text-muted-foreground" />
            <span className="flex min-w-0 flex-1 flex-col text-sm">
              <span className="flex flex-wrap items-center gap-2">
                <strong className="truncate font-medium">{p.title}</strong> {p.status === 'approved' && <Pill tone="success">Approved</Pill>}
              </span>
              <span className="text-xs text-muted-foreground">
                {p.owner_name} · updated {timeAgo(p.updated_at)}
              </span>
            </span>
          </Link>
        ))}
        {!data.pages.length && <p className="text-sm text-muted-foreground">No pages yet.</p>}
      </Panel>
      <Panel
        title="Meetings"
        action={
          project.can_contribute && (
            <Button variant="outline" size="sm" onClick={() => setMeeting(true)}>
              <Icon name="plus" data-icon="inline-start" /> Schedule
            </Button>
          )
        }
        contentClassName="flex flex-col"
      >
        {data.meetings.map((m) => (
          <Link key={m.id} to={`/meetings/${m.id}`} className={row}>
            <Icon name="video" size={16} className="text-muted-foreground" />
            <span className="flex min-w-0 flex-1 flex-col text-sm">
              <strong className="truncate font-medium">{m.title}</strong>
              <span className="text-xs text-muted-foreground">
                {dateTime(m.starts_at)} {m.ended_at && '· notes available'}
              </span>
            </span>
          </Link>
        ))}
        {!data.meetings.length && <p className="text-sm text-muted-foreground">No meetings yet.</p>}
      </Panel>
      <Panel title="Decisions" contentClassName="flex flex-col">
        {data.decisions.slice(0, 8).map((d) => (
          <div key={d.id} className="flex items-center gap-3 px-2 py-2">
            <Icon name="gavel" size={16} className="text-muted-foreground" />
            <span className="flex min-w-0 flex-1 flex-col text-sm">
              <strong className="font-medium">{d.title}</strong>
              <span className="text-xs text-muted-foreground">
                {d.decided_by_name} · {timeAgo(d.created_at)}
              </span>
            </span>
          </div>
        ))}
        {!data.decisions.length && <p className="text-sm text-muted-foreground">No decisions yet.</p>}
      </Panel>
      <Modal open={linking} onClose={() => setLinking(false)} title="Link an external file">
        <form
          className="flex flex-col gap-4"
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
          <FormField label="Name">
            <Input required value={link.name} onChange={(e) => setLink({ ...link, name: e.target.value })} placeholder="e.g. Budget spreadsheet" />
          </FormField>
          <FormField label="URL" hint="Links to Google Drive, OneDrive, Dropbox, Figma or any https address.">
            <Input required type="url" value={link.url} onChange={(e) => setLink({ ...link, url: e.target.value })} placeholder="https://…" />
          </FormField>
          <div className="flex justify-end">
            <Button type="submit">Add link</Button>
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
    <Panel
      title="Check-ins"
      description="Short async updates instead of a status meeting"
      action={
        project.can_contribute && (
          <Button size="sm" onClick={() => setOpen(true)}>
            Check in
          </Button>
        )
      }
      contentClassName="flex flex-col gap-3"
    >
      {!data && <LoadingRows rows={3} />}
      {data && !data.length && <p className="text-sm text-muted-foreground">No check-ins yet.</p>}
      {data?.map((c) => (
        <div key={c.id} className="flex flex-col gap-2 rounded-xl border p-3">
          <div className="flex items-center gap-2 text-sm">
            <Avatar user={{ name: c.user_name, color: c.user_color }} size="sm" />
            <strong className="font-semibold">{c.user_name}</strong>
            <span className="text-xs text-muted-foreground">{timeAgo(c.created_at)}</span>
          </div>
          <dl className="grid grid-cols-[5rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
            {c.done && (
              <>
                <dt className="text-muted-foreground">Done</dt>
                <dd className="whitespace-pre-wrap">{c.done}</dd>
              </>
            )}
            {c.next && (
              <>
                <dt className="text-muted-foreground">Next</dt>
                <dd className="whitespace-pre-wrap">{c.next}</dd>
              </>
            )}
            {c.blockers && (
              <>
                <dt className="text-warning">Blockers</dt>
                <dd className="whitespace-pre-wrap">{c.blockers}</dd>
              </>
            )}
          </dl>
        </div>
      ))}
      <CheckinModal open={open} onClose={() => setOpen(false)} onDone={reload} projectId={project.id} />
    </Panel>
  );
}

function ProjectActivity({ projectId }: { projectId: string }) {
  const { data } = useApi<{ id: string; actor_name: string; actor_color: string; summary: string; link: string; created_at: string }[]>(`/projects/${projectId}/activity`);
  if (!data) return <Loading />;
  return (
    <Panel title="Activity">
      {!data.length && <p className="text-sm text-muted-foreground">No activity yet.</p>}
      <ol className="flex flex-col gap-3 border-l pl-4 text-sm">
        {data.map((a) => (
          <li key={a.id} className="relative flex flex-wrap items-center gap-1.5 before:absolute before:top-2 before:-left-[1.3rem] before:size-2 before:rounded-full before:bg-border">
            <Avatar user={{ name: a.actor_name, color: a.actor_color }} size="xs" /> <strong className="font-medium">{a.actor_name}</strong>{' '}
            {a.link ? (
              <Link className="hover:underline" to={a.link}>
                {a.summary}
              </Link>
            ) : (
              a.summary
            )}{' '}
            <span className="text-xs text-muted-foreground">{timeAgo(a.created_at)}</span>
          </li>
        ))}
      </ol>
    </Panel>
  );
}

function ProjectSettings({ open, onClose, project, onSaved }: { open: boolean; onClose: () => void; project: ProjectFull; onSaved: () => void }) {
  const act = useAction();
  const confirm = useConfirm();
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
        className="flex flex-col gap-4"
        onSubmit={async (e) => {
          e.preventDefault();
          const ok = await act(() => api.patch(`/projects/${project.id}`, { ...form, dueDate: form.dueDate || null }), 'Project updated');
          if (ok) {
            onClose();
            onSaved();
          }
        }}
      >
        <FormField label="Name">
          <Input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </FormField>
        <FormField label="Description">
          <Textarea rows={4} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </FormField>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Visibility" hint="Private projects are only visible to members, including in search.">
            <NativeSelect value={form.visibility} onChange={(e) => setForm({ ...form, visibility: e.target.value as 'workspace' | 'private' })}>
              <NativeSelectOption value="workspace">Everyone in the workspace</NativeSelectOption>
              <NativeSelectOption value="private">Private to members</NativeSelectOption>
            </NativeSelect>
          </FormField>
          <FormField label="Target date">
            <DatePicker value={form.dueDate} onChange={(v) => setForm({ ...form, dueDate: v ?? '' })} placeholder="No target date" />
          </FormField>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Owner (accountable)">
            <NativeSelect value={form.ownerId} onChange={(e) => setForm({ ...form, ownerId: e.target.value })}>
              {project.members.map((m) => (
                <NativeSelectOption key={m.id} value={m.id}>
                  {m.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </FormField>
          <FormField label="Colour">
            <ColorSwatches colors={['purple', 'blue', 'green', 'coral', 'gold', 'sky', 'mint', 'orange']} value={form.color} onChange={(c) => setForm({ ...form, color: c })} />
          </FormField>
        </div>
        <SwitchField
          label="Allow AI assistance"
          description="When off, AI summaries and briefs never read this project’s content."
          checked={!project.ai_excluded}
          onCheckedChange={async (checked) => {
            await act(() => api.patch('/ai/exclusions', { projectId: project.id, excluded: !checked }), checked ? 'AI assistance allowed' : 'AI assistance turned off for this project');
            onSaved();
          }}
        />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button
            variant="ghost"
            className="text-destructive"
            type="button"
            onClick={async () => {
              const archiving = !project.archived_at;
              if (archiving && !(await confirm({ title: 'Archive this project?', description: 'It will be hidden from active lists but kept for reference.', confirmLabel: 'Archive' }))) return;
              await act(() => api.patch(`/projects/${project.id}`, { archived: archiving }), archiving ? 'Project archived' : 'Project restored');
              onClose();
              archiving ? navigate('/projects') : onSaved();
            }}>
            {project.archived_at ? 'Restore project' : 'Archive project'}
          </Button>
          <Button type="submit">Save changes</Button>
        </div>
      </form>
    </Modal>
  );
}
