import { useMemo, useState, type ReactNode } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import type { Person } from '../lib/api';
import { dateLabel, localToday } from '../lib/format';
import { useSession } from '../lib/session';
import { radius, useTheme } from '../lib/theme';
import { Icon } from './Icon';
import { Avatar, Button, Checkbox, ListRow, Muted, Row, SearchBox, Sheet, T } from './kit';

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

/** A month calendar. Values are "YYYY-MM-DD". */
export function Calendar({ value, onChange, min }: { value: string | null; onChange: (v: string) => void; min?: string }) {
  const { c } = useTheme();
  const initial = value ? new Date(`${value}T00:00:00`) : new Date();
  const [month, setMonth] = useState(new Date(initial.getFullYear(), initial.getMonth(), 1));
  const today = localToday();
  const cells = useMemo(() => {
    const first = (month.getDay() + 6) % 7;
    const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
    const out: (string | null)[] = Array(first).fill(null);
    for (let d = 1; d <= days; d++) out.push(ymd(new Date(month.getFullYear(), month.getMonth(), d)));
    while (out.length % 7) out.push(null);
    return out;
  }, [month]);
  const shift = (n: number) => setMonth(new Date(month.getFullYear(), month.getMonth() + n, 1));
  return (
    <View style={{ gap: 8 }}>
      <Row style={{ justifyContent: 'space-between' }}>
        <Pressable onPress={() => shift(-1)} hitSlop={10} accessibilityLabel="Previous month" style={{ padding: 6 }}>
          <Icon name="chevronLeft" size={20} color={c.ink2} />
        </Pressable>
        <T weight="bold">{month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</T>
        <Pressable onPress={() => shift(1)} hitSlop={10} accessibilityLabel="Next month" style={{ padding: 6 }}>
          <Icon name="chevronRight" size={20} color={c.ink2} />
        </Pressable>
      </Row>
      <View style={{ flexDirection: 'row' }}>
        {WEEKDAYS.map((d, i) => (
          <T key={i} size={12} weight="bold" tone="muted" style={{ flex: 1, textAlign: 'center' }}>
            {d}
          </T>
        ))}
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
        {cells.map((d, i) => {
          const on = d === value;
          const disabled = !d || (min ? d < min : false);
          return (
            <View key={i} style={{ width: `${100 / 7}%`, aspectRatio: 1, padding: 2 }}>
              {d && (
                <Pressable
                  disabled={disabled}
                  onPress={() => onChange(d)}
                  accessibilityRole="button"
                  accessibilityLabel={dateLabel(d)}
                  accessibilityState={{ selected: on, disabled }}
                  style={{
                    flex: 1,
                    borderRadius: 10,
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: on ? c.accent : d === today ? c.accentSoft : 'transparent',
                    opacity: disabled ? 0.35 : 1,
                  }}
                >
                  <T weight={on || d === today ? 'bold' : 'medium'} style={{ color: on ? '#fff' : d === today ? c.accentInk : c.ink }}>
                    {Number(d.slice(8))}
                  </T>
                </Pressable>
              )}
            </View>
          );
        })}
      </View>
    </View>
  );
}

/** A tappable date control that opens a calendar sheet. */
export function DateField({
  value,
  onChange,
  placeholder = 'No date',
  label = 'Pick a date',
  clearable = true,
  min,
  disabled,
}: {
  value: string | null | undefined;
  onChange: (v: string | null) => void;
  placeholder?: string;
  label?: string;
  clearable?: boolean;
  min?: string;
  disabled?: boolean;
}) {
  const { c } = useTheme();
  const [open, setOpen] = useState(false);
  const quick = [
    { label: 'Today', days: 0 },
    { label: 'Tomorrow', days: 1 },
    { label: 'Next week', days: 7 },
  ];
  return (
    <>
      <Pressable
        onPress={() => !disabled && setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ disabled }}
        accessibilityValue={{ text: value ? dateLabel(value) : placeholder }}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 46, borderWidth: 1, borderColor: c.lineStrong, borderRadius: 11, paddingHorizontal: 13, backgroundColor: c.surface, opacity: disabled ? 0.6 : 1 }}
      >
        <Icon name="calendar" size={17} color={c.muted} />
        <T style={{ flex: 1 }} tone={value ? 'ink' : 'muted'}>
          {value ? dateLabel(value) : placeholder}
        </T>
      </Pressable>
      <Sheet open={open} onClose={() => setOpen(false)} title={label}>
        <Row wrap>
          {quick.map((q) => (
            <Button
              key={q.label}
              title={q.label}
              small
              onPress={() => {
                const d = new Date();
                d.setDate(d.getDate() + q.days);
                onChange(ymd(d));
                setOpen(false);
              }}
            />
          ))}
          {clearable && value && (
            <Button
              title="Clear"
              small
              variant="ghost"
              onPress={() => {
                onChange(null);
                setOpen(false);
              }}
            />
          )}
        </Row>
        <Calendar
          value={value ?? null}
          min={min}
          onChange={(v) => {
            onChange(v);
            setOpen(false);
          }}
        />
      </Sheet>
    </>
  );
}

