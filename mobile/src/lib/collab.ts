import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import * as Y from 'yjs';
import { api } from './api';
import { realtime } from './realtime';

/**
 * Phone side of live collaboration, the same protocol as the web app: a Yjs copy of a page
 * or whiteboard, local edits sent in small batches, everyone else's applied as they arrive
 * over the realtime socket, and a state-vector catch-up after reconnecting.
 */

export type DocKind = 'page' | 'board';
export type SaveStatus = 'connecting' | 'saved' | 'saving' | 'offline';

export interface Peer {
  clientId: string;
  user: { id: string; name: string; color: string };
  cursor: { x: number; y: number } | null;
  selection: { field: 'title' | 'body'; start: number; end: number } | null;
  at: number;
}

const b64 = (u: Uint8Array) => {
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return globalThis.btoa(s);
};
const bytes = (s: string) => Uint8Array.from(globalThis.atob(s), (ch) => ch.charCodeAt(0));

export const REMOTE = Symbol('remote');
export const LOCAL = Symbol('local');
const PEER_TTL = 30_000;

/** An immutable picture of a live document, replaced on every change so memoised (React Compiler) renders see it. */
export interface LiveState {
  doc: Y.Doc;
  ready: boolean;
  status: SaveStatus;
  canEdit: boolean;
  peers: Peer[];
}

export class LiveDoc {
  doc = new Y.Doc();
  readonly key: string;
  readonly clientId = Math.random().toString(36).slice(2, 12);
  canEdit = false;
  ready = false;
  status: SaveStatus = 'connecting';
  peers = new Map<string, Peer>();
  private pending: Uint8Array[] = [];
  private flushTimer?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private listeners = new Set<() => void>();
  private unsubscribe?: () => void;
  private presenceState: Omit<Peer, 'clientId' | 'user' | 'at'> = { cursor: null, selection: null };
  private lastPresence = 0;
  private presenceTimer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private flushing = false;
  state: LiveState = { doc: this.doc, ready: false, status: 'connecting', canEdit: false, peers: [] };

  constructor(
    readonly kind: DocKind,
    readonly id: string,
  ) {
    this.key = `${kind}:${id}`;
  }

  onChange(fn: () => void) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }
  private emit() {
    this.state = { doc: this.doc, ready: this.ready, status: this.status, canEdit: this.canEdit, peers: [...this.peers.values()] };
    this.listeners.forEach((l) => l());
  }

  async start() {
    this.doc.on('update', this.onLocalUpdate);
    this.unsubscribe = realtime.subscribe((e) => {
      if (e.type === 'collab.update' && e.key === this.key && e.clientId !== this.clientId) {
        try {
          Y.applyUpdate(this.doc, bytes(e.update), REMOTE);
        } catch {
          void this.sync();
        }
      } else if (e.type === 'collab.presence' && e.key === this.key && e.clientId !== this.clientId) {
        if (e.active) this.peers.set(e.clientId, { clientId: e.clientId, user: e.user, cursor: e.cursor, selection: e.selection, at: Date.now() });
        else this.peers.delete(e.clientId);
        this.emit();
      } else if (e.type === 'collab.reset' && e.key === this.key) {
        void this.restart();
      } else if (e.type === 'reconnected') {
        void this.sync().then(() => this.flush());
      }
    });
    await this.sync();
    this.heartbeat = setInterval(() => {
      const cutoff = Date.now() - PEER_TTL;
      for (const [id, p] of this.peers) if (p.at < cutoff) this.peers.delete(id);
      void this.sendPresence(true);
      this.emit();
    }, 10_000);
    void this.sendPresence(true);
  }

  stop() {
    this.stopped = true;
    clearInterval(this.heartbeat);
    clearTimeout(this.presenceTimer);
    this.unsubscribe?.();
    this.doc.off('update', this.onLocalUpdate);
    void this.flush();
    void this.sendPresence(false);
    this.listeners.clear();
  }

  async sync() {
    try {
      const res = await api.post<{ update: string; can_edit: boolean }>(`/collab/${this.kind}/${this.id}/sync`, {
        stateVector: this.ready ? b64(Y.encodeStateVector(this.doc)) : undefined,
      });
      Y.applyUpdate(this.doc, bytes(res.update), REMOTE);
      this.canEdit = res.can_edit;
      this.ready = true;
      if (this.status === 'connecting' || this.status === 'offline') this.status = this.pending.length ? 'saving' : 'saved';
    } catch {
      this.status = 'offline';
    }
    this.emit();
  }

  private async restart() {
    this.pending = [];
    this.doc.off('update', this.onLocalUpdate);
    const fresh = new Y.Doc();
    this.doc.destroy();
    this.doc = fresh;
    this.doc.on('update', this.onLocalUpdate);
    this.ready = false;
    await this.sync();
  }

  private onLocalUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === REMOTE || !this.canEdit) return;
    this.pending.push(update);
    this.status = 'saving';
    clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => void this.flush(), 120);
    this.emit();
  };

  async flush() {
    if (this.flushing || !this.pending.length) return;
    this.flushing = true;
    const batch = this.pending;
    this.pending = [];
    try {
      await api.post(`/collab/${this.kind}/${this.id}/update`, { update: b64(Y.mergeUpdates(batch)), clientId: this.clientId });
      this.status = this.pending.length ? 'saving' : 'saved';
    } catch {
      this.pending = [...batch, ...this.pending];
      this.status = 'offline';
      if (!this.stopped) this.flushTimer = setTimeout(() => void this.flush(), 3000);
    } finally {
      this.flushing = false;
    }
    this.emit();
    if (this.pending.length && this.status !== 'offline') void this.flush();
  }

  setPresence(state: Partial<Omit<Peer, 'clientId' | 'user' | 'at'>>) {
    this.presenceState = { ...this.presenceState, ...state };
    const wait = 150 - (Date.now() - this.lastPresence);
    clearTimeout(this.presenceTimer);
    if (wait <= 0) void this.sendPresence(true);
    else this.presenceTimer = setTimeout(() => void this.sendPresence(true), wait);
  }

  private async sendPresence(active: boolean) {
    this.lastPresence = Date.now();
    try {
      await api.post(`/collab/${this.kind}/${this.id}/presence`, { active, clientId: this.clientId, ...this.presenceState });
    } catch {
      /* presence is best effort */
    }
  }
}

