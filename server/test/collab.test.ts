import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { invite, registerOwner, setup, type TestEnv } from './helpers.js';

let env: TestEnv;
afterEach(() => env?.cleanup());

const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64');
const bytes = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));
type Agent = ReturnType<TestEnv['agent']>;

/** A client-side copy of a live document, as the browser keeps it. */
async function open(agent: Agent, path: string) {
  const doc = new Y.Doc();
  const res = await agent.post(`/api/collab/${path}/sync`).send({});
  expect(res.status).toBe(200);
  Y.applyUpdate(doc, bytes(res.body.update));
  return { doc, canEdit: res.body.can_edit as boolean };
}
/** Make an edit locally and send just that change. */
async function edit(agent: Agent, path: string, doc: Y.Doc, change: (doc: Y.Doc) => void) {
  const before = Y.encodeStateVector(doc);
  change(doc);
  return agent.post(`/api/collab/${path}/update`).send({ update: b64(Y.encodeStateAsUpdate(doc, before)) });
}

describe('live co-editing', () => {
  it('merges concurrent edits from several people', async () => {
    env = setup();
    const owner = await registerOwner(env);
    const member = await invite(env, owner.agent);
    const page = (await owner.agent.post('/api/pages').send({ title: 'Plan', body: 'Hello world' })).body;
    const path = `page/${page.id}`;

    // Both open the page at once: the saved text is not duplicated.
    const [a, b] = await Promise.all([open(owner.agent, path), open(member.agent, path)]);
    expect(a.doc.getText('body').toString()).toBe('Hello world');
    expect(b.doc.getText('body').toString()).toBe('Hello world');

    // They type at the same time, from the same starting point.
    await edit(owner.agent, path, a.doc, (d) => d.getText('body').insert(0, 'A: '));
    await edit(member.agent, path, b.doc, (d) => d.getText('body').insert(d.getText('body').length, ' — B'));
    await edit(member.agent, path, b.doc, (d) => d.getText('title').insert(4, ' v2'));

    // A third person catches up by state vector and sees both edits.
    const c = await open(owner.agent, path);
    expect(c.doc.getText('body').toString()).toBe('A: Hello world — B');
    expect(c.doc.getText('title').toString()).toBe('Plan v2');
    // The first editor only needs what they're missing.
    const diff = await owner.agent.post(`/api/collab/${path}/sync`).send({ stateVector: b64(Y.encodeStateVector(a.doc)) });
    Y.applyUpdate(a.doc, bytes(diff.body.update));
    expect(a.doc.getText('body').toString()).toBe('A: Hello world — B');

    // Saving the live text keeps the draft; saving something else resets it.
    await owner.agent.patch(`/api/pages/${page.id}`).send({ title: 'Plan v2', body: 'A: Hello world — B' }).expect(200);
    expect((await open(member.agent, path)).doc.getText('body').toString()).toBe('A: Hello world — B');
    await owner.agent.patch(`/api/pages/${page.id}`).send({ body: 'Rewritten through the API' }).expect(200);
    expect((await open(member.agent, path)).doc.getText('body').toString()).toBe('Rewritten through the API');
  });

  it('keeps many edits compact and checks access', async () => {
    env = setup();
    const owner = await registerOwner(env);
    const member = await invite(env, owner.agent);
    const outsider = await invite(env, owner.agent);
    const project = (await owner.agent.post('/api/projects').send({ name: 'Private', visibility: 'private', memberIds: [member.id] })).body;
    const page = (await owner.agent.post('/api/pages').send({ title: 'Minutes', projectId: project.id })).body;
    const path = `page/${page.id}`;

    expect((await outsider.agent.post(`/api/collab/${path}/sync`).send({})).status).toBe(404);
    expect((await outsider.agent.post(`/api/collab/${path}/update`).send({ update: 'AAA=' })).status).toBe(404);
    const { doc } = await open(member.agent, path);
    expect((await member.agent.post(`/api/collab/${path}/update`).send({ update: b64(new Uint8Array([9, 9, 9])) })).status).toBe(400);
    expect((await member.agent.post('/api/collab/sheet/x/sync').send({})).status).toBe(400);

    for (let i = 0; i < 80; i++) await edit(member.agent, path, doc, (d) => d.getText('body').insert(d.getText('body').length, `${i % 10}`));
    const rows = () => env.softex.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM collab_updates WHERE doc_key = ?", `page:${page.id}`);
    await open(owner.agent, path); // reading compacts
    expect(Number((await rows())!.n)).toBeLessThan(5);
    expect((await open(owner.agent, path)).doc.getText('body').toString()).toHaveLength(80);

    // Archived pages are read-only.
    await owner.agent.post(`/api/pages/${page.id}/archive`).send({ archived: true }).expect(200);
    const after = await open(member.agent, path);
    expect(after.canEdit).toBe(false);
    expect((await edit(member.agent, path, after.doc, (d) => d.getText('body').insert(0, 'x'))).status).toBe(403);
  });
});

