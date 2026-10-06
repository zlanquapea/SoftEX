import { router } from 'expo-router';
import { useState } from 'react';
import { FlatList, Pressable, RefreshControl, ScrollView, View } from 'react-native';
import { api, qs, type Notification } from '@/lib/api';
import { plainMentions, timeAgo } from '@/lib/format';
import { useApi, useRealtime } from '@/lib/hooks';
import { useShell } from '@/lib/shell';
import { useTheme } from '@/lib/theme';
import { Icon } from '@/ui/Icon';
import { Avatar, Button, Empty, ErrorState, IconButton, LinkText, Loading, Muted, Row, T, Tabs, useAction } from '@/ui/kit';

type Filter = 'all' | 'unread' | 'mentions' | 'assigned' | 'meetings';
export const KIND_ICON: Record<string, string> = {
  reminder: 'clock',
  billing: 'flag',
  deadline: 'calendar',
  automation: 'refresh',
  mention: 'chat',
  dm: 'chat',
  thread: 'thread',
  urgent: 'alert',
  assigned: 'task',
  review: 'eye',
  handoff: 'arrow',
  status: 'refresh',
  comment: 'chat',
  meeting: 'video',
  request: 'inboxCheck',
  announcement: 'megaphone',
  project: 'folder',
  channel: 'hash',
  page: 'book',
  file: 'file',
};

const KIND_LABEL: Record<string, [string, string]> = {
  reminder: ['reminder', 'reminders'],
  billing: ['billing notice', 'billing notices'],
  deadline: ['deadline', 'deadlines'],
  automation: ['automation', 'automations'],
  mention: ['mention', 'mentions'],
  dm: ['direct message', 'direct messages'],
  thread: ['thread reply', 'thread replies'],
  urgent: ['urgent message', 'urgent messages'],
  assigned: ['assignment', 'assignments'],
  review: ['review request', 'review requests'],
  handoff: ['handoff', 'handoffs'],
  status: ['status change', 'status changes'],
  comment: ['comment', 'comments'],
  meeting: ['meeting update', 'meeting updates'],
  request: ['request', 'requests'],
  announcement: ['announcement', 'announcements'],
  project: ['project update', 'project updates'],
  channel: ['channel update', 'channel updates'],
  page: ['page update', 'page updates'],
  file: ['file update', 'file updates'],
};
const kindLabel = (kind: string, count: number) => {
  const [one, many] = KIND_LABEL[kind] ?? [kind, kind];
  return `${count} ${count === 1 ? one : many}`;
};

type Item = Notification & { actor_name: string; actor_color: string };

