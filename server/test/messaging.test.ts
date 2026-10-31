import { afterEach, describe, expect, it } from 'vitest';
import { storageUsed } from '../src/plans.js';
import { invite, registerOwner, setup, type TestEnv } from './helpers.js';

let env: TestEnv;
afterEach(async () => env?.cleanup());

type Msg = { id: string; body: string; [k: string]: any };
const byName = (list: { name: string }[], name: string) => list.find((c) => c.name === name) as { id: string; name: string; [k: string]: any };

/** A workspace with two members, Ama and Ben, and a private channel only Ama is in. */
async function team() {
  env = setup();
  const owner = await registerOwner(env, 'Olu Owner');
  const ama = await invite(env, owner.agent, 'member', {}, 'Ama Mensah');
  const ben = await invite(env, owner.agent, 'member', {}, 'Ben Kollie');
  const general = byName((await ama.agent.get('/api/channels')).body, 'general');
  const secret = (await ama.agent.post('/api/channels').send({ name: 'secret-plans', kind: 'private' })).body;
  const dm = (await ama.agent.post('/api/dms').send({ userIds: [ben.id] })).body;
  return { owner, ama, ben, general, secret, dm };
}

const savedOf = async (agent: ReturnType<TestEnv['agent']>) => (await agent.get('/api/channels')).body.find((c: { personal: boolean }) => c.personal);

