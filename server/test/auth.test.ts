import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { totp } from '../src/totp.js';
import { invite, registerOwner, setup, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeEach(() => (env = setup()));
afterEach(() => env.cleanup());

describe('authentication', () => {
  it('registers a workspace owner with default channels', async () => {
    const { agent, me } = await registerOwner(env, 'Alex');
    expect(me.role).toBe('owner');
    expect(me.user.name).toBe('Alex');
    const channels = await agent.get('/api/channels');
    expect(channels.body.map((c: { name: string }) => c.name).sort()).toEqual(['announcements', 'general']);
  });

  it('rejects anonymous access and wrong passwords', async () => {
    const { email } = await registerOwner(env);
    expect((await env.agent().get('/api/me')).status).toBe(401);
    const bad = await env.agent().post('/api/auth/login').send({ email, password: 'nope-nope' });
    expect(bad.status).toBe(401);
    const good = await env.agent().post('/api/auth/login').send({ email, password: 'password123' });
    expect(good.status).toBe(200);
  });

  it('logs out and invalidates the session', async () => {
    const { agent } = await registerOwner(env);
    await agent.post('/api/auth/logout');
    expect((await agent.get('/api/me')).status).toBe(401);
  });

  it('enforces multifactor authentication once enabled', async () => {
    const { agent, email } = await registerOwner(env);
    const setupRes = await agent.post('/api/me/mfa/setup');
    const { secret } = setupRes.body;
    expect((await agent.post('/api/me/mfa/enable').send({ code: '000000' })).status).toBe(400);
    expect((await agent.post('/api/me/mfa/enable').send({ code: totp(secret) })).status).toBe(200);
    const noCode = await env.agent().post('/api/auth/login').send({ email, password: 'password123' });
    expect(noCode.status).toBe(401);
    expect(noCode.body.details.code).toBe('mfa_required');
    const withCode = await env.agent().post('/api/auth/login').send({ email, password: 'password123', code: totp(secret) });
    expect(withCode.status).toBe(200);
  });

  it('blocks members until MFA is set up when the workspace requires it', async () => {
    const owner = await registerOwner(env);
    const member = await invite(env, owner.agent);
    const { secret } = (await owner.agent.post('/api/me/mfa/setup')).body;
    await owner.agent.post('/api/me/mfa/enable').send({ code: totp(secret) });
    expect((await owner.agent.patch('/api/admin/workspace').send({ requireMfa: true })).status).toBe(200);
    const blocked = await member.agent.get('/api/channels');
    expect(blocked.status).toBe(403);
    expect(blocked.body.details.code).toBe('mfa_setup_required');
    expect((await member.agent.get('/api/me')).body.mfa_setup_required).toBe(true);
  });

  it('revokes access when a member is deactivated', async () => {
    const owner = await registerOwner(env);
    const member = await invite(env, owner.agent);
    expect((await member.agent.get('/api/me')).status).toBe(200);
    await owner.agent.patch(`/api/admin/members/${member.id}`).send({ deactivated: true });
    expect((await member.agent.get('/api/me')).status).toBe(401);
    const audit = await owner.agent.get('/api/admin/audit');
    expect(audit.body.some((e: { action: string }) => e.action === 'member.deactivated')).toBe(true);
  });

  it('keeps at least one owner', async () => {
    const owner = await registerOwner(env);
    const res = await owner.agent.patch(`/api/admin/members/${owner.me.user.id}`).send({ role: 'admin' });
    expect(res.status).toBe(400);
  });

  it('only lets admins manage members', async () => {
    const owner = await registerOwner(env);
    const member = await invite(env, owner.agent);
    expect((await member.agent.get('/api/admin/members')).status).toBe(403);
    expect((await member.agent.post('/api/admin/invitations').send({ email: 'x@example.com', role: 'member' })).status).toBe(403);
  });
});
