import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, type Project, type Task } from '../api';
import { toIso, toLocalInput } from '../format';
import { useApi } from '../hooks';
import { usePeople, useSession } from '../session';
import { Icon } from './Icon';
import { RepeatFields } from './RepeatFields';
import { localToday } from '../format';
import type { Recurrence } from '../repeat';
import { FormField, Modal, PeoplePicker, useAction, Callout, ColorSwatches, DatePicker, DateTimePicker } from '@/components/kit';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOptGroup, NativeSelectOption } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Item, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from '@/components/ui/item';

type Kind = 'task' | 'project' | 'message' | 'meeting' | 'page';

export function QuickCreate({ open, kind, onClose }: { open: boolean; kind?: Kind; onClose: () => void }) {
  const [current, setCurrent] = useState<Kind | undefined>(kind);
  const { me } = useSession();
  useEffect(() => setCurrent(kind), [kind, open]);
  const guest = me?.role === 'guest';
  const options: { id: Kind; icon: string; label: string; hint: string }[] = [
    { id: 'task', icon: 'check', label: 'Task', hint: 'Assign and track work' },
    ...(guest ? [] : [{ id: 'project' as Kind, icon: 'folder', label: 'Project', hint: 'Plan a team initiative' }]),
    { id: 'message', icon: 'send', label: 'Message', hint: 'Start a conversation' },
    { id: 'meeting', icon: 'video', label: 'Meeting', hint: 'Schedule with an agenda' },
    ...(guest ? [] : [{ id: 'page' as Kind, icon: 'book', label: 'Page', hint: 'Write shared knowledge' }]),
  ];
  const titles: Record<Kind, string> = {
    task: 'New task',
    project: 'New project',
    message: 'New message',
    meeting: 'Schedule a meeting',
    page: 'New knowledge page',
  };
  return (
    <Modal open={open} onClose={onClose} eyebrow="QUICK CREATE" title={current ? titles[current] : 'What would you like to start?'} wide={current === 'project' || current === 'meeting'}>
      {!current && (
        <ItemGroup className="grid gap-2 sm:grid-cols-2">
          {options.map((o) => (
            <Item key={o.id} variant="outline" render={<button type="button" onClick={() => setCurrent(o.id)} />} className="text-left hover:bg-muted">
              <ItemMedia variant="icon" className="size-8 rounded-lg bg-accent text-accent-foreground">
                <Icon name={o.icon} />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>{o.label}</ItemTitle>
                <ItemDescription>{o.hint}</ItemDescription>
              </ItemContent>
            </Item>
          ))}
        </ItemGroup>
      )}
      {current === 'task' && <NewTaskForm onDone={onClose} />}
      {current === 'project' && <NewProjectForm onDone={onClose} />}
      {current === 'message' && <NewMessageForm onDone={onClose} />}
      {current === 'meeting' && <NewMeetingForm onDone={onClose} />}
      {current === 'page' && <NewPageForm onDone={onClose} />}
    </Modal>
  );
}

