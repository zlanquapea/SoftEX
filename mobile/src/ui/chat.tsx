import { AudioModule, RecordingPresets, setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus, useAudioRecorder, useAudioRecorderState } from 'expo-audio';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useEffect, useState } from 'react';
import { Platform, Pressable, View } from 'react-native';
import { api, type Channel, type ForwardedMessage, type Message, type MessagePoll, type PickedFile } from '../lib/api';
import { fileSource } from '../lib/files';
import { timeAgo } from '../lib/format';
import { useApi } from '../lib/hooks';
import { useSession } from '../lib/session';
import { radius, useTheme } from '../lib/theme';
import { Icon } from './Icon';
import { Markdown, openLink } from './Markdown';
import { Button, Checkbox, Field, IconButton, Input, ListRow, Muted, Row, SearchBox, Sheet, T, Toggle, useAction, useToast } from './kit';
import { DateField, PeopleField } from './pickers';

// ---------- Polls ----------

export function PollCard({ poll, authorId, onChange }: { poll: MessagePoll; authorId?: string; onChange: (p: MessagePoll) => void }) {
  const { c } = useTheme();
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
    const updated = await act(() => api.post<MessagePoll>(`/polls/${poll.id}/vote`, { options: next }));
    setBusy(false);
    if (updated) onChange(updated);
  };
  return (
    <View style={{ gap: 8, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: c.line, backgroundColor: c.surface2, opacity: poll.closed ? 0.85 : 1 }} accessibilityLabel={`Poll: ${poll.question}`}>
      <Row gap={6}>
        <Icon name="poll" size={16} color={c.accentInk} />
        <T weight="bold" style={{ flex: 1 }}>
          {poll.question}
        </T>
      </Row>
      <Muted size={12}>
        {poll.closed ? 'Poll closed' : poll.multiple ? 'Choose any' : 'Choose one'}
        {poll.anonymous && ' · anonymous'} · {poll.voters} voter{poll.voters === 1 ? '' : 's'}
      </Muted>
      {poll.options.map((o, i) => {
        const share = total ? Math.round((o.votes / total) * 100) : 0;
        const mine = poll.my_votes.includes(i);
        const showShare = voted || poll.closed;
        return (
          <Pressable
            key={i}
            onPress={() => vote(i)}
            disabled={poll.closed || busy}
            accessibilityRole="button"
            accessibilityState={{ selected: mine, disabled: poll.closed }}
            style={{ minHeight: 40, borderRadius: 10, borderWidth: 1, borderColor: mine ? c.accent : c.line, overflow: 'hidden', justifyContent: 'center', backgroundColor: c.surface }}
          >
            <View style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: showShare ? `${share}%` : 0, backgroundColor: mine ? c.accentSoft : c.line2 }} />
            <Row style={{ paddingHorizontal: 12, justifyContent: 'space-between' }}>
              <Row gap={6} style={{ flex: 1 }}>
                {mine && <Icon name="check" size={13} color={c.accentInk} />}
                <T size={14} weight={mine ? 'bold' : 'medium'} style={{ flex: 1 }}>
                  {o.label}
                </T>
              </Row>
              {showShare && (
                <Muted size={12}>
                  {o.votes} · {share}%
                </Muted>
              )}
            </Row>
          </Pressable>
        );
      })}
      {canClose && (
        <Pressable
          hitSlop={6}
          onPress={async () => {
            const res = await act(() => api.post<{ closed: boolean }>(`/polls/${poll.id}/close`));
            if (res) onChange({ ...poll, closed: res.closed });
          }}
        >
          <T size={13} weight="semibold" tone="accent">
            {poll.closed ? 'Reopen poll' : 'Close poll'}
          </T>
        </Pressable>
      )}
    </View>
  );
}

