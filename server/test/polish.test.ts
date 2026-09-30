import { afterEach, describe, expect, it } from 'vitest';
import { friendlyDate, friendlyTime } from '../src/util.js';
import { flushJobs, invite, registerOwner, setup, type TestEnv } from './helpers.js';

let env: TestEnv;
afterEach(() => env?.cleanup());

describe('dates people read', () => {
  it('formats due dates and meeting times without raw ISO strings', () => {
    const year = new Date().getUTCFullYear();
    expect(friendlyDate(`${year}-09-30`)).toMatch(/^[A-Z][a-z]{2}, Sep 30$/);
    expect(friendlyDate('2031-01-02')).toBe('Thu, Jan 2, 2031');
    expect(friendlyTime('2031-01-02T14:00:00.000Z', 'Europe/Berlin')).toBe('Thu, Jan 2, 3:00 PM (Europe/Berlin)');
    expect(friendlyTime('2031-01-02T14:00:00.000Z', 'Not/AZone')).toBe('Thu, Jan 2, 2:00 PM UTC');
  });

  it('writes readable dates into notifications', async () => {
    env = setup();
    const owner = await registerOwner(env);
    const member = await invite(env, owner.agent);
    await owner.agent.post('/api/tasks').send({ title: 'Ship it', ownerId: member.id, dueDate: '2031-01-02' }).expect(201);
    await owner.agent.post('/api/meetings').send({ title: 'Kick-off', startsAt: '2031-01-02T14:00:00.000Z', participantIds: [member.id] }).expect(201);
    await flushJobs(env);
    const bodies = (await member.agent.get('/api/notifications')).body.notifications.map((n: { body: string }) => n.body);
    expect(bodies).toContain('Due Thu, Jan 2, 2031');
    expect(bodies.some((b: string) => /^Thu, Jan 2, \d+:00 PM/.test(b))).toBe(true);
    expect(bodies.join(' ')).not.toMatch(/GMT|\d{4}-\d{2}-\d{2}/);
  });
});

describe('home for a new workspace', () => {
  it('guides the owner through setup, and says so on a first visit', async () => {
    env = setup();
    const owner = await registerOwner(env);
    let home = (await owner.agent.get('/api/home')).body;
    expect(home.first_visit).toBe(true);
    expect(home.setup.map((s: { id: string; done: boolean }) => [s.id, s.done])).toEqual([
      ['invite', false],
      ['project', false],
      ['message', false],
      ['page', false],
      ['meeting', false],
    ]);
    const member = await invite(env, owner.agent);
    await owner.agent.post('/api/projects').send({ name: 'Launch' }).expect(201);
    home = (await owner.agent.get('/api/home')).body;
    expect(home.setup.filter((s: { done: boolean }) => s.done).map((s: { id: string }) => s.id)).toEqual(['invite', 'project']);
    // Members don't get the guide.
    expect((await member.agent.get('/api/home')).body.setup).toBeNull();
  });
});
