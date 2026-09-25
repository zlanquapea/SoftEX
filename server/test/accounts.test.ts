import { existsSync, readdirSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { invite, registerOwner, setup, type TestEnv } from './helpers.js';

let env: TestEnv;
afterEach(() => env?.cleanup());
const db = () => env.softex.ctx.db;
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

/** Fill a workspace with one of nearly everything, so deletion has to cascade through it all. */
async function populate(owner: Awaited<ReturnType<typeof registerOwner>>, member: Awaited<ReturnType<typeof invite>>) {
  const a = owner.agent;
  const general = (await a.get('/api/channels')).body.find((c: { name: string }) => c.name === 'general');
  const root = (await a.post(`/api/channels/${general.id}/messages`).send({ body: `Hi @[M](${member.id})` })).body;
  const reply = (await member.agent.post(`/api/channels/${general.id}/messages`).send({ body: 'reply', parentId: root.id })).body;
  await a.post(`/api/messages/${reply.id}/reactions`).send({ emoji: '👍' });
  await a.post(`/api/messages/${root.id}/pin`);
  await member.agent.post(`/api/messages/${root.id}/save`);
  const project = (await a.post('/api/projects').send({ name: 'Launch', memberIds: [member.id] })).body;
  await a.post(`/api/projects/${project.id}/milestones`).send({ name: 'Beta', dueDate: day(10) });
  await a.post(`/api/projects/${project.id}/risks`).send({ title: 'Vendor delay', likelihood: 'medium', impact: 'high' });
  await a.post(`/api/projects/${project.id}/updates`).send({ health: 'on_track', body: 'Going well' });
  const task = (await a.post(`/api/messages/${root.id}/task`).send({ title: 'From chat', projectId: project.id, ownerId: member.id })).body;
  const task2 = (await a.post('/api/tasks').send({ title: 'Second', projectId: project.id, dueDate: day(-1) })).body;
  await a.post(`/api/tasks/${task.id}/checklist`).send({ text: 'Step' });
  await a.post(`/api/tasks/${task.id}/comments`).send({ body: 'Comment' });
  await a.post(`/api/tasks/${task2.id}/dependencies`).send({ dependsOnId: task.id });
  await a.post('/api/decisions').send({ title: 'Go', rationale: 'Yes', projectId: project.id, messageId: root.id });
  const page = (await a.post('/api/pages').send({ title: 'Handbook', body: 'v1', projectId: project.id })).body;
  await a.patch(`/api/pages/${page.id}`).send({ body: 'v2' });
  const file = (await a.post('/api/files').field('channelId', general.id).attach('file', Buffer.from('hello world'), 'notes.txt')).body;
  await a.post(`/api/files/${file.id}/versions`).attach('file', Buffer.from('hello again'), 'notes.txt');
  await a.post('/api/meetings').send({ title: 'Kickoff', startsAt: new Date(Date.now() + 86_400_000).toISOString(), durationMin: 30, participantIds: [member.id], projectId: project.id });
  await a.post(`/api/projects/${project.id}/automations`).send({ name: 'Rule', triggerType: 'task.created', actionType: 'set_priority', actionConfig: { priority: 'high' } });
  await a.post('/api/reminders').send({ remindAt: new Date(Date.now() + 3_600_000).toISOString(), note: 'Ping', taskId: task.id });
  await a.post(`/api/channels/${general.id}/scheduled-messages`).send({ body: 'Later', sendAt: new Date(Date.now() + 3_600_000).toISOString() });
  await a.post('/api/teams').send({ name: 'Ops', memberIds: [member.id] });
  await a.post('/api/requests').send({ title: 'Laptop', kind: 'purchase', approverId: member.id });
  await a.post('/api/admin/invitations').send({ email: 'pending@example.com', role: 'member' });
  return { project, file };
}

describe('deleting a workspace', () => {
  it('removes every record and uploaded file, and leaves other workspaces alone', async () => {
    env = setup();
    const owner = await registerOwner(env, 'Ada');
    const member = await invite(env, owner.agent);
    await populate(owner, member);
    const other = await registerOwner(env, 'Other');
    await other.agent.post('/api/projects').send({ name: 'Untouched' });
    const wsId = owner.me.workspace.id;
    const uploads = env.softex.ctx.config.uploadDir;
    const stored = () => readdirSync(uploads).filter((f) => f !== 'incoming');
    expect(stored().length).toBe(2);

    for (const table of ['meetings', 'decisions', 'risks', 'automations', 'reminders', 'scheduled_messages', 'requests', 'page_versions', 'task_dependencies', 'status_updates', 'milestones', 'reactions', 'saved_messages', 'teams', 'invitations', 'notifications', 'checklist_items', 'task_comments']) {
      expect([table, (await db().get(`SELECT COUNT(*) AS n FROM ${table}`))!.n]).not.toEqual([table, 0]);
    }
    // Wrong password, wrong name, and non-owners are refused.
    expect((await owner.agent.delete('/api/admin/workspace').send({ password: 'nope', confirmName: "Ada's Co" })).status).toBe(401);
    expect((await owner.agent.delete('/api/admin/workspace').send({ password: 'password123', confirmName: 'Ada' })).status).toBe(400);
    expect((await member.agent.delete('/api/admin/workspace').send({ password: 'password123', confirmName: "Ada's Co" })).status).toBe(403);

    const res = await owner.agent.delete('/api/admin/workspace').send({ password: 'password123', confirmName: "Ada's Co" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: true, me: null });

    const tables = (
      db().dialect === 'postgres'
        ? await db().all(`SELECT table_name AS name FROM information_schema.columns WHERE column_name = 'workspace_id' AND table_schema = current_schema() AND table_name != 'platform_events'`)
        : await db().all(`SELECT name FROM sqlite_master WHERE type = 'table' AND sql LIKE '%workspace_id%' AND name != 'platform_events'`)
    ).map((t) => t.name);
    for (const table of tables) expect([table, (await db().get(`SELECT COUNT(*) AS n FROM ${table} WHERE workspace_id = ?`, wsId))!.n]).toEqual([table, 0]);
    // Child tables without a workspace_id column cascade too (the other workspace has none of these rows).
    for (const table of ['messages', 'status_updates', 'page_versions', 'task_dependencies', 'checklist_items', 'task_comments', 'reactions', 'saved_messages', 'milestones', 'meeting_participants', 'automation_runs', 'team_members']) {
      expect([table, (await db().get(`SELECT COUNT(*) AS n FROM ${table}`))!.n]).toEqual([table, 0]);
    }
    expect((await db().get('SELECT COUNT(*) AS n FROM file_versions'))!.n).toBe(0);
    expect(stored().length).toBe(0);
    expect(await db().get(`SELECT * FROM platform_events WHERE action = 'workspace.deleted'`)).toMatchObject({ workspace_id: wsId, workspace_name: "Ada's Co", actor: owner.email });

    // Everyone is signed out of it; the other workspace still works.
    expect((await owner.agent.get('/api/me')).status).toBe(401);
    expect((await member.agent.get('/api/me')).status).toBe(401);
    expect((await other.agent.get('/api/projects')).body.map((p: { name: string }) => p.name)).toContain('Untouched');
    expect(existsSync(uploads)).toBe(true);
  });

  it('continues in the owner’s next workspace when they have one', async () => {
    env = setup();
    const first = await registerOwner(env, 'First');
    const second = await registerOwner(env, 'Second');
    const inv = await second.agent.post('/api/admin/invitations').send({ email: first.email, role: 'admin' });
    await first.agent.post(`/api/invitations/${inv.body.token}/accept`).send({ password: 'password123' });
    await first.agent.post('/api/me/switch-workspace').send({ workspaceId: first.me.workspace.id });
    const res = await first.agent.delete('/api/admin/workspace').send({ password: 'password123', confirmName: "First's Co" });
    expect(res.body.me.workspace.name).toBe("Second's Co");
    expect((await first.agent.get('/api/me')).body.workspace.name).toBe("Second's Co");
  });
});

describe('deleting an account', () => {
  it('erases personal data but keeps the workspace’s content', async () => {
    env = setup();
    const owner = await registerOwner(env, 'Ada');
    const member = await invite(env, owner.agent, 'member', {}, 'Grace Hopper');
    const general = (await member.agent.get('/api/channels')).body.find((c: { name: string }) => c.name === 'general');
    await member.agent.post(`/api/channels/${general.id}/messages`).send({ body: 'Still here after I leave' });
    await member.agent.post('/api/integrations/tokens').send({ name: 'script' });

    const token = (await member.agent.post('/api/integrations/tokens').send({ name: 'writer', scope: 'write' })).body.token;
    expect((await env.agent().delete('/api/me').set('Authorization', `Bearer ${token}`).send({ password: 'password123' })).status).toBe(403);
    expect((await member.agent.delete('/api/me').send({ password: 'wrong' })).status).toBe(401);
    expect((await member.agent.delete('/api/me').send({ password: 'password123' })).status).toBe(200);

    const user = (await db().get('SELECT * FROM users WHERE id = ?', member.id))!;
    expect(user.name).toBe('Deleted user');
    expect(user.email).not.toContain('example.com');
    expect((await db().get('SELECT COUNT(*) AS n FROM api_tokens WHERE user_id = ? AND revoked_at IS NULL', member.id))!.n).toBe(0);
    expect((await member.agent.get('/api/me')).status).toBe(401);
    expect((await env.agent().post('/api/auth/login').send({ email: member.email, password: 'password123' })).status).toBe(401);
    const messages = (await owner.agent.get(`/api/channels/${general.id}/messages`)).body.messages;
    expect(messages.find((m: { body: string }) => m.body === 'Still here after I leave').user.name).toBe('Deleted user');
    // The address can be used again for a fresh account.
    expect((await env.agent().post('/api/auth/register').send({ name: 'G', email: member.email, password: 'password123', workspaceName: 'New Co' })).status).toBe(201);
  });

  it('refuses while you are the only owner of a workspace', async () => {
    env = setup();
    const owner = await registerOwner(env, 'Ada');
    const member = await invite(env, owner.agent, 'admin');
    const res = await owner.agent.delete('/api/me').send({ password: 'password123' });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("Ada's Co");
    await owner.agent.patch(`/api/admin/members/${member.id}`).send({ role: 'owner' });
    expect((await owner.agent.delete('/api/me').send({ password: 'password123' })).status).toBe(200);
  });
});
