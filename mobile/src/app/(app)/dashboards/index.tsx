import { router, Stack } from 'expo-router';
import { useState } from 'react';
import { api } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { useApi, useReloadOnFocus } from '@/lib/hooks';
import { useTheme } from '@/lib/theme';
import { Icon } from '@/ui/Icon';
import { Button, Card, Empty, ErrorState, Field, IconButton, Input, Loading, Muted, Row, Screen, Select, Sheet, T, useAction } from '@/ui/kit';
import { UpgradeNotice, usePlan } from '@/ui/plan';

interface DashboardSummary {
  id: string;
  name: string;
  description: string;
  visibility: 'private' | 'workspace';
  owner_name: string;
  updated_at: string;
}

export default function Dashboards() {
  const { c } = useTheme();
  const plan = usePlan();
  const act = useAction();
  const { data, error, reload, refresh, refreshing } = useApi<DashboardSummary[]>('/dashboards');
  useReloadOnFocus(reload);
  const readOnly = !plan.has('insights');
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [visibility, setVisibility] = useState<'workspace' | 'private'>('workspace');
  return (
    <>
      <Stack.Screen options={{ title: 'Dashboards', headerRight: () => (!readOnly ? <IconButton name="plus" label="New dashboard" color={c.accentInk} onPress={() => setCreating(true)} /> : null) }} />
      <Screen refreshing={refreshing} onRefresh={refresh}>
        <Muted size={14}>Charts over tasks, time and goals. Everyone sees numbers from the projects they can open, so sharing a dashboard never shares private work.</Muted>
        {readOnly && <UpgradeNotice feature="insights" readOnly={!!data?.length} />}
        {error && !data ? (
          <ErrorState error={error} retry={reload} />
        ) : !data ? (
          <Loading inline />
        ) : !data.length ? (
          readOnly ? null : (
            <Empty icon="chart" title="No dashboards yet" action={<Button variant="primary" icon="plus" title="New dashboard" onPress={() => setCreating(true)} />}>
              Create one to see open work, overdue tasks, progress and trends at a glance. It starts with useful charts you can change.
            </Empty>
          )
        ) : (
          data.map((d) => (
            <Card key={d.id} onPress={() => router.push(`/dashboards/${d.id}`)} style={{ gap: 6 }}>
              <Row>
                <Icon name="chart" size={18} color={c.accentInk} />
                <T weight="bold" style={{ flex: 1 }}>
                  {d.name}
                </T>
                {d.visibility === 'private' && <Icon name="lock" size={14} color={c.muted} />}
              </Row>
              {!!d.description && <Muted>{d.description}</Muted>}
              <Muted size={12}>
                {d.owner_name} · updated {timeAgo(d.updated_at)}
              </Muted>
            </Card>
          ))
        )}
      </Screen>
      <Sheet
        open={creating}
        onClose={() => setCreating(false)}
        title="New dashboard"
        footer={
          <Button
            title="Create"
            variant="primary"
            full
            disabled={!name.trim()}
            onPress={async () => {
              const d = await act(() => api.post<{ id: string }>('/dashboards', { name, visibility }));
              if (d) {
                setCreating(false);
                setName('');
                router.push(`/dashboards/${d.id}`);
              }
            }}
          />
        }
      >
        <Field label="Name">
          <Input value={name} onChangeText={setName} maxLength={100} placeholder="Operations this quarter" autoFocus />
        </Field>
        <Field label="Who can open it">
          <Select
            title="Who can open it"
            value={visibility}
            onChange={setVisibility}
            options={[
              { id: 'workspace', label: 'Everyone in the workspace', hint: 'Each sees their own data' },
              { id: 'private', label: 'Only me' },
            ]}
          />
        </Field>
      </Sheet>
    </>
  );
}
