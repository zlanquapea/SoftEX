import { router } from 'expo-router';
import { View } from 'react-native';
import type { Channel, Message } from '@/lib/api';
import { plainMentions, timeAgo } from '@/lib/format';
import { useApi, useRealtime, useReloadOnFocus } from '@/lib/hooks';
import { useShell } from '@/lib/shell';
import { useTheme } from '@/lib/theme';
import { Icon } from '@/ui/Icon';
import { Avatar, Badge, Button, Card, Empty, ErrorState, H2, ListRow, Loading, Muted, Row, Screen, T } from '@/ui/kit';

export default function Chats() {
  const { c } = useTheme();
  const { openCreate } = useShell();
  const { data: channels, error, reload, refresh, refreshing } = useApi<Channel[]>('/channels');
  const { data: saved, reload: reloadSaved } = useApi<(Message & { channel_name: string; channel_kind: string })[]>('/saved');
  useRealtime((e) => (e.type === 'message.created' || e.type === 'presence' || e.type === 'reconnected') && reload());
  useReloadOnFocus(() => {
    reload();
    reloadSaved();
  });
  if (error && !channels) return <ErrorState error={error} retry={reload} />;
  if (!channels) return <Loading />;
  const dms = channels.filter((ch) => ch.kind === 'dm').sort((a, b) => (b.last_message_at ?? '').localeCompare(a.last_message_at ?? ''));
  return (
    <Screen refreshing={refreshing} onRefresh={refresh}>
      <Row style={{ justifyContent: 'space-between' }}>
        <Muted size={14}>Direct and group conversations.</Muted>
        <Button small variant="primary" icon="plus" title="New message" onPress={() => openCreate('message')} />
      </Row>
      {!dms.length ? (
        <Card>
          <Empty icon="chat" title="No conversations yet" action={<Button variant="primary" icon="plus" title="New message" onPress={() => openCreate('message')} />}>
            Start a direct message with a teammate.
          </Empty>
        </Card>
      ) : (
        <Card padded={false} style={{ paddingHorizontal: 14 }}>
          {dms.map((ch, i) => (
            <View key={ch.id} style={i ? { borderTopWidth: 1, borderColor: c.line2 } : undefined}>
              <ListRow
                left={
                  ch.members && ch.members.length === 1 ? (
                    <Avatar user={ch.members[0]} size="md" presence />
                  ) : (
                    <Avatar user={{ name: String(ch.members?.length ?? 0), color: 'lilac' }} size="md" />
                  )
                }
                title={
                  <Row style={{ justifyContent: 'space-between' }}>
                    <T weight={ch.unread ? 'bold' : 'semibold'} numberOfLines={1} style={{ flex: 1 }}>
                      {ch.members?.map((m) => m.name).join(', ') || 'Just you'}
                    </T>
                    {ch.last_message_at && <Muted size={12}>{timeAgo(ch.last_message_at)}</Muted>}
                  </Row>
                }
                subtitle={
                  <Muted size={13} numberOfLines={1} style={ch.unread ? { color: c.ink2 } : undefined}>
                    {ch.last_message ? `${ch.last_message.mine ? 'You: ' : ''}${plainMentions(ch.last_message.text) || 'Sent an attachment'}` : 'No messages yet'}
                  </Muted>
                }
                right={ch.unread > 0 ? <Badge count={ch.unread} /> : undefined}
                onPress={() => router.push(`/channels/${ch.id}`)}
              />
            </View>
          ))}
        </Card>
      )}
      {saved && saved.length > 0 && (
        <>
          <H2 style={{ marginTop: 6 }}>Saved messages</H2>
          <Card padded={false} style={{ paddingHorizontal: 14 }}>
            {saved.map((m, i) => (
              <View key={m.id} style={i ? { borderTopWidth: 1, borderColor: c.line2 } : undefined}>
                <ListRow
                  left={<Avatar user={m.user} size="sm" />}
                  title={
                    <T size={14} weight="semibold" numberOfLines={1}>
                      {m.user?.name} <T size={12} tone="muted">in {m.channel_kind === 'dm' ? 'a direct message' : `#${m.channel_name}`}</T>
                    </T>
                  }
                  subtitle={plainMentions(m.body).slice(0, 140)}
                  right={<Icon name="bookmark" size={16} color={c.accentInk} />}
                  onPress={() => router.push(`/channels/${m.channel_id}?message=${m.parent_id ?? m.id}`)}
                />
              </View>
            ))}
          </Card>
        </>
      )}
    </Screen>
  );
}