/** Open a live document for as long as the screen is mounted; edits are flushed when the app goes to the background. */
export function useLiveDoc(kind: DocKind, id: string | undefined, enabled = true) {
  const [live, setLive] = useState<LiveDoc | null>(null);
  useEffect(() => {
    if (!id || !enabled) return;
    const d = new LiveDoc(kind, id);
    setLive(d);
    void d.start();
    const sub = AppState.addEventListener('change', (s) => s !== 'active' && void d.flush());
    return () => {
      sub.remove();
      d.stop();
    };
  }, [kind, id, enabled]);
  return live;
}

const NO_STATE: LiveState | null = null;
/** Re-render whenever the live document's state changes; read ready, status, peers and the Y.Doc from here, not from the LiveDoc. */
export function useLiveState(live: LiveDoc | null) {
  return useSyncExternalStore(
    useCallback((fn: () => void) => (live ? live.onChange(fn) : () => {}), [live]),
    () => live?.state ?? NO_STATE,
    () => live?.state ?? NO_STATE,
  );
}

/** Keep a text input in step with a Y.Text: typing becomes minimal inserts and deletes. */
export function useYText(live: LiveDoc | null, name: string) {
  const [value, setValue] = useState('');
  const doc = useLiveState(live)?.doc;
  useEffect(() => {
    if (!doc) return;
    const text = doc.getText(name);
    setValue(text.toString());
    const observer = () => setValue(text.toString());
    text.observe(observer);
    return () => text.unobserve(observer);
  }, [doc, name]);
  const onChange = (next: string) => {
    if (!doc) return;
    const text = doc.getText(name);
    const prev = text.toString();
    if (prev === next) return;
    let start = 0;
    while (start < prev.length && start < next.length && prev[start] === next[start]) start++;
    let endPrev = prev.length;
    let endNext = next.length;
    while (endPrev > start && endNext > start && prev[endPrev - 1] === next[endNext - 1]) {
      endPrev--;
      endNext--;
    }
    doc.transact(() => {
      if (endPrev > start) text.delete(start, endPrev - start);
      if (endNext > start) text.insert(start, next.slice(start, endNext));
    }, LOCAL);
    setValue(next);
  };
  return { value, onChange };
}
