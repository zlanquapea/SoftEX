import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, qs, type Channel, type Message } from '../api';
import { ThreadAi } from '../components/Ai';
import { Avatar } from '../components/Avatar';
import { Icon } from '../components/Icon';
import { RemindModal, WhenModal } from '../components/Later';
import { useShell } from '../components/Layout';
import { Markdown } from '../components/Markdown';
import { NewMeetingForm, NewTaskForm } from '../components/QuickCreate';
import { Empty, ErrorState, Field, Loading, Modal, PeoplePicker, StatusPill, useAction } from '../components/ui';
import { bytes, plainMentions, timeAgo, timeOf } from '../format';
import { useApi, useRealtime } from '../hooks';
import { realtime } from '../realtime';
import { useSession } from '../session';
import { MediaAttachment, VideoLinks, isPlayable } from '../components/Media';

const EMOJI = ['👍', '❤️', '🎉', '✅', '👀', '😄', '🙏', '🚀'];

const channelIcon = (c: { kind: string }) => (c.kind === 'private' ? 'lock' : c.kind === 'announcement' ? 'megaphone' : c.kind === 'dm' ? 'chat' : 'hash');

// ======================= Chats (direct & group messages) =======================

export function Chats() {
  const { openCreate } = useShell();
  const { data: channels, error, reload } = useApi<Channel[]>('/channels');
  const { data: saved } = useApi<(Message & { channel_name: string; channel_kind: string })[]>('/saved');
  useRealtime((e) => (e.type === 'message.created' || e.type === 'presence') && reload());
  const dms = (channels ?? []).filter((c) => c.kind === 'dm').sort((a, b) => (b.last_message_at ?? '').localeCompare(a.last_message_at ?? ''));
  return (
    <div className="page narrow">
      <div className="page-head">
        <div>
          <h1>Chats</h1>
          <p className="muted">Direct and group conversations.</p>
        </div>
        <button className="btn primary" onClick={() => openCreate('message')}>
          <Icon name="plus" size={16} /> New message
        </button>
      </div>
      {error && <ErrorState error={error} retry={reload} />}
      {!channels && !error && <Loading />}
      {channels && !dms.length && (
        <Empty icon="chat" title="No conversations yet">
          Start a direct message with a teammate.
        </Empty>
      )}
      <ul className="list-card">
        {dms.map((c) => (
          <li key={c.id}>
            <Link to={`/channels/${c.id}`} className={`list-row ${c.unread ? 'unread' : ''}`}>
              {c.members && c.members.length === 1 ? (
                <Avatar user={c.members[0]} size="md" showPresence />
              ) : (
                <span className="avatar avatar-md c-lilac">{c.members?.length ?? 0}</span>
              )}
              <span className="grow">
                <strong>{c.members?.map((m) => m.name).join(', ') || 'Just you'}</strong>
                <small className="muted">{c.last_message_at ? timeAgo(c.last_message_at) : 'No messages yet'}</small>
              </span>
              {c.unread > 0 && <b className="badge">{c.unread}</b>}
            </Link>
          </li>
        ))}
      </ul>
      {saved && saved.length > 0 && (
        <>
          <h2 className="section-h">Saved messages</h2>
          <ul className="list-card">
            {saved.map((m) => (
              <li key={m.id}>
                <Link to={`/channels/${m.channel_id}?message=${m.parent_id ?? m.id}`} className="list-row">
                  <Avatar user={m.user} size="sm" />
                  <span className="grow">
                    <strong>
                      {m.user?.name} <small className="muted">in {m.channel_kind === 'dm' ? 'a direct message' : `#${m.channel_name}`}</small>
                    </strong>
                    <small className="muted">{plainMentions(m.body).slice(0, 140)}</small>
                  </span>
                  <Icon name="bookmark" size={16} />
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

// ======================= Channel browser =======================

export function ChannelsBrowser() {
  const { me, people } = useSession();
  const navigate = useNavigate();
  const act = useAction();
  const { data: channels, error, reload } = useApi<Channel[]>('/channels');
  const [creating, setCreating] = useState(false);
  const [filter, setFilter] = useState('');
  const [form, setForm] = useState({ name: '', topic: '', kind: 'public', memberIds: [] as string[] });
  const list = (channels ?? []).filter((c) => c.kind !== 'dm' && (!filter || c.name.includes(filter.toLowerCase())));
  const create = async (e: FormEvent) => {
    e.preventDefault();
    const channel = await act(() => api.post<Channel>('/channels', form), 'Channel created');
    if (channel) navigate(`/channels/${channel.id}`);
  };
  return (
    <div className="page narrow">
      <div className="page-head">
        <div>
          <h1>Channels</h1>
          <p className="muted">Team and project conversations. Join public channels, or ask to be added to private ones.</p>
        </div>
        {me!.role !== 'guest' && (
          <button className="btn primary" onClick={() => setCreating(true)}>
            <Icon name="plus" size={16} /> New channel
          </button>
        )}
      </div>
      <input className="filter" placeholder="Filter channels" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter channels" />
      {error && <ErrorState error={error} retry={reload} />}
      {!channels && !error && <Loading />}
      <ul className="list-card">
        {list.map((c) => (
          <li key={c.id} className="list-row">
            <Icon name={channelIcon(c)} />
            <Link to={`/channels/${c.id}`} className="grow">
              <strong>{c.name}</strong> {c.project_name && <span className="pill">{c.project_name}</span>}
              <small className="muted block">{c.topic}</small>
            </Link>
            {c.unread > 0 && <b className="badge">{c.unread}</b>}
            {c.joined ? (
              <span className="muted small">Joined</span>
            ) : (
              <button
                className="btn sm"
                onClick={async () => {
                  await act(() => api.post(`/channels/${c.id}/join`), `Joined #${c.name}`);
                  reload();
                }}
              >
                Join
              </button>
            )}
          </li>
        ))}
      </ul>
      <Modal open={creating} onClose={() => setCreating(false)} title="Create a channel">
        <form className="form" onSubmit={create}>
          <Field label="Name" hint="Lowercase letters, numbers and hyphens.">
            <input
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value.toLowerCase().replace(/\s+/g, '-') })}
              placeholder="e.g. design-crit"
              autoFocus
            />
          </Field>
          <Field label="Topic">
            <input value={form.topic} onChange={(e) => setForm({ ...form, topic: e.target.value })} placeholder="What is this channel for?" />
          </Field>
          <Field label="Type">
            <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
              <option value="public">Public — anyone in the workspace can join</option>
              <option value="private">Private — invite only</option>
              {['lead', 'admin', 'owner'].includes(me!.role) && <option value="announcement">Announcement — only leads and admins post</option>}
            </select>
          </Field>
          <Field label="Add people">
            <PeoplePicker people={people} value={form.memberIds} onChange={(ids) => setForm({ ...form, memberIds: ids })} exclude={[me!.user.id]} />
          </Field>
          <div className="form-actions">
            <button type="button" className="btn" onClick={() => setCreating(false)}>
              Cancel
            </button>
            <button className="btn primary">Create channel</button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

// ======================= Channel view =======================

interface ChannelDetail extends Channel {
  members: { id: string; name: string; color: string; title: string; status: string; role: string }[];
  project: { id: string; name: string; color: string } | null;
  can_post: boolean;
  can_manage: boolean;
  created_by: string;
  archived_at: string | null;
  ai_excluded: boolean;
}

export function ChannelView() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const { me } = useSession();
  const act = useAction();
  const navigate = useNavigate();
  const { data: channel, error, reload: reloadChannel } = useApi<ChannelDetail>(`/channels/${id}`);
  const [messages, setMessages] = useState<Message[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [panel, setPanel] = useState<'members' | 'pins' | 'files' | null>(null);
  const [typing, setTyping] = useState<Record<string, { name: string; at: number }>>({});
  const [taskFrom, setTaskFrom] = useState<Message | null>(null);
  const [decisionFrom, setDecisionFrom] = useState<Message | null>(null);
  const [meeting, setMeeting] = useState(false);
  const [adding, setAdding] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const highlight = params.get('message');

  const load = async (before?: string) => {
    const res = await api.get<{ messages: Message[]; has_more: boolean }>(`/channels/${id}/messages${qs({ before, limit: 50 })}`);
    setHasMore(res.has_more);
    setMessages((prev) => (before ? [...res.messages, ...prev] : res.messages));
    setLoaded(true);
  };

  useEffect(() => {
    setMessages([]);
    setLoaded(false);
    setThreadId(null);
    stickToBottom.current = true;
    load().catch(() => setLoaded(true));
    api.post(`/channels/${id}/read`).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    if (highlight && loaded) {
      const exists = messages.some((m) => m.id === highlight);
      if (exists) {
        document.getElementById(`m-${highlight}`)?.scrollIntoView({ block: 'center' });
        stickToBottom.current = false;
      } else {
        setThreadId(highlight);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlight, loaded]);

  useLayoutEffect(() => {
    if (stickToBottom.current && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [messages]);

  const refreshMessage = async (messageId: string) => {
    const res = await api.get<{ root: Message; replies: Message[] }>(`/messages/${messageId}/thread`).catch(() => null);
    if (res) setMessages((prev) => prev.map((m) => (m.id === res.root.id ? res.root : m)));
  };

  useRealtime((e) => {
    if (e.type === 'message.created' && e.message.channel_id === id) {
      if (e.message.parent_id) refreshMessage(e.message.parent_id);
      else {
        const el = scroller.current;
        stickToBottom.current = !el || el.scrollHeight - el.scrollTop - el.clientHeight < 120 || e.message.user?.id === me!.user.id;
        setMessages((prev) => (prev.some((m) => m.id === e.message.id) ? prev : [...prev, e.message]));
      }
      if (document.visibilityState === 'visible') api.post(`/channels/${id}/read`).catch(() => {});
      setTyping((t) => {
        const next = { ...t };
        delete next[e.message.user?.id];
        return next;
      });
    }
    if (e.type === 'message.updated' && e.channelId === id) {
      stickToBottom.current = false;
      refreshMessage(e.parentId ?? e.messageId);
    }
    if (e.type === 'typing' && e.channelId === id) setTyping((t) => ({ ...t, [e.userId]: { name: e.name, at: Date.now() } }));
    if (e.type === 'channel.updated' && e.channelId === id) reloadChannel();
    if (e.type === 'reconnected') load();
  });

  useEffect(() => {
    const t = window.setInterval(() => setTyping((ty) => Object.fromEntries(Object.entries(ty).filter(([, v]) => Date.now() - v.at < 4000))), 2000);
    return () => window.clearInterval(t);
  }, []);

  if (error) return <ErrorState error={error} />;
  if (!channel) return <Loading />;

  const dmName = channel.kind === 'dm' ? channel.members.filter((m) => m.id !== me!.user.id).map((m) => m.name).join(', ') || 'Just you' : channel.name;
  const typingNames = Object.values(typing).map((t) => t.name);

  const actions = {
    react: async (m: Message, emoji: string) => act(() => api.post(`/messages/${m.id}/reactions`, { emoji })),
    pin: async (m: Message) => act(() => api.post(`/messages/${m.id}/pin`), m.pinned ? 'Unpinned' : 'Pinned to channel'),
    save: async (m: Message) => {
      const res = await act(() => api.post<{ saved: boolean }>(`/messages/${m.id}/save`), m.saved ? 'Removed from saved' : 'Saved for later');
      if (res) setMessages((prev) => prev.map((x) => (x.id === m.id ? { ...x, saved: res.saved } : x)));
    },
    edit: async (m: Message, body: string) => act(() => api.patch(`/messages/${m.id}`, { body })),
    remove: async (m: Message) => {
      if (confirm('Delete this message?')) await act(() => api.del(`/messages/${m.id}`), 'Message deleted');
    },
    ack: async (m: Message) => act(() => api.post(`/messages/${m.id}/ack`), 'Acknowledged'),
    reply: (m: Message) => setThreadId(m.id),
    task: (m: Message) => setTaskFrom(m),
    decision: (m: Message) => setDecisionFrom(m),
  };

  return (
    <div className={`chat-layout ${threadId || panel ? 'with-panel' : ''}`}>
      <section className="chat-main" aria-label={`Conversation ${dmName}`}>
        <header className="chat-head">
          <div className="chat-title">
            <Icon name={channelIcon(channel)} />
            <div>
              <h1>{dmName}</h1>
              <p className="muted small">
                {channel.project && (
                  <Link to={`/projects/${channel.project.id}`}>
                    <span className={`project-dot bg-${channel.project.color}`} /> {channel.project.name}
                  </Link>
                )}
                {channel.project && channel.topic && ' · '}
                {channel.topic}
              </p>
            </div>
          </div>
          <div className="chat-actions">
            <button className="icon-btn" onClick={() => setPanel(panel === 'members' ? null : 'members')} aria-label="Members" title="Members">
              <Icon name="users" />
              <span className="count">{channel.members.length}</span>
            </button>
            <button className="icon-btn" onClick={() => setPanel(panel === 'pins' ? null : 'pins')} aria-label="Pinned messages" title="Pinned">
              <Icon name="pin" />
            </button>
            <button className="icon-btn" onClick={() => setPanel(panel === 'files' ? null : 'files')} aria-label="Files" title="Files">
              <Icon name="paperclip" />
            </button>
            {channel.can_post && (
              <button className="icon-btn" onClick={() => setMeeting(true)} aria-label="Schedule a meeting" title="Schedule a meeting">
                <Icon name="video" />
              </button>
            )}
            {channel.kind !== 'dm' && channel.joined && (
              <select
                value={channel.notify}
                aria-label="Notification preference"
                onChange={async (e) => {
                  await act(() => api.patch(`/channels/${channel.id}/preferences`, { notify: e.target.value }), 'Notification preference saved');
                  reloadChannel();
                }}
              >
                <option value="all">All activity</option>
                <option value="mentions">Mentions only</option>
                <option value="none">Muted</option>
              </select>
            )}
          </div>
        </header>

        {!channel.joined && channel.kind !== 'dm' && (
          <div className="banner">
            You are previewing #{channel.name}.{' '}
            <button
              className="link-btn"
              onClick={async () => {
                await act(() => api.post(`/channels/${channel.id}/join`), `Joined #${channel.name}`);
                reloadChannel();
              }}
            >
              Join channel
            </button>
          </div>
        )}

        <div
          className="messages"
          ref={scroller}
          onScroll={(e) => {
            const el = e.currentTarget;
            stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
        >
          {hasMore && (
            <button className="btn sm load-more" onClick={() => ((stickToBottom.current = false), load(messages[0]?.created_at))}>
              Load earlier messages
            </button>
          )}
          {loaded && !messages.length && (
            <Empty icon={channelIcon(channel)} title={channel.kind === 'dm' ? `This is the start of your conversation` : `Welcome to #${channel.name}`}>
              {channel.topic || 'Say hello, share a file or record a decision.'}
            </Empty>
          )}
          {!loaded && <Loading />}
          {messages.map((m, i) => {
            const prev = messages[i - 1];
            const grouped = prev && prev.user?.id === m.user?.id && new Date(m.created_at).getTime() - new Date(prev.created_at).getTime() < 5 * 60_000;
            const newDay = !prev || new Date(prev.created_at).toDateString() !== new Date(m.created_at).toDateString();
            return (
              <div key={m.id}>
                {newDay && (
                  <div className="day-divider">
                    <span>{new Date(m.created_at).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</span>
                  </div>
                )}
                <MessageItem
                  message={m}
                  grouped={!!grouped && !newDay}
                  highlight={m.id === highlight}
                  isAnnouncement={channel.kind === 'announcement'}
                  canPost={channel.can_post}
                  actions={actions}
                />
              </div>
            );
          })}
        </div>
        <div className="typing" aria-live="polite">
          {typingNames.length > 0 && `${typingNames.join(', ')} ${typingNames.length > 1 ? 'are' : 'is'} typing…`}
        </div>
        {channel.can_post ? (
          <Composer channelId={channel.id} placeholder={channel.kind === 'dm' ? `Message ${dmName}` : `Message #${channel.name}`} members={channel.members} />
        ) : (
          <p className="composer-disabled muted">
            {channel.kind === 'announcement' ? 'Only leads and admins post here. You can reply in threads and acknowledge announcements.' : 'You cannot post in this channel.'}
          </p>
        )}
      </section>

      {threadId && (
        <ThreadPanel
          messageId={threadId}
          onClose={() => {
            setThreadId(null);
            if (params.get('message')) setParams({});
          }}
          members={channel.members}
          actions={actions}
          isAnnouncement={channel.kind === 'announcement'}
          aiExcluded={channel.ai_excluded}
        />
      )}
      {!threadId && panel && (
        <aside className="side-panel" aria-label="Channel details">
          <div className="panel-head">
            <h2>{panel === 'members' ? 'Members' : panel === 'pins' ? 'Pinned' : 'Files'}</h2>
            <button className="icon-btn" onClick={() => setPanel(null)} aria-label="Close panel">
              <Icon name="x" />
            </button>
          </div>
          {panel === 'members' && (
            <>
              {channel.members.map((m) => (
                <Link key={m.id} to={`/people/${m.id}`} className="list-row">
                  <Avatar user={m} size="sm" showPresence />
                  <span className="grow">
                    <strong>{m.name}</strong>
                    <small className="muted block">{m.title || m.role}</small>
                  </span>
                </Link>
              ))}
              {channel.kind !== 'dm' && me!.role !== 'guest' && channel.joined && (
                <button className="btn block" onClick={() => setAdding(true)}>
                  <Icon name="plus" size={15} /> Add people
                </button>
              )}
              {channel.kind !== 'dm' && channel.joined && (
                <button
                  className="btn block danger-text"
                  onClick={async () => {
                    await act(() => api.post(`/channels/${channel.id}/leave`), `Left #${channel.name}`);
                    navigate('/channels');
                  }}
                >
                  Leave channel
                </button>
              )}
              {channel.can_manage && channel.kind !== 'dm' && <ChannelSettings channel={channel} onSaved={reloadChannel} />}
            </>
          )}
          {panel === 'pins' && <PinsList channelId={channel.id} />}
          {panel === 'files' && <FilesList channelId={channel.id} />}
        </aside>
      )}

      <Modal open={!!taskFrom} onClose={() => setTaskFrom(null)} title="Create a task from this message" eyebrow="TURN DISCUSSION INTO DELIVERY">
        {taskFrom && (
          <>
            <blockquote className="quote">{plainMentions(taskFrom.body).slice(0, 300)}</blockquote>
            <NewTaskForm
              endpoint={`/messages/${taskFrom.id}/task`}
              projectId={channel.project?.id}
              defaults={{ title: plainMentions(taskFrom.body).split('\n')[0].slice(0, 200) }}
              onDone={() => setTaskFrom(null)}
            />
          </>
        )}
      </Modal>
      <Modal open={!!decisionFrom} onClose={() => setDecisionFrom(null)} title="Record a decision" eyebrow="DECISION LOG">
        {decisionFrom && <DecisionForm message={decisionFrom} onDone={() => setDecisionFrom(null)} />}
      </Modal>
      <Modal open={meeting} onClose={() => setMeeting(false)} title="Schedule a meeting from this channel" wide>
        <NewMeetingForm onDone={() => setMeeting(false)} channelId={channel.id} projectId={channel.project?.id} />
      </Modal>
      <AddMembers open={adding} onClose={() => setAdding(false)} channel={channel} onDone={reloadChannel} />
    </div>
  );
}

function ChannelSettings({ channel, onSaved }: { channel: ChannelDetail; onSaved: () => void }) {
  const act = useAction();
  const navigate = useNavigate();
  const [topic, setTopic] = useState(channel.topic);
  return (
    <div className="panel-section">
      <h3>Channel settings</h3>
      <Field label="Topic">
        <input value={topic} onChange={(e) => setTopic(e.target.value)} />
      </Field>
      <button
        className="btn sm"
        onClick={async () => {
          await act(() => api.patch(`/channels/${channel.id}`, { topic }), 'Topic updated');
          onSaved();
        }}
      >
        Save topic
      </button>
      <label className="check-inline">
        <input
          type="checkbox"
          checked={!channel.ai_excluded}
          onChange={async (e) => {
            await act(() => api.patch('/ai/exclusions', { channelId: channel.id, excluded: !e.target.checked }), e.target.checked ? 'AI assistance allowed' : 'AI assistance turned off here');
            onSaved();
          }}
        />{' '}
        Allow AI assistance in this channel
      </label>
      <button
        className="btn sm danger-text"
        onClick={async () => {
          if (!confirm(`Archive #${channel.name}? Messages are kept but no one can post.`)) return;
          await act(() => api.patch(`/channels/${channel.id}`, { archived: true }), 'Channel archived');
          navigate('/channels');
        }}
      >
        Archive channel
      </button>
    </div>
  );
}

function AddMembers({ open, onClose, channel, onDone }: { open: boolean; onClose: () => void; channel: ChannelDetail; onDone: () => void }) {
  const { people } = useSession();
  const act = useAction();
  const [ids, setIds] = useState<string[]>([]);
  return (
    <Modal open={open} onClose={onClose} title={`Add people to #${channel.name}`}>
      <form
        className="form"
        onSubmit={async (e) => {
          e.preventDefault();
          await act(() => api.post(`/channels/${channel.id}/members`, { userIds: ids }), 'People added');
          setIds([]);
          onClose();
          onDone();
        }}
      >
        <PeoplePicker people={people} value={ids} onChange={setIds} exclude={channel.members.map((m) => m.id)} />
        <div className="form-actions">
          <button className="btn primary" disabled={!ids.length}>
            Add
          </button>
        </div>
      </form>
    </Modal>
  );
}

function DecisionForm({ message, onDone }: { message: Message; onDone: () => void }) {
  const act = useAction();
  const [title, setTitle] = useState(plainMentions(message.body).split('\n')[0].slice(0, 200));
  const [rationale, setRationale] = useState('');
  return (
    <form
      className="form"
      onSubmit={async (e) => {
        e.preventDefault();
        const ok = await act(() => api.post('/decisions', { title, rationale, messageId: message.id }), 'Decision recorded');
        if (ok) onDone();
      }}
    >
      <Field label="Decision">
        <input required value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
      </Field>
      <Field label="Rationale (optional)">
        <textarea rows={3} value={rationale} onChange={(e) => setRationale(e.target.value)} placeholder="Why was this decided? What alternatives were considered?" />
      </Field>
      <div className="form-actions">
        <button type="button" className="btn" onClick={onDone}>
          Cancel
        </button>
        <button className="btn primary">Record decision</button>
      </div>
    </form>
  );
}

function PinsList({ channelId }: { channelId: string }) {
  const { data } = useApi<Message[]>(`/channels/${channelId}/pins`);
  if (!data) return <Loading />;
  if (!data.length) return <p className="muted pad">Nothing pinned yet. Pin important messages from their menu.</p>;
  return (
    <div>
      {data.map((m) => (
        <Link key={m.id} to={`/channels/${channelId}?message=${m.id}`} className="pin-item">
          <strong>{m.user?.name}</strong> <small className="muted">{timeAgo(m.created_at)}</small>
          <Markdown text={m.body} compact />
        </Link>
      ))}
    </div>
  );
}

function FilesList({ channelId }: { channelId: string }) {
  const { data } = useApi<{ id: string; name: string; size: number; owner_name: string; created_at: string }[]>(`/channels/${channelId}/files`);
  if (!data) return <Loading />;
  if (!data.length) return <p className="muted pad">No files shared here yet.</p>;
  return (
    <div>
      {data.map((f) => (
        <Link key={f.id} to={`/files/${f.id}`} className="list-row">
          <Icon name="file" />
          <span className="grow">
            <strong>{f.name}</strong>
            <small className="muted block">
              {f.owner_name} · {bytes(f.size)} · {timeAgo(f.created_at)}
            </small>
          </span>
        </Link>
      ))}
    </div>
  );
}

// ======================= Messages =======================

interface Actions {
  react: (m: Message, emoji: string) => void;
  pin: (m: Message) => void;
  save: (m: Message) => void;
  edit: (m: Message, body: string) => Promise<unknown>;
  remove: (m: Message) => void;
  ack: (m: Message) => void;
  reply: (m: Message) => void;
  task: (m: Message) => void;
  decision: (m: Message) => void;
}

function MessageItem({
  message: m,
  grouped,
  highlight,
  isAnnouncement,
  canPost,
  actions,
  inThread = false,
}: {
  message: Message;
  grouped: boolean;
  highlight?: boolean;
  isAnnouncement: boolean;
  canPost: boolean;
  actions: Actions;
  inThread?: boolean;
}) {
  const { me } = useSession();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(m.body);
  const [picker, setPicker] = useState(false);
  const [menu, setMenu] = useState(false);
  const [remind, setRemind] = useState(false);
  const mine = m.user?.id === me!.user.id;
  const isAdmin = me!.role === 'admin' || me!.role === 'owner';
  const policy = me!.workspace.message_edit_policy;
  const canEdit = policy === 'author' ? mine : policy === 'admins' ? isAdmin : false;

  if (m.deleted) {
    return (
      <div className={`message deleted ${grouped ? 'grouped' : ''}`} id={`m-${m.id}`}>
        <span className="msg-gutter" />
        <p className="muted small">
          <Icon name="trash" size={13} /> This message was deleted.
          {m.reply_count > 0 && !inThread && (
            <button className="link-btn" onClick={() => actions.reply(m)}>
              {' '}
              View {m.reply_count} repl{m.reply_count === 1 ? 'y' : 'ies'}
            </button>
          )}
        </p>
      </div>
    );
  }

  return (
    <article className={`message ${grouped ? 'grouped' : ''} ${highlight ? 'highlight' : ''} ${m.urgent ? 'urgent' : ''}`} id={`m-${m.id}`}>
      <span className="msg-gutter">{grouped ? <time className="hover-time">{timeOf(m.created_at)}</time> : <Avatar user={m.user} size="md" />}</span>
      <div className="msg-body">
        {!grouped && (
          <header>
            <Link to={`/people/${m.user?.id}`} className="msg-author">
              {m.user?.name}
            </Link>
            <time dateTime={m.created_at} title={new Date(m.created_at).toLocaleString()}>
              {timeOf(m.created_at)}
            </time>
            {m.urgent && <span className="pill prio-urgent">Urgent</span>}
            {m.pinned && (
              <span className="pill">
                <Icon name="pin" size={11} /> Pinned
              </span>
            )}
          </header>
        )}
        {editing ? (
          <form
            className="edit-form"
            onSubmit={async (e) => {
              e.preventDefault();
              await actions.edit(m, draft);
              setEditing(false);
            }}
          >
            <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={3} autoFocus aria-label="Edit message" />
            <div className="form-actions">
              <button type="button" className="btn sm" onClick={() => setEditing(false)}>
                Cancel
              </button>
              <button className="btn primary sm">Save</button>
            </div>
          </form>
        ) : (
          m.body && (
            <>
              <Markdown text={m.body} compact />
              <VideoLinks text={m.body} />
            </>
          )
        )}
        {m.edited_at && !editing && <small className="muted edited">(edited)</small>}
        {m.files.length > 0 && (
          <div className="attachments">
            {m.files.map((f) =>
              f.mime?.startsWith('image/') ? (
                <Link key={f.id} to={`/files/${f.id}`} className="image-attachment">
                  <img src={`/api/files/${f.id}/download?inline=1`} alt={f.name} loading="lazy" />
                </Link>
              ) : isPlayable(f.mime) ? (
                <MediaAttachment key={f.id} file={f} />
              ) : (
                <Link key={f.id} to={`/files/${f.id}`} className="file-chip">
                  <Icon name="file" size={15} /> {f.name} <small className="muted">{bytes(f.size)}</small>
                </Link>
              ),
            )}
          </div>
        )}
        {(m.tasks.length > 0 || m.decisions.length > 0) && (
          <div className="linked">
            {m.tasks.map((t) => (
              <Link key={t.id} to={`/tasks/${t.id}`} className="linked-item">
                <Icon name="task" size={14} /> {t.title} <StatusPill status={t.status} />
              </Link>
            ))}
            {m.decisions.map((d) => (
              <span key={d.id} className="linked-item decision">
                <Icon name="gavel" size={14} /> Decision: {d.title}
              </span>
            ))}
          </div>
        )}
        {(m.reactions.length > 0 || (isAnnouncement && !inThread)) && (
          <div className="reactions">
            {m.reactions.map((r) => (
              <button key={r.emoji} className={`reaction ${r.mine ? 'mine' : ''}`} onClick={() => actions.react(m, r.emoji)} aria-pressed={r.mine} aria-label={`${r.emoji} ${r.count}`}>
                {r.emoji} {r.count}
              </button>
            ))}
            {isAnnouncement && !inThread && !m.parent_id && (
              <button className={`reaction ack ${m.acked ? 'mine' : ''}`} onClick={() => !m.acked && actions.ack(m)} disabled={m.acked}>
                <Icon name="check" size={13} /> {m.acked ? 'Acknowledged' : 'Acknowledge'} · {m.ack_count}
              </button>
            )}
          </div>
        )}
        {m.reply_count > 0 && !inThread && (
          <button className="thread-link" onClick={() => actions.reply(m)}>
            <Icon name="thread" size={14} /> {m.reply_count} repl{m.reply_count === 1 ? 'y' : 'ies'}
            <span className="muted"> · last {timeAgo(m.last_reply_at)}</span>
          </button>
        )}
      </div>
      <div className="msg-toolbar" role="toolbar" aria-label="Message actions">
        <button className="icon-btn xs" onClick={() => setPicker((p) => !p)} aria-label="Add reaction" title="React">
          <Icon name="smile" size={15} />
        </button>
        {!inThread && (
          <button className="icon-btn xs" onClick={() => actions.reply(m)} aria-label="Reply in thread" title="Reply in thread">
            <Icon name="thread" size={15} />
          </button>
        )}
        <button className="icon-btn xs" onClick={() => actions.task(m)} aria-label="Create task" title="Create task">
          <Icon name="task" size={15} />
        </button>
        <button className="icon-btn xs" onClick={() => setMenu((v) => !v)} aria-label="More actions" title="More">
          <Icon name="more" size={15} />
        </button>
        {picker && (
          <div className="emoji-picker">
            {EMOJI.map((e) => (
              <button
                key={e}
                onClick={() => {
                  actions.react(m, e);
                  setPicker(false);
                }}
                aria-label={`React ${e}`}
              >
                {e}
              </button>
            ))}
          </div>
        )}
        {menu && (
          <div className="popover right" role="menu" onClick={() => setMenu(false)}>
            <button role="menuitem" onClick={() => actions.decision(m)}>
              <Icon name="gavel" size={15} /> Record decision
            </button>
            {canPost && (
              <button role="menuitem" onClick={() => actions.pin(m)}>
                <Icon name="pin" size={15} /> {m.pinned ? 'Unpin' : 'Pin to channel'}
              </button>
            )}
            <button role="menuitem" onClick={() => actions.save(m)}>
              <Icon name="bookmark" size={15} /> {m.saved ? 'Remove from saved' : 'Save for later'}
            </button>
            <button role="menuitem" onClick={() => setRemind(true)}>
              <Icon name="clock" size={15} /> Remind me about this
            </button>
            <button role="menuitem" onClick={() => navigator.clipboard?.writeText(`${location.origin}/channels/${m.channel_id}?message=${m.parent_id ?? m.id}`)}>
              <Icon name="link" size={15} /> Copy link
            </button>
            {canEdit && (
              <button
                role="menuitem"
                onClick={() => {
                  setDraft(m.body);
                  setEditing(true);
                }}
              >
                <Icon name="edit" size={15} /> Edit
              </button>
            )}
            {(canEdit || isAdmin) && (
              <button role="menuitem" className="danger-text" onClick={() => actions.remove(m)}>
                <Icon name="trash" size={15} /> Delete
              </button>
            )}
          </div>
        )}
      </div>
      <RemindModal open={remind} onClose={() => setRemind(false)} messageId={m.id} />
    </article>
  );
}

function ThreadPanel({
  messageId,
  onClose,
  members,
  actions,
  isAnnouncement,
  aiExcluded,
}: {
  messageId: string;
  onClose: () => void;
  members: { id: string; name: string; color: string }[];
  actions: Actions;
  isAnnouncement: boolean;
  aiExcluded: boolean;
}) {
  const { data, error, reload } = useApi<{ root: Message; replies: Message[]; channel: { id: string; name: string } }>(`/messages/${messageId}/thread`);
  const end = useRef<HTMLDivElement>(null);
  useRealtime((e) => {
    if ((e.type === 'message.created' && (e.message.parent_id === data?.root.id || e.message.id === data?.root.id)) || (e.type === 'message.updated' && data && (e.parentId === data.root.id || e.messageId === data.root.id))) reload();
  });
  useEffect(() => end.current?.scrollIntoView({ block: 'end' }), [data?.replies.length]);
  return (
    <aside className="side-panel thread" aria-label="Thread">
      <div className="panel-head">
        <h2>Thread</h2>
        <button className="icon-btn" onClick={onClose} aria-label="Close thread">
          <Icon name="x" />
        </button>
      </div>
      {error && <ErrorState error={error} />}
      {!data && !error && <Loading />}
      {data && (
        <>
          {data.replies.length > 0 && <ThreadAi messageId={data.root.id} excluded={aiExcluded} />}
          <div className="thread-messages">
            <MessageItem message={data.root} grouped={false} isAnnouncement={isAnnouncement} canPost actions={actions} inThread />
            <div className="thread-count">
              {data.replies.length} repl{data.replies.length === 1 ? 'y' : 'ies'}
            </div>
            {data.replies.map((r) => (
              <MessageItem key={r.id} message={r} grouped={false} isAnnouncement={false} canPost actions={actions} inThread />
            ))}
            <div ref={end} />
          </div>
          <Composer channelId={data.root.channel_id} parentId={data.root.id} placeholder="Reply…" members={members} onSent={reload} />
        </>
      )}
    </aside>
  );
}

// ======================= Composer =======================

function Composer({
  channelId,
  parentId,
  placeholder,
  members,
  onSent,
}: {
  channelId: string;
  parentId?: string;
  placeholder: string;
  members: { id: string; name: string; color: string }[];
  onSent?: () => void;
}) {
  const { people } = useSession();
  const act = useAction();
  const storageKey = `softex.draft.${channelId}.${parentId ?? 'root'}`;
  const [text, setText] = useState(() => {
    try {
      return localStorage.getItem(storageKey) ?? '';
    } catch {
      return '';
    }
  });
  const [mentions, setMentions] = useState<Record<string, string>>({});
  const [query, setQuery] = useState<string | null>(null);
  const [files, setFiles] = useState<{ id: string; name: string; preview?: string; kind?: 'image' | 'video' }[]>([]);
  const [urgent, setUrgent] = useState(false);
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [later, setLater] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const lastTyping = useRef(0);

  useEffect(() => {
    try {
      if (text) localStorage.setItem(storageKey, text);
      else localStorage.removeItem(storageKey);
    } catch {
      /* ignore */
    }
  }, [text, storageKey]);

  const candidates = useMemo(() => {
    if (query === null) return [];
    const pool = [...members, ...people.filter((p) => !members.some((m) => m.id === p.id))];
    return pool.filter((p) => p.name.toLowerCase().includes(query.toLowerCase())).slice(0, 6);
  }, [query, members, people]);

  const onChange = (value: string) => {
    setText(value);
    const caret = ref.current?.selectionStart ?? value.length;
    const match = value.slice(0, caret).match(/(?:^|\s)@([\w.-]*)$/);
    setQuery(match ? match[1] : null);
    if (Date.now() - lastTyping.current > 3000) {
      lastTyping.current = Date.now();
      realtime.send({ type: 'typing', channelId });
    }
  };

  const pick = (p: { id: string; name: string }) => {
    const caret = ref.current?.selectionStart ?? text.length;
    const before = text.slice(0, caret).replace(/@([\w.-]*)$/, `@${p.name} `);
    setText(before + text.slice(caret));
    setMentions((m) => ({ ...m, [p.name]: p.id }));
    setQuery(null);
    window.setTimeout(() => ref.current?.focus(), 0);
  };

  const send = async () => {
    if ((!text.trim() && !files.length) || sending) return;
    let body = text.trim();
    for (const [name, id] of Object.entries(mentions)) body = body.split(`@${name}`).join(`@[${name}](${id})`);
    setSending(true);
    const ok = await act(() => api.post(`/channels/${channelId}/messages`, { body, parentId, fileIds: files.map((f) => f.id), urgent }));
    setSending(false);
    if (ok) {
      setText('');
      for (const f of files) if (f.preview) URL.revokeObjectURL(f.preview);
      setFiles([]);
      setMentions({});
      setUrgent(false);
      onSent?.();
    }
  };

  const schedule = async (sendAt: string) => {
    let body = text.trim();
    for (const [name, id] of Object.entries(mentions)) body = body.split(`@${name}`).join(`@[${name}](${id})`);
    const ok = await act(() => api.post(`/channels/${channelId}/scheduled-messages`, { body, parentId, sendAt }), 'Message scheduled. Find it under Later.');
    if (ok) {
      setText('');
      setMentions({});
    }
    return ok;
  };

  const upload = async (file: File) => {
    setUploading(true);
    const form = new FormData();
    form.append('file', file);
    form.append('channelId', channelId);
    const res = await act(() => api.upload<{ id: string; name: string }>('/files', form));
    setUploading(false);
    // Show a preview of images and videos while the message is being written.
    const preview = /^(image|video)\//.test(file.type) ? URL.createObjectURL(file) : undefined;
    if (res) setFiles((f) => [...f, { id: res.id, name: res.name, preview, kind: file.type.startsWith('video/') ? 'video' : 'image' }]);
    else if (preview) URL.revokeObjectURL(preview);
  };

  return (
    <div
      className="composer"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const file = e.dataTransfer.files[0];
        if (file) upload(file);
      }}
    >
      {candidates.length > 0 && (
        <div className="mention-menu" role="listbox" aria-label="Mention someone">
          {candidates.map((p) => (
            <button key={p.id} role="option" aria-selected={false} onMouseDown={(e) => (e.preventDefault(), pick(p))}>
              <Avatar user={p} size="xs" /> {p.name}
            </button>
          ))}
        </div>
      )}
      {files.length > 0 && (
        <div className="pending-files">
          {files.map((f) => (
            <span key={f.id} className="chip">
              {f.preview ? (
                f.kind === 'video' ? (
                  <video className="pending-thumb" src={`${f.preview}#t=0.1`} muted playsInline preload="metadata" aria-hidden="true" />
                ) : (
                  <img className="pending-thumb" src={f.preview} alt="" />
                )
              ) : (
                <Icon name="file" size={13} />
              )}{' '}
              {f.name}
              <button
                onClick={() => {
                  if (f.preview) URL.revokeObjectURL(f.preview);
                  setFiles(files.filter((x) => x.id !== f.id));
                }}
                aria-label={`Remove ${f.name}`}
              >
                <Icon name="x" size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
      <textarea
        ref={ref}
        value={text}
        rows={Math.min(8, Math.max(1, text.split('\n').length))}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !(e.nativeEvent as KeyboardEvent).isComposing) {
            if (candidates.length) {
              e.preventDefault();
              pick(candidates[0]);
              return;
            }
            e.preventDefault();
            send();
          }
          if (e.key === 'Escape') setQuery(null);
        }}
      />
      <div className="composer-bar">
        <button className="icon-btn xs" onClick={() => fileInput.current?.click()} aria-label="Attach a file" title="Attach a file" disabled={uploading}>
          <Icon name="paperclip" size={16} />
        </button>
        <input ref={fileInput} type="file" hidden onChange={(e) => e.target.files?.[0] && (upload(e.target.files[0]), (e.target.value = ''))} />
        <button className="icon-btn xs" onClick={() => onChange(`${text}${text && !text.endsWith(' ') ? ' ' : ''}@`)} aria-label="Mention someone" title="Mention">
          @
        </button>
        <label className={`urgent-toggle ${urgent ? 'on' : ''}`} title="Urgent messages break through quiet hours and focus time">
          <input type="checkbox" checked={urgent} onChange={(e) => setUrgent(e.target.checked)} /> Urgent
        </label>
        <span className="muted small hide-mobile">**bold**, *italic*, `code` · Shift+Enter for a new line</span>
        <button
          className="icon-btn xs"
          onClick={() => setLater(true)}
          disabled={!text.trim() || files.length > 0}
          aria-label="Send later"
          title={files.length ? 'Attachments cannot be scheduled' : 'Send later'}
        >
          <Icon name="clock" size={16} />
        </button>
        <button className="btn primary sm send" onClick={send} disabled={sending || uploading || (!text.trim() && !files.length)} aria-label="Send">
          <Icon name="send" size={15} />
        </button>
      </div>
      <WhenModal open={later} onClose={() => setLater(false)} eyebrow="SEND LATER" title="Schedule this message" confirmLabel="Schedule" onPick={schedule} />
    </div>
  );
}
