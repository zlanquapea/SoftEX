import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, View } from 'react-native';
import { api, formWith, qs, type Task } from '@/lib/api';
import { pickDocuments, pickMedia } from '@/lib/files';
import { bytes, STATUS_LABEL, timeAgo } from '@/lib/format';
import { useApi, useRealtime } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { swatch, useTheme } from '@/lib/theme';
import { NewTaskForm, PRIORITIES } from '@/ui/create';
import { Icon } from '@/ui/Icon';
import {
  ActionSheet,
  Avatar,
  Button,
  Card,
  Checkbox,
  confirm,
  ErrorState,
  IconButton,
  Input,
  LinkText,
  ListRow,
  Loading,
  Muted,
  Pill,
  Row,
  Screen,
  SearchBox,
  Select,
  Sheet,
  StatusPill,
  STATUS_TONE,
  T,
  useAction,
} from '@/ui/kit';
import { Markdown } from '@/ui/Markdown';
import { DateField, PeopleField } from '@/ui/pickers';
import { usePlan } from '@/ui/plan';
import { LabelPicker, Prop, RemindButton, TaskFieldRows, TimeTracker } from '@/ui/work';

interface TaskFull extends Task {
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

export default function TaskScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <TaskDetail key={id} taskId={id} onDeleted={() => router.back()} />;
}

