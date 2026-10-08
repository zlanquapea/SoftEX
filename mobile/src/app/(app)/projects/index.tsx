import { router, Stack } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { qs, type Project } from '@/lib/api';
import { useApi, useReloadOnFocus } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { useShell } from '@/lib/shell';
import { swatch, useTheme } from '@/lib/theme';
import { Icon } from '@/ui/Icon';
import { AvatarStack, Button, Card, Empty, ErrorState, HealthPill, IconButton, Loading, Muted, Pill, ProgressBar, Row, Screen, T, Tabs } from '@/ui/kit';

export default function Projects() {
  const { c } = useTheme();
  const { openCreate } = useShell();
  const { me } = useSession();
  const [scope, setScope] = useState<'mine' | 'all' | 'archived'>('mine');
  const { data, error, reload, refresh, refreshing } = useApi<Project[]>(`/projects${qs({ archived: scope === 'archived' ? 'true' : undefined })}`);
  useReloadOnFocus(reload);
  const list = (data ?? []).filter((p) => scope !== 'mine' || p.is_member);
  const guest = me!.role === 'guest';
  return (
    <>
      <Stack.Screen options={{ title: 'Projects', headerRight: () => (!guest ? <IconButton name="plus" label="New project" color={c.accentInk} onPress={() => openCreate('project')} /> : null) }} />
      <Screen refreshing={refreshing} onRefresh={refresh}>
        <Muted size={14}>Plans, owners, progress and health for every initiative you can see.</Muted>
        <Tabs
          value={scope}
          onChange={setScope}
          tabs={[
            { id: 'mine', label: 'My projects' },
            { id: 'all', label: 'All visible' },
            { id: 'archived', label: 'Archived' },
          ]}
        />
        {error && !data ? (
          <ErrorState error={error} retry={reload} />
        ) : !data ? (
          <Loading inline />
        ) : !list.length ? (
          <Empty
            icon="folder"
            title={scope === 'archived' ? 'No archived projects' : 'No projects here yet'}
            action={scope !== 'archived' && !guest ? <Button variant="primary" icon="plus" title="New project" onPress={() => openCreate('project')} /> : undefined}
          >
            {scope === 'archived' ? 'Projects you archive appear here.' : 'A project keeps one piece of work together: its tasks, owners, dates, chat and files.'}
          </Empty>
        ) : (
          list.map((p) => (
            <Card key={p.id} onPress={() => router.push(`/projects/${p.id}`)} style={{ gap: 10 }}>
              <Row style={{ justifyContent: 'space-between' }}>
                <View style={{ width: 38, height: 38, borderRadius: 11, backgroundColor: swatch(p.color), alignItems: 'center', justifyContent: 'center' }}>
                  <Icon name="folder" size={19} color="#fff" />
                </View>
                {p.visibility === 'private' && <Pill label="Private" icon="lock" />}
              </Row>
              <View>
                <T size={17} weight="display">
                  {p.name}
                </T>
                <Muted size={13}>
                  {p.team ? `${p.team.name} · ` : ''}
                  {p.member_count} member{p.member_count === 1 ? '' : 's'}
                </Muted>
              </View>
              <Row style={{ justifyContent: 'space-between' }}>
                <Muted size={12}>
                  {p.stats.done}/{p.stats.total} tasks
                </Muted>
                <T size={12} weight="bold">
                  {p.stats.progress}%
                </T>
              </Row>
              <ProgressBar value={p.stats.progress} color={swatch(p.color)} />
              {(p.stats.overdue > 0 || p.stats.blocked > 0) && (
                <T size={12} tone="amber" weight="semibold">
                  {[p.stats.overdue > 0 && `${p.stats.overdue} overdue`, p.stats.blocked > 0 && `${p.stats.blocked} blocked`].filter(Boolean).join(' · ')}
                </T>
              )}
              <Row style={{ justifyContent: 'space-between' }}>
                <AvatarStack users={p.members} total={p.member_count} />
                <HealthPill health={p.health} />
              </Row>
            </Card>
          ))
        )}
      </Screen>
    </>
  );
}
