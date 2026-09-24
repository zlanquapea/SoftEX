import { afterEach, describe, expect, it } from 'vitest';
import { applyRetention, processDeadlines } from '../src/routes/productivity.js';
import { flushJobs, invite, registerOwner, setup, type TestEnv } from './helpers.js';

let env: TestEnv;
afterEach(() => env?.cleanup());

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const db = () => env.softex.ctx.db;

describe('automations', () => {
  it('runs project rules on task events and logs every run', async () => {
    env = setup();
    const owner = await registerOwner(env);
    const reviewer = await invite(env, owner.agent, 'member', {}, 'Rita Reviewer');
    const member = await invite(env, owner.agent);
    const project = (await owner.agent.post('/api/projects').send({ name: 'Launch', memberIds: [reviewer.id, member.id] })).body;

    // Only people who manage the project can add rules.
    const denied = await member.agent.post(`/api/projects/${project.id}/automations`).send({ name: 'x', triggerType: 'task.created', actionType: 'set_priority', actionConfig: { priority: 'high' } });
    expect(denied.status).toBe(403);

    const handoff = await owner.agent.post(`/api/projects/${project.id}/automations`).send({
      name: 'Hand off for review',
      triggerType: 'task.status_changed',
      triggerConfig: { to_status: 'review' },
      actionType: 'assign',
      actionConfig: { target: 'user', user_id: reviewer.id },
    });
    expect(handoff.status).toBe(201);
    await owner.agent.post(`/api/projects/${project.id}/automations`).send({
      name: 'Definition of done',
      triggerType: 'task.created',
      actionType: 'add_checklist',
      actionConfig: { items: ['Tests written', 'Docs updated'] },
    });
    await owner.agent.post(`/api/projects/${project.id}/automations`).send({
      name: 'Announce completions',
      triggerType: 'task.status_changed',
      triggerConfig: { to_status: 'done' },
      actionType: 'post_message',
      actionConfig: { channel_id: project.channel_id, text: '{{task}} shipped 🎉' },
    });

    const task = (await member.agent.post('/api/tasks').send({ title: 'Write release notes', projectId: project.id, ownerId: member.id })).body;
    const detail = (await member.agent.get(`/api/tasks/${task.id}`)).body;
    expect(detail.checklist.map((c: { text: string }) => c.text)).toEqual(['Tests written', 'Docs updated']);

    await member.agent.patch(`/api/tasks/${task.id}`).send({ status: 'review' });
    expect((await owner.agent.get(`/api/tasks/${task.id}`)).body.owner.id).toBe(reviewer.id);
    const inbox = (await reviewer.agent.get('/api/notifications')).body.notifications;
    expect(inbox.some((n: { title: string }) => n.title.includes('Hand off for review'))).toBe(true);

    await reviewer.agent.patch(`/api/tasks/${task.id}`).send({ status: 'done' });
    const messages = (await owner.agent.get(`/api/channels/${project.channel_id}/messages`)).body.messages;
    expect(messages.at(-1).body).toContain('Write release notes shipped');

    const runs = (await owner.agent.get(`/api/automations/${handoff.body.id}/runs`)).body;
    expect(runs[0]).toMatchObject({ outcome: 'done', task: { title: 'Write release notes' } });
  });

  it('refuses to post into private channels from other projects', async () => {
    env = setup();
    const owner = await registerOwner(env);
    const project = (await owner.agent.post('/api/projects').send({ name: 'Alpha' })).body;
    const secret = (await owner.agent.post('/api/channels').send({ name: 'secret', kind: 'private' })).body;
    const res = await owner.agent.post(`/api/projects/${project.id}/automations`).send({
      name: 'Leak',
      triggerType: 'task.created',
      actionType: 'post_message',
      actionConfig: { channel_id: secret.id },
    });
    expect(res.status).toBe(400);
  });
});

