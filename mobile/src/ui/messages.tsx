import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, TextInput, View } from 'react-native';
import { api, formWith, session, type Message, type PickedFile } from '../lib/api';
import { pickDocuments, pickMedia } from '../lib/files';
import { plainMentions, timeAgo, timeOf } from '../lib/format';
import { realtime } from '../lib/realtime';
import { useSession } from '../lib/session';
import { storage } from '../lib/storage';
import { fonts, useTheme } from '../lib/theme';
import { Attachments, ForwardedQuote, PollCard, PollSheet, VideoLinks, VoiceNoteButton } from './chat';
import { NewTaskForm } from './create';
import { Icon } from './Icon';
import { Markdown } from './Markdown';
import { ActionSheet, Avatar, Button, confirm, Field, IconButton, Input, Muted, Pill, Row, Sheet, StatusPill, T, useAction, type ActionItem } from './kit';
import { RemindSheet, WhenSheet } from './work';

export const EMOJI = ['👍', '❤️', '🎉', '✅', '👀', '😄', '🙏', '🚀'];

export interface MessageActions {
  forward: (m: Message) => void;
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

/** One message: avatar, name, body, attachments, reactions and thread link. Long-press for actions. */
export function MessageItem({
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
  actions: MessageActions;
  inThread?: boolean;
}) {
  const { c } = useTheme();
  const { me } = useSession();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(m.body);
  const [menu, setMenu] = useState(false);
  const [remind, setRemind] = useState(false);
  const [poll, setPoll] = useState(m.poll ?? null);
  useEffect(() => setPoll(m.poll ?? null), [m.poll]);
  const mine = m.user?.id === me!.user.id;
  const isAdmin = me!.role === 'admin' || me!.role === 'owner';
  const policy = me!.workspace.message_edit_policy;
  const canEdit = policy === 'author' ? mine : policy === 'admins' ? isAdmin : false;

  if (m.deleted) {
    return (
      <View style={{ flexDirection: 'row', gap: 10, paddingVertical: 6, paddingHorizontal: 14 }}>
        <View style={{ width: 36 }} />
        <Row gap={6}>
          <Icon name="trash" size={13} color={c.muted} />
          <Muted>This message was deleted.</Muted>
          {m.reply_count > 0 && !inThread && (
            <T size={13} tone="accent" onPress={() => actions.reply(m)}>
              View {m.reply_count} repl{m.reply_count === 1 ? 'y' : 'ies'}
            </T>
          )}
        </Row>
      </View>
    );
  }

  const menuActions: ActionItem[] = [
    { label: 'Reply in thread', icon: 'thread', onPress: () => actions.reply(m), hidden: inThread },
    { label: 'Create task', icon: 'task', onPress: () => actions.task(m) },
    { label: 'Forward', icon: 'forward', onPress: () => actions.forward(m) },
    { label: 'Record decision', icon: 'gavel', onPress: () => actions.decision(m) },
    { label: m.pinned ? 'Unpin' : 'Pin to channel', icon: 'pin', onPress: () => actions.pin(m), hidden: !canPost },
    { label: m.saved ? 'Remove from saved' : 'Save for later', icon: 'bookmark', onPress: () => actions.save(m) },
    { label: 'Remind me about this', icon: 'clock', onPress: () => setRemind(true) },
    { label: 'Copy text', icon: 'file', onPress: () => Clipboard.setStringAsync(plainMentions(m.body)), hidden: !m.body },
    { label: 'Copy link', icon: 'link', onPress: () => Clipboard.setStringAsync(`${session.server}/channels/${m.channel_id}?message=${m.parent_id ?? m.id}`) },
    {
      label: 'Edit',
      icon: 'edit',
      onPress: () => {
        setDraft(m.body);
        setEditing(true);
      },
      hidden: !canEdit || !!poll,
    },
    { label: 'Delete', icon: 'trash', danger: true, onPress: () => actions.remove(m), hidden: !(canEdit || isAdmin) },
  ];

  return (
    <Pressable
      onLongPress={() => {
        if (Platform.OS !== 'web') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
        setMenu(true);
      }}
      delayLongPress={300}
      accessibilityHint="Long-press for message actions"
      accessibilityActions={[{ name: 'longpress', label: 'Message actions' }]}
      onAccessibilityAction={() => setMenu(true)}
      style={({ pressed }) => ({
        flexDirection: 'row',
        gap: 10,
        paddingHorizontal: 14,
        paddingTop: grouped ? 2 : 10,
        paddingBottom: 4,
        backgroundColor: highlight ? c.amberSoft : pressed ? c.hover : m.urgent ? c.redSoft : 'transparent',
        borderLeftWidth: m.urgent ? 3 : 0,
        borderColor: c.red,
      })}
    >
      <View style={{ width: 36, alignItems: 'center' }}>{grouped ? null : <Avatar user={m.user} size="md" />}</View>
      <View style={{ flex: 1, gap: 3, minWidth: 0 }}>
        {!grouped && (
          <Row gap={6} wrap>
            <T weight="bold" size={15} onPress={() => m.user && router.push(`/people/${m.user.id}`)}>
              {m.user?.name}
            </T>
            <Muted size={12}>{timeOf(m.created_at)}</Muted>
            {m.urgent && <Pill label="Urgent" tone="red" />}
            {m.pinned && <Pill label="Pinned" icon="pin" />}
          </Row>
        )}
        {editing ? (
          <View style={{ gap: 6 }}>
            <Input value={draft} onChangeText={setDraft} multiline autoFocus accessibilityLabel="Edit message" />
            <Row style={{ justifyContent: 'flex-end' }}>
              <Button small title="Cancel" onPress={() => setEditing(false)} />
              <Button
                small
                variant="primary"
                title="Save"
                onPress={async () => {
                  await actions.edit(m, draft);
                  setEditing(false);
                }}
              />
            </Row>
          </View>
        ) : poll ? (
          <PollCard poll={poll} authorId={m.user?.id} onChange={setPoll} />
        ) : (
          !!m.body && (
            <>
              <Markdown text={m.body} compact />
              <VideoLinks text={m.body} />
            </>
          )
        )}
        {m.forwarded && <ForwardedQuote f={m.forwarded} />}
        {m.edited_at && !editing && <Muted size={11}>(edited)</Muted>}
        <Attachments files={m.files} />
        {(m.tasks.length > 0 || m.decisions.length > 0) && (
          <View style={{ gap: 4, marginTop: 2 }}>
            {m.tasks.map((t) => (
              <Pressable key={t.id} onPress={() => router.push(`/tasks/${t.id}`)} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, padding: 8, borderRadius: 9, backgroundColor: c.surface2, borderWidth: 1, borderColor: c.line, alignSelf: 'flex-start' }}>
                <Icon name="task" size={14} color={c.ink2} />
                <T size={13} weight="semibold" numberOfLines={1} style={{ flexShrink: 1 }}>
                  {t.title}
                </T>
                <StatusPill status={t.status} />
              </Pressable>
            ))}
            {m.decisions.map((d) => (
              <Row key={d.id} gap={6} style={{ padding: 8, borderRadius: 9, backgroundColor: c.amberSoft, alignSelf: 'flex-start' }}>
                <Icon name="gavel" size={14} color={c.amberInk} />
                <T size={13} tone="amber" weight="semibold">
                  Decision: {d.title}
                </T>
              </Row>
            ))}
          </View>
        )}
        {(m.reactions.length > 0 || (isAnnouncement && !inThread && !m.parent_id)) && (
          <Row wrap gap={6} style={{ marginTop: 4 }}>
            {m.reactions.map((r) => (
              <Pressable
                key={r.emoji}
                onPress={() => actions.react(m, r.emoji)}
                accessibilityRole="button"
                accessibilityState={{ selected: r.mine }}
                accessibilityLabel={`${r.emoji} ${r.count}`}
                style={{ flexDirection: 'row', gap: 4, alignItems: 'center', paddingHorizontal: 9, height: 28, borderRadius: 14, borderWidth: 1, borderColor: r.mine ? c.accentLine : c.line, backgroundColor: r.mine ? c.accentSoft : c.surface }}
              >
                <T size={14}>{r.emoji}</T>
                <T size={12} weight="bold" tone={r.mine ? 'accent' : 'ink2'}>
                  {r.count}
                </T>
              </Pressable>
            ))}
            {isAnnouncement && !inThread && !m.parent_id && (
              <Pressable
                onPress={() => !m.acked && actions.ack(m)}
                disabled={m.acked}
                accessibilityRole="button"
                style={{ flexDirection: 'row', gap: 4, alignItems: 'center', paddingHorizontal: 10, height: 28, borderRadius: 14, borderWidth: 1, borderColor: m.acked ? c.greenLine : c.line, backgroundColor: m.acked ? c.greenSoft : c.surface }}
              >
                <Icon name="check" size={13} color={m.acked ? c.green : c.ink2} />
                <T size={12} weight="bold" tone={m.acked ? 'green' : 'ink2'}>
                  {m.acked ? 'Acknowledged' : 'Acknowledge'} · {m.ack_count}
                </T>
              </Pressable>
            )}
          </Row>
        )}
        {m.reply_count > 0 && !inThread && (
          <Pressable onPress={() => actions.reply(m)} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 }} accessibilityRole="button">
            <Icon name="thread" size={14} color={c.accentInk} />
            <T size={13} weight="bold" tone="accent">
              {m.reply_count} repl{m.reply_count === 1 ? 'y' : 'ies'}
            </T>
            <Muted size={12}>· last {timeAgo(m.last_reply_at)}</Muted>
          </Pressable>
        )}
      </View>
      <MessageMenu open={menu} onClose={() => setMenu(false)} onReact={(e) => actions.react(m, e)} actions={menuActions} />
      <RemindSheet open={remind} onClose={() => setRemind(false)} messageId={m.id} />
    </Pressable>
  );
}

