import { createReadStream, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';

/**
 * Where uploaded file contents live. The local disk works for a single server;
 * S3-compatible object storage (AWS S3, Cloudflare R2, Backblaze B2, MinIO…) lets
 * several Küü servers share the same files.
 */
export interface FileStore {
  readonly kind: 'local' | 's3' | 'gcs';
  /** Move a finished upload (a temporary local file) into storage under `key`. */
  put(key: string, localPath: string, contentType: string): Promise<void>;
  /** Open a stored file for reading (optionally just bytes start..end, inclusive), or null if it's gone. */
  open(key: string, range?: { start: number; end: number }): Promise<Readable | null>;
  remove(key: string): Promise<void>;
  /** Stored files whose keys start with `prefix` (used for backups). */
  list(prefix: string): Promise<{ key: string; size: number; modified: string }[]>;
}

export class LocalFileStore implements FileStore {
  readonly kind = 'local' as const;
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  async put(key: string, localPath: string) {
    renameSync(localPath, join(this.dir, key));
  }

  async open(key: string, range?: { start: number; end: number }) {
    const path = join(this.dir, key);
    return existsSync(path) && statSync(path).isFile() ? createReadStream(path, range) : null;
  }

  async remove(key: string) {
    try {
      unlinkSync(join(this.dir, key));
    } catch {
      /* already gone */
    }
  }

  async list(prefix: string) {
    return readdirSync(this.dir)
      .filter((name) => name.startsWith(prefix))
      .map((name) => ({ name, stat: statSync(join(this.dir, name)) }))
      .filter((f) => f.stat.isFile())
      .map((f) => ({ key: f.name, size: f.stat.size, modified: f.stat.mtime.toISOString() }));
  }
}

export interface S3Settings {
  bucket: string;
  region?: string;
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  /** Needed by MinIO and some other providers that don't support bucket subdomains. */
  forcePathStyle?: boolean;
  /** Optional key prefix, e.g. "softex/". */
  prefix?: string;
}

export class S3FileStore implements FileStore {
  readonly kind = 's3' as const;
  private client?: import('@aws-sdk/client-s3').S3Client;

  constructor(private readonly settings: S3Settings) {}

  private async s3() {
    const sdk = await import('@aws-sdk/client-s3');
    this.client ??= new sdk.S3Client({
      region: this.settings.region ?? 'auto',
      endpoint: this.settings.endpoint,
      forcePathStyle: this.settings.forcePathStyle,
      // Plain uploads without chunked checksums: many S3-compatible providers don't support the newer default.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      credentials:
        this.settings.accessKeyId && this.settings.secretAccessKey
          ? { accessKeyId: this.settings.accessKeyId, secretAccessKey: this.settings.secretAccessKey }
          : undefined,
    });
    return { sdk, client: this.client };
  }

  private key(key: string) {
    return `${this.settings.prefix ?? ''}${key}`;
  }

  async put(key: string, localPath: string, contentType: string) {
    const { sdk, client } = await this.s3();
    try {
      await client.send(
        new sdk.PutObjectCommand({
          Bucket: this.settings.bucket,
          Key: this.key(key),
          Body: createReadStream(localPath),
          ContentLength: statSync(localPath).size,
          ContentType: contentType,
        }),
      );
    } finally {
      try {
        unlinkSync(localPath);
      } catch {
        /* already removed */
      }
    }
  }

  async open(key: string, range?: { start: number; end: number }) {
    const { sdk, client } = await this.s3();
    try {
      const res = await client.send(
        new sdk.GetObjectCommand({ Bucket: this.settings.bucket, Key: this.key(key), Range: range ? `bytes=${range.start}-${range.end}` : undefined }),
      );
      return (res.Body as Readable | undefined) ?? null;
    } catch (error) {
      if ((error as { name?: string }).name === 'NoSuchKey') return null;
      throw error;
    }
  }

  async remove(key: string) {
    const { sdk, client } = await this.s3();
    await client.send(new sdk.DeleteObjectCommand({ Bucket: this.settings.bucket, Key: this.key(key) }));
  }

  async list(prefix: string) {
    const { sdk, client } = await this.s3();
    const out: { key: string; size: number; modified: string }[] = [];
    const base = this.key('');
    let token: string | undefined;
    do {
      const res = await client.send(new sdk.ListObjectsV2Command({ Bucket: this.settings.bucket, Prefix: this.key(prefix), ContinuationToken: token }));
      for (const o of res.Contents ?? []) {
        if (o.Key) out.push({ key: o.Key.slice(base.length), size: o.Size ?? 0, modified: (o.LastModified ?? new Date()).toISOString() });
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
    return out;
  }
}

export interface GcsSettings {
  bucket: string;
  /** Optional key prefix, e.g. "uploads/". */
  prefix?: string;
  /** Override for tests and emulators (default https://storage.googleapis.com). */
  endpoint?: string;
}

/**
 * Google Cloud Storage over its JSON API, authenticated as the service account the app runs as
 * (the Cloud Run metadata server), so no keys are stored anywhere. Files are capped well below
 * the size where resumable uploads would matter.
 */
export class GcsFileStore implements FileStore {
  readonly kind = 'gcs' as const;
  private token?: { value: string; expires: number };

  constructor(private readonly settings: GcsSettings) {}

  private get base() {
    return (this.settings.endpoint ?? 'https://storage.googleapis.com').replace(/\/$/, '');
  }

  private key(key: string) {
    return `${this.settings.prefix ?? ''}${key}`;
  }

  private async headers(): Promise<Record<string, string>> {
    // An emulator or a local fake needs no credentials.
    if (this.settings.endpoint) return {};
    if (!this.token || this.token.expires < Date.now() + 60_000) {
      const res = await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', {
        headers: { 'Metadata-Flavor': 'Google' },
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) throw new Error(`Could not get a Cloud Storage access token (${res.status})`);
      const body = (await res.json()) as { access_token: string; expires_in: number };
      this.token = { value: body.access_token, expires: Date.now() + body.expires_in * 1000 };
    }
    return { Authorization: `Bearer ${this.token.value}` };
  }

  private object(key: string) {
    return `${this.base}/storage/v1/b/${encodeURIComponent(this.settings.bucket)}/o/${encodeURIComponent(this.key(key))}`;
  }

  async put(key: string, localPath: string, contentType: string) {
    try {
      const size = statSync(localPath).size;
      const url = `${this.base}/upload/storage/v1/b/${encodeURIComponent(this.settings.bucket)}/o?uploadType=media&name=${encodeURIComponent(this.key(key))}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { ...(await this.headers()), 'Content-Type': contentType, 'Content-Length': String(size) },
        body: Readable.toWeb(createReadStream(localPath)) as ReadableStream,
        duplex: 'half',
      } as RequestInit);
      if (!res.ok) throw new Error(`Cloud Storage upload failed (${res.status})`);
    } finally {
      try {
        unlinkSync(localPath);
      } catch {
        /* already removed */
      }
    }
  }

  async open(key: string, range?: { start: number; end: number }) {
    const res = await fetch(`${this.object(key)}?alt=media`, {
      headers: { ...(await this.headers()), ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}) },
    });
    if (res.status === 404) return null;
    if (!res.ok || !res.body) throw new Error(`Cloud Storage download failed (${res.status})`);
    return Readable.fromWeb(res.body as import('node:stream/web').ReadableStream);
  }

  async remove(key: string) {
    const res = await fetch(this.object(key), { method: 'DELETE', headers: await this.headers() });
    if (!res.ok && res.status !== 404) throw new Error(`Cloud Storage delete failed (${res.status})`);
  }

  async list(prefix: string) {
    const out: { key: string; size: number; modified: string }[] = [];
    const base = this.key('');
    let token: string | undefined;
    do {
      const query = new URLSearchParams({ prefix: this.key(prefix), fields: 'items(name,size,updated),nextPageToken' });
      if (token) query.set('pageToken', token);
      const res = await fetch(`${this.base}/storage/v1/b/${encodeURIComponent(this.settings.bucket)}/o?${query}`, { headers: await this.headers() });
      if (!res.ok) throw new Error(`Cloud Storage list failed (${res.status})`);
      const body = (await res.json()) as { items?: { name: string; size: string; updated: string }[]; nextPageToken?: string };
      for (const o of body.items ?? []) out.push({ key: o.name.slice(base.length), size: Number(o.size), modified: o.updated });
      token = body.nextPageToken;
    } while (token);
    return out;
  }
}
