import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { GcsFileStore, S3FileStore } from '../src/storage.js';
import { createBackup, listBackups } from '../src/backup.js';
import { registerOwner, setup, type TestEnv } from './helpers.js';

/** Just enough of the S3 API (path-style PUT/GET/DELETE) to exercise Küü's storage adapter. */
function fakeS3() {
  const objects = new Map<string, { body: Buffer; type: string }>();
  const server = createServer((req, res) => {
    const key = decodeURIComponent(req.url!.split('?')[0]);
    const query = new URLSearchParams(req.url!.split('?')[1] ?? '');
    if (req.method === 'GET' && query.get('list-type') === '2') {
      const prefix = `${key.replace(/\/$/, '')}/${query.get('prefix') ?? ''}`;
      const items = [...objects].filter(([k]) => k.startsWith(prefix));
      const bucket = key.replace(/^\//, '').replace(/\/$/, '');
      const xml = items
        .map(([k, o]) => `<Contents><Key>${k.slice(bucket.length + 2)}</Key><Size>${o.body.length}</Size><LastModified>2026-09-25T00:00:00.000Z</LastModified></Contents>`)
        .join('');
      return res
        .writeHead(200, { 'Content-Type': 'application/xml' })
        .end(`<?xml version="1.0"?><ListBucketResult><Name>${bucket}</Name><IsTruncated>false</IsTruncated>${xml}</ListBucketResult>`);
    }
    if (req.method === 'PUT') {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        objects.set(key, { body: Buffer.concat(chunks), type: String(req.headers['content-type']) });
        res.writeHead(200, { ETag: '"x"' }).end();
      });
      return;
    }
    const obj = objects.get(key);
    if (req.method === 'DELETE') {
      objects.delete(key);
      return res.writeHead(204).end();
    }
    if (!obj) {
      return res
        .writeHead(404, { 'Content-Type': 'application/xml' })
        .end('<?xml version="1.0"?><Error><Code>NoSuchKey</Code><Message>missing</Message></Error>');
    }
    res.writeHead(200, { 'Content-Type': obj.type, 'Content-Length': obj.body.length }).end(obj.body);
  });
  return { server, objects };
}

let env: TestEnv | undefined;
let s3: Server | undefined;
afterEach(async () => {
  await env?.cleanup();
  env = undefined;
  await new Promise((r) => (s3 ? s3.close(r) : r(null)));
});

describe('S3-compatible file storage', () => {
  it('stores uploads in the bucket, serves downloads from it and deletes them with the workspace', async () => {
    const fake = fakeS3();
    s3 = fake.server;
    await new Promise<void>((r) => fake.server.listen(0, '127.0.0.1', r));
    const endpoint = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}`;
    env = setup({
      files: new S3FileStore({ bucket: 'softex', endpoint, region: 'us-east-1', forcePathStyle: true, accessKeyId: 'test', secretAccessKey: 'test', prefix: 'uploads/' }),
    });
    const owner = await registerOwner(env, 'Ada');
    const file = (await owner.agent.post('/api/files').attach('file', Buffer.from('quarterly numbers'), 'report.txt')).body;
    expect(fake.objects.size).toBe(1);
    const [key, stored] = [...fake.objects][0];
    expect(key).toMatch(/^\/softex\/uploads\//);
    expect(stored.body.toString()).toBe('quarterly numbers');

    const download = await owner.agent.get(`/api/files/${file.id}/download`).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(download.status).toBe(200);
    expect((download.body as Buffer).toString()).toBe('quarterly numbers');

    // A missing object is reported as gone rather than crashing.
    fake.objects.clear();
    expect((await owner.agent.get(`/api/files/${file.id}/download`)).status).toBe(410);

    await owner.agent.post('/api/files').attach('file', Buffer.from('second'), 'b.txt');
    expect(fake.objects.size).toBe(1);
    await owner.agent.delete('/api/admin/workspace').send({ password: 'password123', confirmName: "Ada's Co" });
    expect(fake.objects.size).toBe(0);
  });

  it.skipIf(!!process.env.SOFTEX_TEST_DATABASE_URL)('keeps database backups in the bucket, off the server', async () => {
    const fake = fakeS3();
    s3 = fake.server;
    await new Promise<void>((r) => fake.server.listen(0, '127.0.0.1', r));
    const endpoint = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}`;
    env = setup({
      files: new S3FileStore({ bucket: 'softex', endpoint, region: 'us-east-1', forcePathStyle: true, accessKeyId: 'test', secretAccessKey: 'test', prefix: 'app/' }),
      backups: { enabled: true, keep: 2 },
    });
    await registerOwner(env, 'Ada');
    for (let i = 0; i < 3; i++) await createBackup(env.softex.ctx);
    const keys = [...fake.objects.keys()].filter((k) => k.includes('/backups/'));
    expect(keys).toHaveLength(2);
    expect(keys.every((k) => k.startsWith('/softex/app/backups/softex-'))).toBe(true);
    expect((await listBackups(env.softex.ctx)).map((b) => b.name)).toEqual(keys.map((k) => k.split('/').pop()).sort().reverse());
  });
});

