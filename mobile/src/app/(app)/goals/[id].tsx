import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { api, type Project } from '@/lib/api';
import { dateLabel } from '@/lib/format';
import { useApi } from '@/lib/hooks';
import { swatch, useTheme } from '@/lib/theme';
import { FavoriteButton } from '@/ui/chat';
import { GOAL_STATUS_LABEL, GoalForm, GoalStatusPill, KeyResultForm, pct, type Goal, type GoalStatus, type KeyResult } from '@/ui/goals';
import { Icon } from '@/ui/Icon';
import { Button, Card, confirm, ErrorState, H1, HealthPill, IconButton, Input, LinkText, ListRow, Loading, Muted, Pill, ProgressBar, Row, Screen, Section, Segmented, T, useAction } from '@/ui/kit';

export default function GoalDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { c } = useTheme();
  const act = useAction();
  const { data: goal, error, reload, setData, refresh, refreshing } = useApi<Goal>(`/goals/${id}`);
  const { data: all } = useApi<Goal[]>('/goals');
  const { data: projects } = useApi<Project[]>('/projects');
  const [editing, setEditing] = useState(false);
  const [addingKr, setAddingKr] = useState(false);
  if (error && !goal) return <ErrorState error={error} retry={reload} />;
  if (!goal) return <Loading />;
  const parent = all?.find((g) => g.id === goal.parent_id);
  const subGoals = (all ?? []).filter((g) => g.parent_id === goal.id);
  const update = async (patch: Record<string, unknown>) => {
    const saved = await act(() => api.patch<Goal>(`/goals/${goal.id}`, patch));
    if (saved) setData(saved);
  };
  return (
    <>
      <Stack.Screen
        options={{
          title: 'Goal',
          headerRight: () => (
            <Row gap={0}>
              <FavoriteButton kind="goal" id={goal.id} />
              {goal.can_edit && <IconButton name="edit" label="Edit goal" onPress={() => setEditing(true)} />}
            </Row>
          ),
        }}
      />
      <Screen refreshing={refreshing} onRefresh={refresh}>
        {parent && (
          <LinkText size={13} onPress={() => router.push(`/goals/${parent.id}`)}>
            ↑ {parent.title}
          </LinkText>
        )}
        <H1>{goal.title}</H1>
        <Row wrap gap={10}>
          <GoalStatusPill status={goal.status} />
          <Muted size={13}>
            Owner: <T size={13} weight="bold">{goal.owner?.name}</T>
          </Muted>
          {goal.due_date && <Muted size={13}>Due {dateLabel(goal.due_date)}</Muted>}
          {goal.archived_at && <Pill label="Archived" />}
        </Row>
        <Card style={{ gap: 12 }}>
          <Row gap={12}>
            <T size={30} weight="displayHeavy">
              {pct(goal.progress)}
            </T>
            <View style={{ flex: 1 }}>
              <ProgressBar value={goal.progress * 100} height={10} />
            </View>
          </Row>
          {goal.can_edit && (
            <Segmented value={goal.status} onChange={(s) => update({ status: s })} options={(['on_track', 'at_risk', 'off_track', 'done'] as GoalStatus[]).map((s) => ({ id: s, label: GOAL_STATUS_LABEL[s] }))} />
          )}
          {!!goal.description && <T>{goal.description}</T>}
        </Card>
        <Section title="Key results" action={goal.can_edit ? <LinkText onPress={() => setAddingKr(true)}>Add</LinkText> : undefined}>
          {!goal.key_results.length && <Muted>No key results yet. {goal.projects.length ? 'Progress follows the linked projects’ tasks.' : ''}</Muted>}
          {goal.key_results.map((kr) => (
            <KeyResultRow key={kr.id} kr={kr} canEdit={goal.can_edit} onChanged={reload} />
          ))}
        </Section>
        <Section title="Supporting projects">
          {!goal.projects.length && <Muted>No linked projects.</Muted>}
          {goal.projects.map((p) => (
            <ListRow key={p.id} left={<View style={{ width: 10, height: 10, borderRadius: 3, backgroundColor: swatch(p.color) }} />} title={p.name} right={<HealthPill health={p.health} />} onPress={() => router.push(`/projects/${p.id}`)} />
          ))}
        </Section>
        {subGoals.length > 0 && (
          <Section title="Sub-goals">
            {subGoals.map((g) => (
              <ListRow
                key={g.id}
                left={<Icon name="target" size={16} color={c.accentInk} />}
                title={g.title}
                subtitle={pct(g.progress)}
                right={<GoalStatusPill status={g.status} />}
                onPress={() => router.push(`/goals/${g.id}`)}
              />
            ))}
          </Section>
        )}
        {goal.can_edit && (
          <Row>
            <Button title={goal.archived_at ? 'Restore' : 'Archive'} onPress={() => update({ archived: !goal.archived_at })} />
            <Button
              variant="danger"
              icon="trash"
              title="Delete"
              onPress={async () => {
                if (!(await confirm('Delete this goal and its key results?', undefined, 'Delete'))) return;
                if (await act(() => api.del(`/goals/${goal.id}`), 'Goal deleted')) router.back();
              }}
            />
          </Row>
        )}
      </Screen>
      {editing && (
        <GoalForm
          goal={goal}
          goals={all ?? []}
          onClose={() => setEditing(false)}
          onSaved={(g) => {
            setData(g);
            setEditing(false);
          }}
        />
      )}
      {addingKr && (
        <KeyResultForm
          goalId={goal.id}
          projects={projects ?? []}
          onClose={() => setAddingKr(false)}
          onSaved={(g) => {
            setData(g);
            setAddingKr(false);
          }}
        />
      )}
    </>
  );
}

