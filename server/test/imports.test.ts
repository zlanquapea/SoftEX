import { afterEach, describe, expect, it } from 'vitest';
import { parseCsv, parseLooseDate } from '../src/csv.js';
import { flushJobs, invite, registerOwner, setup, type TestEnv } from './helpers.js';

let env: TestEnv;
afterEach(() => env?.cleanup());

describe('CSV reading', () => {
  it('handles quotes, line breaks inside quotes, BOMs and other delimiters', () => {
    expect(parseCsv('﻿Name,Notes\r\n"Plan, v2","He said ""go""\nthen left"\r\n\r\nShip,\n')).toEqual([
      ['Name', 'Notes'],
      ['Plan, v2', 'He said "go"\nthen left'],
      ['Ship', ''],
    ]);
    expect(parseCsv('Name;Due\nA;25.09.2026')).toEqual([['Name', 'Due'], ['A', '25.09.2026']]);
    expect(parseCsv('Name\tDue\nA\t2026-09-25')).toEqual([['Name', 'Due'], ['A', '2026-09-25']]);
  });

  it('reads the date formats spreadsheets use', () => {
    expect(parseLooseDate('2026-09-25')).toBe('2026-09-25');
    expect(parseLooseDate('2026-09-25T14:00:00.000Z')).toBe('2026-09-25');
    expect(parseLooseDate('9/25/2026')).toBe('2026-09-25');
    expect(parseLooseDate('25/9/2026')).toBe('2026-09-25');
    expect(parseLooseDate('25.09.2026')).toBe('2026-09-25');
    expect(parseLooseDate('Sep 25, 2026')).toBe('2026-09-25');
    expect(parseLooseDate('2026-02-30')).toBeNull();
    expect(parseLooseDate('soon')).toBeNull();
  });
});

describe('importing tasks from CSV', () => {
  it('previews, then creates tasks with owners, statuses and dates', async () => {
    env = setup();
    const owner = await registerOwner(env);
    const member = await invite(env, owner.agent, 'member', {}, 'Bo Kollie');
    const project = (await owner.agent.post('/api/projects').send({ name: 'Launch', memberIds: [member.id] })).body;
    // A Trello-style export with its own column names.
    const csv = [
      'Card Name,Card Description,List Name,Due Date,Members,Priority,Estimate',
      `Design logo,"Two options, please",Doing,2026-10-01,${member.email},High,3`,
      'Write copy,,Done,10/15/2026,Bo Kollie,,',
      'Book venue,,To Do,someday,Nobody Here,urgent,lots',
      ',missing title,,,,,',
    ].join('\n');

    const preview = (await owner.agent.post(`/api/projects/${project.id}/import/tasks`).send({ csv, dryRun: true })).body;
    expect(preview.columns).toMatchObject({ title: 'Card Name', description: 'Card Description', status: 'List Name', due: 'Due Date', owner: 'Members' });
    expect(preview.rows).toHaveLength(3);
    expect(preview.rows[0]).toMatchObject({ title: 'Design logo', status: 'in_progress', priority: 'high', due_date: '2026-10-01', owner: { id: member.id } });
    expect(preview.rows[1]).toMatchObject({ status: 'done', due_date: '2026-10-15', owner: { id: member.id } });
    expect(preview.rows[2].owner.id).toBe(owner.me.user.id);
    expect(preview.rows[2].warnings).toHaveLength(3);
    expect(preview.errors).toEqual([{ line: 5, message: 'No title' }]);
    // A preview saves nothing.
    expect((await owner.agent.get('/api/tasks').query({ projectId: project.id })).body).toHaveLength(0);

    const done = await owner.agent.post(`/api/projects/${project.id}/import/tasks`).send({ csv });
    expect(done.status).toBe(201);
    expect(done.body.created).toBe(3);
    const tasks = (await owner.agent.get('/api/tasks').query({ projectId: project.id })).body;
    expect(tasks.map((t: { title: string }) => t.title).sort()).toEqual(['Book venue', 'Design logo', 'Write copy']);
    const logo = tasks.find((t: { title: string }) => t.title === 'Design logo');
    expect(logo.estimate_hours).toBe(3);

    // The assignee gets one summary notification, not one per task.
    const notes = (await member.agent.get('/api/notifications')).body.notifications.filter((n: { kind: string }) => n.kind === 'assigned');
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toBe('You were assigned 2 imported tasks');
  });

  it('only lets people who can add tasks import, and rejects files without titles', async () => {
    env = setup();
    const owner = await registerOwner(env);
    const outsider = await invite(env, owner.agent, 'member');
    const project = (await owner.agent.post('/api/projects').send({ name: 'Private', visibility: 'private' })).body;
    expect((await outsider.agent.post(`/api/projects/${project.id}/import/tasks`).send({ csv: 'Title\nA' })).status).toBe(404);
    expect((await owner.agent.post(`/api/projects/${project.id}/import/tasks`).send({ csv: 'Foo,Bar\n1,2' })).status).toBe(400);
    const big = ['Title', ...Array.from({ length: 501 }, (_, i) => `Task ${i}`)].join('\n');
    expect((await owner.agent.post(`/api/projects/${project.id}/import/tasks`).send({ csv: big })).status).toBe(400);
  });
});

describe('bulk invitations', () => {
  it('invites every address in a pasted list or CSV, skipping members and pending invites', async () => {
    env = setup();
    const owner = await registerOwner(env);
    const member = await invite(env, owner.agent);
    await owner.agent.post('/api/admin/invitations').send({ email: 'pending@example.com' });
    await flushJobs(env);
    env.sent.length = 0;
    const text = `name,email\nAmara,amara@example.com\n"Joe, Jr.",<JOE@example.com>\n${member.email}\npending@example.com\nnot-an-email\nmailto:kofi@example.org; amara@example.com`;
    const res = await owner.agent.post('/api/admin/invitations/bulk').send({ text });
    expect(res.status).toBe(201);
    expect(res.body.invited.sort()).toEqual(['amara@example.com', 'joe@example.com', 'kofi@example.org']);
    expect(res.body.skipped).toEqual(
      expect.arrayContaining([
        { email: member.email, reason: 'Already a member' },
        { email: 'pending@example.com', reason: 'Already invited' },
      ]),
    );
    await flushJobs(env);
    expect(env.sent.map((m) => m.to).sort()).toEqual(['amara@example.com', 'joe@example.com', 'kofi@example.org']);

    // Members can't bulk-invite, and admins-by-bulk need an admin.
    expect((await member.agent.post('/api/admin/invitations/bulk').send({ text: 'x@example.com' })).status).toBe(403);
    expect((await owner.agent.post('/api/admin/invitations/bulk').send({ text: 'nothing here' })).status).toBe(400);
  });

  it('respects the plan’s member limit', async () => {
    env = setup({ mode: 'saas' });
    const owner = await registerOwner(env);
    await env.softex.ctx.db.run("UPDATE workspaces SET trial_ends_at = '2000-01-01T00:00:00.000Z'");
    await env.softex.ctx.db.run('UPDATE users SET email_verified_at = created_at');
    const text = Array.from({ length: 12 }, (_, i) => `p${i}@example.com`).join('\n');
    const res = await owner.agent.post('/api/admin/invitations/bulk').send({ text });
    expect(res.status).toBe(402);
  });
});
