import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseRange } from '../src/routes/knowledge.js';
import { matchVideoUrl } from '../src/routes/embeds.js';
import { registerOwner, setup, type TestEnv } from './helpers.js';

let env: TestEnv | undefined;
afterEach(async () => {
  vi.unstubAllGlobals();
  await env?.cleanup();
  env = undefined;
});

const binary = (res: any, cb: (e: Error | null, b: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

describe('video and audio files', () => {
  it('serves videos inline with byte ranges so they play and seek', async () => {
    const e = (env = setup());
    const owner = await registerOwner(e);
    const content = Buffer.from('0123456789abcdefghij'); // stands in for a video
    const file = (await owner.agent.post('/api/files').attach('file', content, 'clip.mp4')).body;
    expect(file.mime).toBe('video/mp4');

    const full = await owner.agent.get(`/api/files/${file.id}/download?inline=1`).buffer(true).parse(binary);
    expect(full.status).toBe(200);
    expect(full.headers['content-type']).toBe('video/mp4');
    expect(full.headers['accept-ranges']).toBe('bytes');

    const part = await owner.agent.get(`/api/files/${file.id}/download?inline=1`).set('Range', 'bytes=5-9').buffer(true).parse(binary);
    expect(part.status).toBe(206);
    expect(part.headers['content-range']).toBe('bytes 5-9/20');
    expect(part.body.toString()).toBe('56789');

    const tail = await owner.agent.get(`/api/files/${file.id}/download?inline=1`).set('Range', 'bytes=-3').buffer(true).parse(binary);
    expect(tail.body.toString()).toBe('hij');

    const bad = await owner.agent.get(`/api/files/${file.id}/download?inline=1`).set('Range', 'bytes=50-60');
    expect(bad.status).toBe(416);
    expect(bad.headers['content-range']).toBe('bytes */20');
  });

  it('parses ranges strictly', () => {
    expect(parseRange(undefined, 10)).toBeNull();
    expect(parseRange('bytes=0-', 10)).toEqual({ start: 0, end: 9 });
    expect(parseRange('bytes=2-100', 10)).toEqual({ start: 2, end: 9 });
    expect(parseRange('bytes=0-1,4-5', 10)).toBeNull(); // multiple ranges: send the whole file
    expect(parseRange('bytes=5-2', 10)).toBe('invalid');
    expect(parseRange('bytes=-0', 10)).toBe('invalid');
  });
});

describe('video link previews', () => {
  it('recognises video links and builds safe player addresses', () => {
    expect(matchVideoUrl('https://youtu.be/dQw4w9WgXcQ?t=4')).toMatchObject({ provider: 'youtube', id: 'dQw4w9WgXcQ', embedUrl: expect.stringMatching(/^https:\/\/www\.youtube-nocookie\.com\/embed\/dQw4w9WgXcQ/) });
    expect(matchVideoUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=x')?.id).toBe('dQw4w9WgXcQ');
    expect(matchVideoUrl('https://www.youtube.com/shorts/dQw4w9WgXcQ')?.id).toBe('dQw4w9WgXcQ');
    expect(matchVideoUrl('https://vimeo.com/76979871')?.embedUrl).toBe('https://player.vimeo.com/video/76979871?autoplay=1');
    expect(matchVideoUrl('https://www.tiktok.com/@liberia/video/7212345678901234567')?.provider).toBe('tiktok');
    expect(matchVideoUrl('https://www.facebook.com/somepage/videos/1234567890/')?.provider).toBe('facebook');
    expect(matchVideoUrl('https://example.com/watch?v=dQw4w9WgXcQ')).toBeNull();
    expect(matchVideoUrl('javascript:alert(1)')).toBeNull();
  });

  it('adds the title and thumbnail from the provider, keeping only safe image hosts', async () => {
    const e = (env = setup());
    const owner = await registerOwner(e);
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify({ title: 'Team update', thumbnail_url: url.includes('vimeo') ? 'https://evil.example/x.jpg' : 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    });
    const yt = (await owner.agent.get('/api/embeds/video').query({ url: 'https://youtu.be/dQw4w9WgXcQ' })).body;
    expect(yt).toMatchObject({ provider: 'youtube', title: 'Team update', thumbnail: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg' });
    // Only the provider's own oEmbed address is contacted.
    expect(calls[0]).toMatch(/^https:\/\/www\.youtube\.com\/oembed\?/);

    const vimeo = (await owner.agent.get('/api/embeds/video').query({ url: 'https://vimeo.com/76979871' })).body;
    expect(vimeo.thumbnail).toBeNull(); // not from Vimeo's image host, so dropped
    expect((await owner.agent.get('/api/embeds/video').query({ url: 'http://169.254.169.254/latest' })).status).toBe(400);
    expect((await e.agent().get('/api/embeds/video').query({ url: 'https://youtu.be/dQw4w9WgXcQ' })).status).toBe(401);
  });
});
