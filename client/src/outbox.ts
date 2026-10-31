import { useMemo, useSyncExternalStore } from 'react';
import { api, ApiError, type Message } from './api';
import { realtime } from './realtime';

/**
 * Messages on their way to the server. They show in the chat the moment they're sent (faded while sending)
 * and are swapped for the real message once the server has it, so sending never leaves the screen waiting.
 *
 * Each message carries its own id (`clientId`), sent with every attempt: if an answer is lost and the message is
 * sent again, the server returns the one it already has instead of posting it twice. That makes retrying safe,
 * so messages that couldn't reach the server are tried again by themselves when the connection comes back, and
 * are kept on this device until then (a reload or a closed tab doesn't lose them).
 */
export interface Outgoing {
  key: string;
  clientId: string;
  channelId: string;
  parentId: string | null;
  body: string;
  fileIds: string[];
  fileNames: string[];
  urgent: boolean;
  createdAt: string;
  status: 'sending' | 'failed';
  error?: string;
  /** The server turned it down (rather than being unreachable): it needs the sender to act, not a retry. */
  refused?: boolean;
}

const STORE = 'kuu:outbox';
const newClientId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

function restore(): Outgoing[] {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) ?? '[]') as Outgoing[];
    // Anything left from last time was interrupted: show it as not sent until it's tried again.
    return Array.isArray(saved) ? saved.filter((o) => o && o.clientId && o.channelId).map((o) => ({ ...o, status: 'failed' as const, error: o.error ?? 'not sent yet' })) : [];
  } catch {
    return [];
  }
}

let items: Outgoing[] = typeof window === 'undefined' ? [] : restore();
const listeners = new Set<() => void>();
const deliveredListeners = new Set<(message: Message, key: string) => void>();
const inFlight = new Set<string>();
let counter = 0;

const emit = () => listeners.forEach((l) => l());
const set = (next: Outgoing[]) => {
  items = next;
  try {
    if (items.length) localStorage.setItem(STORE, JSON.stringify(items));
    else localStorage.removeItem(STORE);
  } catch {
    /* private mode: kept for this visit only */
  }
  emit();
};
const patch = (key: string, change: Partial<Outgoing>) => set(items.map((o) => (o.key === key ? { ...o, ...change } : o)));

async function deliver(key: string) {
  const item = items.find((o) => o.key === key);
  if (!item || inFlight.has(key)) return;
  inFlight.add(key);
  patch(key, { status: 'sending', error: undefined, refused: false });
  try {
    const message = await api.post<Message>(`/channels/${item.channelId}/messages`, {
      body: item.body,
      parentId: item.parentId,
      fileIds: item.fileIds,
      urgent: item.urgent,
      clientId: item.clientId,
    });
    set(items.filter((o) => o.key !== key));
    deliveredListeners.forEach((l) => l(message, key));
  } catch (e) {
    // A server answer explains itself; anything else means the server couldn't be reached (and is retried later).
    const refused = e instanceof ApiError && e.status < 500 && e.status !== 408 && e.status !== 429;
    patch(key, { status: 'failed', error: e instanceof ApiError && refused ? e.message : 'no connection to Küü', refused });
  } finally {
    inFlight.delete(key);
  }
}

/** Try again everything that failed only because the server couldn't be reached. */
function retryUnreachable() {
  for (const o of items) if (o.status === 'failed' && !o.refused) void deliver(o.key);
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', retryUnreachable);
  realtime.subscribe((e) => e.type === 'reconnected' && retryUnreachable());
  // Restored from last visit: give them a moment for the app to start, then try again.
  if (items.length) window.setTimeout(retryUnreachable, 1500);
}

export const outbox = {
  /** Show a message straight away and send it. */
  send(input: Omit<Outgoing, 'key' | 'createdAt' | 'status' | 'clientId'>) {
    const key = `out-${Date.now().toString(36)}-${counter++}`;
    set([...items, { ...input, key, clientId: newClientId(), createdAt: new Date().toISOString(), status: 'sending' }]);
    void deliver(key);
    return key;
  },
  retry: (key: string) => void deliver(key),
  /** After reconnecting: resend what couldn't get through (safe — the server ignores repeats). */
  retryUnreachable,
  discard: (key: string) => set(items.filter((o) => o.key !== key)),
  /**
   * The server's copy of one of our messages arrived over the socket before the send finished:
   * drop the matching outgoing one so it isn't shown twice. Returns whether one matched.
   */
  settle(message: Message) {
    const match =
      items.find((o) => !!message.client_id && o.clientId === message.client_id) ??
      items.find((o) => o.status === 'sending' && o.channelId === message.channel_id && o.parentId === message.parent_id && o.body === message.body);
    if (match) set(items.filter((o) => o !== match));
    return !!match;
  },
  onDelivered(fn: (message: Message, key: string) => void) {
    deliveredListeners.add(fn);
    return () => void deliveredListeners.delete(fn);
  },
};

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};

/** Outgoing messages for one chat (or one thread, with its parent id). */
export function useOutbox(channelId: string | undefined, parentId: string | null = null) {
  const all = useSyncExternalStore(subscribe, () => items);
  return useMemo(() => all.filter((o) => o.channelId === channelId && o.parentId === parentId), [all, channelId, parentId]);
}
