import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, type Channel, type ForwardedMessage, type Message, type MessagePoll } from '../api';
import { bytes, timeOf } from '../format';
import { useApi } from '../hooks';
import { useSession } from '../session';
import { Avatar } from './Avatar';
import { Icon } from './Icon';
import { Markdown } from './Markdown';
import { CheckboxField, FormField, IconButton, Modal, notify, SearchField, useAction } from '@/components/kit';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';

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
    <Card size="sm" className={cn('poll my-1 max-w-md gap-3', poll.closed && 'opacity-80')} role="group" aria-label={`Poll: ${poll.question}`}>
      <CardHeader>
        <CardTitle className="flex items-start gap-2">
          <Icon name="poll" size={16} className="mt-0.5 shrink-0 text-primary" />
          {poll.question}
        </CardTitle>
        <CardDescription className="text-xs">
          {poll.closed ? 'Poll closed' : poll.multiple ? 'Choose any' : 'Choose one'}
          {poll.anonymous && ' · anonymous'} · {poll.voters} voter{poll.voters === 1 ? '' : 's'}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-1.5">
        {poll.options.map((o, i) => {
          const share = total ? Math.round((o.votes / total) * 100) : 0;
          const mine = poll.my_votes.includes(i);
          return (
            <button
              key={i}
              className={cn(
                'relative flex min-h-9 items-center gap-2 overflow-hidden rounded-xl border px-3 text-left text-sm transition-colors hover:bg-muted/60 disabled:cursor-default disabled:hover:bg-transparent',
                mine && 'border-primary/50',
              )}
              onClick={() => vote(i)}
              disabled={poll.closed || busy}
              aria-pressed={mine}
              title={o.voters.length ? o.voters.join(', ') : undefined}
            >
              <i className={cn('absolute inset-y-0 left-0 transition-[width] duration-300', mine ? 'bg-primary/15' : 'bg-muted')} style={{ width: voted || poll.closed ? `${share}%` : 0 }} />
              <span className="relative flex min-w-0 flex-1 items-center gap-1.5">
                {mine && <Icon name="check" size={13} className="text-primary" />} {o.label}
              </span>
              {(voted || poll.closed) && (
                <span className="relative text-xs text-muted-foreground tabular-nums">
                  {o.votes} · {share}%
                </span>
              )}
            </button>
          );
        })}
      </CardContent>
      {canClose && (
        <CardFooter>
          <Button
            variant="ghost"
            size="xs"
            onClick={async () => {
              const res = await act(() => api.post<{ closed: boolean }>(`/polls/${poll.id}/close`));
              if (res) onChange({ ...poll, closed: res.closed });
            }}
          >
            {poll.closed ? 'Reopen poll' : 'Close poll'}
          </Button>
        </CardFooter>
      )}
    </Card>
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
        className="flex flex-col gap-3"
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
        <FormField label="Question">
          <Input value={question} onChange={(e) => setQuestion(e.target.value)} required maxLength={300} placeholder="Where should we hold the staff retreat?" autoFocus />
        </FormField>
        {options.map((o, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <Input className="min-w-0 flex-1" value={o} onChange={(e) => setOptions(options.map((x, j) => (j === i ? e.target.value : x)))} placeholder={`Option ${i + 1}`} aria-label={`Option ${i + 1}`} maxLength={120} />
            {options.length > 2 && (
              <Button
                variant="ghost"
                size="icon-xs"
                type="button"
                aria-label={`Remove option ${i + 1}`}
                onClick={() => setOptions(options.filter((_, j) => j !== i))}>
                <Icon name="x" />
              </Button>
            )}
          </div>
        ))}
        {options.length < 10 && (
          <Button
            variant="outline"
            size="sm"
            type="button"
            onClick={() => setOptions([...options, ''])}>
            <Icon name="plus" data-icon="inline-start" /> Add option
          </Button>
        )}
        <CheckboxField label="Allow more than one choice" checked={multiple} onCheckedChange={setMultiple} />
        <CheckboxField label="Anonymous — hide who voted for what" checked={anonymous} onCheckedChange={setAnonymous} />
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="outline" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!question.trim() || clean.length < 2} type="submit">
            Post poll
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ---------- Forwarding ----------

export type Forwarded = ForwardedMessage;

/** Where a forward came from, in words: a channel's name, "Saved", or "a direct message". */
function sourceLabel(s: NonNullable<Forwarded['source']>) {
  if (s.personal) return 'Saved';
  if (s.kind === 'dm') return 'a direct message';
  return `#${s.channel_name}`;
}