function MessageMenu({ open, onClose, onReact, actions }: { open: boolean; onClose: () => void; onReact: (emoji: string) => void; actions: ActionItem[] }) {
  const { c } = useTheme();
  return (
    <Sheet open={open} onClose={onClose}>
      <Row style={{ justifyContent: 'space-between' }}>
        {EMOJI.map((e) => (
          <Pressable
            key={e}
            onPress={() => {
              onReact(e);
              onClose();
            }}
            accessibilityLabel={`React ${e}`}
            style={({ pressed }) => ({ width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: pressed ? c.accentSoft : c.surface })}
          >
            <T size={22}>{e}</T>
          </Pressable>
        ))}
      </Row>
      <View>
        {actions
          .filter((a) => !a.hidden)
          .map((a) => (
            <Pressable
              key={a.label}
              onPress={() => {
                onClose();
                setTimeout(a.onPress, Platform.OS === 'ios' ? 350 : 50);
              }}
              style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, backgroundColor: pressed ? c.hover : 'transparent' })}
              accessibilityRole="button"
            >
              <Icon name={a.icon ?? 'arrow'} size={19} color={a.danger ? c.red : c.ink2} />
              <T weight="semibold" tone={a.danger ? 'red' : 'ink'}>
                {a.label}
              </T>
            </Pressable>
          ))}
      </View>
    </Sheet>
  );
}

