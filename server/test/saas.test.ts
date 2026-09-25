import { afterEach, describe, expect, it } from 'vitest';
import type { AppOptions } from '../src/app.js';
import { processBillingNotices } from '../src/routes/billing.js';
import { totp } from '../src/totp.js';
import { flushJobs, invite, registerOwner, setup, type TestEnv } from './helpers.js';

let env: TestEnv;
afterEach(() => env?.cleanup());
const db = () => env.softex.ctx.db;
const DAY = 86_400_000;
const iso = (days: number) => new Date(Date.now() + days * DAY).toISOString();
const ai = { complete: async () => ({ text: 'A tidy summary.', refused: false }) };

const saas = (extra: Partial<AppOptions> = {}) =>
  setup({
    mode: 'saas',
    operatorEmails: ['ops@softex.test'],
    ai,
    ...extra,
    billing: { paymentInstructions: 'Send to Orange Money 0770 000 000 (SoftEX Ltd).', supportEmail: 'help@softex.test', lrdPerUsd: 190, ...extra.billing },
  });

/** Confirm an account's email address using the link from its verification email. */
async function verify(email: string) {
  const mail = [...env.sent].reverse().find((m) => m.to === email && /Confirm your email/.test(m.subject));
  const token = mail!.text.match(/verify-email\/([\w-]+)/)![1];
  expect((await env.agent().post('/api/auth/verify-email').send({ token })).status).toBe(200);
}

async function verifiedOwner(name = 'Owner') {
  const owner = await registerOwner(env, name);
  await flushJobs(env);
  await verify(owner.email);
  return owner;
}

/** Sign up the operator (a normal account whose email is in SOFTEX_OPERATOR_EMAILS) with MFA on. */
async function operator() {
  const agent = env.agent();
  await agent.post('/api/auth/register').send({ name: 'Ops', email: 'ops@softex.test', password: 'password123', workspaceName: 'SoftEX HQ', acceptTerms: true });
  await flushJobs(env);
  await verify('ops@softex.test');
  const { secret } = (await agent.post('/api/me/mfa/setup')).body;
  await agent.post('/api/me/mfa/enable').send({ code: totp(secret) });
  return agent;
}

const endTrial = async (workspaceId: string) => await db().run('UPDATE workspaces SET trial_ends_at = ? WHERE id = ?', iso(-1), workspaceId);

describe('sign-up on a hosted server', () => {
  it('starts a 30-day Business trial and asks for email confirmation', async () => {
    env = saas();
    const owner = await registerOwner(env);
    expect(owner.me.mode).toBe('saas');
    expect(owner.me.user.email_verified).toBe(false);
    expect(owner.me.workspace.plan).toMatchObject({ id: 'business', status: 'trial' });
    const days = (new Date(owner.me.workspace.plan.trial_ends_at).getTime() - Date.now()) / DAY;
    expect(Math.round(days)).toBe(30);

    // Unconfirmed accounts can use the workspace but can't invite people or use AI.
    const blocked = await owner.agent.post('/api/admin/invitations').send({ email: 'a@example.com' });
    expect(blocked.status).toBe(403);
    expect(blocked.body.details.code).toBe('email_unverified');

    await flushJobs(env);
    expect(env.sent.find((m) => m.to === owner.email)!.subject).toBe('Confirm your email address for SoftEX');
    expect((await owner.agent.post('/api/me/verify-email/resend')).status).toBe(200);
    await flushJobs(env);
    await verify(owner.email);
    expect((await owner.agent.get('/api/me')).body.user.email_verified).toBe(true);
    expect((await owner.agent.post('/api/admin/invitations').send({ email: 'a@example.com' })).status).toBe(201);
    expect((await owner.agent.post('/api/me/verify-email/resend')).status).toBe(400);
  });

  it('requires accepting the terms, and records the version accepted', async () => {
    env = saas();
    const res = await env.agent().post('/api/auth/register').send({ name: 'A', email: 'a@example.com', password: 'password123', workspaceName: 'Acme' });
    expect(res.status).toBe(400);
    const owner = await registerOwner(env);
    const user = (await db().get('SELECT terms_accepted_at, terms_version FROM users WHERE id = ?', owner.me.user.id))!;
    expect(user.terms_accepted_at).toBeTruthy();
    expect(user.terms_version).toBe((await env.agent().get('/api/public/plans')).body.terms_version);
  });

  it('rejects stale verification links, and treats invited people as confirmed', async () => {
    env = saas();
    const owner = await verifiedOwner();
    expect((await env.agent().post('/api/auth/verify-email').send({ token: 'not-a-real-token-at-all' })).status).toBe(400);
    const member = await invite(env, owner.agent);
    expect(member.me.user.email_verified).toBe(true);
  });

  it('leaves self-hosted servers without plans, billing or an operator console', async () => {
    env = setup({ operatorEmails: ['ops@softex.test'] });
    const owner = await registerOwner(env);
    expect(owner.me.workspace.plan).toMatchObject({ status: 'self_hosted' });
    expect(owner.me.user.email_verified).toBe(true);
    expect((await owner.agent.get('/api/billing')).status).toBe(404);
    expect((await owner.agent.get('/api/operator/summary')).status).toBe(404);
    expect((await env.agent().get('/api/public/plans')).body.mode).toBe('self_hosted');
  });
});