/**
 * A forwarded copy inside a message: who wrote the original and when, what it said then, and (only for people who
 * can open it) a link back to where it came from.
 */
export function ForwardedQuote({ f }: { f: Forwarded }) {
  if (f.deleted) return <blockquote className="forwarded my-1 border-l-2 pl-3 text-sm text-muted-foreground">Forwarded message was deleted.</blockquote>;
  return (
    <blockquote className="forwarded my-1 flex max-w-full flex-col gap-1 rounded-r-xl border-l-2 border-primary/40 bg-muted/40 py-1.5 pr-3 pl-3">
      <span className="flex flex-wrap items-center gap-x-1 gap-y-0.5 text-xs text-muted-foreground">
        <Icon name="forward" size={12} aria-hidden />
        <span className="sr-only">Forwarded message.</span>
        <span aria-hidden>Forwarded ·</span>
        <strong className="font-medium text-foreground">{f.user?.name}</strong>
        {f.created_at && (
          <time dateTime={f.created_at} title={new Date(f.created_at).toLocaleString()}>
            · {new Date(f.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} {timeOf(f.created_at)}
          </time>
        )}
        {f.source && (
          <>
            {' '}
            · from{' '}
            <Link className="text-primary underline-offset-2 hover:underline" to={`/channels/${f.source.channel_id}?message=${f.source.message_id}`}>
              {sourceLabel(f.source)}
            </Link>
          </>
        )}
      </span>
      {f.body ? <Markdown text={f.body} compact /> : <span className="text-xs text-muted-foreground italic">Attachment only</span>}
      {(f.original_edited || f.original_deleted) && (
        <span className="text-[11px] text-muted-foreground">{f.original_deleted ? 'The original has since been deleted; this copy stays.' : 'The original has been edited since this was forwarded.'}</span>
      )}
    </blockquote>
  );
}

interface ForwardTarget {
  id: string;
  name: string;
  kind: Channel['kind'];
  personal: boolean;
  members?: { id: string; name: string; color: string }[];
}

const newClientId = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `f-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);

/**
 * Forward a copy of a message: pick where (Saved, a direct message, or a channel you can post in), add a note if you
 * like, check the preview, and send. Nothing is sent until Send is pressed.
 */
export function ForwardModal({ message, onClose }: { message: Message | null; onClose: () => void }) {
  const act = useAction();
  const navigate = useNavigate();
  const { data: targets, error } = useApi<ForwardTarget[]>(message ? '/forward-targets' : null);
  const [target, setTarget] = useState('');
  const [comment, setComment] = useState('');
  const [q, setQ] = useState('');
  const [sending, setSending] = useState(false);
  // One id per attempt to forward, so pressing Send twice (or retrying after a lost answer) sends it once.
  const clientId = useRef(newClientId());
  useEffect(() => {
    setTarget('');
    setComment('');
    setQ('');
    clientId.current = newClientId();
  }, [message?.id]);
  const label = (c: ForwardTarget) => (c.personal ? 'Saved' : c.kind === 'dm' ? c.members?.map((m) => m.name).join(', ') || 'Direct message' : `#${c.name}`);
  const options = (targets ?? []).filter((c) => !q || label(c).toLowerCase().includes(q.trim().toLowerCase()));
  const chosen = targets?.find((t) => t.id === target);
  // What will be copied: a forward of a forward copies the original.
  const original = message?.forwarded && !message.forwarded.deleted ? { user: message.forwarded.user?.name, body: message.forwarded.body ?? '', at: message.forwarded.created_at } : { user: message?.user?.name, body: message?.body ?? '', at: message?.created_at };
  return (
    <Modal open={!!message} onClose={onClose} title="Forward message" description="Send a copy to Saved, a person, or a channel.">
      {message && (
        <form
          className="flex flex-col gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!target || sending) return;
            setSending(true);
            const sent = await act(
              () => api.post<Message>(`/messages/${message.id}/forward`, { channelId: target, comment: comment.trim(), clientId: clientId.current }),
              chosen?.personal ? undefined : `Forwarded to ${chosen ? label(chosen) : 'the conversation'}`,
            );
            setSending(false);
            if (sent) {
              onClose();
              if (chosen?.personal) notify('Saved a copy', 'success', { action: { label: 'Open Saved', onClick: () => navigate(`/channels/${sent.channel_id}`) } });
            }
          }}
        >
          <SearchField value={q} onChange={setQ} placeholder="Find a person or channel" aria-label="Search destinations" className="max-w-none" autoFocus />
          <RadioGroup
            value={target}
            onValueChange={(v) => setTarget(v as string)}
            aria-label="Forward to"
            className="forward-targets max-h-56 grid-cols-[minmax(0,1fr)] gap-0.5 overflow-y-auto rounded-xl border p-1"
            tabIndex={0}
          >
            {error && <p className="p-3 text-sm text-destructive">Couldn’t load where you can forward to.</p>}
            {!targets && !error && <p className="p-3 text-sm text-muted-foreground">Loading…</p>}
            {targets && !options.length && <p className="p-3 text-sm text-muted-foreground">No conversation you can post in matches “{q}”.</p>}
            {options.slice(0, 50).map((c) => (
              <Label key={c.id} className={cn('flex min-h-10 w-full min-w-0 cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 font-normal hover:bg-muted', target === c.id && 'bg-accent')}>
                <RadioGroupItem value={c.id} />
                {c.kind === 'dm' && !c.personal && c.members?.length === 1 ? (
                  <Avatar user={c.members[0]} size="xs" />
                ) : (
                  <Icon name={c.personal ? 'bookmark' : c.kind === 'dm' ? 'users' : c.kind === 'private' ? 'lock' : 'hash'} size={14} className="text-muted-foreground" />
                )}
                <span className="min-w-0 flex-1 truncate">{label(c)}</span>
                {c.personal && <span className="shrink-0 text-xs text-muted-foreground">Only you</span>}
                {c.kind === 'private' && <span className="shrink-0 text-xs text-muted-foreground">Private</span>}
              </Label>
            ))}
          </RadioGroup>
          <FormField label="Add a note (optional)">
            <Textarea value={comment} onChange={(e) => setComment(e.target.value)} maxLength={10000} rows={2} placeholder="Why you’re sharing this" />
          </FormField>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">Preview</span>
            <blockquote className="flex max-h-40 flex-col gap-1 overflow-y-auto rounded-xl border-l-2 border-primary/40 bg-muted/50 py-2 pr-3 pl-3" tabIndex={0} aria-label="Message being forwarded">
              <span className="text-xs text-muted-foreground">
                <strong className="font-medium text-foreground">{original.user}</strong>
                {original.at && ` · ${new Date(original.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`}
              </span>
              {original.body ? <Markdown text={original.body} compact /> : null}
              {message.files.length > 0 && (
                <ul className="flex flex-wrap gap-1.5 pt-1" aria-label="Attachments">
                  {message.files.map((f) => (
                    <li key={f.id} className="inline-flex items-center gap-1 rounded-md border bg-background px-1.5 py-0.5 text-xs">
                      <Icon name="paperclip" size={12} /> <span className="max-w-40 truncate">{f.name}</span> <span className="text-muted-foreground">{bytes(f.size)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </blockquote>
          </div>
          <p className="text-xs text-muted-foreground">
            This sends a copy. It keeps the original author and time{message.files.length ? ', and its attachments' : ''}, and stays even if the original is edited or deleted
            (until your workspace’s retention settings remove it). People who can’t open the original won’t see where it came from.
          </p>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button variant="outline" type="button" onClick={onClose}>
              Cancel
            </Button>
            <Button disabled={!target || sending} type="submit">
              {sending ? <Spinner data-icon="inline-start" /> : <Icon name="send" data-icon="inline-start" />} Send
            </Button>
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
      notify('Küü needs permission to use your microphone to record a voice note.', 'error');
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
      <span className="flex items-center gap-2 text-sm">
        <span className="size-2 animate-pulse rounded-full bg-destructive" aria-hidden="true" />
        <span className="tabular-nums" aria-label="Recording time">
          {Math.floor(s / 60)}:{String(s % 60).padStart(2, '0')}
        </span>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            recording.recorder.onstop = () => {
              recording.recorder.stream.getTracks().forEach((t) => t.stop());
              setRecording(null);
            };
            recording.recorder.stop();
          }}>
          Cancel
        </Button>
        <Button size="sm" onClick={() => recording.recorder.stop()}>
          Done
        </Button>
      </span>
    );
  }
  return (
    <IconButton label="Record a voice note" size="icon-sm" onClick={start} disabled={disabled}>
      <Icon name="mic" />
    </IconButton>
  );
}
