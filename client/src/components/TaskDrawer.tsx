import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api, qs, type Task } from '../api';
import { bytes, dueLabel, localToday, plainMentions, STATUS_LABEL, timeAgo } from '../format';
import { useApi, useRealtime, useViewing } from '../hooks';
import { usePeople, useSession } from '../session';
import { Avatar } from './Avatar';
import { Icon } from './Icon';
import { RemindButton } from './Later';
import { Markdown } from './Markdown';
import { NewTaskForm } from './QuickCreate';
import { defaultUntil, REPEAT_OPTIONS, repeatLabel, shortRepeat } from '../repeat';
import { Callout, ChoiceChips, DatePicker, ErrorBoundary, ErrorState, IconButton, Loading, Pill, PriorityPill, StatusPill, useAction, useConfirm } from '@/components/kit';
import { LabelChips, LabelPicker, TaskFieldRows, TimeTracker } from './Work';
import { usePlan } from './Plan';
import { Button, buttonVariants } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from '@/components/ui/input-group';
import { Item, ItemContent, ItemGroup, ItemMedia, ItemTitle } from '@/components/ui/item';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';

const STATUS_TONE = { todo: 'neutral', in_progress: 'info', blocked: 'danger', review: 'warning', done: 'success' } as const;

/** Side drawer wrapper around TaskDetail, opened from any list. */
export function TaskDrawer({ taskId, onClose }: { taskId: string | null; onClose: () => void }) {
  return (
    <Sheet open={!!taskId} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-xl" showCloseButton={false}>
        <SheetHeader className="flex-row items-center justify-between border-b py-2.5">
          <SheetTitle className="sr-only">Task details</SheetTitle>
          {taskId && (
            <Link
              to={`/tasks/${taskId}`}
              onClick={onClose}
              className={buttonVariants({
                variant: "ghost",
                size: "sm",
                className: "text-muted-foreground"
              })}>Open full page <Icon name="arrow" data-icon="inline-end" />
            </Link>
          )}
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close task">
            <Icon name="x" />
          </Button>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6">
          {taskId && (
            <ErrorBoundary resetKey={taskId}>
              <TaskDetail taskId={taskId} onDeleted={onClose} />
            </ErrorBoundary>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** A titled block inside the task detail. */
function DetailSection({ title, action, children }: { title: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <Separator />
      <div className="flex items-center justify-between gap-2 pt-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

/** One label/value row in the task's property grid. */
function Prop({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="pt-1.5 text-sm text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 flex-wrap items-center gap-2">{children}</dd>
    </>
  );
}

const None = ({ children }: { children: ReactNode }) => <p className="text-sm text-muted-foreground">{children}</p>;

/** Sizes a one-row text area to its content. */
function autoGrow(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
}

/**
 * Ref for a growing text area: sizes it now, and again whenever its width changes (rotation,
 * split screen) or a web font finishes loading (text measured in the fallback font can wrap
 * differently once the real font arrives).
 */
function autoGrowRef(el: HTMLTextAreaElement | null) {
  if (!el) return;
  autoGrow(el);
  const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
  const onFonts = () => el.isConnected && autoGrow(el);
  fonts?.addEventListener('loadingdone', onFonts);
  fonts?.ready.then(onFonts);
  let observer: ResizeObserver | undefined;
  if (typeof ResizeObserver !== 'undefined') {
    let width = el.clientWidth;
    observer = new ResizeObserver(() => {
      if (el.clientWidth === width) return; // our own height change also triggers this
      width = el.clientWidth;
      autoGrow(el);
    });
    observer.observe(el);
  }
  return () => {
    observer?.disconnect();
    fonts?.removeEventListener('loadingdone', onFonts);
  };
}

interface TaskFull extends Task {
  checklist_items?: never;
  checklist: any;
  comments: { id: string; user_id: string; user_name: string; user_color: string; body: string; created_at: string }[];
  collaborators: { id: string; name: string; color: string }[];
  subtask_list: Task[];
  depends_on: { id: string; title: string; status: string }[];
  blocking: { id: string; title: string; status: string }[];
  activity: { id: string; actor_name: string; summary: string; created_at: string }[];
  source_message: { id: string; channel_id: string; body: string; channel_name: string; kind: string } | null;
  meeting: { id: string; title: string; starts_at: string } | null;
  milestones: { id: string; name: string }[];
  files: { id: string; name: string; external_url: string | null; mime: string | null; size: number | null }[];
  can_edit: boolean;
  creator: { id: string; name: string } | null;
}

export function TaskDetail({ taskId, onDeleted }: { taskId: string; onDeleted?: () => void }) {
  const { me } = useSession();
  const people = usePeople();
  const { has: planHas } = usePlan();
  const act = useAction();
  const confirm = useConfirm();
  const { data: task, error, reload, setData } = useApi<TaskFull>(`/tasks/${taskId}`);
  const { data: teams } = useApi<{ id: string; name: string }[]>('/teams');
  const [newItem, setNewItem] = useState('');
  const [comment, setComment] = useState('');
  const [editingDesc, setEditingDesc] = useState(false);
  const [desc, setDesc] = useState('');
  const [addingSub, setAddingSub] = useState(false);
  const [depQuery, setDepQuery] = useState('');
  const [depOptions, setDepOptions] = useState<{ id: string; title: string; status: string }[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);

  useRealtime((e) => {
    if (e.type === 'task.updated' && e.taskId === taskId && !e.deleted) reload();
  });
  // Seeing the task (in the drawer or on its page) reads its notifications, and comments on it don't notify while it is open.
  useViewing([`/tasks/${taskId}`]);
  useEffect(() => {
    void api.post('/notifications/read-group', { group: `/tasks/${taskId}` }).catch(() => {});
  }, [taskId]);

  useEffect(() => {
    if (depQuery.length < 2) return setDepOptions([]);
    const t = window.setTimeout(async () => setDepOptions(await api.get(`/tasks-lookup${qs({ q: depQuery })}`)), 200);
    return () => window.clearTimeout(t);
  }, [depQuery]);

  if (error) return <ErrorState error={error} retry={reload} />;
  if (!task) return <Loading />;

  const update = async (patch: Record<string, unknown>) => {
    const updated = await act(() => api.patch<Task>(`/tasks/${task.id}`, patch));
    if (!updated) return;
    // The response is the list shape, where checklist and subtasks are counts; keep the detail's lists, then refetch them.
    const { checklist: _checklist, subtasks: _subtasks, ...fields } = updated;
    setData({ ...task, ...fields });
    reload();
  };
  const disabled = !task.can_edit;
  // Start dates feed the timeline, a planning feature; existing ones stay visible.
  const showStart = planHas('planning') || !!task.start_date;

  return (
    <div className="task-detail flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {task.project ? (
          <Link to={`/projects/${task.project.id}`} className="inline-flex items-center gap-1.5 text-muted-foreground hover:text-foreground">
            <span className="size-2 rounded-full" style={{ background: `var(--c-${task.project.color})` }} /> {task.project.name}
          </Link>
        ) : (
          <span className="text-muted-foreground">Personal task</span>
        )}
        {task.recurrence && (
          <Pill>
            <Icon name="repeat" /> {repeatLabel(task.recurrence, task.recurrence_until)}
          </Pill>
        )}
      </div>
      {/* A text area that grows with the title, so long titles are readable on a phone. */}
      <Textarea
        className="min-h-0 resize-none rounded-lg border-0 bg-transparent px-1 py-0.5 font-heading text-xl font-semibold shadow-none hover:bg-muted/60 md:text-xl dark:bg-transparent"
        rows={1}
        defaultValue={task.title}
        key={task.title}
        disabled={disabled}
        aria-label="Task title"
        ref={autoGrowRef}
        onInput={(e) => autoGrow(e.currentTarget)}
        onBlur={(e) => {
          const value = e.target.value.replace(/\s+/g, ' ').trim();
          if (value && value !== task.title) update({ title: value });
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault();
            e.currentTarget.blur();
          }
        }}
      />

      <ChoiceChips
        aria-label="Status"
        value={task.status}
        disabled={disabled}
        onChange={(status) => update({ status })}
        options={(['todo', 'in_progress', 'blocked', 'review', 'done'] as const).map((s) => ({ value: s, label: STATUS_LABEL[s], tone: STATUS_TONE[s] }))}
      />
      {task.status === 'blocked' && (
        <Input
          placeholder="What is blocking this? (visible to the team)"
          defaultValue={task.blocked_reason}
          disabled={disabled}
          aria-label="What is blocking this task"
          onBlur={(e) => e.target.value !== task.blocked_reason && update({ blockedReason: e.target.value })}
        />
      )}
      {task.waiting_on > 0 && (
        <Callout tone="warning">
          Waiting on {task.waiting_on} unfinished prerequisite task{task.waiting_on > 1 ? 's' : ''}.
        </Callout>
      )}

      <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] items-start gap-x-3 gap-y-2.5">
        <Prop label="Owner">
          <NativeSelect className="w-full" value={task.owner?.id ?? ''} disabled={disabled} onChange={(e) => update({ ownerId: e.target.value || null })} aria-label="Owner">
            <NativeSelectOption value="">Unassigned</NativeSelectOption>
            {people.map((p) => (
              <NativeSelectOption key={p.id} value={p.id}>
                {p.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Prop>
        <Prop label="Team">
          <NativeSelect className="w-full" value={task.team?.id ?? ''} disabled={disabled} onChange={(e) => update({ teamId: e.target.value || null })} aria-label="Team">
            <NativeSelectOption value="">No team</NativeSelectOption>
            {(teams ?? []).map((t) => (
              <NativeSelectOption key={t.id} value={t.id}>
                {t.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          {task.team && !task.owner && !disabled && (
            // Given to the team and nobody has it yet: anyone on the team can take it.
            <Button size="sm" variant="outline" className="shrink-0" onClick={() => update({ ownerId: me!.user.id })}>
              Take it
            </Button>
          )}
        </Prop>
        <Prop label="Due">
          <DatePicker value={task.due_date} disabled={disabled} onChange={(v) => update({ dueDate: v })} aria-label="Due date" placeholder="No due date" />
          {task.overdue && <Pill tone="danger">Overdue</Pill>}
        </Prop>
        {showStart && (
          <Prop label="Start">
            <DatePicker
              value={task.start_date}
              max={task.due_date ?? undefined}
              disabled={disabled || !planHas('planning')}
              onChange={(v) => update({ startDate: v })}
              aria-label="Start date"
              placeholder="No start date"
            />
          </Prop>
        )}
        <Prop label="Estimate">
          <InputGroup className="w-32">
            <InputGroupInput
              type="number"
              min={0}
              max={1000}
              step={0.5}
              defaultValue={task.estimate_hours ?? ''}
              key={`est-${task.estimate_hours}`}
              disabled={disabled}
              placeholder="0"
              aria-label="Estimate in hours"
              onBlur={(e) => {
                const v = e.target.value === '' ? null : Number(e.target.value);
                if (v !== task.estimate_hours && (v === null || (v >= 0 && v <= 1000))) update({ estimateHours: v });
              }}
            />
            <InputGroupAddon align="inline-end">
              <InputGroupText>hours</InputGroupText>
            </InputGroupAddon>
          </InputGroup>
        </Prop>
        <Prop label="Priority">
          <NativeSelect className="w-full" value={task.priority} disabled={disabled} onChange={(e) => update({ priority: e.target.value })} aria-label="Priority">
            <NativeSelectOption value="low">Low</NativeSelectOption>
            <NativeSelectOption value="medium">Medium</NativeSelectOption>
            <NativeSelectOption value="high">High</NativeSelectOption>
            <NativeSelectOption value="urgent">Urgent</NativeSelectOption>
          </NativeSelect>
        </Prop>
        <Prop label="Reviewer">
          <NativeSelect className="w-full" value={task.reviewer?.id ?? ''} disabled={disabled} onChange={(e) => update({ reviewerId: e.target.value || null })} aria-label="Reviewer">
            <NativeSelectOption value="">None</NativeSelectOption>
            {people
              .filter((p) => p.id !== task.owner?.id)
              .map((p) => (
                <NativeSelectOption key={p.id} value={p.id}>
                  {p.name}
                </NativeSelectOption>
              ))}
          </NativeSelect>
        </Prop>
        {task.milestones.length > 0 && (
          <Prop label="Milestone">
            <NativeSelect className="w-full" value={task.milestone_id ?? ''} disabled={disabled} onChange={(e) => update({ milestoneId: e.target.value || null })} aria-label="Milestone">
              <NativeSelectOption value="">None</NativeSelectOption>
              {task.milestones.map((m) => (
                <NativeSelectOption key={m.id} value={m.id}>
                  {m.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Prop>
        )}
        <Prop label="Labels">
          <LabelPicker taskId={task.id} value={task.labels ?? []} disabled={disabled} onChange={(labels) => setData({ ...task, labels })} />
        </Prop>
        <TaskFieldRows taskId={task.id} projectId={task.project?.id} values={task.fields ?? {}} disabled={disabled} onChange={(fields) => setData({ ...task, fields })} />
        <Prop label="Repeats">
          <div className="flex w-full flex-col gap-2">
            <NativeSelect
              className="w-full"
              value={task.recurrence ?? ''}
              disabled={disabled}
              aria-label="Repeats"
              onChange={(e) =>
                update(
                  e.target.value
                    ? // A repeating task needs a first day: today, unless it has one.
                      { recurrence: e.target.value, ...(task.due_date ? {} : { dueDate: localToday() }) }
                    : { recurrence: null },
                )
              }
            >
              <NativeSelectOption value="">Doesn’t repeat</NativeSelectOption>
              {REPEAT_OPTIONS.map((o) => (
                <NativeSelectOption key={o.value} value={o.value}>
                  {o.label}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            {task.recurrence && (
              <NativeSelect
                className="w-full"
                value={task.recurrence_until ? 'on' : 'never'}
                disabled={disabled}
                aria-label="When it stops repeating"
                onChange={(e) => update({ recurrenceUntil: e.target.value === 'on' ? defaultUntil(task.due_date) : null })}
              >
                <NativeSelectOption value="never">Never ends</NativeSelectOption>
                <NativeSelectOption value="on">Ends on a date</NativeSelectOption>
              </NativeSelect>
            )}
            {task.recurrence && task.recurrence_until && (
              <DatePicker value={task.recurrence_until} min={task.due_date ?? undefined} clearable={false} disabled={disabled} aria-label="Last day it repeats" onChange={(v) => v && update({ recurrenceUntil: v })} />
            )}
          </div>
        </Prop>
      </dl>
      <div className="flex flex-wrap items-center gap-2">
        <RemindButton taskId={task.id} />
      </div>

      {(task.source_message || task.meeting) && (
        <ItemGroup className="gap-2">
          {task.source_message && (
            <Item variant="muted" size="sm" render={<Link to={`/channels/${task.source_message.channel_id}?message=${task.source_message.id}`} />}>
              <ItemMedia variant="icon">
                <Icon name="chat" />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>From a message in {task.source_message.kind === 'dm' ? 'a direct message' : `#${task.source_message.channel_name}`}</ItemTitle>
              </ItemContent>
            </Item>
          )}
          {task.meeting && (
            <Item variant="muted" size="sm" render={<Link to={`/meetings/${task.meeting.id}`} />}>
              <ItemMedia variant="icon">
                <Icon name="video" />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>Follow-up from {task.meeting.title}</ItemTitle>
              </ItemContent>
            </Item>
          )}
        </ItemGroup>
      )}

      <DetailSection
        title="Description"
        action={
          !disabled &&
          !editingDesc && (
            <Button
              variant="ghost"
              size="xs"
              onClick={() => {
                setDesc(task.description);
                setEditingDesc(true);
              }}
            >
              <Icon name="edit" data-icon="inline-start" /> Edit
            </Button>
          )
        }
      >
        {editingDesc ? (
          <div className="flex flex-col gap-2">
            <Textarea rows={6} value={desc} onChange={(e) => setDesc(e.target.value)} autoFocus aria-label="Description" />
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setEditingDesc(false)}>
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={async () => {
                  await update({ description: desc });
                  setEditingDesc(false);
                }}
              >
                Save
              </Button>
            </div>
          </div>
        ) : task.description ? (
          <Markdown text={task.description} />
        ) : (
          <None>No description.</None>
        )}
      </DetailSection>

      <DetailSection title={`Checklist ${task.checklist.length ? `${task.checklist.filter((c: any) => c.done).length}/${task.checklist.length}` : ''}`}>
        {task.checklist.length > 0 && (
          <ul className="flex flex-col gap-1">
            {task.checklist.map((item: { id: string; text: string; done: number }) => (
              <li key={item.id} className="group flex items-center gap-2.5 rounded-lg px-1 py-1 hover:bg-muted/60">
                <Checkbox
                  id={`check-${item.id}`}
                  checked={!!item.done}
                  disabled={disabled}
                  onCheckedChange={async (checked) => {
                    await act(() => api.patch(`/checklist/${item.id}`, { done: checked }));
                    reload();
                  }}
                />
                <Label htmlFor={`check-${item.id}`} className={cn('flex-1 font-normal', item.done && 'text-muted-foreground line-through')}>
                  {item.text}
                </Label>
                {!disabled && (
                  <IconButton
                    label={`Remove ${item.text}`}
                    size="icon-xs"
                    tooltip={false}
                    className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                    onClick={async () => {
                      await act(() => api.del(`/checklist/${item.id}`));
                      reload();
                    }}
                  >
                    <Icon name="x" />
                  </IconButton>
                )}
              </li>
            ))}
          </ul>
        )}
        {!disabled && (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (!newItem.trim()) return;
              await act(() => api.post(`/tasks/${task.id}/checklist`, { text: newItem }));
              setNewItem('');
              reload();
            }}
          >
            <Input value={newItem} onChange={(e) => setNewItem(e.target.value)} placeholder="Add a checklist item" aria-label="New checklist item" />
          </form>
        )}
      </DetailSection>

      {!task.parent_id && (
        <DetailSection
          title="Subtasks"
          action={
            !disabled && (
              <Button variant="ghost" size="xs" onClick={() => setAddingSub((v) => !v)}>
                {addingSub ? 'Cancel' : (
                  <>
                    <Icon name="plus" data-icon="inline-start" /> Add
                  </>
                )}
              </Button>
            )
          }
        >
          {task.subtask_list.map((s) => (
            <Link key={s.id} to={`/tasks/${s.id}`} className="flex items-center gap-2 rounded-lg px-1 py-1.5 text-sm hover:bg-muted/60">
              <StatusPill status={s.status} />
              <span className="min-w-0 flex-1 truncate">{s.title}</span>
              {s.owner && <Avatar user={s.owner} size="xs" />}
            </Link>
          ))}
          {!task.subtask_list.length && !addingSub && <None>No subtasks.</None>}
          {addingSub && (
            <Card size="sm">
              <CardContent>
                <NewTaskForm
                  projectId={task.project?.id}
                  defaults={{ parentId: task.id, ownerId: task.owner?.id }}
                  onDone={() => {
                    setAddingSub(false);
                    reload();
                  }}
                />
              </CardContent>
            </Card>
          )}
        </DetailSection>
      )}

      <DetailSection title="Dependencies">
        {task.depends_on.map((d) => (
          <div key={d.id} className="flex items-center gap-2 text-sm">
            <span className="text-xs text-muted-foreground">Waits on</span>
            <Link to={`/tasks/${d.id}`} className="min-w-0 flex-1 truncate hover:underline">
              {d.title}
            </Link>
            <StatusPill status={d.status} />
            {!disabled && (
              <IconButton
                label="Remove dependency"
                size="icon-xs"
                onClick={async () => {
                  await act(() => api.del(`/tasks/${task.id}/dependencies/${d.id}`));
                  reload();
                }}
              >
                <Icon name="x" />
              </IconButton>
            )}
          </div>
        ))}
        {task.blocking.map((d) => (
          <div key={d.id} className="flex items-center gap-2 text-sm">
            <span className="text-xs text-muted-foreground">Blocks</span>
            <Link to={`/tasks/${d.id}`} className="min-w-0 flex-1 truncate hover:underline">
              {d.title}
            </Link>
            <StatusPill status={d.status} />
          </div>
        ))}
        {!disabled && (
          <div className="flex flex-col gap-1">
            <InputGroup>
              <InputGroupAddon>
                <Icon name="search" />
              </InputGroupAddon>
              <InputGroupInput value={depQuery} onChange={(e) => setDepQuery(e.target.value)} placeholder="This task waits on… (search tasks)" aria-label="Add dependency" />
            </InputGroup>
            {depOptions.length > 0 && (
              <div className="flex flex-col rounded-xl border bg-popover p-1 shadow-md">
                {depOptions
                  .filter((o) => o.id !== task.id)
                  .map((o) => (
                    <Button
                      key={o.id}
                      variant="ghost"
                      className="justify-between font-normal"
                      onClick={async () => {
                        await act(() => api.post(`/tasks/${task.id}/dependencies`, { dependsOnId: o.id }));
                        setDepQuery('');
                        reload();
                      }}
                    >
                      <span className="truncate">{o.title}</span> <StatusPill status={o.status} />
                    </Button>
                  ))}
              </div>
            )}
          </div>
        )}
      </DetailSection>

      <TimeTracker taskId={task.id} estimateHours={task.estimate_hours} canLog={!disabled} />

      <DetailSection
        title="Attachments"
        action={
          !disabled && (
            <Button variant="ghost" size="xs" onClick={() => fileInput.current?.click()}>
              <Icon name="upload" data-icon="inline-start" /> Upload
            </Button>
          )
        }
      >
        <input
          ref={fileInput}
          type="file"
          hidden
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            const form = new FormData();
            form.append('file', file);
            form.append('taskId', task.id);
            await act(() => api.upload('/files', form), 'File attached');
            e.target.value = '';
            reload();
          }}
        />
        {task.files.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {task.files.map((f) => (
              <Link
                to={`/files/${f.id}`}
                key={f.id}
                className={buttonVariants({
                  variant: "outline",
                  size: "sm",
                  className: "max-w-full"
                })}>
                <Icon name={f.external_url ? 'link' : 'file'} data-icon="inline-start" />
                <span className="truncate">{f.name}</span>
                <span className="text-xs text-muted-foreground">{bytes(f.size)}</span>
              </Link>
            ))}
          </div>
        )}
        {!task.files.length && <None>No attachments.</None>}
      </DetailSection>

      <DetailSection title="Comments">
        {task.comments.map((c) => (
          <div key={c.id} className="flex gap-2.5">
            <Avatar user={{ id: c.user_id, name: c.user_name, color: c.user_color }} size="sm" />
            <div className="min-w-0 flex-1 text-sm">
              <div className="flex items-baseline gap-2">
                <strong className="font-semibold">{c.user_name}</strong> <span className="text-xs text-muted-foreground">{timeAgo(c.created_at)}</span>
              </div>
              <Markdown text={c.body} compact />
            </div>
          </div>
        ))}
        <form
          className="flex items-center gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!comment.trim()) return;
            await act(() => api.post(`/tasks/${task.id}/comments`, { body: comment }));
            setComment('');
            reload();
          }}
        >
          <Avatar user={me!.user} size="sm" />
          <Input className="flex-1" value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Write a comment…" aria-label="Comment" />
          <Button variant="outline" size="sm" disabled={!comment.trim()} type="submit">
            Post
          </Button>
        </form>
      </DetailSection>

      <DetailSection title="Activity">
        <ol className="relative flex flex-col gap-2 border-l pl-4 text-sm">
          {task.activity.map((a) => (
            <li key={a.id} className="relative before:absolute before:top-2 before:-left-[1.3rem] before:size-2 before:rounded-full before:bg-border">
              <strong className="font-medium">{a.actor_name}</strong> {a.summary} <span className="text-xs text-muted-foreground">{timeAgo(a.created_at)}</span>
            </li>
          ))}
          <li className="relative before:absolute before:top-2 before:-left-[1.3rem] before:size-2 before:rounded-full before:bg-border">
            <strong className="font-medium">{task.creator?.name}</strong> created this task <span className="text-xs text-muted-foreground">{timeAgo(task.created_at)}</span>
          </li>
        </ol>
      </DetailSection>

      {!disabled && (task.created_by === me!.user.id || task.owner?.id === me!.user.id || me!.role === 'admin' || me!.role === 'owner') && (
        <>
          <Separator />
          <Button
            variant="destructive"
            className="self-start"
            onClick={async () => {
              if (!(await confirm({ title: 'Delete this task?', description: 'This cannot be undone.', confirmLabel: 'Delete task', destructive: true }))) return;
              const ok = await act(() => api.del(`/tasks/${task.id}`), 'Task deleted');
              if (ok) onDeleted?.();
            }}
          >
            <Icon name="trash" data-icon="inline-start" /> Delete task
          </Button>
        </>
      )}
    </div>
  );
}

/** Compact task row used in lists across the app. */
export function TaskRow({
  task,
  onOpen,
  onToggle,
  showProject = true,
  selection,
}: {
  task: Task;
  onOpen: () => void;
  onToggle?: (done: boolean) => void | Promise<unknown>;
  showProject?: boolean;
  /** Choosing several tasks to act on at once: the box selects instead of completing, and so does clicking the row. */
  selection?: { selected: boolean; onChange: (selected: boolean) => void };
}) {
  // Ticked at once; the list's own data takes over again when the server has answered.
  const [pending, setPending] = useState<boolean | null>(null);
  const done = pending ?? task.status === 'done';
  return (
    <div className={cn('task group/task flex items-center gap-3 rounded-xl px-2 py-2 transition-colors hover:bg-muted/60', done && 'is-done', selection?.selected && 'bg-accent/70 hover:bg-accent')}>
      {selection ? (
        <Checkbox checked={selection.selected} onCheckedChange={(v) => selection.onChange(!!v)} aria-label={`Select ${task.title}`} />
      ) : (
      <Checkbox
        checked={done}
        onCheckedChange={async (checked) => {
          setPending(checked);
          try {
            await onToggle?.(checked);
          } finally {
            setPending(null);
          }
        }}
        aria-label={`Mark ${task.title} ${done ? 'not done' : 'done'}`}
        disabled={!onToggle}
      />
      )}
      <button
        className="task-body flex min-w-0 flex-1 flex-col items-start gap-1 text-left outline-none focus-visible:underline"
        onClick={selection ? () => selection.onChange(!selection.selected) : onOpen}
      >
        <strong className={cn('text-sm font-medium', done && 'text-muted-foreground line-through')}>{task.title}</strong>
        <span className="flex max-w-full flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          {showProject &&
            (task.project ? (
              <span className="inline-flex min-w-0 items-center gap-1.5">
                <span className="size-2 shrink-0 rounded-full" style={{ background: `var(--c-${task.project.color})` }} />
                <span className="truncate">{task.project.name}</span>
              </span>
            ) : task.team ? null : (
              'Personal'
            ))}
          {task.status !== 'todo' && task.status !== 'done' && <StatusPill status={task.status} />}
          <LabelChips labels={task.labels} />
          <PriorityPill priority={task.priority} />
          {task.recurrence && (
            <span className="inline-flex items-center gap-1" title={repeatLabel(task.recurrence, task.recurrence_until)}>
              <Icon name="repeat" size={12} /> {shortRepeat(task.recurrence)}
              <span className="sr-only">, {repeatLabel(task.recurrence, task.recurrence_until)}</span>
            </span>
          )}
          {task.checklist.total > 0 && (
            <span className="inline-flex items-center gap-1">
              <Icon name="check" size={12} /> {task.checklist.done}/{task.checklist.total}
            </span>
          )}
          {task.comment_count > 0 && (
            <span className="inline-flex items-center gap-1">
              <Icon name="chat" size={12} /> {task.comment_count}
            </span>
          )}
          {task.status === 'blocked' && task.blocked_reason && <span>— {plainMentions(task.blocked_reason)}</span>}
        </span>
      </button>
      <span className="flex shrink-0 items-center gap-2">
        {task.due_date && <DueLabel due={task.due_date} overdue={task.overdue} />}
        {/* Given to a team and nobody has it yet: show the team instead of an empty avatar. */}
        {!task.owner && task.team ? (
          <Pill className="max-w-28 truncate" title={`${task.team.name} — anyone on the team can pick it up`}>
            <Icon name="users" size={12} /> {task.team.name}
          </Pill>
        ) : (
          <Avatar user={task.owner} size="sm" />
        )}
      </span>
    </div>
  );
}

/** "Today", "Tomorrow", "Oct 14"… coloured when it is today or overdue. */
export function DueLabel({ due, overdue }: { due: string; overdue?: boolean }) {
  const label = dueLabel(due);
  return <span className={cn('text-xs font-medium whitespace-nowrap', overdue ? 'text-destructive' : label === 'Today' ? 'text-primary' : 'text-muted-foreground')}>{label}</span>;
}
