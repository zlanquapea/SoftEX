import { expect, test } from '@playwright/test';
import { signIn, trackErrors } from './helpers';

test('phones never scroll sideways, and long tab rows scroll on their own', async ({ page }) => {
  const noErrors = trackErrors(page);
  await signIn(page, 'alex@acme.test');
  await page.setViewportSize({ width: 390, height: 844 });
  const projectId = await page.evaluate(async () => (await (await fetch('/api/projects')).json())[0].id);
  for (const path of ['/', '/inbox', '/chats', `/projects/${projectId}`, '/admin', '/meetings', '/workload', '/goals', '/help']) {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, `sideways scroll on ${path}`).toBeLessThanOrEqual(0);
  }
  await expect(page.getByRole('button', { name: 'Notifications' }).or(page.locator('.notification')).first()).toBeInViewport();
  noErrors();
});

test('a direct message is filed under Chats, with a preview in the list', async ({ page }) => {
  await signIn(page, 'alex@acme.test');
  await page.goto('/chats');
  const row = page.locator('.list-row').filter({ hasText: 'Maya Singh' });
  // Other tests may reply first, so check there is a preview rather than its exact words.
  await expect(row.locator('.list-preview')).toHaveText(/Do you have 10 minutes|^You: /);
  await row.click();
  await expect(page.locator('.nav-item.active')).toHaveText(/Chats/);
});

test('owners of a new workspace get a setup guide', async ({ page }) => {
  await page.goto('/register');
  const run = Date.now().toString(36);
  await page.getByLabel('Your name').fill('Ama Boateng');
  await page.getByLabel('Work email').fill(`ama-${run}@example.com`);
  await page.getByLabel('Password').fill('password123');
  await page.getByRole('button', { name: 'Show' }).click();
  await expect(page.getByLabel('Password')).toHaveAttribute('type', 'text');
  await page.getByLabel('Workspace name').fill(`Boateng ${run}`);
  await page.getByRole('button', { name: 'Create workspace' }).click();
  const guide = page.getByRole('region', { name: 'Get started' });
  await expect(guide).toContainText(/0 of 5 done/);
  await expect(guide.getByRole('link', { name: 'Invite people' })).toBeVisible();
  await expect(page.getByText('Recent activity in your workspace')).toBeVisible();
  await guide.getByRole('button', { name: 'Hide' }).click();
  await expect(guide).toBeHidden();
});
