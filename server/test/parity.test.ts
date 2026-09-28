import { afterEach, describe, expect, it } from 'vitest';
import { invite, registerOwner, setup, type TestEnv } from './helpers.js';

let env: TestEnv;
afterEach(() => env?.cleanup());

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const tokenOf = (url: string) => url.split('/').at(-1)!;

describe('labels and custom fields', () => {
  it('tags tasks, filters by label and stores typed field values', async () => {
    env = setup();
    const owner = await registerOwner(env);
    const member = await invite(env, owner.agent);
    const outsider = await invite(env, owner.agent);
    const project = (await owner.agent.post('/api/projects').send({ name: 'Clinic rollout', memberIds: [member.id], visibility: 'private' })).body;
    const task = (await member.agent.post('/api/tasks').send({ title: 'Order generators', projectId: project.id })).body;
    const other = (await member.agent.post('/api/tasks').send({ title: 'Hire nurses', projectId: project.id })).body;

    const urgent = (await member.agent.post('/api/labels').send({ name: 'Procurement', color: 'gold' })).body;
    // Same name, any case, returns the existing label.
    expect((await owner.agent.post('/api/labels').send({ name: 'procurement' })).body.id).toBe(urgent.id);
    const labelled = await member.agent.put(`/api/tasks/${task.id}/labels`).send({ labelIds: [urgent.id] });
    expect(labelled.body).toEqual([{ id: urgent.id, name: 'Procurement', color: 'gold' }]);
    expect((await outsider.agent.put(`/api/tasks/${task.id}/labels`).send({ labelIds: [] })).status).toBe(404);

    const filtered = (await member.agent.get(`/api/tasks?projectId=${project.id}&labelId=${urgent.id}`)).body;
    expect(filtered.map((t: { id: string }) => t.id)).toEqual([task.id]);
    expect(filtered[0].labels[0].name).toBe('Procurement');

    // Only project leads define fields.
    expect((await member.agent.post(`/api/projects/${project.id}/fields`).send({ name: 'Cost', type: 'number' })).status).toBe(403);
    const cost = (await owner.agent.post(`/api/projects/${project.id}/fields`).send({ name: 'Cost', type: 'number' })).body;
    const county = (await owner.agent.post(`/api/projects/${project.id}/fields`).send({ name: 'County', type: 'select', options: [{ label: 'Bong' }, { label: 'Nimba' }] })).body;
    expect((await owner.agent.post(`/api/projects/${project.id}/fields`).send({ name: 'Empty', type: 'select' })).status).toBe(400);

    expect((await member.agent.put(`/api/tasks/${task.id}/fields/${cost.id}`).send({ value: 'lots' })).status).toBe(400);
    expect((await member.agent.put(`/api/tasks/${task.id}/fields/${county.id}`).send({ value: 'Lofa' })).status).toBe(400);
    await member.agent.put(`/api/tasks/${task.id}/fields/${cost.id}`).send({ value: 1250 }).expect(200);
    await member.agent.put(`/api/tasks/${task.id}/fields/${county.id}`).send({ value: 'Nimba' }).expect(200);
    // A field from another project can't be written through this task.
    const elsewhere = (await owner.agent.post('/api/projects').send({ name: 'Elsewhere' })).body;
    const foreign = (await owner.agent.post(`/api/projects/${elsewhere.id}/fields`).send({ name: 'X', type: 'text' })).body;
    expect((await member.agent.put(`/api/tasks/${task.id}/fields/${foreign.id}`).send({ value: 'x' })).status).toBe(404);

    const detail = (await member.agent.get(`/api/tasks/${task.id}`)).body;
    expect(detail.fields).toEqual({ [cost.id]: 1250, [county.id]: 'Nimba' });
    await member.agent.put(`/api/tasks/${task.id}/fields/${cost.id}`).send({ value: null }).expect(200);
    expect((await member.agent.get(`/api/tasks/${task.id}`)).body.fields).toEqual({ [county.id]: 'Nimba' });
    expect((await member.agent.get(`/api/tasks/${other.id}`)).body.fields).toEqual({});

    // Deleting a field removes its values.
    await owner.agent.delete(`/api/fields/${county.id}`).expect(200);
    expect((await member.agent.get(`/api/tasks/${task.id}`)).body.fields).toEqual({});
    expect((await outsider.agent.get(`/api/projects/${project.id}/fields`)).status).toBe(404);
  });
});

