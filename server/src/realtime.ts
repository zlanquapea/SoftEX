import type { IncomingMessage, Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { Auth } from './access.js';

export interface RealtimeEvent {
  type: string;
  [key: string]: unknown;
}

interface Client {
  socket: WebSocket;
  auth: Auth;
  alive: boolean;
}

/**
 * WebSocket hub for messaging, presence and notification delivery (§8 "Real time").
 * Messages are persisted before they are published, so clients that reconnect
 * simply refetch from the REST API; the socket is a delivery accelerator only.
 */
export class RealtimeHub {
  private clients = new Set<Client>();
  private wss?: WebSocketServer;
  private heartbeat?: NodeJS.Timeout;

  attach(server: Server, authenticate: (req: IncomingMessage) => Auth | null) {
    this.wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket, head) => {
      if (!req.url?.startsWith('/ws')) return socket.destroy();
      const auth = authenticate(req);
      if (!auth) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        return socket.destroy();
      }
      this.wss!.handleUpgrade(req, socket, head, (ws) => this.register(ws, auth));
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

  private register(socket: WebSocket, auth: Auth) {
    const client: Client = { socket, auth, alive: true };
    const wasOnline = this.isOnline(auth.workspaceId, auth.userId);
    this.clients.add(client);
    socket.on('pong', () => (client.alive = true));
    socket.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'typing' && typeof msg.channelId === 'string') {
          this.onTyping?.(auth, msg.channelId);
        }
      } catch {
        /* ignore malformed frames */
      }
    });
    socket.on('close', () => {
      this.clients.delete(client);
      if (!this.isOnline(auth.workspaceId, auth.userId)) {
        this.publish(auth.workspaceId, { type: 'presence', userId: auth.userId, online: false });
      }
    });
    socket.send(JSON.stringify({ type: 'hello', online: this.onlineUsers(auth.workspaceId) }));
    if (!wasOnline) this.publish(auth.workspaceId, { type: 'presence', userId: auth.userId, online: true });
  }

  onTyping?: (auth: Auth, channelId: string) => void;

  isOnline(workspaceId: string, userId: string) {
    for (const c of this.clients) if (c.auth.workspaceId === workspaceId && c.auth.userId === userId) return true;
    return false;
  }

  onlineUsers(workspaceId: string) {
    return [...new Set([...this.clients].filter((c) => c.auth.workspaceId === workspaceId).map((c) => c.auth.userId))];
  }

  /** Publish to every connected client in a workspace that passes the filter. */
  publish(workspaceId: string, event: RealtimeEvent, filter?: (auth: Auth) => boolean) {
    const data = JSON.stringify(event);
    for (const client of this.clients) {
      if (client.auth.workspaceId !== workspaceId) continue;
      if (filter && !filter(client.auth)) continue;
      if (client.socket.readyState === WebSocket.OPEN) client.socket.send(data);
    }
  }

  toUser(workspaceId: string, userId: string, event: RealtimeEvent) {
    this.publish(workspaceId, event, (auth) => auth.userId === userId);
  }

  /** Drop sockets for a user, e.g. after deactivation or logout. */
  disconnect(workspaceId: string, userId: string) {
    for (const client of this.clients) {
      if (client.auth.workspaceId === workspaceId && client.auth.userId === userId) client.socket.close(4001, 'signed out');
    }
  }

  close() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const client of this.clients) client.socket.terminate();
    this.wss?.close();
  }
}
