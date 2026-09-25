import { afterEach, describe, expect, it } from 'vitest';
import { invite, registerOwner, setup, type TestEnv } from './helpers.js';

let env: TestEnv;
afterEach(() => env?.cleanup());

const signUp = (e: TestEnv, n: number) =>
  e.agent().post('/api/auth/register').send({ name: `Person ${n}`, email: `signup${n}@example.com`, password: 'password123', workspaceName: `Company ${n}` });

describe('workspace sign-up policy', () => {
  it('"first" lets only the first person create a workspace; invitations still work', async () => {
    env = setup({ registration: 'first' });
    const owner = await registerOwner(env);
    const res = await signUp(env, 1);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/cannot be created/);
    const member = await invite(env, owner.agent);
    expect(member.id).toBeTruthy();
  });

  it('"closed" blocks all sign-ups', async () => {
    env = setup({ registration: 'closed' });
    expect((await signUp(env, 2)).status).toBe(403);
  });

  it('"open" is the default', async () => {
    env = setup();
    expect((await signUp(env, 3)).status).toBe(201);
    expect((await signUp(env, 4)).status).toBe(201);
  });
});

describe('behind a hosting proxy', () => {
  it('rate-limits sign-ins per client address, not per proxy', async () => {
    env = setup({ trustProxy: 1 });
    const attempt = (ip: string) =>
      env.agent().post('/api/auth/login').set('X-Forwarded-For', ip).send({ email: 'nobody@example.com', password: 'wrong-password' });
    let last = 0;
    for (let i = 0; i < 30 && last !== 429; i++) last = (await attempt('203.0.113.1')).status;
    expect(last).toBe(429);
    expect((await attempt('203.0.113.2')).status).toBe(401);
  });

  it('counts only failed sign-ins, and a successful one clears them', async () => {
    env = setup();
    const { email } = await registerOwner(env);
    const login = (password: string) => env.agent().post('/api/auth/login').send({ email, password });
    for (let i = 0; i < 20; i++) expect((await login('password123')).status).toBe(200);
    for (let i = 0; i < 9; i++) expect((await login('wrong-password')).status).toBe(401);
    expect((await login('password123')).status).toBe(200);
    for (let i = 0; i < 10; i++) expect((await login('wrong-password')).status).toBe(401);
    // Locked now, even with the right password.
    expect((await login('password123')).status).toBe(429);
  });
});