/** Date and time, as an ISO timestamp. Times are offered in 15-minute steps. */
export function DateTimeField({ value, onChange, label = 'When' }: { value: string; onChange: (iso: string) => void; label?: string }) {
  const { c } = useTheme();
  const [open, setOpen] = useState(false);
  const d = new Date(value);
  const day = ymd(d);
  const times = useMemo(() => {
    const out: { h: number; m: number }[] = [];
    for (let h = 6; h < 23; h++) for (const m of [0, 15, 30, 45]) out.push({ h, m });
    return out;
  }, []);
  const set = (date: string, h: number, m: number) => {
    const next = new Date(`${date}T${pad(h)}:${pad(m)}:00`);
    onChange(next.toISOString());
  };
  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={label}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 46, borderWidth: 1, borderColor: c.lineStrong, borderRadius: 11, paddingHorizontal: 13, backgroundColor: c.surface }}
      >
        <Icon name="clock" size={17} color={c.muted} />
        <T style={{ flex: 1 }}>{d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</T>
      </Pressable>
      <Sheet open={open} onClose={() => setOpen(false)} title={label} footer={<Button title="Done" variant="primary" full onPress={() => setOpen(false)} />}>
        <Calendar value={day} onChange={(v) => set(v, d.getHours(), d.getMinutes())} />
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
          {times.map((t) => {
            const on = t.h === d.getHours() && t.m === d.getMinutes();
            return (
              <Pressable
                key={`${t.h}:${t.m}`}
                onPress={() => set(day, t.h, t.m)}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                style={{ paddingHorizontal: 12, height: 36, justifyContent: 'center', borderRadius: radius.pill, borderWidth: 1, borderColor: on ? c.accent : c.line, backgroundColor: on ? c.accent : c.surface }}
              >
                <T size={13} weight="bold" style={{ color: on ? '#fff' : c.ink2 }}>
                  {new Date(2000, 0, 1, t.h, t.m).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
                </T>
              </Pressable>
            );
          })}
        </ScrollView>
      </Sheet>
    </>
  );
}

type Pickable = Pick<Person, 'id' | 'name' | 'color'> & { title?: string; role?: string };

/** Choose people from the workspace directory (or a given list). */
export function PeopleField({
  value,
  onChange,
  people,
  multiple = true,
  placeholder = 'Add people',
  title,
  exclude = [],
  allowNone,
  disabled,
}: {
  value: string[];
  onChange: (ids: string[]) => void;
  people?: Pickable[];
  multiple?: boolean;
  placeholder?: string;
  title?: string;
  exclude?: string[];
  allowNone?: string;
  disabled?: boolean;
}) {
  const { c } = useTheme();
  const { people: everyone } = useSession();
  const list = (people ?? everyone.filter((p) => p.role !== 'guest' || value.includes(p.id))).filter((p) => !exclude.includes(p.id));
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const selected = list.filter((p) => value.includes(p.id));
  const shown = list.filter((p) => !q || p.name.toLowerCase().includes(q.toLowerCase()) || p.title?.toLowerCase().includes(q.toLowerCase()));
  let summary: ReactNode = <T tone="muted">{placeholder}</T>;
  if (selected.length === 1)
    summary = (
      <Row>
        <Avatar user={selected[0]} size="xs" />
        <T>{selected[0].name}</T>
      </Row>
    );
  else if (selected.length > 1) summary = <T numberOfLines={1}>{selected.map((p) => p.name.split(' ')[0]).join(', ')}</T>;
  return (
    <>
      <Pressable
        onPress={() => !disabled && setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={title ?? placeholder}
        accessibilityState={{ disabled }}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 46, borderWidth: 1, borderColor: c.lineStrong, borderRadius: 11, paddingHorizontal: 13, backgroundColor: c.surface, opacity: disabled ? 0.6 : 1 }}
      >
        <View style={{ flex: 1 }}>{summary}</View>
        <Icon name="chevronDown" size={18} color={c.muted} />
      </Pressable>
      <Sheet open={open} onClose={() => setOpen(false)} title={title ?? placeholder} full footer={multiple ? <Button title="Done" variant="primary" full onPress={() => setOpen(false)} /> : undefined}>
        <SearchBox value={q} onChangeText={setQ} placeholder="Search people" />
        <View>
          {!multiple && allowNone && (
            <ListRow
              title={allowNone}
              left={<Avatar user={null} size="sm" />}
              right={!value.length ? <Icon name="check" size={18} color={c.accent} /> : undefined}
              onPress={() => {
                onChange([]);
                setOpen(false);
              }}
            />
          )}
          {shown.map((p) => {
            const on = value.includes(p.id);
            return (
              <ListRow
                key={p.id}
                title={p.name}
                subtitle={p.title}
                left={<Avatar user={p} size="sm" />}
                right={multiple ? <Checkbox checked={on} onChange={() => onChange(on ? value.filter((v) => v !== p.id) : [...value, p.id])} /> : on ? <Icon name="check" size={18} color={c.accent} /> : undefined}
                onPress={() => {
                  if (multiple) onChange(on ? value.filter((v) => v !== p.id) : [...value, p.id]);
                  else {
                    onChange([p.id]);
                    setOpen(false);
                  }
                }}
              />
            );
          })}
          {!shown.length && <Muted style={{ padding: 12 }}>No matches</Muted>}
        </View>
      </Sheet>
    </>
  );
}
