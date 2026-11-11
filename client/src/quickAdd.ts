/**
 * Smart task quick-add: one line of text becomes a task with a due date, priority, owner and project.
 *
 *   "Send the deck to @maya friday !high #brand refresh"
 *     → title "Send the deck to", due next Friday, high priority, owner Maya, project Brand refresh
 *
 * Dates: today, tonight, tomorrow (tmrw), weekdays (mon…sunday, "next friday"), "next week" (Monday),
 * "next month" (the 1st), "in 3 days", "in 2 weeks", "end of week" (Friday), "end of month",
 * "12 nov", "nov 12", "12/11" (day/month) and 2026-11-12. "by", "on" or "due" before a date is dropped too.
 * Priority: !urgent, !high, !medium (!med), !low.  Owner: @first-name or @full name.  Project: #name.
 * Repeats: every day (daily), every weekday (weekdays), every week (weekly), every month (monthly), and
 * "every friday" (weekly, starting Friday).
 */

export type Priority = 'low' | 'medium' | 'high' | 'urgent';
export interface QuickAddPerson {
  id: string;
  name: string;
}
export interface QuickAddProject {
  id: string;
  name: string;
}
export interface QuickAddToken {
  kind: 'due' | 'priority' | 'owner' | 'project' | 'repeat';
  /** What the chip shows, e.g. "Fri, Nov 14", "High", "Maya Singh", "Brand refresh". */
  label: string;
  /** The text that was recognised, as typed. */
  text: string;
}
export interface QuickAdd {
  title: string;
  dueDate: string | null;
  priority: Priority | null;
  ownerId: string | null;
  projectId: string | null;
  recurrence: 'daily' | 'weekdays' | 'weekly' | 'monthly' | null;
  tokens: QuickAddToken[];
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const PRIORITIES: Record<string, Priority> = { urgent: 'urgent', high: 'high', medium: 'medium', med: 'medium', low: 'low' };

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The next given weekday after today (a weekday name never means today). */
function nextWeekday(today: Date, day: number) {
  const ahead = (day - today.getDay() + 7) % 7 || 7;
  return addDays(today, ahead);
}

/** A day and month without a year: this year, or next year once it has passed. */
function dayMonth(today: Date, day: number, month: number) {
  if (month < 0 || month > 11 || day < 1 || day > 31) return null;
  let d = new Date(today.getFullYear(), month, day);
  if (d.getMonth() !== month) return null;
  if (d < addDays(today, 0) && iso(d) !== iso(today)) d = new Date(today.getFullYear() + 1, month, day);
  return d;
}

const DAY = 'sun(?:day)?|mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?';
const MONTH = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*';
/** Date phrases, each with how to turn its match into a date. */
const DATE_RULES: { re: RegExp; date: (m: RegExpMatchArray, today: Date) => Date | null }[] = [
  { re: /\b(\d{4})-(\d{2})-(\d{2})\b/, date: (m) => new Date(+m[1], +m[2] - 1, +m[3]) },
  { re: /\btoday\b|\btonight\b|\beod\b/, date: (_, t) => t },
  { re: /\b(?:tomorrow|tmrw|tmr)\b/, date: (_, t) => addDays(t, 1) },
  { re: /\bin (\d{1,3}) (day|days|week|weeks)\b/, date: (m, t) => addDays(t, +m[1] * (m[2].startsWith('week') ? 7 : 1)) },
  { re: /\bend of (?:the )?week\b/, date: (_, t) => (t.getDay() === 5 ? t : nextWeekday(t, 5)) },
  { re: /\bend of (?:the )?month\b/, date: (_, t) => new Date(t.getFullYear(), t.getMonth() + 1, 0) },
  { re: /\bnext week\b/, date: (_, t) => nextWeekday(t, 1) },
  { re: /\bnext month\b/, date: (_, t) => new Date(t.getFullYear(), t.getMonth() + 1, 1) },
  { re: new RegExp(`\\b(?:next )?(${DAY})\\b`), date: (m, t) => nextWeekday(t, WEEKDAYS.findIndex((w) => w.startsWith(m[1].slice(0, 3)))) },
  { re: new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)? (${MONTH})\\b`), date: (m, t) => dayMonth(t, +m[1], MONTHS.indexOf(m[2].slice(0, 3))) },
  { re: new RegExp(`\\b(${MONTH}) (\\d{1,2})(?:st|nd|rd|th)?\\b`), date: (m, t) => dayMonth(t, +m[2], MONTHS.indexOf(m[1].slice(0, 3))) },
  { re: /\b(\d{1,2})\/(\d{1,2})\b/, date: (m, t) => dayMonth(t, +m[1], +m[2] - 1) },
];

export function dueChipLabel(isoDate: string, today = new Date()) {
  const d = new Date(`${isoDate}T00:00:00`);
  if (isoDate === iso(today)) return 'Today';
  if (isoDate === iso(addDays(today, 1))) return 'Tomorrow';
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

export function parseQuickAdd(
  input: string,
  /** `skip` leaves those kinds in the title (the person said "no, I meant the word"). */
  options: { people?: QuickAddPerson[]; projects?: QuickAddProject[]; today?: Date; skip?: ReadonlySet<QuickAddToken['kind']> } = {},
): QuickAdd {
  const skip = options.skip ?? new Set();
  const today = options.today ?? new Date();
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  let text = ` ${input} `;
  const tokens: QuickAddToken[] = [];
  const take = (match: string) => {
    text = text.replace(match, ' ');
  };
  const result: QuickAdd = { title: '', dueDate: null, priority: null, ownerId: null, projectId: null, recurrence: null, tokens };


  // Priority: !high
  const p = text.match(/(?:^|\s)!(urgent|high|medium|med|low)\b/i);
  if (p && !skip.has('priority')) {
    result.priority = PRIORITIES[p[1].toLowerCase()];
    tokens.push({ kind: 'priority', label: result.priority[0].toUpperCase() + result.priority.slice(1), text: p[0].trim() });
    take(p[0]);
  }

  // Project: #name — the longest project name that follows the #.
  const hash = text.match(/(?:^|\s)#([^\s#@!][^#@!]*)/);
  if (hash && options.projects?.length && !skip.has('project')) {
    const after = hash[1].toLowerCase();
    // The longest full project name typed after the #; failing that, a word that starts just one project's name ("#brand").
    const full = [...options.projects]
      .sort((a, b) => b.name.length - a.name.length)
      .find((x) => after.startsWith(x.name.toLowerCase()) || after.startsWith(x.name.toLowerCase().replace(/\s+/g, '-')));
    const word = after.split(/\s/)[0];
    const starts = word.length >= 2 ? options.projects.filter((x) => x.name.toLowerCase().startsWith(word) || x.name.toLowerCase().replace(/\s+/g, '-').startsWith(word)) : [];
    const project = full ?? (starts.length === 1 ? starts[0] : undefined);
    if (project) {
      const typed = hash[0].trim().slice(0, 1 + (full ? project.name.length : word.length));
      result.projectId = project.id;
      tokens.push({ kind: 'project', label: project.name, text: typed });
      take(typed);
    }
  }

  // Owner: @full name, or @first name when only one person has it.
  const at = text.match(/(?:^|\s)@([\p{L}][\p{L}'.-]*(?: [\p{L}][\p{L}'.-]*)?)/u);
  if (at && options.people?.length && !skip.has('owner')) {
    const words = at[1].toLowerCase();
    const full = options.people.find((x) => words.startsWith(x.name.toLowerCase()));
    const first = words.split(' ')[0];
    const byFirst = options.people.filter((x) => x.name.toLowerCase().split(' ')[0] === first);
    const person = full ?? (byFirst.length === 1 ? byFirst[0] : undefined);
    if (person) {
      const typed = full ? at[0].trim().slice(0, 1 + person.name.length) : `@${at[1].split(' ')[0]}`;
      result.ownerId = person.id;
      tokens.push({ kind: 'owner', label: person.name, text: typed });
      take(new RegExp(`(?:^|\\s)${escape(typed)}`, 'i').exec(text)?.[0] ?? typed);
    }
  }

  // Repeats (after the other tokens are out, so "…daily !low" ends with "daily"): "every day", "weekdays", "every friday" (weekly, and the weekday is left to be read as the first date).
  const every = skip.has('repeat')
    ? null
    : // "every …" anywhere; a bare "daily", "weekly"… only as the last word, so "Monthly report" keeps its title.
      (text.match(new RegExp(`(?:^|\\s)((?:every|each) (day|weekday|work ?day|week|month|${DAY}))(?=\\s)`, 'i')) ??
      text.match(/(?:^|\s)(daily|weekdays|weekly|monthly)(?=\s*$)/i));
  if (every) {
    const word = (every[2] ?? every[1]).toLowerCase();
    const kind = /^(day|daily)$/.test(word) ? 'daily' : /^(weekday|weekdays|work ?day)$/.test(word) ? 'weekdays' : /^(month|monthly)$/.test(word) ? 'monthly' : 'weekly';
    const LABEL = { daily: 'Every day', weekdays: 'Every weekday', weekly: 'Every week', monthly: 'Every month' } as const;
    result.recurrence = kind;
    const weekday = every[2] && new RegExp(`^(?:${DAY})$`, 'i').test(every[2]) ? every[2] : null;
    tokens.push({ kind: 'repeat', label: weekday ? `Every ${WEEKDAYS.find((w) => w.startsWith(weekday.toLowerCase().slice(0, 3)))}` : LABEL[kind], text: every[1] });
    text = text.replace(every[1], weekday ?? ' ');
  }

  // Due date: the first phrase that reads as a date (with "by", "on" or "due" before it).
  const lower = text.toLowerCase();
  for (const rule of skip.has('due') ? [] : DATE_RULES) {
    const m = lower.match(rule.re);
    if (!m || m.index === undefined) continue;
    const date = rule.date(m, start);
    if (!date) continue;
    const before = lower.slice(0, m.index).match(/(?:\b(?:by|on|due|before)\s+)$/);
    const from = m.index - (before ? before[0].length : 0);
    const typed = text.slice(from, m.index + m[0].length);
    result.dueDate = iso(date);
    tokens.push({ kind: 'due', label: dueChipLabel(result.dueDate, start), text: typed.trim() });
    text = text.slice(0, from) + ' ' + text.slice(m.index + m[0].length);
    break;
  }

  result.title = text.replace(/\s+/g, ' ').trim();
  return result;
}
