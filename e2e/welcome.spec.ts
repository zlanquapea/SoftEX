import { expect, test } from '@playwright/test';
import { signIn, trackErrors } from './helpers';

// Signed-out visitors to "/" see the product website on every server; sign-in is at /login.
test('the product website can be previewed at /welcome, signed out or in', async ({ page }) => {
  const noErrors = trackErrors(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: /Stop chasing work/ })).toBeVisible();
  await page.goto('/login');
  await expect(page.getByLabel('Work email')).toBeVisible();

  await page.goto('/welcome');
  await expect(page.getByRole('heading', { level: 1, name: /Stop chasing work/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /Start free/ }).first()).toBeVisible();

  await signIn(page, 'alex@acme.test');
  await page.goto('/welcome');
  await expect(page.getByRole('heading', { level: 1, name: /Stop chasing work/ })).toBeVisible();
  await page.getByRole('link', { name: 'Open Küü' }).click();
  await expect(page.getByRole('heading', { name: /Good (morning|afternoon|evening)/ })).toBeVisible();
  noErrors();
});

test('the website tour plays through the main features and can be driven by hand', async ({ page }) => {
  const noErrors = trackErrors(page);
  await page.goto('/welcome');
  const tab = (name: string) => page.getByRole('tab', { name });
  await expect(tab('Chat')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel')).toContainText('# launch-team');

  await tab('Projects').click();
  await expect(tab('Projects')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel')).toContainText('Website relaunch');
  await tab('Ask Küü').click();
  await expect(page.getByRole('tabpanel')).toContainText('Answers with sources');

  // Left alone in view, it moves on to the next feature by itself.
  await page.locator('.demo-frame').scrollIntoViewIfNeeded();
  await page.mouse.move(2, 300);
  await expect(tab('Dashboards')).toHaveAttribute('aria-selected', 'true', { timeout: 10_000 });

  // The site speaks to teams anywhere.
  await expect(page.locator('body')).not.toContainText(/Liberia/i);
  noErrors();
});