function KeyResultRow({ kr, canEdit, onChanged }: { kr: KeyResult; canEdit: boolean; onChanged: () => void }) {
  const { c } = useTheme();
  const act = useAction();
  const [value, setValue] = useState(String(kr.current_value));
  useEffect(() => setValue(String(kr.current_value)), [kr.current_value]);
  const fmt = (n: number) => `${Number(n).toLocaleString()}${kr.unit ? ` ${kr.unit}` : ''}`;
  return (
    <View style={{ gap: 6, paddingVertical: 10, borderTopWidth: 1, borderColor: c.line2 }}>
      <Row style={{ alignItems: 'flex-start' }}>
        <T weight="bold" style={{ flex: 1 }}>
          {kr.title}
        </T>
        <T weight="bold">{pct(kr.progress)}</T>
        {canEdit && (
          <IconButton
            name="x"
            size={14}
            label={`Delete ${kr.title}`}
            onPress={async () => {
              if (!(await confirm('Delete this key result?', undefined, 'Delete'))) return;
              await act(() => api.del(`/key-results/${kr.id}`));
              onChanged();
            }}
          />
        )}
      </Row>
      <Muted size={12}>
        {kr.kind === 'tasks' ? `${kr.current_value} of ${kr.target_value} tasks done${kr.project ? ` in ${kr.project.name}` : ''}` : `${fmt(kr.current_value)} of ${fmt(kr.target_value)} (from ${fmt(kr.start_value)})`}
      </Muted>
      <ProgressBar value={kr.progress * 100} />
      {kr.kind === 'number' && (
        <Row>
          <Input
            value={value}
            onChangeText={setValue}
            keyboardType="decimal-pad"
            accessibilityLabel={`Current value of ${kr.title}`}
            style={{ flex: 1 }}
            onBlur={async () => {
              const v = Number(value);
              if (value === '' || Number.isNaN(v) || v === kr.current_value) return;
              await act(() => api.patch(`/key-results/${kr.id}`, { currentValue: v }), 'Progress updated');
              onChanged();
            }}
          />
          <Muted size={12}>current value</Muted>
        </Row>
      )}
    </View>
  );
}