export function NewTaskForm({
  onDone,
  projectId: fixedProject,
  defaults = {},
  endpoint = '/tasks',
}: {
  onDone: (task?: Task) => void;
  projectId?: string;
  defaults?: Partial<{ title: string; ownerId: string; teamId: string; dueDate: string; status: string; milestoneId: string; meetingId: string; parentId: string }>;
  endpoint?: string;
}) {
  const { me } = useSession();
  const people = usePeople();
  const act = useAction();
  const { data: projects } = useApi<Project[]>(fixedProject ? null : '/projects');
  const { data: teams } = useApi<{ id: string; name: string }[]>('/teams');
  const [title, setTitle] = useState(defaults.title ?? '');
  const [projectId, setProjectId] = useState(fixedProject ?? '');
  // A person's id, or "team:<id>" to give the task to a whole team.
  const [ownerId, setOwnerId] = useState(defaults.teamId ? `team:${defaults.teamId}` : defaults.ownerId ?? me!.user.id);
  const team = ownerId.startsWith('team:') ? ownerId.slice(5) : null;
  const [dueDate, setDueDate] = useState(defaults.dueDate ?? '');
  const [priority, setPriority] = useState('medium');
  const [description, setDescription] = useState('');
  const [repeat, setRepeat] = useState<{ recurrence: Recurrence | ''; until: string }>({ recurrence: '', until: '' });
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const task = await act(
      () =>
        api.post<Task>(endpoint, {
          title,
          description: description || undefined,
          projectId: projectId || null,
          ownerId: team ? null : ownerId || null,
          teamId: team,
          dueDate: dueDate || null,
          priority,
          recurrence: repeat.recurrence || null,
          recurrenceUntil: repeat.recurrence && repeat.until ? repeat.until : null,
          status: defaults.status,
          milestoneId: defaults.milestoneId,
          meetingId: defaults.meetingId,
          parentId: defaults.parentId,
        }),
      'Task created',
    );
    setBusy(false);
    if (task) onDone(task);
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <FormField label="Title">
        <Input autoFocus required value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What needs doing?" maxLength={300} />
      </FormField>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] gap-4">
        {!fixedProject && (
          <FormField label="Project">
            <NativeSelect value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <NativeSelectOption value="">Personal (no project)</NativeSelectOption>
              {(projects ?? []).map((p) => (
                <NativeSelectOption key={p.id} value={p.id}>
                  {p.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </FormField>
        )}
        <FormField label="Owner" hint={team ? 'Everyone on the team is told; anyone can pick it up.' : undefined}>
          <NativeSelect value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
            <NativeSelectOption value="">Unassigned</NativeSelectOption>
            <NativeSelectOptGroup label="People">
              {people.map((p) => (
                <NativeSelectOption key={p.id} value={p.id}>
                  {p.id === me!.user.id ? `${p.name} (me)` : p.name}
                </NativeSelectOption>
              ))}
            </NativeSelectOptGroup>
            {!!teams?.length && (
              <NativeSelectOptGroup label="Teams">
                {teams.map((t) => (
                  <NativeSelectOption key={t.id} value={`team:${t.id}`}>
                    {t.name} (team)
                  </NativeSelectOption>
                ))}
              </NativeSelectOptGroup>
            )}
          </NativeSelect>
        </FormField>
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] gap-4">
        <FormField label="Due date">
          <DatePicker value={dueDate} onChange={(v) => setDueDate(v ?? '')} placeholder="No due date" />
        </FormField>
        <FormField label="Priority">
          <NativeSelect value={priority} onChange={(e) => setPriority(e.target.value)}>
            <NativeSelectOption value="low">Low</NativeSelectOption>
            <NativeSelectOption value="medium">Medium</NativeSelectOption>
            <NativeSelectOption value="high">High</NativeSelectOption>
            <NativeSelectOption value="urgent">Urgent</NativeSelectOption>
          </NativeSelect>
        </FormField>
      </div>
      <RepeatFields
        recurrence={repeat.recurrence}
        until={repeat.until}
        minUntil={dueDate || undefined}
        onChange={(next) => {
          // A repeating task needs a first day: today, unless one was picked.
          if (next.recurrence && !dueDate) setDueDate(localToday());
          setRepeat(next);
        }}
      />
      <FormField label="Description (optional)">
        <Textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
      </FormField>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button variant="outline" type="button" onClick={() => onDone()}>
          Cancel
        </Button>
        <Button disabled={busy || !title.trim()} type="submit">
          Create task
        </Button>
      </div>
    </form>
  );
}

function NewProjectForm({ onDone }: { onDone: () => void }) {
  const { me } = useSession();
  const people = usePeople();
  const navigate = useNavigate();
  const act = useAction();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState<'workspace' | 'private'>('workspace');
  const [template, setTemplate] = useState('blank');
  const [color, setColor] = useState('purple');
  const [dueDate, setDueDate] = useState('');
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const project = await act(
      () => api.post<Project>('/projects', { name, description, visibility, template, color, dueDate: dueDate || null, memberIds, createChannel: true }),
      'Project created',
    );
    if (project) {
      onDone();
      navigate(`/projects/${project.id}`);
    }
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <FormField label="Name">
        <Input autoFocus required minLength={2} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Website relaunch" />
      </FormField>
      <FormField label="Description">
        <Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What outcome is this project driving?" />
      </FormField>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] gap-4">
        <FormField label="Template">
          <NativeSelect value={template} onChange={(e) => setTemplate(e.target.value)}>
            <NativeSelectOption value="blank">Blank project</NativeSelectOption>
            <NativeSelectOption value="product_launch">Product launch</NativeSelectOption>
            <NativeSelectOption value="client_onboarding">Client onboarding</NativeSelectOption>
            <NativeSelectOption value="weekly_ops">Weekly operations</NativeSelectOption>
          </NativeSelect>
        </FormField>
        <FormField label="Visibility">
          <NativeSelect value={visibility} onChange={(e) => setVisibility(e.target.value as 'workspace' | 'private')}>
            <NativeSelectOption value="workspace">Everyone in the workspace</NativeSelectOption>
            <NativeSelectOption value="private">Private to members</NativeSelectOption>
          </NativeSelect>
        </FormField>
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] gap-4">
        <FormField label="Target date">
          <DatePicker value={dueDate} onChange={(v) => setDueDate(v ?? '')} placeholder="No target date" />
        </FormField>
        <FormField label="Colour">
          <ColorSwatches colors={['purple', 'blue', 'green', 'coral', 'gold', 'sky', 'mint', 'orange']} value={color} onChange={setColor} />
        </FormField>
      </div>
      <FormField label="Members" hint="A project channel is created automatically for these members.">
        <PeoplePicker people={people} value={memberIds} onChange={setMemberIds} exclude={[me!.user.id]} />
      </FormField>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button variant="outline" type="button" onClick={onDone}>
          Cancel
        </Button>
        <Button disabled={name.trim().length < 2} type="submit">
          Create project
        </Button>
      </div>
    </form>
  );
}

