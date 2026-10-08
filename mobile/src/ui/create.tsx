import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';
import { api, type Project, type Task } from '../lib/api';
import { useApi } from '../lib/hooks';
import { useSession } from '../lib/session';
import { SWATCH, useTheme } from '../lib/theme';
import { Icon } from './Icon';
import { Button, Field, Input, Muted, Row, Select, Sheet, T, Toggle, useAction } from './kit';
import { DateField, DateTimeField, PeopleField } from './pickers';

export type CreateKind = 'task' | 'project' | 'message' | 'meeting' | 'page';

const TITLES: Record<CreateKind, string> = {
  task: 'New task',
  project: 'New project',
  message: 'New message',
  meeting: 'Schedule a meeting',
  page: 'New knowledge page',
};

export function QuickCreate({ open, kind, onClose }: { open: boolean; kind?: CreateKind; onClose: () => void }) {
  const { c } = useTheme();
  const { me } = useSession();
  const [current, setCurrent] = useState<CreateKind | undefined>(kind);
  useEffect(() => setCurrent(kind), [kind, open]);
  const guest = me?.role === 'guest';
  const options: { id: CreateKind; icon: string; label: string; hint: string }[] = [
    { id: 'task', icon: 'check', label: 'Task', hint: 'Assign and track work' },
    ...(guest ? [] : [{ id: 'project' as CreateKind, icon: 'folder', label: 'Project', hint: 'Plan a team initiative' }]),
    { id: 'message', icon: 'send', label: 'Message', hint: 'Start a conversation' },
    { id: 'meeting', icon: 'video', label: 'Meeting', hint: 'Schedule with an agenda' },
    ...(guest ? [] : [{ id: 'page' as CreateKind, icon: 'book', label: 'Page', hint: 'Write shared knowledge' }]),
  ];
  return (
    <Sheet open={open} onClose={onClose} eyebrow="Quick create" title={current ? TITLES[current] : 'What would you like to start?'} full={!!current && current !== 'message'}>
      {!current && (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
          {options.map((o) => (
            <Pressable
              key={o.id}
              onPress={() => setCurrent(o.id)}
              accessibilityRole="button"
              style={({ pressed }) => ({ width: '47%', flexGrow: 1, padding: 14, borderRadius: 14, backgroundColor: pressed ? c.hover : c.surface, borderWidth: 1, borderColor: c.line, gap: 6 })}
            >
              <View style={{ width: 36, height: 36, borderRadius: 10, backgroundColor: c.accentSoft, alignItems: 'center', justifyContent: 'center' }}>
                <Icon name={o.icon} size={18} color={c.accentInk} />
              </View>
              <T weight="bold">{o.label}</T>
              <Muted size={12}>{o.hint}</Muted>
            </Pressable>
          ))}
        </View>
      )}
      {current === 'task' && <NewTaskForm onDone={(t) => (onClose(), t && router.push(`/tasks/${t.id}`))} />}
      {current === 'project' && <NewProjectForm onDone={onClose} />}
      {current === 'message' && <NewMessageForm onDone={onClose} />}
      {current === 'meeting' && <NewMeetingForm onDone={onClose} />}
      {current === 'page' && <NewPageForm onDone={onClose} />}
    </Sheet>
  );
}

export const PRIORITIES = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'urgent', label: 'Urgent' },
] as const;

