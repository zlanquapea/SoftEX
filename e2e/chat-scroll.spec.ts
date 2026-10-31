import { deflateSync } from 'node:zlib';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { signIn, trackErrors } from './helpers';

/** A tall plain PNG, so a photo in a message adds real height once it loads. */
function tallPng(width = 400, height = 700) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0xc8)]);
  const pixels = deflateSync(Buffer.concat(Array.from({ length: height }, () => row)));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', pixels), chunk('IEND', Buffer.alloc(0))]);
}

/** Post messages as whoever is signed in; `photo` attaches the tall image. */
async function post(page: Page, channelId: string, messages: { body: string; parentId?: string; photo?: boolean }[]) {
  const png = tallPng().toString('base64');
  return page.evaluate(
    async ({ channelId, messages, png }) => {
      const ids: string[] = [];
      for (const m of messages) {
        let fileIds: string[] = [];
        if (m.photo) {
          const form = new FormData();
          form.append('file', new Blob([Uint8Array.from(atob(png), (c) => c.charCodeAt(0))], { type: 'image/png' }), 'photo.png');
          fileIds = [(await (await fetch('/api/files', { method: 'POST', body: form })).json()).id];
        }
        const res = await fetch(`/api/channels/${channelId}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: m.body, parentId: m.parentId, fileIds }) });
        ids.push((await res.json()).id);
      }
      return ids;
    },
    { channelId, messages, png },
  );
}

/** The nearest scrolling box around an element, measured: how far it is from its end. */
const fromEnd = (inside: Locator) =>
  inside.evaluate((el) => {
    let box: HTMLElement | null = el.parentElement;
    while (box && !/(auto|scroll)/.test(getComputedStyle(box).overflowY)) box = box.parentElement;
    return box ? Math.round(box.scrollHeight - box.scrollTop - box.clientHeight) : -1;
  });

/** Photos arrive slowly, like on a weak connection, so they grow the conversation after it has opened. */
const slowPhotos = (page: Page) =>
  page.route(/\/api\/files\/[^/]+/, async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });

for (const [device, viewport] of [
  ['computer', { width: 1280, height: 800 }],
  ['phone', { width: 390, height: 844 }],
] as const) {
  test(`a conversation opens on its newest message, even when photos load late (${device})`, async ({ page }) => {
    const noErrors = trackErrors(page);
    await page.setViewportSize(viewport);
    await signIn(page, 'alex@acme.test');
    const run = Date.now().toString(36);
    const channel = await page.evaluate(async () => (await (await fetch('/api/channels')).json()).find((c: { name: string }) => c.name === 'user-research'));
    await post(page, channel.id, [
      ...Array.from({ length: 20 }, (_, i) => ({ body: `Earlier ${i} ${run}` })),
      { body: `Photo one ${run}`, photo: true },
      { body: `Photo two ${run}`, photo: true },
      { body: `Newest ${run}` },
    ]);
    await slowPhotos(page);

    await page.goto(`/channels/${channel.id}`);
    // In the conversation (the list beside it previews the same text on wide screens).
    const newest = page.locator('.message').getByText(`Newest ${run}`);
    await expect(newest).toBeVisible();
    // Wait for the photos to arrive, then the newest message must still be on screen.
    await expect(page.locator('img[src*="/api/files/"]').last()).toHaveJSProperty('complete', true, { timeout: 10_000 });
    await expect.poll(() => fromEnd(newest), { timeout: 5_000 }).toBeLessThanOrEqual(2);
    await expect(newest).toBeInViewport();
    noErrors();
  });

  test(`a thread opens on its newest reply, and stays put once you scroll up to read (${device})`, async ({ page }) => {
    const noErrors = trackErrors(page);
    await page.setViewportSize(viewport);
    await signIn(page, 'alex@acme.test');
    const run = Date.now().toString(36);
    const channel = await page.evaluate(async () => (await (await fetch('/api/channels')).json()).find((c: { name: string }) => c.name === 'mobile-app'));
    const [root] = await post(page, channel.id, [{ body: `Thread start ${run}` }]);
    await post(page, channel.id, [
      ...Array.from({ length: 12 }, (_, i) => ({ body: `Reply ${i} ${run}`, parentId: root })),
      { body: `Photo reply ${run}`, parentId: root, photo: true },
      { body: `Latest reply ${run}`, parentId: root },
    ]);
    await slowPhotos(page);

    await page.goto(`/channels/${channel.id}`);
    await page.locator('.message', { hasText: `Thread start ${run}` }).getByRole('button', { name: /replies/ }).click();
    const thread = page.getByRole('complementary', { name: 'Thread' });
    const latest = thread.getByText(`Latest reply ${run}`);
    await expect(latest).toBeVisible();
    await expect(thread.locator('img[src*="/api/files/"]').last()).toHaveJSProperty('complete', true, { timeout: 10_000 });
    await expect.poll(() => fromEnd(latest), { timeout: 5_000 }).toBeLessThanOrEqual(2);
    await expect(latest).toBeInViewport();

    // Scrolled up to read: the thread growing (a long reply from someone else) doesn't pull the reader back down...
    const first = thread.getByText(`Reply 0 ${run}`);
    await first.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await thread.locator('.message', { hasText: `Latest reply ${run}` }).evaluate((el) => (el.style.paddingBottom = '600px'));
    await page.waitForTimeout(500);
    await expect(first).toBeInViewport();
    // ...but sending a reply yourself brings you back to the end.
    await thread.getByRole('textbox').fill(`My answer ${run}`);
    await thread.getByRole('textbox').press('Enter');
    await expect(thread.getByText(`My answer ${run}`)).toBeInViewport();
    noErrors();
  });
}