describe('plan limits', () => {
  it('keeps the Free plan to 10 members and core features', async () => {
    env = saas();
    const owner = await verifiedOwner();
    const wsId = owner.me.workspace.id;
    await endTrial(wsId);
    expect((await owner.agent.get('/api/me')).body.workspace.plan).toMatchObject({ id: 'free', status: 'free', features: [] });

    for (let i = 0; i < 9; i++) await invite(env, owner.agent);
    const full = await owner.agent.post('/api/admin/invitations').send({ email: 'eleventh@example.com' });
    expect(full.status).toBe(402);
    expect(full.body.details).toMatchObject({ code: 'plan_limit', limit: 'members' });

    const project = (await owner.agent.post('/api/projects').send({ name: 'Ops' })).body;
    const general = (await owner.agent.get('/api/channels')).body.find((c: { name: string }) => c.name === 'general');
    const checks: [string, () => Promise<{ status: number; body: { details?: { feature?: string } } }>][] = [
      ['automations', () => owner.agent.post(`/api/projects/${project.id}/automations`).send({ name: 'x', triggerType: 'task.created', actionType: 'set_priority', actionConfig: { priority: 'high' } })],
      ['planning', () => owner.agent.get('/api/workload')],
      ['insights', () => owner.agent.get('/api/admin/insights')],
      ['api', () => owner.agent.post('/api/integrations/tokens').send({ name: 'script' })],
      ['api', () => owner.agent.post('/api/integrations/webhooks').send({ url: 'https://example.com/hook', events: ['task.created'] })],
      ['ai', () => owner.agent.patch('/api/admin/workspace').send({ aiEnabled: true })],
      ['retention', () => owner.agent.patch('/api/admin/workspace').send({ retentionDays: 90 })],
      ['scim', () => owner.agent.post('/api/admin/scim/token')],
    ];
    for (const [feature, request] of checks) {
      const res = await request();
      expect([feature, res.status, res.body.details?.feature]).toEqual([feature, 402, feature]);
    }
    // Core collaboration keeps working.
    expect((await owner.agent.post(`/api/channels/${general.id}/messages`).send({ body: 'still free' })).status).toBe(201);
    expect((await owner.agent.post('/api/tasks').send({ title: 'Still free', projectId: project.id })).status).toBe(201);
  });

  it('blocks guests on Free and uploads beyond the storage allowance', async () => {
    env = saas();
    const owner = await verifiedOwner();
    await endTrial(owner.me.workspace.id);
    const general = (await owner.agent.get('/api/channels')).body.find((c: { name: string }) => c.name === 'general');
    const guest = await owner.agent.post('/api/admin/invitations').send({ email: 'g@example.com', role: 'guest', channelIds: [general.id] });
    expect([guest.status, guest.body.details.feature]).toEqual([402, 'guests']);

    expect((await owner.agent.post('/api/files').attach('file', Buffer.from('hello'), 'a.txt')).status).toBe(201);
    await db().run('UPDATE file_versions SET size = ?', 2 * 1024 ** 3);
    const over = await owner.agent.post('/api/files').attach('file', Buffer.from('hello'), 'b.txt');
    expect([over.status, over.body.details.limit]).toEqual([402, 'storage']);
  });

  it('caps AI requests during the trial and records usage', async () => {
    env = saas({ billing: { trialAiRequests: 2 } });
    const owner = await verifiedOwner();
    await owner.agent.patch('/api/admin/workspace').send({ aiEnabled: true });
    const ask = () => owner.agent.post('/api/ai/ask').send({ question: 'What did we decide about travel?' });
    const general = (await owner.agent.get('/api/channels')).body.find((c: { name: string }) => c.name === 'general');
    await owner.agent.post(`/api/channels/${general.id}/messages`).send({ body: 'We decided economy travel for short flights' });
    expect((await ask()).status).toBe(200);
    expect((await ask()).status).toBe(200);
    const third = await ask();
    expect([third.status, third.body.details.limit]).toEqual([402, 'ai']);
    expect((await db().get('SELECT COUNT(*) AS n FROM ai_usage'))!.n).toBe(2);
  });

  it('stops automations from running after a downgrade, without deleting them', async () => {
    env = saas();
    const owner = await verifiedOwner();
    const project = (await owner.agent.post('/api/projects').send({ name: 'Ops' })).body;
    await owner.agent.post(`/api/projects/${project.id}/automations`).send({ name: 'Urgent', triggerType: 'task.created', actionType: 'set_priority', actionConfig: { priority: 'urgent' } });
    await owner.agent.post('/api/tasks').send({ title: 'A', projectId: project.id });
    expect((await db().get(`SELECT priority FROM tasks WHERE title = 'A'`))!.priority).toBe('urgent');
    await endTrial(owner.me.workspace.id);
    await owner.agent.post('/api/tasks').send({ title: 'B', projectId: project.id });
    expect((await db().get(`SELECT priority FROM tasks WHERE title = 'B'`))!.priority).toBe('medium');
    expect((await db().get('SELECT COUNT(*) AS n FROM automations'))!.n).toBe(1);
  });
});

