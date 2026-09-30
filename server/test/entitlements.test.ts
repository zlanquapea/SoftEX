import { afterEach, describe, expect, it } from 'vitest';
import { processBillingNotices } from '../src/routes/billing.js';
import { totp } from '../src/totp.js';
import { flushJobs, invite, registerOwner, setup, type TestEnv } from './helpers.js';

let env: TestEnv;
afterEach(() => env?.cleanup());
const db = () => env.softex.ctx.db;
const DAY = 86_400_000;
const iso = (days: number) => new Date(Date.now() + days * DAY).toISOString();

const saas = () => setup({ mode: 'saas', operatorEmails: ['ops@softex.test'], ai: { complete: async () => ({ text: 'ok', refused: false }) } });

async function verify(email: string) {
  const mail = [...env.sent].reverse().find((m) => m.to === email && /Confirm your email/.test(m.subject));
  await env.agent().post('/api/auth/verify-email').send({ token: mail!.text.match(/verify-email\/([\w-]+)/)![1] }).expect(200);
}

async function verifiedOwner(name = 'Owner') {
  const owner = await registerOwner(env, name);
  await flushJobs(env);
  await verify(owner.email);
  return owner;
}

async function operator() {
  const agent = env.agent();
  await agent.post('/api/auth/register').send({ name: 'Ops', email: 'ops@softex.test', password: 'password123', workspaceName: 'HQ', acceptTerms: true });
  await flushJobs(env);
  await verify('ops@softex.test');
  const { secret } = (await agent.post('/api/me/mfa/setup')).body;
  await agent.post('/api/me/mfa/enable').send({ code: totp(secret) });
  return agent;
}

const toFree = (wsId: string) => db().run(`UPDATE workspaces SET plan = 'free', paid_through = NULL, trial_ends_at = ? WHERE id = ?`, iso(-1), wsId);

describe('entitlement overrides', () => {
  it('lets an operator grant features and change limits for one workspace', async () => {
    env = saas();
    const owner = await verifiedOwner('Kollie');
    const wsId = owner.me.workspace.id;
    await toFree(wsId);
    expect((await owner.agent.post('/api/goals').send({ title: 'Grow' })).status).toBe(402);

    const ops = await operator();
    // Unknown features and malformed limits are refused.
    expect((await ops.patch(`/api/operator/workspaces/${wsId}`).send({ overrides: { grant: ['teleport'], revoke: [], note: '' } })).status).toBe(400);
    expect((await ops.patch(`/api/operator/workspaces/${wsId}`).send({ overrides: { grant: [], revoke: [], members: 'lots' } })).status).toBe(400);

    const saved = await ops
      .patch(`/api/operator/workspaces/${wsId}`)
      .send({ overrides: { grant: ['goals'], revoke: [], members: 7, note: 'Pilot for the NGO programme' } });
    expect(saved.status).toBe(200);
    expect(saved.body.plan).toMatchObject({ id: 'free', custom: true });

    // Free plan, but goals are on and the member limit is 7 instead of 5.
    expect((await owner.agent.post('/api/goals').send({ title: 'Grow' })).status).toBe(201);
    const billing = (await owner.agent.get('/api/billing')).body;
    expect(billing.plan).toMatchObject({ custom: true, member_limit: 7, features: ['goals'] });
    expect(billing.usage.member_limit).toBe(7);

    // Taking a feature away works the same way, whatever the plan.
    await ops.patch(`/api/operator/workspaces/${wsId}`).send({ plan: 'organization', paidThrough: iso(30), overrides: { grant: [], revoke: ['ai'], storage_gb: null, note: '' } });
    const org = (await owner.agent.get('/api/billing')).body.plan;
    expect(org.features).not.toContain('ai');
    expect(org.features).toContain('sso');
    expect(org.storage_limit).toBeNull();
    expect((await owner.agent.patch('/api/admin/workspace').send({ aiEnabled: true })).status).toBe(402);

    // null clears the overrides.
    await ops.patch(`/api/operator/workspaces/${wsId}`).send({ overrides: null });
    expect((await owner.agent.get('/api/billing')).body.plan).toMatchObject({ custom: false, member_limit: 50 });
  });
});

