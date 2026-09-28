import { useEffect, useRef, useState } from 'react';
import * as Y from 'yjs';
import { api } from './api';
import { realtime } from './realtime';

/**
 * Browser side of live collaboration. A LiveDoc keeps a Yjs copy of a page or whiteboard,
 * sends local edits in small batches, applies everyone else's as they arrive over the
 * realtime socket, and catches up by state vector after a reconnect. Edits made while the
 * connection is down are kept and sent when it comes back.
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
  return btoa(s);
};
const bytes = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export const REMOTE = Symbol('remote');
export const LOCAL = Symbol('local');
const PEER_TTL = 30_000;

export class LiveDoc {
  doc = new Y.Doc();
  readonly key: string;
  readonly clientId = Math.random().toString(36).slice(2, 12);
  canEdit = false;
  ready = false;
  status: SaveStatus = 'connecting';
  peers = new Map<string, Peer>();
  private pending: Uint8Array[] = [];
  private flushTimer?: number;
  private heartbeat?: number;
  private listeners = new Set<() => void>();
  private unsubscribe?: () => void;
  private presenceState: Omit<Peer, 'clientId' | 'user' | 'at'> = { cursor: null, selection: null };
  private lastPresence = 0;
  private presenceTimer?: number;
  private stopped = false;

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
    this.heartbeat = window.setInterval(() => {
      const cutoff = Date.now() - PEER_TTL;
      for (const [id, p] of this.peers) if (p.at < cutoff) this.peers.delete(id);
      void this.sendPresence(true);
      this.emit();
    }, 10_000);
    void this.sendPresence(true);
  }

  stop() {
    this.stopped = true;
    window.clearInterval(this.heartbeat);
    window.clearTimeout(this.presenceTimer);
    this.unsubscribe?.();
    this.doc.off('update', this.onLocalUpdate);
    void this.flush();
    void this.sendPresence(false);
    this.listeners.clear();
  }

  /** Fetch whatever this copy is missing. */
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

  /** The saved text changed underneath us (restored version, API): start from it again. */
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
    window.clearTimeout(this.flushTimer);
    this.flushTimer = window.setTimeout(() => void this.flush(), 120);
    this.emit();
  };

  private flushing = false;
  async flush() {
    if (this.flushing || !this.pending.length) return;
    this.flushing = true;
    const batch = this.pending;
    this.pending = [];
    try {
      await api.post(`/collab/${this.kind}/${this.id}/update`, { update: b64(Y.mergeUpdates(batch)), clientId: this.clientId });
      this.status = this.pending.length ? 'saving' : 'saved';
    } catch {
      // Keep the edits and try again; they merge cleanly whenever they arrive.
      this.pending = [...batch, ...this.pending];
      this.status = 'offline';
      if (!this.stopped) this.flushTimer = window.setTimeout(() => void this.flush(), 3000);
    } finally {
      this.flushing = false;
    }
    this.emit();
    if (this.pending.length && this.status !== 'offline') void this.flush();
  }

  /** Share where you are (throttled). */
  setPresence(state: Partial<Omit<Peer, 'clientId' | 'user' | 'at'>>) {
    this.presenceState = { ...this.presenceState, ...state };
    const wait = 150 - (Date.now() - this.lastPresence);
    window.clearTimeout(this.presenceTimer);
    if (wait <= 0) void this.sendPresence(true);
    else this.presenceTimer = window.setTimeout(() => void this.sendPresence(true), wait);
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

/** Open a live document for as long as the component is mounted. */
export function useLiveDoc(kind: DocKind, id: string | undefined, enabled = true) {
  const [live, setLive] = useState<LiveDoc | null>(null);
  const [, bump] = useState(0);
  useEffect(() => {
    if (!id || !enabled) return;
    const d = new LiveDoc(kind, id);
    setLive(d);
    const off = d.onChange(() => bump((n) => n + 1));
    void d.start();
    const leave = () => d.stop();
    window.addEventListener('pagehide', leave);
    return () => {
      window.removeEventListener('pagehide', leave);
      off();
      d.stop();
    };
  }, [kind, id, enabled]);
  return live;
}

/**
 * Keep a text field in step with a Y.Text: local typing becomes minimal inserts and deletes,
 * and remote changes move the caret so it stays on the same character.
 */
export function useYText(live: LiveDoc | null, name: string) {
  const [value, setValue] = useState('');
  const ref = useRef<HTMLTextAreaElement & HTMLInputElement>(null);
  const doc = live?.doc;
  useEffect(() => {
    if (!doc) return;
    const text = doc.getText(name);
    setValue(text.toString());
    const observer = (event: Y.YTextEvent, tr: Y.Transaction) => {
      const next = text.toString();
      const el = ref.current;
      if (tr.origin !== LOCAL && el && document.activeElement === el) {
        const move = (pos: number) => {
          let index = 0;
          for (const op of event.delta) {
            if (op.retain) index += op.retain;
            else if (typeof op.insert === 'string') {
              if (index <= pos) pos += op.insert.length;
              index += op.insert.length;
            } else if (op.delete) {
              if (index < pos) pos -= Math.min(op.delete, pos - index);
            }
          }
          return pos;
        };
        const start = move(el.selectionStart ?? 0);
        const end = move(el.selectionEnd ?? 0);
        el.value = next;
        el.setSelectionRange(start, end);
      }
      setValue(next);
    };
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
  return { value, onChange, ref };
}
