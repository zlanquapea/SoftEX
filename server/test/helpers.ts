import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { createApp, type AppOptions, type SoftexApp } from '../src/app.js';
import { resetRateLimits } from '../src/routes/auth.js';
import { runJobsOnce } from '../src/jobs.js';

export interface SentMail {
  to: string;
  subject: string;
  text: string;
  attachments?: { filename: string; content: string }[];
}

export interface TestEnv {
  softex: SoftexApp;
  sent: SentMail[];
  agent: () => ReturnType<typeof request.agent>;
  cleanup: () => void;
}

export function setup(options: Partial<AppOptions> = {}): TestEnv {
  resetRateLimits();
  const dir = mkdtempSync(join(tmpdir(), 'softex-test-'));
  const sent: SentMail[] = [];
  const softex = createApp({
    dbPath: ':memory:',
    uploadDir: join(dir, 'uploads'),
    startJobs: false,
    publicUrl: 'https://softex.test',
    allowPrivateWebhooks: true,
    secretKey: 'test-secret-key',
    mail: { sendMail: async (m) => void sent.push(m as SentMail) },
    ...options,
  });
  return {
    softex,
    sent,
    agent: () => request.agent(softex.app),
    cleanup: () => {
      softex.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

let counter = 0;

/** Register a new workspace owner and return a signed-in agent. */
export async function registerOwner(env: TestEnv, name = 'Owner') {
  const agent = env.agent();
  const email = `owner${++counter}@example.com`;
  const res = await agent.post('/api/auth/register').send({ name, email, password: 'password123', workspaceName: `${name}'s Co`, acceptTerms: true });
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { agent, me: res.body, email };
}

/** Invite someone into the owner's workspace and return their signed-in agent. */
export async function invite(
  env: TestEnv,
  owner: ReturnType<typeof request.agent>,
  role: 'admin' | 'lead' | 'member' | 'guest' = 'member',
  extra: Record<string, unknown> = {},
  name = `Person ${counter + 1}`,
) {
  const email = `person${++counter}@example.com`;
  const inv = await owner.post('/api/admin/invitations').send({ email, role, ...extra });
  if (inv.status !== 201) throw new Error(`invite failed: ${inv.status} ${JSON.stringify(inv.body)}`);
  const agent = env.agent();
  const res = await agent.post(`/api/invitations/${inv.body.token}/accept`).send({ name, password: 'password123', acceptTerms: true });
  if (res.status !== 200) throw new Error(`accept failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { agent, me: res.body, id: res.body.user.id as string, email };
}

/** Deliver queued emails and webhooks, as the background scheduler would. */
export const flushJobs = (env: TestEnv) => runJobsOnce(env.softex.ctx);