/** Just enough of the Cloud Storage JSON API (media upload, alt=media download, delete, list). */
function fakeGcs() {
  const objects = new Map<string, { body: Buffer; type: string }>();
  const server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    const send = (status: number, body?: unknown) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(body === undefined ? undefined : JSON.stringify(body));
    if (req.method === 'POST' && url.pathname === '/upload/storage/v1/b/media/o') {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        objects.set(url.searchParams.get('name')!, { body: Buffer.concat(chunks), type: String(req.headers['content-type']) });
        send(200, {});
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/storage/v1/b/media/o') {
      const prefix = url.searchParams.get('prefix') ?? '';
      const items = [...objects].filter(([k]) => k.startsWith(prefix)).map(([name, o]) => ({ name, size: String(o.body.length), updated: '2026-10-01T00:00:00.000Z' }));
      return send(200, { items });
    }
    const name = decodeURIComponent(url.pathname.replace('/storage/v1/b/media/o/', ''));
    const obj = objects.get(name);
    if (req.method === 'DELETE') return send(objects.delete(name) ? 204 : 404);
    if (!obj) return send(404, { error: 'not found' });
    const range = /bytes=(\d+)-(\d+)/.exec(String(req.headers.range ?? ''));
    res.writeHead(range ? 206 : 200, { 'Content-Type': obj.type }).end(range ? obj.body.subarray(Number(range[1]), Number(range[2]) + 1) : obj.body);
  });
  return { server, objects };
}

describe('Google Cloud Storage file storage', () => {
  it('stores, streams (with ranges), lists and deletes files', async () => {
    const fake = fakeGcs();
    s3 = fake.server;
    await new Promise<void>((r) => fake.server.listen(0, '127.0.0.1', r));
    const endpoint = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}`;
    env = setup({ files: new GcsFileStore({ bucket: 'media', endpoint, prefix: 'uploads/' }) });
    const owner = await registerOwner(env, 'Ada');
    const file = (await owner.agent.post('/api/files').attach('file', Buffer.from('quarterly numbers'), 'report.txt')).body;
    expect([...fake.objects.keys()][0]).toMatch(/^uploads\//);
    expect([...fake.objects.values()][0].body.toString()).toBe('quarterly numbers');

    const read = (path: string) =>
      owner.agent.get(path).buffer(true).parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(((await read(`/api/files/${file.id}/download`)).body as Buffer).toString()).toBe('quarterly numbers');

    const store = env.softex.ctx.files;
    const key = [...fake.objects.keys()][0].slice('uploads/'.length);
    expect((await store.list('')).map((f) => f.key)).toEqual([key]);
    const part = await store.open(key, { start: 0, end: 8 });
    const bytes: Buffer[] = [];
    for await (const chunk of part!) bytes.push(chunk as Buffer);
    expect(Buffer.concat(bytes).toString()).toBe('quarterly');
    expect(await store.open('missing')).toBeNull();

    await store.remove(key);
    await store.remove(key); // already gone is fine
    expect(fake.objects.size).toBe(0);
    expect((await owner.agent.get(`/api/files/${file.id}/download`)).status).toBe(410);
  });
});
