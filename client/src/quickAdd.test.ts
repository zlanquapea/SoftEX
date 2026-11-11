import { describe, expect, it } from 'vitest';
import { parseQuickAdd } from './quickAdd';

// Wednesday 12 November 2025.
const today = new Date(2025, 10, 12);
const people = [
  { id: 'maya', name: 'Maya Singh' },
  { id: 'jordan', name: 'Jordan Wells' },
  { id: 'jo', name: 'Jo Park' },
];
const projects = [
  { id: 'brand', name: 'Brand refresh' },
  { id: 'brand-x', name: 'Brand' },
  { id: 'mobile', name: 'Mobile app' },
];
const parse = (text: string) => parseQuickAdd(text, { people, projects, today });

describe('smart quick-add', () => {
  it('reads a due date, priority, owner and project out of one line', () => {
    const r = parse('Send the deck to @maya friday !high #brand refresh');
    expect(r).toMatchObject({ title: 'Send the deck to', dueDate: '2025-11-14', priority: 'high', ownerId: 'maya', projectId: 'brand' });
    expect(r.tokens.map((t) => t.kind).sort()).toEqual(['due', 'owner', 'priority', 'project']);
  });

  it('leaves plain text alone', () => {
    expect(parse('Write the onboarding guide')).toMatchObject({ title: 'Write the onboarding guide', dueDate: null, priority: null, ownerId: null, projectId: null, tokens: [] });
  });

  it.each([
    ['Pay invoice today', '2025-11-12'],
    ['Pay invoice tomorrow', '2025-11-13'],
    ['Pay invoice tmrw', '2025-11-13'],
    ['Pay invoice by monday', '2025-11-17'],
    // A weekday name never means today.
    ['Pay invoice wednesday', '2025-11-19'],
    ['Pay invoice next week', '2025-11-17'],
    ['Pay invoice next month', '2025-12-01'],
    ['Pay invoice in 3 days', '2025-11-15'],
    ['Pay invoice in 2 weeks', '2025-11-26'],
    ['Pay invoice end of week', '2025-11-14'],
    ['Pay invoice end of month', '2025-11-30'],
    ['Pay invoice due 20 nov', '2025-11-20'],
    ['Pay invoice on Nov 20th', '2025-11-20'],
    ['Pay invoice 20/11', '2025-11-20'],
    // A day that has already passed this year means next year.
    ['Pay invoice 3 jan', '2026-01-03'],
    ['Pay invoice 2026-02-01', '2026-02-01'],
  ])('%s → %s', (text, due) => {
    const r = parse(text);
    expect(r.dueDate).toBe(due);
    expect(r.title).toBe('Pay invoice');
  });

  it('does not take dates out of the middle of words', () => {
    expect(parse('Monthly sunny wedding plan').dueDate).toBeNull();
    expect(parse('Monthly sunny wedding plan').title).toBe('Monthly sunny wedding plan');
  });

  it('matches the longest project and a unique first name; leaves unknown ones in the title', () => {
    expect(parse('Logo #brand refresh').projectId).toBe('brand');
    expect(parse('Logo #brand').projectId).toBe('brand-x');
    expect(parse('Logo #mobile-app').projectId).toBe('mobile');
    // The start of just one project's name is enough.
    expect(parse('Logo #mob tomorrow')).toMatchObject({ projectId: 'mobile', title: 'Logo' });
    // …but not when it could be more than one ("bra" starts both Brand and Brand refresh).
    expect(parse('Logo #bra').projectId).toBeNull();
    expect(parse('Ask @jordan wells').ownerId).toBe('jordan');
    expect(parse('Ask @Jo about it')).toMatchObject({ ownerId: 'jo', title: 'Ask about it' });
    expect(parse('Ask @nobody #nowhere')).toMatchObject({ ownerId: null, projectId: null, title: 'Ask @nobody #nowhere' });
  });

  it('can be told to leave a part in the title', () => {
    expect(parseQuickAdd('Plan the May 5 launch', { today, skip: new Set(['due']) })).toMatchObject({ title: 'Plan the May 5 launch', dueDate: null });
  });

  it('reads priorities, including the short form', () => {
    expect(parse('Fix login !urgent').priority).toBe('urgent');
    expect(parse('Tidy docs !med').priority).toBe('medium');
    expect(parse('Tidy docs !low').title).toBe('Tidy docs');
  });
});

describe('repeats', () => {
  const today = new Date(2026, 10, 11); // Wednesday
  it('reads every day, every weekday, weekly and monthly', () => {
    expect(parseQuickAdd('Check the inbox every day', { today })).toMatchObject({ title: 'Check the inbox', recurrence: 'daily', dueDate: null });
    expect(parseQuickAdd('Stand-up notes every weekday', { today })).toMatchObject({ title: 'Stand-up notes', recurrence: 'weekdays' });
    expect(parseQuickAdd('Water plants daily !low', { today })).toMatchObject({ title: 'Water plants', recurrence: 'daily', priority: 'low' });
    expect(parseQuickAdd('Timesheet weekly', { today })).toMatchObject({ title: 'Timesheet', recurrence: 'weekly' });
    expect(parseQuickAdd('Pay rent monthly', { today })).toMatchObject({ title: 'Pay rent', recurrence: 'monthly' });
  });
  it('"every friday" repeats weekly from the next Friday', () => {
    const r = parseQuickAdd('Send the report every friday', { today });
    expect(r).toMatchObject({ title: 'Send the report', recurrence: 'weekly', dueDate: '2026-11-13' });
    expect(r.tokens.find((t) => t.kind === 'repeat')?.label).toBe('Every friday');
  });
  it('can be turned off to keep the words', () => {
    expect(parseQuickAdd('Write the weekly newsletter', { today, skip: new Set(['repeat']) })).toMatchObject({ title: 'Write the weekly newsletter', recurrence: null });
  });
});
