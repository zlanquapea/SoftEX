import { router, Stack } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import type { Decision } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { useTheme } from '@/lib/theme';
import { Icon } from '@/ui/Icon';
import { Card, Empty, ErrorState, LinkText, Loading, Muted, Row, Screen, SearchBox, T } from '@/ui/kit';
import { Markdown } from '@/ui/Markdown';

export default function Decisions() {
  const { c } = useTheme();
  const { data, error, reload, refresh, refreshing } = useApi<Decision[]>('/decisions?limit=200');
  const [q, setQ] = useState('');
  const list = (data ?? []).filter((d) => !q || `${d.title} ${d.rationale} ${d.project_name ?? ''}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <>
      <Stack.Screen options={{ title: 'Decisions' }} />
      <Screen refreshing={refreshing} onRefresh={refresh}>
        <Muted size={14}>Every recorded decision you can access, linked back to where it was made.</Muted>
        <SearchBox value={q} onChangeText={setQ} placeholder="Filter decisions" />
        {error && !data ? (
          <ErrorState error={error} retry={reload} />
        ) : !data ? (
          <Loading inline />
        ) : !list.length ? (
          <Empty icon="gavel" title="No decisions yet">
            Record decisions from a message menu, a meeting, or a project’s Decisions tab.
          </Empty>
        ) : (
          list.map((d) => (
            <Card key={d.id} style={{ flexDirection: 'row', gap: 12 }}>
              <View style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: c.amberSoft, alignItems: 'center', justifyContent: 'center' }}>
                <Icon name="gavel" size={16} color={c.amberInk} />
              </View>
              <View style={{ flex: 1, gap: 4 }}>
                <T weight="bold">{d.title}</T>
                {!!d.rationale && <Markdown text={d.rationale} compact size={14} />}
                <Muted size={12}>
                  {d.decided_by_name} · {dateTime(d.created_at)}
                </Muted>
                <Row wrap gap={10}>
                  {d.project_id && (
                    <LinkText size={13} onPress={() => router.push(`/projects/${d.project_id}?tab=decisions`)}>
                      {d.project_name ?? 'Project'}
                    </LinkText>
                  )}
                  {d.channel_id && d.message_id && (
                    <LinkText size={13} onPress={() => router.push(`/channels/${d.channel_id}?message=${d.message_id}`)}>
                      #{d.channel_name}
                    </LinkText>
                  )}
                  {d.meeting_id && (
                    <LinkText size={13} onPress={() => router.push(`/meetings/${d.meeting_id}`)}>
                      {d.meeting_title}
                    </LinkText>
                  )}
                </Row>
              </View>
            </Card>
          ))
        )}
      </Screen>
    </>
  );
}