function TaskDetail({ taskId, onDeleted }: { taskId: string; onDeleted?: () => void }) {
  const { c } = useTheme();
  const { people, me } = useSession();
  const { has: planHas } = usePlan();
  const act = useAction();
  const { data: task, error, reload, refresh, refreshing, setData } = useApi<TaskFull>(`/tasks/${taskId}`);
  const [title, setTitle] = useState('');
  const [blockedReason, setBlockedReason] = useState('');
  const [estimate, setEstimate] = useState('');
  const [newItem, setNewItem] = useState('');
  const [comment, setComment] = useState('');
  const [editingDesc, setEditingDesc] = useState(false);
  const [desc, setDesc] = useState('');
  const [addingSub, setAddingSub] = useState(false);
  const [depOpen, setDepOpen] = useState(false);
  const [depQuery, setDepQuery] = useState('');
  const [depOptions, setDepOptions] = useState<{ id: string; title: string; status: string }[]>([]);
  const [attach, setAttach] = useState(false);

  useRealtime((e) => {
    if (e.type === 'task.updated' && e.taskId === taskId && !e.deleted) reload();
  });

  useEffect(() => {
    if (!task) return;
    setTitle(task.title);
    setBlockedReason(task.blocked_reason);
    setEstimate(task.estimate_hours == null ? '' : String(task.estimate_hours));
  }, [task?.title, task?.blocked_reason, task?.estimate_hours]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (depQuery.length < 2) return setDepOptions([]);
    const t = setTimeout(async () => setDepOptions(await api.get(`/tasks-lookup${qs({ q: depQuery })}`)), 200);
    return () => clearTimeout(t);
  }, [depQuery]);

  if (error && !task) return <ErrorState error={error} retry={reload} />;
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
  const showStart = planHas('planning') || !!task.start_date;
  const canDelete = !disabled && (task.created_by === me!.user.id || task.owner?.id === me!.user.id || me!.role === 'admin' || me!.role === 'owner');
  const upload = async (files: { uri: string; name: string; type: string; file?: Blob }[]) => {
    for (const f of files) await act(() => api.upload('/files', formWith({ file: f, taskId: task.id })), 'File attached');
    reload();
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={90}>
      <Stack.Screen
        options={{
          title: task.project?.name ?? 'Task',
          headerRight: () =>
            canDelete ? (
              <IconButton
                name="trash"
                label="Delete task"
                color={c.red}
                onPress={async () => {
                  if (!(await confirm('Delete this task?', 'This cannot be undone.', 'Delete'))) return;
                  const ok = await act(() => api.del(`/tasks/${task.id}`), 'Task deleted');
                  if (ok) onDeleted?.();
                }}
              />
            ) : null,
        }}
      />
      <Screen refreshing={refreshing} onRefresh={refresh}>
        <Row wrap gap={8}>
          {task.project ? (
            <Pressable onPress={() => router.push(`/projects/${task.project!.id}`)} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }} accessibilityRole="link">
              <View style={{ width: 9, height: 9, borderRadius: 3, backgroundColor: swatch(task.project.color) }} />
              <T size={13} weight="semibold" tone="ink2">
                {task.project.name}
              </T>
            </Pressable>
          ) : (
            <Muted>Personal task</Muted>
          )}
          {task.recurrence && <Pill icon="refresh" label={`Repeats ${task.recurrence}`} />}
          {task.overdue && <Pill label="Overdue" tone="red" />}
        </Row>
        <Input
          value={title}
          onChangeText={setTitle}
          editable={!disabled}
          multiline
          accessibilityLabel="Task title"
          onBlur={() => title.trim() && title !== task.title && update({ title: title.trim() })}
          style={{ fontSize: 22, fontFamily: 'Manrope_700Bold', borderWidth: 0, backgroundColor: 'transparent', paddingHorizontal: 0, minHeight: 0 }}
        />

        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }} accessibilityRole="radiogroup" accessibilityLabel="Status">
          {(['todo', 'in_progress', 'blocked', 'review', 'done'] as const).map((s) => {
            const on = task.status === s;
            const tone = STATUS_TONE[s];
            const bg = on ? { neutral: c.line2, blue: c.blueSoft, red: c.redSoft, amber: c.amberSoft, green: c.greenSoft }[tone] : c.surface;
            const fg = on ? { neutral: c.ink, blue: c.blueInk, red: c.red, amber: c.amberInk, green: c.green }[tone] : c.muted;
            return (
              <Pressable
                key={s}
                disabled={disabled}
                onPress={() => update({ status: s })}
                accessibilityRole="radio"
                accessibilityState={{ checked: on, disabled }}
                style={{ paddingHorizontal: 12, height: 34, justifyContent: 'center', borderRadius: 17, backgroundColor: bg, borderWidth: 1, borderColor: on ? fg : c.line }}
              >
                <T size={13} weight="bold" style={{ color: fg }}>
                  {STATUS_LABEL[s]}
                </T>
              </Pressable>
            );
          })}
        </View>
        {task.status === 'blocked' && (
          <Input
            value={blockedReason}
            onChangeText={setBlockedReason}
            editable={!disabled}
            placeholder="What is blocking this? (visible to the team)"
            onBlur={() => blockedReason !== task.blocked_reason && update({ blockedReason })}
          />
        )}
        {task.waiting_on > 0 && (
          <Row gap={8} style={{ padding: 12, borderRadius: 11, backgroundColor: c.amberSoft }}>
            <Icon name="alert" size={15} color={c.amberInk} />
            <T size={14} tone="amber" style={{ flex: 1 }}>
              Waiting on {task.waiting_on} unfinished prerequisite task{task.waiting_on > 1 ? 's' : ''}.
            </T>
          </Row>
        )}

        <Card style={{ gap: 14 }}>
          <Prop label="Owner">
            <PeopleField disabled={disabled} multiple={false} title="Owner" allowNone="Unassigned" placeholder="Unassigned" value={task.owner ? [task.owner.id] : []} onChange={(ids) => update({ ownerId: ids[0] ?? null })} />
          </Prop>
          <Row gap={10}>
            <View style={{ flex: 1 }}>
              <Prop label="Due">
                <DateField disabled={disabled} value={task.due_date} onChange={(v) => update({ dueDate: v })} label="Due date" />
              </Prop>
            </View>
            {showStart && (
              <View style={{ flex: 1 }}>
                <Prop label="Start">
                  <DateField disabled={disabled || !planHas('planning')} value={task.start_date} onChange={(v) => update({ startDate: v })} label="Start date" />
                </Prop>
              </View>
            )}
          </Row>
          <Row gap={10}>
            <View style={{ flex: 1 }}>
              <Prop label="Priority">
                <Select title="Priority" disabled={disabled} value={task.priority} onChange={(v) => update({ priority: v })} options={PRIORITIES.map((p) => ({ ...p }))} />
              </Prop>
            </View>
            <View style={{ flex: 1 }}>
              <Prop label="Estimate (hours)">
                <Input
                  value={estimate}
                  onChangeText={setEstimate}
                  editable={!disabled}
                  keyboardType="decimal-pad"
                  placeholder="0"
                  accessibilityLabel="Estimate in hours"
                  onBlur={() => {
                    const v = estimate === '' ? null : Number(estimate);
                    if (v !== task.estimate_hours && (v === null || (v >= 0 && v <= 1000))) update({ estimateHours: v });
                  }}
                />
              </Prop>
            </View>
          </Row>
          <Prop label="Reviewer">
            <PeopleField
              disabled={disabled}
              multiple={false}
              title="Reviewer"
              allowNone="None"
              placeholder="None"
              value={task.reviewer ? [task.reviewer.id] : []}
              people={people.filter((p) => p.id !== task.owner?.id)}
              onChange={(ids) => update({ reviewerId: ids[0] ?? null })}
            />
          </Prop>
          {task.milestones.length > 0 && (
            <Prop label="Milestone">
              <Select
                title="Milestone"
                disabled={disabled}
                value={task.milestone_id ?? ''}
                onChange={(v) => update({ milestoneId: v || null })}
                options={[{ id: '', label: 'None' }, ...task.milestones.map((m) => ({ id: m.id, label: m.name }))]}
              />
            </Prop>
          )}
          <Prop label="Labels">
            <LabelPicker taskId={task.id} value={task.labels ?? []} disabled={disabled} onChange={(labels) => setData({ ...task, labels })} />
          </Prop>
          <TaskFieldRows taskId={task.id} projectId={task.project?.id} values={task.fields ?? {}} disabled={disabled} onChange={(fields) => setData({ ...task, fields })} />
          <Prop label="Repeats">
            <Select
              title="Repeats"
              disabled={disabled}
              value={task.recurrence ?? ''}
              onChange={(v) => update({ recurrence: v || null })}
              options={[
                { id: '', label: 'Never' },
                { id: 'daily', label: 'Daily' },
                { id: 'weekly', label: 'Weekly' },
                { id: 'monthly', label: 'Monthly' },
              ]}
            />
          </Prop>
          <RemindButton taskId={task.id} />
        </Card>

        {(task.source_message || task.meeting) && (
          <Card padded={false} style={{ paddingHorizontal: 14 }}>
            {task.source_message && (
              <ListRow
                left={<Icon name="chat" size={17} color={c.ink2} />}
                title={`From a message in ${task.source_message.kind === 'dm' ? 'a direct message' : `#${task.source_message.channel_name}`}`}
                chevron
                onPress={() => router.push(`/channels/${task.source_message!.channel_id}?message=${task.source_message!.id}`)}
              />
            )}
            {task.meeting && <ListRow left={<Icon name="video" size={17} color={c.ink2} />} title={`Follow-up from ${task.meeting.title}`} chevron onPress={() => router.push(`/meetings/${task.meeting!.id}`)} />}
          </Card>
        )}

        <Card style={{ gap: 10 }}>
          <Row style={{ justifyContent: 'space-between' }}>
            <T size={16} weight="display">
              Description
            </T>
            {!disabled && !editingDesc && (
              <LinkText
                onPress={() => {
                  setDesc(task.description);
                  setEditingDesc(true);
                }}
              >
                Edit
              </LinkText>
            )}
          </Row>
          {editingDesc ? (
            <>
              <Input multiline value={desc} onChangeText={setDesc} autoFocus accessibilityLabel="Description" style={{ minHeight: 140 }} />
              <Row style={{ justifyContent: 'flex-end' }}>
                <Button small title="Cancel" onPress={() => setEditingDesc(false)} />
                <Button
                  small
                  variant="primary"
                  title="Save"
                  onPress={async () => {
                    await update({ description: desc });
                    setEditingDesc(false);
                  }}
                />
              </Row>
            </>
          ) : task.description ? (
            <Markdown text={task.description} />
          ) : (
            <Muted>No description.</Muted>
          )}
        </Card>

        <Card style={{ gap: 10 }}>
          <T size={16} weight="display">
            Checklist {task.checklist.length ? `${task.checklist.filter((i: { done: number }) => i.done).length}/${task.checklist.length}` : ''}
          </T>
          {task.checklist.map((item: { id: string; text: string; done: number }) => (
            <Row key={item.id} gap={8}>
              <View style={{ flex: 1 }}>
                <Checkbox
                  checked={!!item.done}
                  disabled={disabled}
                  onChange={async (v) => {
                    await act(() => api.patch(`/checklist/${item.id}`, { done: v }));
                    reload();
                  }}
                  label={
                    <T style={{ flex: 1, textDecorationLine: item.done ? 'line-through' : 'none', color: item.done ? c.muted : c.ink }} numberOfLines={3}>
                      {item.text}
                    </T>
                  }
                />
              </View>
              {!disabled && (
                <Pressable
                  hitSlop={10}
                  accessibilityLabel={`Remove ${item.text}`}
                  onPress={async () => {
                    await act(() => api.del(`/checklist/${item.id}`));
                    reload();
                  }}
                >
                  <Icon name="x" size={14} color={c.muted} />
                </Pressable>
              )}
            </Row>
          ))}
          {!disabled && (
            <Input
              value={newItem}
              onChangeText={setNewItem}
              placeholder="Add a checklist item"
              accessibilityLabel="New checklist item"
              returnKeyType="done"
              blurOnSubmit={false}
              onSubmitEditing={async () => {
                if (!newItem.trim()) return;
                await act(() => api.post(`/tasks/${task.id}/checklist`, { text: newItem }));
                setNewItem('');
                reload();
              }}
            />
          )}
        </Card>

        {!task.parent_id && (
          <Card style={{ gap: 6 }}>
            <Row style={{ justifyContent: 'space-between' }}>
              <T size={16} weight="display">
                Subtasks
              </T>
              {!disabled && <LinkText onPress={() => setAddingSub(true)}>Add</LinkText>}
            </Row>
            {task.subtask_list.map((s) => (
              <ListRow key={s.id} title={s.title} left={<StatusPill status={s.status} />} right={s.owner ? <Avatar user={s.owner} size="xs" /> : undefined} onPress={() => router.push(`/tasks/${s.id}`)} />
            ))}
            {!task.subtask_list.length && <Muted>No subtasks.</Muted>}
          </Card>
        )}

        <Card style={{ gap: 6 }}>
          <Row style={{ justifyContent: 'space-between' }}>
            <T size={16} weight="display">
              Dependencies
            </T>
            {!disabled && <LinkText onPress={() => setDepOpen(true)}>Add</LinkText>}
          </Row>
          {task.depends_on.map((d) => (
            <ListRow
              key={d.id}
              title={d.title}
              subtitle="Waits on"
              right={
                <Row>
                  <StatusPill status={d.status} />
                  {!disabled && (
                    <Pressable
                      hitSlop={10}
                      accessibilityLabel="Remove dependency"
                      onPress={async () => {
                        await act(() => api.del(`/tasks/${task.id}/dependencies/${d.id}`));
                        reload();
                      }}
                    >
                      <Icon name="x" size={14} color={c.muted} />
                    </Pressable>
                  )}
                </Row>
              }
              onPress={() => router.push(`/tasks/${d.id}`)}
            />
          ))}
          {task.blocking.map((d) => (
            <ListRow key={d.id} title={d.title} subtitle="Blocks" right={<StatusPill status={d.status} />} onPress={() => router.push(`/tasks/${d.id}`)} />
          ))}
          {!task.depends_on.length && !task.blocking.length && <Muted>No dependencies.</Muted>}
        </Card>

        <Card>
          <TimeTracker taskId={task.id} estimateHours={task.estimate_hours} canLog={!disabled} />
        </Card>

        <Card style={{ gap: 6 }}>
          <Row style={{ justifyContent: 'space-between' }}>
            <T size={16} weight="display">
              Attachments
            </T>
            {!disabled && <LinkText onPress={() => setAttach(true)}>Upload</LinkText>}
          </Row>
          {task.files.map((f) => (
            <ListRow key={f.id} left={<Icon name={f.external_url ? 'link' : 'file'} size={17} color={c.ink2} />} title={f.name} subtitle={bytes(f.size)} chevron onPress={() => router.push(`/files/${f.id}`)} />
          ))}
          {!task.files.length && <Muted>No attachments.</Muted>}
        </Card>

        <Card style={{ gap: 12 }}>
          <T size={16} weight="display">
            Comments
          </T>
          {task.comments.map((cm) => (
            <Row key={cm.id} gap={10} style={{ alignItems: 'flex-start' }}>
              <Avatar user={{ id: cm.user_id, name: cm.user_name, color: cm.user_color }} size="sm" />
              <View style={{ flex: 1, gap: 2 }}>
                <Row gap={6}>
                  <T size={14} weight="bold">
                    {cm.user_name}
                  </T>
                  <Muted size={12}>{timeAgo(cm.created_at)}</Muted>
                </Row>
                <Markdown text={cm.body} compact size={14} />
              </View>
            </Row>
          ))}
          <Row gap={8}>
            <Avatar user={me!.user} size="sm" />
            <Input value={comment} onChangeText={setComment} placeholder="Write a comment…" accessibilityLabel="Comment" style={{ flex: 1 }} multiline />
            <Button
              small
              title="Post"
              disabled={!comment.trim()}
              onPress={async () => {
                if (!comment.trim()) return;
                await act(() => api.post(`/tasks/${task.id}/comments`, { body: comment }));
                setComment('');
                reload();
              }}
            />
          </Row>
        </Card>

        <Card style={{ gap: 8 }}>
          <T size={16} weight="display">
            Activity
          </T>
          {task.activity.map((a) => (
            <T key={a.id} size={13} tone="ink2">
              <T size={13} weight="bold">
                {a.actor_name}
              </T>{' '}
              {a.summary} <T size={12} tone="muted">{timeAgo(a.created_at)}</T>
            </T>
          ))}
          <T size={13} tone="ink2">
            <T size={13} weight="bold">
              {task.creator?.name}
            </T>{' '}
            created this task <T size={12} tone="muted">{timeAgo(task.created_at)}</T>
          </T>
        </Card>
      </Screen>

      <Sheet open={addingSub} onClose={() => setAddingSub(false)} title="New subtask" full>
        <NewTaskForm
          projectId={task.project?.id}
          defaults={{ parentId: task.id, ownerId: task.owner?.id }}
          onDone={() => {
            setAddingSub(false);
            reload();
          }}
        />
      </Sheet>
      <Sheet open={depOpen} onClose={() => setDepOpen(false)} title="This task waits on…" full>
        <SearchBox value={depQuery} onChangeText={setDepQuery} placeholder="Search tasks" autoFocus />
        <View>
          {depOptions
            .filter((o) => o.id !== task.id)
            .map((o) => (
              <ListRow
                key={o.id}
                title={o.title}
                right={<StatusPill status={o.status} />}
                onPress={async () => {
                  await act(() => api.post(`/tasks/${task.id}/dependencies`, { dependsOnId: o.id }));
                  setDepQuery('');
                  setDepOpen(false);
                  reload();
                }}
              />
            ))}
          {depQuery.length >= 2 && !depOptions.length && <Muted>No matching tasks.</Muted>}
        </View>
      </Sheet>
      <ActionSheet
        open={attach}
        onClose={() => setAttach(false)}
        title="Attach"
        actions={[
          { label: 'Photo or video', icon: 'upload', onPress: () => act(async () => upload(await pickMedia('library', true))) },
          { label: 'Take a photo', icon: 'eye', onPress: () => act(async () => upload(await pickMedia('camera'))), hidden: Platform.OS === 'web' },
          { label: 'File', icon: 'file', onPress: () => act(async () => upload(await pickDocuments(true))) },
        ]}
      />
    </KeyboardAvoidingView>
  );
}