describe('Saved', () => {
  it('everyone has one private Saved conversation, at the top, that nobody else can reach', async () => {
    const { owner, ama, ben } = await team();
    const saved = await savedOf(ama.agent);
    expect(saved).toMatchObject({ name: 'Saved', kind: 'dm', personal: true, members: [] });
    // One per person: asking again (or messaging yourself) gives the same one.
    expect((await ama.agent.get('/api/saved/channel')).body.id).toBe(saved.id);
    expect((await ama.agent.post('/api/dms').send({ userIds: [ama.id] })).body.id).toBe(saved.id);
    expect((await savedOf(ben.agent)).id).not.toBe(saved.id);

    // Notes and files go in it.
    const file = (await ama.agent.post('/api/files').attach('file', Buffer.from('my notes'), 'notes.txt')).body;
    const note = (await ama.agent.post(`/api/channels/${saved.id}/messages`).send({ body: 'Call the printer @[Ben Kollie](' + ben.id + ')', fileIds: [file.id] })).body;
    expect(note.files).toHaveLength(1);

    // Nobody else — not another member, not an admin — can read, post, join, search or open its files.
    for (const other of [ben.agent, owner.agent]) {
      expect((await other.get(`/api/channels/${saved.id}`)).status).toBe(404);
      expect((await other.get(`/api/channels/${saved.id}/messages`)).status).toBe(404);
      expect((await other.post(`/api/channels/${saved.id}/messages`).send({ body: 'hi' })).status).toBe(404);
      expect((await other.post(`/api/channels/${saved.id}/join`)).status).toBe(404);
      expect((await other.get(`/api/files/${file.id}`)).status).toBe(404);
      expect((await other.get(`/api/files/${file.id}/download`)).status).toBe(404);
      expect((await other.post(`/api/messages/${note.id}/forward`).send({ channelId: 'saved' })).status).toBe(404);
      expect((await other.get('/api/search?type=messages&q=printer')).body.messages).toHaveLength(0);
    }
    expect((await owner.agent.post(`/api/channels/${saved.id}/members`).send({ userIds: [ben.id] })).status).toBe(404);
    expect((await ama.agent.post(`/api/channels/${saved.id}/members`).send({ userIds: [ben.id] })).status).toBe(400);
    expect((await ama.agent.post(`/api/channels/${saved.id}/leave`)).status).toBe(400);
    // Mentioning someone in your own notes doesn't tell them.
    const benInbox = (await ben.agent.get('/api/notifications')).body.notifications;
    expect(benInbox.some((n: { body: string }) => (n.body ?? '').includes('printer'))).toBe(false);
    // You can search your own Saved.
    const found = (await ama.agent.get('/api/search?type=messages&q=printer&offset=0')).body;
    expect(found.messages).toMatchObject([{ id: note.id, channel_name: 'Saved', saved: true }]);
    expect(found.messages_has_more).toBe(false);
  });

  it('saving copies a message into Saved and saving again takes it out; items can be edited and removed', async () => {
    const { ama, ben, general } = await team();
    await env.softex.ctx.db.run("UPDATE workspaces SET message_edit_policy = 'none'");
    const post = (await ben.agent.post(`/api/channels/${general.id}/messages`).send({ body: 'Launch is on Friday' })).body;
    const res = (await ama.agent.post(`/api/messages/${post.id}/save`)).body;
    expect(res).toMatchObject({ saved: true, message: { forwarded: { copy: true, body: 'Launch is on Friday', user: { name: 'Ben Kollie' } } } });
    const saved = await savedOf(ama.agent);
    expect(res.channel_id).toBe(saved.id);
    // The original shows as saved for Ama only.
    const seen = (who: ReturnType<TestEnv['agent']>) => who.get(`/api/channels/${general.id}/messages`).then((r) => r.body.messages.find((m: Msg) => m.id === post.id));
    expect((await seen(ama.agent)).saved).toBe(true);
    expect((await seen(ben.agent)).saved).toBe(false);

    // Your own notes in Saved can be edited even when the workspace doesn't allow editing.
    expect((await ama.agent.patch(`/api/messages/${res.message.id}`).send({ body: 'remember this' })).status).toBe(200);
    // Saving again takes it out.
    expect((await ama.agent.post(`/api/messages/${post.id}/save`)).body).toMatchObject({ saved: false, removed: res.message.id });
    expect((await ama.agent.get(`/api/channels/${saved.id}/messages`)).body.messages).toHaveLength(0);
    expect((await seen(ama.agent)).saved).toBe(false);

    // Removing from inside Saved deletes it for good, whatever the edit policy.
    const again = (await ama.agent.post(`/api/messages/${post.id}/save`)).body.message;
    expect((await ama.agent.delete(`/api/messages/${again.id}`)).status).toBe(200);
    expect((await ama.agent.get(`/api/channels/${saved.id}/messages`)).body.messages).toHaveLength(0);
    // The original is untouched.
    expect((await seen(ben.agent)).body).toBe('Launch is on Friday');
  });

  it('turns old bookmarks into copies the first time Saved is opened', async () => {
    const { ama, ben, general } = await team();
    const post = (await ben.agent.post(`/api/channels/${general.id}/messages`).send({ body: 'Old bookmark' })).body;
    const { db } = env.softex.ctx;
    // Simulate a workspace from before Saved: a bookmark and no Saved conversation yet.
    await db.run('DELETE FROM channels WHERE personal = 1 AND created_by = ?', ama.id);
    await db.run('INSERT INTO saved_messages (user_id, message_id, created_at) VALUES (?, ?, ?)', ama.id, post.id, new Date().toISOString());
    const saved = await savedOf(ama.agent);
    const items = (await ama.agent.get(`/api/channels/${saved.id}/messages`)).body.messages;
    expect(items).toMatchObject([{ forwarded: { copy: true, body: 'Old bookmark' } }]);
    expect(await db.get('SELECT 1 FROM saved_messages WHERE user_id = ?', ama.id)).toBeUndefined();
  });
});

