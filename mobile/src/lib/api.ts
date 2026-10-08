import { Platform } from 'react-native';
import { storage } from './storage';

/**
 * Typed client for the Küü REST API. The phone keeps its session token in secure
 * storage and sends it as a Bearer token; the server hands it over in X-Kuu-Session
 * whenever it starts a session (sign-in, workspace switch, SSO).
 */

export const DEFAULT_SERVER = (process.env.EXPO_PUBLIC_KUU_SERVER || 'https://kuu.example.com').replace(/\/+$/, '');
const SERVER_KEY = 'kuu.server';
const TOKEN_KEY = 'kuu.session';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: any,
  ) {
    super(message);
  }
}

type Listener = () => void;
const unauthorizedListeners = new Set<Listener>();
const mfaListeners = new Set<Listener>();

let server = DEFAULT_SERVER;
let token: string | null = null;

/** The web preview is served next to the API, so it talks to its own origin with cookies. */
const sameOrigin = Platform.OS === 'web' && process.env.EXPO_PUBLIC_KUU_SAME_ORIGIN === '1';

export const session = {
  async load() {
    server = (await storage.get(SERVER_KEY)) || DEFAULT_SERVER;
    token = await storage.get(TOKEN_KEY);
  },
  get server() {
    return sameOrigin ? globalThis.location?.origin ?? server : server;
  },
  get token() {
    return token;
  },
  async setServer(url: string) {
    server = normaliseServer(url);
    if (server === DEFAULT_SERVER) await storage.del(SERVER_KEY);
    else await storage.set(SERVER_KEY, server);
  },
  async setToken(next: string | null) {
    token = next;
    if (next) await storage.set(TOKEN_KEY, next);
    else await storage.del(TOKEN_KEY);
  },
  onUnauthorized(fn: Listener) {
    unauthorizedListeners.add(fn);
    return () => void unauthorizedListeners.delete(fn);
  },
  onMfaRequired(fn: Listener) {
    mfaListeners.add(fn);
    return () => void mfaListeners.delete(fn);
  },
};

export function normaliseServer(url: string) {
  let u = url.trim();
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  const parsed = new URL(u);
  return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, '')}`;
}

/** Full URL for an API path, e.g. a file download. */
export const apiUrl = (path: string) => `${session.server}/api${path}`;

/** Headers that authenticate a request made outside `api` (images, downloads, WebSocket). */
export const authHeaders = (): Record<string, string> => (token && !sameOrigin ? { Authorization: `Bearer ${token}` } : {});

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'x-kuu-client': 'mobile', accept: 'application/json', ...authHeaders() };
  const init: RequestInit = { method, headers, credentials: sameOrigin ? 'same-origin' : 'omit' };
  if (body instanceof FormData) {
    init.body = body;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(apiUrl(path), init);
  } catch {
    throw new ApiError(0, `Can't reach ${session.server.replace(/^https?:\/\//, '')}. Check your connection and try again.`);
  }
  const issued = res.headers.get('x-kuu-session');
  if (issued) await session.setToken(issued);
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    if (!res.ok) throw new ApiError(res.status, `The server responded ${res.status}. Is this a Küü server?`);
  }
  if (!res.ok) {
    const err = new ApiError(res.status, data?.error ?? `Request failed (${res.status})`, data?.details);
    if (res.status === 401 && !path.startsWith('/auth') && !path.startsWith('/invitations')) {
      unauthorizedListeners.forEach((fn) => fn());
    }
    if (res.status === 403 && data?.details?.code === 'mfa_setup_required') mfaListeners.forEach((fn) => fn());
    throw err;
  }
  return data as T;
}

/** A file picked on the device, ready to upload. */
export interface PickedFile {
  uri: string;
  name: string;
  type: string;
  /** Web preview only: the picked File. */
  file?: Blob;
}

export function formWith(fields: Record<string, string | PickedFile | PickedFile[] | undefined>) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    for (const item of Array.isArray(v) ? v : [v]) {
      if (typeof item === 'string') form.append(k, item);
      else if (item.file) form.append(k, item.file as Blob, item.name);
      // React Native's FormData takes { uri, name, type } for files.
      else form.append(k, { uri: item.uri, name: item.name, type: item.type } as unknown as Blob);
    }
  }
  return form;
}

export const api = {
  get: <T = any>(path: string) => request<T>('GET', path),
  post: <T = any>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  patch: <T = any>(path: string, body: unknown) => request<T>('PATCH', path, body),
  put: <T = any>(path: string, body: unknown) => request<T>('PUT', path, body),
  del: <T = any>(path: string, body?: unknown) => request<T>('DELETE', path, body),
  upload: <T = any>(path: string, form: FormData) => request<T>('POST', path, form),
};

export const qs = (params: Record<string, string | number | boolean | undefined | null>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') s.set(k, String(v));
  const str = s.toString();
  return str ? `?${str}` : '';
};

export * from './types';
