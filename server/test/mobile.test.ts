import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { pushIdle, type MobilePushMessage } from '../src/push.js';
import { flushJobs, invite, registerOwner, setup, type TestEnv } from './helpers.js';

let env: TestEnv;
afterEach(async () => env?.cleanup());

const expoToken = (n: number) => `ExponentPushToken[device-token-${n}xxxxxx]`;

describe('phone app', () => {
  it('gets a session token on sign-in and uses it as a Bearer token', async () => {
    env = setup();
    const owner = await registerOwner(env);
    // A browser never sees the token outside its cookie.
    const web = await env.agent().post('/api/auth/login').send({ email: owner.email, password: 'password123' });
    expect(web.headers['x-kuu-session']).toBeUndefined();

    const login = await request(env.softex.app).post('/api/auth/login').set('x-kuu-client', 'mobile').send({ email: owner.email, password: 'password123' });
    expect(login.status).toBe(200);
    const token = login.headers['x-kuu-session'];
    expect(token).toMatch(/^[A-Za-z0-9_-]{20,}$/);

    const me = await request(env.softex.app).get('/api/me').set('Authorization', `Bearer ${token}`);
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe(owner.email);

    // Signing out with the token ends that session.
    expect((await request(env.softex.app).post('/api/auth/logout').set('Authorization', `Bearer ${token}`)).status).toBe(200);
    expect((await request(env.softex.app).get('/api/me').set('Authorization', `Bearer ${token}`)).status).toBe(401);
  });

  it('delivers notifications to registered phones and forgets uninstalled apps', async () => {
    const sent: MobilePushMessage[] = [];
    let error: string | undefined;
    env = setup({
      mobilePush: { send: async (messages) => (sent.push(...messages), messages.map(() => (error ? { status: 'error' as const, details: { error } } : { status: 'ok' as const }))) },
    });
    const owner = await registerOwner(env);
    const member = await invite(env, owner.agent, 'member', {}, 'Maya');
    const login = await request(env.softex.app).post('/api/auth/login').set('x-kuu-client', 'mobile').send({ email: member.email, password: 'password123' });
    const bearer = { Authorization: `Bearer ${login.headers['x-kuu-session']}` };

    expect((await request(env.softex.app).get('/api/push/config').set(bearer)).body.mobile).toBe(true);
    for (const bad of ['not-a-token', 'ExponentPushToken[]', 'https://fcm.googleapis.com/x']) {
      expect((await request(env.softex.app).post('/api/me/mobile-push').set(bearer).send({ token: bad, platform: 'ios' })).status).toBe(400);
    }
    expect((await request(env.softex.app).post('/api/me/mobile-push').set(bearer).send({ token: expoToken(1), platform: 'android' })).status).toBe(201);
    // Registering again is harmless.
    expect((await request(env.softex.app).post('/api/me/mobile-push').set(bearer).send({ token: expoToken(1), platform: 'android' })).status).toBe(201);
    expect(await env.softex.ctx.db.all('SELECT * FROM mobile_push_tokens')).toHaveLength(1);

    const general = (await owner.agent.get('/api/channels')).body.find((c: { name: string }) => c.name === 'general');
    await owner.agent.post(`/api/channels/${general.id}/messages`).send({ body: `Can you check this @[Maya](${member.id})?` });
    await pushIdle();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: expoToken(1), sound: 'default' });
    expect(sent[0].body).toContain('@Maya');
    expect(sent[0].data.url).toMatch(/^\//);

    // The test button counts phones too.
    sent.length = 0;
    expect((await request(env.softex.app).post('/api/me/push/test').set(bearer)).status).toBe(200);
    expect(sent).toHaveLength(1);

    // If Expo refuses, the test button says so instead of claiming success.
    error = 'MessageRateExceeded';
    expect((await request(env.softex.app).post('/api/me/push/test').set(bearer)).status).toBe(400);

    // Expo reports the app was uninstalled: the token is dropped.
    error = 'DeviceNotRegistered';
    await request(env.softex.app).post('/api/me/push/test').set(bearer);
    await pushIdle();
    expect(await env.softex.ctx.db.get('SELECT 1 FROM mobile_push_tokens')).toBeUndefined();
    error = undefined;

    // Unregistering, and signing out, both stop alerts.
    await request(env.softex.app).post('/api/me/mobile-push').set(bearer).send({ token: expoToken(2), platform: 'ios' });
    expect((await request(env.softex.app).delete('/api/me/mobile-push').set(bearer).send({ token: expoToken(2) })).status).toBe(200);
    expect(await env.softex.ctx.db.get('SELECT 1 FROM mobile_push_tokens')).toBeUndefined();
    await request(env.softex.app).post('/api/me/mobile-push').set(bearer).send({ token: expoToken(3), platform: 'ios' });
    await request(env.softex.app).post('/api/auth/logout').set(bearer);
    await flushJobs(env);
    sent.length = 0;
    await owner.agent.post(`/api/channels/${general.id}/messages`).send({ body: `Still there @[Maya](${member.id})?` });
    await pushIdle();
    expect(sent).toHaveLength(0);
  });

  it('refuses phone registration when phone push is off', async () => {
    env = setup();
    const owner = await registerOwner(env);
    expect((await owner.agent.get('/api/push/config')).body.mobile).toBe(false);
    expect((await owner.agent.post('/api/me/mobile-push').send({ token: expoToken(1), platform: 'ios' })).status).not.toBe(201);
  });
});