describe('whiteboards', () => {
  it('shares boards with the right people and syncs drawings', async () => {
    env = setup();
    const owner = await registerOwner(env);
    const member = await invite(env, owner.agent);
    const outsider = await invite(env, owner.agent);
    const general = (await owner.agent.get('/api/channels')).body.find((c: { name: string }) => c.name === 'general');
    const guest = await invite(env, owner.agent, 'guest', { channelIds: [general.id], guestDays: 7 });
    const project = (await owner.agent.post('/api/projects').send({ name: 'Private', visibility: 'private', memberIds: [member.id] })).body;

    const open = (await member.agent.post('/api/boards').send({ title: 'Brainstorm' })).body;
    const secret = (await member.agent.post('/api/boards').send({ title: 'Board papers', projectId: project.id })).body;
    expect(secret.project).toMatchObject({ id: project.id });
    expect((await outsider.agent.post('/api/boards').send({ title: 'x', projectId: project.id })).status).toBe(404);
    expect((await guest.agent.post('/api/boards').send({ title: 'x' })).status).toBe(403);
    expect((await outsider.agent.get('/api/boards')).body.map((b: { title: string }) => b.title)).toEqual(['Brainstorm']);
    expect((await guest.agent.get('/api/boards')).body).toEqual([]);
    expect((await outsider.agent.get(`/api/boards/${secret.id}`)).status).toBe(404);
    expect((await outsider.agent.post(`/api/collab/board/${secret.id}/sync`).send({})).status).toBe(404);

    // Drawing syncs through the live store.
    const a = new Y.Doc();
    Y.applyUpdate(a, bytes((await member.agent.post(`/api/collab/board/${open.id}/sync`).send({})).body.update));
    const before = Y.encodeStateVector(a);
    a.getMap('elements').set('n1', { id: 'n1', type: 'sticky', x: 10, y: 10, w: 180, h: 140, color: '#FFE58A', text: 'Idea', z: 1 });
    await member.agent.post(`/api/collab/board/${open.id}/update`).send({ update: b64(Y.encodeStateAsUpdate(a, before)) }).expect(200);
    const b = new Y.Doc();
    Y.applyUpdate(b, bytes((await outsider.agent.post(`/api/collab/board/${open.id}/sync`).send({})).body.update));
    expect((b.getMap('elements').get('n1') as { text: string }).text).toBe('Idea');

    // Renaming is for editors, archiving and deleting for the owner or an admin.
    await outsider.agent.patch(`/api/boards/${open.id}`).send({ title: 'Brainstorm 2' }).expect(200);
    expect((await outsider.agent.patch(`/api/boards/${open.id}`).send({ archived: true })).status).toBe(403);
    expect((await outsider.agent.delete(`/api/boards/${open.id}`)).status).toBe(403);
    await outsider.agent.put('/api/favorites').send({ kind: 'board', id: open.id, on: true }).expect(200);
    await member.agent.delete(`/api/boards/${open.id}`).expect(200);
    expect((await outsider.agent.get('/api/favorites')).body).toEqual([]);
    const left = await env.softex.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM collab_updates WHERE doc_key = ?', `board:${open.id}`);
    expect(Number(left!.n)).toBe(0);
  });
});
