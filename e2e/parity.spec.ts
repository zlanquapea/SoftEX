import { expect, test } from '@playwright/test';
import { signIn, trackErrors } from './helpers';

const run = () => Date.now().toString(36);

test('project table and calendar views, fields, labels and time', async ({ page }) => {
  const noErrors = trackErrors(page);
  await signIn(page, 'alex@acme.test');
  await page.goto('/projects');
  await page.getByRole('link', { name: /Brand refresh/ }).first().click();

  // A custom field shows up as a table column.
  const field = `Budget ${run()}`;
  await page.getByRole('button', { name: 'Fields' }).click();
  await page.getByLabel('New field name').fill(field);
  await page.getByLabel('Field type').selectOption('number');
  await page.getByRole('button', { name: 'Add field' }).click();
  await expect(page.getByLabel('Field name', { exact: true }).last()).toHaveValue(field);
  await page.getByRole('button', { name: 'Close' }).click();

  await page.getByRole('tab', { name: /Tasks/ }).click();
  await page.getByRole('button', { name: 'Table' }).click();
  await expect(page.getByRole('columnheader', { name: field })).toBeVisible();
  // The table re-sorts after a change, so follow the task by name.
  const name = (await page.getByRole('combobox', { name: /^Status of / }).first().getAttribute('aria-label'))!;
  await page.getByRole('combobox', { name, exact: true }).selectOption('review');
  await expect(page.getByRole('combobox', { name, exact: true })).toHaveValue('review');

  await page.getByRole('button', { name: 'Calendar' }).click();
  await expect(page.getByRole('heading', { name: new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) })).toBeVisible();
  await expect(page.getByRole('grid')).toBeVisible();

  // Labels and time from the task drawer.
  await page.getByRole('button', { name: 'List' }).click();
  await page.locator('.task-body').first().click();
  const drawer = page.getByRole('dialog', { name: 'Task details' });
  const label = `Print ${run()}`;
  await drawer.getByRole('button', { name: 'Add label' }).click();
  await drawer.getByLabel('Find or create a label').fill(label);
  await drawer.getByRole('button', { name: `Create “${label}”` }).click();
  await expect(drawer.locator('.label-picker > .label-chip', { hasText: label })).toBeVisible();
  await drawer.getByRole('button', { name: 'Log time' }).click();
  await drawer.getByRole('spinbutton', { name: 'Hours', exact: true }).fill('1.5');
  await drawer.getByRole('button', { name: 'Save time' }).click();
  await expect(drawer.getByText('1h 30m', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close task' }).click();

  await page.getByLabel('Workspace navigation').getByRole('link', { name: 'Timesheet' }).click();
  await expect(page.getByText(/Total this week: \d/)).toBeVisible();
  noErrors();
});

test('goals with key results', async ({ page }) => {
  const noErrors = trackErrors(page);
  await signIn(page, 'alex@acme.test');
  await page.getByLabel('Workspace navigation').getByRole('link', { name: 'Goals' }).click();
  const title = `Grow to 500 customers ${run()}`;
  await page.getByRole('button', { name: 'New goal' }).click();
  await page.getByLabel('Goal', { exact: true }).fill(title);
  await page.getByRole('button', { name: 'Create goal' }).click();
  await page.getByRole('link', { name: new RegExp(title) }).click();
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByRole('textbox', { name: 'Key result' }).fill('Paying customers');
  await page.getByRole('spinbutton', { name: 'Target' }).fill('500');
  await page.getByRole('button', { name: 'Add', exact: true }).last().click();
  const current = page.getByLabel('Current value of Paying customers');
  await current.fill('250');
  await current.press('Enter');
  await expect(page.locator('.big-number')).toHaveText('50%');
  await page.getByRole('button', { name: 'Add to favorites' }).click();
  await expect(page.getByLabel('Favorites').getByRole('link', { name: title })).toBeVisible();
  noErrors();
});

test('nested pages, comments and publishing to the web', async ({ page, browser }) => {
  const noErrors = trackErrors(page);
  await signIn(page, 'alex@acme.test');
  await page.goto('/knowledge');
  await page.locator('.page-card').first().click();
  const parent = (await page.locator('.doc-title').innerText()).trim();
  await page.getByRole('button', { name: 'Sub-page' }).click();
  const title = `Checklist ${run()}`;
  await page.getByLabel('Page title').fill(title);
  await page.getByLabel('Page content').fill('Bring **ID** and a pen.');
  await page.getByRole('button', { name: /^Save version/ }).click();
  await expect(page.locator('.crumbs a').last()).toHaveText(parent);

  await page.getByLabel('Comment on this page').fill('Looks good to me');
  await page.getByRole('button', { name: 'Post' }).click();
  await expect(page.locator('.page-comments').getByText('Looks good to me')).toBeVisible();

  await page.getByRole('button', { name: 'Publish' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Publish' }).click();
  const url = await page.getByLabel('Public link').inputValue();
  const path = new URL(url).pathname;
  const visitor = await browser.newPage();
  await visitor.goto(path);
  await expect(visitor.getByRole('heading', { name: title })).toBeVisible();
  await expect(visitor.getByText('Bring')).toBeVisible();
  await expect(visitor.getByText('Looks good to me')).toHaveCount(0);
  await visitor.close();
  noErrors();
});

test('an intake form takes responses from people without an account', async ({ page, browser }) => {
  const noErrors = trackErrors(page);
  await signIn(page, 'alex@acme.test');
  await page.goto('/projects');
  await page.getByRole('link', { name: /Brand refresh/ }).first().click();
  await page.getByRole('tab', { name: 'Forms' }).click();
  await page.getByRole('button', { name: 'New form' }).click();
  const title = `Design request ${run()}`;
  await page.getByLabel('Title').fill(title);
  await page.getByLabel('Anyone with the link can respond').check();
  await page.getByRole('button', { name: 'Save form' }).click();
  const card = page.locator('.form-card', { hasText: title });
  await expect(card.getByText('Public link', { exact: true })).toBeVisible();
  await card.getByRole('link', { name: 'Open form' }).click();
  const formUrl = page.url();
  expect(formUrl).toMatch(/\/forms\//);
  // Grab the public link from the project list.
  await page.goBack();
  const [publicUrl] = await Promise.all([
    page.evaluate(() => new Promise<string>((resolve) => (navigator.clipboard.writeText = async (t: string) => resolve(t)) as never)),
    card.getByRole('button', { name: 'Copy public link' }).click(),
  ]);

  const visitor = await browser.newPage();
  await visitor.goto(new URL(publicUrl).pathname);
  await expect(visitor.getByRole('heading', { name: title })).toBeVisible();
  const ask = `New flyer ${run()}`;
  await visitor.getByLabel('What do you need? *').fill(ask);
  await visitor.getByLabel('Your email').fill('visitor@example.com');
  await visitor.getByRole('button', { name: 'Submit' }).click();
  await expect(visitor.getByText('your response was received')).toBeVisible();
  await visitor.close();

  await page.getByRole('tab', { name: /Tasks/ }).click();
  await expect(page.getByText(ask)).toBeVisible();
  noErrors();
});

test('polls and forwarding in chat', async ({ page }) => {
  const noErrors = trackErrors(page);
  await signIn(page, 'alex@acme.test');
  await page.goto('/channels');
  await page.getByRole('link', { name: 'general' }).first().click();
  await page.getByRole('button', { name: 'Create a poll' }).click();
  const question = `Team lunch ${run()}?`;
  await page.getByLabel('Question').fill(question);
  await page.getByLabel('Option 1').fill('Jollof');
  await page.getByLabel('Option 2').fill('Palm butter');
  await page.getByRole('button', { name: 'Post poll' }).click();
  const poll = page.getByRole('group', { name: `Poll: ${question}` });
  await poll.getByRole('button', { name: /Palm butter/ }).click();
  await expect(poll.getByRole('button', { name: /Palm butter/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(poll.getByText('1 · 100%')).toBeVisible();

  const message = page.locator('.message').filter({ has: poll });
  await message.hover();
  await message.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Forward' }).click();
  const dialog = page.getByRole('dialog', { name: 'Forward message' });
  await dialog.locator('.forward-targets label').filter({ hasNotText: 'general' }).first().click();
  await dialog.getByRole('button', { name: 'Forward' }).click();
  await expect(page.getByText('Message forwarded')).toBeVisible();
  noErrors();
});