describe('deadlines, reminders and scheduled messages', () => {
  it('reminds owners once before and after the due date, and fires overdue rules', async () => {
    env = setup();
    const owner = await registerOwner(env);
    const project = (await owner.agent.post('/api/projects').send({ name: 'Ops' })).body;
    await owner.agent.post(`/api/projects/${project.id}/automations`).send({
      name: 'Escalate overdue',
      triggerType: 'task.overdue',
      actionType: 'set_priority',
      actionConfig: { priority: 'urgent' },
    });
    const soon = (await owner.agent.post('/api/tasks').send({ title: 'Renew domain', projectId: project.id, dueDate: day(1) })).body;
    const late = (await owner.agent.post('/api/tasks').send({ title: 'File taxes', projectId: project.id, dueDate: day(-2) })).body;
    // The creator is the owner, so notifications about their own actions are skipped; hand the tasks to someone else.
    const member = await invite(env, owner.agent);
    await owner.agent.post(`/api/projects/${project.id}/members`).send({ userIds: [member.id] });
    await owner.agent.patch(`/api/tasks/${soon.id}`).send({ ownerId: member.id });
    await owner.agent.patch(`/api/tasks/${late.id}`).send({ ownerId: member.id });

    expect(processDeadlines(env.softex.ctx)).toBe(2);
    expect(processDeadlines(env.softex.ctx)).toBe(0);
    const titles = (await member.agent.get('/api/notifications')).body.notifications.map((n: { title: string }) => n.title);
    expect(titles).toEqual(expect.arrayContaining(['“Renew domain” is due tomorrow', '“File taxes” is overdue']));
    expect((await owner.agent.get(`/api/tasks/${late.id}`)).body.priority).toBe('urgent');
  });

  it('delivers personal reminders only for things the person can still see', async () => {
    env = setup();
    const owner = await registerOwner(env);
    const general = (await owner.agent.get('/api/channels')).body.find((c: { name: string }) => c.name === 'general');
    const msg = (await owner.agent.post(`/api/channels/${general.id}/messages`).send({ body: 'Budget due Friday' })).body;
    const r1 = await owner.agent.post('/api/reminders').send({ messageId: msg.id, remindAt: new Date(Date.now() + 3_600_000).toISOString() });
    expect(r1.status).toBe(201);
    expect((await owner.agent.get('/api/reminders')).body).toHaveLength(1);
    db().run('UPDATE reminders SET remind_at = ?', new Date(Date.now() - 1000).toISOString());
    await flushJobs(env);
    // Reminders are about the person's own content, so they are delivered even though they are the actor.
    const rows = db().all(`SELECT title, link FROM notifications WHERE kind = 'reminder'`);
    expect(rows[0].link).toContain(`/channels/${general.id}`);
    expect((await owner.agent.get('/api/reminders')).body).toHaveLength(0);

    const member = await invite(env, owner.agent);
    const secret = (await owner.agent.post('/api/channels').send({ name: 'secret', kind: 'private' })).body;
    const hidden = (await owner.agent.post(`/api/channels/${secret.id}/messages`).send({ body: 'private' })).body;
    expect((await member.agent.post('/api/reminders').send({ messageId: hidden.id, remindAt: new Date(Date.now() + 60_000).toISOString() })).status).toBe(404);
  });

  it('sends scheduled messages later as their author, and fails safely if access was lost', async () => {
    env = setup();
    const owner = await registerOwner(env);
    const member = await invite(env, owner.agent);
    const general = (await member.agent.get('/api/channels')).body.find((c: { name: string }) => c.name === 'general');
    const scheduled = await member.agent.post(`/api/channels/${general.id}/scheduled-messages`).send({ body: 'Good morning team', sendAt: new Date(Date.now() + 3_600_000).toISOString() });
    expect(scheduled.status).toBe(201);
    expect((await member.agent.post(`/api/channels/${general.id}/scheduled-messages`).send({ body: 'too soon', sendAt: new Date().toISOString() })).status).toBe(400);
    db().run('UPDATE scheduled_messages SET send_at = ?', new Date(Date.now() - 1000).toISOString());
    await flushJobs(env);
    const messages = (await owner.agent.get(`/api/channels/${general.id}/messages`)).body.messages;
    expect(messages.at(-1)).toMatchObject({ body: 'Good morning team', user: { id: member.id } });
    expect((await member.agent.get('/api/scheduled-messages')).body).toHaveLength(0);

    const secret = (await owner.agent.post('/api/channels').send({ name: 'secret', kind: 'private', memberIds: [member.id] })).body;
    await member.agent.post(`/api/channels/${secret.id}/scheduled-messages`).send({ body: 'later', sendAt: new Date(Date.now() + 3_600_000).toISOString() });
    await owner.agent.delete(`/api/channels/${secret.id}/members/${member.id}`);
    db().run('UPDATE scheduled_messages SET send_at = ? WHERE sent_message_id IS NULL', new Date(Date.now() - 1000).toISOString());
    await flushJobs(env);
    expect(db().get(`SELECT failed_reason FROM scheduled_messages WHERE body = 'later'`)!.failed_reason).toBeTruthy();
    expect((await owner.agent.get(`/api/channels/${secret.id}/messages`)).body.messages).toHaveLength(0);
  });
});