describe('time tracking', () => {
  it('runs one timer at a time, logs manual time and totals it', async () => {
    env = setup();
    const owner = await registerOwner(env);
    const member = await invite(env, owner.agent);
    const viewer = await invite(env, owner.agent);
    const project = (await owner.agent.post('/api/projects').send({ name: 'Website', memberIds: [member.id], visibility: 'private' })).body;
    const a = (await member.agent.post('/api/tasks').send({ title: 'Design', projectId: project.id, ownerId: member.id, estimateHours: 2 })).body;
    const b = (await member.agent.post('/api/tasks').send({ title: 'Build', projectId: project.id, ownerId: member.id })).body;

    await member.agent.post(`/api/tasks/${a.id}/time/start`).expect(201);
    await member.agent.post(`/api/tasks/${b.id}/time/start`).expect(201);
    const onA = (await member.agent.get(`/api/tasks/${a.id}/time`)).body;
    expect(onA.running).toBeNull();
    expect(onA.entries[0].running).toBe(false);
    expect((await member.agent.get(`/api/tasks/${b.id}/time`)).body.running).not.toBeNull();
    await member.agent.post('/api/time/stop').expect(200);

    await member.agent.post(`/api/tasks/${a.id}/time`).send({ minutes: 90, date: day(0), note: 'Wireframes' }).expect(201);
    expect((await member.agent.post(`/api/tasks/${a.id}/time`).send({ minutes: 0 })).status).toBe(400);
    // People outside the project can't log time on its tasks.
    expect((await viewer.agent.post(`/api/tasks/${a.id}/time`).send({ minutes: 30 })).status).toBe(404);

    const summary = (await member.agent.get(`/api/tasks/${a.id}/time`)).body;
    expect(summary.total_minutes).toBeGreaterThanOrEqual(91);
    expect((await member.agent.get(`/api/tasks/${a.id}`)).body.time_minutes).toBe(summary.total_minutes);

    const week = (await member.agent.get('/api/time/me')).body;
    expect(week.days).toHaveLength(7);
    expect(week.total_minutes).toBeGreaterThanOrEqual(90);
    const byProject = (await owner.agent.get(`/api/projects/${project.id}/time`)).body;
    expect(byProject.by_person[0]).toMatchObject({ id: member.id });
    expect(byProject.by_task.map((t: { title: string }) => t.title)).toContain('Design');

    const entry = summary.entries.find((e: { note: string }) => e.note === 'Wireframes');
    expect((await viewer.agent.delete(`/api/time/${entry.id}`)).status).toBe(403);
    await member.agent.delete(`/api/time/${entry.id}`).expect(200);
  });
});

