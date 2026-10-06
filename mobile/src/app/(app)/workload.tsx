import { router, Stack } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { qs } from '@/lib/api';
import { useApi, useRealtime } from '@/lib/hooks';
import { swatch, useTheme } from '@/lib/theme';
import { Avatar, Card, Empty, ErrorState, ListRow, Loading, Muted, Row, Screen, Select, Sheet, T } from '@/ui/kit';
import { UpgradeNotice, usePlan } from '@/ui/plan';
import { shortDate } from '@/ui/planning';

interface WorkloadItem {
  id: string;
  title: string;
  due_date: string | null;
  project: string;
  color: string;
  estimate_hours: number | null;
}
interface WorkloadData {
  weeks: string[];
  capacity_hours_per_week: number;
  rows: { person: { id: string; name: string; color: string; title: string }; total: number; buckets: Record<string, { tasks: number; hours: number; items: WorkloadItem[] }> }[];
}

export default function Workload() {
  const { has } = usePlan();
  return (
    <>
      <Stack.Screen options={{ title: 'Workload' }} />
      {has('planning') ? (
        <WorkloadView />
      ) : (
        <Screen>
          <UpgradeNotice feature="planning" />
        </Screen>
      )}
    </>
  );
}

function WorkloadView() {
  const { c } = useTheme();
  const [weeks, setWeeks] = useState('4');
  const [projectId, setProjectId] = useState('');
  const [teamId, setTeamId] = useState('');
  const [cell, setCell] = useState<{ person: string; key: string; items: WorkloadItem[] } | null>(null);
  const { data: projects } = useApi<{ id: string; name: string }[]>('/projects');
  const { data: teams } = useApi<{ id: string; name: string }[]>('/teams');
  const { data, error, reload, refresh, refreshing } = useApi<WorkloadData>(`/workload${qs({ weeks, projectId, teamId })}`);
  useRealtime((e) => e.type === 'task.updated' && reload());
  const keys = data ? ['overdue', ...data.weeks, 'unscheduled'] : [];
  const label = (k: string) => (k === 'overdue' ? 'Overdue' : k === 'unscheduled' ? 'No date' : `Week of ${shortDate(k)}`);
  const load = (b: { tasks: number; hours: number }) => (b.hours || b.tasks * 6) / (data?.capacity_hours_per_week ?? 32);
  const levelColor = [c.greenSoft, c.green + '55', c.amberSoft, c.redSoft];
  return (
    <Screen refreshing={refreshing} onRefresh={refresh}>
      <Muted size={14}>Open tasks per person by due week. Use it to spot overload before it becomes a missed deadline.</Muted>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
        <View style={{ width: 160 }}>
          <Select title="Project" value={projectId} onChange={setProjectId} options={[{ id: '', label: 'All projects' }, ...(projects ?? []).map((p) => ({ id: p.id, label: p.name }))]} />
        </View>
        <View style={{ width: 140 }}>
          <Select title="Team" value={teamId} onChange={setTeamId} options={[{ id: '', label: 'Everyone' }, ...(teams ?? []).map((t) => ({ id: t.id, label: t.name }))]} />
        </View>
        <View style={{ width: 120 }}>
          <Select title="Weeks shown" value={weeks} onChange={setWeeks} options={[2, 4, 6, 8, 12].map((n) => ({ id: String(n), label: `${n} weeks` }))} />
        </View>
      </ScrollView>
      <Row gap={10}>
        {[
          ['Light', levelColor[0]],
          ['Full', levelColor[2]],
          ['Over capacity', levelColor[3]],
        ].map(([l, col]) => (
          <Row key={l} gap={4}>
            <View style={{ width: 12, height: 12, borderRadius: 3, backgroundColor: col }} />
            <Muted size={12}>{l}</Muted>
          </Row>
        ))}
      </Row>
      {error && !data ? (
        <ErrorState error={error} retry={reload} />
      ) : !data ? (
        <Loading inline />
      ) : !data.rows.length ? (
        <Empty icon="users" title="No one has open work here" />
      ) : (
        <Card padded={false} style={{ overflow: 'hidden' }}>
          <ScrollView horizontal>
            <View>
              <Row gap={0} style={{ borderBottomWidth: 1, borderColor: c.line, backgroundColor: c.surface2 }}>
                <View style={{ width: 140, padding: 10 }}>
                  <T size={12} weight="bold" tone="muted">
                    Person
                  </T>
                </View>
                {keys.map((k) => (
                  <View key={k} style={{ width: 84, padding: 10 }}>
                    <T size={11} weight="bold" tone="muted" numberOfLines={2}>
                      {label(k)}
                    </T>
                  </View>
                ))}
              </Row>
              {data.rows.map((row) => (
                <Row key={row.person.id} gap={0} style={{ borderBottomWidth: 1, borderColor: c.line2 }}>
                  <Pressable onPress={() => router.push(`/people/${row.person.id}`)} style={{ width: 140, padding: 8, flexDirection: 'row', gap: 6, alignItems: 'center' }}>
                    <Avatar user={row.person} size="sm" />
                    <View style={{ flex: 1 }}>
                      <T size={13} weight="bold" numberOfLines={1}>
                        {row.person.name}
                      </T>
                      <Muted size={11}>{row.total} open</Muted>
                    </View>
                  </Pressable>
                  {keys.map((k) => {
                    const b = row.buckets[k];
                    const level = k === 'unscheduled' ? 0 : Math.min(3, Math.floor(load(b) * 2.2));
                    return (
                      <View key={k} style={{ width: 84, padding: 4 }}>
                        {b.tasks > 0 ? (
                          <Pressable
                            onPress={() => setCell({ person: row.person.name, key: k, items: b.items })}
                            accessibilityRole="button"
                            accessibilityLabel={`${row.person.name}, ${label(k)}: ${b.tasks} tasks`}
                            style={{ height: 44, borderRadius: 9, alignItems: 'center', justifyContent: 'center', backgroundColor: k === 'overdue' ? c.redSoft : levelColor[level] }}
                          >
                            <T weight="bold" tone={k === 'overdue' ? 'red' : 'ink'}>
                              {b.tasks}
                            </T>
                            {b.hours > 0 && <Muted size={10}>{b.hours}h</Muted>}
                          </Pressable>
                        ) : (
                          <View style={{ height: 44, alignItems: 'center', justifyContent: 'center' }}>
                            <Muted>·</Muted>
                          </View>
                        )}
                      </View>
                    );
                  })}
                </Row>
              ))}
            </View>
          </ScrollView>
        </Card>
      )}
      <Sheet open={!!cell} onClose={() => setCell(null)} title={cell ? `${cell.person} · ${label(cell.key)}` : ''}>
        <View>
          {cell?.items.map((t) => (
            <ListRow
              key={t.id}
              left={<View style={{ width: 10, height: 10, borderRadius: 3, backgroundColor: swatch(t.color) }} />}
              title={t.title}
              subtitle={`${t.project} · ${t.due_date ? `due ${shortDate(t.due_date)}` : 'no due date'}${t.estimate_hours ? ` · ${t.estimate_hours}h` : ''}`}
              onPress={() => {
                setCell(null);
                router.push(`/tasks/${t.id}`);
              }}
            />
          ))}
        </View>
      </Sheet>
    </Screen>
  );
}
