import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { Auth } from './access.js';

export interface RealtimeEvent {
  type: string;
  [key: string]: unknown;
}

/**
 * Who may receive an event. Audiences are plain data (not functions) so they can be sent
 * to other SoftEX servers, each of which checks them against the database for its own
 * connected clients.
 */
export type Audience =
  | { kind: 'workspace' }
  | { kind: 'user'; userId: string }
  | { kind: 'channel'; channelId: string; exceptUserId?: string }
  | { kind: 'task'; taskId: string }
  | { kind: 'meeting'; meetingId: string };

/** Turns an audience into a per-client check (set up by the app with database access). */
export type AudienceResolver = (workspaceId: string, audience: Audience) => Promise<(auth: Auth) => boolean | Promise<boolean>>;

/** Messages exchanged between SoftEX servers. */
type PeerMessage =
  | { t: 'event'; origin: string; workspaceId: string; event: RealtimeEvent; audience: Audience }
  | { t: 'disconnect'; origin: string; workspaceId: string; userId: string }
  | { t: 'disconnect-sessions'; origin: string; userId: string; sessionIds: string[] }
  | { t: 'presence'; origin: string; online: string[] };

/** A publish/subscribe link between servers (PostgreSQL LISTEN/NOTIFY); absent with one server. */
export interface PeerLink {
  publish(payload: string): Promise<void>;
  subscribe(handler: (payload: string) => void): Promise<() => Promise<void>>;
}

interface Client {
  socket: WebSocket;
  auth: Auth;
  alive: boolean;
}

const PRESENCE_EVERY = 20_000;
const PRESENCE_TTL = 65_000;

/**
 * WebSocket hub for messaging, presence and notification delivery (§8 "Real time").
 * Messages are persisted before they are published, so clients that reconnect
 * simply refetch from the REST API; the socket is a delivery accelerator only.
 * With several servers, events, sign-outs and presence are shared through a PeerLink.
 */
export class RealtimeHub {
  readonly id = randomUUID();
  private clients = new Set<Client>();
  private wss?: WebSocketServer;
  private heartbeat?: NodeJS.Timeout;
  private presenceTimer?: NodeJS.Timeout;
  private peers?: PeerLink;
  private unsubscribe?: () => Promise<void>;
  /** Online users on other servers: server id → ("workspace:user" keys, when last heard). */
  private remote = new Map<string, { online: Set<string>; at: number }>();
  resolveAudience: AudienceResolver = async () => () => true;

