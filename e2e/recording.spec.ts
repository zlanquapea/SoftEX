import { expect, test } from '@playwright/test';
import { signIn, trackErrors } from './helpers';

// Chromium's fake microphone: a steady tone, with no permission prompt.
test.use({
  permissions: ['microphone'],
  launchOptions: {
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
  },
});

test('record a meeting and play it back', async ({ page }) => {
  const noErrors = trackErrors(page);
  await signIn(page, 'alex@acme.test');
  await page.goto('/meetings');
  await page.locator('a[href^="/meetings/"]').first().click();
  const section = page.locator('#recordings');
  await section.getByRole('button', { name: 'Record' }).click();

  const dialog = page.getByRole('dialog', { name: 'Record this meeting' });
  const start = dialog.getByRole('button', { name: 'Start recording' });
  await expect(start).toBeDisabled();
  await dialog.getByLabel('Live captions').uncheck();
  await dialog.getByLabel(/Everyone in this meeting knows/).check();
  await start.click();

  await expect(section.getByText(/^Recording \d+:\d\d$/)).toBeVisible();
  await page.waitForTimeout(2500);
  await section.getByRole('button', { name: 'Stop and save' }).click();
  await expect(page.getByText('Recording saved')).toBeVisible();

  const item = section.locator('.recording-item').last();
  await expect(item.locator('audio')).toHaveAttribute('src', /^\/api\/recordings\/[^/]+\/media$/);
  // The file really plays: the browser reads its length from the server.
  await expect.poll(async () => item.locator('audio').evaluate((a: HTMLAudioElement) => a.readyState)).toBeGreaterThan(0);
  await expect(item.getByRole('link', { name: 'Download' })).toBeVisible();

  page.once('dialog', (d) => d.accept());
  await item.getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByText('Recording deleted')).toBeVisible();
  noErrors();
});
