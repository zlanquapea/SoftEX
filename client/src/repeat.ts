/** How a task can repeat. A repeating task brings in its next occurrence when it's completed. */
export type Recurrence = 'daily' | 'weekdays' | 'weekly' | 'monthly';

export const REPEAT_OPTIONS: { value: Recurrence; label: string }[] = [
  { value: 'daily', label: 'Every day' },
  { value: 'weekdays', label: 'Every weekday (Mon–Fri)' },
  { value: 'weekly', label: 'Every week' },
  { value: 'monthly', label: 'Every month' },
];

const SHORT: Record<string, string> = { daily: 'Daily', weekdays: 'Weekdays', weekly: 'Weekly', monthly: 'Monthly' };

/** "Repeats daily", "Repeats weekdays until Dec 31". */
export function repeatLabel(recurrence: string | null | undefined, until?: string | null) {
  if (!recurrence) return '';
  const base = `Repeats ${(SHORT[recurrence] ?? recurrence).toLowerCase()}`;
  if (!until) return base;
  return `${base} until ${new Date(`${until}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: until.slice(0, 4) === String(new Date().getFullYear()) ? undefined : 'numeric' })}`;
}

export const shortRepeat = (recurrence: string | null | undefined) => (recurrence ? SHORT[recurrence] ?? recurrence : '');

/** A sensible first end date for a repeat: a month after it starts (today when there's no start). */
export function defaultUntil(start?: string | null) {
  const d = start ? new Date(`${start}T00:00:00`) : new Date();
  d.setMonth(d.getMonth() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
