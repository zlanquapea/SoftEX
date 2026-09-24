import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, qs, type Decision, type Meeting, type Task } from '../api';
import { Avatar, AvatarStack } from '../components/Avatar';
import { Icon } from '../components/Icon';
import { useShell } from '../components/Layout';
import { Markdown } from '../components/Markdown';
import { NewTaskForm } from '../components/QuickCreate';
import { TaskRow } from '../components/TaskDrawer';
import { Empty, ErrorState, Field, Loading, Modal, PeoplePicker, Tabs, useAction } from '../components/ui';
import { dateTime, localTimeIn, timeOf } from '../format';
import { useApi, useRealtime } from '../hooks';
import { useSession } from '../session';

export function Meetings() {
  const { openCreate } = useShell();
  const [range, setRange] = useState<'upcoming' | 'past'>('upcoming');
  const { data, error, reload } = useApi<Meeting[]>(`/meetings${qs({ range })}`);
  useRealtime((e) => e.type === 'meeting.updated' && reload());
  const groups = new Map<string, Meeting[]>();
  for (const m of data ?? []) {
    const key = new Date(m.starts_at).toDateString();
    groups.set(key, [...(groups.get(key) ?? []), m]);
  }
  return (
    <div className="page narrow">
      <div className="page-head">
        <div>
          <h1>Meetings</h1>
          <p className="muted">Agendas, notes, decisions and follow-ups — connected to the work they concern.</p>
        </div>
        <button className="btn primary" onClick={() => openCreate('meeting')}>
          <Icon name="plus" size={16} /> Schedule
        </button>
      </div>
      <Tabs value={range} onChange={setRange} tabs={[{ id: 'upcoming', label: 'Upcoming' }, { id: 'past', label: 'Past' }]} />
      {error && <ErrorState error={error} retry={reload} />}
      {!data && !error && <Loading />}
      {data && !data.length && (
        <Empty icon="video" title={range === 'upcoming' ? 'No upcoming meetings' : 'No past meetings'}>
          Schedule from here, a channel or a project.
        </Empty>
      )}
      {[...groups.entries()].map(([day, list]) => (
        <section key={day} className="meeting-day">
          <h2 className="section-h">{new Date(day).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</h2>
          <div className="card">
            {list.map((m) => (
              <Link key={m.id} to={`/meetings/${m.id}`} className="meeting">
                <div className="time">
                  <strong>{timeOf(m.starts_at)}</strong>
                  <small>{m.duration_min} min</small>
                </div>
                <div className={`meeting-line ${m.started_at && !m.ended_at ? 'live' : ''} fg-${m.project?.color ?? 'purple'}`} />
                <div className="grow">
                  <h3>
                    {m.title} {m.started_at && !m.ended_at && <span className="pill prio-urgent">Live</span>}
                  </h3>
                  <p>
                    {m.video_url && <Icon name="video" size={14} />} {m.project?.name ?? m.location ?? ''} · organised by {m.organizer?.name}
                  </p>
                  <AvatarStack users={m.participants} max={5} />
                </div>
              </Link>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

interface MeetingFull extends Meeting {
  agenda: string;
  notes: string;
  tasks: Task[];
  decisions: Decision[];
  channel: { id: string; name: string; kind: string } | null;
  my_response: string | null;
  can_manage: boolean;
  can_take_notes: boolean;
}

export function MeetingDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { openTask } = useShell();
  const { people } = useSession();
  const act = useAction();
  const { data: m, error, reload } = useApi<MeetingFull>(`/meetings/${id}`);
  const [notes, setNotes] = useState<string | null>(null);
  const [agenda, setAgenda] = useState<string | null>(null);
  const [addingTask, setAddingTask] = useState(false);
  const [decision, setDecision] = useState('');
  const [editPeople, setEditPeople] = useState<string[] | null>(null);
  useRealtime((e) => e.type === 'meeting.updated' && e.meetingId === id && notes === null && agenda === null && reload());

  if (error) return <ErrorState error={error} retry={reload} />;
  if (!m) return <Loading />;
  const live = !!m.started_at && !m.ended_at;
  const zones = [...new Set(m.participants.map((p) => p.timezone).filter((tz) => tz && tz !== Intl.DateTimeFormat().resolvedOptions().timeZone))];

  const saveNotes = async () => {
    if (notes === null || notes === m.notes) return setNotes(null);
    await act(() => api.patch(`/meetings/${m.id}`, { notes }), 'Notes saved');
    setNotes(null);
    reload();
  };
  const saveAgenda = async () => {
    if (agenda === null || agenda === m.agenda) return setAgenda(null);
    await act(() => api.patch(`/meetings/${m.id}`, { agenda }), 'Agenda saved');
    setAgenda(null);
    reload();
  };

  return (
    <div className="page">
      <div className="crumbs">
        <Link to="/meetings">Meetings</Link>
        {m.project && (
          <>
            {' / '}
            <Link to={`/projects/${m.project.id}`}>{m.project.name}</Link>
          </>
        )}
      </div>
      <div className="meeting-head card">
        <div className="grow">
          <p className="eyebrow">{live ? 'HAPPENING NOW' : m.ended_at ? 'ENDED' : 'SCHEDULED'}</p>
          <h1>{m.title}</h1>
          <p className="muted">
            {dateTime(m.starts_at)} – {timeOf(m.ends_at)} · {m.duration_min} min{m.location && ` · ${m.location}`}
          </p>
          {zones.length > 0 && (
            <p className="muted small">
              {zones.map((tz) => `${new Date(m.starts_at).toLocaleTimeString(undefined, { timeZone: tz, hour: 'numeric', minute: '2-digit' })} ${tz}`).join(' · ')}
            </p>
          )}
        </div>
        <div className="meeting-actions">
          {m.video_url && !m.ended_at && (
            <a
              className="btn primary"
              href={m.video_url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => m.can_take_notes && !m.started_at && api.post(`/meetings/${m.id}/start`).then(reload)}
            >
              <Icon name="video" size={16} /> {live ? 'Join now' : 'Start & join video'}
            </a>
          )}
          {m.can_take_notes && !m.ended_at && (
            <button
              className="btn"
              onClick={async () => {
                if (!confirm('End the meeting and send notes, decisions and follow-ups to participants?')) return;
                await act(() => api.post(`/meetings/${m.id}/end`), 'Meeting wrapped up');
                reload();
              }}
            >
              <Icon name="check" size={16} /> End & share follow-ups
            </button>
          )}
          <a className="btn" href={`/api/meetings/${m.id}/ics`}>
            <Icon name="calendar" size={16} /> Add to calendar
          </a>
          {m.my_response && !m.ended_at && (
            <select
              value={m.my_response}
              onChange={async (e) => {
                await act(() => api.post(`/meetings/${m.id}/respond`, { response: e.target.value }), 'Response saved');
                reload();
              }}
              aria-label="Your response"
            >
              <option value="pending">Not responded</option>
              <option value="accepted">Going</option>
              <option value="declined">Not going</option>
            </select>
          )}
        </div>
      </div>

      <div className="dashboard-grid">
        <div className="main-column">
          <article className="card">
            <div className="section-heading compact">
              <h2>Agenda</h2>
              {m.can_take_notes && agenda === null && (
                <button className="link-btn" onClick={() => setAgenda(m.agenda)}>
                  Edit
                </button>
              )}
            </div>
            {agenda !== null ? (
              <>
                <textarea rows={6} value={agenda} onChange={(e) => setAgenda(e.target.value)} autoFocus aria-label="Agenda" />
                <div className="form-actions">
                  <button className="btn sm" onClick={() => setAgenda(null)}>
                    Cancel
                  </button>
                  <button className="btn primary sm" onClick={saveAgenda}>
                    Save
                  </button>
                </div>
              </>
            ) : m.agenda ? (
              <Markdown text={m.agenda} />
            ) : (
              <p className="muted">No agenda yet.</p>
            )}
          </article>

          <article className="card">
            <div className="section-heading compact">
              <h2>Notes</h2>
              {m.can_take_notes && notes === null && (
                <button className="link-btn" onClick={() => setNotes(m.notes)}>
                  {m.notes ? 'Edit' : 'Take notes'}
                </button>
              )}
            </div>
            {notes !== null ? (
              <>
                <textarea rows={12} value={notes} onChange={(e) => setNotes(e.target.value)} autoFocus aria-label="Meeting notes" placeholder="Capture discussion points. Record decisions and follow-ups below so they are tracked." />
                <div className="form-actions">
                  <button className="btn sm" onClick={() => setNotes(null)}>
                    Cancel
                  </button>
                  <button className="btn primary sm" onClick={saveNotes}>
                    Save notes
                  </button>
                </div>
              </>
            ) : m.notes ? (
              <Markdown text={m.notes} />
            ) : (
              <p className="muted">No notes yet.</p>
            )}
          </article>

          <article className="card">
            <div className="section-heading compact">
              <h2>Decisions</h2>
            </div>
            {m.decisions.map((d) => (
              <div key={d.id} className="list-row">
                <span className="activity-icon decision">
                  <Icon name="gavel" size={15} />
                </span>
                <span className="grow">
                  <strong>{d.title}</strong>
                  <small className="muted block">{d.decided_by_name}</small>
                </span>
              </div>
            ))}
            {!m.decisions.length && <p className="muted">No decisions recorded.</p>}
            {m.can_take_notes && (
              <form
                className="inline-add"
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (!decision.trim()) return;
                  await act(() => api.post('/decisions', { title: decision, meetingId: m.id }), 'Decision recorded');
                  setDecision('');
                  reload();
                }}
              >
                <input value={decision} onChange={(e) => setDecision(e.target.value)} placeholder="Record a decision and press Enter" aria-label="New decision" />
              </form>
            )}
          </article>

          <article className="card">
            <div className="section-heading compact">
              <h2>Follow-up tasks</h2>
              {m.can_take_notes && (
                <button className="btn sm" onClick={() => setAddingTask(true)}>
                  <Icon name="plus" size={14} /> Add follow-up
                </button>
              )}
            </div>
            <div className="task-list">
              {m.tasks.map((t) => (
                <TaskRow key={t.id} task={t} onOpen={() => openTask(t.id)} />
              ))}
            </div>
            {!m.tasks.length && <p className="muted">No follow-ups yet. Every action item should have one owner and a date.</p>}
          </article>
        </div>

        <aside className="right-column">
          <article className="card">
            <div className="section-heading compact">
              <div>
                <h2>Participants</h2>
                <p>{m.participants.length} invited</p>
              </div>
              {m.can_manage && !m.ended_at && (
                <button className="link-btn" onClick={() => setEditPeople(m.participants.map((p) => p.id))}>
                  Edit
                </button>
              )}
            </div>
            {m.participants.map((p) => (
              <div key={p.id} className="list-row">
                <Avatar user={p} size="sm" showPresence />
                <span className="grow">
                  {p.name} {p.id === m.organizer?.id && <span className="pill">Organizer</span>}
                  <small className="muted block">{localTimeIn(p.timezone)} local time</small>
                </span>
                <span className={`rsvp rsvp-${p.response}`}>{p.response === 'accepted' ? 'Going' : p.response === 'declined' ? 'Declined' : 'Pending'}</span>
              </div>
            ))}
          </article>
          {m.channel && (
            <article className="card">
              <h2>Discussion</h2>
              <Link to={`/channels/${m.channel.id}`} className="list-row">
                <Icon name="hash" /> {m.channel.name}
              </Link>
            </article>
          )}
          {m.can_manage && !m.ended_at && (
            <button
              className="btn block danger-text"
              onClick={async () => {
                if (!confirm('Cancel this meeting? Participants will be notified.')) return;
                await act(() => api.del(`/meetings/${m.id}`), 'Meeting cancelled');
                navigate('/meetings');
              }}
            >
              Cancel meeting
            </button>
          )}
        </aside>
      </div>

      <Modal open={addingTask} onClose={() => setAddingTask(false)} title="Add a follow-up task">
        {addingTask && (
          <NewTaskForm
            projectId={m.project?.id}
            defaults={{ meetingId: m.id }}
            onDone={() => {
              setAddingTask(false);
              reload();
            }}
          />
        )}
      </Modal>
      <Modal open={editPeople !== null} onClose={() => setEditPeople(null)} title="Participants">
        {editPeople && (
          <form
            className="form"
            onSubmit={async (e) => {
              e.preventDefault();
              await act(() => api.patch(`/meetings/${m.id}`, { participantIds: editPeople }), 'Participants updated');
              setEditPeople(null);
              reload();
            }}
          >
            <Field label="People">
              <PeoplePicker people={people} value={editPeople} onChange={setEditPeople} />
            </Field>
            <div className="form-actions">
              <button className="btn primary">Save</button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}
