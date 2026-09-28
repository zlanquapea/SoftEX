import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Channel, type ForwardedMessage, type Message, type MessagePoll } from '../api';
import { timeAgo } from '../format';
import { useApi } from '../hooks';
import { useSession } from '../session';
import { Icon } from './Icon';
import { Markdown } from './Markdown';
import { Field, Modal, useAction } from './ui';

// ---------- Polls ----------

export type Poll = MessagePoll;

export function PollCard({ poll, authorId, onChange }: { poll: Poll; authorId?: string; onChange: (p: Poll) => void }) {
  const act = useAction();
  const { me } = useSession();
  const [busy, setBusy] = useState(false);
  const total = poll.options.reduce((s, o) => s + o.votes, 0);
  const voted = poll.my_votes.length > 0;
  const canClose = authorId === me!.user.id || me!.role === 'admin' || me!.role === 'owner';
  const vote = async (index: number) => {
    if (poll.closed || busy) return;
    const next = poll.multiple ? (poll.my_votes.includes(index) ? poll.my_votes.filter((i) => i !== index) : [...poll.my_votes, index]) : poll.my_votes.includes(index) ? [] : [index];
    setBusy(true);
    const updated = await act(() => api.post<Poll>(`/polls/${poll.id}/vote`, { options: next }));
    setBusy(false);
    if (updated) onChange(updated);
  };
  return (
    <div className={`poll ${poll.closed ? 'closed' : ''}`} role="group" aria-label={`Poll: ${poll.question}`}>
      <div className="poll-head">
        <Icon name="poll" size={16} />
        <strong>{poll.question}</strong>
      </div>
      <small className="muted">
        {poll.closed ? 'Poll closed' : poll.multiple ? 'Choose any' : 'Choose one'}
        {poll.anonymous && ' · anonymous'} · {poll.voters} voter{poll.voters === 1 ? '' : 's'}
      </small>
      {poll.options.map((o, i) => {
        const share = total ? Math.round((o.votes / total) * 100) : 0;
        const mine = poll.my_votes.includes(i);
        return (
          <button
            key={i}
            className={`poll-option ${mine ? 'mine' : ''}`}
            onClick={() => vote(i)}
            disabled={poll.closed || busy}
            aria-pressed={mine}
            title={o.voters.length ? o.voters.join(', ') : undefined}
          >
            <i style={{ width: voted || poll.closed ? `${share}%` : 0 }} />
            <span className="poll-label">
              {mine && <Icon name="check" size={13} />} {o.label}
            </span>
            {(voted || poll.closed) && (
              <span className="poll-count">
                {o.votes} · {share}%
              </span>
            )}
          </button>
        );
      })}
      {canClose && (
        <button
          className="link-btn small"
          onClick={async () => {
            const res = await act(() => api.post<{ closed: boolean }>(`/polls/${poll.id}/close`));
            if (res) onChange({ ...poll, closed: res.closed });
          }}
        >
          {poll.closed ? 'Reopen poll' : 'Close poll'}
        </button>
      )}
    </div>
  );
}

export function PollModal({ open, onClose, channelId, parentId, onSent }: { open: boolean; onClose: () => void; channelId: string; parentId?: string; onSent?: () => void }) {
  const act = useAction();
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState(['', '']);
  const [multiple, setMultiple] = useState(false);
  const [anonymous, setAnonymous] = useState(false);
  const clean = options.map((o) => o.trim()).filter(Boolean);
  return (
    <Modal open={open} onClose={onClose} title="Create a poll">
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          const ok = await act(() => api.post(`/channels/${channelId}/polls`, { question, options: clean, multiple, anonymous, parentId }));
          if (!ok) return;
          setQuestion('');
          setOptions(['', '']);
          onSent?.();
          onClose();
        }}
      >
        <Field label="Question">
          <input value={question} onChange={(e) => setQuestion(e.target.value)} required maxLength={300} placeholder="Where should we hold the staff retreat?" autoFocus />
        </Field>
        {options.map((o, i) => (
          <div key={i} className="row-gap">
            <input className="grow" value={o} onChange={(e) => setOptions(options.map((x, j) => (j === i ? e.target.value : x)))} placeholder={`Option ${i + 1}`} aria-label={`Option ${i + 1}`} maxLength={120} />
            {options.length > 2 && (
              <button type="button" className="icon-btn xs" aria-label={`Remove option ${i + 1}`} onClick={() => setOptions(options.filter((_, j) => j !== i))}>
                <Icon name="x" size={12} />
              </button>
            )}
          </div>
        ))}
        {options.length < 10 && (
          <button type="button" className="btn sm" onClick={() => setOptions([...options, ''])}>
            <Icon name="plus" size={14} /> Add option
          </button>
        )}
        <label className="check-inline">
          <input type="checkbox" checked={multiple} onChange={(e) => setMultiple(e.target.checked)} /> Allow more than one choice
        </label>
        <label className="check-inline">
          <input type="checkbox" checked={anonymous} onChange={(e) => setAnonymous(e.target.checked)} /> Anonymous — hide who voted for what
        </label>
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!question.trim() || clean.length < 2}>
            Post poll
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ---------- Forwarding ----------

export type Forwarded = ForwardedMessage;

