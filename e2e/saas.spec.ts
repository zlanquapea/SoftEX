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
  await expect(page.getByRole('heading', { name: /one simple price/ })).toBeVisible();
  // One flat price per workspace, with each plan's members, shared storage and active projects; larger organisations get a quote.
  const free = page.getByRole('list', { name: 'What Free includes' });
  await expect(free).toContainText('3 members');
  await expect(free).toContainText('250 MB storage');
  await expect(free).toContainText('2 active projects');
  await expect(page.getByRole('list', { name: 'What Team includes' })).toContainText('25 GB storage');
  await expect(page.getByText('$250 billed yearly — 2 months free')).toBeVisible();
  await expect(page.getByText(/14-day Organization trial/).first()).toBeVisible();
  await expect(page.getByRole('table', { name: 'Compare plans' })).toContainText('Quote');
  await expect(page.getByText(/free forever|up to 5 members/i)).toHaveCount(0);

  await page.getByRole('link', { name: 'Start 14-day trial' }).first().click();
  await expect(page.getByText(/14-day free trial of Organization/)).toBeVisible();
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
  await expect(page.getByRole('heading', { name: /Organization trial/ })).toBeVisible();
  await expect(page.getByText(/Organization trial — 14 days left/)).toBeVisible();
  await page.getByRole('button', { name: 'Choose Team' }).click();
  await expect(page.getByText('One price for the whole workspace: 15 members (guests don\'t count), 25 GB shared storage and unlimited active projects.', { exact: false })).toBeVisible();
  await expect(page.getByText('Send to Orange Money 0770 000 000')).toBeVisible();
  // Payments need a confirmed email address.
  await expect(page.getByRole('button', { name: 'Submit payment' })).toBeDisabled();
  noErrors();
});