  attach(server: Server, authenticate: (req: IncomingMessage) => Promise<Auth | null>) {
    this.wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket, head) => {
      if (!req.url?.startsWith('/ws')) return socket.destroy();
      authenticate(req).then(
        (auth) => {
          if (!auth) {
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            return socket.destroy();
          }
          this.wss!.handleUpgrade(req, socket, head, (ws) => this.register(ws, auth));
        },
        (error) => {
          console.error('WebSocket authentication failed', error);
          socket.destroy();
        },
      );
    });
    this.heartbeat = setInterval(() => {
      for (const client of this.clients) {
        if (!client.alive) {
          client.socket.terminate();
          continue;
        }
        client.alive = false;
        client.socket.ping();
      }
    }, 30_000);
    this.heartbeat.unref();
  }

  /** Connect to the other servers sharing this database. */
  async connectPeers(peers: PeerLink) {
    this.peers = peers;
    this.unsubscribe = await peers.subscribe((payload) => {
      try {
        this.onPeerMessage(JSON.parse(payload) as PeerMessage);
      } catch (error) {
        console.error('Ignoring malformed realtime message', error);
      }
    });
    this.presenceTimer = setInterval(() => void this.sharePresence(), PRESENCE_EVERY);
    this.presenceTimer.unref();
    await this.sharePresence();
  }

  private send(message: PeerMessage) {
    if (!this.peers) return Promise.resolve();
    return this.peers.publish(JSON.stringify(message)).catch((error) => console.error('Could not reach other servers', error));
  }

  private onPeerMessage(msg: PeerMessage) {
    if (msg.origin === this.id) return;
    if (msg.t === 'event') void this.deliver(msg.workspaceId, msg.event, msg.audience);
    else if (msg.t === 'disconnect') this.closeLocal(msg.workspaceId, msg.userId);
    else if (msg.t === 'disconnect-sessions') this.closeSessions(msg.userId, msg.sessionIds);
    else if (msg.t === 'presence') {
      const before = this.remote.get(msg.origin)?.online ?? new Set<string>();
      const now = new Set(msg.online);
      this.remote.set(msg.origin, { online: now, at: Date.now() });
      // Tell local clients about people who came online or left on another server.
      for (const key of now) if (!before.has(key)) this.announcePresence(key, true);
      for (const key of before) if (!now.has(key)) this.announcePresence(key, false);
    }
  }

  private announcePresence(key: string, online: boolean) {
    const [workspaceId, userId] = key.split(':');
    if (this.isLocallyOnline(workspaceId, userId)) return;
    void this.deliver(workspaceId, { type: 'presence', userId, online }, { kind: 'workspace' });
  }

  private sharePresence() {
    const online = [...new Set([...this.clients].map((c) => `${c.auth.workspaceId}:${c.auth.userId}`))];
    return this.send({ t: 'presence', origin: this.id, online });
  }

  private register(socket: WebSocket, auth: Auth) {
    const client: Client = { socket, auth, alive: true };
    const wasOnline = this.isOnline(auth.workspaceId, auth.userId);
    this.clients.add(client);
    socket.on('pong', () => (client.alive = true));
    socket.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'typing' && typeof msg.channelId === 'string') {
          this.onTyping?.(auth, msg.channelId).catch((error) => console.error('Typing event failed', error));
        }
      } catch {
        /* ignore malformed frames */
      }
    });
    socket.on('close', () => {
      this.clients.delete(client);
      if (!this.isLocallyOnline(auth.workspaceId, auth.userId)) void this.sharePresence();
      if (!this.isOnline(auth.workspaceId, auth.userId)) {
        void this.publish(auth.workspaceId, { type: 'presence', userId: auth.userId, online: false });
      }
    });
    socket.send(JSON.stringify({ type: 'hello', online: this.onlineUsers(auth.workspaceId) }));
    if (!wasOnline) {
      void this.sharePresence();
      void this.publish(auth.workspaceId, { type: 'presence', userId: auth.userId, online: true });
    }
  }

  onTyping?: (auth: Auth, channelId: string) => Promise<void>;

  private isLocallyOnline(workspaceId: string, userId: string) {
    for (const c of this.clients) if (c.auth.workspaceId === workspaceId && c.auth.userId === userId) return true;
    return false;
  }

  private remoteOnline() {
    const cutoff = Date.now() - PRESENCE_TTL;
    const keys = new Set<string>();
    for (const [origin, entry] of this.remote) {
      if (entry.at < cutoff) this.remote.delete(origin);
      else for (const key of entry.online) keys.add(key);
    }
    return keys;
  }

  /** Whether the person has SoftEX open anywhere (on any server). */
  isOnline(workspaceId: string, userId: string) {
    return this.isLocallyOnline(workspaceId, userId) || this.remoteOnline().has(`${workspaceId}:${userId}`);
  }

  onlineUsers(workspaceId: string) {
    const local = [...this.clients].filter((c) => c.auth.workspaceId === workspaceId).map((c) => c.auth.userId);
    const remote = [...this.remoteOnline()].filter((k) => k.startsWith(`${workspaceId}:`)).map((k) => k.slice(workspaceId.length + 1));
    return [...new Set([...local, ...remote])];
  }

  /** Deliveries run one after another so events arrive in the order they were published. */
  private delivery: Promise<void> = Promise.resolve();

  private deliver(workspaceId: string, event: RealtimeEvent, audience: Audience) {
    const data = JSON.stringify(event);
    const run = async () => {
      const targets = [...this.clients].filter((c) => c.auth.workspaceId === workspaceId);
      if (!targets.length) return;
      const allowed = await this.resolveAudience(workspaceId, audience).then(
        (check) => Promise.all(targets.map((c) => Promise.resolve(check(c.auth)).catch(() => false))),
        () => targets.map(() => false),
      );
      targets.forEach((client, i) => {
        if (allowed[i] === true && client.socket.readyState === WebSocket.OPEN) client.socket.send(data);
      });
    };
    this.delivery = this.delivery.then(run, run).catch((error) => console.error('Realtime delivery failed', error));
    return this.delivery;
  }

  /**
   * Publish to every connected client in a workspace who belongs to the audience, on this
   * server and on the others. Resolves once delivered locally and handed to the other servers.
   */
  async publish(workspaceId: string, event: RealtimeEvent, audience: Audience = { kind: 'workspace' }) {
    const go = async () => {
      await Promise.all([this.deliver(workspaceId, event, audience), this.send({ t: 'event', origin: this.id, workspaceId, event, audience })]);
    };
    await (this.defer ? this.defer(go) : go());
  }

  /** Set by the app so events published inside a transaction go out after it commits. */
  defer?: (fn: () => Promise<void>) => Promise<void>;

  toUser(workspaceId: string, userId: string, event: RealtimeEvent) {
    return this.publish(workspaceId, event, { kind: 'user', userId });
  }

  private closeLocal(workspaceId: string, userId: string) {
    for (const client of this.clients) {
      if (client.auth.workspaceId === workspaceId && client.auth.userId === userId) client.socket.close(4001, 'signed out');
    }
  }

  /** Drop sockets for a user on every server, e.g. after deactivation or logout. */
  disconnect(workspaceId: string, userId: string) {
    this.closeLocal(workspaceId, userId);
    void this.send({ t: 'disconnect', origin: this.id, workspaceId, userId });
  }

  private closeSessions(userId: string, sessionIds: string[]) {
    const ids = new Set(sessionIds);
    for (const client of this.clients) {
      if (client.auth.userId === userId && client.auth.sessionId && ids.has(client.auth.sessionId)) client.socket.close(4001, 'signed out');
    }
  }

  /** Drop the sockets of particular sessions (e.g. "sign out other devices"), on every server. */
  disconnectSessions(userId: string, sessionIds: string[]) {
    if (!sessionIds.length) return;
    this.closeSessions(userId, sessionIds);
    void this.send({ t: 'disconnect-sessions', origin: this.id, userId, sessionIds });
  }

  async close() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.presenceTimer) clearInterval(this.presenceTimer);
    await this.unsubscribe?.().catch(() => {});
    for (const client of this.clients) client.socket.terminate();
    this.wss?.close();
  }
}
