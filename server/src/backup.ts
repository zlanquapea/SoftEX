import { createReadStream, createWriteStream, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { DatabaseSync } from 'node:sqlite';
import { createGunzip, createGzip } from 'node:zlib';
import type { Ctx } from './context.js';
import { LocalFileStore, type FileStore } from './storage.js';
import { now } from './util.js';

/**
 * Automatic backups of the SQLite database (§7 "verified backups and restore"). A consistent
 * snapshot is taken with VACUUM INTO, checked with PRAGMA integrity_check, compressed, and
 * kept in S3-compatible storage when configured (off the server) or in the backup folder.
 * The newest `keep` copies are kept. PostgreSQL relies on the database provider's backups.
 */

export interface BackupConfig {
  enabled: boolean;
  /** Folder for backups when files aren't in S3 (default: data/backups). */
  dir: string;
  keep: number;
  everyHours: number;
}

export interface BackupInfo {
  name: string;
  size: number;
  created_at: string;
}

const NAME = /^softex-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(-\d{3})?Z\.db\.gz$/;
export const isBackupName = (name: string) => NAME.test(name);

function target(ctx: Ctx): { store: FileStore; prefix: string; location: 's3' | 'local' } {
  if (ctx.files.kind === 's3') return { store: ctx.files, prefix: 'backups/', location: 's3' };
  return { store: new LocalFileStore(ctx.config.backups.dir), prefix: '', location: 'local' };
}

export const backupLocation = (ctx: Ctx) => target(ctx).location;

export async function listBackups(ctx: Ctx): Promise<BackupInfo[]> {
  const { store, prefix } = target(ctx);
  return (await store.list(prefix))
    .map((f) => ({ name: f.key.slice(prefix.length), size: f.size, created_at: f.modified }))
    .filter((b) => isBackupName(b.name))
    .sort((a, b) => b.name.localeCompare(a.name));
}

export async function openBackup(ctx: Ctx, name: string) {
  if (!isBackupName(name)) return null;
  const { store, prefix } = target(ctx);
  return store.open(prefix + name);
}

/** Check that a snapshot file is a healthy Küü database. */
export function verifySnapshot(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = db.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[];
    if (rows.length !== 1 || rows[0].integrity_check !== 'ok') throw new Error(`integrity check failed: ${rows.map((r) => r.integrity_check).join('; ')}`);
    db.prepare('SELECT COUNT(*) AS n FROM workspaces').get();
  } finally {
    db.close();
  }
}

type LastBackup = { at: string; ok: boolean; name?: string; size?: number; error?: string; last_success_at?: string };

export async function lastBackup(ctx: Ctx): Promise<LastBackup | null> {
  const row = await ctx.db.get<{ value: string }>("SELECT value FROM server_settings WHERE key = 'backup:last'");
  return row ? (JSON.parse(row.value) as LastBackup) : null;
}

async function recordLast(ctx: Ctx, value: LastBackup) {
  const json = JSON.stringify(value);
  await ctx.db.run(
    "INSERT INTO server_settings (key, value, created_at) VALUES ('backup:last', ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    json,
    now(),
  );
}

/** Open a local file for reading, or null when it doesn't exist. */
function openLocal(path: string) {
  return new Promise<ReturnType<typeof createReadStream> | null>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.once('open', () => resolve(stream));
    stream.once('error', (error: NodeJS.ErrnoException) => (error.code === 'ENOENT' ? resolve(null) : reject(error)));
  });
}