describe('forwarding', () => {
  it('forwards a copy that keeps the author and time, and only shows where it came from to people who can see it', async () => {
    const { ama, ben, general, secret } = await team();
    const original = (await ama.agent.post(`/api/channels/${secret.id}/messages`).send({ body: 'Budget is 40k' })).body;
    // Ben can't forward what he can't read, or post where he can't post.
    expect((await ben.agent.post(`/api/messages/${original.id}/forward`).send({ channelId: general.id })).status).toBe(404);
    const benPost = (await ben.agent.post(`/api/channels/${general.id}/messages`).send({ body: 'hello' })).body;
    expect((await ben.agent.post(`/api/messages/${benPost.id}/forward`).send({ channelId: secret.id })).status).toBe(404);

    const copy = (await ama.agent.post(`/api/messages/${original.id}/forward`).send({ channelId: general.id, comment: 'FYI' })).body;
    expect(copy).toMatchObject({ body: 'FYI', user: { name: 'Ama Mensah' }, forwarded: { copy: true, body: 'Budget is 40k', created_at: original.created_at, user: { name: 'Ama Mensah' } } });
    // Ama can see the source; Ben gets the copy without the private channel's name or a link.
    expect(copy.forwarded.source).toMatchObject({ channel_id: secret.id, channel_name: 'secret-plans', message_id: original.id });
    const benView = (await ben.agent.get(`/api/channels/${general.id}/messages`)).body.messages.find((m: Msg) => m.id === copy.id);
    expect(benView.forwarded).toMatchObject({ copy: true, body: 'Budget is 40k', source: null, channel_name: null });
    expect(benView.forwarded.id).toBeUndefined();
    expect(JSON.stringify(benView)).not.toContain('secret-plans');
    expect(JSON.stringify(benView)).not.toContain(secret.id);

    // Editing or deleting the original leaves the copy as it was.
    await ama.agent.patch(`/api/messages/${original.id}`).send({ body: 'Budget is 55k' }).expect(200);
    let amaView = (await ama.agent.get(`/api/channels/${general.id}/messages`)).body.messages.find((m: Msg) => m.id === copy.id);
    expect(amaView.forwarded).toMatchObject({ body: 'Budget is 40k', original_edited: true });
    await ama.agent.delete(`/api/messages/${original.id}`).expect(200);
    amaView = (await ama.agent.get(`/api/channels/${general.id}/messages`)).body.messages.find((m: Msg) => m.id === copy.id);
    expect(amaView.forwarded).toMatchObject({ body: 'Budget is 40k', source: null, original_deleted: true });
    const benAfter = (await ben.agent.get(`/api/channels/${general.id}/messages`)).body.messages.find((m: Msg) => m.id === copy.id);
    expect(benAfter.forwarded).toMatchObject({ body: 'Budget is 40k', original_deleted: false, source: null });
  });

  it('the link back follows access: it goes away when access is revoked', async () => {
    const { ama, ben, general, secret } = await team();
    await ama.agent.post(`/api/channels/${secret.id}/members`).send({ userIds: [ben.id] }).expect(200);
    const original = (await ama.agent.post(`/api/channels/${secret.id}/messages`).send({ body: 'Plan B' })).body;
    const copy = (await ama.agent.post(`/api/messages/${original.id}/forward`).send({ channelId: general.id })).body;
    const view = async () => (await ben.agent.get(`/api/channels/${general.id}/messages`)).body.messages.find((m: Msg) => m.id === copy.id).forwarded;
    expect((await view()).source).toMatchObject({ channel_id: secret.id });
    // Ama (who made the channel) removes Ben.
    await ama.agent.delete(`/api/channels/${secret.id}/members/${ben.id}`).expect(200);
    expect((await view()).source).toBeNull();
    expect((await view()).body).toBe('Plan B');
    expect((await ben.agent.get(`/api/channels/${secret.id}/messages`)).status).toBe(404);
  });

  it('attachments come along as copies readable in the destination, without using more storage', async () => {
    const { ama, ben, dm, secret } = await team();
    const { db } = env.softex.ctx;
    const file = (await ama.agent.post('/api/files').attach('file', Buffer.from('quarterly numbers'), 'q3.txt')).body;
    const original = (await ama.agent.post(`/api/channels/${secret.id}/messages`).send({ body: 'Q3', fileIds: [file.id] })).body;
    const before = await storageUsed(db, (await db.get('SELECT workspace_id FROM channels WHERE id = ?', secret.id))!.workspace_id);
    // Ben can't open the original attachment.
    expect((await ben.agent.get(`/api/files/${file.id}/download`)).status).toBe(404);
    const copy = (await ama.agent.post(`/api/messages/${original.id}/forward`).send({ channelId: dm.id })).body;
    expect(copy.files).toHaveLength(1);
    expect(copy.files[0].id).not.toBe(file.id);
    expect(copy.forwarded.source).toBeTruthy();
    // Ben can open the copy (it's in a conversation he's in), and it's the same bytes.
    const download = await ben.agent.get(`/api/files/${copy.files[0].id}/download`).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(download.status).toBe(200);
    expect(download.body.toString()).toBe('quarterly numbers');
    // ...but still not the original.
    expect((await ben.agent.get(`/api/files/${file.id}/download`)).status).toBe(404);
    expect(await storageUsed(db, (await db.get('SELECT workspace_id FROM channels WHERE id = ?', secret.id))!.workspace_id)).toBe(before);

    // Deleting the original file keeps the bytes the copy still uses.
    await ama.agent.delete(`/api/files/${file.id}`).expect(200);
    const again = await ben.agent.get(`/api/files/${copy.files[0].id}/download`);
    expect(again.status).toBe(200);
  });

  it('respects announcement rules and lists only places you can post in', async () => {
    const { owner, ama, general, secret } = await team();
    const news = (await owner.agent.post('/api/channels').send({ name: 'news', kind: 'announcement', memberIds: [ama.id] })).body;
    const post = (await ama.agent.post(`/api/channels/${general.id}/messages`).send({ body: 'hi all' })).body;
    expect((await ama.agent.post(`/api/messages/${post.id}/forward`).send({ channelId: news.id })).status).toBe(403);
    const targets = (await ama.agent.get('/api/forward-targets')).body as { id: string; personal: boolean }[];
    expect(targets[0].personal).toBe(true);
    expect(targets.map((t) => t.id)).toContain(secret.id);
    expect(targets.map((t) => t.id)).not.toContain(news.id);
    // Forwarding to Saved by name.
    const saved = (await ama.agent.post(`/api/messages/${post.id}/forward`).send({ channelId: 'saved', comment: 'for later' })).body;
    expect(saved.channel_id).toBe((await savedOf(ama.agent)).id);
  });
});