describe('goals', () => {
  it('measures progress from key results and linked projects, and keeps guests out', async () => {
    env = setup();
    const owner = await registerOwner(env);
    const member = await invite(env, owner.agent);
    const general = (await owner.agent.get('/api/channels')).body.find((c: { name: string }) => c.name === 'general');
    const guest = await invite(env, owner.agent, 'guest', { channelIds: [general.id], guestDays: 7 });
    const project = (await owner.agent.post('/api/projects').send({ name: 'Schools', memberIds: [member.id] })).body;
    const secret = (await owner.agent.post('/api/projects').send({ name: 'Secret', visibility: 'private' })).body;
    for (const [title, status] of [['A', 'done'], ['B', 'done'], ['C', 'todo'], ['D', 'todo']]) {
      const t = (await owner.agent.post('/api/tasks').send({ title, projectId: project.id })).body;
      if (status === 'done') await owner.agent.patch(`/api/tasks/${t.id}`).send({ status: 'done' });
    }

    const company = (await owner.agent.post('/api/goals').send({ title: 'Reach every county', ownerId: member.id, dueDate: day(90), projectIds: [project.id, secret.id] })).body;
    expect(company.progress).toBeCloseTo(0.25, 5); // average of 2/4 and 0/0
    const inbox = (await member.agent.get('/api/notifications')).body.notifications;
    expect(inbox.some((n: { link: string }) => n.link === `/goals/${company.id}`)).toBe(true);
    // Projects the viewer can't see stay hidden.
    expect((await member.agent.get(`/api/goals/${company.id}`)).body.projects.map((p: { id: string }) => p.id)).toEqual([project.id]);
    expect((await member.agent.post('/api/goals').send({ title: 'x', projectIds: [secret.id] })).status).toBe(403);

    let goal = (await member.agent.post(`/api/goals/${company.id}/key-results`).send({ title: 'Schools signed', startValue: 0, targetValue: 40, unit: 'schools' })).body;
    goal = (await member.agent.post(`/api/goals/${company.id}/key-results`).send({ title: 'Tasks', kind: 'tasks', projectId: project.id })).body;
    const [number, tasks] = goal.key_results;
    expect(tasks).toMatchObject({ current_value: 2, target_value: 4, progress: 0.5 });
    await member.agent.patch(`/api/key-results/${number.id}`).send({ currentValue: 30 }).expect(200);
    goal = (await member.agent.get(`/api/goals/${company.id}`)).body;
    expect(goal.progress).toBeCloseTo((0.75 + 0.5) / 2, 5);

    // Sub-goals nest, but never inside themselves.
    const team = (await member.agent.post('/api/goals').send({ title: 'Nimba schools', parentId: company.id })).body;
    expect((await member.agent.patch(`/api/goals/${company.id}`).send({ parentId: team.id })).status).toBe(400);
    const other = await invite(env, owner.agent);
    expect((await other.agent.patch(`/api/goals/${company.id}`).send({ title: 'Mine now' })).status).toBe(403);
    expect((await other.agent.patch(`/api/key-results/${number.id}`).send({ targetValue: 1 })).status).toBe(403);
    await member.agent.patch(`/api/goals/${company.id}`).send({ status: 'done' }).expect(200);
    expect((await member.agent.get(`/api/goals/${company.id}`)).body.progress).toBe(1);

    expect((await guest.agent.get('/api/goals')).status).toBe(403);
  });
});

