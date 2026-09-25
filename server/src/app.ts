import express, { type Express } from 'express';
import { rateLimit } from 'express-rate-limit';
import compression from 'compression';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { canViewChannel, canViewMeeting, canViewTask } from './access.js';
import { openDatabase } from './db.js';
import { LocalFileStore, S3FileStore, type FileStore, type S3Settings } from './storage.js';
import type { AiClient, Config, Ctx, MailTransport } from './context.js';
import type { BillingConfig } from './plans.js';
import { createClaudeClient } from './ai.js';
import { startBackgroundJobs } from './jobs.js';
import { aiRouter } from './routes/ai.js';
import { integrationsRouter } from './routes/integrations.js';
import { ssoAdminRouter, ssoPublicRouter } from './routes/sso.js';
import { productivityRouter } from './routes/productivity.js';
import { scimAdminRouter, scimRouter } from './routes/scim.js';
import { billingRouter, operatorRouter, publicBillingRouter } from './routes/billing.js';
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

export interface AppOptions extends Partial<Omit<Config, 'billing'>> {
  billing?: Partial<BillingConfig>;
  /** Express "trust proxy" setting: a hop count, true/false, or an address list. */
  trustProxy?: boolean | number | string;
  dbPath?: string;
  /** postgres://… to use PostgreSQL instead of the SQLite file at dbPath. */
  databaseUrl?: string;
  /** S3-compatible storage for uploaded files (otherwise they go to uploadDir). */
  s3?: S3Settings;
  files?: FileStore;
  staticDir?: string;
  /** Requests per minute per client address across the API (default 1200). */
  rateLimitPerMinute?: number;
  /** Start the in-process email/webhook/digest scheduler (default true; tests drive jobs manually). */
  startJobs?: boolean;
  anthropicApiKey?: string;
  mail?: MailTransport;
  ai?: AiClient;
}

export interface SoftexApp {
  app: Express;
  server: Server;
  ctx: Ctx;
  /** Resolves when the database is migrated and realtime is connected to other servers. */
  ready: Promise<void>;
  close: () => Promise<void>;
}

