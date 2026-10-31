import { afterEach, describe, expect, it } from 'vitest';
import type { AppOptions } from '../src/app.js';
import { MOVE_TO_CURRENT_PLANS } from '../src/db.js';
import { CURRENT_PLAN_VERSION, GB, MB, storageUsed } from '../src/plans.js';
import { flushJobs, invite, registerOwner, setup, type TestEnv } from './helpers.js';

/**
 * The 2026-11 packaging: Free for evaluation (3 members, 250 MB, 2 active projects), Starter (6, 5 GB, 10),
 * Team (15, 25 GB, unlimited) and Organization (30, 100 GB, unlimited), with existing workspaces kept on
 * their original allowances.
 */

let env: TestEnv;
afterEach(() => env?.cleanup());
const db = () => env.softex.ctx.db;
const DAY = 86_400_000;
const iso = (days: number) => new Date(Date.now() + days * DAY).toISOString();

const saas = (extra: Partial<AppOptions> = {}) =>
  setup({ mode: 'saas', ...extra, billing: { paymentInstructions: 'Send to Orange Money 0770 000 000.', supportEmail: 'help@softex.test', ...extra.billing } });

async function verifiedOwner(name = 'Owner') {
  const owner = await registerOwner(env, name);
  await flushJobs(env);
  const mail = [...env.sent].reverse().find((m) => m.to === owner.email && /Confirm your email/.test(m.subject))!;
  const token = mail.text.match(/verify-email\/([\w-]+)/)![1];
  await env.agent().post('/api/auth/verify-email').send({ token }).expect(200);
  return owner;
}

type Agent = Awaited<ReturnType<typeof verifiedOwner>>['agent'];
const ws = (owner: { me: { workspace: { id: string } } }) => owner.me.workspace.id;
const endTrial = (id: string) => db().run('UPDATE workspaces SET trial_ends_at = ? WHERE id = ?', iso(-1), id);
const pay = (id: string, plan: string) => db().run('UPDATE workspaces SET plan = ?, paid_through = ?, trial_ends_at = ? WHERE id = ?', plan, iso(30), iso(-1), id);
/** An invitation that hasn't been accepted yet; returns its token. */
const inviteOnly = async (agent: Agent, email: string, extra: Record<string, unknown> = {}) => {
  const res = await agent.post('/api/admin/invitations').send({ email, ...extra });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.token as string;
};
const accept = (token: string, name = 'New person') => env.agent().post(`/api/invitations/${token}/accept`).send({ name, password: 'password123', acceptTerms: true });
const upload = (agent: Agent, bytes = 5, name = 'a.txt', extra: Record<string, string> = {}) => {
  let req = agent.post('/api/files').attach('file', Buffer.alloc(bytes, 'x'), name);
  for (const [k, v] of Object.entries(extra)) req = req.field(k, v);
  return req;
};
/** Pretend the workspace already stores `bytes` (one big existing file), without writing that much to disk. */
const fill = async (agent: Agent, bytes: number) => {
  const file = (await upload(agent, 1, 'big.bin').expect(201)).body;
  await db().run('UPDATE file_versions SET size = ? WHERE file_id = ?', bytes, file.id);
  return file;
};
const limit = (res: { status: number; body: { details?: { limit?: string } } }) => [res.status, res.body.details?.limit];