describe('intake forms', () => {
  it('turns member and public responses into tasks', async () => {
    env = setup();
    const owner = await registerOwner(env);
    const lead = await invite(env, owner.agent, 'member', {}, 'Lena Lead');
    const member = await invite(env, owner.agent);
    const project = (await owner.agent.post('/api/projects').send({ name: 'IT help', memberIds: [lead.id] })).body;
    const urgency = (await owner.agent.post(`/api/projects/${project.id}/fields`).send({ name: 'Device', type: 'select', options: [{ label: 'Laptop' }, { label: 'Phone' }] })).body;
    const questions = [
      { id: 'what', label: 'What’s wrong?', type: 'short', required: true, maps: 'title' },
      { id: 'details', label: 'Details', type: 'long', maps: 'description' },
      { id: 'device', label: 'Device', type: 'select', options: ['Laptop', 'Phone'], maps: urgency.id },
      { id: 'when', label: 'Needed by', type: 'date', maps: 'due_date' },
      { id: 'email', label: 'Email', type: 'email' },
    ];
    expect((await member.agent.post(`/api/projects/${project.id}/forms`).send({ title: 'x', questions })).status).toBe(403);
    expect((await owner.agent.post(`/api/projects/${project.id}/forms`).send({ title: 'x', questions: [{ id: 'q', label: 'Q', type: 'short', maps: 'nope' }] })).status).toBe(400);
    const form = (await owner.agent.post(`/api/projects/${project.id}/forms`).send({ title: 'IT request', questions, ownerId: lead.id, public: true })).body;
    expect(form.public_url).toMatch(/^https:\/\/softex\.test\/f\//);

    // Members fill it in inside Küü.
    expect((await member.agent.post(`/api/forms/${form.id}/responses`).send({ answers: { details: 'no title' } })).status).toBe(400);
    const sent = await member.agent.post(`/api/forms/${form.id}/responses`).send({ answers: { what: 'Laptop won’t boot', device: 'Laptop', when: day(3), details: 'Since Monday' } });
    expect(sent.status).toBe(201);
    const task = (await lead.agent.get(`/api/tasks/${sent.body.taskId}`)).body;
    expect(task).toMatchObject({ title: 'Laptop won’t boot', due_date: day(3), owner: { id: lead.id } });
    expect(task.description).toContain('Since Monday');
    expect(task.fields[urgency.id]).toBe('Laptop');
    const inbox = (await lead.agent.get('/api/notifications')).body.notifications;
    expect(inbox.some((n: { title: string }) => n.title.includes('IT request'))).toBe(true);

    // Anyone with the link can respond, without seeing how answers map to tasks.
    const token = tokenOf(form.public_url);
    const anon = env.agent();
    const pub = (await anon.get(`/api/public/forms/${token}`)).body;
    expect(pub.title).toBe('IT request');
    expect(pub.questions[0].maps).toBeUndefined();
    expect((await anon.post(`/api/public/forms/${token}`).send({ answers: { what: 'Printer', email: 'not-an-email' } })).status).toBe(400);
    await anon.post(`/api/public/forms/${token}`).send({ answers: { what: 'Printer jammed' }, name: 'Visitor', email: 'visitor@example.com' }).expect(201);
    // Bots that fill the hidden field get a quiet success and create nothing.
    await anon.post(`/api/public/forms/${token}`).send({ answers: { what: 'Buy pills' }, website: 'http://spam.example' });
    const titles = (await lead.agent.get(`/api/tasks?projectId=${project.id}`)).body.map((t: { title: string }) => t.title);
    expect(titles).toContain('Printer jammed');
    expect(titles).not.toContain('Buy pills');
    expect((await owner.agent.get(`/api/forms/${form.id}`)).body.responses).toBe(2);

    // Closing, or rotating the link, stops old submissions.
    const rotated = (await owner.agent.patch(`/api/forms/${form.id}`).send({ newLink: true })).body;
    expect((await anon.get(`/api/public/forms/${token}`)).status).toBe(404);
    await owner.agent.patch(`/api/forms/${form.id}`).send({ closed: true }).expect(200);
    expect((await anon.post(`/api/public/forms/${tokenOf(rotated.public_url)}`).send({ answers: { what: 'Late' } })).status).toBe(410);
    expect((await member.agent.post(`/api/forms/${form.id}/responses`).send({ answers: { what: 'Late' } })).status).toBe(410);
  });
});

describe('knowledge pages', () => {
  it('nests pages, discusses them and publishes read-only links', async () => {
    env = setup();
    const owner = await registerOwner(env);
    const member = await invite(env, owner.agent, 'member', {}, 'Musu Member');
    const handbook = (await owner.agent.post('/api/pages').send({ title: 'Handbook', body: '# Welcome', icon: '📘' })).body;
    const leave = (await owner.agent.post('/api/pages').send({ title: 'Leave policy', parentId: handbook.id })).body;
    const sick = (await owner.agent.post('/api/pages').send({ title: 'Sick leave', parentId: leave.id })).body;

    const view = (await member.agent.get(`/api/pages/${sick.id}`)).body;
    expect(view.breadcrumbs.map((b: { title: string }) => b.title)).toEqual(['Handbook', 'Leave policy']);
    expect((await member.agent.get(`/api/pages/${handbook.id}`)).body.children).toEqual([{ id: leave.id, title: 'Leave policy', icon: null }]);
    // A page can't move under its own descendant.
    expect((await owner.agent.patch(`/api/pages/${handbook.id}`).send({ parentId: sick.id })).status).toBe(400);
    // Changing one setting leaves the rest of the page alone.
    await owner.agent.patch(`/api/pages/${handbook.id}`).send({ status: 'approved' }).expect(200);
    expect((await owner.agent.get(`/api/pages/${handbook.id}`)).body).toMatchObject({ status: 'approved', body: '# Welcome', icon: '📘', version: 1 });

    // Comments notify the owner and anyone mentioned.
    await member.agent.post(`/api/pages/${handbook.id}/comments`).send({ body: 'Is this current?' }).expect(201);
    const reply = await owner.agent.post(`/api/pages/${handbook.id}/comments`).send({ body: `@[Musu Member](${member.id}) yes, updated last week` });
    expect(reply.status).toBe(201);
    expect((await owner.agent.get('/api/notifications')).body.notifications.some((n: { title: string }) => n.title.includes('commented on “Handbook”'))).toBe(true);
    expect((await member.agent.get('/api/notifications')).body.notifications.some((n: { title: string }) => n.title.includes('mentioned you on “Handbook”'))).toBe(true);
    const comments = (await member.agent.get(`/api/pages/${handbook.id}/comments`)).body;
    expect(comments).toHaveLength(2);
    await owner.agent.patch(`/api/page-comments/${comments[0].id}`).send({ resolved: true }).expect(200);
    expect((await owner.agent.delete(`/api/page-comments/${comments[0].id}`)).status).toBe(200); // admins may remove
    expect((await member.agent.delete(`/api/page-comments/${comments[1].id}`)).status).toBe(403);

    // Publishing gives a read-only link without comments or history.
    expect((await env.agent().get('/api/public/pages/nope')).status).toBe(404);
    const published = (await owner.agent.post(`/api/pages/${handbook.id}/publish`).send({ public: true })).body;
    expect(published.public_url).toMatch(/^https:\/\/softex\.test\/p\//);
    const token = tokenOf(published.public_url);
    const pub = await env.agent().get(`/api/public/pages/${token}`);
    expect(pub.status).toBe(200);
    expect(pub.headers['x-robots-tag']).toBe('noindex');
    expect(pub.body).toMatchObject({ title: 'Handbook', body: '# Welcome', icon: '📘' });
    expect(Object.keys(pub.body).sort()).toEqual(['body', 'icon', 'title', 'updated_at', 'workspace_name']);
    await owner.agent.post(`/api/pages/${handbook.id}/publish`).send({ public: false }).expect(200);
    expect((await env.agent().get(`/api/public/pages/${token}`)).status).toBe(404);
  });

  it('keeps favorites personal and drops ones you lose access to', async () => {
    env = setup();
    const owner = await registerOwner(env);
    const member = await invite(env, owner.agent);
    const project = (await owner.agent.post('/api/projects').send({ name: 'Private', visibility: 'private', memberIds: [member.id] })).body;
    const page = (await owner.agent.post('/api/pages').send({ title: 'Wiki' })).body;
    await member.agent.put('/api/favorites').send({ kind: 'project', id: project.id, on: true }).expect(200);
    await member.agent.put('/api/favorites').send({ kind: 'page', id: page.id, on: true }).expect(200);
    expect((await member.agent.put('/api/favorites').send({ kind: 'page', id: 'missing', on: true })).status).toBe(404);
    expect((await member.agent.get('/api/favorites')).body.map((f: { title: string }) => f.title)).toEqual(['Private', 'Wiki']);
    expect((await owner.agent.get('/api/favorites')).body).toEqual([]);

    await owner.agent.delete(`/api/projects/${project.id}/members/${member.id}`);
    const after = (await member.agent.get('/api/favorites')).body.map((f: { title: string }) => f.title);
    expect(after).not.toContain('Private');
    await member.agent.put('/api/favorites').send({ kind: 'page', id: page.id, on: false }).expect(200);
    expect((await member.agent.get('/api/favorites')).body.map((f: { title: string }) => f.title)).not.toContain('Wiki');
  });
});

describe('chat additions', () => {
  it('runs polls, forwards messages and notifies @channel', async () => {
    env = setup();
    const owner = await registerOwner(env, 'Olu Owner');
    const a = await invite(env, owner.agent);
    const b = await invite(env, owner.agent);
    const general = (await owner.agent.get('/api/channels')).body.find((c: { name: string }) => c.name === 'general');
    const team = (await owner.agent.post('/api/channels').send({ name: 'team', kind: 'private', memberIds: [a.id] })).body;

    expect((await owner.agent.post(`/api/channels/${general.id}/polls`).send({ question: 'Lunch?', options: ['Rice'] })).status).toBe(400);
    expect((await owner.agent.post(`/api/channels/${general.id}/polls`).send({ question: 'Lunch?', options: ['Rice', 'rice'] })).status).toBe(400);
    const msg = (await owner.agent.post(`/api/channels/${general.id}/polls`).send({ question: 'Retreat venue?', options: ['Robertsport', 'Kpatawee', 'Monrovia'] })).body;
    expect(msg.poll).toMatchObject({ question: 'Retreat venue?', multiple: false, voters: 0 });

    let poll = (await a.agent.post(`/api/polls/${msg.poll.id}/vote`).send({ options: [0] })).body;
    expect(poll.options[0]).toMatchObject({ votes: 1, voters: [expect.any(String)] });
    expect((await a.agent.post(`/api/polls/${msg.poll.id}/vote`).send({ options: [0, 1] })).status).toBe(400);
    expect((await a.agent.post(`/api/polls/${msg.poll.id}/vote`).send({ options: [7] })).status).toBe(400);
    poll = (await a.agent.post(`/api/polls/${msg.poll.id}/vote`).send({ options: [1] })).body; // changing a vote replaces it
    expect(poll.options.map((o: { votes: number }) => o.votes)).toEqual([0, 1, 0]);
    expect(poll.my_votes).toEqual([1]);
    expect((await b.agent.post(`/api/polls/${msg.poll.id}/close`)).status).toBe(403);
    await owner.agent.post(`/api/polls/${msg.poll.id}/close`).expect(200);
    expect((await b.agent.post(`/api/polls/${msg.poll.id}/vote`).send({ options: [0] })).status).toBe(400);
    // People outside a private channel can't see or vote in its polls.
    const secretPoll = (await owner.agent.post(`/api/channels/${team.id}/polls`).send({ question: 'Hidden?', options: ['Yes', 'No'] })).body;
    expect((await b.agent.post(`/api/polls/${secretPoll.poll.id}/vote`).send({ options: [0] })).status).toBe(404);

    // Forwarding shares the text, credits the author and needs access to both ends.
    const original = (await a.agent.post(`/api/channels/${team.id}/messages`).send({ body: 'Budget approved' })).body;
    expect((await b.agent.post(`/api/messages/${original.id}/forward`).send({ channelId: general.id })).status).toBe(404);
    const fwd = (await a.agent.post(`/api/messages/${original.id}/forward`).send({ channelId: general.id, comment: 'FYI all' })).body;
    expect(fwd).toMatchObject({ body: 'FYI all', forwarded: { id: original.id, body: 'Budget approved', channel_name: 'team', deleted: false } });
    const again = (await owner.agent.post(`/api/messages/${fwd.id}/forward`).send({ channelId: general.id })).body;
    expect(again.forwarded.id).toBe(original.id);
    await a.agent.delete(`/api/messages/${original.id}`).expect(200);
    const seen = (await b.agent.get(`/api/channels/${general.id}/messages`)).body.messages.find((m: { id: string }) => m.id === fwd.id);
    expect(seen.forwarded).toMatchObject({ deleted: true });
    expect(seen.forwarded.body).toBeUndefined();

    // @channel reaches every member; a word like "email@channel" does not.
    await owner.agent.post(`/api/channels/${general.id}/messages`).send({ body: 'write to me at olu@channel.lr' });
    let bInbox = (await b.agent.get('/api/notifications')).body.notifications;
    expect(bInbox.some((n: { title: string }) => n.title.includes('@channel'))).toBe(false);
    await owner.agent.post(`/api/channels/${general.id}/messages`).send({ body: '@channel staff meeting at 3' });
    bInbox = (await b.agent.get('/api/notifications')).body.notifications;
    expect(bInbox.some((n: { title: string }) => n.title === 'Olu Owner notified @channel in #general')).toBe(true);
  });
});
