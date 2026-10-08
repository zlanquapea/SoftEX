import { router, Stack } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { localTimeIn, ROLE_LABEL } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { statusLabel } from '@/lib/shell';
import { useTheme } from '@/lib/theme';
import { STATUS_DOT } from '@/ui/header';
import { Avatar, Card, Dot, Empty, Muted, Pill, Row, Screen, SearchBox, Select, T, Tabs } from '@/ui/kit';

export default function Directory() {
  const { c } = useTheme();
  const { people, reloadPeople } = useSession();
  const [tab, setTab] = useState<'people' | 'teams'>('people');
  const [q, setQ] = useState('');
  const [team, setTeam] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const { data: teams, reload: reloadTeams } = useApi<{ id: string; name: string; description: string; members: { id: string; name: string; color: string }[] }[]>('/teams');
  const filtered = people.filter((p) => (!q || `${p.name} ${p.title} ${p.expertise.join(' ')} ${p.email}`.toLowerCase().includes(q.toLowerCase())) && (!team || p.teams.some((t) => t.id === team)));
  return (
    <>
      <Stack.Screen options={{ title: 'Directory' }} />
      <Screen
        refreshing={refreshing}
        onRefresh={async () => {
          setRefreshing(true);
          await Promise.all([reloadPeople(), reloadTeams()]);
          setRefreshing(false);
        }}
      >
        <Muted size={14}>Find people by team, role, expertise and working hours.</Muted>
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { id: 'people', label: 'People', count: people.length },
            { id: 'teams', label: 'Teams', count: teams?.length },
          ]}
        />
        {tab === 'people' && (
          <>
            <SearchBox value={q} onChangeText={setQ} placeholder="Name, role or expertise" />
            {!!teams?.length && <Select title="Team" value={team} onChange={setTeam} options={[{ id: '', label: 'All teams' }, ...teams.map((t) => ({ id: t.id, label: t.name }))]} />}
            {!filtered.length && <Empty icon="users" title="No one matches" />}
            {filtered.map((p) => (
              <Card key={p.id} onPress={() => router.push(`/people/${p.id}`)} style={{ flexDirection: 'row', gap: 12 }}>
                <Avatar user={p} size="lg" presence />
                <View style={{ flex: 1, gap: 3 }}>
                  <T weight="bold">{p.name}</T>
                  <Muted size={13}>{p.title || ROLE_LABEL[p.role]}</Muted>
                  <Row gap={5}>
                    <Dot color={STATUS_DOT[p.status] ?? c.dotAway} />
                    <T size={12} tone="ink2">
                      {p.status_text || statusLabel(p.status)} · {localTimeIn(p.timezone)}
                    </T>
                  </Row>
                  <Row wrap gap={4}>
                    {p.role === 'guest' && <Pill label="Guest" />}
                    {p.teams.map((t) => (
                      <Pill key={t.id} label={t.name} />
                    ))}
                    {p.expertise.slice(0, 3).map((x) => (
                      <Pill key={x} label={x} tone="accent" />
                    ))}
                  </Row>
                </View>
              </Card>
            ))}
          </>
        )}
        {tab === 'teams' && (
          <>
            {teams?.map((t) => (
              <Card key={t.id} style={{ gap: 8 }}>
                <T size={16} weight="display">
                  {t.name}
                </T>
                <Muted>{t.description || 'No description.'}</Muted>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
                  {t.members.map((m) => (
                    <Pressable key={m.id} onPress={() => router.push(`/people/${m.id}`)} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingRight: 10, paddingLeft: 3, paddingVertical: 3, borderRadius: 999, backgroundColor: c.line2 }}>
                      <Avatar user={m} size="xs" />
                      <T size={13}>{m.name}</T>
                    </Pressable>
                  ))}
                </ScrollView>
              </Card>
            ))}
            {teams && !teams.length && <Empty icon="users" title="No teams yet">Leads and admins can create teams in Administration.</Empty>}
          </>
        )}
      </Screen>
    </>
  );
}
