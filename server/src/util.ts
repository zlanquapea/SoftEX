import { randomBytes, scryptSync, timingSafeEqual, createHash, randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { ZodError, type ZodType } from 'zod';

export const newId = () => randomUUID();
export const now = () => new Date().toISOString();
export const today = () => new Date().toISOString().slice(0, 10);

/** A due date for people to read: "Wed, Sep 30" (with the year when it isn't this year). Takes "YYYY-MM-DD". */
export function friendlyDate(day: string | null | undefined) {
  if (!day) return '';
  const d = new Date(`${day.slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return day;
  const year = d.getUTCFullYear() === new Date().getUTCFullYear() ? undefined : 'numeric';
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year, timeZone: 'UTC' });
}

/** A moment in someone's own time zone: "Thu, Oct 1, 2:00 PM (Europe/London)". Falls back to UTC. */
export function friendlyTime(iso: string, timeZone?: string | null) {
  const d = new Date(iso);
  const opts: Intl.DateTimeFormatOptions = { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
  try {
    if (timeZone) return `${d.toLocaleString('en-US', { ...opts, timeZone })} (${timeZone})`;
  } catch {
    /* unknown zone: fall through to UTC */
  }
  return `${d.toLocaleString('en-US', { ...opts, timeZone: 'UTC' })} UTC`;
}

export class HttpError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
  }
}

export const notFound = (what = 'Resource') => new HttpError(404, `${what} not found`);
export const forbidden = (message = 'You do not have access to this item') => new HttpError(403, message);
export const badRequest = (message: string, details?: unknown) => new HttpError(400, message, details);

export function parse<T>(schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw badRequest(`${issue.path.join('.') || 'input'}: ${issue.message}`, result.error.issues);
  }
  return result.data;
}

/**
 * Parse a partial update. Zod 4 fills in `.default()` values even for keys that were left out,
 * which would reset fields nobody asked to change, so only keys present in the request are kept.
 */
export function parsePatch<T extends object>(schema: ZodType<T>, value: unknown): Partial<T> {
  const parsed = parse(schema, value);
  const sent = value && typeof value === 'object' ? new Set(Object.keys(value)) : new Set<string>();
  return Object.fromEntries(Object.entries(parsed).filter(([key]) => sent.has(key))) as Partial<T>;
}

/**
 * Does a browser origin match an allowed pattern? Patterns are full origins such as
 * `https://kuu.example.com`; a `*` matches one run of letters, digits and hyphens, so
 * `https://my-space-*.app.github.dev` covers every forwarded port of one codespace.
 */
export function originAllowed(origin: string, patterns: string[]) {
  const o = origin.toLowerCase().replace(/\/$/, '');
  return patterns.some((p) => {
    const pattern = p.trim().toLowerCase().replace(/\/$/, '');
    if (!pattern) return false;
    if (!pattern.includes('*')) return pattern === o;
    const re = new RegExp(`^${pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[a-z0-9-]+')}$`);
    return re.test(o);
  });
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length);
  return timingSafeEqual(expected, actual);
}

export const randomToken = () => randomBytes(32).toString('base64url');
export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message, details: err.details });
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({ error: 'Invalid input', details: err.issues });
    return;
  }
  const anyErr = err as { code?: string; message?: string; status?: number; type?: string };
  if (anyErr?.code === 'LIMIT_FILE_SIZE') {
    res.status(413).json({ error: 'File is too large' });
    return;
  }
  if (anyErr?.type === 'entity.parse.failed') {
    res.status(400).json({ error: 'Malformed JSON body' });
    return;
  }
  console.error(err);
  res.status(500).json({ error: 'Something went wrong' });
}

export const parseJson = <T>(value: string | null | undefined, fallback: T): T => {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

/** Escape a user-supplied search term for use in a LIKE pattern. */
export const likePattern = (term: string) => `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** Extract @mentions of the form @[Name](user-id) or plain @handle from a message body. */
export function extractMentionIds(body: string): string[] {
  const ids = new Set<string>();
  for (const match of body.matchAll(/@\[[^\]]+\]\(([0-9a-f-]{36})\)/g)) ids.add(match[1]);
  return [...ids];
}

export const COLORS = ['purple', 'blue', 'green', 'coral', 'gold', 'sky', 'mint', 'lilac', 'orange'];
export const pickColor = (seed: string) => COLORS[[...seed].reduce((a, c) => a + c.charCodeAt(0), 0) % COLORS.length];

/** Array.filter with an async predicate (checks run concurrently, order is kept). */
export async function filterAsync<T>(items: readonly T[], predicate: (item: T, index: number) => boolean | Promise<boolean>): Promise<T[]> {
  const keep = await Promise.all(items.map((item, i) => predicate(item, i)));
  return items.filter((_, i) => keep[i] === true);
}

/** A short, human-readable device label from a User-Agent header, e.g. "Chrome on Android". */
export function describeDevice(userAgent: string | null | undefined): string {
  const ua = userAgent ?? '';
  if (!ua) return 'Unknown device';
  const browser =
    /Edg\//.test(ua) ? 'Edge'
    : /OPR\/|Opera/.test(ua) ? 'Opera'
    : /SamsungBrowser/.test(ua) ? 'Samsung Internet'
    : /Firefox\/|FxiOS/.test(ua) ? 'Firefox'
    : /Chrome\/|CriOS/.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari'
    : /curl|node|python|axios|okhttp/i.test(ua) ? 'Script'
    : 'Browser';
  const os =
    /Android/.test(ua) ? 'Android'
    : /iPhone|iPad|iPod/.test(ua) ? 'iOS'
    : /Windows/.test(ua) ? 'Windows'
    : /Mac OS X|Macintosh/.test(ua) ? 'macOS'
    : /CrOS/.test(ua) ? 'ChromeOS'
    : /Linux/.test(ua) ? 'Linux'
    : '';
  return os ? `${browser} on ${os}` : browser;
}