export function PollSheet({ open, onClose, channelId, parentId, onSent }: { open: boolean; onClose: () => void; channelId: string; parentId?: string; onSent?: () => void }) {
  const { c } = useTheme();
  const act = useAction();
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState(['', '']);
  const [multiple, setMultiple] = useState(false);
  const [anonymous, setAnonymous] = useState(false);
  const clean = options.map((o) => o.trim()).filter(Boolean);
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Create a poll"
      full
      footer={
        <Button
          title="Post poll"
          variant="primary"
          full
          disabled={!question.trim() || clean.length < 2}
          onPress={async () => {
            const ok = await act(() => api.post(`/channels/${channelId}/polls`, { question, options: clean, multiple, anonymous, parentId }));
            if (!ok) return;
            setQuestion('');
            setOptions(['', '']);
            onSent?.();
            onClose();
          }}
        />
      }
    >
      <Field label="Question">
        <Input value={question} onChangeText={setQuestion} maxLength={300} placeholder="Where should we hold the staff retreat?" autoFocus />
      </Field>
      {options.map((o, i) => (
        <Row key={i}>
          <Input style={{ flex: 1 }} value={o} onChangeText={(v) => setOptions(options.map((x, j) => (j === i ? v : x)))} placeholder={`Option ${i + 1}`} accessibilityLabel={`Option ${i + 1}`} maxLength={120} />
          {options.length > 2 && <IconButton name="x" label={`Remove option ${i + 1}`} color={c.muted} onPress={() => setOptions(options.filter((_, j) => j !== i))} />}
        </Row>
      ))}
      {options.length < 10 && <Button small icon="plus" title="Add option" onPress={() => setOptions([...options, ''])} />}
      <Toggle value={multiple} onChange={setMultiple} label="Allow more than one choice" />
      <Toggle value={anonymous} onChange={setAnonymous} label="Anonymous" hint="Hide who voted for what" />
    </Sheet>
  );
}

// ---------- Forwarding ----------

export function ForwardedQuote({ f }: { f: ForwardedMessage }) {
  const { c } = useTheme();
  const box = { borderLeftWidth: 3, borderColor: c.lineStrong, paddingLeft: 10, gap: 4, marginTop: 4 } as const;
  if (f.deleted)
    return (
      <View style={box}>
        <Muted>Forwarded message was deleted.</Muted>
      </View>
    );
  return (
    <View style={box}>
      <Row gap={4} wrap>
        <Icon name="forward" size={12} color={c.muted} />
        <Muted size={12}>
          Forwarded from <T size={12} weight="bold">{f.user?.name}</T>
          {f.channel_name ? ' in ' : ''}
        </Muted>
        {f.channel_name && (
          <T size={12} tone="accent" onPress={() => router.push(`/channels/${f.channel_id}?message=${f.id}`)}>
            #{f.channel_name}
          </T>
        )}
        <Muted size={12}>· {timeAgo(f.created_at)}</Muted>
      </Row>
      <Markdown text={f.body ?? ''} compact size={14} />
    </View>
  );
}

export function ForwardSheet({ message, onClose }: { message: Message | null; onClose: () => void }) {
  const { c } = useTheme();
  const act = useAction();
  const { me } = useSession();
  const { data: channels } = useApi<Channel[]>(message ? '/channels' : null);
  const [target, setTarget] = useState('');
  const [comment, setComment] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    setTarget('');
    setComment('');
    setQ('');
  }, [message?.id]);
  const label = (ch: Channel) => (ch.kind === 'dm' ? ch.members?.filter((m) => m.id !== me!.user.id).map((m) => m.name).join(', ') || 'Direct message' : `#${ch.name}`);
  const options = (channels ?? []).filter((ch) => (ch.kind === 'dm' || ch.joined) && (!q || label(ch).toLowerCase().includes(q.toLowerCase())));
  return (
    <Sheet
      open={!!message}
      onClose={onClose}
      title="Forward message"
      full
      footer={
        <Button
          title="Forward"
          variant="primary"
          full
          disabled={!target}
          onPress={async () => {
            const ok = await act(() => api.post(`/messages/${message!.id}/forward`, { channelId: target, comment }), 'Message forwarded');
            if (ok) onClose();
          }}
        />
      }
    >
      {message && (
        <>
          <SearchBox value={q} onChangeText={setQ} placeholder="Find a channel or conversation" />
          <View>
            {options.slice(0, 30).map((ch) => (
              <ListRow
                key={ch.id}
                left={<Icon name={ch.kind === 'dm' ? 'chat' : ch.kind === 'private' ? 'lock' : 'hash'} size={16} color={c.ink2} />}
                title={label(ch)}
                right={target === ch.id ? <Icon name="check" size={18} color={c.accent} /> : undefined}
                onPress={() => setTarget(ch.id)}
              />
            ))}
          </View>
          <Field label="Add a note (optional)">
            <Input value={comment} onChangeText={setComment} maxLength={10000} />
          </Field>
          <View style={{ borderLeftWidth: 3, borderColor: c.lineStrong, paddingLeft: 10 }}>
            <Muted size={12}>{message.user?.name}</Muted>
            <Markdown text={message.body} compact size={14} />
          </View>
        </>
      )}
    </Sheet>
  );
}