describe('plan catalog and versions', () => {
  it('publishes the new allowances, in exact bytes', async () => {
    env = saas();
    const { plans, trial_days, annual_factor } = (await env.agent().get('/api/public/plans').expect(200)).body;
    expect(trial_days).toBe(14);
    expect(annual_factor).toBeCloseTo(10 / 12);
    const row = (id: string) => plans.find((p: { id: string }) => p.id === id);
    expect(plans.map((p: Record<string, unknown>) => [p.id, p.price, p.member_limit, p.storage_bytes, p.project_limit])).toEqual([
      ['free', 0, 3, 250 * MB, 2],
      ['starter', 10, 6, 5 * GB, 10],
      ['team', 25, 15, 25 * GB, null],
      ['organization', 60, 30, 100 * GB, null],
      ['enterprise', null, null, 1024 * GB, null],
    ]);
    // 250 MB is not rounded away for older clients either.
    expect(row('free').storage_gb).toBeCloseTo(250 / 1024);
    expect(row('free').tagline).toBe('Try Küü with a small team.');
    expect(row('starter').tagline).toBe('Run your team’s everyday work.');
    expect(row('team').tagline).toBe('Coordinate projects, clients, and workflows.');
    expect(row('organization').tagline).toBe('Manage growing teams with AI and advanced controls.');
    // Features and the AI and recording quotas are unchanged.
    expect(row('free').features).toEqual([]);
    expect(row('starter').features).toEqual([]);
    expect(row('team').features).toEqual(['automations', 'planning', 'fields', 'goals', 'recordings', 'insights', 'guests', 'api']);
    expect(row('organization').features).toEqual(expect.arrayContaining(['ai', 'sso', 'scim', 'retention']));
    expect([row('team').recording_hours, row('organization').recording_hours, row('organization').ai_per_month, row('enterprise').ai_per_month]).toEqual([20, 60, 1000, 5000]);
  });

  it('new workspaces get the new packaging, with Organization allowances during the trial and Free after it', async () => {
    env = saas();
    const owner = await verifiedOwner();
    expect((await db().get('SELECT plan_version FROM workspaces WHERE id = ?', ws(owner)))!.plan_version).toBe(CURRENT_PLAN_VERSION);
    const trial = (await owner.agent.get('/api/billing').expect(200)).body;
    expect(trial.plan).toMatchObject({ id: 'organization', status: 'trial', member_limit: 30, storage_limit: 100 * GB, project_limit: null, plan_version: '2026-11' });
    await endTrial(ws(owner));
    const after = (await owner.agent.get('/api/billing')).body;
    expect(after.plan).toMatchObject({ id: 'free', status: 'free', member_limit: 3, storage_limit: 250 * MB, project_limit: 2 });
    expect(after.usage).toMatchObject({ members: 1, member_limit: 3, projects: 0, project_limit: 2, storage_limit: 250 * MB });
    // Everyone in the workspace can see the shared allowances (billing details stay admin-only).
    const member = await invite(env, owner.agent);
    expect((await member.agent.get('/api/billing')).status).toBe(403);
    expect((await member.agent.get('/api/plan/usage').expect(200)).body).toMatchObject({ members: 2, member_limit: 3, project_limit: 2, can_manage_billing: false });
  });

  it('moves existing workspaces to the new plans once, letting a paid period finish on the old allowances', async () => {
    env = saas();
    const free = await verifiedOwner('Free');
    const paid = await verifiedOwner('Paid');
    // Both from before versioning; one has paid for Starter until next month.
    await db().run(`UPDATE workspaces SET plan_version = 'v1' WHERE id IN (?, ?)`, ws(free), ws(paid));
    await endTrial(ws(free));
    await pay(ws(paid), 'starter');
    await db().run(MOVE_TO_CURRENT_PLANS);
    await db().run(MOVE_TO_CURRENT_PLANS); // safe to repeat

    expect((await free.agent.get('/api/billing')).body.plan).toMatchObject({ id: 'free', member_limit: 3, storage_limit: 250 * MB, project_limit: 2, plan_version: '2026-11', legacy_until: null });
    const during = (await paid.agent.get('/api/billing')).body;
    expect(during.plan).toMatchObject({ id: 'starter', member_limit: 10, storage_limit: 20 * GB, project_limit: null, plan_version: 'v1' });
    expect(new Date(during.plan.legacy_until).getTime()).toBeGreaterThan(Date.now() + 29 * DAY);
    // Choosing or renewing a plan shows (and buys) the new allowances.
    expect(during.plans.find((p: { id: string }) => p.id === 'starter')).toMatchObject({ member_limit: 6, storage_bytes: 5 * GB, project_limit: 10 });

    // A renewal extends the paid date, but the old allowances still end with the period paid before the move.
    await db().run('UPDATE workspaces SET paid_through = ?, legacy_allowances_until = ? WHERE id = ?', iso(60), iso(-8), ws(paid));
    expect((await paid.agent.get('/api/billing')).body.plan).toMatchObject({ id: 'starter', status: 'active', member_limit: 6, storage_limit: 5 * GB, project_limit: 10, legacy_until: null });
  });

  it('lets an operator keep a workspace on the original allowances on purpose', async () => {
    env = saas();
    const owner = await verifiedOwner();
    // Set explicitly (after the one-time move), e.g. for an agreed exception.
    await db().run(`UPDATE workspaces SET plan_version = 'v1' WHERE id = ?`, ws(owner));
    await endTrial(ws(owner));
    expect((await owner.agent.get('/api/billing')).body.plan).toMatchObject({ id: 'free', member_limit: 5, storage_limit: 2 * GB, project_limit: null });
    for (let i = 0; i < 4; i++) await invite(env, owner.agent);
    for (let i = 0; i < 3; i++) await owner.agent.post('/api/projects').send({ name: `Legacy ${i}` }).expect(201);
    await fill(owner.agent, 1 * GB);
    await upload(owner.agent).expect(201);

    await pay(ws(owner), 'starter');
    const billing = (await owner.agent.get('/api/billing')).body;
    expect(billing.plan).toMatchObject({ id: 'starter', status: 'active', member_limit: 10, storage_limit: 20 * GB, project_limit: null });
    // Its billing screen shows the allowances it signed up with, at the same prices.
    expect(billing.plans.find((p: { id: string }) => p.id === 'starter')).toMatchObject({ price: 10, storage_bytes: 20 * GB, project_limit: null });
    expect((await owner.agent.post('/api/billing/payments').send({ plan: 'starter', months: 12, method: 'bank', reference: 'LEGACY-1' })).body).toMatchObject({ amount: 100 });
  });
});