function NewMessageForm({ onDone }: { onDone: () => void }) {
  const { me } = useSession();
  const people = usePeople();
  const navigate = useNavigate();
  const act = useAction();
  const [ids, setIds] = useState<string[]>([]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const dm = await act(() => api.post<{ id: string }>('/dms', { userIds: ids }));
    if (dm) {
      onDone();
      navigate(`/channels/${dm.id}`);
    }
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <FormField label="To" hint="Pick one person for a direct message, or several for a group conversation.">
        <PeoplePicker people={people} value={ids} onChange={setIds} exclude={[me!.user.id]} placeholder="Type a name…" />
      </FormField>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button variant="outline" type="button" onClick={onDone}>
          Cancel
        </Button>
        <Button disabled={!ids.length} type="submit">
          Open conversation
        </Button>
      </div>
    </form>
  );
}

export function NewMeetingForm({ onDone, projectId: fixedProject, channelId }: { onDone: () => void; projectId?: string; channelId?: string }) {
  const { me } = useSession();
  const people = usePeople();
  const navigate = useNavigate();
  const act = useAction();
  const { data: projects } = useApi<Project[]>(fixedProject ? null : '/projects');
  const nextHour = new Date();
  nextHour.setMinutes(0, 0, 0);
  nextHour.setHours(nextHour.getHours() + 1);
  const [title, setTitle] = useState('');
  const [startsAt, setStartsAt] = useState(toLocalInput(nextHour.toISOString()));
  const [duration, setDuration] = useState(30);
  const [agenda, setAgenda] = useState('');
  const [location, setLocation] = useState('');
  const [video, setVideo] = useState(true);
  const [projectId, setProjectId] = useState(fixedProject ?? '');
  const [ids, setIds] = useState<string[]>([]);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const meeting = await act(
      () =>
        api.post('/meetings', {
          title,
          startsAt: toIso(startsAt),
          durationMin: duration,
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
      navigate(`/meetings/${meeting.id}`);
    }
  };
  const selectedZones = [...new Set(people.filter((p) => ids.includes(p.id) && p.timezone !== zone).map((p) => p.timezone))];
  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <FormField label="Title">
        <Input autoFocus required value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Weekly product sync" />
      </FormField>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] gap-4">
        <FormField label={`Starts (${zone})`}>
          <DateTimePicker value={startsAt} onChange={(v) => v && setStartsAt(v)} aria-label="Starts" />
        </FormField>
        <FormField label="Duration">
          <NativeSelect value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
            {[15, 30, 45, 60, 90, 120].map((d) => (
              <NativeSelectOption key={d} value={d}>
                {d} minutes
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </FormField>
      </div>
      {selectedZones.length > 0 && startsAt && (
        <Callout tone="info">
          For participants elsewhere:{' '}
          {selectedZones
            .map((tz) => `${new Date(toIso(startsAt)).toLocaleTimeString(undefined, { timeZone: tz, hour: 'numeric', minute: '2-digit' })} in ${tz}`)
            .join(' · ')}
        </Callout>
      )}
      <FormField label="Participants">
        <PeoplePicker people={people} value={ids} onChange={setIds} exclude={[me!.user.id]} />
      </FormField>
      {!fixedProject && (
        <FormField label="Project (optional)">
          <NativeSelect value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <NativeSelectOption value="">None</NativeSelectOption>
            {(projects ?? []).map((p) => (
              <NativeSelectOption key={p.id} value={p.id}>
                {p.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </FormField>
      )}
      <FormField label="Agenda">
        <Textarea rows={3} value={agenda} onChange={(e) => setAgenda(e.target.value)} placeholder={'1. Updates\n2. Decisions needed\n3. Next steps'} />
      </FormField>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] gap-4">
        <FormField label="Room or location (optional)">
          <Input value={location} onChange={(e) => setLocation(e.target.value)} />
        </FormField>
        <Label className="self-end pb-2">
          <Checkbox checked={video} onCheckedChange={(checked) => setVideo(checked)} /> Add a video link
        </Label>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button variant="outline" type="button" onClick={onDone}>
          Cancel
        </Button>
        <Button disabled={!title.trim()} type="submit">
          Schedule
        </Button>
      </div>
    </form>
  );
}

function NewPageForm({ onDone }: { onDone: () => void }) {
  const navigate = useNavigate();
  const act = useAction();
  const { data: projects } = useApi<Project[]>('/projects');
  const [title, setTitle] = useState('');
  const [projectId, setProjectId] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const page = await act(() => api.post('/pages', { title, projectId: projectId || null, body: '' }));
    if (page) {
      onDone();
      navigate(`/knowledge/${page.id}?edit=1${title.trim() ? '' : '&new=1'}`);
    }
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <FormField label="Title" hint="Optional — you can name it later.">
        <Input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Untitled" />
      </FormField>
      <FormField label="Where does it belong?">
        <NativeSelect value={projectId} onChange={(e) => setProjectId(e.target.value)}>
          <NativeSelectOption value="">Company knowledge (whole workspace)</NativeSelectOption>
          {(projects ?? []).map((p) => (
            <NativeSelectOption key={p.id} value={p.id}>
              Project: {p.name}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </FormField>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button variant="outline" type="button" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit">Create and edit</Button>
      </div>
    </form>
  );
}