// ---------- Composer ----------

const BROADCASTS = [
  { id: 'channel', name: 'channel', color: 'gold', hint: 'Notify everyone here' },
  { id: 'here', name: 'here', color: 'gold', hint: 'Notify people online now' },
];

type Pending = { id: string; name: string; preview?: string; kind?: 'image' | 'video' | 'file' };

export function Composer({
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
  const { c } = useTheme();
  const { people } = useSession();
  const act = useAction();
  const storageKey = `kuu.draft.${channelId}.${parentId ?? 'root'}`;
  const [text, setText] = useState('');
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const [mentions, setMentions] = useState<Record<string, string>>({});
  const [query, setQuery] = useState<string | null>(null);
  const [files, setFiles] = useState<Pending[]>([]);
  const [urgent, setUrgent] = useState(false);
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [later, setLater] = useState(false);
  const [polling, setPolling] = useState(false);
  const [more, setMore] = useState(false);
  const ref = useRef<TextInput>(null);
  const lastTyping = useRef(0);

  useEffect(() => {
    storage.get(storageKey).then((v) => v && setText(v));
  }, [storageKey]);
  useEffect(() => {
    const t = setTimeout(() => (text ? storage.set(storageKey, text) : storage.del(storageKey)), 400);
    return () => clearTimeout(t);
  }, [text, storageKey]);

  const candidates = useMemo(() => {
    if (query === null) return [];
    const pool = [...members, ...people.filter((p) => !members.some((m) => m.id === p.id))];
    const found = pool.filter((p) => p.name.toLowerCase().includes(query.toLowerCase())).slice(0, 6);
    const everyone = members.length > 2 ? BROADCASTS.filter((b) => b.name.startsWith(query.toLowerCase())) : [];
    return [...found, ...everyone].slice(0, 7);
  }, [query, members, people]);

  const onChange = (value: string, caret = value.length) => {
    setText(value);
    const match = value.slice(0, caret).match(/(?:^|\s)@([\w.-]*)$/);
    setQuery(match ? match[1] : null);
    if (Date.now() - lastTyping.current > 3000) {
      lastTyping.current = Date.now();
      realtime.send({ type: 'typing', channelId });
    }
  };

  const pick = (p: { id: string; name: string }) => {
    const caret = selection.start || text.length;
    const before = text.slice(0, caret).replace(/@([\w.-]*)$/, `@${p.name} `);
    setText(before + text.slice(caret));
    if (!BROADCASTS.some((b) => b.id === p.id)) setMentions((m) => ({ ...m, [p.name]: p.id }));
    setQuery(null);
    setTimeout(() => ref.current?.focus(), 0);
  };

  const withMentions = () => {
    let body = text.trim();
    for (const [name, id] of Object.entries(mentions)) body = body.split(`@${name}`).join(`@[${name}](${id})`);
    return body;
  };

  const send = async () => {
    if ((!text.trim() && !files.length) || sending) return;
    setSending(true);
    const ok = await act(() => api.post(`/channels/${channelId}/messages`, { body: withMentions(), parentId, fileIds: files.map((f) => f.id), urgent }));
    setSending(false);
    if (ok) {
      setText('');
      setFiles([]);
      setMentions({});
      setUrgent(false);
      storage.del(storageKey);
      onSent?.();
    }
  };

  const schedule = async (sendAt: string) => {
    const ok = await act(() => api.post(`/channels/${channelId}/scheduled-messages`, { body: withMentions(), parentId, sendAt }), 'Message scheduled. Find it under Later.');
    if (ok) {
      setText('');
      setMentions({});
    }
    return ok;
  };

  const upload = async (picked: PickedFile[]) => {
    for (const file of picked) {
      setUploading(true);
      const res = await act(() => api.upload<{ id: string; name: string }>('/files', formWith({ file, channelId })));
      setUploading(false);
      if (res) setFiles((f) => [...f, { id: res.id, name: res.name, preview: /^image\//.test(file.type) ? file.uri : undefined, kind: file.type.startsWith('video/') ? 'video' : file.type.startsWith('image/') ? 'image' : 'file' }]);
    }
  };

  const canSend = !sending && !uploading && (!!text.trim() || files.length > 0);

  return (
    <View style={{ borderTopWidth: 1, borderColor: c.line, backgroundColor: c.surface, paddingHorizontal: 10, paddingTop: 8, paddingBottom: 8, gap: 6 }}>
      {candidates.length > 0 && (
        <View style={{ borderRadius: 12, borderWidth: 1, borderColor: c.line, backgroundColor: c.surface, overflow: 'hidden' }} accessibilityRole="list" accessibilityLabel="Mention someone">
          {candidates.map((p) => (
            <Pressable key={p.id} onPress={() => pick(p)} style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 8, padding: 10, backgroundColor: pressed ? c.hover : 'transparent' })}>
              {'hint' in p ? <Icon name="megaphone" size={16} color={c.amberInk} /> : <Avatar user={p} size="xs" />}
              <T weight="semibold">{'hint' in p ? `@${p.name}` : p.name}</T>
              {'hint' in p && <Muted size={12}>{String(p.hint)}</Muted>}
            </Pressable>
          ))}
        </View>
      )}
      {files.length > 0 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
          {files.map((f) => (
            <Row key={f.id} gap={6} style={{ paddingLeft: 6, paddingRight: 4, paddingVertical: 4, borderRadius: 10, backgroundColor: c.line2, maxWidth: 220 }}>
              {f.preview ? <Image source={{ uri: f.preview }} style={{ width: 32, height: 32, borderRadius: 6 }} /> : <Icon name={f.kind === 'video' ? 'video' : 'file'} size={15} color={c.ink2} />}
              <T size={12} numberOfLines={1} style={{ flexShrink: 1 }}>
                {f.name}
              </T>
              <IconButton name="x" size={13} label={`Remove ${f.name}`} onPress={() => setFiles(files.filter((x) => x.id !== f.id))} />
            </Row>
          ))}
        </ScrollView>
      )}
      <Row gap={6} style={{ alignItems: 'flex-end' }}>
        <IconButton name="plus" label="Attach, poll and more" onPress={() => setMore(true)} />
        <TextInput
          ref={ref}
          value={text}
          onChangeText={(v) => onChange(v, selection.start + (v.length - text.length))}
          onSelectionChange={(e) => setSelection(e.nativeEvent.selection)}
          placeholder={placeholder}
          placeholderTextColor={c.muted}
          accessibilityLabel={placeholder}
          multiline
          numberOfLines={1}
          style={{
            flex: 1,
            minHeight: 40,
            maxHeight: 140,
            borderRadius: 20,
            borderWidth: 1,
            borderColor: urgent ? c.red : c.lineStrong,
            backgroundColor: c.canvas,
            paddingHorizontal: 14,
            paddingTop: Platform.OS === 'ios' ? 10 : 8,
            paddingBottom: Platform.OS === 'ios' ? 10 : 8,
            fontFamily: fonts.body,
            fontSize: 16,
            color: c.ink,
          }}
        />
        {text.trim() || files.length ? (
          <Pressable
            onPress={send}
            disabled={!canSend}
            accessibilityRole="button"
            accessibilityLabel="Send"
            style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: canSend ? (urgent ? c.red : c.accent) : c.lineStrong, alignItems: 'center', justifyContent: 'center' }}
          >
            <Icon name="send" size={18} color="#fff" />
          </Pressable>
        ) : (
          <VoiceNoteButton onRecorded={(f) => upload([f])} disabled={uploading} />
        )}
      </Row>
      {urgent && (
        <Row gap={6} style={{ paddingLeft: 48 }}>
          <Icon name="alert" size={13} color={c.red} />
          <T size={12} tone="red" style={{ flex: 1 }}>
            Urgent: reaches people even in quiet hours and focus time.
          </T>
          <T size={12} tone="accent" weight="bold" onPress={() => setUrgent(false)}>
            Undo
          </T>
        </Row>
      )}
      <ActionSheet
        open={more}
        onClose={() => setMore(false)}
        actions={[
          { label: 'Photo or video', icon: 'upload', onPress: () => act(async () => upload(await pickMedia('library', true))) },
          { label: 'Take a photo', icon: 'eye', onPress: () => act(async () => upload(await pickMedia('camera'))), hidden: Platform.OS === 'web' },
          { label: 'File', icon: 'paperclip', onPress: () => act(async () => upload(await pickDocuments(true))) },
          { label: 'Poll', icon: 'poll', onPress: () => setPolling(true) },
          { label: 'Mention someone', icon: 'users', onPress: () => (onChange(`${text}${text && !text.endsWith(' ') ? ' ' : ''}@`), ref.current?.focus()) },
          { label: urgent ? 'Not urgent' : 'Mark as urgent', icon: 'alert', onPress: () => setUrgent(!urgent) },
          { label: 'Send later', icon: 'clock', onPress: () => setLater(true), hidden: !text.trim() || files.length > 0 },
        ]}
      />
      <WhenSheet open={later} onClose={() => setLater(false)} eyebrow="Send later" title="Schedule this message" confirmLabel="Schedule" onPick={schedule} />
      <PollSheet open={polling} onClose={() => setPolling(false)} channelId={channelId} parentId={parentId} onSent={onSent} />
    </View>
  );
}

