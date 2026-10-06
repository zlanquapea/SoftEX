import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, FlatList, KeyboardAvoidingView, Platform, Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { api, qs, type Channel, type Message } from '@/lib/api';
import { bytes, timeAgo } from '@/lib/format';
import { useApi, useRealtime } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { useShell } from '@/lib/shell';
import { swatch, useTheme } from '@/lib/theme';
import { channelIcon, FavoriteButton, ForwardSheet } from '@/ui/chat';
import { NewMeetingForm } from '@/ui/create';
import { Icon } from '@/ui/Icon';
import { Avatar, Button, confirm, Empty, ErrorState, Field, IconButton, Input, ListRow, Loading, Muted, Row, Segmented, Sheet, T, Toggle, useAction } from '@/ui/kit';
import { Markdown } from '@/ui/Markdown';
import { Composer, DecisionSheet, MessageItem, TaskFromMessageSheet, useMessageActions } from '@/ui/messages';
import { PeopleField } from '@/ui/pickers';

export interface ChannelDetail extends Channel {
  members: { id: string; name: string; color: string; title: string; status: string; role: string }[];
  project: { id: string; name: string; color: string } | null;
  can_post: boolean;
  can_manage: boolean;
  created_by: string;
  archived_at: string | null;
  ai_excluded: boolean;
}

type ListItem = { type: 'message'; message: Message; grouped: boolean } | { type: 'day'; label: string; key: string };

