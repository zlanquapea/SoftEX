import { expect, test } from '@playwright/test';
import { signIn, trackErrors } from './helpers';

test('the bell lists notifications and each one opens what it is about', async ({ page }) => {
  const noErrors = trackErrors(page);
  await signIn(page, 'alex@acme.test');
  const bell = page.getByRole('button', { name: /^Notifications/ });
  await bell.click();
  const panel = page.getByRole('dialog', { name: 'Notifications' });
  await expect(panel).toBeVisible();
  const first = panel.locator('.notif-item.unread').first();
  await expect(first).toBeVisible();
  const before = await bell.getAttribute('aria-label');
  await first.click();
  await expect(panel).toBeHidden();
  await expect(page).not.toHaveURL(/\/$/);
  // Opening it marked it read.
  await expect.poll(async () => bell.getAttribute('aria-label')).not.toBe(before);
  // Escape and outside clicks close it.
  await bell.click();
  await expect(panel).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  noErrors();
});

test('inbox summary pills filter the list', async ({ page }) => {
  await signIn(page, 'alex@acme.test');
  await page.goto('/inbox');
  const pill = page.locator('.digest .pill-button').first();
  await expect(pill).toBeVisible();
  await pill.click();
  await expect(pill).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText(/^Showing .* only\./)).toBeVisible();
  await page.getByRole('button', { name: 'Show everything' }).click();
  await expect(pill).toHaveAttribute('aria-pressed', 'false');
});

test('video links and uploaded videos show a preview in messages', async ({ page }) => {
  await signIn(page, 'alex@acme.test');
  await page.goto('/channels');
  await page.getByRole('link', { name: 'general' }).first().click();
  const composer = page.getByRole('textbox', { name: 'Message #general' });
  const run = Date.now().toString(36);
  await composer.fill(`Watch this ${run} https://youtu.be/dQw4w9WgXcQ`);
  await composer.press('Enter');
  const msg = page.locator('.message').filter({ hasText: `Watch this ${run}` });
  await expect(msg.locator('.video-card')).toBeVisible();
  await expect(msg.locator('.video-thumb img')).toHaveAttribute('src', /^https:\/\/i\.ytimg\.com\/vi\/dQw4w9WgXcQ\//);

  await page.locator('.composer input[type=file]').setInputFiles({ name: `clip-${run}.mp4`, mimeType: 'video/mp4', buffer: Buffer.alloc(2048) });
  await expect(page.locator('.pending-files video.pending-thumb')).toBeAttached();
  await composer.fill(`Clip ${run}`);
  await composer.press('Enter');
  const clip = page.locator('.message').filter({ hasText: `Clip ${run}` });
  await expect(clip.locator('.video-attachment video')).toHaveAttribute('src', /\/download\?inline=1#t=0\.1$/);
});
