import { expect, test } from '@playwright/test';
import { signIn, trackErrors } from './helpers';

// This server is self-hosted, so "/" goes to sign-in; the website is still at /welcome.
test('the product website can be previewed at /welcome, signed out or in', async ({ page }) => {
  const noErrors = trackErrors(page);
  await page.goto('/');
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
