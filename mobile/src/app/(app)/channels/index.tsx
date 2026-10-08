import { router, Stack } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { api, type Channel } from '@/lib/api';
import { useApi, useReloadOnFocus } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { useTheme } from '@/lib/theme';
import { channelIcon } from '@/ui/chat';
import { Icon } from '@/ui/Icon';
import { Badge, Button, Card, Empty, ErrorState, Field, IconButton, Input, ListRow, Loading, Muted, Pill, Screen, SearchBox, Select, Sheet, T, useAction } from '@/ui/kit';
import { PeopleField } from '@/ui/pickers';

export default function ChannelsBrowser() {
  const { c } = useTheme();
  const { me } = useSession();
  const act = useAction();
  const { data: channels, error, reload, refresh, refreshing } = useApi<Channel[]>('/channels');
  useReloadOnFocus(reload);
  const [creating, setCreating] = useState(false);
  const [filter, setFilter] = useState('');
  const [form, setForm] = useState({ name: '', topic: '', kind: 'public', memberIds: [] as string[] });
  if (error && !channels) return <ErrorState error={error} retry={reload} />;
  const list = (channels ?? []).filter((ch) => ch.kind !== 'dm' && (!filter || ch.name.includes(filter.toLowerCase())));
  const create = async () => {
    const channel = await act(() => api.post<Channel>('/channels', form), 'Channel created');
    if (channel) {
      setCreating(false);
      setForm({ name: '', topic: '', kind: 'public', memberIds: [] });
      router.push(`/channels/${channel.id}`);
    }
  };
  return (
    <>
      <Stack.Screen
        options={{
          title: 'Channels',
          headerRight: () => (me!.role !== 'guest' ? <IconButton name="plus" label="New channel" onPress={() => setCreating(true)} color={c.accentInk} /> : null),
        }}
      />
      <Screen refreshing={refreshing} onRefresh={refresh}>
        <Muted size={14}>Team and project conversations. Join public channels, or ask to be added to private ones.</Muted>
        <SearchBox value={filter} onChangeText={setFilter} placeholder="Filter channels" />
        {!channels ? (
          <Loading inline />
        ) : !list.length ? (
          <Empty icon="hash" title="No channels match" />
        ) : (
          <Card padded={false} style={{ paddingHorizontal: 14 }}>
            {list.map((ch, i) => (
              <View key={ch.id} style={i ? { borderTopWidth: 1, borderColor: c.line2 } : undefined}>
                <ListRow
                  left={<Icon name={channelIcon(ch)} size={18} color={c.ink2} />}
                  title={
                    <T weight={ch.unread ? 'bold' : 'semibold'} numberOfLines={1}>
                      {ch.name}
                    </T>
                  }
                  subtitle={
                    <View style={{ gap: 4 }}>
                      {!!ch.topic && (
                        <Muted size={13} numberOfLines={2}>
                          {ch.topic}
                        </Muted>
                      )}
                      {ch.project_name && <Pill label={ch.project_name} />}
                    </View>
                  }
                  right={
                    ch.joined ? (
                      ch.unread > 0 ? (
                        <Badge count={ch.unread} />
                      ) : (
                        <Muted size={12}>Joined</Muted>
                      )
                    ) : (
                      <Button
                        small
                        title="Join"
                        onPress={async () => {
                          await act(() => api.post(`/channels/${ch.id}/join`), `Joined #${ch.name}`);
                          reload();
                        }}
                      />
                    )
                  }
                  onPress={() => router.push(`/channels/${ch.id}`)}
                />
              </View>
            ))}
          </Card>
        )}
      </Screen>
      <Sheet open={creating} onClose={() => setCreating(false)} title="Create a channel" full footer={<Button title="Create channel" variant="primary" full disabled={!form.name.trim()} onPress={create} />}>
        <Field label="Name" hint="Lowercase letters, numbers and hyphens.">
          <Input value={form.name} onChangeText={(v) => setForm({ ...form, name: v.toLowerCase().replace(/\s+/g, '-') })} placeholder="e.g. design-crit" autoFocus autoCapitalize="none" autoCorrect={false} />
        </Field>
        <Field label="Topic">
          <Input value={form.topic} onChangeText={(v) => setForm({ ...form, topic: v })} placeholder="What is this channel for?" />
        </Field>
        <Field label="Type">
          <Select
            title="Type"
            value={form.kind}
            onChange={(v) => setForm({ ...form, kind: v })}
            options={[
              { id: 'public', label: 'Public', hint: 'Anyone in the workspace can join' },
              { id: 'private', label: 'Private', hint: 'Invite only' },
              ...(['lead', 'admin', 'owner'].includes(me!.role) ? [{ id: 'announcement', label: 'Announcement', hint: 'Only leads and admins post' }] : []),
            ]}
          />
        </Field>
        <Field label="Add people">
          <PeopleField value={form.memberIds} onChange={(ids) => setForm({ ...form, memberIds: ids })} exclude={[me!.user.id]} title="Add people" />
        </Field>
      </Sheet>
    </>
  );
}