// ---------- From a message ----------

export function TaskFromMessageSheet({ message, projectId, onClose }: { message: Message | null; projectId?: string; onClose: () => void }) {
  const { c } = useTheme();
  return (
    <Sheet open={!!message} onClose={onClose} title="Create a task from this message" eyebrow="Turn discussion into delivery" full>
      {message && (
        <>
          <View style={{ borderLeftWidth: 3, borderColor: c.accentLine, paddingLeft: 10 }}>
            <Muted>{plainMentions(message.body).slice(0, 300)}</Muted>
          </View>
          <NewTaskForm endpoint={`/messages/${message.id}/task`} projectId={projectId} defaults={{ title: plainMentions(message.body).split('\n')[0].slice(0, 200) }} onDone={onClose} />
        </>
      )}
    </Sheet>
  );
}

export function DecisionSheet({ message, onClose }: { message: Message | null; onClose: () => void }) {
  const act = useAction();
  const [title, setTitle] = useState('');
  const [rationale, setRationale] = useState('');
  useEffect(() => {
    if (message) {
      setTitle(plainMentions(message.body).split('\n')[0].slice(0, 200));
      setRationale('');
    }
  }, [message]);
  return (
    <Sheet
      open={!!message}
      onClose={onClose}
      title="Record a decision"
      eyebrow="Decision log"
      footer={
        <Button
          title="Record decision"
          variant="primary"
          full
          disabled={!title.trim()}
          onPress={async () => {
            const ok = await act(() => api.post('/decisions', { title, rationale, messageId: message!.id }), 'Decision recorded');
            if (ok) onClose();
          }}
        />
      }
    >
      <Field label="Decision">
        <Input value={title} onChangeText={setTitle} autoFocus />
      </Field>
      <Field label="Rationale (optional)">
        <Input multiline value={rationale} onChangeText={setRationale} placeholder="Why was this decided? What alternatives were considered?" />
      </Field>
    </Sheet>
  );
}