describe('members', () => {
  it('counts the owner, refuses the fourth member on Free, and explains what to do', async () => {
    env = saas();
    const owner = await verifiedOwner();
    await endTrial(ws(owner));
    await invite(env, owner.agent);
    await invite(env, owner.agent);
    const res = await owner.agent.post('/api/admin/invitations').send({ email: 'fourth@example.com' });
    expect(limit(res)).toEqual([402, 'members']);
    expect(res.body.details).toMatchObject({ code: 'plan_limit', used: 3, allowed: 3, upgrade: 'starter' });
    expect(res.body.error).toMatch(/includes 3 members .* Deactivate someone .* Starter plan includes more/);
  });

  it('fits six members on Starter, the owner included', async () => {
    env = saas();
    const owner = await verifiedOwner();
    await pay(ws(owner), 'starter');
    for (let i = 0; i < 5; i++) await invite(env, owner.agent);
    const seventh = await owner.agent.post('/api/admin/invitations').send({ email: 'seventh@example.com' });
    expect(limit(seventh)).toEqual([402, 'members']);
    expect(seventh.body.details).toMatchObject({ used: 6, allowed: 6, upgrade: 'team' });
  });

  it('checks again when an invitation is accepted, so earlier invitations can’t overfill the plan', async () => {
    env = saas();
    const owner = await verifiedOwner();
    await endTrial(ws(owner));
    const first = await inviteOnly(owner.agent, 'a@example.com');
    const second = await inviteOnly(owner.agent, 'b@example.com');
    const third = await inviteOnly(owner.agent, 'c@example.com');
    expect((await accept(first)).status).toBe(200);
    expect((await accept(second)).status).toBe(200);
    expect(limit(await accept(third))).toEqual([402, 'members']);
  });

  it('lets only one of two simultaneous acceptances take the last place', async () => {
    env = saas();
    const owner = await verifiedOwner();
    await endTrial(ws(owner));
    await invite(env, owner.agent);
    const tokens = [await inviteOnly(owner.agent, 'x@example.com'), await inviteOnly(owner.agent, 'y@example.com')];
    const results = await Promise.all(tokens.map((t, i) => accept(t, `Racer ${i}`)));
    expect(results.map((r) => r.status).sort()).toEqual([200, 402]);
    expect((await owner.agent.get('/api/billing')).body.usage.members).toBe(3);
  });

  it('doesn’t count guests, but a guest can’t become a full member without a free place', async () => {
    env = saas();
    const owner = await verifiedOwner();
    await pay(ws(owner), 'team');
    await db().run(`UPDATE workspaces SET entitlement_overrides = ? WHERE id = ?`, JSON.stringify({ members: 2 }), ws(owner));
    const general = (await owner.agent.get('/api/channels')).body.find((c: { name: string }) => c.name === 'general');
    const guest = await invite(env, owner.agent, 'guest', { channelIds: [general.id] });
    await invite(env, owner.agent);
    expect((await owner.agent.get('/api/billing')).body.usage).toMatchObject({ members: 2, guests: 1, member_limit: 2 });

    // Promoting the guest, or a member invitation sent to them, would add a third full member.
    expect(limit(await owner.agent.patch(`/api/admin/members/${guest.id}`).send({ role: 'member' }))).toEqual([402, 'members']);
    await db().run(`UPDATE workspaces SET entitlement_overrides = ? WHERE id = ?`, JSON.stringify({ members: 3 }), ws(owner));
    await db().run('UPDATE memberships SET deactivated_at = ? WHERE user_id = ?', new Date().toISOString(), guest.id);
    const memberInvite = await inviteOnly(owner.agent, guest.email);
    await db().run('UPDATE memberships SET deactivated_at = NULL WHERE user_id = ?', guest.id);
    await db().run(`UPDATE workspaces SET entitlement_overrides = ? WHERE id = ?`, JSON.stringify({ members: 2 }), ws(owner));
    const res = await env.agent().post(`/api/invitations/${memberInvite}/accept`).send({ password: 'password123' });
    expect(limit(res)).toEqual([402, 'members']);
    expect((await db().get('SELECT role FROM memberships WHERE user_id = ?', guest.id))!.role).toBe('guest');

    // With a place free, the promotion goes through.
    await db().run(`UPDATE workspaces SET entitlement_overrides = ? WHERE id = ?`, JSON.stringify({ members: 3 }), ws(owner));
    await owner.agent.patch(`/api/admin/members/${guest.id}`).send({ role: 'member' }).expect(200);
  });

  it('needs a free place to reactivate someone', async () => {
    env = saas();
    const owner = await verifiedOwner();
    await endTrial(ws(owner));
    const a = await invite(env, owner.agent);
    await owner.agent.patch(`/api/admin/members/${a.id}`).send({ deactivated: true }).expect(200);
    await invite(env, owner.agent);
    await invite(env, owner.agent);
    expect(limit(await owner.agent.patch(`/api/admin/members/${a.id}`).send({ deactivated: false }))).toEqual([402, 'members']);
  });
});