describe('paying with mobile money', () => {
  it('lets an admin submit a payment that the operator confirms', async () => {
    env = saas();
    const owner = await verifiedOwner('Kollie');
    const wsId = owner.me.workspace.id;
    await invite(env, owner.agent);
    await invite(env, owner.agent, 'guest', { channelIds: [(await owner.agent.get('/api/channels')).body[0].id] });

    const billing = (await owner.agent.get('/api/billing')).body;
    expect(billing.instructions).toContain('Orange Money');
    expect(billing.lrd_per_usd).toBe(190);
    expect(billing.usage).toMatchObject({ members: 3, seats: 2 });
    expect(billing.plans.map((p: { id: string; price: number }) => [p.id, p.price])).toEqual([
      ['free', 0],
      ['standard', 1.5],
      ['business', 3],
    ]);

    const submitted = await owner.agent
      .post('/api/billing/payments')
      .send({ plan: 'business', months: 12, method: 'orange_money', reference: 'OM240925.1234', payerPhone: '0770000001' });
    expect(submitted.status).toBe(201);
    // 2 billable members (guests are free) × $3 × 12 months, with two months free.
    expect(submitted.body).toMatchObject({ status: 'pending', seats: 2, amount: 60 });
    expect((await owner.agent.post('/api/billing/payments').send({ plan: 'business', months: 1, method: 'orange_money', reference: 'OM240925.1234' })).status).toBe(400);
    await flushJobs(env);
    expect(env.sent.some((m) => m.to === 'ops@softex.test' && m.subject.includes('Payment to confirm'))).toBe(true);

    // Only operators see the console; everyone else gets a 404.
    expect((await owner.agent.get('/api/operator/payments')).status).toBe(404);
    const ops = await operator();
    const pending = (await ops.get('/api/operator/payments?status=pending')).body;
    expect(pending).toHaveLength(1);
    expect(pending[0].workspace.name).toBe("Kollie's Co");

    const approved = await ops.post(`/api/operator/payments/${pending[0].id}/approve`).send({ note: 'Seen on statement' });
    expect(approved.status).toBe(200);
    const plan = (await owner.agent.get('/api/me')).body.workspace.plan;
    expect(plan).toMatchObject({ id: 'business', status: 'active' });
    expect(Math.round((new Date(plan.paid_through).getTime() - Date.now()) / DAY)).toBeGreaterThanOrEqual(365);
    await flushJobs(env);
    expect(env.sent.some((m) => m.to === owner.email && m.subject.startsWith('Payment received'))).toBe(true);
    expect((await owner.agent.get('/api/notifications')).body.notifications.some((n: { kind: string }) => n.kind === 'billing')).toBe(true);

    // Renewing the same plan extends from the end of the paid period.
    const before = new Date(plan.paid_through).getTime();
    const renewal = (await owner.agent.post('/api/billing/payments').send({ plan: 'business', months: 1, method: 'mtn_momo', reference: 'MP240925.9' })).body;
    await ops.post(`/api/operator/payments/${renewal.id}/approve`).send({});
    const after = new Date((await owner.agent.get('/api/me')).body.workspace.plan.paid_through).getTime();
    expect(Math.round((after - before) / DAY)).toBeGreaterThanOrEqual(28);

    const summary = (await ops.get('/api/operator/summary')).body;
    expect(summary.revenue_30d).toBe(66);
    expect(summary.workspaces.active).toBe(1);
    const events = (await ops.get('/api/operator/events')).body.map((e: { action: string }) => e.action);
    expect(events).toContain('payment.approved');
    expect((await owner.agent.get('/api/admin/audit')).body.some((e: { action: string }) => e.action === 'billing.payment_approved')).toBe(true);
    expect(wsId).toBeTruthy();
  });

  it('tells the admin when a payment is rejected', async () => {
    env = saas();
    const owner = await verifiedOwner();
    const p = (await owner.agent.post('/api/billing/payments').send({ plan: 'standard', months: 1, method: 'bank', reference: 'BANK-001' })).body;
    const ops = await operator();
    expect((await ops.post(`/api/operator/payments/${p.id}/reject`).send({ reason: 'No payment with this reference' })).status).toBe(200);
    const payments = (await owner.agent.get('/api/billing')).body.payments;
    expect(payments[0]).toMatchObject({ status: 'rejected', decision_note: 'No payment with this reference' });
    expect((await owner.agent.get('/api/me')).body.workspace.plan.status).toBe('trial');
  });

  it('keeps paid features for a grace week, then moves to Free', async () => {
    env = saas();
    const owner = await verifiedOwner();
    const wsId = owner.me.workspace.id;
    await db().run(`UPDATE workspaces SET plan = 'standard', paid_through = ?, trial_ends_at = ? WHERE id = ?`, iso(-3), iso(-40), wsId);
    expect((await owner.agent.get('/api/me')).body.workspace.plan).toMatchObject({ id: 'standard', status: 'grace' });
    expect((await owner.agent.get('/api/workload')).status).toBe(200);
    await db().run('UPDATE workspaces SET paid_through = ? WHERE id = ?', iso(-8), wsId);
    expect((await owner.agent.get('/api/me')).body.workspace.plan).toMatchObject({ id: 'free', status: 'free' });
    expect((await owner.agent.get('/api/workload')).status).toBe(402);
  });
});

