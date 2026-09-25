import { createReadStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Readable } from 'node:stream';

/**
 * Where uploaded file contents live. The local disk works for a single server;
 * S3-compatible object storage (AWS S3, Cloudflare R2, Backblaze B2, MinIO…) lets
 * several SoftEX servers share the same files.
 */
export interface FileStore {
  readonly kind: 'local' | 's3';
  /** Move a finished upload (a temporary local file) into storage under `key`. */
  put(key: string, localPath: string, contentType: string): Promise<void>;
  /** Open a stored file for reading, or null if it's gone. */
  open(key: string): Promise<Readable | null>;
  remove(key: string): Promise<void>;
}

export class LocalFileStore implements FileStore {
  readonly kind = 'local' as const;
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  async put(key: string, localPath: string) {
    renameSync(localPath, join(this.dir, key));
  }

  async open(key: string) {
    const path = join(this.dir, key);
    return existsSync(path) && statSync(path).isFile() ? createReadStream(path) : null;
  }

  async remove(key: string) {
    try {
      unlinkSync(join(this.dir, key));
    } catch {
      /* already gone */
    }
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

  async open(key: string) {
    const { sdk, client } = await this.s3();
    try {
      const res = await client.send(new sdk.GetObjectCommand({ Bucket: this.settings.bucket, Key: this.key(key) }));
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
}