/** The shared message actions for a conversation or thread. */
export function useMessageActions(opts: { onSaved?: (m: Message, saved: boolean) => void; setTaskFrom: (m: Message) => void; setDecisionFrom: (m: Message) => void; setForwarding: (m: Message) => void }): MessageActions {
  const act = useAction();
  return {
    forward: opts.setForwarding,
    react: (m, emoji) => void act(() => api.post(`/messages/${m.id}/reactions`, { emoji })),
    pin: (m) => void act(() => api.post(`/messages/${m.id}/pin`), m.pinned ? 'Unpinned' : 'Pinned to channel'),
    save: async (m) => {
      const res = await act(() => api.post<{ saved: boolean }>(`/messages/${m.id}/save`), m.saved ? 'Removed from saved' : 'Saved for later');
      if (res) opts.onSaved?.(m, res.saved);
    },
    edit: (m, body) => act(() => api.patch(`/messages/${m.id}`, { body })),
    remove: async (m) => {
      if (await confirm('Delete this message?', undefined, 'Delete')) await act(() => api.del(`/messages/${m.id}`), 'Message deleted');
    },
    ack: (m) => void act(() => api.post(`/messages/${m.id}/ack`), 'Acknowledged'),
    reply: (m) => router.push(`/threads/${m.id}`),
    task: opts.setTaskFrom,
    decision: opts.setDecisionFrom,
  };
}

