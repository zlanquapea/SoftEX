import { router, Stack } from 'expo-router';
import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { dateLabel } from '@/lib/format';
import { useApi, useReloadOnFocus } from '@/lib/hooks';
import { useTheme } from '@/lib/theme';
import { GOAL_STATUS_LABEL, GoalForm, GoalStatusPill, pct, type Goal, type GoalStatus } from '@/ui/goals';
import { Icon } from '@/ui/Icon';
import { Avatar, Button, Card, Empty, ErrorState, IconButton, Loading, Muted, Pill, ProgressBar, Row, Screen, T, Tabs } from '@/ui/kit';
import { UpgradeNotice, usePlan } from '@/ui/plan';

export default function Goals() {
  const { c } = useTheme();
  const plan = usePlan();
  const [tab, setTab] = useState<'active' | 'archived'>('active');
  const [creating, setCreating] = useState(false);
  const { data, error, reload, refresh, refreshing } = useApi<Goal[]>(`/goals?archived=${tab === 'archived'}`);
  useReloadOnFocus(reload);
  const readOnly = !plan.has('goals');
  const ids = new Set(data?.map((g) => g.id));
  const roots = (data ?? []).filter((g) => !g.parent_id || !ids.has(g.parent_id));
  const children = (id: string) => (data ?? []).filter((g) => g.parent_id === id);
  const counts = (data ?? []).reduce<Record<string, number>>((acc, g) => ({ ...acc, [g.status]: (acc[g.status] ?? 0) + 1 }), {});

  const renderGoal = (g: Goal, depth: number): React.ReactNode => (
    <View key={g.id}>
      <Pressable
        onPress={() => router.push(`/goals/${g.id}`)}
        accessibilityRole="button"
        style={({ pressed }) => ({ paddingVertical: 12, paddingLeft: depth * 18, gap: 6, borderTopWidth: 1, borderColor: c.line2, backgroundColor: pressed ? c.hover : 'transparent' })}
      >
        <Row>
          <Icon name={depth ? 'chevronRight' : 'target'} size={16} color={c.accentInk} />
          <T weight="bold" style={{ flex: 1 }}>
            {g.title}
          </T>
          <Avatar user={g.owner} size="xs" />
        </Row>
        <Muted size={12}>
          {g.key_results.length} key result{g.key_results.length === 1 ? '' : 's'}
          {g.due_date ? ` · due ${dateLabel(g.due_date)}` : ''}
        </Muted>
        <Row>
          <View style={{ flex: 1 }}>
            <ProgressBar value={g.progress * 100} />
          </View>
          <T size={12} weight="bold">
            {pct(g.progress)}
          </T>
          <GoalStatusPill status={g.status} />
        </Row>
      </Pressable>
      {children(g.id).map((ch) => renderGoal(ch, depth + 1))}
    </View>
  );

  return (
    <>
      <Stack.Screen options={{ title: 'Goals', headerRight: () => (!readOnly ? <IconButton name="plus" label="New goal" color={c.accentInk} onPress={() => setCreating(true)} /> : null) }} />
      <Screen refreshing={refreshing} onRefresh={refresh}>
        <Muted size={14}>What the organisation is aiming for this season, how far along it is, and the projects that get it there.</Muted>
        {readOnly && <UpgradeNotice feature="goals" readOnly={!!data?.length} />}
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { id: 'active', label: 'Active' },
            { id: 'archived', label: 'Archived' },
          ]}
        />
        {error && !data ? (
          <ErrorState error={error} retry={reload} />
        ) : !data ? (
          <Loading inline />
        ) : !data.length ? (
          <Empty icon="target" title={tab === 'active' ? 'No goals yet' : 'Nothing archived'} action={tab === 'active' && !readOnly ? <Button variant="primary" icon="plus" title="New goal" onPress={() => setCreating(true)} /> : undefined}>
            {tab === 'active' ? 'Set a goal, add key results you can measure, and link the projects that move it.' : undefined}
          </Empty>
        ) : (
          <>
            {tab === 'active' && (
              <Row wrap gap={6}>
                {(['on_track', 'at_risk', 'off_track', 'done'] as GoalStatus[]).map((s) => (
                  <Pill key={s} label={`${counts[s] ?? 0} ${GOAL_STATUS_LABEL[s].toLowerCase()}`} />
                ))}
              </Row>
            )}
            <Card padded={false} style={{ paddingHorizontal: 14 }}>
              {roots.map((g) => renderGoal(g, 0))}
            </Card>
          </>
        )}
      </Screen>
      {creating && (
        <GoalForm
          goals={data ?? []}
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            reload();
          }}
        />
      )}
    </>
  );
}
