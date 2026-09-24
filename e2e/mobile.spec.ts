import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

test('mobile layout uses bottom navigation', async ({ page }) => {
  await signIn(page, 'maya@acme.test');
  const nav = page.getByRole('navigation', { name: 'Primary' });
  await expect(nav).toBeVisible();
  await nav.getByRole('link', { name: 'My work' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'My work' })).toBeVisible();
  const width = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(width).toBeLessThanOrEqual(1);
});