describe('billing reminders', () => {
  it('warns before a trial ends, once', async () => {
    env = saas();
    const owner = await verifiedOwner();
    await db().run('UPDATE workspaces SET trial_ends_at = ? WHERE id = ?', iso(5), owner.me.workspace.id);
    expect(await processBillingNotices(env.softex.ctx)).toBe(1);
    expect(await processBillingNotices(env.softex.ctx)).toBe(0);
    await flushJobs(env);
    expect(env.sent.some((m) => m.to === owner.email && m.subject === 'Your SoftEX trial ends in 5 days')).toBe(true);
    await endTrial(owner.me.workspace.id);
    expect(await processBillingNotices(env.softex.ctx)).toBe(1);
    await flushJobs(env);
    expect(env.sent.some((m) => m.subject.endsWith('is now on the Free plan'))).toBe(true);
  });
});

describe('operator console', () => {
  it('requires multifactor authentication', async () => {
    env = saas();
    const agent = env.agent();
    await agent.post('/api/auth/register').send({ name: 'Ops', email: 'ops@softex.test', password: 'password123', workspaceName: 'HQ', acceptTerms: true });
    const res = await agent.get('/api/operator/summary');
    expect([res.status, res.body.details.code]).toEqual([403, 'operator_mfa']);
    expect((await agent.get('/api/me')).body.operator).toBe(true);
  });

  it('suspends and restores a workspace', async () => {
    env = saas();
    const owner = await verifiedOwner('Musu');
    const member = await invite(env, owner.agent);
    const ops = await operator();
    const list = (await ops.get('/api/operator/workspaces?q=musu')).body;
    expect(list).toHaveLength(1);
    expect(list[0].owners[0].email).toBe(owner.email);
    // Operators see sizes and dates, never content.
    expect(Object.keys(list[0])).not.toContain('channels');

    expect((await ops.patch(`/api/operator/workspaces/${list[0].id}`).send({ suspended: true })).status).toBe(400);
    expect((await ops.patch(`/api/operator/workspaces/${list[0].id}`).send({ suspended: true, reason: 'Spam reports' })).status).toBe(200);
    expect((await member.agent.get('/api/me')).status).toBe(401);
    const login = await env.agent().post('/api/auth/login').send({ email: owner.email, password: 'password123' });
    expect([login.status, login.body.details.code]).toEqual([403, 'workspace_suspended']);

    await ops.patch(`/api/operator/workspaces/${list[0].id}`).send({ suspended: false });
    expect((await env.agent().post('/api/auth/login').send({ email: owner.email, password: 'password123' })).status).toBe(200);

    // Operators can also extend a trial or grant a plan by hand.
    await ops.patch(`/api/operator/workspaces/${list[0].id}`).send({ plan: 'standard', paidThrough: iso(30) });
    expect((await member.agent.post('/api/auth/login').send({ email: member.email, password: 'password123' })).body.workspace.plan).toMatchObject({
      id: 'standard',
      status: 'active',
    });
  });
});

describe('public pricing', () => {
  it('lists plans without signing in', async () => {
    env = saas({ billing: { priceStandard: 1, priceBusiness: 2.5 } });
    const res = await env.agent().get('/api/public/plans');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ mode: 'saas', currency: 'USD', trial_days: 30, lrd_per_usd: 190 });
    expect(res.body.plans.find((p: { id: string }) => p.id === 'business')).toMatchObject({ price: 2.5, features: expect.arrayContaining(['ai', 'sso']) });
    expect(res.body.plans.find((p: { id: string }) => p.id === 'standard').features).not.toContain('ai');
  });
});