// ---------- Voice notes ----------

/** Press to record, Done to attach (up to five minutes), like the web composer. */
export function VoiceNoteButton({ onRecorded, disabled }: { onRecorded: (file: PickedFile) => void; disabled?: boolean }) {
  const { c } = useTheme();
  const toast = useToast();
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const state = useAudioRecorderState(recorder, 500);
  const [active, setActive] = useState(false);
  useEffect(() => {
    if (active && state.durationMillis > 5 * 60_000) finish(true);
  }, [state.durationMillis]); // eslint-disable-line react-hooks/exhaustive-deps
  const start = async () => {
    const perm = await AudioModule.requestRecordingPermissionsAsync();
    if (!perm.granted) return toast('Allow microphone access in Settings to record a voice note.', 'error');
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
    await recorder.prepareToRecordAsync();
    recorder.record();
    setActive(true);
  };
  const finish = async (keep: boolean) => {
    await recorder.stop();
    await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
    setActive(false);
    const uri = recorder.uri;
    if (keep && uri) {
      const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
      const ext = Platform.OS === 'web' ? 'webm' : 'm4a';
      onRecorded({ uri, name: `voice-note-${stamp}.${ext}`, type: Platform.OS === 'web' ? 'audio/webm' : 'audio/mp4' });
    }
  };
  if (active) {
    const s = Math.floor(state.durationMillis / 1000);
    return (
      <Row gap={6}>
        <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: c.red }} />
        <T size={13} weight="bold">
          {Math.floor(s / 60)}:{String(s % 60).padStart(2, '0')}
        </T>
        <Button small title="Cancel" onPress={() => finish(false)} />
        <Button small variant="primary" title="Done" onPress={() => finish(true)} />
      </Row>
    );
  }
  return <IconButton name="mic" label="Record a voice note" onPress={disabled ? undefined : start} />;
}

// ---------- Media ----------

function AudioAttachment({ file }: { file: { id: string; name: string } }) {
  const { c } = useTheme();
  const player = useAudioPlayer(fileSource(file.id));
  const status = useAudioPlayerStatus(player);
  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  useEffect(() => {
    if (status.didJustFinish) player.seekTo(0);
  }, [status.didJustFinish, player]);
  return (
    <Row gap={10} style={{ padding: 8, paddingRight: 14, borderRadius: radius.pill, backgroundColor: c.surface2, borderWidth: 1, borderColor: c.line, alignSelf: 'flex-start', maxWidth: 300 }}>
      <Pressable
        onPress={() => (status.playing ? player.pause() : player.play())}
        accessibilityRole="button"
        accessibilityLabel={status.playing ? `Pause ${file.name}` : `Play ${file.name}`}
        style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: c.accent, alignItems: 'center', justifyContent: 'center' }}
      >
        <Icon name={status.playing ? 'square' : 'play'} size={15} color="#fff" />
      </Pressable>
      <View style={{ flex: 1, gap: 4 }}>
        <View style={{ height: 4, borderRadius: 2, backgroundColor: c.line, overflow: 'hidden' }}>
          <View style={{ width: `${status.duration ? (status.currentTime / status.duration) * 100 : 0}%`, height: 4, backgroundColor: c.accent }} />
        </View>
        <Muted size={11}>{status.duration ? `${fmt(status.currentTime)} / ${fmt(status.duration)}` : 'Voice note'}</Muted>
      </View>
    </Row>
  );
}

function VideoAttachment({ file }: { file: { id: string; name: string } }) {
  const player = useVideoPlayer(fileSource(file.id));
  return (
    <View style={{ width: '100%', maxWidth: 360, aspectRatio: 16 / 9, borderRadius: 12, overflow: 'hidden', backgroundColor: '#000' }}>
      <VideoView player={player} style={{ flex: 1 }} nativeControls contentFit="contain" accessibilityLabel={file.name} />
    </View>
  );
}

