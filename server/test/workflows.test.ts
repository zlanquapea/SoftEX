import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { invite, registerOwner, setup, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeEach(() => (env = setup()));
afterEach(() => env.cleanup());

const today = () => new Date().toISOString().slice(0, 10);

describe('turn a discussion into delivery (§6)', () => {
  it('links discussion, decision, task and My work', async () => {
    const owner = await registerOwner(env, 'Lead');
    const member = await invite(env, owner.agent, 'member', {}, 'Maya');
    const project = (await owner.agent.post('/api/projects').send({ name: 'Brand refresh', memberIds: [member.id] })).body;
    expect(project.channel_id).toBeTruthy();
    const channelId = project.channel_id;

    const msg = (
      await owner.agent.post(`/api/channels/${channelId}/messages`).send({ body: `We should ship the new logo @[Maya](${member.id})` })
    ).body;
    const mentions = (await member.agent.get('/api/notifications').query({ filter: 'mentions' })).body.notifications;
    expect(mentions[0].kind).toBe('mention');

    const reply = await member.agent.post(`/api/channels/${channelId}/messages`).send({ body: 'Agreed', parentId: msg.id });
    expect(reply.status).toBe(201);
    const thread = (await owner.agent.get(`/api/messages/${msg.id}/thread`)).body;
    expect(thread.replies).toHaveLength(1);

    const decision = await owner.agent.post('/api/decisions').send({ title: 'Adopt the new logo', messageId: msg.id });
    expect(decision.status).toBe(201);
    expect(decision.body.project_id).toBe(project.id);

    const task = (await owner.agent.post(`/api/messages/${msg.id}/task`).send({ ownerId: member.id, dueDate: today() })).body;
    expect(task.project.id).toBe(project.id);
    expect(task.source_message_id).toBe(msg.id);

    const work = (await member.agent.get('/api/my-work')).body;
    expect(work.today.map((t: { id: string }) => t.id)).toContain(task.id);

    const messages = (await owner.agent.get(`/api/channels/${channelId}/messages`)).body.messages;
    const linked = messages.find((m: { id: string }) => m.id === msg.id);
    expect(linked.tasks).toHaveLength(1);
    expect(linked.decisions).toHaveLength(1);
    expect(linked.reply_count).toBe(1);

    await member.agent.patch(`/api/tasks/${task.id}`).send({ status: 'done' });
    const overview = (await owner.agent.get(`/api/projects/${project.id}`)).body;
    expect(overview.stats.done).toBe(1);
    const summary = (await owner.agent.get(`/api/projects/${project.id}/summary`)).body;
    expect(summary.completed).toHaveLength(1);
    expect(summary.decisions).toHaveLength(1);
  });

  it('runs a project meeting with decisions and follow-up tasks', async () => {
    const owner = await registerOwner(env);
    const member = await invite(env, owner.agent);
    const project = (await owner.agent.post('/api/projects').send({ name: 'Mobile app', memberIds: [member.id] })).body;
    const meeting = (
      await owner.agent.post('/api/meetings').send({
        title: 'Sprint review',
        startsAt: new Date(Date.now() + 3600_000).toISOString(),
        projectId: project.id,
        participantIds: [member.id],
        agenda: '1. Demo\n2. Next steps',
      })
    ).body;
    expect(meeting.video_url).toMatch(/^https:\/\/meet\.jit\.si\//);
    expect((await member.agent.get('/api/notifications')).body.notifications[0].kind).toBe('meeting');

    await member.agent.patch(`/api/meetings/${meeting.id}`).send({ notes: 'Demo went well' });
    expect((await member.agent.patch(`/api/meetings/${meeting.id}`).send({ title: 'Renamed' })).status).toBe(403);
    await owner.agent.post('/api/decisions').send({ title: 'Ship beta', meetingId: meeting.id });
    await owner.agent.post('/api/tasks').send({ title: 'Prepare beta build', meetingId: meeting.id, projectId: project.id, ownerId: member.id });
    await owner.agent.post(`/api/meetings/${meeting.id}/end`);
    const detail = (await member.agent.get(`/api/meetings/${meeting.id}`)).body;
    expect(detail.notes).toBe('Demo went well');
    expect(detail.decisions).toHaveLength(1);
    expect(detail.tasks).toHaveLength(1);
    expect(detail.ended_at).toBeTruthy();
    const ics = await member.agent.get(`/api/meetings/${meeting.id}/ics`);
    expect(ics.text).toContain('BEGIN:VCALENDAR');
  });

  it('finds an approved policy page with its owner and review date', async () => {
    const owner = await registerOwner(env);
    const member = await invite(env, owner.agent);
    const page = (
      await owner.agent.post('/api/pages').send({ title: 'Travel policy', body: 'Book economy for flights under 6 hours.', status: 'approved', reviewDate: '2027-01-01' })
    ).body;
    const results = (await member.agent.get('/api/search').query({ q: 'economy' })).body;
    expect(results.pages[0]).toMatchObject({ id: page.id, status: 'approved', review_date: '2027-01-01' });
    await member.agent.patch(`/api/pages/${page.id}`).send({ body: 'Book economy for all flights.' });
    const detail = (await owner.agent.get(`/api/pages/${page.id}`)).body;
    expect(detail.version).toBe(2);
    expect(detail.versions).toHaveLength(2);
  });

  it('tracks dependencies, notifies handoffs and rejects cycles', async () => {
    const owner = await registerOwner(env);
    const member = await invite(env, owner.agent);
    const project = (await owner.agent.post('/api/projects').send({ name: 'Launch', memberIds: [member.id] })).body;
    const a = (await owner.agent.post('/api/tasks').send({ title: 'Design', projectId: project.id })).body;
    const b = (await owner.agent.post('/api/tasks').send({ title: 'Build', projectId: project.id, ownerId: member.id })).body;
    expect((await owner.agent.post(`/api/tasks/${b.id}/dependencies`).send({ dependsOnId: a.id })).status).toBe(201);
    expect((await owner.agent.post(`/api/tasks/${a.id}/dependencies`).send({ dependsOnId: b.id })).status).toBe(400);
    await owner.agent.patch(`/api/tasks/${a.id}`).send({ status: 'done' });
    const inbox = (await member.agent.get('/api/notifications')).body.notifications;
    expect(inbox.some((n: { kind: string }) => n.kind === 'handoff')).toBe(true);
  });

  it('creates the next occurrence of a recurring task', async () => {
    const owner = await registerOwner(env);
    const t = (await owner.agent.post('/api/tasks').send({ title: 'Weekly report', dueDate: '2026-09-24', recurrence: 'weekly' })).body;
    await owner.agent.patch(`/api/tasks/${t.id}`).send({ status: 'done' });
    const work = (await owner.agent.get('/api/my-work')).body;
    const all = [...work.later, ...work.upcoming, ...work.today, ...work.overdue];
    expect(all.find((x: { title: string; due_date: string }) => x.title === 'Weekly report')?.due_date).toBe('2026-10-01');
  });

  it('routes approval requests to the approver', async () => {
    const owner = await registerOwner(env);
    const member = await invite(env, owner.agent);
    const reqRes = await member.agent.post('/api/requests').send({ kind: 'purchase', title: 'New laptop', approverId: owner.me.user.id });
    expect(reqRes.status).toBe(201);
    expect((await member.agent.post(`/api/requests/${reqRes.body.id}/decide`).send({ status: 'approved' })).status).toBe(403);
    expect((await owner.agent.post(`/api/requests/${reqRes.body.id}/decide`).send({ status: 'approved' })).status).toBe(200);
    const inbox = (await member.agent.get('/api/notifications')).body.notifications;
    expect(inbox[0].title).toContain('approved');
  });

  it('builds the home screen', async () => {
    const owner = await registerOwner(env);
    await owner.agent.post('/api/tasks').send({ title: 'Due today', dueDate: today() });
    const home = (await owner.agent.get('/api/home')).body;
    expect(home.focus).toHaveLength(1);
    expect(home.counts.open_tasks).toBe(1);
  });
});

describe('files', () => {
  it('uploads, versions and downloads with permission checks', async () => {
    const owner = await registerOwner(env);
    const member = await invite(env, owner.agent);
    const project = (await owner.agent.post('/api/projects').send({ name: 'Secret', visibility: 'private' })).body;
    const up = await owner.agent.post('/api/files').field('projectId', project.id).attach('file', Buffer.from('hello world'), 'notes.txt');
    expect(up.status).toBe(201);
    const v2 = await owner.agent.post(`/api/files/${up.body.id}/versions`).attach('file', Buffer.from('hello again'), 'notes.txt');
    expect(v2.body.version).toBe(2);
    const dl = await owner.agent.get(`/api/files/${up.body.id}/download`).query({ version: 1 });
    expect(dl.status).toBe(200);
    expect(dl.headers['content-disposition']).toContain('attachment');
    expect((await member.agent.get(`/api/files/${up.body.id}/download`)).status).toBe(404);
  });

  it('refuses executables and malware test signatures', async () => {
    const owner = await registerOwner(env);
    const exe = await owner.agent.post('/api/files').attach('file', Buffer.from('MZ....'), 'setup.exe');
    expect(exe.status).toBe(400);
    const eicar = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
    const infected = await owner.agent.post('/api/files').attach('file', Buffer.from(eicar), 'readme.txt');
    expect(infected.status).toBe(400);
    const audit = (await owner.agent.get('/api/admin/audit')).body;
    expect(audit.filter((e: { action: string }) => e.action === 'file.upload_rejected')).toHaveLength(2);
  });
});
