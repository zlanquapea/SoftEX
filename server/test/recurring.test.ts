import { afterEach, describe, expect, it } from 'vitest';
import { nextDue } from '../src/routes/tasks.js';
import { registerOwner, setup, type TestEnv } from './helpers.js';

let env: TestEnv;
afterEach(async () => env?.cleanup());

const iso = (d: Date) => d.toISOString().slice(0, 10);
const dayFrom = (base: string, n: number) => iso(new Date(Date.parse(`${base}T00:00:00Z`) + n * 86_400_000));

describe('nextDue', () => {
  it('steps daily, on weekdays, weekly and monthly', () => {
    expect(nextDue('2026-11-11', 'daily', '2026-11-11')).toBe('2026-11-12');
    // Friday → Monday when only weekdays count.
    expect(nextDue('2026-11-13', 'weekdays', '2026-11-13')).toBe('2026-11-16');
    expect(nextDue('2026-11-11', 'weekly', '2026-11-11')).toBe('2026-11-18');
    expect(nextDue('2026-11-11', 'monthly', '2026-11-11')).toBe('2026-12-11');
  });
  it('keeps the day of the month, using the last day of shorter months', () => {
    expect(nextDue('2026-01-31', 'monthly', '2026-01-31')).toBe('2026-02-28');
    expect(nextDue('2026-08-31', 'monthly', '2026-08-31')).toBe('2026-09-30');
  });
  it('skips repeats missed while the task sat undone', () => {
    expect(nextDue('2026-11-01', 'daily', '2026-11-11')).toBe('2026-11-12');
    expect(nextDue('2026-09-05', 'monthly', '2026-11-11')).toBe('2026-12-05');
    // Done early: the next one still comes after this one's due date.
    expect(nextDue('2026-11-12', 'daily', '2026-11-10')).toBe('2026-11-13');
  });
  it('starts from today when the task has no due date', () => {
    expect(nextDue(null, 'daily', '2026-11-11')).toBe('2026-11-12');
  });
});

describe('repeating tasks', () => {
  it('a daily task with no end repeats each time it is done, once per occurrence, with its checklist and labels', async () => {
    env = setup();
    const owner = await registerOwner(env);
    const a = owner.agent;
    const today = iso(new Date());
    const task = (await a.post('/api/tasks').send({ title: 'Check the inbox', dueDate: today, recurrence: 'daily' })).body;
    expect(task).toMatchObject({ recurrence: 'daily', recurrence_until: null });
    await a.post(`/api/tasks/${task.id}/checklist`).send({ text: 'Reply to customers' });
    const label = (await a.post('/api/labels').send({ name: 'Routine', color: 'blue' })).body;
    await a.put(`/api/tasks/${task.id}/labels`).send({ labelIds: [label.id] });

    const done = (await a.patch(`/api/tasks/${task.id}`).send({ status: 'done' })).body;
    expect(done.next_occurrence).toMatchObject({ due_date: dayFrom(today, 1) });
    const next = (await a.get(`/api/tasks/${done.next_occurrence.id}`)).body;
    expect(next).toMatchObject({ title: 'Check the inbox', status: 'todo', recurrence: 'daily', due_date: dayFrom(today, 1) });
    expect(next.checklist.map((c: { text: string; done: number | boolean }) => [c.text, !!c.done])).toEqual([['Reply to customers', false]]);
    expect(next.labels.map((l: { name: string }) => l.name)).toEqual(['Routine']);

    // Reopening and completing again doesn't make a second copy.
    await a.patch(`/api/tasks/${task.id}`).send({ status: 'todo' });
    const again = (await a.patch(`/api/tasks/${task.id}`).send({ status: 'done' })).body;
    expect(again.next_occurrence).toBeNull();
    const all = (await a.get('/api/tasks?q=Check%20the%20inbox')).body as { id: string }[];
    expect(all.length).toBe(2);

    // And the next one carries on.
    const third = (await a.patch(`/api/tasks/${next.id}`).send({ status: 'done' })).body;
    expect(third.next_occurrence).toMatchObject({ due_date: dayFrom(today, 2) });
  });

  it('stops at its end date, and stopping the repeat stops it', async () => {
    env = setup();
    const owner = await registerOwner(env);
    const a = owner.agent;
    const today = iso(new Date());
    const task = (await a.post('/api/tasks').send({ title: 'Stand-up notes', dueDate: today, recurrence: 'daily', recurrenceUntil: dayFrom(today, 1) })).body;
    expect(task.recurrence_until).toBe(dayFrom(today, 1));
    const first = (await a.patch(`/api/tasks/${task.id}`).send({ status: 'done' })).body;
    expect(first.next_occurrence.due_date).toBe(dayFrom(today, 1));
    // The next repeat would be after the end date: none.
    expect((await a.patch(`/api/tasks/${first.next_occurrence.id}`).send({ status: 'done' })).body.next_occurrence).toBeNull();

    const weekly = (await a.post('/api/tasks').send({ title: 'Timesheet', dueDate: today, recurrence: 'weekly' })).body;
    const stopped = (await a.patch(`/api/tasks/${weekly.id}`).send({ recurrence: null })).body;
    expect(stopped).toMatchObject({ recurrence: null, recurrence_until: null });
    expect((await a.patch(`/api/tasks/${weekly.id}`).send({ status: 'done' })).body.next_occurrence).toBeNull();
  });
});
