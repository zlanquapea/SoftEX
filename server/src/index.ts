import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const dataDir = process.env.SOFTEX_DATA_DIR ?? join(root, 'data');

const { server } = createApp({
  dbPath: process.env.SOFTEX_DB ?? join(dataDir, 'softex.db'),
  uploadDir: join(dataDir, 'uploads'),
  meetingBaseUrl: process.env.SOFTEX_MEETING_BASE_URL,
  maxUploadBytes: process.env.SOFTEX_MAX_UPLOAD_MB ? Number(process.env.SOFTEX_MAX_UPLOAD_MB) * 1024 * 1024 : undefined,
  secureCookies: process.env.SOFTEX_SECURE_COOKIES === 'true',
  staticDir: process.env.SOFTEX_STATIC_DIR ?? resolve(root, '..', 'client', 'dist'),
  publicUrl: process.env.SOFTEX_PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 4000}`,
  smtpUrl: process.env.SOFTEX_SMTP_URL || undefined,
  mailFrom: process.env.SOFTEX_MAIL_FROM || undefined,
  secretKey: process.env.SOFTEX_SECRET_KEY || undefined,
  clamav: process.env.SOFTEX_CLAMAV_HOST
    ? { host: process.env.SOFTEX_CLAMAV_HOST, port: Number(process.env.SOFTEX_CLAMAV_PORT ?? 3310) }
    : undefined,
  allowPrivateWebhooks: process.env.SOFTEX_ALLOW_PRIVATE_WEBHOOKS === 'true',
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || undefined,
  aiModel: process.env.SOFTEX_AI_MODEL || undefined,
});

if (process.env.NODE_ENV === 'production' && !process.env.SOFTEX_PUBLIC_URL) {
  console.warn('SOFTEX_PUBLIC_URL is not set: links in emails will point to localhost.');
}

const port = Number(process.env.PORT ?? 4000);
server.listen(port, () => {
  console.log(`SoftEX server listening on http://localhost:${port}`);
});
