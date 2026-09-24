import express, { type Express } from 'express';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { canViewChannel } from './access.js';
import { Database } from './db.js';
import type { Config, Ctx } from './context.js';
import { RealtimeHub } from './realtime.js';
import { authRouter, authenticate, meRouter, requireAuth } from './routes/auth.js';
import { channelsRouter } from './routes/channels.js';
import { homeRouter } from './routes/home.js';
import { knowledgeRouter } from './routes/knowledge.js';
import { meetingsRouter } from './routes/meetings.js';
import { projectsRouter } from './routes/projects.js';
import { tasksRouter } from './routes/tasks.js';
import { workspaceRouter } from './routes/workspace.js';
import { HttpError, errorHandler } from './util.js';

export interface AppOptions extends Partial<Config> {
  dbPath?: string;
  staticDir?: string;
}

export interface SoftexApp {
  app: Express;
  server: Server;
  ctx: Ctx;
  close: () => void;
}

export function createApp(options: AppOptions = {}): SoftexApp {
  const config: Config = {
    uploadDir: options.uploadDir ?? join(process.cwd(), 'data', 'uploads'),
    meetingBaseUrl: options.meetingBaseUrl ?? 'https://meet.jit.si',
    maxUploadBytes: options.maxUploadBytes ?? 25 * 1024 * 1024,
    secureCookies: options.secureCookies ?? false,
  };
  const db = new Database(options.dbPath ?? join(process.cwd(), 'data', 'softex.db'));
  const hub = new RealtimeHub();
  const ctx: Ctx = { db, hub, config };

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    // Cookie sessions + mutating requests: reject cross-origin browser requests (CSRF defence in depth).
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin) {
      const host = req.headers['x-forwarded-host'] ?? req.headers.host;
      if (new URL(req.headers.origin).host !== host) return next(new HttpError(403, 'Cross-origin request rejected'));
    }
    next();
  });
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', (_req, res) => {
    db.get('SELECT 1');
    res.json({ ok: true, time: new Date().toISOString() });
  });
  app.use('/api', authRouter(ctx));
  const api = express.Router();
  api.use(requireAuth(ctx));
  api.use(meRouter(ctx));
  api.use(homeRouter(ctx));
  api.use(channelsRouter(ctx));
  api.use(projectsRouter(ctx));
  api.use(tasksRouter(ctx));
  api.use(knowledgeRouter(ctx));
  api.use(meetingsRouter(ctx));
  api.use(workspaceRouter(ctx));
  app.use('/api', api);
  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found')));

  const staticDir = options.staticDir;
  if (staticDir && existsSync(join(staticDir, 'index.html'))) {
    app.use(express.static(staticDir, { index: false, maxAge: '1h' }));
    app.get(/^\/(?!api|ws).*/, (_req, res) => {
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; connect-src 'self' ws: wss:; frame-ancestors 'none'",
      );
      res.sendFile(join(staticDir, 'index.html'));
    });
  }
  app.use(errorHandler);

  hub.onTyping = (auth, channelId) => {
    const channel = db.get('SELECT * FROM channels WHERE id = ?', channelId);
    if (!channel || !canViewChannel(db, auth, channel)) return;
    const user = db.get('SELECT name FROM users WHERE id = ?', auth.userId);
    hub.publish(auth.workspaceId, { type: 'typing', channelId, userId: auth.userId, name: user?.name }, (a) => a.userId !== auth.userId && canViewChannel(db, a, channel));
  };

  const server = createServer(app);
  hub.attach(server, (req) => authenticate(ctx, req));

  return {
    app,
    server,
    ctx,
    close: () => {
      hub.close();
      server.close();
      db.close();
    },
  };
}