export function ForwardedQuote({ f }: { f: Forwarded }) {
  if (f.deleted) return <blockquote className="forwarded muted">Forwarded message was deleted.</blockquote>;
  return (
    <blockquote className="forwarded">
      <small className="muted">
        <Icon name="forward" size={12} /> Forwarded from <strong>{f.user?.name}</strong>
        {f.channel_name && (
          <>
            {' '}
            in <Link to={`/channels/${f.channel_id}?message=${f.id}`}>#{f.channel_name}</Link>
          </>
        )}{' '}
        · {timeAgo(f.created_at)}
      </small>
      <Markdown text={f.body ?? ''} compact />
    </blockquote>
  );
}

export function ForwardModal({ message, onClose }: { message: Message | null; onClose: () => void }) {
  const act = useAction();
  const { data: channels } = useApi<Channel[]>(message ? '/channels' : null);
  const [target, setTarget] = useState('');
  const [comment, setComment] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    setTarget('');
    setComment('');
    setQ('');
  }, [message?.id]);
  const { me } = useSession();
  const label = (c: Channel) =>
    c.kind === 'dm' ? c.members?.filter((m) => m.id !== me!.user.id).map((m) => m.name).join(', ') || 'Direct message' : `#${c.name}`;
  const options = (channels ?? []).filter((c) => (c.kind === 'dm' || c.joined) && (!q || label(c).toLowerCase().includes(q.toLowerCase())));
  return (
    <Modal open={!!message} onClose={onClose} title="Forward message">
      {message && (
        <form
          className="stack"
          onSubmit={async (e) => {
            e.preventDefault();
            const ok = await act(() => api.post(`/messages/${message.id}/forward`, { channelId: target, comment }), 'Message forwarded');
            if (ok) onClose();
          }}
        >
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a channel or conversation" aria-label="Find a channel" />
          <div className="forward-targets" role="radiogroup" aria-label="Forward to">
            {options.slice(0, 30).map((c) => (
              <label key={c.id} className={`check-row ${target === c.id ? 'on' : ''}`}>
                <input type="radio" name="forward-target" checked={target === c.id} onChange={() => setTarget(c.id)} />
                <Icon name={c.kind === 'dm' ? 'chat' : c.kind === 'private' ? 'lock' : 'hash'} size={14} /> {label(c)}
              </label>
            ))}
          </div>
          <Field label="Add a note (optional)">
            <input value={comment} onChange={(e) => setComment(e.target.value)} maxLength={10000} />
          </Field>
          <blockquote className="forwarded">
            <small className="muted">{message.user?.name}</small>
            <Markdown text={message.body} compact />
          </blockquote>
          <div className="form-actions">
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button className="btn primary" disabled={!target}>
              Forward
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

// ---------- Voice notes ----------

const pickType = () => {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const [mime, ext] of [
    ['audio/webm;codecs=opus', 'weba'],
    ['audio/webm', 'weba'],
    ['audio/mp4', 'm4a'],
    ['audio/ogg;codecs=opus', 'ogg'],
  ] as const) {
    if (MediaRecorder.isTypeSupported(mime)) return { mime, ext };
  }
  return null;
};

/** Hold-free voice recording: press to start, press again to attach. */
export function VoiceNoteButton({ onRecorded, disabled }: { onRecorded: (file: File) => void; disabled?: boolean }) {
  const [recording, setRecording] = useState<{ recorder: MediaRecorder; started: number } | null>(null);
  const [, tick] = useState(0);
  const chunks = useRef<Blob[]>([]);
  const type = pickType();
  useEffect(() => {
    if (!recording) return;
    const t = window.setInterval(() => tick((n) => n + 1), 500);
    // Stop at five minutes so files stay small.
    const limit = window.setTimeout(() => recording.recorder.stop(), 5 * 60_000);
    return () => {
      window.clearInterval(t);
      window.clearTimeout(limit);
    };
  }, [recording]);
  useEffect(() => () => recording?.recorder.stream.getTracks().forEach((t) => t.stop()), [recording]);
  if (!type || !navigator.mediaDevices?.getUserMedia) return null;

  const start = async () => {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      alert('Küü needs permission to use your microphone to record a voice note.');
      return;
    }
    const recorder = new MediaRecorder(stream, { mimeType: type.mime });
    chunks.current = [];
    recorder.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
    recorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      setRecording(null);
      const blob = new Blob(chunks.current, { type: type.mime.split(';')[0] });
      if (blob.size > 0) {
        const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
        onRecorded(new File([blob], `voice-note-${stamp}.${type.ext}`, { type: blob.type }));
      }
    };
    recorder.start();
    setRecording({ recorder, started: Date.now() });
  };

  if (recording) {
    const s = Math.floor((Date.now() - recording.started) / 1000);
    return (
      <span className="voice-recording">
        <span className="rec-dot" /> {Math.floor(s / 60)}:{String(s % 60).padStart(2, '0')}
        <button
          className="btn sm"
          onClick={() => {
            recording.recorder.onstop = () => {
              recording.recorder.stream.getTracks().forEach((t) => t.stop());
              setRecording(null);
            };
            recording.recorder.stop();
          }}
        >
          Cancel
        </button>
        <button className="btn primary sm" onClick={() => recording.recorder.stop()}>
          Done
        </button>
      </span>
    );
  }
  return (
    <button className="icon-btn xs" onClick={start} disabled={disabled} aria-label="Record a voice note" title="Record a voice note">
      <Icon name="mic" size={16} />
    </button>
  );
}