/** Take a backup now. Throws on failure (and records it for the operator console). */
export async function createBackup(ctx: Ctx): Promise<BackupInfo> {
  if (ctx.db.dialect !== 'sqlite') throw new Error('Backups here are for SQLite; use your PostgreSQL provider’s backups.');
  const previous = await lastBackup(ctx);
  const { store, prefix, location } = target(ctx);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const name = `softex-${stamp}.db.gz`;
  // Work next to the final destination so the last step is a same-disk rename.
  const workDir = location === 'local' ? ctx.config.backups.dir : tmpdir();
  mkdirSync(workDir, { recursive: true });
  const raw = join(workDir, `.${name}.tmp.db`);
  const packed = join(workDir, `.${name}.tmp`);
  try {
    rmSync(raw, { force: true });
    await ctx.db.run('VACUUM INTO ?', raw);
    verifySnapshot(raw);
    await pipeline(createReadStream(raw), createGzip({ level: 6 }), createWriteStream(packed));
    const size = statSync(packed).size;
    await store.put(prefix + name, packed, 'application/gzip');
    // Keep the newest copies only.
    const all = await listBackups(ctx);
    for (const old of all.slice(Math.max(1, ctx.config.backups.keep))) await store.remove(prefix + old.name);
    await recordLast(ctx, { at: now(), ok: true, name, size, last_success_at: now() });
    return { name, size, created_at: now() };
  } catch (error) {
    await recordLast(ctx, { at: now(), ok: false, error: (error as Error).message.slice(0, 300), last_success_at: previous?.last_success_at });
    throw error;
  } finally {
    rmSync(raw, { force: true });
    rmSync(packed, { force: true });
  }
}

/** Called by the periodic jobs: back up when the last success is older than the interval. */
export async function backupIfDue(ctx: Ctx) {
  if (!ctx.config.backups.enabled || ctx.db.dialect !== 'sqlite') return;
  const last = await lastBackup(ctx);
  const t = Date.now();
  const lastSuccess = last?.last_success_at ? Date.parse(last.last_success_at) : 0;
  const lastAttempt = last?.at ? Date.parse(last.at) : 0;
  if (t - lastSuccess < ctx.config.backups.everyHours * 3600_000) return;
  // After a failure, try again an hour later rather than every few minutes.
  if (last && !last.ok && t - lastAttempt < 3600_000) return;
  try {
    const b = await createBackup(ctx);
    console.log(`Backup saved: ${b.name} (${Math.round(b.size / 1024)} KB)`);
  } catch (error) {
    console.error('Backup failed', error);
  }
}

/**
 * Restore on start-up (SOFTEX_RESTORE_BACKUP=<name>): used where there's no shell, such as
 * Railway. The current database is kept beside it as softex.db.before-restore-<time>, and a
 * marker file stops the same backup being restored again on the next restart.
 */
export async function restoreOnStartup(options: { dbPath: string; backupName: string; files: FileStore; backupDir: string }) {
  const { dbPath, backupName, files, backupDir } = options;
  if (!isBackupName(backupName)) throw new Error(`SOFTEX_RESTORE_BACKUP must be a backup file name like softex-2026-09-25T02-00-00-000Z.db.gz`);
  const marker = `${dbPath}.restored-${backupName}`;
  // Claim the marker atomically; if it already exists this backup was restored before.
  try {
    writeFileSync(marker, `${now()}\n`, { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    console.log(`Backup ${backupName} was already restored; remove SOFTEX_RESTORE_BACKUP to stop seeing this message.`);
    return false;
  }
  const incoming = `${dbPath}.restoring`;
  try {
    const source = files.kind === 's3' ? await files.open(`backups/${backupName}`) : await openLocal(join(backupDir, backupName));
    if (!source) throw new Error(`Backup ${backupName} was not found`);
    await pipeline(source, createGunzip(), createWriteStream(incoming));
    verifySnapshot(incoming);
  } catch (error) {
    rmSync(marker, { force: true });
    rmSync(incoming, { force: true });
    throw error;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      renameSync(dbPath + suffix, `${dbPath}.before-restore-${stamp}${suffix}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  renameSync(incoming, dbPath);
  console.log(`Restored ${backupName} into ${basename(dbPath)}. The previous database was kept as ${basename(dbPath)}.before-restore-${stamp}.`);
  return true;
}