describe('reliable sending', () => {
  it('a retried send with the same client id posts once', async () => {
    const { ama, ben, general } = await team();
    const send = () => ama.agent.post(`/api/channels/${general.id}/messages`).send({ body: 'only once', clientId: 'c-1234567890' });
    const [a, b] = await Promise.all([send(), send()]);
    const c = await send();
    expect(new Set([a.body.id, b.body.id, c.body.id]).size).toBe(1);
    expect(c.body.client_id).toBe('c-1234567890');
    const all = (await ben.agent.get(`/api/channels/${general.id}/messages`)).body.messages.filter((m: Msg) => m.body === 'only once');
    expect(all).toHaveLength(1);
    // The same id from someone else, or in another conversation, is a different message.
    const fromBen = (await ben.agent.post(`/api/channels/${general.id}/messages`).send({ body: 'only once', clientId: 'c-1234567890' })).body;
    expect(fromBen.id).not.toBe(a.body.id);
    // Forwards can be retried safely too.
    const f1 = (await ama.agent.post(`/api/messages/${fromBen.id}/forward`).send({ channelId: 'saved', clientId: 'f-1234567890' })).body;
    const f2 = (await ama.agent.post(`/api/messages/${fromBen.id}/forward`).send({ channelId: 'saved', clientId: 'f-1234567890' })).body;
    expect(f2.id).toBe(f1.id);
  });
});

