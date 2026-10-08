import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { api, type Task } from '@/lib/api';
import { localToday } from '@/lib/format';
import { useApi, useRealtime, useReloadOnFocus } from '@/lib/hooks';
import { useShell } from '@/lib/shell';
import { useTheme } from '@/lib/theme';
import { Icon } from '@/ui/Icon';
import { Badge, Button, Card, Empty, ErrorState, Input, Loading, Muted, Row, Screen, T, useAction } from '@/ui/kit';
import { DateField } from '@/ui/pickers';
import { TaskList } from '@/ui/work';

interface MyWorkData {
  overdue: Task[];
  today: Task[];
  upcoming: Task[];
  later: Task[];
  blocked: Task[];
  review: Task[];
  done_recently: Task[];
}

const SECTIONS: { id: keyof MyWorkData; title: string; hint: string; tone?: 'danger' | 'warn' }[] = [
  { id: 'overdue', title: 'Overdue', hint: 'Past their due date', tone: 'danger' },
  { id: 'today', title: 'Today', hint: 'Due today or urgent' },
  { id: 'blocked', title: 'Blocked', hint: 'Waiting on something', tone: 'warn' },
  { id: 'review', title: 'Assigned for review', hint: 'Waiting on your review' },
  { id: 'upcoming', title: 'Next 7 days', hint: 'Coming up soon' },
  { id: 'later', title: 'Later', hint: 'No date or further out' },
  { id: 'done_recently', title: 'Done recently', hint: 'Completed in the last day' },
];

export default function MyWork() {
  const { c } = useTheme();
  const { openTask, reloadCounts } = useShell();
  const act = useAction();
  const { data, error, reload, refresh, refreshing } = useApi<MyWorkData>('/my-work');
  const [title, setTitle] = useState('');
  const [due, setDue] = useState<string | null>(localToday());
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({ done_recently: true });
  useRealtime((e) => (e.type === 'task.updated' || e.type === 'reconnected') && reload());
  useReloadOnFocus(reload);

  const add = async () => {
    if (!title.trim()) return;
    await act(() => api.post('/tasks', { title, dueDate: due || null }), 'Task added');
    setTitle('');
    reload();
    reloadCounts();
  };
  const toggle = async (t: Task, done: boolean) => {
    await act(() => api.patch(`/tasks/${t.id}`, { status: done ? 'done' : 'todo' }), done ? 'Nice work — task completed' : 'Task reopened');
    reload();
    reloadCounts();
  };

  if (error && !data) return <ErrorState error={error} retry={reload} />;
  if (!data) return <Loading />;
  const total = SECTIONS.filter((s) => s.id !== 'done_recently').reduce((n, s) => n + data[s.id].length, 0);

  return (
    <Screen refreshing={refreshing} onRefresh={refresh}>
      <Muted size={14}>Everything you own or need to review, across every project.</Muted>
      <Card style={{ gap: 10 }}>
        <Row>
          <Icon name="plus" size={18} color={c.accentInk} />
          <Input value={title} onChangeText={setTitle} placeholder="Add a personal task" accessibilityLabel="New task title" returnKeyType="done" onSubmitEditing={add} style={{ flex: 1 }} />
        </Row>
        <Row>
          <View style={{ flex: 1 }}>
            <DateField value={due} onChange={setDue} label="Due date" />
          </View>
          <Button variant="primary" title="Add" disabled={!title.trim()} onPress={add} />
        </Row>
      </Card>
      {total === 0 && (
        <Empty icon="check" title="You are all clear">
          Nothing assigned to you right now.
        </Empty>
      )}
      {SECTIONS.map((s) =>
        data[s.id].length ? (
          <Card key={s.id} style={s.tone === 'danger' ? { borderColor: c.redLine } : s.tone === 'warn' ? { borderColor: c.amberLine } : undefined}>
            <Pressable onPress={() => setCollapsed({ ...collapsed, [s.id]: !collapsed[s.id] })} accessibilityRole="button" accessibilityState={{ expanded: !collapsed[s.id] }} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Icon name={collapsed[s.id] ? 'chevronRight' : 'chevronDown'} size={16} color={c.muted} />
              <T size={17} weight="display" style={{ color: s.tone === 'danger' ? c.red : c.ink }}>
                {s.title}
              </T>
              <Badge count={data[s.id].length} tone={s.tone === 'danger' ? 'red' : 'muted'} />
              <Muted size={12} style={{ flex: 1, textAlign: 'right' }} numberOfLines={1}>
                {s.hint}
              </Muted>
            </Pressable>
            {!collapsed[s.id] && <TaskList tasks={data[s.id]} onOpen={(t) => openTask(t.id)} onToggle={toggle} />}
          </Card>
        ) : null,
      )}
    </Screen>
  );
}
