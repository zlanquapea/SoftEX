import { useEffect, useState, type ReactNode } from 'react';
import { Pressable, View } from 'react-native';
import { api, LABEL_COLORS, type CustomField, type FieldType, type Label, type LabelColor, type Task, type TimeEntry } from '../lib/api';
import { dateTime, dueLabel, duration, localToday, plainMentions, timeAgo } from '../lib/format';
import { useApi } from '../lib/hooks';
import { useSession } from '../lib/session';
import { swatch, useTheme } from '../lib/theme';
import { Icon } from './Icon';
import { openLink } from './Markdown';
import { Avatar, Button, Checkbox, confirm, Field, Input, LinkText, ListRow, Muted, Pill, ProgressBar, Row, SearchBox, Select, Sheet, StatusPill, T, useAction } from './kit';
import { DateField, DateTimeField, PeopleField } from './pickers';
import { UpgradeNotice, usePlan } from './plan';

// ---------- Task rows ----------

/** Compact task row used in lists across the app. */
export function TaskRow({ task, onOpen, onToggle, showProject = true }: { task: Task; onOpen: () => void; onToggle?: (done: boolean) => void; showProject?: boolean }) {
  const { c } = useTheme();
  const done = task.status === 'done';
  const due = task.due_date ? dueLabel(task.due_date) : '';
  return (
    <Pressable onPress={onOpen} style={({ pressed }) => ({ flexDirection: 'row', gap: 12, paddingVertical: 11, alignItems: 'flex-start', backgroundColor: pressed ? c.hover : 'transparent' })} accessibilityRole="button" accessibilityLabel={task.title}>
      <View style={{ paddingTop: 1 }}>
        <Checkbox checked={done} disabled={!onToggle} onChange={(v) => onToggle?.(v)} />
      </View>
      <View style={{ flex: 1, gap: 4, minWidth: 0 }}>
        <T weight="semibold" numberOfLines={2} style={done ? { textDecorationLine: 'line-through', color: c.muted } : undefined}>
          {task.title}
        </T>
        <Row gap={6} wrap>
          {showProject &&
            (task.project ? (
              <Row gap={4}>
                <View style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: swatch(task.project.color) }} />
                <Muted size={12} numberOfLines={1}>
                  {task.project.name}
                </Muted>
              </Row>
            ) : (
              <Muted size={12}>Personal</Muted>
            ))}
          {task.status !== 'todo' && task.status !== 'done' && <StatusPill status={task.status} />}
          <LabelChips labels={task.labels} />
          {(task.priority === 'urgent' || task.priority === 'high') && <Pill label={task.priority} tone={task.priority === 'urgent' ? 'red' : 'amber'} />}
          {task.checklist.total > 0 && <Meta icon="check" text={`${task.checklist.done}/${task.checklist.total}`} />}
          {task.comment_count > 0 && <Meta icon="chat" text={String(task.comment_count)} />}
        </Row>
        {task.status === 'blocked' && !!task.blocked_reason && (
          <Muted size={12} numberOfLines={2}>
            — {plainMentions(task.blocked_reason)}
          </Muted>
        )}
      </View>
      <View style={{ alignItems: 'flex-end', gap: 4 }}>
        {!!due && (
          <T size={12} weight="bold" style={{ color: task.overdue ? c.red : due === 'Today' ? c.accentInk : c.muted }}>
            {due}
          </T>
        )}
        <Avatar user={task.owner} size="xs" />
      </View>
    </Pressable>
  );
}

function Meta({ icon, text }: { icon: string; text: string }) {
  const { c } = useTheme();
  return (
    <Row gap={3}>
      <Icon name={icon} size={12} color={c.muted} />
      <Muted size={12}>{text}</Muted>
    </Row>
  );
}