export function createApp(options: AppOptions = {}): SoftexApp {
  const config: Config = {
    uploadDir: options.uploadDir ?? join(process.cwd(), 'data', 'uploads'),
    meetingBaseUrl: options.meetingBaseUrl ?? 'https://meet.jit.si',
    maxUploadBytes: options.maxUploadBytes ?? 25 * 1024 * 1024,
    secureCookies: options.secureCookies ?? false,
    publicUrl: (options.publicUrl ?? 'http://localhost:4000').replace(/\/$/, ''),
    smtpUrl: options.smtpUrl,
    mailFrom: options.mailFrom ?? 'SoftEX <no-reply@softex.local>',
    secretKey: options.secretKey,
    clamav: options.clamav,
    allowPrivateWebhooks: options.allowPrivateWebhooks ?? false,
    aiModel: options.aiModel ?? 'claude-opus-5',
    registration: options.registration ?? 'open',
    mode: options.mode ?? 'self_hosted',
    operatorEmails: (options.operatorEmails ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean),
    company: options.company ?? {},
    billing: {
      priceStandard: 1.5,
      priceBusiness: 3,
      trialDays: 30,
      trialAiRequests: 100,
      annualFactor: 10 / 12,
      paymentInstructions: '',
      ...options.billing,
    },
  };
  const db = openDatabase(options.databaseUrl ?? options.dbPath ?? join(process.cwd(), 'data', 'softex.db'));
  const hub = new RealtimeHub();
  const files: FileStore = options.files ?? (options.s3?.bucket ? new S3FileStore(options.s3) : new LocalFileStore(config.uploadDir));
  const ctx: Ctx = {
    db,
    files,
    hub,
    config,
    mail: options.mail,
    ai: options.ai ?? (options.anthropicApiKey ? createClaudeClient(options.anthropicApiKey, config.aiModel) : undefined),
  };
  const stopJobs = options.startJobs === false ? () => {} : startBackgroundJobs(ctx);

  const app = express();
  app.disable('x-powered-by');
  // Behind a hosting proxy (Railway, Render, Fly, a load balancer) set trustProxy so rate limits see real client addresses.
  app.set('trust proxy', options.trustProxy ?? 'loopback');
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
  // Abuse protection for the whole API: generous enough for normal use of the app
  // (which polls and reacts to live events), strict enough to blunt floods and scraping.
  // Smaller responses for low-bandwidth connections (§2 goal 6).
  app.use(compression());
  app.use(
    ['/api', '/scim'],
    rateLimit({
      windowMs: 60_000,
      limit: options.rateLimitPerMinute ?? 1200,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      message: { error: 'Too many requests. Please slow down and try again shortly.' },
    }),
  );
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', async (_req, res) => {
    await db.get('SELECT 1');
    res.json({ ok: true, time: new Date().toISOString() });
  });
  app.use('/api', authRouter(ctx));
  app.use('/api', ssoPublicRouter(ctx));
  app.use('/api', publicBillingRouter(ctx));
  app.use('/scim/v2', express.json({ type: ['application/json', 'application/scim+json'], limit: '1mb' }), scimRouter(ctx));
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
  api.use(ssoAdminRouter(ctx));
  api.use(integrationsRouter(ctx));
  api.use(aiRouter(ctx));
  api.use(productivityRouter(ctx));
  api.use(scimAdminRouter(ctx));
  api.use(billingRouter(ctx));
  api.use(operatorRouter(ctx));
  app.use('/api', api);
  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found')));

  const staticDir = options.staticDir;
  if (staticDir && existsSync(join(staticDir, 'index.html'))) {
    app.use(
      express.static(staticDir, {
        index: false,
        maxAge: '1h',
        setHeaders: (res, path) => {
          // Hashed bundles never change; the service worker must always be revalidated so fixes reach installed apps.
          if (/[\\/]assets[\\/]/.test(path)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          else if (/[\\/]sw\.js$/.test(path)) res.setHeader('Cache-Control', 'no-cache');
        },
      }),
    );
    app.get(/^\/(?!api|ws|scim).*/, (_req, res) => {
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; connect-src 'self' ws: wss:; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'",
      );
      res.sendFile(join(staticDir, 'index.html'));
    });
  }
  app.use(errorHandler);

  hub.onTyping = async (auth, channelId) => {
    const channel = await db.get('SELECT * FROM channels WHERE id = ?', channelId);
    if (!channel || !await canViewChannel(db, auth, channel)) return;
    const user = await db.get('SELECT name FROM users WHERE id = ?', auth.userId);
    await hub.publish(auth.workspaceId, { type: 'typing', channelId, userId: auth.userId, name: user?.name }, { kind: 'channel', channelId, exceptUserId: auth.userId });
  };

  // Realtime audiences are checked against the database for each connected client.
  hub.resolveAudience = async (_workspaceId, audience) => {
    switch (audience.kind) {
      case 'workspace':
        return () => true;
      case 'user':
        return (a) => a.userId === audience.userId;
      case 'channel': {
        const channel = await db.get('SELECT * FROM channels WHERE id = ?', audience.channelId);
        return (a) => !!channel && a.userId !== audience.exceptUserId && canViewChannel(db, a, channel);
      }
      case 'task': {
        const task = await db.get('SELECT * FROM tasks WHERE id = ?', audience.taskId);
        return (a) => !!task && canViewTask(db, a, task);
      }
      case 'meeting': {
        const meeting = await db.get('SELECT * FROM meetings WHERE id = ?', audience.meetingId);
        return (a) => !!meeting && canViewMeeting(db, a, meeting);
      }
    }
  };
  // Events published inside a transaction go out once it commits.
  hub.defer = (fn) => db.afterCommit(fn);
  // With PostgreSQL, servers sharing the database pass events, sign-outs and presence to each other.
  const peers = db.peerLink();
  const ready = (async () => {
    await db.ready;
    if (peers) await hub.connectPeers(peers);
  })();
  ready.catch(() => {});

  const server = createServer(app);
  hub.attach(server, (req) => authenticate(ctx, req));

  return {
    app,
    server,
    ctx,
    ready,
    close: async () => {
      stopJobs();
      await ready.catch(() => {});
      await hub.close();
      server.close();
      await db.close();
    },
  };
}
