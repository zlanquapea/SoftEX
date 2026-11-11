import { expect, test, type Page } from '@playwright/test';
import { signIn, trackErrors } from './helpers';

const call = (page: Page, method: string, path: string, body?: unknown) =>
  page.evaluate(
    async ({ method, path, body }) => {
      const res = await fetch(`/api${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      return res.json();
    },
    { method, path, body },
  );
const run = () => Date.now().toString(36);
test('Home sums up what arrived since the last visit', async ({ page }) => {
  const noErrors = trackErrors(page);
  await signIn(page, 'alex@acme.test');
  const catchUp = page.getByRole('region', { name: 'Catch up' });
  await expect(catchUp).toBeVisible();
  await expect(catchUp.getByText(/From the last few days|Since your last visit/)).toBeVisible();
  noErrors();
});

test('filter tasks, save the filters as a view, and come back to it', async ({ page }) => {
  const noErrors = trackErrors(page);
  await signIn(page, 'alex@acme.test');
  const id = run();
  await call(page, 'POST', '/tasks', { title: `Fire drill ${id}`, priority: 'urgent' });
  await page.goto('/my-work');
  await page.getByRole('tab', { name: 'Filter tasks' }).click();
  await page.getByRole('group', { name: 'Priority' }).getByRole('button', { name: 'Urgent' }).click();
  await page.getByRole('searchbox', { name: 'Search task titles' }).fill(id);
  const results = page.getByRole('region', { name: 'Matching tasks' });
  await expect(results.locator('.task', { hasText: `Fire drill ${id}` })).toBeVisible();
  await expect(results.locator('.task')).toHaveCount(1);

  await page.getByRole('button', { name: 'Save as view' }).click();
  const dialog = page.getByRole('dialog', { name: 'Save view' });
  await dialog.getByLabel('Name').fill(`Drills ${id}`);
  await dialog.getByRole('button', { name: 'Save view' }).click();
  await expect(page.getByRole('tab', { name: `Drills ${id}` })).toHaveAttribute('aria-selected', 'true');
  await expect(page).toHaveURL(/\?view=/);

  // Still there after a reload, with its tasks.
  await page.reload();
  await expect(page.getByRole('tab', { name: `Drills ${id}` })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('region', { name: 'Matching tasks' }).locator('.task', { hasText: `Fire drill ${id}` })).toBeVisible();

  await page.getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete view' }).click();
  await expect(page.getByRole('tab', { name: `Drills ${id}` })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'My work' })).toHaveAttribute('aria-selected', 'true');
  noErrors();
});

test('out of office: set it in settings; chats show it and answer automatically', async ({ page, browser }) => {
  const noErrors = trackErrors(page);
  const leoContext = await browser.newContext();
  const leo = await leoContext.newPage();
  await signIn(leo, 'leo@acme.test');
  await leo.goto('/settings?section=notifications');
  const panel = leo.locator('#out-of-office');
  await panel.getByRole('button', { name: /Last day away/ }).click();
  // Pick a day a few days ahead in the calendar.
  const until = new Date(Date.now() + 3 * 86_400_000);
  if (until.getMonth() !== new Date().getMonth()) await leo.getByRole('button', { name: /next month/i }).click();
  const month = until.toLocaleDateString('en-US', { month: 'long' });
  await leo.getByRole('gridcell', { name: new RegExp(`${month} ${until.getDate()}(st|nd|rd|th), ${until.getFullYear()}`) }).click();
  const id = run();
  await panel.getByLabel('Automatic reply').fill(`Back soon ${id}. Ask Alex.`);
  await panel.getByRole('button', { name: 'Turn on' }).click();
  await expect(panel.getByText('On now')).toBeVisible();

  await signIn(page, 'nina@acme.test');
  const leoId = (await call(leo, 'GET', '/me')).user.id;
  const dm = await call(page, 'POST', '/dms', { userIds: [leoId] });
  await page.goto(`/channels/${dm.id}`);
  await expect(page.getByText('Leo is out of office until')).toBeVisible();
  const composer = page.getByRole('textbox', { name: /^Message / });
  await composer.fill(`Quick question ${id}`);
  await composer.press('Enter');
  const reply = page.locator('.message', { hasText: `Back soon ${id}` });
  await expect(reply).toBeVisible();
  await expect(reply).toContainText('Automatic reply');

  // Mentioning someone away says so before sending.
  const general = (await call(page, 'GET', '/channels')).find((c: { name: string }) => c.name === 'general');
  await page.goto(`/channels/${general.id}`);
  await composer.fill('@Leo');
  await expect(page.getByRole('option', { name: /Leo Ramos/ })).toContainText('Out of office');
  await page.getByRole('option', { name: /Leo Ramos/ }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Leo is out of office until' })).toBeVisible();
  await composer.fill('');

  // Back again.
  await leo.getByRole('button', { name: 'Turn off' }).click();
  await expect(panel.getByText('On now')).toHaveCount(0);
  await leoContext.close();
  noErrors();
});

test('a team sets a recurring check-in and members answer it on the team page', async ({ page }) => {
  const noErrors = trackErrors(page);
  await signIn(page, 'jordan@acme.test');
  const team = (await call(page, 'GET', '/teams')).find((t: { name: string }) => t.name === 'Product');
  await page.goto(`/teams/${team.id}?tab=checkins`);
  await page.getByRole('button', { name: /Set a schedule|Change schedule/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Check-in schedule' });
  await dialog.getByLabel('Time').fill('10:15');
  await dialog.getByRole('button', { name: 'Save schedule' }).click();
  await expect(page.getByText(/Weekdays at 10:15/)).toBeVisible();

  const id = run();
  await page.getByRole('button', { name: /Check in now|Add another update/ }).click();
  const form = page.getByRole('dialog', { name: 'Product check-in' });
  await form.getByLabel('What did you get done?').fill(`Shipped the beta ${id}`);
  await form.getByRole('button', { name: 'Share check-in' }).click();
  await expect(page.getByRole('region', { name: 'Today' })).toContainText(`Shipped the beta ${id}`);

  // The reminder's link opens the form directly.
  await page.goto(`/teams/${team.id}?tab=checkins&checkin=1`);
  await expect(page.getByRole('dialog', { name: 'Product check-in' })).toBeVisible();
  await page.keyboard.press('Escape');
  noErrors();
});

test.afterAll(async ({ browser }) => {
  // Leave Leo back at work even if the out-of-office test stopped half-way.
  const page = await browser.newPage();
  await signIn(page, 'leo@acme.test');
  await call(page, 'PATCH', '/me', { ooo_until: null, ooo_from: null });
  await page.close();
});


test('a daily task that never ends: set it when creating, and completing it brings in tomorrow’s', async ({ page }) => {
  const noErrors = trackErrors(page);
  await signIn(page, 'alex@acme.test');
  const id = run();
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.getByRole('button', { name: /Task Assign and track work/ }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Title').fill(`Check support inbox ${id}`);
  await dialog.getByLabel('Repeats').selectOption('daily');
  // Starts today, and repeats until stopped unless an end date is chosen.
  await expect(dialog.getByRole('button', { name: /Due date|Today|\d/ }).first()).toBeVisible();
  await expect(dialog.getByLabel('When it stops repeating')).toHaveValue('never');
  await dialog.getByRole('button', { name: 'Create task' }).click();

  await page.goto('/my-work');
  const row = page.locator('.task', { hasText: `Check support inbox ${id}` });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('Daily');
  await row.getByRole('checkbox', { name: /Mark .* done/ }).click();
  await expect(page.getByText(new RegExp(`Next “Check support inbox ${id}”: Tomorrow`))).toBeVisible();
  // The next one is waiting (in the upcoming list), still repeating.
  await expect(page.locator('.task:not(.is-done)', { hasText: `Check support inbox ${id}` })).toHaveCount(1, { timeout: 10_000 });

  // Quick add understands it too.
  await page.getByRole('textbox', { name: 'New task' }).first().fill(`Stand-up notes ${id} every weekday`);
  await expect(page.locator('#quick-add-understood')).toContainText('Every weekday');
  noErrors();
});