/** A thin list of tasks with dividers. */
export function TaskList({ tasks, onToggle, onOpen, showProject, empty }: { tasks: Task[]; onToggle?: (t: Task, done: boolean) => void; onOpen: (t: Task) => void; showProject?: boolean; empty?: ReactNode }) {
  const { c } = useTheme();
  if (!tasks.length) return <>{empty ?? null}</>;
  return (
    <View>
      {tasks.map((t, i) => (
        <View key={t.id} style={i ? { borderTopWidth: 1, borderColor: c.line2 } : undefined}>
          <TaskRow task={t} showProject={showProject} onOpen={() => onOpen(t)} onToggle={onToggle ? (d) => onToggle(t, d) : undefined} />
        </View>
      ))}
    </View>
  );
}

// ---------- Labels ----------

export function LabelChip({ label, onRemove }: { label: Pick<Label, 'name' | 'color'>; onRemove?: () => void }) {
  const color = swatch(label.color);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 7, paddingVertical: 1, borderRadius: 6, backgroundColor: `${color}22`, borderWidth: 1, borderColor: `${color}55` }}>
      <T size={11} weight="bold" style={{ color, lineHeight: 16 }}>
        {label.name}
      </T>
      {onRemove && (
        <Pressable onPress={onRemove} hitSlop={8} accessibilityLabel={`Remove label ${label.name}`}>
          <Icon name="x" size={11} color={color} />
        </Pressable>
      )}
    </View>
  );
}

export function LabelChips({ labels }: { labels?: Label[] }) {
  if (!labels?.length) return null;
  return (
    <>
      {labels.map((l) => (
        <LabelChip key={l.id} label={l} />
      ))}
    </>
  );
}

export function ColorDots({ value, onChange }: { value: LabelColor; onChange: (c: LabelColor) => void }) {
  const { c } = useTheme();
  return (
    <Row wrap gap={8}>
      {LABEL_COLORS.map((name) => (
        <Pressable
          key={name}
          onPress={() => onChange(name)}
          accessibilityRole="radio"
          accessibilityState={{ checked: value === name }}
          accessibilityLabel={name}
          style={{ width: 26, height: 26, borderRadius: 13, backgroundColor: swatch(name), borderWidth: 3, borderColor: value === name ? c.ink : 'transparent' }}
        />
      ))}
    </Row>
  );
}

/** Pick labels for a task, creating new ones inline. */
export function LabelPicker({ taskId, value, disabled, onChange }: { taskId: string; value: Label[]; disabled?: boolean; onChange: (labels: Label[]) => void }) {
  const act = useAction();
  const { data: all, reload } = useApi<Label[]>('/labels');
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [color, setColor] = useState<LabelColor>('blue');
  const save = async (ids: string[]) => {
    const labels = await act(() => api.put<Label[]>(`/tasks/${taskId}/labels`, { labelIds: ids }));
    if (labels) onChange(labels);
  };
  const ids = value.map((l) => l.id);
  const matches = (all ?? []).filter((l) => !q || l.name.toLowerCase().includes(q.toLowerCase()));
  const exact = (all ?? []).some((l) => l.name.toLowerCase() === q.trim().toLowerCase());
  return (
    <Row wrap gap={6}>
      {value.map((l) => (
        <LabelChip key={l.id} label={l} onRemove={disabled ? undefined : () => save(ids.filter((id) => id !== l.id))} />
      ))}
      {!value.length && disabled && <Muted>None</Muted>}
      {!disabled && <LinkText onPress={() => setOpen(true)}>{value.length ? 'Edit' : 'Add label'}</LinkText>}
      <Sheet open={open} onClose={() => setOpen(false)} title="Labels" footer={<Button title="Done" variant="primary" full onPress={() => setOpen(false)} />}>
        <SearchBox value={q} onChangeText={setQ} placeholder="Find or create a label" />
        <View style={{ gap: 10 }}>
          {matches.map((l) => (
            <Checkbox key={l.id} checked={ids.includes(l.id)} onChange={(v) => save(v ? [...ids, l.id] : ids.filter((id) => id !== l.id))} label={<LabelChip label={l} />} />
          ))}
        </View>
        {!!q.trim() && !exact && (
          <View style={{ gap: 10 }}>
            <ColorDots value={color} onChange={setColor} />
            <Button
              title={`Create “${q.trim()}”`}
              onPress={async () => {
                const created = await act(() => api.post<Label>('/labels', { name: q.trim(), color }));
                if (!created) return;
                setQ('');
                await reload();
                await save([...ids, created.id]);
              }}
            />
          </View>
        )}
      </Sheet>
    </Row>
  );
}