describe('retention and legal hold', () => {
  it('deletes old messages unless a legal hold is in place', async () => {
    env = setup();
    const owner = await registerOwner(env);
    const general = (await owner.agent.get('/api/channels')).body.find((c: { name: string }) => c.name === 'general');
    await owner.agent.post(`/api/channels/${general.id}/messages`).send({ body: 'ancient' });
    await owner.agent.post(`/api/channels/${general.id}/messages`).send({ body: 'recent' });
    const thread = (await owner.agent.post(`/api/channels/${general.id}/messages`).send({ body: 'old thread, still active' })).body;
    await owner.agent.post(`/api/channels/${general.id}/messages`).send({ body: 'fresh reply', parentId: thread.id });
    db().run(`UPDATE messages SET created_at = ? WHERE body IN ('ancient', 'old thread, still active')`, new Date(Date.now() - 400 * 86_400_000).toISOString());
    expect((await owner.agent.patch('/api/admin/workspace').send({ retentionDays: 10 })).status).toBe(400); // minimum 30 days
    await owner.agent.patch('/api/admin/workspace').send({ retentionDays: 365, legalHold: true });
    expect(applyRetention(env.softex.ctx)).toBe(0);
    await owner.agent.patch('/api/admin/workspace').send({ legalHold: false });
    expect(applyRetention(env.softex.ctx)).toBe(1);
    const bodies = (await owner.agent.get(`/api/channels/${general.id}/messages`)).body.messages.map((m: { body: string }) => m.body);
    expect(bodies).toEqual(expect.arrayContaining(['recent', 'old thread, still active']));
    expect(bodies).not.toContain('ancient');
    const auditLog = (await owner.agent.get('/api/admin/audit').query({ action: 'retention' })).body;
    expect(auditLog[0].detail.count).toBe(1);
  });
});

describe('planning views and insights', () => {
  it('shows workload per person per week and insights for leads', async () => {
    env = setup();
    const owner = await registerOwner(env, 'Olu');
    const member = await invite(env, owner.agent);
    const project = (await owner.agent.post('/api/projects').send({ name: 'Plan', memberIds: [member.id] })).body;
    await owner.agent.post('/api/tasks').send({ title: 'A', projectId: project.id, ownerId: member.id, dueDate: day(0), estimateHours: 6, startDate: day(-2) });
    await owner.agent.post('/api/tasks').send({ title: 'B', projectId: project.id, ownerId: member.id, dueDate: day(-5), estimateHours: 2 });
    await owner.agent.post('/api/tasks').send({ title: 'C', projectId: project.id, ownerId: member.id });
    const workload = (await owner.agent.get('/api/workload').query({ weeks: 2 })).body;
    const row = workload.rows.find((r: { person: { id: string } }) => r.person.id === member.id);
    expect(row.total).toBe(3);
    expect(row.buckets.overdue.tasks).toBe(1);
    expect(row.buckets.unscheduled.tasks).toBe(1);
    const thisWeek = row.buckets[workload.weeks[0]];
    expect(thisWeek).toMatchObject({ tasks: 1, hours: 6 });

    const insights = await owner.agent.get('/api/admin/insights');
    expect(insights.status).toBe(200);
    expect(insights.body.measures.find((m: { id: string }) => m.id === 'ownership').value).toBe(100);
    expect(insights.body.weekly).toHaveLength(8);
    expect((await member.agent.get('/api/admin/insights')).status).toBe(403);
  });
});