describe('after a downgrade', () => {
  it('keeps goals and dashboards readable but not editable', async () => {
    env = saas();
    const owner = await verifiedOwner();
    const goal = (await owner.agent.post('/api/goals').send({ title: 'Open the new branch' }).expect(201)).body;
    const dash = (await owner.agent.post('/api/dashboards').send({ name: 'Ops' }).expect(201)).body;
    await toFree(owner.me.workspace.id);

    const goals = (await owner.agent.get('/api/goals')).body;
    expect(goals).toMatchObject([{ id: goal.id, can_edit: false }]);
    expect((await owner.agent.get(`/api/goals/${goal.id}`)).body.can_edit).toBe(false);
    expect((await owner.agent.patch(`/api/goals/${goal.id}`).send({ title: 'x' })).status).toBe(402);

    expect((await owner.agent.get('/api/dashboards')).body).toMatchObject([{ id: dash.id, can_edit: false }]);
    expect((await owner.agent.get(`/api/dashboards/${dash.id}/data`)).status).toBe(200);
    expect((await owner.agent.patch(`/api/dashboards/${dash.id}`).send({ name: 'y' })).status).toBe(402);
    expect((await owner.agent.post('/api/dashboards').send({ name: 'New' })).status).toBe(402);

    // People can still tidy up what they have.
    await owner.agent.delete(`/api/goals/${goal.id}`).expect(200);
    await owner.agent.delete(`/api/dashboards/${dash.id}`).expect(200);
  });

  it('checks timeline start dates on the server, not only in the app', async () => {
    env = saas();
    const owner = await verifiedOwner();
    const project = (await owner.agent.post('/api/projects').send({ name: 'Launch' })).body;
    const task = (await owner.agent.post('/api/tasks').send({ title: 'Plan', projectId: project.id, startDate: '2031-01-01', dueDate: '2031-01-05' }).expect(201)).body;
    await toFree(owner.me.workspace.id);
    const blocked = await owner.agent.post('/api/tasks').send({ title: 'Later', projectId: project.id, startDate: '2031-01-02' });
    expect([blocked.status, blocked.body.details.feature]).toEqual([402, 'planning']);
    expect((await owner.agent.patch(`/api/tasks/${task.id}`).send({ startDate: '2031-01-03' })).status).toBe(402);
    // Due dates are core, and clearing a start date is always allowed.
    await owner.agent.patch(`/api/tasks/${task.id}`).send({ dueDate: '2031-01-09' }).expect(200);
    await owner.agent.patch(`/api/tasks/${task.id}`).send({ startDate: null }).expect(200);
  });
});

describe('upgrade signals and usage warnings', () => {
  it('records what the plan stopped, for the admin and the operator', async () => {
    env = saas();
    const owner = await verifiedOwner('Musu');
    await toFree(owner.me.workspace.id);
    for (let i = 0; i < 3; i++) await owner.agent.post('/api/goals').send({ title: 'Grow' }).expect(402);
    await owner.agent.get('/api/workload').expect(402);
    const blocked = (await owner.agent.get('/api/billing')).body.usage.blocked;
    expect(blocked).toEqual([
      { key: 'goals', label: 'Goals and intake forms', count: 3 },
      { key: 'planning', label: 'Timeline and workload', count: 1 },
    ]);
    const ops = await operator();
    const list = (await ops.get('/api/operator/workspaces?q=musu')).body;
    expect(list[0].upgrade_signals[0]).toMatchObject({ key: 'goals', count: 3 });
  });

  it('warns admins at 80% and at 100% of a limit, once each', async () => {
    env = saas();
    const owner = await verifiedOwner();
    const wsId = owner.me.workspace.id;
    for (let i = 0; i < 3; i++) await invite(env, owner.agent);
    await db().run(`UPDATE workspaces SET plan = 'free', paid_through = NULL, trial_ends_at = NULL WHERE id = ?`, wsId);
    // 4 of 5 members = 80%.
    await processBillingNotices(env.softex.ctx);
    expect(await processBillingNotices(env.softex.ctx)).toBe(0);
    await flushJobs(env);
    expect(env.sent.some((m) => m.to === owner.email && m.subject.endsWith('has used 80% of its member limit'))).toBe(true);
    await invite(env, owner.agent);
    await processBillingNotices(env.softex.ctx);
    await flushJobs(env);
    expect(env.sent.some((m) => m.to === owner.email && m.subject.endsWith('has reached its member limit'))).toBe(true);
  });
});
