import { randomBytes, scryptSync, timingSafeEqual, createHash, randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { ZodError, type ZodType } from 'zod';

export const newId = () => randomUUID();
export const now = () => new Date().toISOString();
export const today = () => new Date().toISOString().slice(0, 10);

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