export const isPlayable = (mime?: string | null) => !!mime && (mime.startsWith('video/') || mime.startsWith('audio/'));

/** Images, voice notes, videos and other files attached to a message. */
export function Attachments({ files }: { files: { id: string; name: string; mime: string; size: number }[] }) {
  const { c } = useTheme();
  if (!files.length) return null;
  return (
    <View style={{ gap: 6, marginTop: 4 }}>
      {files.map((f) =>
        f.mime?.startsWith('image/') ? (
          <Pressable key={f.id} onPress={() => router.push(`/files/${f.id}`)} accessibilityRole="imagebutton" accessibilityLabel={f.name}>
            <Image source={fileSource(f.id)} style={{ width: 240, height: 180, borderRadius: 12, backgroundColor: c.line2 }} contentFit="cover" transition={150} />
          </Pressable>
        ) : f.mime?.startsWith('audio/') ? (
          <AudioAttachment key={f.id} file={f} />
        ) : f.mime?.startsWith('video/') ? (
          <VideoAttachment key={f.id} file={f} />
        ) : (
          <Pressable
            key={f.id}
            onPress={() => router.push(`/files/${f.id}`)}
            accessibilityRole="button"
            style={{ flexDirection: 'row', alignItems: 'center', gap: 8, padding: 10, borderRadius: 10, borderWidth: 1, borderColor: c.line, backgroundColor: c.surface2, alignSelf: 'flex-start', maxWidth: 300 }}
          >
            <Icon name="file" size={16} color={c.ink2} />
            <T size={14} weight="semibold" numberOfLines={1} style={{ flexShrink: 1 }}>
              {f.name}
            </T>
          </Pressable>
        ),
      )}
    </View>
  );
}

// ---------- Video links ----------

type Provider = 'youtube' | 'vimeo' | 'loom' | 'tiktok' | 'facebook';
const PROVIDER_NAME: Record<Provider, string> = { youtube: 'YouTube', vimeo: 'Vimeo', loom: 'Loom', tiktok: 'TikTok', facebook: 'Facebook' };

function classify(raw: string): { url: string; provider: Provider; youtubeId?: string } | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.toLowerCase().replace(/^(www\.|m\.)/, '');
  const path = u.pathname;
  if (host === 'youtu.be' || host === 'youtube.com' || host === 'music.youtube.com') {
    const id = host === 'youtu.be' ? path.slice(1).split('/')[0] : path === '/watch' ? u.searchParams.get('v') : /^\/(?:shorts|embed|live|v)\/([\w-]{11})/.exec(path)?.[1];
    return id && /^[\w-]{11}$/.test(id) ? { url: raw, provider: 'youtube', youtubeId: id } : null;
  }
  if ((host === 'vimeo.com' || host === 'player.vimeo.com') && /^\/(?:video\/)?\d{5,12}(?:\/|$)/.test(path)) return { url: raw, provider: 'vimeo' };
  if (host === 'loom.com' && /^\/(?:share|embed)\/[0-9a-f]{32}/.test(path)) return { url: raw, provider: 'loom' };
  if (host === 'tiktok.com' && /^\/@[\w.-]+\/video\/\d{8,25}/.test(path)) return { url: raw, provider: 'tiktok' };
  if ((host === 'facebook.com' && /\/(videos|watch|reel)\b/.test(path)) || host === 'fb.watch') return { url: raw, provider: 'facebook' };
  return null;
}

