import { expect, test } from '@playwright/test';
import { signIn, trackErrors } from './helpers';

test('owner can reach every main screen', async ({ page }) => {
  const noErrors = trackErrors(page);
  await signIn(page, 'alex@acme.test');
  await expect(page.getByText('Today’s focus')).toBeVisible();
  for (const [link, heading] of [
    ['Inbox', 'Inbox'],
    ['Chats', 'Chats'],
    ['Channels', 'Channels'],
    ['My work', 'My work'],
    ['Projects', 'Projects'],
    ['Knowledge', 'Knowledge'],
    ['Meetings', 'Meetings'],
    ['Directory', 'Directory'],
    ['Decisions', 'Decisions'],
    ['Requests', 'Requests & approvals'],
  ]) {
    // Link names can include unread badges, e.g. "Inbox 8".
    await page.getByLabel('Workspace navigation').getByRole('link', { name: new RegExp(`^${link}( \\d+)?$`) }).first().click();
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
  }
  noErrors();
});

test('discussion to delivery: message, mention and task', async ({ page }) => {
  const noErrors = trackErrors(page);
  const run = Date.now().toString(36);
  await signIn(page, 'alex@acme.test');
  await page.goto('/channels');
  await page.getByRole('link', { name: 'general' }).first().click();
  const composer = page.getByRole('textbox', { name: 'Message #general' });
  await composer.fill(`Smoke test message ${run}`);
  await composer.press('Enter');
  await expect(page.locator('.message').filter({ hasText: `Smoke test message ${run}` })).toBeVisible();

  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.getByRole('button', { name: /Task Assign and track work/ }).click();
  await page.getByLabel('Title').fill(`Follow-up task ${run}`);
  await page.getByRole('button', { name: 'Create task' }).click();
  await page.goto('/my-work');
  await expect(page.getByText(`Follow-up task ${run}`)).toBeVisible();
  noErrors();
});

test('global search finds knowledge by its content', async ({ page }) => {
  await signIn(page, 'alex@acme.test');
  await page.keyboard.press('Control+k');
  await page.getByRole('textbox', { name: 'Search' }).fill('economy');
  await expect(page.getByRole('button', { name: /Travel and expense policy/ })).toBeVisible();
});

test('guests only see what was shared with them', async ({ page }) => {
  await signIn(page, 'casey@northwind.test');
  await expect(page.getByText(/You are a guest in Acme Studio/)).toBeVisible();
  await page.goto('/channels');
  await expect(page.getByRole('link', { name: 'client-northwind' }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'leadership-planning' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'general', exact: true })).toHaveCount(0);
});

test('password reset screen is reachable from sign-in', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'Forgot password?' }).click();
  await page.getByLabel('Work email').fill('alex@acme.test');
  await page.getByRole('button', { name: 'Email me a reset link' }).click();
  await expect(page.getByText(/reset link is on its way/)).toBeVisible();
});

test('admin integration screens and personal API tokens', async ({ page }) => {
  const noErrors = trackErrors(page);
  await signIn(page, 'alex@acme.test');
  await page.goto('/admin?tab=sso');
  await expect(page.getByText(/SOFTEX_SECRET_KEY|Single sign-on \(OpenID Connect\)/)).toBeVisible();
  await page.goto('/admin?tab=integrations');
  await expect(page.getByRole('heading', { name: 'Add a webhook' })).toBeVisible();
  await page.goto('/admin?tab=email');
  await expect(page.getByRole('heading', { name: 'Email', exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'jordan@acme.test' }).first()).toBeVisible();

  await page.goto('/settings?tab=api');
  await page.getByLabel('Name').fill(`CI token ${Date.now()}`);
  await page.getByRole('button', { name: 'Create token' }).click();
  const token = (await page.locator('.token-reveal code').textContent())!;
  expect(token).toMatch(/^sx_/);
  const res = await page.request.get('/api/projects', { headers: { Authorization: `Bearer ${token}` } });
  expect(res.status()).toBe(200);
  noErrors();
});