export function NewTaskForm({
  onDone,
  projectId: fixedProject,
  defaults = {},
  endpoint = '/tasks',
}: {
  onDone: (task?: Task) => void;
  projectId?: string;
  defaults?: Partial<{ title: string; ownerId: string; dueDate: string; status: string; milestoneId: string; meetingId: string; parentId: string }>;
  endpoint?: string;
}) {
  const { me, people } = useSession();
  const act = useAction();
  const { data: projects } = useApi<Project[]>(fixedProject ? null : '/projects');
  const [title, setTitle] = useState(defaults.title ?? '');
  const [projectId, setProjectId] = useState(fixedProject ?? '');
  const [ownerId, setOwnerId] = useState(defaults.ownerId ?? me!.user.id);
  const [dueDate, setDueDate] = useState<string | null>(defaults.dueDate ?? null);
  const [priority, setPriority] = useState('medium');
  const [description, setDescription] = useState('');
  const submit = async () => {
    const task = await act(
      () =>
        api.post<Task>(endpoint, {
          title,
          description: description || undefined,
          projectId: projectId || null,
          ownerId: ownerId || null,
          dueDate: dueDate || null,
          priority,
          status: defaults.status,
          milestoneId: defaults.milestoneId,
          meetingId: defaults.meetingId,
          parentId: defaults.parentId,
        }),
      'Task created',
    );
    if (task) onDone(task);
  };
  return (
    <View style={{ gap: 14 }}>
      <Field label="Title">
        <Input autoFocus value={title} onChangeText={setTitle} placeholder="What needs doing?" maxLength={300} returnKeyType="next" />
      </Field>
      {!fixedProject && (
        <Field label="Project">
          <Select
            title="Project"
            value={projectId}
            onChange={setProjectId}
            options={[{ id: '', label: 'Personal (no project)' }, ...(projects ?? []).map((p) => ({ id: p.id, label: p.name, left: <View style={{ width: 10, height: 10, borderRadius: 3, backgroundColor: SWATCH[p.color] ?? SWATCH.purple }} /> }))]}
          />
        </Field>
      )}
      <Field label="Owner">
        <PeopleField
          title="Owner"
          multiple={false}
          allowNone="Unassigned"
          placeholder="Unassigned"
          value={ownerId ? [ownerId] : []}
          onChange={(ids) => setOwnerId(ids[0] ?? '')}
          people={people.map((p) => (p.id === me!.user.id ? { ...p, name: `${p.name} (me)` } : p))}
        />
      </Field>
      <Row gap={10}>
        <Field label="Due date" style={{ flex: 1 }}>
          <DateField value={dueDate} onChange={setDueDate} label="Due date" />
        </Field>
        <Field label="Priority" style={{ flex: 1 }}>
          <Select title="Priority" value={priority} onChange={setPriority} options={PRIORITIES.map((p) => ({ ...p }))} />
        </Field>
      </Row>
      <Field label="Description (optional)">
        <Input multiline value={description} onChangeText={setDescription} />
      </Field>
      <Button title="Create task" variant="primary" full disabled={!title.trim()} onPress={submit} />
    </View>
  );
}

const TEMPLATES = [
  { id: 'blank', label: 'Blank project' },
  { id: 'product_launch', label: 'Product launch' },
  { id: 'client_onboarding', label: 'Client onboarding' },
  { id: 'weekly_ops', label: 'Weekly operations' },
];

export function ColourPicker({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  const { c } = useTheme();
  return (
    <Row wrap gap={10}>
      {['purple', 'blue', 'green', 'coral', 'gold', 'sky', 'mint', 'orange'].map((name) => (
        <Pressable
          key={name}
          onPress={() => onChange(name)}
          accessibilityRole="button"
          accessibilityLabel={name}
          accessibilityState={{ selected: value === name }}
          style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: SWATCH[name], borderWidth: 3, borderColor: value === name ? c.ink : 'transparent' }}
        />
      ))}
    </Row>
  );
}

function NewProjectForm({ onDone }: { onDone: () => void }) {
  const { me } = useSession();
  const act = useAction();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState<'workspace' | 'private'>('workspace');
  const [template, setTemplate] = useState('blank');
  const [color, setColor] = useState('purple');
  const [dueDate, setDueDate] = useState<string | null>(null);
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const submit = async () => {
    const project = await act(() => api.post<Project>('/projects', { name, description, visibility, template, color, dueDate, memberIds, createChannel: true }), 'Project created');
    if (project) {
      onDone();
      router.push(`/projects/${project.id}`);
    }
  };
  return (
    <View style={{ gap: 14 }}>
      <Field label="Name">
        <Input autoFocus value={name} onChangeText={setName} placeholder="e.g. Website relaunch" />
      </Field>
      <Field label="Description">
        <Input multiline value={description} onChangeText={setDescription} placeholder="What outcome is this project driving?" />
      </Field>
      <Field label="Template">
        <Select title="Template" value={template} onChange={setTemplate} options={TEMPLATES} />
      </Field>
      <Field label="Visibility">
        <Select
          title="Visibility"
          value={visibility}
          onChange={setVisibility}
          options={[
            { id: 'workspace', label: 'Everyone in the workspace' },
            { id: 'private', label: 'Private to members' },
          ]}
        />
      </Field>
      <Field label="Target date">
        <DateField value={dueDate} onChange={setDueDate} label="Target date" />
      </Field>
      <Field label="Colour">
        <ColourPicker value={color} onChange={setColor} />
      </Field>
      <Field label="Members" hint="A project channel is created automatically for these members.">
        <PeopleField value={memberIds} onChange={setMemberIds} exclude={[me!.user.id]} title="Members" />
      </Field>
      <Button title="Create project" variant="primary" full disabled={name.trim().length < 2} onPress={submit} />
    </View>
  );
}