export default function ChannelView() {
  const { id, message: highlight } = useLocalSearchParams<{ id: string; message?: string }>();
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const { me } = useSession();
  const { reloadChannels } = useShell();
  const act = useAction();
  const { data: channel, error, reload: reloadChannel } = useApi<ChannelDetail>(`/channels/${id}`);
  const [messages, setMessages] = useState<Message[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [info, setInfo] = useState(false);
  const [typing, setTyping] = useState<Record<string, { name: string; at: number }>>({});
  const [taskFrom, setTaskFrom] = useState<Message | null>(null);
  const [decisionFrom, setDecisionFrom] = useState<Message | null>(null);
  const [forwarding, setForwarding] = useState<Message | null>(null);
  const [meeting, setMeeting] = useState(false);
  const list = useRef<FlatList<ListItem>>(null);

  const markRead = useCallback(() => {
    api
      .post(`/channels/${id}/read`)
      .then(reloadChannels)
      .catch(() => {});
  }, [id, reloadChannels]);

  const load = useCallback(
    async (before?: string) => {
      const res = await api.get<{ messages: Message[]; has_more: boolean }>(`/channels/${id}/messages${qs({ before, limit: 50 })}`);
      setHasMore(res.has_more);
      setMessages((prev) => (before ? [...res.messages, ...prev] : res.messages));
      setLoaded(true);
    },
    [id],
  );

  useEffect(() => {
    setMessages([]);
    setLoaded(false);
    load().catch(() => setLoaded(true));
    markRead();
  }, [id, load, markRead]);

  // A link to a reply opens its thread.
  useEffect(() => {
    if (highlight && loaded && !messages.some((m) => m.id === highlight)) router.push(`/threads/${highlight}`);
  }, [highlight, loaded]); // eslint-disable-line react-hooks/exhaustive-deps

  const refreshMessage = async (messageId: string) => {
    const res = await api.get<{ root: Message; replies: Message[] }>(`/messages/${messageId}/thread`).catch(() => null);
    if (res) setMessages((prev) => prev.map((m) => (m.id === res.root.id ? res.root : m)));
  };

  useRealtime((e) => {
    if (e.type === 'message.created' && e.message.channel_id === id) {
      if (e.message.parent_id) refreshMessage(e.message.parent_id);
      else setMessages((prev) => (prev.some((m) => m.id === e.message.id) ? prev : [...prev, e.message]));
      if (AppState.currentState === 'active') markRead();
      setTyping((t) => {
        const next = { ...t };
        delete next[e.message.user?.id];
        return next;
      });
    }
    if (e.type === 'message.updated' && e.channelId === id) refreshMessage(e.parentId ?? e.messageId);
    if (e.type === 'typing' && e.channelId === id && e.userId !== me!.user.id) setTyping((t) => ({ ...t, [e.userId]: { name: e.name, at: Date.now() } }));
    if (e.type === 'channel.updated' && e.channelId === id) reloadChannel();
    if (e.type === 'reconnected') load();
  });

  useEffect(() => {
    const t = setInterval(() => setTyping((ty) => Object.fromEntries(Object.entries(ty).filter(([, v]) => Date.now() - v.at < 4000))), 2000);
    return () => clearInterval(t);
  }, []);

  const actions = useMessageActions({
    setTaskFrom,
    setDecisionFrom,
    setForwarding,
    onSaved: (m, saved) => setMessages((prev) => prev.map((x) => (x.id === m.id ? { ...x, saved } : x))),
  });

  // Newest first for the inverted list, with a date divider above each day's first message.
  const rows: ListItem[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const prev = messages[i - 1];
    const newDay = !prev || new Date(prev.created_at).toDateString() !== new Date(m.created_at).toDateString();
    const grouped = !!prev && !newDay && prev.user?.id === m.user?.id && new Date(m.created_at).getTime() - new Date(prev.created_at).getTime() < 5 * 60_000;
    rows.push({ type: 'message', message: m, grouped });
    if (newDay) rows.push({ type: 'day', key: `day-${m.id}`, label: new Date(m.created_at).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }) });
  }

  useEffect(() => {
    if (!highlight || !loaded) return;
    const index = rows.findIndex((r) => r.type === 'message' && r.message.id === highlight);
    if (index >= 0) setTimeout(() => list.current?.scrollToIndex({ index, viewPosition: 0.5, animated: true }), 300);
  }, [highlight, loaded]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error && !channel) return <ErrorState error={error} />;
  if (!channel) return <Loading />;

  const dmName = channel.kind === 'dm' ? channel.members.filter((m) => m.id !== me!.user.id).map((m) => m.name).join(', ') || 'Just you' : channel.name;
  const typingNames = Object.values(typing).map((t) => t.name);
  const other = channel.kind === 'dm' && channel.members.length === 2 ? channel.members.find((m) => m.id !== me!.user.id) : undefined;

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: c.canvas }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={Platform.OS === 'ios' ? insets.top + 44 : 0}>
      <Stack.Screen
        options={{
          headerTitle: () => (
            <Pressable onPress={() => setInfo(true)} accessibilityRole="button" accessibilityLabel={`${dmName}, conversation details`} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, maxWidth: 240 }}>
              {other ? <Avatar user={other} size="sm" presence /> : <Icon name={channelIcon(channel)} size={17} color={c.ink2} />}
              <View style={{ flexShrink: 1 }}>
                <T weight="display" size={16} numberOfLines={1}>
                  {dmName}
                </T>
                {(channel.project || channel.topic || channel.kind !== 'dm') && (
                  <Muted size={11} numberOfLines={1}>
                    {channel.project ? channel.project.name : channel.topic || `${channel.members.length} members`}
                  </Muted>
                )}
              </View>
            </Pressable>
          ),
          headerRight: () => (
            <Row gap={0}>
              {channel.can_post && <IconButton name="video" label="Schedule a meeting" onPress={() => setMeeting(true)} />}
              <IconButton name="users" label="Conversation details" onPress={() => setInfo(true)} />
            </Row>
          ),
        }}
      />
      {!channel.joined && channel.kind !== 'dm' && (
        <Row gap={6} style={{ padding: 10, paddingHorizontal: 14, backgroundColor: c.accentWash, borderBottomWidth: 1, borderColor: c.accentLine }}>
          <T size={13} style={{ flex: 1 }}>
            You are previewing #{channel.name}.
          </T>
          <Button
            small
            variant="primary"
            title="Join channel"
            onPress={async () => {
              await act(() => api.post(`/channels/${channel.id}/join`), `Joined #${channel.name}`);
              reloadChannel();
              reloadChannels();
            }}
          />
        </Row>
      )}
      <FlatList
        ref={list}
        inverted
        data={rows}
        keyExtractor={(r) => (r.type === 'day' ? r.key : r.message.id)}
        contentContainerStyle={{ paddingVertical: 8 }}
        keyboardShouldPersistTaps="handled"
        onScrollToIndexFailed={() => {}}
        renderItem={({ item }) =>
          item.type === 'day' ? (
            <Row style={{ paddingHorizontal: 14, paddingVertical: 10 }}>
              <View style={{ flex: 1, height: 1, backgroundColor: c.line }} />
              <T size={12} weight="bold" tone="muted">
                {item.label}
              </T>
              <View style={{ flex: 1, height: 1, backgroundColor: c.line }} />
            </Row>
          ) : (
            <MessageItem message={item.message} grouped={item.grouped} highlight={item.message.id === highlight} isAnnouncement={channel.kind === 'announcement'} canPost={channel.can_post} actions={actions} />
          )
        }
        onEndReachedThreshold={0.3}
        onEndReached={async () => {
          if (!hasMore || loadingMore) return;
          setLoadingMore(true);
          await load(messages[0]?.created_at).catch(() => {});
          setLoadingMore(false);
        }}
        ListFooterComponent={loadingMore ? <Loading inline /> : null}
        ListEmptyComponent={
          loaded ? (
            <View style={{ transform: [{ scaleY: -1 }] }}>
              <Empty icon={channelIcon(channel)} title={channel.kind === 'dm' ? 'This is the start of your conversation' : `Welcome to #${channel.name}`}>
                {channel.topic || 'Say hello, share a file or record a decision.'}
              </Empty>
            </View>
          ) : (
            <Loading inline />
          )
        }
      />
      {typingNames.length > 0 && (
        <Muted size={12} style={{ paddingHorizontal: 16, paddingBottom: 4 }}>
          {typingNames.join(', ')} {typingNames.length > 1 ? 'are' : 'is'} typing…
        </Muted>
      )}
      <View style={{ paddingBottom: insets.bottom, backgroundColor: c.surface }}>
        {channel.can_post ? (
          <Composer channelId={channel.id} placeholder={channel.kind === 'dm' ? `Message ${dmName}` : `Message #${channel.name}`} members={channel.members} />
        ) : (
          <Muted style={{ padding: 14, textAlign: 'center' }}>
            {channel.kind === 'announcement' ? 'Only leads and admins post here. You can reply in threads and acknowledge announcements.' : 'You cannot post in this channel.'}
          </Muted>
        )}
      </View>

      <ChannelInfo open={info} onClose={() => setInfo(false)} channel={channel} onChanged={reloadChannel} />
      <TaskFromMessageSheet message={taskFrom} projectId={channel.project?.id} onClose={() => setTaskFrom(null)} />
      <ForwardSheet message={forwarding} onClose={() => setForwarding(null)} />
      <DecisionSheet message={decisionFrom} onClose={() => setDecisionFrom(null)} />
      <Sheet open={meeting} onClose={() => setMeeting(false)} title="Schedule a meeting from this channel" full>
        <NewMeetingForm onDone={() => setMeeting(false)} channelId={channel.id} projectId={channel.project?.id} />
      </Sheet>
    </KeyboardAvoidingView>
  );
}

