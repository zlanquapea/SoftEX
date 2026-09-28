import { afterEach, describe, expect, it } from 'vitest';
import { invite, registerOwner, setup, type TestEnv } from './helpers.js';

let env: TestEnv;
afterEach(() => env?.cleanup());

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

describe('dashboards', () => {
  it('computes every widget from what the viewer can open', async () => {
    env = setup();
    const owner = await registerOwner(env, 'Olu Owner');
    const member = await invite(env, owner.agent, 'member', {}, 'Mia Member');
    const open = (await owner.agent.post('/api/projects').send({ name: 'Open work', memberIds: [member.id] })).body;
    const secret = (await owner.agent.post('/api/projects').send({ name: 'Board papers', visibility: 'private' })).body;

    await owner.agent.post('/api/tasks').send({ title: 'Late one', projectId: open.id, ownerId: member.id, dueDate: day(-2), priority: 'urgent' });
    await owner.agent.post('/api/tasks').send({ title: 'Blocked one', projectId: open.id, ownerId: member.id });
    const done = (await owner.agent.post('/api/tasks').send({ title: 'Finished', projectId: open.id })).body;
    await owner.agent.patch(`/api/tasks/${done.id}`).send({ status: 'done' });
    const blocked = (await owner.agent.get(`/api/tasks?projectId=${open.id}`)).body.find((t: { title: string }) => t.title === 'Blocked one');
    await owner.agent.patch(`/api/tasks/${blocked.id}`).send({ status: 'blocked', blockedReason: 'Waiting on quote' });
    for (const title of ['Minutes', 'Budget', 'Audit']) await owner.agent.post('/api/tasks').send({ title, projectId: secret.id, dueDate: day(-1) });

    // A new dashboard starts with a useful layout, shared with the workspace.
    const dash = (await owner.agent.post('/api/dashboards').send({ name: 'Ops' })).body;
    expect(dash.widgets.length).toBeGreaterThan(5);
    expect(dash.visibility).toBe('workspace');

    const mine = (await owner.agent.get(`/api/dashboards/${dash.id}/data`)).body.widgets;
    const theirs = (await member.agent.get(`/api/dashboards/${dash.id}/data`)).body.widgets;
    // Open tasks: owner sees 2 + 3 private; the member only sees the 2 in the project they can open.
    expect(mine.w1).toMatchObject({ kind: 'number', value: 5 });
    expect(theirs.w1).toMatchObject({ kind: 'number', value: 2 });
    expect(theirs.w2).toMatchObject({ value: 1 }); // overdue
    expect(theirs.w3).toMatchObject({ value: 1 }); // done this week
    expect(theirs.w4).toMatchObject({ value: 1 }); // blocked
    const status = Object.fromEntries(theirs.w5.items.map((i: { key: string; value: number }) => [i.key, i.value]));
    expect(status).toMatchObject({ todo: 1, blocked: 1, done: 1 });
    expect(theirs.w6.items).toEqual([expect.objectContaining({ label: 'Mia Member', value: 2 })]);
    expect(theirs.w7.series.find((s: { key: string }) => s.key === 'created').values.at(-1)).toBe(3);
    expect(theirs.w8.items.map((i: { title: string }) => i.title)).toEqual(['Late one']);
    expect(theirs.w9.items.map((i: { title: string }) => i.title)).toEqual(['Open work']);
    expect(JSON.stringify(theirs)).not.toContain('Board papers');
    expect(JSON.stringify(theirs)).not.toContain('Minutes');

    // A widget pinned to a project the viewer can't open shows nothing, not the owner's data.
    await owner.agent
      .patch(`/api/dashboards/${dash.id}`)
      .send({ widgets: [{ id: 'p', type: 'number', metric: 'overdue', projectIds: [secret.id] }, { id: 'q', type: 'priority', projectIds: [open.id] }] })
      .expect(200);
    const pinned = (await member.agent.get(`/api/dashboards/${dash.id}/data`)).body.widgets;
    expect(pinned.p).toMatchObject({ value: 0 });
    expect((await owner.agent.get(`/api/dashboards/${dash.id}/data`)).body.widgets.p).toMatchObject({ value: 3 });
    expect(pinned.q.items.find((i: { key: string }) => i.key === 'urgent').value).toBe(1);
  });

  it('charts custom fields, time and goals', async () => {
    env = setup();
    const owner = await registerOwner(env);
    const project = (await owner.agent.post('/api/projects').send({ name: 'Clinics' })).body;
    const other = (await owner.agent.post('/api/projects').send({ name: 'Other' })).body;
    const county = (await owner.agent.post(`/api/projects/${project.id}/fields`).send({ name: 'County', type: 'select', options: [{ label: 'Bong' }, { label: 'Nimba' }] })).body;
    const cost = (await owner.agent.post(`/api/projects/${project.id}/fields`).send({ name: 'Cost', type: 'number' })).body;
    const tasks = [];
    for (const [c, v] of [['Bong', 100], ['Bong', 50], ['Nimba', 25]] as const) {
      const t = (await owner.agent.post('/api/tasks').send({ title: `Clinic ${c}`, projectId: project.id })).body;
      await owner.agent.put(`/api/tasks/${t.id}/fields/${county.id}`).send({ value: c });
      await owner.agent.put(`/api/tasks/${t.id}/fields/${cost.id}`).send({ value: v });
      tasks.push(t);
    }
    await owner.agent.post('/api/tasks').send({ title: 'No county', projectId: project.id });
    await owner.agent.post(`/api/tasks/${tasks[0].id}/time`).send({ minutes: 90 });
    await owner.agent.post('/api/goals').send({ title: 'Open 10 clinics', projectIds: [project.id] });

    const dash = (
      await owner.agent.post('/api/dashboards').send({
        name: 'Clinics',
        visibility: 'private',
        widgets: [
          { id: 'county', type: 'field', fieldId: county.id, projectIds: [project.id] },
          { id: 'cost', type: 'number', metric: 'field_sum', fieldId: cost.id, projectIds: [project.id] },
          { id: 'wrong', type: 'field', fieldId: county.id, projectIds: [other.id] },
          { id: 'hours', type: 'time', projectIds: [project.id] },
          { id: 'week', type: 'number', metric: 'hours_week' },
          { id: 'goals', type: 'goals', projectIds: [] },
          { id: 'note', type: 'note', text: '**Read me**' },
        ],
      })
    ).body;
    const data = (await owner.agent.get(`/api/dashboards/${dash.id}/data`)).body.widgets;
    expect(data.county.items.map((i: { label: string; value: number }) => [i.label, i.value])).toEqual([
      ['Bong', 2],
      ['Nimba', 1],
      ['Not set', 1],
    ]);
    expect(data.cost).toMatchObject({ kind: 'number', value: 175, unit: 'Cost' });
    // A field from outside the widget's projects is refused.
    expect(data.wrong.kind).toBe('empty');
    expect(data.hours.items[0]).toMatchObject({ value: 1.5 });
    expect(data.week).toMatchObject({ value: 1.5, unit: 'hours' });
    expect(data.goals.items[0]).toMatchObject({ title: 'Open 10 clinics', link: expect.stringMatching(/^\/goals\//) });
    expect(data.note).toEqual({ kind: 'note' });
  });

  it('keeps private dashboards private and editing to owners and admins', async () => {
    env = setup();
    const owner = await registerOwner(env);
    const member = await invite(env, owner.agent);
    const other = await invite(env, owner.agent);
    const general = (await owner.agent.get('/api/channels')).body.find((c: { name: string }) => c.name === 'general');
    const guest = await invite(env, owner.agent, 'guest', { channelIds: [general.id], guestDays: 7 });

    const mine = (await member.agent.post('/api/dashboards').send({ name: 'My view', visibility: 'private' })).body;
    const shared = (await member.agent.post('/api/dashboards').send({ name: 'Team view' })).body;
    expect((await other.agent.get(`/api/dashboards/${mine.id}`)).status).toBe(404);
    expect((await other.agent.get(`/api/dashboards/${mine.id}/data`)).status).toBe(404);
    expect((await other.agent.get('/api/dashboards')).body.map((d: { name: string }) => d.name)).toEqual(['Team view']);
    expect((await other.agent.get(`/api/dashboards/${shared.id}`)).body.can_edit).toBe(false);
    expect((await other.agent.patch(`/api/dashboards/${shared.id}`).send({ name: 'Mine now' })).status).toBe(403);
    expect((await other.agent.delete(`/api/dashboards/${shared.id}`)).status).toBe(403);
    // Admins can tidy up shared dashboards.
    await owner.agent.patch(`/api/dashboards/${shared.id}`).send({ description: 'Weekly review' }).expect(200);
    expect((await member.agent.get(`/api/dashboards/${shared.id}`)).body).toMatchObject({ name: 'Team view', description: 'Weekly review' });

    expect((await member.agent.post('/api/dashboards').send({ name: 'x', widgets: [{ id: 'a', type: 'note' }, { id: 'a', type: 'note' }] })).status).toBe(400);
    expect((await member.agent.post('/api/dashboards').send({ name: 'x', widgets: [{ id: 'a', type: 'pie' }] })).status).toBe(400);
    expect((await guest.agent.get('/api/dashboards')).status).toBe(403);

    // Favorites follow access too.
    await other.agent.put('/api/favorites').send({ kind: 'dashboard', id: shared.id, on: true }).expect(200);
    expect((await other.agent.put('/api/favorites').send({ kind: 'dashboard', id: mine.id, on: true })).status).toBe(404);
    expect((await other.agent.get('/api/favorites')).body).toEqual([expect.objectContaining({ kind: 'dashboard', title: 'Team view', link: `/dashboards/${shared.id}` })]);
    await member.agent.delete(`/api/dashboards/${shared.id}`).expect(200);
    expect((await other.agent.get('/api/favorites')).body).toEqual([]);
  });
});