describe('threads and notification preferences', () => {
  it('follow, mute, and "mentions and replies"', async () => {
    const { owner, ama, ben, general } = await team();
    const root = (await ama.agent.post(`/api/channels/${general.id}/messages`).send({ body: 'Thread start' })).body;
    // Updates about one thread group into one row with a count.
    const inbox = async (who: ReturnType<TestEnv['agent']>) =>
      (await who.get('/api/notifications')).body.notifications
        .filter((n: { title: string }) => n.title.includes('replied to a thread'))
        .reduce((sum: number, n: { group_count?: number }) => sum + (n.group_count ?? 1), 0);

    // Ben follows without replying; the owner replies.
    expect((await ben.agent.put(`/api/messages/${root.id}/subscription`).send({ mode: 'follow' })).body).toEqual({ mode: 'follow', following: true });
    await owner.agent.post(`/api/channels/${general.id}/messages`).send({ body: 'first', parentId: root.id }).expect(201);
    expect(await inbox(ben.agent)).toBe(1);
    expect(await inbox(ama.agent)).toBe(1);

    // Ama mutes it; "Mentions and replies" still hears about replies for Ben.
    await ama.agent.put(`/api/messages/${root.id}/subscription`).send({ mode: 'mute' }).expect(200);
    await ben.agent.patch(`/api/channels/${general.id}/preferences`).send({ notify: 'mentions' }).expect(200);
    await owner.agent.post(`/api/channels/${general.id}/messages`).send({ body: 'second', parentId: root.id }).expect(201);
    expect(await inbox(ama.agent)).toBe(1);
    expect(await inbox(ben.agent)).toBe(2);
    const thread = (await ama.agent.get(`/api/messages/${root.id}/thread`)).body;
    expect(thread.subscription).toEqual({ mode: 'mute', following: false });
    expect(thread.root.reply_count).toBe(2);

    // Muted conversations stay quiet, but unread still counts.
    await ben.agent.patch(`/api/channels/${general.id}/preferences`).send({ notify: 'none' }).expect(200);
    await ben.agent.post(`/api/channels/${general.id}/read`).expect(200);
    await owner.agent.post(`/api/channels/${general.id}/messages`).send({ body: 'third', parentId: root.id }).expect(201);
    await owner.agent.post(`/api/channels/${general.id}/messages`).send({ body: 'new top-level' }).expect(201);
    expect(await inbox(ben.agent)).toBe(2);
    expect(byName((await ben.agent.get('/api/channels')).body, 'general').unread).toBe(2);
    // Your own messages never notify you.
    expect((await owner.agent.get('/api/notifications')).body.notifications.filter((n: { title: string }) => n.title.includes('replied')).length).toBe(0);
  });
});

describe('message search', () => {
  it('pages through results, finds forwarded text, and never shows what you cannot see', async () => {
    const { ama, ben, general, secret } = await team();
    for (let i = 0; i < 5; i++) await ama.agent.post(`/api/channels/${general.id}/messages`).send({ body: `report draft ${i}` });
    await ama.agent.post(`/api/channels/${secret.id}/messages`).send({ body: 'report secret' });
    const page1 = (await ben.agent.get('/api/search?type=messages&q=report&limit=3&offset=0')).body;
    expect(page1.messages).toHaveLength(3);
    expect(page1.messages_has_more).toBe(true);
    const page2 = (await ben.agent.get('/api/search?type=messages&q=report&limit=3&offset=3')).body;
    expect(page2.messages).toHaveLength(2);
    expect(page2.messages_has_more).toBe(false);
    expect([...page1.messages, ...page2.messages].some((m: Msg) => m.body.includes('secret'))).toBe(false);
    expect(page1.messages[0].snippet).toContain('report');

    // A forwarded copy is found by what the original said.
    const benPost = (await ben.agent.post(`/api/channels/${general.id}/messages`).send({ body: 'zebra crossing' })).body;
    await ama.agent.post(`/api/messages/${benPost.id}/forward`).send({ channelId: secret.id, comment: 'look' });
    const hits = (await ama.agent.get(`/api/search?type=messages&q=zebra&channelId=${secret.id}`)).body.messages;
    expect(hits).toMatchObject([{ channel_name: 'secret-plans', forwarded: { user_name: 'Ben Kollie' } }]);
    expect((await ben.agent.get(`/api/search?type=messages&q=zebra&channelId=${secret.id}`)).body.messages).toHaveLength(0);
  });
});