function VideoLinkCard({ link }: { link: { url: string; provider: Provider; youtubeId?: string } }) {
  const { c } = useTheme();
  const { data } = useApi<{ title: string | null; thumbnail: string | null }>(`/embeds/video?url=${encodeURIComponent(link.url)}`);
  const thumbnail = data?.thumbnail ?? (link.youtubeId ? `https://i.ytimg.com/vi/${link.youtubeId}/hqdefault.jpg` : null);
  const title = data?.title ?? `${PROVIDER_NAME[link.provider]} video`;
  return (
    <Pressable onPress={() => openLink(link.url)} accessibilityRole="link" accessibilityLabel={`Play ${title}`} style={{ width: 260, borderRadius: 12, overflow: 'hidden', borderWidth: 1, borderColor: c.line, backgroundColor: c.surface2 }}>
      <View style={{ height: 146, backgroundColor: '#1d1d1d', alignItems: 'center', justifyContent: 'center' }}>
        {thumbnail && <Image source={{ uri: thumbnail }} style={{ position: 'absolute', inset: 0 } as never} contentFit="cover" />}
        <View style={{ width: 46, height: 46, borderRadius: 23, backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="play" size={22} color="#fff" />
        </View>
      </View>
      <View style={{ padding: 10 }}>
        <T size={13} weight="bold" numberOfLines={2}>
          {title}
        </T>
        <Muted size={12}>{PROVIDER_NAME[link.provider]}</Muted>
      </View>
    </Pressable>
  );
}

export function VideoLinks({ text }: { text: string }) {
  const found = new Map<string, NonNullable<ReturnType<typeof classify>>>();
  for (const m of text.matchAll(/https?:\/\/[^\s<>()[\]"'`]+/g)) {
    const url = m[0].replace(/[.,;:!?]+$/, '');
    const link = classify(url);
    if (link && !found.has(url)) found.set(url, link);
    if (found.size >= 3) break;
  }
  if (!found.size) return null;
  return (
    <View style={{ gap: 6, marginTop: 4 }}>
      {[...found.values()].map((l) => (
        <VideoLinkCard key={l.url} link={l} />
      ))}
    </View>
  );
}

// ---------- Favorites ----------

export type FavoriteKind = 'page' | 'project' | 'channel' | 'goal' | 'dashboard' | 'board';
export interface Favorite {
  kind: FavoriteKind;
  id: string;
  title: string;
  icon: string | null;
  color?: string;
  link: string;
}

let favCache: Favorite[] | null = null;
let favPending: Promise<Favorite[]> | null = null;
const favListeners = new Set<(f: Favorite[]) => void>();
async function loadFavorites(force = false) {
  if (favCache && !force) return favCache;
  favPending ??= api.get<Favorite[]>('/favorites').finally(() => (favPending = null));
  favCache = await favPending;
  favListeners.forEach((l) => l(favCache!));
  return favCache;
}

export function useFavorites() {
  const [items, setItems] = useState<Favorite[]>(favCache ?? []);
  useEffect(() => {
    favListeners.add(setItems);
    loadFavorites().then(setItems, () => {});
    return () => void favListeners.delete(setItems);
  }, []);
  return items;
}

export function FavoriteButton({ kind, id }: { kind: FavoriteKind; id: string }) {
  const { c } = useTheme();
  const act = useAction();
  const items = useFavorites();
  const on = items.some((f) => f.kind === kind && f.id === id);
  return (
    <IconButton
      name="star"
      label={on ? 'Remove from favorites' : 'Add to favorites'}
      color={on ? c.amber : c.ink2}
      onPress={async () => {
        const ok = await act(() => api.put('/favorites', { kind, id, on: !on }));
        if (ok) await loadFavorites(true);
      }}
    />
  );
}

// ---------- AI ----------

export function useAiEnabled() {
  const { me } = useSession();
  return !!me?.workspace.ai_enabled && !!me?.workspace.ai_available && !!me?.workspace.plan?.features.includes('ai');
}

export function AiDraft({ text, onUse, useLabel }: { text: string; onUse?: () => void; useLabel?: string }) {
  const { c } = useTheme();
  return (
    <View style={{ gap: 8, padding: 12, borderRadius: 12, backgroundColor: c.blueSoft, borderWidth: 1, borderColor: c.blueLine }} accessibilityLabel="AI draft">
      <Row gap={6}>
        <Icon name="spark" size={14} color={c.blueInk} />
        <T size={12} weight="bold" tone="blue">
          AI draft — check it before relying on it
        </T>
      </Row>
      <Markdown text={text} size={14} />
      <Muted size={11}>Only visible to you. Generated from content you have access to.</Muted>
      {onUse && <Button small variant="primary" title={useLabel ?? 'Use'} onPress={onUse} />}
    </View>
  );
}

interface Suggestion {
  title: string;
  owner_id: string | null;
  owner_name: string | null;
  due_date: string | null;
  reason: string;
}

/** Thread tools: summary and task suggestions that a person reviews before anything is created. */
export function ThreadAi({ messageId, excluded }: { messageId: string; excluded: boolean }) {
  const { c } = useTheme();
  const enabled = useAiEnabled();
  const act = useAction();
  const [busy, setBusy] = useState<'summary' | 'tasks' | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [suggested, setSuggested] = useState<{ project_id: string | null; source_message_id: string; suggestions: (Suggestion & { pick: boolean })[] } | null>(null);
  if (!enabled) return null;
  if (excluded) return <Muted>AI assistance is turned off for this conversation.</Muted>;
  const set = (i: number, patch: Partial<Suggestion & { pick: boolean }>) => setSuggested(suggested && { ...suggested, suggestions: suggested.suggestions.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
  return (
    <View style={{ gap: 10 }}>
      <Row wrap>
        <Button
          small
          icon="spark"
          title={busy === 'summary' ? 'Summarizing…' : 'Summarize thread'}
          disabled={!!busy}
          onPress={async () => {
            setBusy('summary');
            const res = await act(() => api.post<{ summary: string }>(`/ai/threads/${messageId}/summary`));
            setBusy(null);
            if (res) setSummary(res.summary);
          }}
        />
        <Button
          small
          icon="task"
          title={busy === 'tasks' ? 'Looking…' : 'Suggest tasks'}
          disabled={!!busy}
          onPress={async () => {
            setBusy('tasks');
            const res = await act(() => api.post<{ project_id: string | null; source_message_id: string; suggestions: Suggestion[] }>(`/ai/threads/${messageId}/suggest-tasks`));
            setBusy(null);
            if (res) setSuggested({ ...res, suggestions: res.suggestions.map((s) => ({ ...s, pick: true })) });
          }}
        />
      </Row>
      {summary && <AiDraft text={summary} />}
      {suggested && (
        <View style={{ gap: 10, padding: 12, borderRadius: 12, backgroundColor: c.blueSoft, borderWidth: 1, borderColor: c.blueLine }}>
          <Row gap={6}>
            <Icon name="spark" size={14} color={c.blueInk} />
            <T size={12} weight="bold" tone="blue">
              Suggested tasks — review before creating
            </T>
          </Row>
          {!suggested.suggestions.length && <Muted>No clear follow-ups found.</Muted>}
          {suggested.suggestions.map((s, i) => (
            <View key={i} style={{ gap: 6, flexDirection: 'row' }}>
              <Checkbox checked={s.pick} onChange={(v) => set(i, { pick: v })} />
              <View style={{ flex: 1, gap: 6 }}>
                <Input value={s.title} onChangeText={(v) => set(i, { title: v })} accessibilityLabel="Task title" />
                <PeopleField multiple={false} title="Owner" allowNone="Unassigned" placeholder="Unassigned" value={s.owner_id ? [s.owner_id] : []} onChange={(ids) => set(i, { owner_id: ids[0] ?? null })} />
                <DateField value={s.due_date} onChange={(v) => set(i, { due_date: v })} label="Due date" />
                <Muted size={12}>{s.reason}</Muted>
              </View>
            </View>
          ))}
          <Row style={{ justifyContent: 'flex-end' }}>
            <Button small title="Dismiss" onPress={() => setSuggested(null)} />
            <Button
              small
              variant="primary"
              title="Create selected"
              disabled={!suggested.suggestions.some((s) => s.pick)}
              onPress={async () => {
                let created = 0;
                for (const s of suggested.suggestions.filter((x) => x.pick)) {
                  const ok = await act(() => api.post('/tasks', { title: s.title, ownerId: s.owner_id, dueDate: s.due_date, projectId: suggested.project_id, sourceMessageId: suggested.source_message_id }));
                  if (ok) created += 1;
                }
                if (created) {
                  setSuggested(null);
                  await act(async () => undefined, `${created} task${created > 1 ? 's' : ''} created`);
                }
              }}
            />
          </Row>
        </View>
      )}
    </View>
  );
}

export const channelIcon = (ch: { kind: string }) => (ch.kind === 'private' ? 'lock' : ch.kind === 'announcement' ? 'megaphone' : ch.kind === 'dm' ? 'chat' : 'hash');
