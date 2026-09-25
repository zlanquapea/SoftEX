import { expect, test } from '@playwright/test';
import { trackErrors } from './helpers';

test('sign up on a hosted server: trial, pricing and billing', async ({ page }) => {
  const noErrors = trackErrors(page);
  const run = Date.now().toString(36);
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: /Stop chasing work/ })).toBeVisible();
  await page.getByRole('link', { name: 'Terms of Service' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Terms of Service' })).toBeVisible();
  await page.getByRole('link', { name: 'Privacy Policy' }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Privacy Policy' })).toBeVisible();
  await page.goto('/pricing');
  await expect(page.getByRole('heading', { name: /priced for Liberia/ })).toBeVisible();
  await expect(page.getByText('$1.50')).toBeVisible();

  await page.getByRole('link', { name: 'Start free trial' }).first().click();
  await expect(page.getByText(/30-day free trial of Business/)).toBeVisible();
  await page.getByLabel('Your name').fill('Musu Kollie');
  await page.getByLabel('Work email').fill(`musu-${run}@example.com`);
  await page.getByLabel('Password').fill('password123');
  await page.getByLabel('Workspace name').fill(`Monrovia Traders ${run}`);
  await page.getByRole('button', { name: 'Create workspace' }).click();
  // The terms checkbox is required.
  await expect(page.getByText(/Please confirm your email address/)).not.toBeVisible();
  await page.getByRole('checkbox', { name: /I agree to the/ }).check();
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page.getByText(/Please confirm your email address/)).toBeVisible();

  await page.goto('/admin?tab=billing');
  await expect(page.getByRole('heading', { name: /Business trial/ })).toBeVisible();
  await expect(page.getByText(/30 days left/)).toBeVisible();
  await page.getByRole('button', { name: 'Choose Standard' }).click();
  await expect(page.getByText('Send to Orange Money 0770 000 000')).toBeVisible();
  // Payments need a confirmed email address.
  await expect(page.getByRole('button', { name: 'Submit payment' })).toBeDisabled();
  noErrors();
});
