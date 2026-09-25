import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createApp, type SoftexApp } from '../src/app.js';

/**
 * Two SoftEX servers sharing one PostgreSQL database, as when a hosting platform runs
 * several replicas. Runs when SOFTEX_TEST_DATABASE_URL is set (CI does this).
 */
const url = process.env.SOFTEX_TEST_DATABASE_URL;

let apps: SoftexApp[] = [];
let sockets: WebSocket[] = [];
let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  for (const s of sockets) s.terminate();
  await Promise.all(apps.map((a) => a.close()));
  await cleanup?.();
  apps = [];
  sockets = [];
});

async function cluster() {
  const schema = `t_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  const dir = mkdtempSync(join(tmpdir(), 'softex-cluster-'));
  const make = () =>
    createApp({ databaseUrl: `${url}?schema=${schema}`, uploadDir: join(dir, 'uploads'), startJobs: false, publicUrl: 'https://softex.test', mail: { sendMail: async () => {} } });
  apps = [make(), make()];
  await Promise.all(apps.map((a) => a.ready));
  const ports = await Promise.all(apps.map((a) => new Promise<number>((r) => a.server.listen(0, '127.0.0.1', () => r((a.server.address() as AddressInfo).port)))));
  cleanup = async () => {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.end();
    rmSync(dir, { recursive: true, force: true });
  };
  return ports;
}

const cookieOf = (res: request.Response) => String(res.headers['set-cookie']?.[0] ?? '').split(';')[0];

/** Open a socket and collect its events; `next(match)` waits for a matching one. */
function connect(port: number, cookie: string) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie } });
  sockets.push(socket);
  const events: any[] = [];
  const waiters: { test: (e: any) => boolean; resolve: (e: any) => void }[] = [];
  socket.on('message', (raw) => {
    const e = JSON.parse(raw.toString());
    events.push(e);
    for (const w of [...waiters]) if (w.test(e)) (waiters.splice(waiters.indexOf(w), 1), w.resolve(e));
  });
  const closed = new Promise<number>((r) => socket.on('close', (code) => r(code)));
  const next = (match: (e: any) => boolean, ms = 3000) =>
    new Promise<any>((resolve, reject) => {
      const found = events.find(match);
      if (found) return resolve(found);
      waiters.push({ test: match, resolve });
      setTimeout(() => reject(new Error('timed out waiting for a realtime event')), ms).unref();
    });
  return { socket, events, next, closed };
}

describe.skipIf(!url)('several servers on one PostgreSQL database', () => {
  it('shares realtime events, presence, sign-outs and background-job leadership', async () => {
    const [portA, portB] = await cluster();
    const [a, b] = apps;
    const owner = await request(a.app).post('/api/auth/register').send({ name: 'Ada', email: 'ada@example.com', password: 'password123', workspaceName: 'Acme' });
    const ownerCookie = cookieOf(owner);
    const inv = await request(a.app).post('/api/admin/invitations').set('Cookie', ownerCookie).send({ email: 'bo@example.com' });
    // The member joins and signs in through the *other* server.
    const member = await request(b.app).post(`/api/invitations/${inv.body.token}/accept`).send({ name: 'Bo', password: 'password123' });
    const memberCookie = cookieOf(member);
    const memberId = member.body.user.id;

    const bo = connect(portB, memberCookie);
    await bo.next((e) => e.type === 'hello');

    // A message posted on server A reaches a person connected to server B…
    const channels = (await request(a.app).get('/api/channels').set('Cookie', ownerCookie)).body;
    const general = channels.find((c: { name: string }) => c.name === 'general');
    await request(a.app).post(`/api/channels/${general.id}/messages`).set('Cookie', ownerCookie).send({ body: 'Hello from server A' });
    expect((await bo.next((e) => e.type === 'message.created')).message.body).toBe('Hello from server A');

    // …including events too large for NOTIFY, which travel by reference.
    const long = 'x'.repeat(9000);
    await request(a.app).post(`/api/channels/${general.id}/messages`).set('Cookie', ownerCookie).send({ body: long });
    expect((await bo.next((e) => e.type === 'message.created' && e.message.body.length === 9000)).message.body).toBe(long);

    // …but never messages from a private channel they can't see.
    const secret = (await request(a.app).post('/api/channels').set('Cookie', ownerCookie).send({ name: 'secret', kind: 'private' })).body;
    await request(a.app).post(`/api/channels/${secret.id}/messages`).set('Cookie', ownerCookie).send({ body: 'Top secret' });
    await request(a.app).post(`/api/channels/${general.id}/messages`).set('Cookie', ownerCookie).send({ body: 'marker' });
    await bo.next((e) => e.type === 'message.created' && e.message.body === 'marker');
    expect(bo.events.some((e) => e.type === 'message.created' && e.message.body === 'Top secret')).toBe(false);

    // Presence: the owner opens SoftEX on server A; server B learns they are online.
    const ada = connect(portA, ownerCookie);
    await ada.next((e) => e.type === 'hello');
    await bo.next((e) => e.type === 'presence' && e.userId === owner.body.user.id && e.online === true);
    expect(b.ctx.hub.isOnline(owner.body.workspace.id, owner.body.user.id)).toBe(true);
    expect((await ada.next((e) => e.type === 'hello')).online).toEqual(expect.arrayContaining([memberId]));

    // Deactivating the member on server A signs them out of server B too.
    await request(a.app).patch(`/api/admin/members/${memberId}`).set('Cookie', ownerCookie).send({ deactivated: true });
    expect(await bo.closed).toBe(4001);

    // Only one server at a time runs a background job.
    let inner: string | undefined = 'not run';
    await a.ctx.db.exclusive('softex:test-job', async () => {
      inner = await b.ctx.db.exclusive('softex:test-job', async () => 'ran');
    });
    expect(inner).toBeUndefined();
    expect(await b.ctx.db.exclusive('softex:test-job', async () => 'ran')).toBe('ran');
  });

  it('shares sign-in rate limits between servers', async () => {
    await cluster();
    const [a, b] = apps;
    await request(a.app).post('/api/auth/register').send({ name: 'Ada', email: 'ada@example.com', password: 'password123', workspaceName: 'Acme' });
    const attempt = (app: SoftexApp) => request(app.app).post('/api/auth/login').send({ email: 'ada@example.com', password: 'wrong-password' });
    for (let i = 0; i < 5; i++) await attempt(a);
    for (let i = 0; i < 5; i++) await attempt(b);
    // The 11th attempt is refused whichever server it reaches.
    expect((await attempt(a)).status).toBe(429);
  });
});