// ---------- Custom fields ----------

export const FIELD_TYPE_LABEL: Record<FieldType, string> = {
  text: 'Text',
  number: 'Number',
  date: 'Date',
  select: 'Dropdown',
  person: 'Person',
  checkbox: 'Checkbox',
  url: 'Link',
};

export function FieldValue({ field, value }: { field: CustomField; value: unknown }) {
  const { c } = useTheme();
  const { people } = useSession();
  if (value === undefined || value === null || value === '') return <Muted>—</Muted>;
  switch (field.type) {
    case 'checkbox':
      return value ? <Icon name="check" size={14} color={c.green} /> : <Muted>—</Muted>;
    case 'select': {
      const opt = field.options.find((o) => o.label === value);
      return <LabelChip label={{ name: String(value), color: opt?.color ?? 'blue' }} />;
    }
    case 'person':
      return <T size={14}>{people.find((p) => p.id === value)?.name ?? 'Former member'}</T>;
    case 'url':
      return (
        <LinkText size={14} onPress={() => openLink(String(value))}>
          {String(value).replace(/^https?:\/\//, '').slice(0, 40)}
        </LinkText>
      );
    case 'number':
      return <T size={14}>{Number(value).toLocaleString()}</T>;
    default:
      return <T size={14}>{String(value)}</T>;
  }
}

export function FieldInput({ field, value, disabled, onSave }: { field: CustomField; value: unknown; disabled?: boolean; onSave: (value: unknown) => void }) {
  const { people } = useSession();
  const [text, setText] = useState(value == null ? '' : String(value));
  useEffect(() => setText(value == null ? '' : String(value)), [value]);
  switch (field.type) {
    case 'checkbox':
      return <Checkbox checked={!!value} disabled={disabled} onChange={(v) => onSave(v)} />;
    case 'select':
      return (
        <Select
          title={field.name}
          disabled={disabled}
          value={(value as string) ?? ''}
          placeholder="—"
          onChange={(v) => onSave(v || null)}
          options={[{ id: '', label: '—' }, ...field.options.map((o) => ({ id: o.label, label: o.label }))]}
        />
      );
    case 'person':
      return <PeopleField multiple={false} title={field.name} allowNone="—" placeholder="—" value={value ? [String(value)] : []} onChange={(ids) => onSave(ids[0] ?? null)} people={people} />;
    case 'date':
      return <DateField value={(value as string) ?? null} onChange={(v) => onSave(v)} label={field.name} />;
    default:
      return (
        <Input
          value={text}
          editable={!disabled}
          onChangeText={setText}
          keyboardType={field.type === 'number' ? 'decimal-pad' : field.type === 'url' ? 'url' : 'default'}
          autoCapitalize={field.type === 'url' ? 'none' : 'sentences'}
          placeholder={field.type === 'url' ? 'https://' : ''}
          accessibilityLabel={field.name}
          returnKeyType="done"
          onBlur={() => {
            const v = text.trim();
            if (field.type === 'number') {
              const n = v === '' ? null : Number(v);
              if (n !== (value ?? null) && (n === null || !Number.isNaN(n))) onSave(n);
            } else if (v !== ((value as string) ?? '')) onSave(v || null);
          }}
        />
      );
  }
}

export function useProjectFields(projectId: string | null | undefined) {
  return useApi<CustomField[]>(projectId ? `/projects/${projectId}/fields` : null);
}

/** A labelled property row, like the web's <dt>/<dd> pairs. */
export function Prop({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={{ gap: 6 }}>
      <T size={12} weight="bold" tone="muted" style={{ textTransform: 'uppercase', letterSpacing: 0.6 }}>
        {label}
      </T>
      {children}
    </View>
  );
}

export function TaskFieldRows({ taskId, projectId, values, disabled, onChange }: { taskId: string; projectId?: string | null; values: Record<string, unknown>; disabled: boolean; onChange: (v: Record<string, unknown>) => void }) {
  const act = useAction();
  const { data: fields } = useProjectFields(projectId);
  if (!fields?.length) return null;
  return (
    <>
      {fields.map((f) => (
        <Prop key={f.id} label={f.name}>
          <FieldInput
            field={f}
            value={values[f.id]}
            disabled={disabled}
            onSave={async (value) => {
              const res = await act(() => api.put<{ fields: Record<string, unknown> }>(`/tasks/${taskId}/fields/${f.id}`, { value }));
              if (res) onChange(res.fields);
            }}
          />
        </Prop>
      ))}
    </>
  );
}

/** Project settings: add, rename, reorder and remove custom fields. */
export function FieldsManager({ projectId, open, onClose }: { projectId: string; open: boolean; onClose: () => void }) {
  const { c } = useTheme();
  const act = useAction();
  const plan = usePlan();
  const { data: fields, reload } = useProjectFields(open ? projectId : null);
  const [name, setName] = useState('');
  const [type, setType] = useState<FieldType>('text');
  const [options, setOptions] = useState('');
  return (
    <Sheet open={open} onClose={onClose} title="Custom fields" eyebrow="Project settings" full>
      {!plan.has('fields') ? (
        <UpgradeNotice feature="fields" />
      ) : (
        <>
          <Muted>Fields show on every task in this project and as columns in the table view.</Muted>
          {fields?.map((f, i) => (
            <View key={f.id} style={{ gap: 6, paddingVertical: 8, borderBottomWidth: 1, borderColor: c.line2 }}>
              <Row>
                <Input
                  defaultValue={f.name}
                  accessibilityLabel="Field name"
                  style={{ flex: 1 }}
                  onEndEditing={async (e) => {
                    const v = e.nativeEvent.text.trim();
                    if (v && v !== f.name) await act(() => api.patch(`/fields/${f.id}`, { name: v }));
                    reload();
                  }}
                />
                <Pill label={FIELD_TYPE_LABEL[f.type]} />
              </Row>
              {f.type === 'select' && <Muted size={12}>{f.options.map((o) => o.label).join(', ')}</Muted>}
              <Row>
                <Button
                  small
                  title="Move up"
                  icon="chevronLeft"
                  disabled={i === 0}
                  onPress={async () => {
                    const order = fields.map((x) => x.id);
                    [order[i - 1], order[i]] = [order[i], order[i - 1]];
                    await act(async () => {
                      for (const [position, id] of order.entries()) await api.patch(`/fields/${id}`, { position });
                    });
                    reload();
                  }}
                />
                <Button
                  small
                  title="Delete"
                  icon="trash"
                  variant="danger"
                  onPress={async () => {
                    if (!(await confirm(`Delete the “${f.name}” field?`, 'Its values on every task are removed too.', 'Delete'))) return;
                    await act(() => api.del(`/fields/${f.id}`));
                    reload();
                  }}
                />
              </Row>
            </View>
          ))}
          {fields && !fields.length && <Muted>No fields yet.</Muted>}
          <Field label="New field name">
            <Input value={name} onChangeText={setName} maxLength={60} />
          </Field>
          <Field label="Type">
            <Select title="Field type" value={type} onChange={setType} options={(Object.keys(FIELD_TYPE_LABEL) as FieldType[]).map((t) => ({ id: t, label: FIELD_TYPE_LABEL[t] }))} />
          </Field>
          {type === 'select' && (
            <Field label="Options" hint="Separate options with commas.">
              <Input value={options} onChangeText={setOptions} />
            </Field>
          )}
          <Button
            title="Add field"
            variant="primary"
            disabled={!name.trim()}
            onPress={async () => {
              const opts = options
                .split(',')
                .map((o) => o.trim())
                .filter(Boolean)
                .map((label, i) => ({ label, color: LABEL_COLORS[i % LABEL_COLORS.length] }));
              const ok = await act(() => api.post(`/projects/${projectId}/fields`, { name, type, options: opts }), 'Field added');
              if (!ok) return;
              setName('');
              setOptions('');
              reload();
            }}
          />
        </>
      )}
    </Sheet>
  );
}

// ---------- Time tracking ----------

export function useElapsed(startedAt: string | null | undefined) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!startedAt) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [startedAt]);
  if (!startedAt) return '';
  const s = Math.max(0, Math.floor((Date.now() - Date.parse(startedAt)) / 1000));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
}

