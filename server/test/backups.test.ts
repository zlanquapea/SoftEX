import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { backupIfDue, createBackup, listBackups, restoreOnStartup } from '../src/backup.js';
import { LocalFileStore } from '../src/storage.js';
import { registerOwner, setup, type TestEnv } from './helpers.js';

const sqliteOnly = !!process.env.SOFTEX_TEST_DATABASE_URL;
let env: TestEnv | undefined;
const dirs: string[] = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'softex-backup-'));
  dirs.push(d);
  return d;
};
afterEach(async () => {
  await env?.cleanup();
  env = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const usersIn = (gz: Buffer) => {
  const dir = tempDir();
  writeFileSync(join(dir, 'x.db'), gunzipSync(gz));
  const db = new DatabaseSync(join(dir, 'x.db'), { readOnly: true });
  const rows = db.prepare('SELECT email FROM users').all() as { email: string }[];
  db.close();
  return rows.map((r) => r.email);
};

describe.skipIf(sqliteOnly)('SQLite backups', () => {
  it('saves checked, compressed snapshots and keeps the newest few', async () => {
    const dir = tempDir();
    env = setup({ backups: { enabled: true, dir, keep: 2, everyHours: 24 } });
    const { email } = await registerOwner(env);
    const first = await createBackup(env.softex.ctx);
    expect(first.name).toMatch(/^softex-.*\.db\.gz$/);
    expect(usersIn(readFileSync(join(dir, first.name)))).toContain(email);
    await createBackup(env.softex.ctx);
    await createBackup(env.softex.ctx);
    const kept = await listBackups(env.softex.ctx);
    expect(kept).toHaveLength(2);
    expect(kept.map((b) => b.name)).not.toContain(first.name);
    // No temporary files are left behind.
    expect(readdirSync(dir).filter((f) => f.startsWith('.'))).toEqual([]);
  });

  it('runs on schedule from the background jobs', async () => {
    const dir = tempDir();
    env = setup({ backups: { enabled: true, dir, keep: 7, everyHours: 24 } });
    await registerOwner(env);
    await backupIfDue(env.softex.ctx);
    await backupIfDue(env.softex.ctx);
    expect(await listBackups(env.softex.ctx)).toHaveLength(1);
    // Turned off: nothing happens.
    const off = setup({ backups: { enabled: false, dir: tempDir() } });
    await backupIfDue(off.softex.ctx);
    expect(await listBackups(off.softex.ctx)).toHaveLength(0);
    await off.cleanup();
  });

  it('restores a backup on start-up, once, keeping the previous database', async () => {
    const dir = tempDir();
    env = setup({ backups: { enabled: true, dir, keep: 7, everyHours: 24 } });
    const { email } = await registerOwner(env);
    const backup = await createBackup(env.softex.ctx);

    const dataDir = tempDir();
    const dbPath = join(dataDir, 'softex.db');
    writeFileSync(dbPath, 'not the data you want');
    const files = new LocalFileStore(join(dataDir, 'uploads'));
    expect(await restoreOnStartup({ dbPath, backupName: backup.name, files, backupDir: dir })).toBe(true);
    const restored = new DatabaseSync(dbPath, { readOnly: true });
    expect((restored.prepare('SELECT email FROM users').all() as { email: string }[]).map((r) => r.email)).toContain(email);
    restored.close();
    expect(readdirSync(dataDir).some((f) => f.startsWith('softex.db.before-restore-'))).toBe(true);
    // A restart with the variable still set doesn't restore again.
    expect(await restoreOnStartup({ dbPath, backupName: backup.name, files, backupDir: dir })).toBe(false);
    await expect(restoreOnStartup({ dbPath, backupName: '../../etc/passwd', files, backupDir: dir })).rejects.toThrow(/file name/);
    await expect(restoreOnStartup({ dbPath: join(dataDir, 'other.db'), backupName: 'softex-2020-01-01T00-00-00-000Z.db.gz', files, backupDir: dir })).rejects.toThrow(/not found/);
    expect(existsSync(join(dataDir, 'other.db'))).toBe(false);
  });

  it('lets operators list, create and download backups', async () => {
    const dir = tempDir();
    env = setup({ mode: 'saas', backups: { enabled: true, dir, keep: 7, everyHours: 24 } });
    const ops = await registerOwner(env, 'Ops');
    const customer = await registerOwner(env, 'Customer');
    env.softex.ctx.config.operatorEmails.push(ops.email);
    await env.softex.ctx.db.run('UPDATE users SET mfa_enabled = 1, email_verified_at = created_at WHERE email = ?', ops.email);

    expect((await customer.agent.get('/api/operator/backups')).status).toBe(404);
    const created = await ops.agent.post('/api/operator/backups');
    expect(created.status).toBe(201);
    const status = (await ops.agent.get('/api/operator/backups')).body;
    expect(status).toMatchObject({ supported: true, enabled: true, location: 'local', last: { ok: true } });
    expect(status.backups).toHaveLength(1);

    const download = await ops.agent
      .get(`/api/operator/backups/${created.body.name}/download`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(download.status).toBe(200);
    expect(usersIn(download.body)).toEqual(expect.arrayContaining([ops.email, customer.email]));
    expect((await ops.agent.get('/api/operator/backups/..%2Fsoftex.db/download')).status).toBe(404);
    const events = (await ops.agent.get('/api/operator/events')).body.map((e: { action: string }) => e.action);
    expect(events).toEqual(expect.arrayContaining(['backup.created', 'backup.downloaded']));
  });
});