function NewMessageForm({ onDone }: { onDone: () => void }) {
  const { me } = useSession();
  const act = useAction();
  const [ids, setIds] = useState<string[]>([]);
  const submit = async () => {
    const dm = await act(() => api.post<{ id: string }>('/dms', { userIds: ids }));
    if (dm) {
      onDone();
      router.push(`/channels/${dm.id}`);
    }
  };
  return (
    <View style={{ gap: 14 }}>
      <Field label="To" hint="Pick one person for a direct message, or several for a group conversation.">
        <PeopleField value={ids} onChange={setIds} exclude={[me!.user.id]} placeholder="Choose people" title="To" />
      </Field>
      <Button title="Open conversation" variant="primary" full disabled={!ids.length} onPress={submit} />
    </View>
  );
}

export function NewMeetingForm({ onDone, projectId: fixedProject, channelId }: { onDone: () => void; projectId?: string; channelId?: string }) {
  const { people, me } = useSession();
  const act = useAction();
  const { data: projects } = useApi<Project[]>(fixedProject ? null : '/projects');
  const nextHour = new Date();
  nextHour.setMinutes(0, 0, 0);
  nextHour.setHours(nextHour.getHours() + 1);
  const [title, setTitle] = useState('');
  const [startsAt, setStartsAt] = useState(nextHour.toISOString());
  const [duration, setDuration] = useState('30');
  const [agenda, setAgenda] = useState('');
  const [location, setLocation] = useState('');
  const [video, setVideo] = useState(true);
  const [projectId, setProjectId] = useState(fixedProject ?? '');
  const [ids, setIds] = useState<string[]>([]);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const submit = async () => {
    const meeting = await act(
      () =>
        api.post('/meetings', {
          title,
          startsAt,
          durationMin: Number(duration),
          agenda,
          location,
          video,
          projectId: projectId || null,
          channelId: channelId ?? null,
          participantIds: ids,
        }),
      'Meeting scheduled',
    );
    if (meeting) {
      onDone();
      router.push(`/meetings/${meeting.id}`);
    }
  };
  const zones = [...new Set(people.filter((p) => ids.includes(p.id) && p.timezone !== zone).map((p) => p.timezone))];
  return (
    <View style={{ gap: 14 }}>
      <Field label="Title">
        <Input autoFocus value={title} onChangeText={setTitle} placeholder="e.g. Weekly product sync" />
      </Field>
      <Field label={`Starts (${zone})`}>
        <DateTimeField value={startsAt} onChange={setStartsAt} label="Starts" />
      </Field>
      <Field label="Duration">
        <Select title="Duration" value={duration} onChange={setDuration} options={[15, 30, 45, 60, 90, 120].map((d) => ({ id: String(d), label: `${d} minutes` }))} />
      </Field>
      {zones.length > 0 && (
        <Muted>
          For participants elsewhere:{' '}
          {zones.map((tz) => `${new Date(startsAt).toLocaleTimeString(undefined, { timeZone: tz, hour: 'numeric', minute: '2-digit' })} in ${tz}`).join(' · ')}
        </Muted>
      )}
      <Field label="Participants">
        <PeopleField value={ids} onChange={setIds} exclude={[me!.user.id]} title="Participants" />
      </Field>
      {!fixedProject && (
        <Field label="Project (optional)">
          <Select title="Project" value={projectId} onChange={setProjectId} options={[{ id: '', label: 'None' }, ...(projects ?? []).map((p) => ({ id: p.id, label: p.name }))]} />
        </Field>
      )}
      <Field label="Agenda">
        <Input multiline value={agenda} onChangeText={setAgenda} placeholder={'1. Updates\n2. Decisions needed\n3. Next steps'} />
      </Field>
      <Field label="Room or location (optional)">
        <Input value={location} onChangeText={setLocation} />
      </Field>
      <Toggle value={video} onChange={setVideo} label="Add a video link" />
      <Button title="Schedule" variant="primary" full disabled={!title.trim()} onPress={submit} />
    </View>
  );
}

function NewPageForm({ onDone }: { onDone: () => void }) {
  const act = useAction();
  const { data: projects } = useApi<Project[]>('/projects');
  const [title, setTitle] = useState('');
  const [projectId, setProjectId] = useState('');
  const submit = async () => {
    const page = await act(() => api.post('/pages', { title, projectId: projectId || null, body: '' }));
    if (page) {
      onDone();
      router.push(`/knowledge/${page.id}?edit=1`);
    }
  };
  return (
    <View style={{ gap: 14 }}>
      <Field label="Title">
        <Input autoFocus value={title} onChangeText={setTitle} placeholder="e.g. Expense policy" />
      </Field>
      <Field label="Where does it belong?">
        <Select
          title="Where does it belong?"
          value={projectId}
          onChange={setProjectId}
          options={[{ id: '', label: 'Company knowledge (whole workspace)' }, ...(projects ?? []).map((p) => ({ id: p.id, label: `Project: ${p.name}` }))]}
        />
      </Field>
      <Button title="Create and edit" variant="primary" full disabled={!title.trim()} onPress={submit} />
    </View>
  );
}