/** Timer plus manual entries on a task. */
export function TimeTracker({ taskId, estimateHours, canLog }: { taskId: string; estimateHours: number | null; canLog: boolean }) {
  const { c } = useTheme();
  const act = useAction();
  const plan = usePlan();
  const { me } = useSession();
  const { data, reload } = useApi<{ entries: TimeEntry[]; total_minutes: number; running: TimeEntry | null }>(`/tasks/${taskId}/time`);
  const elapsed = useElapsed(data?.running?.started_at);
  const [adding, setAdding] = useState(false);
  const [hours, setHours] = useState('');
  const [date, setDate] = useState<string | null>(localToday());
  const [note, setNote] = useState('');
  if (!data) return null;
  const available = plan.has('fields');
  const pct = estimateHours ? Math.min(100, Math.round((data.total_minutes / (estimateHours * 60)) * 100)) : null;
  return (
    <View style={{ gap: 10 }}>
      <Row style={{ justifyContent: 'space-between' }}>
        <T weight="display" size={16}>
          Time{' '}
          {data.total_minutes > 0 && (
            <T size={13} tone="muted">
              {duration(data.total_minutes)} logged{estimateHours ? ` of ${estimateHours}h` : ''}
            </T>
          )}
        </T>
      </Row>
      {pct !== null && data.total_minutes > 0 && <ProgressBar value={pct} color={pct >= 100 ? c.red : c.accent} />}
      {!available && canLog && <UpgradeNotice feature="fields" />}
      {canLog && available && (
        <Row>
          {data.running ? (
            <Button
              small
              variant="danger"
              icon="square"
              title={`${elapsed} Stop`}
              onPress={async () => {
                await act(() => api.post('/time/stop'));
                reload();
              }}
            />
          ) : (
            <Button
              small
              icon="play"
              title="Start timer"
              onPress={async () => {
                await act(() => api.post(`/tasks/${taskId}/time/start`));
                reload();
              }}
            />
          )}
          <Button small variant="ghost" title="Log time" icon="plus" onPress={() => setAdding(true)} />
        </Row>
      )}
      {data.entries.slice(0, 8).map((e) => (
        <Row key={e.id} gap={8}>
          <T size={14} weight="bold">
            {e.running ? elapsed || 'Running' : duration(e.minutes)}
          </T>
          <T size={14} style={{ flex: 1 }} numberOfLines={1}>
            {e.user?.name}
            {e.note ? <T tone="muted"> — {e.note}</T> : null}
          </T>
          <Muted size={12}>{timeAgo(e.started_at)}</Muted>
          {(e.user?.id === me?.user.id || me?.role === 'admin' || me?.role === 'owner') && !e.running && (
            <Pressable
              hitSlop={8}
              accessibilityLabel="Remove time entry"
              onPress={async () => {
                await act(() => api.del(`/time/${e.id}`));
                reload();
              }}
            >
              <Icon name="x" size={14} color={c.muted} />
            </Pressable>
          )}
        </Row>
      ))}
      <Sheet
        open={adding}
        onClose={() => setAdding(false)}
        title="Log time"
        footer={
          <Button
            title="Save time"
            variant="primary"
            full
            disabled={!Number(hours)}
            onPress={async () => {
              const minutes = Math.round(Number(hours) * 60);
              if (!minutes) return;
              const ok = await act(() => api.post(`/tasks/${taskId}/time`, { minutes, date, note }), 'Time logged');
              if (!ok) return;
              setHours('');
              setNote('');
              setAdding(false);
              reload();
            }}
          />
        }
      >
        <Field label="Hours">
          <Input value={hours} onChangeText={setHours} keyboardType="decimal-pad" placeholder="e.g. 1.5" autoFocus />
        </Field>
        <Field label="Date">
          <DateField value={date} onChange={setDate} clearable={false} label="Date" />
        </Field>
        <Field label="Note (optional)">
          <Input value={note} onChangeText={setNote} maxLength={500} />
        </Field>
      </Sheet>
    </View>
  );
}

