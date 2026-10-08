import { expect, test, type Page } from '@playwright/test';
import { signIn, trackErrors } from './helpers';

/** Call the API as whoever is signed in on this page (same origin, so it carries their session). */
const call = (page: Page, method: string, path: string, body?: unknown) =>
  page.evaluate(
    async ({ method, path, body }) => {
      const res = await fetch(`/api${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      return res.json();
    },
    { method, path, body },
  );

test('unread messages from one chat are one Inbox row with a count, and reading the chat clears it', async ({ page, browser }) => {
  const noErrors = trackErrors(page);
  // Nina writes to Leo (people no other test signs in as).
  const ninaContext = await browser.newContext();
  const nina = await ninaContext.newPage();
  await signIn(nina, 'nina@acme.test');
  await signIn(page, 'leo@acme.test');
  const leoId = (await call(page, 'GET', '/me')).user.id;
  const dm = await call(nina, 'POST', '/dms', { userIds: [leoId] });
  const run = Date.now().toString(36);
  for (const n of [1, 2, 3]) await call(nina, 'POST', `/channels/${dm.id}/messages`, { body: `Update ${n} ${run}` });

  await page.goto('/inbox');
  const row = page.locator('.inbox-item.unread').filter({ hasText: `Update 3 ${run}` });
  await expect(row).toHaveCount(1);
  await expect(row.locator('.group-count')).toHaveText(/^[3-9]|\d\d+$/);
  // Only one row for the chat, not one per message.
  await expect(page.locator('.inbox-item').filter({ hasText: `Update 2 ${run}` })).toHaveCount(0);

  // Open the chat: its notifications are read, and a message arriving while it's open doesn't notify.
  await page.goto(`/channels/${dm.id}`);
  await expect(page.getByText(`Update 3 ${run}`)).toBeVisible();
  await call(nina, 'POST', `/channels/${dm.id}/messages`, { body: `While you look ${run}` });
  await expect(page.getByText(`While you look ${run}`)).toBeVisible();
  await expect
    .poll(async () => (await call(page, 'GET', '/notifications?filter=unread')).notifications.filter((n: { group_key: string }) => n.group_key === `/channels/${dm.id}`).length)
    .toBe(0);
  await ninaContext.close();
  noErrors();
});

test('changing a task in the drawer or on its page keeps the screen working', async ({ page }) => {
  const noErrors = trackErrors(page);
  await signIn(page, 'alex@acme.test');
  const task = await call(page, 'POST', '/tasks', { title: `Regression ${Date.now().toString(36)}` });
  await page.goto('/my-work');
  await page.getByText(task.title).click();
  const drawer = page.locator('.task-detail');
  await drawer.locator('.status-steps').getByRole('button', { name: 'In progress' }).click();
  await drawer.getByLabel('Reviewer').selectOption({ label: 'Maya Singh' });
  await drawer.locator('.status-steps').getByRole('button', { name: 'Done' }).click();
  await expect(drawer.locator('.status-steps').getByRole('button', { name: 'Done' })).toHaveAttribute('aria-pressed', 'true');
  await expect(drawer.getByLabel('Task title')).toHaveValue(task.title);

  await page.goto(`/tasks/${task.id}`);
  await page.locator('.status-steps').getByRole('button', { name: 'Review' }).click();
  await page.getByLabel('Reviewer').selectOption({ label: 'Jordan Wells' });
  await expect(page.getByLabel('Reviewer')).toHaveValue(/.+/);
  await expect(page.getByLabel('Task title')).toHaveValue(task.title);
  noErrors();
});

test('the sidebar keeps the logo and profile in view, folds channels, and docks to icons', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 600 });
  await signIn(page, 'alex@acme.test');
  const sidebar = page.getByRole('complementary', { name: 'Workspace navigation' });
  await sidebar.locator('.nav-scroll').evaluate((el) => (el.scrollTop = el.scrollHeight));
  await expect(sidebar.getByRole('link', { name: 'Küü home' })).toBeInViewport();
  await expect(sidebar.locator('.profile')).toBeInViewport();

  await sidebar.getByRole('button', { name: 'Hide your channels' }).click();
  await expect(sidebar.getByLabel('Your channels', { exact: true })).toHaveCount(0);
  await sidebar.getByRole('button', { name: 'Show your channels' }).click();
  await expect(sidebar.getByLabel('Your channels', { exact: true })).toBeVisible();

  await sidebar.getByRole('button', { name: 'Collapse the sidebar into a dock' }).click();
  await expect(sidebar).toHaveClass(/docked/);
  expect((await sidebar.boundingBox())!.width).toBeLessThan(90);
  await sidebar.getByRole('link', { name: /^Inbox/ }).click();
  await expect(page).toHaveURL(/\/inbox$/);
  // Remembered on this device.
  await page.reload();
  await expect(sidebar).toHaveClass(/docked/);
  await sidebar.getByRole('button', { name: 'Expand the sidebar' }).click();
  await expect(sidebar).not.toHaveClass(/docked/);
});

test.describe('on a device that has never been asked', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('asks to turn on notifications after signing in, and "Not now" puts it away', async ({ page }) => {
    // Headless browsers report notifications as blocked (when there is nothing to ask), so present a device
    // that supports push and hasn't been asked yet: permission undecided, no push subscription.
    await page.addInitScript(() => {
      Object.defineProperty(Notification, 'permission', { get: () => 'default' });
      const registration = { pushManager: { getSubscription: async () => null } };
      Object.defineProperty(navigator.serviceWorker, 'ready', { get: () => Promise.resolve(registration) });
      navigator.serviceWorker.getRegistration = async () => registration as unknown as ServiceWorkerRegistration;
    });
    await signIn(page, 'jordan@acme.test');
    const prompt = page.getByRole('dialog', { name: 'Turn on notifications?' });
    await expect(prompt).toBeVisible({ timeout: 10_000 });
    await prompt.getByRole('button', { name: 'Not now' }).click();
    await expect(prompt).toBeHidden();
    await page.reload();
    await page.waitForTimeout(3500);
    await expect(prompt).toBeHidden();
  });
});

test('messages can have several paragraphs: Enter to send can be turned off, and Ctrl+Enter always sends', async ({ page }) => {
  const noErrors = trackErrors(page);
  await signIn(page, 'alex@acme.test');
  await page.goto('/channels');
  await page.getByRole('link', { name: 'general' }).first().click();
  const composer = page.getByRole('textbox', { name: 'Message #general' });
  const run = Date.now().toString(36);

  // Default on a computer: Shift+Enter starts a new line, Enter sends.
  await composer.fill(`First ${run}`);
  await composer.press('Shift+Enter');
  await composer.press('Shift+Enter');
  await composer.pressSequentially(`Second ${run}`);
  await composer.press('Enter');
  const message = page.locator('.message').filter({ hasText: `First ${run}` });
  await expect(message.locator('.markdown p')).toHaveCount(2);
  // The blank line shows as a gap between the paragraphs.
  const gap = await message.locator('.markdown p').nth(1).evaluate((p) => parseFloat(getComputedStyle(p).marginTop));
  expect(gap).toBeGreaterThan(0);

  // With "Enter to send" off, Enter starts a new line and Ctrl+Enter sends.
  await page.getByLabel('Enter to send').uncheck();
  await composer.pressSequentially(`Third ${run}`);
  await composer.press('Enter');
  await composer.press('Enter');
  await composer.pressSequentially(`Fourth ${run}`);
  await expect(composer).toHaveValue(`Third ${run}\n\nFourth ${run}`);
  await composer.press('Control+Enter');
  await expect(page.locator('.message').filter({ hasText: `Third ${run}` }).locator('.markdown p')).toHaveCount(2);
  // Remembered on this device.
  await page.reload();
  await expect(page.getByLabel('Enter to send')).not.toBeChecked();
  await page.getByLabel('Enter to send').check();
  noErrors();
});