describe('active projects', () => {
  it('counts projects that aren’t archived, when creating and when restoring', async () => {
    env = saas();
    const owner = await verifiedOwner();
    await endTrial(ws(owner));
    const one = (await owner.agent.post('/api/projects').send({ name: 'One' }).expect(201)).body;
    await owner.agent.post('/api/projects').send({ name: 'Two' }).expect(201);
    const third = await owner.agent.post('/api/projects').send({ name: 'Three' });
    expect(limit(third)).toEqual([402, 'projects']);
    expect(third.body.details).toMatchObject({ used: 2, allowed: 2, upgrade: 'starter' });
    expect(third.body.error).toMatch(/Archive a finished project/);

    // Archiving frees a place; the archived project stays readable.
    await owner.agent.patch(`/api/projects/${one.id}`).send({ archived: true }).expect(200);
    await owner.agent.get(`/api/projects/${one.id}`).expect(200);
    await owner.agent.post('/api/projects').send({ name: 'Three' }).expect(201);
    // …and restoring it needs a place again.
    expect(limit(await owner.agent.patch(`/api/projects/${one.id}`).send({ archived: false }))).toEqual([402, 'projects']);
    // Other edits to an archived project still work.
    await owner.agent.patch(`/api/projects/${one.id}`).send({ description: 'Done in October' }).expect(200);
  });

  it('can’t be overshot by simultaneous requests', async () => {
    env = saas();
    const owner = await verifiedOwner();
    await endTrial(ws(owner));
    const results = await Promise.all([1, 2, 3, 4, 5].map((i) => owner.agent.post('/api/projects').send({ name: `Race ${i}` })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(2);
    expect(results.filter((r) => r.status === 402)).toHaveLength(3);
    expect((await db().get(`SELECT COUNT(*) AS n FROM projects WHERE workspace_id = ? AND archived_at IS NULL`, ws(owner)))!.n).toBe(2);
  });
});

describe('shared storage', () => {
  it('allows uploads up to exactly 250 MB on Free, and refuses a byte more', async () => {
    env = saas();
    const owner = await verifiedOwner();
    await endTrial(ws(owner));
    await fill(owner.agent, 250 * MB - 10);
    await upload(owner.agent, 10, 'fits.txt').expect(201);
    expect(await storageUsed(db(), ws(owner))).toBe(250 * MB);
    const over = await upload(owner.agent, 1, 'one-more.txt');
    expect(limit(over)).toEqual([402, 'storage']);
    expect(over.body.error).toMatch(/250 MB of 250 MB .* Delete files you no longer need/);
    // Nothing was stored or recorded for the refused upload.
    expect(await storageUsed(db(), ws(owner))).toBe(250 * MB);
    expect((await db().get(`SELECT COUNT(*) AS n FROM files WHERE name = 'one-more.txt'`))!.n).toBe(0);
  });

  it('is shared by everyone, and counts every version, archived files and archived projects, and recordings, once each', async () => {
    env = saas();
    const owner = await verifiedOwner();
    const member = await invite(env, owner.agent);
    await endTrial(ws(owner));
    const project = (await owner.agent.post('/api/projects').send({ name: 'Docs' }).expect(201)).body;
    const a = (await upload(owner.agent, 100, 'a.txt', { projectId: project.id }).expect(201)).body;
    await owner.agent.post(`/api/files/${a.id}/versions`).attach('file', Buffer.alloc(50, 'y'), 'a.txt').expect(201);
    await upload(member.agent, 30, 'b.txt').expect(201);
    expect(await storageUsed(db(), ws(owner))).toBe(180);
    await owner.agent.post(`/api/files/${a.id}/archive`).send({ archived: true }).expect(200);
    await owner.agent.patch(`/api/projects/${project.id}`).send({ archived: true }).expect(200);
    expect(await storageUsed(db(), ws(owner))).toBe(180);
    // A saved recording counts; a stored object referenced twice counts once.
    const meeting = (await owner.agent.post('/api/meetings').send({ title: 'Sync', startsAt: iso(1) }).expect(201)).body;
    await db().run(
      `INSERT INTO meeting_recordings (id, workspace_id, meeting_id, started_by, kind, status, storage_key, size, started_at) VALUES ('r1', ?, ?, ?, 'audio', 'ready', 'rec-key', 20, ?)`,
      ws(owner),
      meeting.id,
      owner.me.user.id,
      new Date().toISOString(),
    );
    const v = (await db().get('SELECT * FROM file_versions WHERE file_id = ? AND version = 1', a.id))!;
    await db().run(`INSERT INTO file_versions (id, file_id, version, storage_key, mime, size, uploaded_by, created_at) VALUES ('dup', ?, 9, ?, ?, ?, ?, ?)`, a.id, v.storage_key, v.mime, v.size, v.uploaded_by, v.created_at);
    expect(await storageUsed(db(), ws(owner))).toBe(200);
  });

  it('refuses new versions and recordings at the limit too', async () => {
    env = saas();
    const owner = await verifiedOwner();
    await endTrial(ws(owner));
    const file = await fill(owner.agent, 250 * MB);
    expect(limit(await owner.agent.post(`/api/files/${file.id}/versions`).attach('file', Buffer.alloc(5, 'z'), 'big.bin'))).toEqual([402, 'storage']);
  });

  it('can’t be overshot by simultaneous uploads', async () => {
    env = saas();
    const owner = await verifiedOwner();
    await endTrial(ws(owner));
    await fill(owner.agent, 250 * MB - 25);
    const results = await Promise.all([1, 2, 3, 4].map((i) => upload(owner.agent, 10, `race-${i}.txt`)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(2);
    expect(await storageUsed(db(), ws(owner))).toBeLessThanOrEqual(250 * MB);
  });

  it('frees space when a file is deleted, even while over the limit, except under a legal hold', async () => {
    env = saas();
    const owner = await verifiedOwner();
    const member = await invite(env, owner.agent);
    await endTrial(ws(owner));
    const big = await fill(owner.agent, 300 * MB);
    expect(limit(await upload(owner.agent))).toEqual([402, 'storage']);
    // Only the owner of a file, or an admin, may delete it.
    expect((await member.agent.delete(`/api/files/${big.id}`)).status).toBe(403);
    await db().run('UPDATE workspaces SET legal_hold = 1 WHERE id = ?', ws(owner));
    expect((await owner.agent.delete(`/api/files/${big.id}`)).status).toBe(403);
    await db().run('UPDATE workspaces SET legal_hold = 0 WHERE id = ?', ws(owner));
    expect((await owner.agent.delete(`/api/files/${big.id}`).expect(200)).body.freed_bytes).toBe(300 * MB);
    expect(await storageUsed(db(), ws(owner))).toBe(0);
    await owner.agent.get(`/api/files/${big.id}`).expect(404);
    await upload(owner.agent).expect(201);
  });
});

describe('when a trial ends over the Free allowances', () => {
  it('keeps everything available, pauses only what would add more, and resumes once within the limits', async () => {
    env = saas();
    const owner = await verifiedOwner();
    const people = [];
    for (let i = 0; i < 4; i++) people.push(await invite(env, owner.agent));
    const projects = [];
    for (let i = 0; i < 4; i++) projects.push((await owner.agent.post('/api/projects').send({ name: `Trial ${i}` }).expect(201)).body);
    const file = await fill(owner.agent, 300 * MB);
    const general = (await owner.agent.get('/api/channels')).body.find((c: { name: string }) => c.name === 'general');

    await endTrial(ws(owner));
    const usage = (await owner.agent.get('/api/billing')).body.usage;
    expect(usage).toMatchObject({ members: 5, member_limit: 3, projects: 4, project_limit: 2, storage_bytes: 300 * MB });

    // Nothing is deleted, and everyone can still read, download and export.
    expect((await db().get('SELECT COUNT(*) AS n FROM memberships WHERE workspace_id = ? AND deactivated_at IS NULL', ws(owner)))!.n).toBe(5);
    await people[3].agent.get(`/api/projects/${projects[3].id}`).expect(200);
    await people[3].agent.get(`/api/files/${file.id}`).expect(200);
    await owner.agent.get(`/api/files/${file.id}/download`).expect(200);
    await owner.agent.get('/api/export').expect(200);
    // Everyday work in existing projects carries on.
    await people[3].agent.post('/api/tasks').send({ title: 'Still working', projectId: projects[3].id }).expect(201);
    await people[3].agent.post(`/api/channels/${general.id}/messages`).send({ body: 'Still here' }).expect(201);

    // Adding more of what's over is paused.
    expect(limit(await owner.agent.post('/api/admin/invitations').send({ email: 'more@example.com' }))).toEqual([402, 'members']);
    expect(limit(await owner.agent.post('/api/projects').send({ name: 'More' }))).toEqual([402, 'projects']);
    expect(limit(await upload(owner.agent))).toEqual([402, 'storage']);

    // Reducing usage brings each back.
    for (const p of projects.slice(0, 3)) await owner.agent.patch(`/api/projects/${p.id}`).send({ archived: true }).expect(200);
    await owner.agent.post('/api/projects').send({ name: 'Fresh start' }).expect(201);
    await owner.agent.delete(`/api/files/${file.id}`).expect(200);
    await upload(owner.agent).expect(201);
    for (const p of people.slice(0, 3)) await owner.agent.patch(`/api/admin/members/${p.id}`).send({ deactivated: true }).expect(200);
    await owner.agent.post('/api/admin/invitations').send({ email: 'back@example.com' }).expect(201);
  });

  it('warns admins as Free storage fills up', async () => {
    env = saas();
    const owner = await verifiedOwner();
    await endTrial(ws(owner));
    await fill(owner.agent, 210 * MB);
    const { processBillingNotices } = await import('../src/routes/billing.js');
    await processBillingNotices(env.softex.ctx);
    await flushJobs(env);
    const mail = env.sent.find((m) => m.to === owner.email && /84% of its file storage/.test(m.subject));
    expect(mail?.text).toContain('210 MB of 250 MB');
  });
});
