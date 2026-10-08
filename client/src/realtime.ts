/** WebSocket connection with automatic reconnection and a tiny pub/sub. */
type Handler = (event: any) => void;

class Realtime {
  private socket?: WebSocket;
  private handlers = new Set<Handler>();
  private retry = 0;
  private stopped = true;
  private timer?: number;
  online = new Set<string>();
  /** What the open screen shows (a chat, a thread), reported while this tab is in front so the server doesn't notify about it. */
  private viewing = new Map<number, string[]>();
  private nextView = 0;
  private reported = '';

  start() {
    this.stopped = false;
    this.connect();
    if (!this.watching) {
      this.watching = true;
      for (const name of ['visibilitychange', 'focus', 'blur'] as const) (name === 'visibilitychange' ? document : window).addEventListener(name, () => this.reportViewing());
    }
  }
  private watching = false;

  /** Add what one part of the screen shows; call the returned function when it goes away. */
  addViewing(keys: string[]) {
    const id = this.nextView++;
    this.viewing.set(id, keys);
    this.reportViewing();
    return () => {
      this.viewing.delete(id);
      this.reportViewing();
    };
  }

  private reportViewing(force = false) {
    // "Active" decides whether the server also pushes to this person's other devices (and this one, when hidden).
    const inFront = document.visibilityState === 'visible' && document.hasFocus();
    const keys = inFront ? [...new Set([...this.viewing.values()].flat())] : [];
    const next = JSON.stringify({ keys, active: inFront });
    if (!force && next === this.reported) return;
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.reported = next;
    this.socket.send(JSON.stringify({ type: 'viewing', keys, active: inFront }));
  }

  stop() {
    this.stopped = true;
    window.clearTimeout(this.timer);
    this.socket?.close();
    this.socket = undefined;
  }

  private connect() {
    if (this.stopped) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${proto}://${location.host}/ws`);
    this.socket = socket;
    socket.onopen = () => {
      // After a reconnect, listeners refetch so nothing sent while offline is missed.
      if (this.retry > 0) this.emit({ type: 'reconnected' });
      this.retry = 0;
      this.reportViewing(true);
    };
    socket.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data);
        if (event.type === 'hello') this.online = new Set(event.online);
        if (event.type === 'presence') event.online ? this.online.add(event.userId) : this.online.delete(event.userId);
        this.emit(event);
      } catch {
        /* ignore */
      }
    };
    socket.onclose = (e) => {
      if (this.stopped || e.code === 4001) return;
      this.retry += 1;
      this.timer = window.setTimeout(() => this.connect(), Math.min(30_000, 500 * 2 ** this.retry));
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