describe('SCIM provisioning', () => {
  it('lets an identity provider create, find, update and deactivate members', async () => {
    env = setup();
    const owner = await registerOwner(env);
    const member = await invite(env, owner.agent);
    expect((await member.agent.post('/api/admin/scim/token')).status).toBe(403);
    const { token } = (await owner.agent.post('/api/admin/scim/token')).body;
    const scim = () => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/scim+json' });
    expect((await env.agent().get('/scim/v2/Users')).status).toBe(401);

    const created = await env.agent().post('/scim/v2/Users').set(scim()).send(
      JSON.stringify({ schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'], userName: 'Ada@Corp.example', name: { givenName: 'Ada', familyName: 'Lovelace' }, externalId: 'okta-1', active: true }),
    );
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ userName: 'ada@corp.example', displayName: 'Ada Lovelace', active: true, externalId: 'okta-1' });
    const dup = await env.agent().post('/scim/v2/Users').set(scim()).send(JSON.stringify({ userName: 'ada@corp.example' }));
    expect(dup.status).toBe(409);

    const found = (await env.agent().get('/scim/v2/Users').set(scim()).query({ filter: 'userName eq "ada@corp.example"' })).body;
    expect(found.totalResults).toBe(1);

    // The new person can reset a password and sign in until deprovisioned.
    const people = (await owner.agent.get('/api/people')).body;
    expect(people.some((p: { email: string }) => p.email === 'ada@corp.example')).toBe(true);

    const patched = await env.agent().patch(`/scim/v2/Users/${member.id}`).set(scim()).send(
      JSON.stringify({ schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: [{ op: 'replace', value: { active: false } }] }),
    );
    expect(patched.body.active).toBe(false);
    expect((await member.agent.get('/api/me')).status).toBe(401);
    expect((await env.agent().delete(`/scim/v2/Users/${owner.me.user.id}`).set(scim())).status).toBe(400);
  });
});

describe('PDF search', () => {
  it('indexes text inside PDFs', async () => {
    env = setup();
    const owner = await registerOwner(env);
    const pdf = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 144]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 58>>stream
BT /F1 18 Tf 20 60 Td (Vendor contract Kigali office) Tj ET
endstream endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
trailer<</Root 1 0 R>>
%%EOF`;
    expect((await owner.agent.post('/api/files').attach('file', Buffer.from(pdf), 'contract.pdf')).status).toBe(201);
    const files = (await owner.agent.get('/api/search').query({ q: 'Kigali', type: 'files' })).body.files;
    expect(files[0]).toMatchObject({ name: 'contract.pdf' });
  });
});

describe('Ask SoftEX', () => {
  it('answers from permitted sources only, with citations', async () => {
    const prompts: string[] = [];
    env = setup({ ai: { complete: async ({ prompt }) => (prompts.push(prompt), { text: 'Economy class for short flights [1].', refused: false }) } });
    const owner = await registerOwner(env);
    const member = await invite(env, owner.agent);
    await owner.agent.patch('/api/admin/workspace').send({ aiEnabled: true });
    await owner.agent.post('/api/pages').send({ title: 'Travel policy', body: 'Book economy flights under 6 hours.', status: 'approved' });
    const secret = (await owner.agent.post('/api/channels').send({ name: 'exec', kind: 'private' })).body;
    await owner.agent.post(`/api/channels/${secret.id}/messages`).send({ body: 'Secret: executives may fly business on any flights' });

    const res = await member.agent.post('/api/ai/ask').send({ question: 'Which class of flights can we book?' });
    expect(res.status).toBe(200);
    expect(res.body.answer).toContain('[1]');
    expect(res.body.sources[0]).toMatchObject({ n: 1, type: 'page', link: expect.stringContaining('/knowledge/') });
    expect(prompts[0]).not.toContain('executives');
    expect(res.body.sources.some((s: { snippet: string }) => s.snippet.includes('executives'))).toBe(false);

    // The owner can see the private channel, so it is included for them.
    await owner.agent.post('/api/ai/ask').send({ question: 'Which class of flights can we book?' });
    expect(prompts[1]).toContain('executives');
  });
});