export default function Inbox() {
  const { c } = useTheme();
  const { reloadCounts } = useShell();
  const [filter, setFilter] = useState<Filter>('all');
  const [kind, setKind] = useState<string | null>(null);
  const act = useAction();
  const { data, error, reload, refresh, refreshing, setData } = useApi<{ notifications: Item[]; unread: number }>(`/notifications${qs({ filter, kind, limit: 100 })}`);
  const { data: digest, reload: reloadDigest } = useApi<{ kind: string; count: number; unread: number }[]>('/notifications/digest');
  useRealtime((e) => {
    if (e.type === 'notification') {
      reload();
      reloadDigest();
    }
  });

  const markRead = async (n: Notification, read = true) => {
    await api.post(`/notifications/${n.id}/read`, { read }).catch(() => {});
    setData(data && { ...data, unread: Math.max(0, data.unread + (read ? -1 : 1)), notifications: data.notifications.map((x) => (x.id === n.id ? { ...x, read_at: read ? new Date().toISOString() : null } : x)) });
    reloadCounts();
  };

  const header = (
    <View style={{ gap: 12, paddingBottom: 6 }}>
      <Row style={{ justifyContent: 'space-between' }}>
        <Muted size={14} style={{ flex: 1 }}>
          Mentions, assignments, reviews, meeting updates and approvals in one place.
        </Muted>
        <Button
          small
          icon="check"
          title="Mark all read"
          onPress={async () => {
            await act(() => api.post('/notifications/read-all'), 'All caught up');
            reload();
            reloadCounts();
          }}
        />
      </Row>
      {digest && digest.length > 0 && (
        <View style={{ gap: 6 }}>
          <Muted size={12}>Last 24 hours</Muted>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
            {digest.map((d) => {
              const on = kind === d.kind;
              return (
                <Pressable
                  key={d.kind}
                  onPress={() => {
                    setKind(on ? null : d.kind);
                    setFilter('all');
                  }}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on }}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, height: 30, borderRadius: 15, backgroundColor: on ? c.accentSoft : c.surface, borderWidth: 1, borderColor: on ? c.accentLine : c.line }}
                >
                  <Icon name={KIND_ICON[d.kind] ?? 'bell'} size={12} color={on ? c.accentInk : c.ink2} />
                  <T size={12} weight="semibold" tone={on ? 'accent' : 'ink2'}>
                    {kindLabel(d.kind, d.count)}
                    {d.unread ? ` · ${d.unread} new` : ''}
                  </T>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
      )}
      {kind && (
        <Row gap={4}>
          <Muted size={13}>Showing {KIND_LABEL[kind]?.[1] ?? kind} only.</Muted>
          <LinkText size={13} onPress={() => setKind(null)}>
            Show everything
          </LinkText>
        </Row>
      )}
      <Tabs
        value={filter}
        onChange={(f) => {
          setFilter(f);
          setKind(null);
        }}
        tabs={[
          { id: 'all', label: 'All' },
          { id: 'unread', label: 'Unread', count: data?.unread },
          { id: 'mentions', label: 'Mentions & DMs' },
          { id: 'assigned', label: 'Tasks' },
          { id: 'meetings', label: 'Meetings' },
        ]}
      />
    </View>
  );

  if (error && !data) return <ErrorState error={error} retry={reload} />;
  return (
    <FlatList
      style={{ flex: 1, backgroundColor: c.canvas }}
      contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
      data={data?.notifications ?? []}
      keyExtractor={(n) => n.id}
      ListHeaderComponent={header}
      ListEmptyComponent={
        data ? (
          <Empty icon="inbox" title="Nothing here">
            You are all caught up.
          </Empty>
        ) : (
          <Loading inline />
        )
      }
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={c.accent} />}
      ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
      renderItem={({ item: n }) => (
        <Pressable
          onPress={() => {
            if (!n.read_at) markRead(n);
            if (n.link) router.push(n.link as never);
          }}
          accessibilityRole="button"
          style={({ pressed }) => ({
            flexDirection: 'row',
            gap: 12,
            padding: 12,
            borderRadius: 14,
            backgroundColor: pressed ? c.hover : n.read_at ? c.surface : c.accentWash,
            borderWidth: 1,
            borderColor: n.urgent ? c.redLine : n.read_at ? c.line : c.accentLine,
          })}
        >
          {n.actor_name ? (
            <Avatar user={{ id: n.actor_id ?? undefined, name: n.actor_name, color: n.actor_color }} size="md" />
          ) : (
            <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: c.line2, alignItems: 'center', justifyContent: 'center' }}>
              <Icon name={KIND_ICON[n.kind] ?? 'bell'} size={16} color={c.ink2} />
            </View>
          )}
          <View style={{ flex: 1, gap: 3 }}>
            <Row gap={5} style={{ alignItems: 'flex-start' }}>
              <View style={{ paddingTop: 3 }}>
                <Icon name={KIND_ICON[n.kind] ?? 'bell'} size={13} color={n.urgent ? c.red : c.muted} />
              </View>
              <T size={14} weight={n.read_at ? 'medium' : 'bold'} style={{ flex: 1 }}>
                {n.title}
              </T>
            </Row>
            {!!n.body && (
              <Muted size={13} numberOfLines={3}>
                {plainMentions(n.body)}
              </Muted>
            )}
            <Muted size={11}>{timeAgo(n.created_at)}</Muted>
          </View>
          <IconButton name={n.read_at ? 'bell' : 'check'} label={n.read_at ? 'Mark as unread' : 'Mark as read'} size={17} onPress={() => markRead(n, !n.read_at)} />
        </Pressable>
      )}
    />
  );
}
