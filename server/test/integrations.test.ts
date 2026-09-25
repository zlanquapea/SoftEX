import { createHmac, generateKeyPairSync, sign } from 'node:crypto';
import { createServer as createHttpServer, type IncomingMessage, type Server } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { deflateRawSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { queueDigests } from '../src/mailer.js';
import { flushJobs, invite, registerOwner, setup, type TestEnv } from './helpers.js';

let env: TestEnv;
const servers: Server[] = [];
afterEach(async () => {
  await env?.cleanup();
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

const listen = async (server: Server) => {
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
  });

describe('email delivery', () => {
  it('emails invitations with a working link, and resending replaces the link', async () => {
    env = setup();
    const owner = await registerOwner(env, 'Alex');
    const created = (await owner.agent.post('/api/admin/invitations').send({ email: 'new@example.com', role: 'member' })).body;
    await flushJobs(env);
    const mail = env.sent.find((m) => m.to === 'new@example.com')!;
    expect(mail.subject).toContain("invited you to Alex's Co");
    expect(mail.text).toContain(`https://softex.test/invite/${created.token}`);

    const resent = (await owner.agent.post(`/api/admin/invitations/${created.id}/resend`)).body;
    expect((await env.agent().get(`/api/invitations/${created.token}`)).status).toBe(404);
    expect((await env.agent().get(`/api/invitations/${resent.token}`)).status).toBe(200);
    await flushJobs(env);
    expect(env.sent.filter((m) => m.to === 'new@example.com')).toHaveLength(2);
  });

  it('resets a password through an emailed one-time link', async () => {
    env = setup();
    const { agent, email } = await registerOwner(env);
    expect((await env.agent().post('/api/auth/forgot').send({ email: 'nobody@example.com' })).status).toBe(200);
    await env.agent().post('/api/auth/forgot').send({ email });
    await flushJobs(env);
    expect(env.sent).toHaveLength(1);
    const token = env.sent[0].text.match(/reset-password\/([\w-]+)/)![1];
    expect((await env.agent().post('/api/auth/reset').send({ token, password: 'brand-new-pass' })).status).toBe(200);
    expect((await env.agent().post('/api/auth/reset').send({ token, password: 'another-pass1' })).status).toBe(400);
    expect((await agent.get('/api/me')).status).toBe(401); // existing sessions revoked
    expect((await env.agent().post('/api/auth/login').send({ email, password: 'brand-new-pass' })).status).toBe(200);
  });

  it('sends calendar invitations for meetings', async () => {
    env = setup();
    const owner = await registerOwner(env);
    const member = await invite(env, owner.agent);
    await flushJobs(env);
    env.sent.length = 0;
    await owner.agent.post('/api/meetings').send({ title: 'Planning', startsAt: new Date(Date.now() + 86_400_000).toISOString(), participantIds: [member.id] });
    await flushJobs(env);
    expect(env.sent).toHaveLength(1);
    expect(env.sent[0].to).toBe(member.email);
    expect(env.sent[0].attachments![0].content).toContain('METHOD:REQUEST');
  });

  it('emails urgent messages to people who are offline, respecting their preference', async () => {
    env = setup();
    const owner = await registerOwner(env);
    const member = await invite(env, owner.agent);
    const dm = (await owner.agent.post('/api/dms').send({ userIds: [member.id] })).body;
    await flushJobs(env);
    env.sent.length = 0;
    await owner.agent.post(`/api/channels/${dm.id}/messages`).send({ body: 'Server is down', urgent: true });
    await owner.agent.post(`/api/channels/${dm.id}/messages`).send({ body: 'not urgent' });
    await flushJobs(env);
    expect(env.sent.map((m) => m.subject)).toEqual([expect.stringContaining('Urgent')]);
    await member.agent.patch('/api/me').send({ email_urgent: false });
    await owner.agent.post(`/api/channels/${dm.id}/messages`).send({ body: 'Again', urgent: true });
    await flushJobs(env);
    expect(env.sent).toHaveLength(1);
  });

  it('builds a morning digest of unread notifications', async () => {
    env = setup();
    const owner = await registerOwner(env);
    const member = await invite(env, owner.agent);
    await member.agent.patch('/api/me').send({ timezone: 'UTC' });
    await owner.agent.post('/api/tasks').send({ title: 'Review budget', ownerId: member.id });
    const eightUtc = new Date();
    eightUtc.setUTCHours(8, 5, 0, 0);
    expect(await queueDigests(env.softex.ctx, eightUtc)).toBeGreaterThanOrEqual(1);
    expect(await queueDigests(env.softex.ctx, eightUtc)).toBe(0); // at most once a day
    await flushJobs(env);
    const digest = env.sent.find((m) => m.to === member.email && m.subject.includes('digest'))!;
    expect(digest.text).toContain('Review budget');
  });

  it('retries failed deliveries with backoff', async () => {
    let fail = true;
    env = setup({ mail: { sendMail: async () => { if (fail) throw new Error('SMTP down'); } } });
    const owner = await registerOwner(env);
    await owner.agent.post('/api/admin/invitations').send({ email: 'x@example.com', role: 'member' });
    await flushJobs(env);
    const row = (await env.softex.ctx.db.get(`SELECT * FROM outbound_emails WHERE to_email = 'x@example.com'`))!;
    expect(row).toMatchObject({ status: 'queued', attempts: 1, last_error: 'SMTP down' });
    fail = false;
    await env.softex.ctx.db.run(`UPDATE outbound_emails SET next_attempt_at = ?`, new Date(0).toISOString());
    await flushJobs(env);
    expect((await env.softex.ctx.db.get(`SELECT status FROM outbound_emails WHERE id = ?`, row.id))!.status).toBe('sent');
  });
});

describe('public API tokens', () => {
  it('acts as the user within the token scope', async () => {
    env = setup();
    const owner = await registerOwner(env);
    const readTok = (await owner.agent.post('/api/integrations/tokens').send({ name: 'reporting', scope: 'read' })).body.token;
    const writeTok = (await owner.agent.post('/api/integrations/tokens').send({ name: 'bot', scope: 'write' })).body.token;
    const api = env.agent();
    expect((await api.get('/api/projects').set('Authorization', `Bearer ${readTok}`)).status).toBe(200);
    expect((await api.post('/api/tasks').set('Authorization', `Bearer ${readTok}`).send({ title: 'x' })).status).toBe(403);
    expect((await api.post('/api/tasks').set('Authorization', `Bearer ${writeTok}`).send({ title: 'From the API' })).status).toBe(201);
    expect((await api.get('/api/integrations/tokens').set('Authorization', `Bearer ${writeTok}`)).status).toBe(403);
    const tokens = (await owner.agent.get('/api/integrations/tokens')).body;
    await owner.agent.delete(`/api/integrations/tokens/${tokens.find((t: { name: string }) => t.name === 'bot').id}`);
    expect((await api.get('/api/me').set('Authorization', `Bearer ${writeTok}`)).status).toBe(401);
  });
});

describe('webhooks', () => {
  it('delivers signed events for public content only', async () => {
    env = setup();
    const received: { headers: IncomingMessage['headers']; body: string }[] = [];
    const url = await listen(
      createHttpServer(async (req, res) => {
        received.push({ headers: req.headers, body: await readBody(req) });
        res.end('ok');
      }),
    );
    const owner = await registerOwner(env);
    const hook = (await owner.agent.post('/api/integrations/webhooks').send({ url, events: ['message.created', 'task.created'] })).body;
    expect(hook.secret).toMatch(/^whsec_/);
    const general = (await owner.agent.get('/api/channels')).body.find((c: { name: string }) => c.name === 'general');
    const secret = (await owner.agent.post('/api/channels').send({ name: 'secret', kind: 'private' })).body;
    await owner.agent.post(`/api/channels/${general.id}/messages`).send({ body: 'hello world' });
    await owner.agent.post(`/api/channels/${secret.id}/messages`).send({ body: 'classified' });
    await owner.agent.post('/api/tasks').send({ title: 'personal, no project' });
    await flushJobs(env);
    expect(received).toHaveLength(1);
    const { headers, body } = received[0];
    expect(JSON.parse(body)).toMatchObject({ type: 'message.created', data: { body: 'hello world' } });
    const expected = `sha256=${createHmac('sha256', hook.secret).update(`${headers['x-kuu-timestamp']}.${body}`).digest('hex')}`;
    expect(headers['x-kuu-signature']).toBe(expected);
    expect(headers['x-kuu-event']).toBe('message.created');
    // Integrations built before the rename still get the old header names.
    expect(headers['x-softex-signature']).toBe(expected);
    expect(headers['x-softex-timestamp']).toBe(headers['x-kuu-timestamp']);
    const deliveries = (await owner.agent.get(`/api/integrations/webhooks/${hook.id}/deliveries`)).body;
    expect(deliveries[0].status).toBe('delivered');
  });

  it('refuses private network targets in production mode and is admin-only', async () => {
    env = setup({ allowPrivateWebhooks: false });
    const owner = await registerOwner(env);
    const member = await invite(env, owner.agent);
    for (const url of ['http://example.com/hook', 'https://127.0.0.1/hook', 'https://10.1.2.3/x', 'https://[::1]/x']) {
      expect((await owner.agent.post('/api/integrations/webhooks').send({ url, events: ['*'] })).status).toBe(400);
    }
    expect((await member.agent.get('/api/integrations/webhooks')).status).toBe(403);
  });
});

/** Build a minimal .docx (zip with word/document.xml) for extraction tests. */
function makeDocx(text: string) {
  const name = Buffer.from('word/document.xml');
  const content = Buffer.from(`<?xml version="1.0"?><w:document><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`);
  const data = deflateRawSync(content);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(0, 42);
  const centralStart = local.length + name.length + data.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(centralStart, 16);
  return Buffer.concat([local, name, data, central, name, end]);
}

describe('files: content search and malware scanning', () => {
  it('finds uploaded documents by their contents', async () => {
    env = setup();
    const owner = await registerOwner(env);
    await owner.agent.post('/api/files').attach('file', makeDocx('Quarterly revenue forecast for Nairobi office'), 'forecast.docx');
    await owner.agent.post('/api/files').attach('file', Buffer.from('Incident runbook: rotate the database credentials'), 'runbook.md');
    const docx = (await owner.agent.get('/api/search').query({ q: 'Nairobi', type: 'files' })).body.files;
    expect(docx[0]).toMatchObject({ name: 'forecast.docx' });
    expect(docx[0].snippet).toContain('Nairobi');
    expect((await owner.agent.get('/api/search').query({ q: 'credentials', type: 'files' })).body.files[0].name).toBe('runbook.md');
  });

  it('streams uploads to ClamAV and fails closed when it is unavailable', async () => {
    const clamd = createTcpServer((socket) => {
      const chunks: Buffer[] = [];
      socket.on('data', (d: Buffer) => chunks.push(d));
      socket.on('end', () => socket.end(Buffer.concat(chunks).includes('virus-signature') ? 'stream: Test.Virus FOUND\0' : 'stream: OK\0'));
    });
    servers.push(clamd as unknown as Server);
    await new Promise<void>((r) => clamd.listen(0, '127.0.0.1', r));
    env = setup({ clamav: { host: '127.0.0.1', port: (clamd.address() as AddressInfo).port } });
    const owner = await registerOwner(env);
    expect((await owner.agent.post('/api/files').attach('file', Buffer.from('clean text'), 'ok.txt')).status).toBe(201);
    const bad = await owner.agent.post('/api/files').attach('file', Buffer.from('has virus-signature inside'), 'bad.txt');
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain('Test.Virus');
    await env.cleanup();

    env = setup({ clamav: { host: '127.0.0.1', port: 1 } });
    const owner2 = await registerOwner(env);
    expect((await owner2.agent.post('/api/files').attach('file', Buffer.from('anything'), 'a.txt')).status).toBe(400);
  });
});

describe('single sign-on (OIDC)', () => {
  async function fakeIdp(opts: { email: string; audience?: string }) {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
    let issuer = '';
    const nonces = new Map<string, string>();
    const server = createHttpServer(async (req, res) => {
      const url = new URL(req.url!, issuer);
      res.setHeader('Content-Type', 'application/json');
      if (url.pathname === '/.well-known/openid-configuration') {
        return res.end(JSON.stringify({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks` }));
      }
      if (url.pathname === '/jwks') return res.end(JSON.stringify({ keys: [jwk] }));
      if (url.pathname === '/token') {
        const form = new URLSearchParams(await readBody(req));
        const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
        const head = b64({ alg: 'RS256', kid: 'k1', typ: 'JWT' });
        const now = Math.floor(Date.now() / 1000);
        const body = b64({ iss: issuer, aud: opts.audience ?? form.get('client_id'), sub: '123', email: opts.email, email_verified: true, name: 'Sam Sso', nonce: nonces.get(form.get('code')!), iat: now, exp: now + 300 });
        const sig = sign('sha256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url');
        return res.end(JSON.stringify({ id_token: `${head}.${body}.${sig}`, token_type: 'Bearer' }));
      }
      res.statusCode = 404;
      res.end('{}');
    });
    issuer = await listen(server);
    return { issuer, rememberNonce: (code: string, nonce: string) => nonces.set(code, nonce) };
  }

  async function signIn(email: string, idp: Awaited<ReturnType<typeof fakeIdp>>) {
    const agent = env.agent();
    const start = await agent.get('/api/auth/sso/start').query({ email });
    expect(start.status).toBe(302);
    const authorize = new URL(start.headers.location);
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    idp.rememberNonce('the-code', authorize.searchParams.get('nonce')!);
    const cb = await agent.get('/api/auth/sso/callback').query({ code: 'the-code', state: authorize.searchParams.get('state') });
    return { agent, cb };
  }

  it('signs people in with their identity provider and provisions accounts', async () => {
    env = setup();
    const idp = await fakeIdp({ email: 'sam@acme.example' });
    const owner = await registerOwner(env);
    const cfg = await owner.agent.put('/api/admin/sso').send({ enabled: true, issuer: idp.issuer, clientId: 'softex', clientSecret: 's3cret', domain: 'acme.example' });
    expect(cfg.status).toBe(200);
    expect(JSON.stringify(await env.softex.ctx.db.get('SELECT sso_client_secret FROM workspaces'))).not.toContain('s3cret');
    expect((await env.agent().get('/api/auth/sso/discover').query({ email: 'sam@acme.example' })).body.sso).toBe(true);

    const { agent, cb } = await signIn('sam@acme.example', idp);
    expect(cb.headers.location).toBe('/');
    const me = (await agent.get('/api/me')).body;
    expect(me.user).toMatchObject({ email: 'sam@acme.example', name: 'Sam Sso' });
    expect(me.role).toBe('member');
  });

  it('rejects tokens for another audience, and can require SSO for password users', async () => {
    env = setup();
    const idp = await fakeIdp({ email: 'sam@acme.example', audience: 'someone-else' });
    const owner = await registerOwner(env);
    const member = await invite(env, owner.agent);
    await owner.agent.put('/api/admin/sso').send({ enabled: true, issuer: idp.issuer, clientId: 'softex', clientSecret: 'x', domain: 'acme.example', required: true });
    const { cb } = await signIn('sam@acme.example', idp);
    expect(cb.headers.location).toContain('sso_error=');
    const login = await env.agent().post('/api/auth/login').send({ email: member.email, password: 'password123' });
    expect(login.status).toBe(403);
    expect(login.body.details.code).toBe('sso_required');
    // Owners keep a password fallback so a broken IdP cannot lock the workspace out.
    expect((await env.agent().post('/api/auth/login').send({ email: owner.email, password: 'password123' })).status).toBe(200);
  });
});

describe('governed AI assistance', () => {
  function fakeAi() {
    const prompts: string[] = [];
    return {
      prompts,
      client: {
        complete: async ({ prompt, jsonSchema }: { prompt: string; jsonSchema?: object }) => {
          prompts.push(prompt);
          return jsonSchema
            ? { text: JSON.stringify({ tasks: [{ title: 'Send the contract', owner_name: 'Maya', due_date: '2026-10-01', reason: 'Maya agreed' }] }), refused: false }
            : { text: 'Summary: the team agreed to ship.', refused: false };
        },
      },
    };
  }

  it('is off until an admin enables it, and only reads what the requester can see', async () => {
    const ai = fakeAi();
    env = setup({ ai: ai.client });
    const owner = await registerOwner(env);
    const maya = await invite(env, owner.agent, 'member', {}, 'Maya');
    const general = (await owner.agent.get('/api/channels')).body.find((c: { name: string }) => c.name === 'general');
    const root = (await owner.agent.post(`/api/channels/${general.id}/messages`).send({ body: 'Can someone send the contract?' })).body;
    await maya.agent.post(`/api/channels/${general.id}/messages`).send({ body: 'I will send it by Oct 1', parentId: root.id });

    expect((await owner.agent.post(`/api/ai/threads/${root.id}/summary`)).status).toBe(403);
    await owner.agent.patch('/api/admin/workspace').send({ aiEnabled: true });
    const summary = await owner.agent.post(`/api/ai/threads/${root.id}/summary`);
    expect(summary.status).toBe(200);
    expect(summary.body.summary).toContain('agreed');
    expect(ai.prompts[0]).toContain('I will send it by Oct 1');

    const suggestions = (await owner.agent.post(`/api/ai/threads/${root.id}/suggest-tasks`)).body.suggestions;
    expect(suggestions[0]).toMatchObject({ title: 'Send the contract', owner_id: maya.id, due_date: '2026-10-01' });

    const secret = (await owner.agent.post('/api/channels').send({ name: 'secret', kind: 'private' })).body;
    const s1 = (await owner.agent.post(`/api/channels/${secret.id}/messages`).send({ body: 'private one' })).body;
    await owner.agent.post(`/api/channels/${secret.id}/messages`).send({ body: 'private two', parentId: s1.id });
    expect((await maya.agent.post(`/api/ai/threads/${s1.id}/summary`)).status).toBe(404);

    await owner.agent.patch('/api/ai/exclusions').send({ channelId: general.id, excluded: true });
    expect((await owner.agent.post(`/api/ai/threads/${root.id}/summary`)).status).toBe(403);
    const audit = (await owner.agent.get('/api/admin/audit').query({ action: 'ai' })).body;
    expect(audit.map((a: { action: string }) => a.action)).toEqual(expect.arrayContaining(['ai.thread_summary', 'ai.task_suggestions', 'ai.exclusion_changed']));
    expect(JSON.stringify(audit)).not.toContain('contract');
  });
});

describe('abuse protection', () => {
  it('rate limits the API per client', async () => {
    env = setup({ rateLimitPerMinute: 5 });
    const { agent } = await registerOwner(env); // 1 request
    for (let i = 0; i < 4; i++) expect((await agent.get('/api/me')).status).toBe(200);
    const limited = await agent.get('/api/me');
    expect(limited.status).toBe(429);
    expect(limited.body.error).toContain('Too many requests');
  });
});