// ---------- Later & reminders ----------

/** Quick choices for "later": in 20 minutes, in an hour, this evening, tomorrow morning, next Monday. */
export function laterPresets(from = new Date()) {
  const at = (d: Date, h: number, m = 0) => {
    const x = new Date(d);
    x.setHours(h, m, 0, 0);
    return x;
  };
  const plus = (ms: number) => new Date(from.getTime() + ms);
  const tomorrow = new Date(from);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const monday = new Date(from);
  monday.setDate(monday.getDate() + ((8 - monday.getDay()) % 7 || 7));
  const list = [
    { label: 'In 20 minutes', date: plus(20 * 60_000) },
    { label: 'In 1 hour', date: plus(60 * 60_000) },
    { label: 'In 3 hours', date: plus(3 * 60 * 60_000) },
    { label: 'Tomorrow morning', date: at(tomorrow, 9) },
    { label: 'Next Monday', date: at(monday, 9) },
  ];
  const evening = at(from, 17);
  if (evening.getTime() - from.getTime() > 60 * 60_000) list.splice(3, 0, { label: 'This evening', date: evening });
  return list;
}

/** A sheet that asks "when?" with quick presets and a custom date/time. */
export function WhenSheet({
  open,
  onClose,
  title,
  eyebrow,
  confirmLabel,
  withNote,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  eyebrow?: string;
  confirmLabel: string;
  withNote?: boolean;
  onPick: (iso: string, note: string) => Promise<unknown>;
}) {
  const [custom, setCustom] = useState(() => new Date(Date.now() + 2 * 60 * 60_000).toISOString());
  const [note, setNote] = useState('');
  const pick = async (iso: string) => {
    const ok = await onPick(iso, note);
    if (ok) {
      setNote('');
      onClose();
    }
  };
  return (
    <Sheet open={open} onClose={onClose} title={title} eyebrow={eyebrow}>
      {withNote && (
        <Field label="Note (optional)">
          <Input value={note} onChangeText={setNote} maxLength={500} placeholder="What should you remember?" />
        </Field>
      )}
      <View>
        {laterPresets().map((p) => (
          <ListRow key={p.label} title={p.label} subtitle={dateTime(p.date.toISOString())} onPress={() => pick(p.date.toISOString())} chevron />
        ))}
      </View>
      <Field label="Or pick a date and time">
        <DateTimeField value={custom} onChange={setCustom} label="Date and time" />
      </Field>
      <Button title={confirmLabel} variant="primary" full onPress={() => pick(custom)} />
    </Sheet>
  );
}

export function RemindSheet({ open, onClose, messageId, taskId }: { open: boolean; onClose: () => void; messageId?: string; taskId?: string }) {
  const act = useAction();
  return (
    <WhenSheet
      open={open}
      onClose={onClose}
      eyebrow="Reminder"
      title="Remind me about this"
      confirmLabel="Set reminder"
      withNote
      onPick={(iso, note) => act(() => api.post('/reminders', { remindAt: iso, note, messageId, taskId }), `Reminder set for ${dateTime(iso)}`)}
    />
  );
}

export function RemindButton({ taskId, messageId, label = 'Remind me' }: { taskId?: string; messageId?: string; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button small icon="clock" title={label} onPress={() => setOpen(true)} />
      <RemindSheet open={open} onClose={() => setOpen(false)} taskId={taskId} messageId={messageId} />
    </>
  );
}
