import { AppState } from 'react-native';
import { authHeaders, session } from './api';

/** WebSocket connection with automatic reconnection and a tiny pub/sub, like the web app's. */
type Handler = (event: any) => void;

class Realtime {
  private socket?: WebSocket;
  private handlers = new Set<Handler>();
  private retry = 0;
  private stopped = true;
  private timer?: ReturnType<typeof setTimeout>;
  private appState?: { remove: () => void };
  online = new Set<string>();

  start() {
    this.stopped = false;
    this.connect();
    // Phones suspend sockets in the background; reconnect (and refetch) when the app comes back.
    this.appState ??= AppState.addEventListener('change', (state) => {
      if (this.stopped) return;
      if (state === 'active' && this.socket?.readyState !== WebSocket.OPEN) {
        clearTimeout(this.timer);
        this.retry = Math.max(this.retry, 1);
        this.connect();
      }
    });
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.appState?.remove();
    this.appState = undefined;
    const s = this.socket;
    this.socket = undefined;
    s?.close();
  }

  private connect() {
    if (this.stopped) return;
    this.socket?.close();
    const url = `${session.server.replace(/^http/, 'ws')}/ws`;
    // React Native's WebSocket accepts headers as a third argument; browsers send the cookie instead.
    const Ctor = WebSocket as unknown as new (url: string, protocols?: string[] | null, options?: { headers: Record<string, string> }) => WebSocket;
    const socket = new Ctor(url, null, { headers: authHeaders() });
    this.socket = socket;
    socket.onopen = () => {
      if (this.retry > 0) this.emit({ type: 'reconnected' });
      this.retry = 0;
    };
    socket.onmessage = (e) => {
      try {
        const event = JSON.parse(String(e.data));
        if (event.type === 'hello') this.online = new Set(event.online);
        if (event.type === 'presence') event.online ? this.online.add(event.userId) : this.online.delete(event.userId);
        this.emit(event);
      } catch {
        /* ignore */
      }
    };
    socket.onclose = (e) => {
      if (this.socket !== socket || this.stopped || e.code === 4001) return;
      this.retry += 1;
      this.timer = setTimeout(() => this.connect(), Math.min(30_000, 500 * 2 ** this.retry));
    };
  }

  private emit(event: any) {
    for (const h of this.handlers) h(event);
  }

  subscribe(handler: Handler) {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  send(event: object) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(event));
  }
}

export const realtime = new Realtime();
