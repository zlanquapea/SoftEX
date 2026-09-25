import { accessSync, constants, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const dataDir = process.env.SOFTEX_DATA_DIR ?? join(root, 'data');

// Fail fast with a useful hint when the data directory (usually a mounted volume) is not writable.
try {
  mkdirSync(dataDir, { recursive: true });
  accessSync(dataDir, constants.W_OK);
} catch (error) {
  console.error(
    `SoftEX cannot write to its data directory ${dataDir} (${(error as Error).message}).\n` +
      'If it is a mounted volume owned by root (for example on Railway), give the app user write access, ' +
      'or on Railway set the service variable RAILWAY_RUN_UID=0.',
  );
  process.exit(1);
}

const registration = process.env.SOFTEX_REGISTRATION ?? 'open';
if (!['open', 'first', 'closed'].includes(registration)) throw new Error('SOFTEX_REGISTRATION must be open, first or closed');

const trustProxyEnv = process.env.SOFTEX_TRUST_PROXY;
const trustProxy =
  trustProxyEnv === undefined || trustProxyEnv === ''
    ? undefined
    : trustProxyEnv === 'true' || trustProxyEnv === 'false'
      ? trustProxyEnv === 'true'
      : /^\d+$/.test(trustProxyEnv)
        ? Number(trustProxyEnv)
        : trustProxyEnv;

const mode = process.env.SOFTEX_MODE ?? 'self_hosted';
if (!['self_hosted', 'saas'].includes(mode)) throw new Error('SOFTEX_MODE must be self_hosted or saas');

const num = (name: string) => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number`);
  return value;
};
const billing = Object.fromEntries(
  Object.entries({
    priceStandard: num('SOFTEX_PRICE_STANDARD'),
    priceBusiness: num('SOFTEX_PRICE_BUSINESS'),
    trialDays: num('SOFTEX_TRIAL_DAYS'),
    trialAiRequests: num('SOFTEX_TRIAL_AI_REQUESTS'),
    lrdPerUsd: num('SOFTEX_LRD_PER_USD'),
    // Newlines can be written as \n in a single-line environment variable.
    paymentInstructions: process.env.SOFTEX_PAYMENT_INSTRUCTIONS?.replace(/\\n/g, '\n'),
    supportEmail: process.env.SOFTEX_SUPPORT_EMAIL || undefined,
  }).filter(([, v]) => v !== undefined),
);

const { server } = createApp({
  dbPath: process.env.SOFTEX_DB ?? join(dataDir, 'softex.db'),
  databaseUrl: process.env.SOFTEX_DATABASE_URL || undefined,
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
  registration: registration as 'open' | 'first' | 'closed',
  mode: mode as 'self_hosted' | 'saas',
  operatorEmails: (process.env.SOFTEX_OPERATOR_EMAILS ?? '').split(','),
  billing,
  trustProxy,
  company: {
    name: process.env.SOFTEX_COMPANY_NAME || undefined,
    address: process.env.SOFTEX_COMPANY_ADDRESS || undefined,
    email: process.env.SOFTEX_LEGAL_EMAIL || process.env.SOFTEX_SUPPORT_EMAIL || undefined,
  },
});

if (process.env.NODE_ENV === 'production' && !process.env.SOFTEX_PUBLIC_URL) {
  console.warn('SOFTEX_PUBLIC_URL is not set: links in emails will point to localhost.');
}

const port = Number(process.env.PORT ?? 4000);
server.listen(port, () => {
  console.log(`SoftEX server listening on http://localhost:${port}`);
});
