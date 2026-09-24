import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { invite, registerOwner, setup, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeEach(() => (env = setup()));
afterEach(() => env.cleanup());

const mention = (name: string, id: string) => `@[${name}](${id})`;

describe('private content never leaks through derived surfaces', () => {
  it('hides private channels from non-members in lists, reads, search, activity and export', async () => {
    const owner = await registerOwner(env);
    const outsider = await invite(env, owner.agent);
    const channel = (await owner.agent.post('/api/channels').send({ name: 'leadership', kind: 'private' })).body;
    await owner.agent.post(`/api/channels/${channel.id}/messages`).send({ body: 'Confidential salary review plan' });

    const list = await outsider.agent.get('/api/channels');
    expect(list.body.find((c: { id: string }) => c.id === channel.id)).toBeUndefined();
    expect((await outsider.agent.get(`/api/channels/${channel.id}/messages`)).status).toBe(404);
    expect((await outsider.agent.post(`/api/channels/${channel.id}/join`)).status).toBe(404);
    const search = await outsider.agent.get('/api/search').query({ q: 'salary' });
    expect(search.body.messages).toHaveLength(0);
    const activity = await outsider.agent.get('/api/activity');
    expect(activity.body.some((a: { channel_id: string }) => a.channel_id === channel.id)).toBe(false);
    const exported = await outsider.agent.get('/api/export');
    expect(JSON.stringify(exported.body)).not.toContain('salary');

    const ownerSearch = await owner.agent.get('/api/search').query({ q: 'salary' });
    expect(ownerSearch.body.messages).toHaveLength(1);
  });

  it('does not notify people who are mentioned in a channel they cannot see', async () => {
    const owner = await registerOwner(env);
    const outsider = await invite(env, owner.agent, 'member', {}, 'Olive');
    const channel = (await owner.agent.post('/api/channels').send({ name: 'secret', kind: 'private' })).body;
    await owner.agent.post(`/api/channels/${channel.id}/messages`).send({ body: `hey ${mention('Olive', outsider.id)}` });
    const inbox = await outsider.agent.get('/api/notifications');
    expect(inbox.body.notifications).toHaveLength(0);
  });

  it('protects private projects, their tasks, pages and files', async () => {
    const owner = await registerOwner(env);
    const member = await invite(env, owner.agent);
    const project = (await owner.agent.post('/api/projects').send({ name: 'Acquisition', visibility: 'private' })).body;
    const task = (await owner.agent.post('/api/tasks').send({ title: 'Due diligence checklist', projectId: project.id })).body;
    const page = (await owner.agent.post('/api/pages').send({ title: 'Deal memo', body: 'target valuation', projectId: project.id })).body;

    expect((await member.agent.get(`/api/projects/${project.id}`)).status).toBe(404);
    expect((await member.agent.get(`/api/tasks/${task.id}`)).status).toBe(404);
    expect((await member.agent.get(`/api/pages/${page.id}`)).status).toBe(404);
    expect((await member.agent.get('/api/projects')).body).toHaveLength(0);
    const search = await member.agent.get('/api/search').query({ q: 'diligence' });
    expect(search.body.tasks).toHaveLength(0);
    expect((await member.agent.get('/api/search').query({ q: 'valuation' })).body.pages).toHaveLength(0);
    expect((await member.agent.post('/api/tasks').send({ title: 'sneaky', projectId: project.id })).status).toBe(404);
    // Cannot assign a private-project task to someone outside the project.
    const assign = await owner.agent.patch(`/api/tasks/${task.id}`).send({ ownerId: member.id });
    expect(assign.status).toBe(400);

    await owner.agent.post(`/api/projects/${project.id}/members`).send({ userIds: [member.id] });
    expect((await member.agent.get(`/api/tasks/${task.id}`)).status).toBe(200);
  });

  it('limits guests to explicitly shared spaces and enforces their expiry', async () => {
    const owner = await registerOwner(env);
    const channels = (await owner.agent.get('/api/channels')).body;
    const general = channels.find((c: { name: string }) => c.name === 'general');
    const shared = (await owner.agent.post('/api/channels').send({ name: 'client-x', kind: 'private' })).body;
    const guest = await invite(env, owner.agent, 'guest', { channelIds: [shared.id], guestDays: 7 });

    const visible = (await guest.agent.get('/api/channels')).body.map((c: { id: string }) => c.id);
    expect(visible).toEqual([shared.id]);
    expect((await guest.agent.get(`/api/channels/${general.id}/messages`)).status).toBe(404);
    expect((await guest.agent.post('/api/projects').send({ name: 'Nope' })).status).toBe(403);
    expect((await guest.agent.post('/api/channels').send({ name: 'nope' })).status).toBe(403);
    const people = (await guest.agent.get('/api/people')).body;
    expect(people.length).toBe(2);
    expect(guest.me.guest_expires_at).toBeTruthy();

    await owner.agent.patch(`/api/admin/members/${guest.id}`).send({ guestExpiresAt: new Date(Date.now() - 1000).toISOString() });
    expect((await guest.agent.get('/api/me')).status).toBe(401);
  });

  it('isolates workspaces from each other', async () => {
    const a = await registerOwner(env, 'Alpha');
    const b = await registerOwner(env, 'Beta');
    const channelA = (await a.agent.get('/api/channels')).body[0];
    const projectA = (await a.agent.post('/api/projects').send({ name: 'Alpha plan' })).body;
    const taskA = (await a.agent.post('/api/tasks').send({ title: 'Alpha task', projectId: projectA.id })).body;
    expect((await b.agent.get(`/api/channels/${channelA.id}/messages`)).status).toBe(404);
    expect((await b.agent.post(`/api/channels/${channelA.id}/messages`).send({ body: 'hi' })).status).toBe(404);
    expect((await b.agent.get(`/api/projects/${projectA.id}`)).status).toBe(404);
    expect((await b.agent.get(`/api/tasks/${taskA.id}`)).status).toBe(404);
    expect((await b.agent.get('/api/search').query({ q: 'Alpha' })).body.projects).toHaveLength(0);
    expect((await b.agent.post('/api/dms').send({ userIds: [a.me.user.id] })).status).toBe(404);
  });

  it('restricts announcement posting and tracks acknowledgements', async () => {
    const owner = await registerOwner(env);
    const member = await invite(env, owner.agent);
    const ann = (await owner.agent.get('/api/channels')).body.find((c: { name: string }) => c.name === 'announcements');
    expect((await member.agent.post(`/api/channels/${ann.id}/messages`).send({ body: 'hello all' })).status).toBe(403);
    const post = (await owner.agent.post(`/api/channels/${ann.id}/messages`).send({ body: 'Office closed Friday' })).body;
    const inbox = (await member.agent.get('/api/notifications')).body.notifications;
    expect(inbox.some((n: { kind: string }) => n.kind === 'announcement')).toBe(true);
    await member.agent.post(`/api/messages/${post.id}/ack`);
    const acks = (await owner.agent.get(`/api/messages/${post.id}/acks`)).body;
    expect(acks.find((a: { id: string }) => a.id === member.id).acked_at).toBeTruthy();
  });

  it('applies the workspace message edit policy', async () => {
    const owner = await registerOwner(env);
    const member = await invite(env, owner.agent);
    const general = (await member.agent.get('/api/channels')).body.find((c: { name: string }) => c.name === 'general');
    const msg = (await member.agent.post(`/api/channels/${general.id}/messages`).send({ body: 'tpyo' })).body;
    expect((await member.agent.patch(`/api/messages/${msg.id}`).send({ body: 'typo' })).status).toBe(200);
    expect((await owner.agent.patch(`/api/messages/${msg.id}`).send({ body: 'hijack' })).status).toBe(403);
    await owner.agent.patch('/api/admin/workspace').send({ messageEditPolicy: 'none' });
    expect((await member.agent.patch(`/api/messages/${msg.id}`).send({ body: 'again' })).status).toBe(403);
    expect((await owner.agent.delete(`/api/messages/${msg.id}`)).status).toBe(200);
    const list = (await member.agent.get(`/api/channels/${general.id}/messages`)).body.messages;
    expect(list.find((m: { id: string }) => m.id === msg.id).deleted).toBe(true);
  });
});
