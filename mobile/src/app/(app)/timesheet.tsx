import { Stack } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { api, type TimeEntry } from '@/lib/api';
import { duration } from '@/lib/format';
import { useApi, useReloadOnFocus } from '@/lib/hooks';
import { useShell } from '@/lib/shell';
import { useTheme } from '@/lib/theme';
import { Button, Card, Empty, ErrorState, IconButton, ListRow, Loading, Muted, Row, Screen, T, useAction } from '@/ui/kit';
import { UpgradeNotice, usePlan } from '@/ui/plan';
import { useElapsed } from '@/ui/work';

interface Week {
  week: string;
  entries: (TimeEntry & { project_id: string | null })[];
  days: { date: string; minutes: number }[];
  total_minutes: number;
  running: TimeEntry | null;
}
const shift = (week: string, days: number) => {
  const d = new Date(`${week}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

export default function Timesheet() {
  const { c } = useTheme();
  const plan = usePlan();
  const act = useAction();
  const { openTask } = useShell();
  const [week, setWeek] = useState<string | undefined>(undefined);
  const { data, error, reload, refresh, refreshing } = useApi<Week>(`/time/me${week ? `?week=${week}` : ''}`);
  useReloadOnFocus(reload);
  const elapsed = useElapsed(data?.running?.started_at);
  if (error && !data) return <ErrorState error={error} retry={reload} />;
  if (!data) return <Loading />;
  const locked = !plan.has('fields');
  const max = Math.max(...data.days.map((d) => d.minutes), 60);
  const today = new Date().toISOString().slice(0, 10);
  return (
    <>
      <Stack.Screen options={{ title: 'Timesheet' }} />
      <Screen refreshing={refreshing} onRefresh={refresh}>
        <Muted size={14}>Time you’ve logged on tasks. Start a timer or log time from any task.</Muted>
        {locked && <UpgradeNotice feature="fields" readOnly={data.days.some((d) => d.minutes > 0)} />}
        <Row style={{ justifyContent: 'space-between' }}>
          <IconButton name="chevronLeft" label="Previous week" onPress={() => setWeek(shift(data.week, -7))} />
          <T weight="bold">Week of {new Date(`${data.week}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })}</T>
          <IconButton name="chevronRight" label="Next week" onPress={() => setWeek(shift(data.week, 7))} />
        </Row>
        {week && <Button small title="This week" onPress={() => setWeek(undefined)} />}
        {data.running && (
          <Card style={{ flexDirection: 'row', alignItems: 'center', gap: 10, borderColor: c.redLine }}>
            <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: c.red }} />
            <T weight="bold">{elapsed}</T>
            <T tone="accent" style={{ flex: 1 }} numberOfLines={1} onPress={() => openTask(data.running!.task_id)}>
              {data.running.task_title}
            </T>
            <Button
              small
              title="Stop"
              onPress={async () => {
                await act(() => api.post('/time/stop'));
                reload();
              }}
            />
          </Card>
        )}
        <Card style={{ gap: 12 }}>
          <Row style={{ alignItems: 'flex-end', height: 140 }} gap={6}>
            {data.days.map((d) => (
              <View key={d.date} style={{ flex: 1, alignItems: 'center', gap: 4, height: '100%', justifyContent: 'flex-end' }}>
                <View style={{ width: '70%', flex: 1, justifyContent: 'flex-end' }}>
                  <View style={{ height: `${Math.max(2, (d.minutes / max) * 100)}%`, borderRadius: 6, backgroundColor: d.date === today ? c.accent : c.accentLine }} />
                </View>
                <T size={11} weight="bold">
                  {d.minutes ? duration(d.minutes) : '—'}
                </T>
                <Muted size={11}>{new Date(`${d.date}T00:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', timeZone: 'UTC' })}</Muted>
              </View>
            ))}
          </Row>
          <Muted>
            Total this week: <T weight="bold">{duration(data.total_minutes)}</T>
          </Muted>
        </Card>
        <Card padded={false} style={{ paddingHorizontal: 14 }}>
          {!data.entries.length ? (
            <Empty icon="clock" title="No time logged this week" />
          ) : (
            data.entries
              .slice()
              .reverse()
              .map((e) => (
                <ListRow
                  key={e.id}
                  left={
                    <View style={{ width: 54 }}>
                      <Muted size={11}>{new Date(e.started_at).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' })}</Muted>
                      <T size={14} weight="bold">
                        {e.running ? elapsed : duration(e.minutes)}
                      </T>
                    </View>
                  }
                  title={e.task_title ?? 'Task'}
                  subtitle={e.note || undefined}
                  onPress={() => openTask(e.task_id)}
                  right={
                    !e.running ? (
                      <IconButton
                        name="x"
                        size={14}
                        label="Remove time entry"
                        onPress={async () => {
                          await act(() => api.del(`/time/${e.id}`));
                          reload();
                        }}
                      />
                    ) : undefined
                  }
                />
              ))
          )}
        </Card>
      </Screen>
    </>
  );
}
