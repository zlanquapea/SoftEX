import { afterEach, describe, expect, it } from 'vitest';
import { setup, type TestEnv } from './helpers.js';

let env: TestEnv;
afterEach(() => env?.cleanup());

const signIn = (origin: string, host = 'localhost:4000', forwardedHost?: string) => {
  const req = env.agent().post('/api/auth/login').set('Origin', origin).set('Host', host);
  if (forwardedHost) req.set('X-Forwarded-Host', forwardedHost);
  return req.send({ email: 'nobody@example.com', password: 'wrong-password' });
};
// A refused origin answers 403 before the login is even checked; an allowed one reaches it (401).
const allowed = async (res: Promise<{ status: number }> | { status: number }) => (await res).status !== 403;

describe('cross-origin protection', () => {
  it('accepts the page’s own address and the configured public address, and refuses others', async () => {
    env = setup({ publicUrl: 'https://kuu.example.com' });
    expect(await allowed(signIn('http://localhost:4000'))).toBe(true);
    expect(await allowed(signIn('https://kuu.example.com'))).toBe(true);
    // Behind a proxy that says where the request was really addressed.
    expect(await allowed(signIn('https://app.example.org', 'localhost:4000', 'app.example.org'))).toBe(true);
    expect(await allowed(signIn('https://evil.example'))).toBe(false);
    const refused = await signIn('https://evil.example');
    expect(refused.body.error).toBe('Cross-origin request rejected');
  });

  it('trusts dev tunnels such as GitHub Codespaces when configured', async () => {
    // Codespaces hands the server Host: localhost while the browser is on *.app.github.dev.
    env = setup({ allowedOrigins: ['https://fuzzy-space-7x9-*.app.github.dev'] });
    expect(await allowed(signIn('https://fuzzy-space-7x9-5173.app.github.dev', 'localhost:5173'))).toBe(true);
    expect(await allowed(signIn('https://fuzzy-space-7x9-4000.app.github.dev', 'localhost:4000'))).toBe(true);
    // Someone else's codespace, or a look-alike address, is still refused.
    expect(await allowed(signIn('https://other-space-5173.app.github.dev', 'localhost:5173'))).toBe(false);
    expect(await allowed(signIn('https://fuzzy-space-7x9-5173.app.github.dev.evil.example', 'localhost:5173'))).toBe(false);
  });
});