/** Members, pinned messages, files and settings: the web's side panel. */
function ChannelInfo({ open, onClose, channel, onChanged }: { open: boolean; onClose: () => void; channel: ChannelDetail; onChanged: () => void }) {
  const { c } = useTheme();
  const { me } = useSession();
  const { reloadChannels } = useShell();
  const act = useAction();
  const [tab, setTab] = useState<'members' | 'pins' | 'files'>('members');
  const [adding, setAdding] = useState<string[]>([]);
  const [topic, setTopic] = useState(channel.topic);
  useEffect(() => setTopic(channel.topic), [channel.topic]);
  const { data: pins } = useApi<Message[]>(open && tab === 'pins' ? `/channels/${channel.id}/pins` : null);
  const { data: files } = useApi<{ id: string; name: string; size: number; owner_name: string; created_at: string }[]>(open && tab === 'files' ? `/channels/${channel.id}/files` : null);
  const go = (path: string) => {
    onClose();
    setTimeout(() => router.push(path as never), 250);
  };
  return (
    <Sheet open={open} onClose={onClose} title={channel.kind === 'dm' ? 'Conversation' : `#${channel.name}`} full>
      {channel.project && (
        <ListRow
          left={<View style={{ width: 12, height: 12, borderRadius: 4, backgroundColor: swatch(channel.project.color) }} />}
          title={channel.project.name}
          subtitle="Project"
          chevron
          onPress={() => go(`/projects/${channel.project!.id}`)}
        />
      )}
      <Row style={{ justifyContent: 'space-between' }}>
        {channel.kind !== 'dm' && <FavoriteButton kind="channel" id={channel.id} />}
        {channel.kind !== 'dm' && channel.joined && (
          <View style={{ flex: 1, marginLeft: 8 }}>
            <Segmented
              value={channel.notify}
              onChange={async (v) => {
                await act(() => api.patch(`/channels/${channel.id}/preferences`, { notify: v }), 'Notification preference saved');
                onChanged();
              }}
              options={[
                { id: 'all', label: 'All' },
                { id: 'mentions', label: 'Mentions' },
                { id: 'none', label: 'Muted' },
              ]}
            />
          </View>
        )}
      </Row>
      <Segmented
        value={tab}
        onChange={setTab}
        options={[
          { id: 'members', label: `Members ${channel.members.length}` },
          { id: 'pins', label: 'Pinned' },
          { id: 'files', label: 'Files' },
        ]}
      />
      {tab === 'members' && (
        <View>
          {channel.members.map((m) => (
            <ListRow key={m.id} left={<Avatar user={m} size="sm" presence />} title={m.name} subtitle={m.title || m.role} onPress={() => go(`/people/${m.id}`)} />
          ))}
          {channel.kind !== 'dm' && me!.role !== 'guest' && channel.joined && (
            <View style={{ gap: 8, marginTop: 8 }}>
              <PeopleField value={adding} onChange={setAdding} exclude={channel.members.map((m) => m.id)} placeholder="Add people" title="Add people" />
              {adding.length > 0 && (
                <Button
                  variant="primary"
                  title={`Add ${adding.length}`}
                  onPress={async () => {
                    await act(() => api.post(`/channels/${channel.id}/members`, { userIds: adding }), 'People added');
                    setAdding([]);
                    onChanged();
                  }}
                />
              )}
            </View>
          )}
          {channel.kind !== 'dm' && channel.joined && (
            <Button
              variant="danger"
              title="Leave channel"
              style={{ marginTop: 10 }}
              onPress={async () => {
                await act(() => api.post(`/channels/${channel.id}/leave`), `Left #${channel.name}`);
                reloadChannels();
                onClose();
                router.back();
              }}
            />
          )}
          {channel.can_manage && channel.kind !== 'dm' && (
            <View style={{ gap: 10, marginTop: 16, paddingTop: 12, borderTopWidth: 1, borderColor: c.line }}>
              <T weight="display" size={16}>
                Channel settings
              </T>
              <Field label="Topic">
                <Input value={topic} onChangeText={setTopic} />
              </Field>
              <Button
                small
                title="Save topic"
                onPress={async () => {
                  await act(() => api.patch(`/channels/${channel.id}`, { topic }), 'Topic updated');
                  onChanged();
                }}
              />
              <Toggle
                label="Allow AI assistance in this channel"
                value={!channel.ai_excluded}
                onChange={async (v) => {
                  await act(() => api.patch('/ai/exclusions', { channelId: channel.id, excluded: !v }), v ? 'AI assistance allowed' : 'AI assistance turned off here');
                  onChanged();
                }}
              />
              <Button
                small
                variant="danger"
                title="Archive channel"
                onPress={async () => {
                  if (!(await confirm(`Archive #${channel.name}?`, 'Messages are kept but no one can post.', 'Archive'))) return;
                  await act(() => api.patch(`/channels/${channel.id}`, { archived: true }), 'Channel archived');
                  reloadChannels();
                  onClose();
                  router.back();
                }}
              />
            </View>
          )}
        </View>
      )}
      {tab === 'pins' &&
        (!pins ? (
          <Loading inline />
        ) : !pins.length ? (
          <Muted>Nothing pinned yet. Long-press a message to pin it.</Muted>
        ) : (
          <View style={{ gap: 12 }}>
            {pins.map((m) => (
              <Pressable key={m.id} onPress={() => go(`/channels/${channel.id}?message=${m.id}`)} style={{ gap: 4, padding: 12, borderRadius: 12, backgroundColor: c.surface, borderWidth: 1, borderColor: c.line }}>
                <Row gap={6}>
                  <T size={14} weight="bold">
                    {m.user?.name}
                  </T>
                  <Muted size={12}>{timeAgo(m.created_at)}</Muted>
                </Row>
                <Markdown text={m.body} compact size={14} />
              </Pressable>
            ))}
          </View>
        ))}
      {tab === 'files' &&
        (!files ? (
          <Loading inline />
        ) : !files.length ? (
          <Muted>No files shared here yet.</Muted>
        ) : (
          <View>
            {files.map((f) => (
              <ListRow key={f.id} left={<Icon name="file" size={18} color={c.ink2} />} title={f.name} subtitle={`${f.owner_name} · ${bytes(f.size)} · ${timeAgo(f.created_at)}`} onPress={() => go(`/files/${f.id}`)} />
            ))}
          </View>
        ))}
    </Sheet>
  );
}
