import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { invite, registerOwner, setup, type TestEnv } from './helpers.js';
import { pushIdle, type PushSubscriptionInput } from '../src/push.js';

let env: TestEnv;
afterEach(() => env?.cleanup());

describe('signed-in devices', () => {
  it('lists sessions and signs out one or all other devices', async () => {
    env = setup();
    const { agent, email } = await registerOwner(env);
    const signIn = async (ua: string) => {
      const a = env.agent();
      expect((await a.post('/api/auth/login').set('User-Agent', ua).send({ email, password: 'password123' })).status).toBe(200);
      return a;
    };
    const phone = await signIn('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/128.0 Mobile Safari/537.36');
    const laptop = await signIn('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Gecko/20100101 Firefox/130.0');

    const list = (await phone.get('/api/me/sessions')).body;
    expect(list).toHaveLength(3);
    expect(list.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
    expect(list.find((s: { current: boolean }) => s.current).device).toBe('Chrome on Android');
    expect(list.map((s: { device: string }) => s.device)).toContain('Firefox on Windows');
    // Nothing secret is exposed.
    expect(JSON.stringify(list)).not.toMatch(/token/);

    // Sign out the laptop from the phone.
    const laptopId = list.find((s: { device: string }) => s.device === 'Firefox on Windows').id;
    expect((await phone.delete(`/api/me/sessions/${laptopId}`)).status).toBe(200);
    expect((await laptop.get('/api/me')).status).toBe(401);

    // Other people's sessions can't be touched.
    const stranger = await registerOwner(env, 'Stranger');
    const phoneId = list.find((s: { current: boolean }) => s.current).id;
    expect((await stranger.agent.delete(`/api/me/sessions/${phoneId}`)).status).toBe(404);

    // Sign out everywhere else: the original browser loses access, the phone keeps it.
    const res = await phone.post('/api/me/sessions/revoke-others');
    expect(res.body.ended).toBe(1);
    expect((await agent.get('/api/me')).status).toBe(401);
    expect((await phone.get('/api/me')).status).toBe(200);
    expect((await phone.get('/api/me/sessions')).body).toHaveLength(1);
  });
});

describe('calendar subscription', () => {
  it('serves the person’s meetings at a private link until it is reset or they leave', async () => {
    env = setup();
    const owner = await registerOwner(env);
    const member = await invite(env, owner.agent);
    const outsider = await invite(env, owner.agent);
    const inAnHour = new Date(Date.now() + 3600_000).toISOString();
    await owner.agent.post('/api/meetings').send({ title: 'Planning, week 40; room “A”', startsAt: inAnHour, participantIds: [member.id], agenda: 'x'.repeat(200) });
    await owner.agent.post('/api/meetings').send({ title: 'Owner only', startsAt: inAnHour, participantIds: [] });

    expect((await member.agent.get('/api/me/calendar-feed')).body.enabled).toBe(false);
    const created = (await member.agent.post('/api/me/calendar-feed')).body;
    expect(created.url).toMatch(/^https:\/\/softex\.test\/api\/calendar\/.+\.ics$/);
    expect(created.webcal).toMatch(/^webcal:\/\//);
    const path = new URL(created.url).pathname;

    const feed = await request(env.softex.app).get(path);
    expect(feed.status).toBe(200);
    expect(feed.headers['content-type']).toMatch(/text\/calendar/);
    expect(feed.text).toContain('SUMMARY:Planning\\, week 40\\; room “A”');
    expect(feed.text).not.toContain('Owner only');
    // Long lines are folded to 75 octets.
    expect(feed.text.split('\r\n').every((l: string) => Buffer.byteLength(l) <= 75)).toBe(true);
    expect((await member.agent.get('/api/me/calendar-feed')).body.last_used_at).toBeTruthy();

    // Meetings they aren't part of never appear.
    await outsider.agent.post('/api/me/calendar-feed');
    // Resetting the link retires the old one.
    const again = (await member.agent.post('/api/me/calendar-feed')).body;
    expect((await request(env.softex.app).get(path)).status).toBe(404);
    const path2 = new URL(again.url).pathname;
    expect((await request(env.softex.app).get(path2)).status).toBe(200);

    // Deactivated members' links stop working.
    await owner.agent.patch(`/api/admin/members/${member.id}`).send({ deactivated: true });
    expect((await request(env.softex.app).get(path2)).status).toBe(404);
    expect((await request(env.softex.app).get('/api/calendar/not-a-real-token.ics')).status).toBe(404);
  });
});

describe('push notifications', () => {
  const endpoint = (n: number) => `https://fcm.googleapis.com/fcm/send/device-${n}`;
  const keys = { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' };

  it('reaches signed-in devices when the person is away, and stops when they sign out', async () => {
    const sent: { endpoint: string; payload: any }[] = [];
    let status = 201;
    env = setup({ push: { send: async (sub: PushSubscriptionInput, payload: string) => (sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) }), status) } });
    const owner = await registerOwner(env);
    const member = await invite(env, owner.agent, 'member', {}, 'Maya');

    const config = (await member.agent.get('/api/push/config')).body;
    expect(config.enabled).toBe(true);
    expect(config.publicKey).toMatch(/^[A-Za-z0-9_-]{80,}$/);
    // The key pair is generated once and shared; the private half is stored encrypted.
    expect((await owner.agent.get('/api/push/config')).body.publicKey).toBe(config.publicKey);
    const stored = await env.softex.ctx.db.get("SELECT value FROM server_settings WHERE key = 'vapid'");
    expect(JSON.parse(stored!.value).encrypted).toBe(true);

    // Only real push services are accepted.
    for (const bad of ['http://fcm.googleapis.com/x', 'https://127.0.0.1/x', 'https://evil.example/x', 'https://fcm.googleapis.com:8443/x']) {
      expect((await member.agent.post('/api/me/push').send({ endpoint: bad, keys })).status).toBe(400);
    }
    expect((await member.agent.post('/api/me/push').send({ endpoint: endpoint(1), keys })).status).toBe(201);

    const dm = (await owner.agent.post('/api/dms').send({ userIds: [member.id] })).body;
    const general = (await owner.agent.get('/api/channels')).body.find((c: { name: string }) => c.name === 'general');
    await owner.agent.post(`/api/channels/${general.id}/messages`).send({ body: `Can you check this @[Maya](${member.id})?` });
    await pushIdle();
    expect(sent).toHaveLength(1);
    expect(sent[0].endpoint).toBe(endpoint(1));
    expect(sent[0].payload.body).toContain('@Maya');
    expect(sent[0].payload.body).not.toContain('](');
    expect(sent[0].payload.url).toMatch(/^\//);

    // Focus time holds back ordinary alerts, but urgent messages still get through.
    await member.agent.patch('/api/me').send({ status: 'focus', focus_until: new Date(Date.now() + 3600_000).toISOString() });
    sent.length = 0;
    await owner.agent.post(`/api/channels/${dm.id}/messages`).send({ body: 'fyi' });
    await owner.agent.post(`/api/channels/${dm.id}/messages`).send({ body: 'Server is down', urgent: true });
    await pushIdle();
    expect(sent.map((s) => s.payload.body)).toEqual([expect.stringContaining('Server is down')]);

    // A test notification can be sent on demand.
    sent.length = 0;
    expect((await member.agent.post('/api/me/push/test')).status).toBe(200);
    expect(sent).toHaveLength(1);

    // Devices the push service has forgotten are removed.
    status = 410;
    await member.agent.post('/api/me/push/test');
    expect(await env.softex.ctx.db.get('SELECT 1 FROM push_subscriptions')).toBeUndefined();
    status = 201;

    // Signing out stops alerts to that device.
    await member.agent.post('/api/me/push').send({ endpoint: endpoint(2), keys });
    await member.agent.post('/api/auth/logout');
    sent.length = 0;
    await owner.agent.post(`/api/channels/${dm.id}/messages`).send({ body: 'Still there?', urgent: true });
    await pushIdle();
    expect(sent).toHaveLength(0);
  });

  it('can be turned off on a server', async () => {
    env = setup({ push: false });
    const owner = await registerOwner(env);
    expect((await owner.agent.get('/api/push/config')).body).toEqual({ enabled: false });
    expect((await owner.agent.post('/api/me/push').send({ endpoint: endpoint(1), keys })).status).toBe(404);
  });
});
