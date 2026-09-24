import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, type Project, type Task } from '../api';
import { toIso, toLocalInput } from '../format';
import { useApi } from '../hooks';
import { useSession } from '../session';
import { Icon } from './Icon';
import { Field, Modal, PeoplePicker, useAction } from './ui';

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
        <div className="create-options">
          {options.map((o) => (
            <button key={o.id} onClick={() => setCurrent(o.id)}>
              <span>
                <Icon name={o.icon} />
              </span>
              <b>{o.label}</b>
              <small>{o.hint}</small>
            </button>
          ))}
        </div>
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
  defaults?: Partial<{ title: string; ownerId: string; dueDate: string; status: string; milestoneId: string; meetingId: string; parentId: string }>;
  endpoint?: string;
}) {
  const { me, people } = useSession();
  const act = useAction();
  const { data: projects } = useApi<Project[]>(fixedProject ? null : '/projects');
  const [title, setTitle] = useState(defaults.title ?? '');
  const [projectId, setProjectId] = useState(fixedProject ?? '');
  const [ownerId, setOwnerId] = useState(defaults.ownerId ?? me!.user.id);
  const [dueDate, setDueDate] = useState(defaults.dueDate ?? '');
  const [priority, setPriority] = useState('medium');
  const [description, setDescription] = useState('');
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
    setBusy(false);
    if (task) onDone(task);
  };
  return (
    <form onSubmit={submit} className="form">
      <Field label="Title">
        <input autoFocus required value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What needs doing?" maxLength={300} />
      </Field>
      <div className="form-row">
        {!fixedProject && (
          <Field label="Project">
            <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">Personal (no project)</option>
              {(projects ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Owner">
          <select value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
            <option value="">Unassigned</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.id === me!.user.id ? `${p.name} (me)` : p.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="form-row">
        <Field label="Due date">
          <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        </Field>
        <Field label="Priority">
          <select value={priority} onChange={(e) => setPriority(e.target.value)}>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
            <option value="urgent">Urgent</option>
          </select>
        </Field>
      </div>
      <Field label="Description (optional)">
        <textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <div className="form-actions">
        <button type="button" className="btn" onClick={() => onDone()}>
          Cancel
        </button>
        <button className="btn primary" disabled={busy || !title.trim()}>
          Create task
        </button>
      </div>
    </form>
  );
}

function NewProjectForm({ onDone }: { onDone: () => void }) {
  const { people, me } = useSession();
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
    <form onSubmit={submit} className="form">
      <Field label="Name">
        <input autoFocus required minLength={2} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Website relaunch" />
      </Field>
      <Field label="Description">
        <textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What outcome is this project driving?" />
      </Field>
      <div className="form-row">
        <Field label="Template">
          <select value={template} onChange={(e) => setTemplate(e.target.value)}>
            <option value="blank">Blank project</option>
            <option value="product_launch">Product launch</option>
            <option value="client_onboarding">Client onboarding</option>
            <option value="weekly_ops">Weekly operations</option>
          </select>
        </Field>
        <Field label="Visibility">
          <select value={visibility} onChange={(e) => setVisibility(e.target.value as 'workspace' | 'private')}>
            <option value="workspace">Everyone in the workspace</option>
            <option value="private">Private to members</option>
          </select>
        </Field>
      </div>
      <div className="form-row">
        <Field label="Target date">
          <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        </Field>
        <Field label="Colour">
          <div className="color-row">
            {['purple', 'blue', 'green', 'coral', 'gold', 'sky', 'mint', 'orange'].map((c) => (
              <button type="button" key={c} className={`swatch bg-${c} ${color === c ? 'active' : ''}`} onClick={() => setColor(c)} aria-label={c} aria-pressed={color === c} />
            ))}
          </div>
        </Field>
      </div>
      <Field label="Members" hint="A project channel is created automatically for these members.">
        <PeoplePicker people={people} value={memberIds} onChange={setMemberIds} exclude={[me!.user.id]} />
      </Field>
      <div className="form-actions">
        <button type="button" className="btn" onClick={onDone}>
          Cancel
        </button>
        <button className="btn primary" disabled={name.trim().length < 2}>
          Create project
        </button>
      </div>
    </form>
  );
}

function NewMessageForm({ onDone }: { onDone: () => void }) {
  const { people, me } = useSession();
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
    <form onSubmit={submit} className="form">
      <Field label="To" hint="Pick one person for a direct message, or several for a group conversation.">
        <PeoplePicker people={people} value={ids} onChange={setIds} exclude={[me!.user.id]} placeholder="Type a name…" />
      </Field>
      <div className="form-actions">
        <button type="button" className="btn" onClick={onDone}>
          Cancel
        </button>
        <button className="btn primary" disabled={!ids.length}>
          Open conversation
        </button>
      </div>
    </form>
  );
}

export function NewMeetingForm({ onDone, projectId: fixedProject, channelId }: { onDone: () => void; projectId?: string; channelId?: string }) {
  const { people, me } = useSession();
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
    <form onSubmit={submit} className="form">
      <Field label="Title">
        <input autoFocus required value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Weekly product sync" />
      </Field>
      <div className="form-row">
        <Field label={`Starts (${zone})`}>
          <input type="datetime-local" required value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
        </Field>
        <Field label="Duration">
          <select value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
            {[15, 30, 45, 60, 90, 120].map((d) => (
              <option key={d} value={d}>
                {d} minutes
              </option>
            ))}
          </select>
        </Field>
      </div>
      {selectedZones.length > 0 && startsAt && (
        <p className="hint-box">
          <Icon name="clock" size={15} /> For participants elsewhere:{' '}
          {selectedZones
            .map((tz) => `${new Date(toIso(startsAt)).toLocaleTimeString(undefined, { timeZone: tz, hour: 'numeric', minute: '2-digit' })} in ${tz}`)
            .join(' · ')}
        </p>
      )}
      <Field label="Participants">
        <PeoplePicker people={people} value={ids} onChange={setIds} exclude={[me!.user.id]} />
      </Field>
      {!fixedProject && (
        <Field label="Project (optional)">
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">None</option>
            {(projects ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field label="Agenda">
        <textarea rows={3} value={agenda} onChange={(e) => setAgenda(e.target.value)} placeholder={'1. Updates\n2. Decisions needed\n3. Next steps'} />
      </Field>
      <div className="form-row">
        <Field label="Room or location (optional)">
          <input value={location} onChange={(e) => setLocation(e.target.value)} />
        </Field>
        <label className="check-inline field">
          <input type="checkbox" checked={video} onChange={(e) => setVideo(e.target.checked)} /> Add a video link
        </label>
      </div>
      <div className="form-actions">
        <button type="button" className="btn" onClick={onDone}>
          Cancel
        </button>
        <button className="btn primary" disabled={!title.trim()}>
          Schedule
        </button>
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
      navigate(`/knowledge/${page.id}?edit=1`);
    }
  };
  return (
    <form onSubmit={submit} className="form">
      <Field label="Title">
        <input autoFocus required value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Expense policy" />
      </Field>
      <Field label="Where does it belong?">
        <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
          <option value="">Company knowledge (whole workspace)</option>
          {(projects ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              Project: {p.name}
            </option>
          ))}
        </select>
      </Field>
      <div className="form-actions">
        <button type="button" className="btn" onClick={onDone}>
          Cancel
        </button>
        <button className="btn primary" disabled={!title.trim()}>
          Create and edit
        </button>
      </div>
    </form>
  );
}
