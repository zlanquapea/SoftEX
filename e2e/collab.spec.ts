import { expect, test, type Browser } from '@playwright/test';
import { signIn, trackErrors } from './helpers';

async function person(browser: Browser, email: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const noErrors = trackErrors(page);
  await signIn(page, email);
  return { page, context, noErrors };
}

test('two people edit the same page at once', async ({ browser }) => {
  const alex = await person(browser, 'alex@acme.test');
  const maya = await person(browser, 'maya@acme.test');
  const title = `Live notes ${Date.now().toString(36)}`;

  await alex.page.goto('/knowledge');
  await alex.page.getByRole('button', { name: 'New page' }).click();
  await alex.page.getByLabel('Title').fill(title);
  await alex.page.getByRole('dialog').getByRole('button', { name: /Create/ }).click();
  // "Create and edit" opens the live editor straight away.
  await expect(alex.page).toHaveURL(/\/knowledge\/[^/?]+\?edit=1$/);
  await maya.page.goto(alex.page.url());
  const alexBody = alex.page.getByLabel('Page content');
  const mayaBody = maya.page.getByLabel('Page content');
  await expect(alexBody).toBeVisible();
  await expect(mayaBody).toBeVisible();

  // Each sees the other is here.
  await expect(alex.page.getByLabel(/^Also editing: .*Maya/)).toBeVisible();

  await alexBody.click();
  await alexBody.pressSequentially('Agenda from Alex. ');
  await expect(mayaBody).toHaveValue('Agenda from Alex. ');
  await mayaBody.click();
  await maya.page.keyboard.press('End');
  await mayaBody.pressSequentially('Notes from Maya.');
  await expect(alexBody).toHaveValue('Agenda from Alex. Notes from Maya.');

  // Saving publishes the shared text; readers see it.
  await maya.page.getByRole('button', { name: /^Save version/ }).click();
  await expect(maya.page.getByText('Notes from Maya.')).toBeVisible();
  await expect(maya.page.locator('.doc')).toContainText('Agenda from Alex.');

  alex.noErrors();
  maya.noErrors();
  await alex.context.close();
  await maya.context.close();
});

test('two people draw on the same whiteboard', async ({ browser }) => {
  const alex = await person(browser, 'alex@acme.test');
  const maya = await person(browser, 'maya@acme.test');
  const name = `Retro ${Date.now().toString(36)}`;

  await alex.page.getByLabel('Workspace navigation').getByRole('link', { name: 'Whiteboards' }).click();
  await alex.page.getByRole('button', { name: 'New whiteboard' }).click();
  await alex.page.getByLabel('Name').fill(name);
  await alex.page.getByRole('dialog').getByRole('button', { name: 'Create' }).click();
  const alexBoard = alex.page.getByRole('img', { name: /^Whiteboard with/ });
  await expect(alexBoard).toHaveAccessibleName('Whiteboard with 0 items');

  await maya.page.goto(alex.page.url());
  const mayaBoard = maya.page.getByRole('img', { name: /^Whiteboard with/ });
  await expect(mayaBoard).toBeVisible();

  // Alex double-clicks to add a sticky note and writes on it.
  const box = (await alexBoard.boundingBox())!;
  await alexBoard.dblclick({ position: { x: box.width / 2 - 150, y: box.height / 2 } });
  await alex.page.getByLabel('Edit text').fill('What went well?');
  await alex.page.getByLabel('Edit text').press('Escape');
  await expect(maya.page.locator('.wb-text', { hasText: 'What went well?' })).toBeVisible();

  // Maya draws a rectangle; Alex sees it arrive.
  await maya.page.getByRole('button', { name: 'Rectangle' }).click();
  const mbox = (await mayaBoard.boundingBox())!;
  await maya.page.mouse.move(mbox.x + mbox.width / 2 + 60, mbox.y + mbox.height / 2 - 40);
  await maya.page.mouse.down();
  await maya.page.mouse.move(mbox.x + mbox.width / 2 + 220, mbox.y + mbox.height / 2 + 60, { steps: 5 });
  await maya.page.mouse.up();
  await expect(alexBoard).toHaveAccessibleName('Whiteboard with 2 items');

  // Undo only reverts your own change.
  await maya.page.getByRole('button', { name: 'Undo' }).click();
  await expect(alexBoard).toHaveAccessibleName('Whiteboard with 1 item');
  await expect(alex.page.locator('.wb-text', { hasText: 'What went well?' })).toBeVisible();

  // It is still there after a reload.
  await alex.page.reload();
  await expect(alex.page.locator('.wb-text', { hasText: 'What went well?' })).toBeVisible();

  alex.noErrors();
  maya.noErrors();
  await alex.context.close();
  await maya.context.close();
});
