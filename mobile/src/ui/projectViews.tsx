import { useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { api, type CustomField, type Task, type TaskStatus } from '../lib/api';
import { dateLabel, dueLabel, duration, localToday, STATUS_LABEL } from '../lib/format';
import { useSession } from '../lib/session';
import { useTheme } from '../lib/theme';
import { Icon } from './Icon';
import { Avatar, Card, Dot, ListRow, Muted, Pill, Row, Select, Sheet, StatusPill, T, useAction } from './kit';
import { DateField } from './pickers';
import { STATUS_COLOR } from './planning';
import { FieldInput, FieldValue, LabelChips } from './work';

export const STATUSES: TaskStatus[] = ['todo', 'in_progress', 'blocked', 'review', 'done'];
const STATUS_OPTIONS = STATUSES.map((s) => ({ id: s, label: STATUS_LABEL[s] }));

/** Kanban columns side by side; move a card with its status menu. */
export function TaskBoard({ tasks, canEdit, onOpen, onMove, onAdd }: { tasks: Task[]; canEdit: boolean; onOpen: (id: string) => void; onMove: (id: string, s: TaskStatus) => void; onAdd: (s: TaskStatus) => void }) {
  const { c } = useTheme();
  const colors = STATUS_COLOR(c);
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 10, paddingRight: 16 }} style={{ marginHorizontal: -16 }} contentInset={{ left: 16 }}>
      <View style={{ width: 6 }} />
      {STATUSES.map((status) => {
        const group = tasks.filter((t) => t.status === status);
        return (
          <View key={status} style={{ width: 272, gap: 8, padding: 10, borderRadius: 14, backgroundColor: c.surface2, borderWidth: 1, borderColor: c.line }} accessibilityLabel={STATUS_LABEL[status]}>
            <Row gap={6}>
              <Dot color={colors[status]} />
              <T weight="bold">{STATUS_LABEL[status]}</T>
              <Muted size={12}>{group.length}</Muted>
            </Row>
            {group.map((t) => (
              <Pressable key={t.id} onPress={() => onOpen(t.id)} accessibilityRole="button" style={({ pressed }) => ({ gap: 6, padding: 10, borderRadius: 11, backgroundColor: pressed ? c.hover : c.surface, borderWidth: 1, borderColor: c.line })}>
                <T size={14} weight="semibold">
                  {t.title}
                </T>
                {t.status === 'blocked' && !!t.blocked_reason && (
                  <T size={12} tone="amber" numberOfLines={2}>
                    {t.blocked_reason}
                  </T>
                )}
                <Row wrap gap={4}>
                  <LabelChips labels={t.labels} />
                </Row>
                <Row gap={6}>
                  {(t.priority === 'urgent' || t.priority === 'high') && <Pill label={t.priority} tone={t.priority === 'urgent' ? 'red' : 'amber'} />}
                  {t.due_date && (
                    <T size={12} weight="bold" style={{ color: t.overdue ? c.red : c.muted }}>
                      {dueLabel(t.due_date)}
                    </T>
                  )}
                  {t.checklist.total > 0 && (
                    <Muted size={12}>
                      ✓ {t.checklist.done}/{t.checklist.total}
                    </Muted>
                  )}
                  <View style={{ flex: 1 }} />
                  <Avatar user={t.owner} size="xs" />
                </Row>
                {canEdit && <Select title={`Move ${t.title}`} value={t.status} onChange={(s) => onMove(t.id, s)} options={STATUS_OPTIONS} />}
              </Pressable>
            ))}
            {canEdit && (
              <Pressable onPress={() => onAdd(status)} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, padding: 6 }} accessibilityRole="button">
                <Icon name="plus" size={14} color={c.accentInk} />
                <T size={13} weight="semibold" tone="accent">
                  Add
                </T>
              </Pressable>
            )}
          </View>
        );
      })}
    </ScrollView>
  );
}

type SortKey = 'title' | 'status' | 'owner' | 'due_date' | 'priority' | `f:${string}`;
const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };

/** Spreadsheet-style view: scroll sideways for every column, tap a row to edit its values. */
export function TaskTable({ tasks, fields, canEdit, onOpen, onChanged }: { tasks: Task[]; fields: CustomField[]; canEdit: boolean; onOpen: (id: string) => void; onChanged: (task: Task) => void }) {
  const { c } = useTheme();
  const { people } = useSession();
  const act = useAction();
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'status', dir: 1 });
  const [editing, setEditing] = useState<Task | null>(null);
  const valueOf = (t: Task, key: SortKey): string | number => {
    if (key.startsWith('f:')) {
      const v = t.fields?.[key.slice(2)];
      return v === undefined || v === null ? '' : typeof v === 'number' ? v : String(v);
    }
    if (key === 'status') return STATUSES.indexOf(t.status);
    if (key === 'owner') return t.owner?.name ?? '~';
    if (key === 'priority') return PRIORITY_RANK[t.priority] ?? 9;
    if (key === 'due_date') return t.due_date ?? '9999';
    return t.title.toLowerCase();
  };
  const rows = [...tasks].sort((a, b) => {
    const x = valueOf(a, sort.key);
    const y = valueOf(b, sort.key);
    return (x < y ? -1 : x > y ? 1 : 0) * sort.dir;
  });
  const patch = async (task: Task, body: Record<string, unknown>) => {
    const updated = await act(() => api.patch<Task>(`/tasks/${task.id}`, body));
    if (updated) {
      onChanged({ ...task, ...updated });
      setEditing((e) => (e && e.id === task.id ? { ...e, ...updated } : e));
    }
  };
  const columns: { key: SortKey; label: string; width: number }[] = [
    { key: 'title', label: 'Task', width: 200 },
    { key: 'status', label: 'Status', width: 110 },
    { key: 'owner', label: 'Owner', width: 120 },
    { key: 'due_date', label: 'Due', width: 90 },
    { key: 'priority', label: 'Priority', width: 80 },
    ...fields.map((f) => ({ key: `f:${f.id}` as SortKey, label: f.name, width: 130 })),
  ];
  const cell = { paddingHorizontal: 10, paddingVertical: 10, justifyContent: 'center' as const };
  return (
    <Card padded={false} style={{ overflow: 'hidden' }}>
      <ScrollView horizontal>
        <View>
          <View style={{ flexDirection: 'row', borderBottomWidth: 1, borderColor: c.line, backgroundColor: c.surface2 }}>
            {columns.map((col) => (
              <Pressable key={col.key} onPress={() => setSort((s) => ({ key: col.key, dir: s.key === col.key ? ((-s.dir) as 1 | -1) : 1 }))} style={[cell, { width: col.width, flexDirection: 'row', alignItems: 'center', gap: 4 }]} accessibilityRole="button" accessibilityLabel={`Sort by ${col.label}`}>
                <T size={12} weight="bold" tone="muted" numberOfLines={1}>
                  {col.label}
                </T>
                {sort.key === col.key && <Icon name={sort.dir === 1 ? 'chevronDown' : 'chevronRight'} size={12} color={c.muted} />}
              </Pressable>
            ))}
            <View style={[cell, { width: 70 }]}>
              <T size={12} weight="bold" tone="muted">
                Time
              </T>
            </View>
          </View>
          {rows.map((t) => (
            <Pressable key={t.id} onPress={() => (canEdit ? setEditing(t) : onOpen(t.id))} style={({ pressed }) => ({ flexDirection: 'row', borderBottomWidth: 1, borderColor: c.line2, backgroundColor: pressed ? c.hover : 'transparent', opacity: t.status === 'done' ? 0.6 : 1 })}>
              <View style={[cell, { width: 200 }]}>
                <T size={14} weight="semibold" numberOfLines={2} tone="accent" onPress={() => onOpen(t.id)}>
                  {t.title}
                </T>
              </View>
              <View style={[cell, { width: 110 }]}>
                <StatusPill status={t.status} />
              </View>
              <View style={[cell, { width: 120 }]}>
                <T size={13} numberOfLines={1}>
                  {t.owner?.name ?? 'Unassigned'}
                </T>
              </View>
              <View style={[cell, { width: 90 }]}>
                <T size={13} style={{ color: t.overdue ? c.red : c.ink }}>
                  {t.due_date ? dateLabel(t.due_date) : '—'}
                </T>
              </View>
              <View style={[cell, { width: 80 }]}>
                <T size={13}>{t.priority}</T>
              </View>
              {fields.map((f) => (
                <View key={f.id} style={[cell, { width: 130 }]}>
                  <FieldValue field={f} value={t.fields?.[f.id]} />
                </View>
              ))}
              <View style={[cell, { width: 70 }]}>
                <Muted size={13}>{t.time_minutes ? duration(t.time_minutes) : '—'}</Muted>
              </View>
            </Pressable>
          ))}
        </View>
      </ScrollView>
      {!rows.length && <Muted style={{ padding: 14 }}>No tasks match.</Muted>}
      <Sheet open={!!editing} onClose={() => setEditing(null)} title={editing?.title} full>
        {editing && (
          <>
            <ListRow title="Open task" chevron onPress={() => (setEditing(null), onOpen(editing.id))} />
            <Muted>Status</Muted>
            <Select title="Status" value={editing.status} onChange={(v) => patch(editing, { status: v })} options={STATUS_OPTIONS} />
            <Muted>Owner</Muted>
            <Select title="Owner" value={editing.owner?.id ?? ''} onChange={(v) => patch(editing, { ownerId: v || null })} options={[{ id: '', label: 'Unassigned' }, ...people.map((p) => ({ id: p.id, label: p.name }))]} />
            <Muted>Due</Muted>
            <DateField value={editing.due_date} onChange={(v) => patch(editing, { dueDate: v })} label="Due date" />
            <Muted>Priority</Muted>
            <Select
              title="Priority"
              value={editing.priority}
              onChange={(v) => patch(editing, { priority: v })}
              options={['low', 'medium', 'high', 'urgent'].map((p) => ({ id: p, label: p[0].toUpperCase() + p.slice(1) }))}
            />
            {fields.map((f) => (
              <View key={f.id} style={{ gap: 6 }}>
                <Muted>{f.name}</Muted>
                <FieldInput
                  field={f}
                  value={editing.fields?.[f.id]}
                  onSave={async (value) => {
                    const res = await act(() => api.put<{ fields: Record<string, unknown> }>(`/tasks/${editing.id}/fields/${f.id}`, { value }));
                    if (res) {
                      const next = { ...editing, fields: res.fields };
                      onChanged(next);
                      setEditing(next);
                    }
                  }}
                />
              </View>
            ))}
          </>
        )}
      </Sheet>
    </Card>
  );
}

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Month grid of tasks by due date. Tap a day to see its tasks; long-press a task to move it to another day. */
export function TaskCalendar({ tasks, canEdit, onOpen, onChanged }: { tasks: Task[]; canEdit: boolean; onOpen: (id: string) => void; onChanged: (task: Task) => void }) {
  const { c } = useTheme();
  const act = useAction();
  const colors = STATUS_COLOR(c);
  const [month, setMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const [day, setDay] = useState<string>(localToday());
  const [moving, setMoving] = useState<Task | null>(null);
  const first = new Date(month);
  first.setDate(1 - ((month.getDay() + 6) % 7));
  const days = Array.from({ length: 42 }, (_, i) => new Date(first.getFullYear(), first.getMonth(), first.getDate() + i));
  const today = localToday();
  const byDay = new Map<string, Task[]>();
  for (const t of tasks) if (t.due_date) byDay.set(t.due_date, [...(byDay.get(t.due_date) ?? []), t]);
  const undated = tasks.filter((t) => !t.due_date && t.status !== 'done');
  const reschedule = async (task: Task, date: string | null) => {
    if (!date || task.due_date === date) return;
    const updated = await act(() => api.patch<Task>(`/tasks/${task.id}`, { dueDate: date, ...(task.start_date && task.start_date > date ? { startDate: null } : {}) }));
    if (updated) onChanged({ ...task, ...updated });
  };
  const list = (items: Task[]) =>
    items.map((t) => (
      <ListRow
        key={t.id}
        left={<Dot color={colors[t.status]} />}
        title={t.title}
        subtitle={`${STATUS_LABEL[t.status]}${t.owner ? ` · ${t.owner.name}` : ''}`}
        onPress={() => onOpen(t.id)}
        onLongPress={canEdit ? () => setMoving(t) : undefined}
        right={t.overdue ? <Pill label="Overdue" tone="red" /> : undefined}
      />
    ));
  return (
    <View style={{ gap: 12 }}>
      <Card>
        <Row style={{ justifyContent: 'space-between', marginBottom: 8 }}>
          <Pressable onPress={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))} accessibilityLabel="Previous month" hitSlop={10}>
            <Icon name="chevronLeft" size={20} color={c.ink2} />
          </Pressable>
          <Pressable onPress={() => setMonth(new Date(new Date().getFullYear(), new Date().getMonth(), 1))} accessibilityLabel="Go to this month">
            <T weight="bold">{month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</T>
          </Pressable>
          <Pressable onPress={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))} accessibilityLabel="Next month" hitSlop={10}>
            <Icon name="chevronRight" size={20} color={c.ink2} />
          </Pressable>
        </Row>
        <View style={{ flexDirection: 'row' }}>
          {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => (
            <T key={i} size={11} weight="bold" tone="muted" style={{ flex: 1, textAlign: 'center' }}>
              {d}
            </T>
          ))}
        </View>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
          {days.map((d) => {
            const key = iso(d);
            const items = byDay.get(key) ?? [];
            const on = key === day;
            return (
              <Pressable
                key={key}
                onPress={() => setDay(key)}
                accessibilityRole="button"
                accessibilityLabel={`${d.toDateString()}, ${items.length} tasks`}
                style={{ width: `${100 / 7}%`, height: 50, padding: 2, opacity: d.getMonth() !== month.getMonth() ? 0.4 : 1 }}
              >
                <View style={{ flex: 1, borderRadius: 9, alignItems: 'center', paddingTop: 4, gap: 3, backgroundColor: on ? c.accent : key === today ? c.accentSoft : 'transparent' }}>
                  <T size={13} weight={on || key === today ? 'bold' : 'medium'} style={{ color: on ? '#fff' : c.ink }}>
                    {d.getDate()}
                  </T>
                  <Row gap={2}>
                    {items.slice(0, 3).map((t) => (
                      <Dot key={t.id} size={5} color={on ? '#fff' : t.overdue ? c.red : colors[t.status]} />
                    ))}
                  </Row>
                </View>
              </Pressable>
            );
          })}
        </View>
      </Card>
      <Card padded={false} style={{ paddingHorizontal: 14, paddingTop: 10 }}>
        <T weight="display" size={15}>
          {dateLabel(day)}
        </T>
        {(byDay.get(day) ?? []).length ? list(byDay.get(day)!) : <Muted style={{ paddingVertical: 10 }}>Nothing due this day.</Muted>}
      </Card>
      {undated.length > 0 && (
        <Card padded={false} style={{ paddingHorizontal: 14, paddingTop: 10 }}>
          <T weight="display" size={15}>
            {undated.length} open task{undated.length === 1 ? '' : 's'} without a due date
          </T>
          {canEdit && <Muted size={12}>Long-press one to give it a date.</Muted>}
          {list(undated)}
        </Card>
      )}
      <Sheet open={!!moving} onClose={() => setMoving(null)} title={moving?.title} eyebrow="Move to another day">
        {moving && (
          <DateField
            value={moving.due_date}
            clearable={false}
            label="Due date"
            onChange={async (v) => {
              await reschedule(moving, v);
              setMoving(null);
            }}
          />
        )}
      </Sheet>
    </View>
  );
}
