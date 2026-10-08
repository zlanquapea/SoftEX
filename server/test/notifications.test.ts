import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { pushIdle, type PushSubscriptionInput } from '../src/push.js';
import { invite, registerOwner, setup, type TestEnv } from './helpers.js';

let env: TestEnv;
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) s.close();
  await env?.cleanup();
});

const unread = async (agent: ReturnType<TestEnv['agent']>) => (await agent.get('/api/notifications?filter=unread')).body;

/** Sign in again to get a session cookie for a WebSocket, then open one that reports what it is viewing. */
async function openWindow(email: string) {
  const login = await request(env.softex.app).post('/api/auth/login').send({ email, password: 'password123' });
  const cookie = String(login.headers['set-cookie']?.[0] ?? '').split(';')[0];
  await new Promise<void>((r) => (env.softex.server.listening ? r() : env.softex.server.listen(0, '127.0.0.1', () => r())));
  const port = (env.softex.server.address() as AddressInfo).port;
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie } });
  sockets.push(socket);
  await new Promise((r) => socket.once('message', r));
  return {
    view: async (keys: string[], active = true) => {
      socket.send(JSON.stringify({ type: 'viewing', keys, active }));
      // Let the server handle the frame.
      await new Promise((r) => setTimeout(r, 50));
    },
  };
}

describe('notifications', () => {
  it('groups unread updates about one chat into one row with a count, and reading the chat reads them', async () => {
    env = setup();
    const owner = await registerOwner(env, 'Ada');
    const member = await invite(env, owner.agent, 'member', {}, 'Bo');
    const dm = (await owner.agent.post('/api/dms').send({ userIds: [member.id] })).body;
    for (const body of ['one', 'two', 'three']) await owner.agent.post(`/api/channels/${dm.id}/messages`).send({ body });
    const task = (await owner.agent.post('/api/tasks').send({ title: 'Ship it', ownerId: member.id })).body;

    const before = await unread(member.agent);
    // Three messages in one chat and one assignment: two rows, counted as two in the badge.
    expect(before.unread).toBe(2);
    const chatRow = before.notifications.find((n: { group_key: string }) => n.group_key === `/channels/${dm.id}`);
    expect(chatRow.group_count).toBe(3);
    expect(chatRow.title).toMatch(/New message from Ada/);
    expect(before.notifications.find((n: { group_key: string }) => n.group_key === `/tasks/${task.id}`).group_count).toBe(1);

    // Reading the chat marks what you were notified about in it as read.
    await member.agent.post(`/api/channels/${dm.id}/read`).expect(200);
    const after = await unread(member.agent);
    expect(after.unread).toBe(1);
    expect(after.notifications.map((n: { group_key: string }) => n.group_key)).toEqual([`/tasks/${task.id}`]);

    // Reading a grouped row reads its whole group; opening the task reads the task's group.
    await owner.agent.post(`/api/channels/${dm.id}/messages`).send({ body: 'four' });
    await owner.agent.post(`/api/channels/${dm.id}/messages`).send({ body: 'five' });
    const row = (await unread(member.agent)).notifications.find((n: { group_key: string }) => n.group_key === `/channels/${dm.id}`);
    expect(row.group_count).toBe(2);
    await member.agent.post(`/api/notifications/${row.id}/read`).send({ read: true }).expect(200);
    await member.agent.post('/api/notifications/read-group').send({ group: `/tasks/${task.id}?tab=comments` }).expect(200);
    expect((await unread(member.agent)).unread).toBe(0);

    // Replying in a chat also counts as having read it.
    await member.agent.post(`/api/channels/${dm.id}/messages`).send({ body: 'thanks' });
    await owner.agent.post(`/api/channels/${dm.id}/messages`).send({ body: 'six' });
    expect((await unread(member.agent)).unread).toBe(1);
    await member.agent.post(`/api/channels/${dm.id}/messages`).send({ body: 'got it' });
    expect((await unread(member.agent)).unread).toBe(0);
  });

  it('does not notify about a chat or thread the person has on screen', async () => {
    env = setup();
    const owner = await registerOwner(env, 'Ada');
    const member = await invite(env, owner.agent, 'member', {}, 'Bo');
    const dm = (await owner.agent.post('/api/dms').send({ userIds: [member.id] })).body;
    const window = await openWindow(member.email);

    // Looking at the DM: no notification for a new message in it.
    await window.view([`/channels/${dm.id}`]);
    await owner.agent.post(`/api/channels/${dm.id}/messages`).send({ body: 'are you there?' });
    expect((await unread(member.agent)).unread).toBe(0);

    // Looking elsewhere: notified as usual.
    await window.view(['/channels/somewhere-else']);
    await owner.agent.post(`/api/channels/${dm.id}/messages`).send({ body: 'hello?' });
    expect((await unread(member.agent)).unread).toBe(1);
    await member.agent.post(`/api/channels/${dm.id}/read`);

    // A thread reply isn't on screen just because its channel is: only an open thread counts.
    const general = (await member.agent.get('/api/channels')).body.find((c: { name: string }) => c.name === 'general');
    const root = (await member.agent.post(`/api/channels/${general.id}/messages`).send({ body: 'Plan for Friday?' })).body;
    await window.view([`/channels/${general.id}`]);
    await owner.agent.post(`/api/channels/${general.id}/messages`).send({ body: 'Lunch at noon', parentId: root.id });
    expect((await unread(member.agent)).notifications[0].kind).toBe('thread');
    await member.agent.post(`/api/channels/${general.id}/read`);
    await window.view([`/channels/${general.id}`, `/channels/${general.id}?thread=${root.id}`]);
    await owner.agent.post(`/api/channels/${general.id}/messages`).send({ body: 'Booked', parentId: root.id });
    expect((await unread(member.agent)).unread).toBe(0);
  });

  it('pushes to devices unless a Küü window is in front, and says when the push service refuses', async () => {
    const sent: string[] = [];
    let status = 201;
    env = setup({ push: { send: async (sub: PushSubscriptionInput) => (sent.push(sub.endpoint), status) } });
    const owner = await registerOwner(env, 'Ada');
    const member = await invite(env, owner.agent, 'member', {}, 'Bo');
    const keys = { p256dh: randomBytes(65).toString('base64url'), auth: randomBytes(16).toString('base64url') };
    await member.agent.post('/api/me/push').send({ endpoint: 'https://fcm.googleapis.com/fcm/send/phone', keys }).expect(201);
    const dm = (await owner.agent.post('/api/dms').send({ userIds: [member.id] })).body;
    const window = await openWindow(member.email);

    // Using Küü right now (in another chat): the alert shows in the app, not as a push.
    await window.view(['/channels/elsewhere'], true);
    await owner.agent.post(`/api/channels/${dm.id}/messages`).send({ body: 'one' });
    await pushIdle();
    expect(sent).toHaveLength(0);

    // Küü left open in a background tab: the phone still gets the push.
    await window.view([], false);
    await owner.agent.post(`/api/channels/${dm.id}/messages`).send({ body: 'two' });
    await pushIdle();
    expect(sent).toEqual(['https://fcm.googleapis.com/fcm/send/phone']);

    // "Send a test" tells the person when the push service refused, instead of claiming success.
    status = 403;
    const test = await member.agent.post('/api/me/push/test');
    expect(test.status).toBe(400);
    expect(test.body.error).toMatch(/refused the server’s keys/);
  });
});
