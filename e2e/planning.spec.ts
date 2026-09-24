import { expect, test } from '@playwright/test';
import { signIn, trackErrors } from './helpers';

test('project timeline and automations', async ({ page }) => {
  const noErrors = trackErrors(page);
  await signIn(page, 'alex@acme.test');
  await page.goto('/projects');
  await page.locator('a[href^="/projects/"]').first().click();
  await page.getByRole('tab', { name: 'Timeline' }).click();
  await expect(page.getByRole('figure', { name: 'Project timeline' }).or(page.getByText('Nothing on the timeline yet'))).toBeVisible();

  await page.getByRole('tab', { name: 'Automations' }).click();
  const name = `Escalate blockers ${Date.now().toString(36)}`;
  await page.getByRole('button', { name: 'New automation' }).click();
  await page.getByLabel('Name', { exact: true }).fill(name);
  await page.getByLabel('Trigger', { exact: true }).selectOption('task.status_changed');
  await page.getByRole('combobox', { name: 'To', exact: true }).selectOption('blocked');
  await page.getByLabel('Action', { exact: true }).selectOption('set_priority');
  await page.getByRole('combobox', { name: 'Priority', exact: true }).selectOption('urgent');
  await page.getByRole('button', { name: 'Create automation' }).click();
  await expect(page.getByText(name)).toBeVisible();
  await expect(page.getByText('When a task moves to Blocked, set priority to urgent.').first()).toBeVisible();
  noErrors();
});

test('workload, reminders and insights', async ({ page }) => {
  const noErrors = trackErrors(page);
  await signIn(page, 'alex@acme.test');
  await page.getByLabel('Workspace navigation').getByRole('link', { name: 'Workload' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Workload' })).toBeVisible();

  await page.getByLabel('Workspace navigation').getByRole('link', { name: 'Later' }).click();
  await page.getByRole('button', { name: 'Reminder', exact: true }).click();
  const note = `Call the printer ${Date.now().toString(36)}`;
  await page.getByLabel('Note (optional)').fill(note);
  await page.getByRole('button', { name: /^Tomorrow morning/ }).click();
  await expect(page.locator('.later-list').getByText(note)).toBeVisible();

  await page.goto('/admin?tab=insights');
  await expect(page.getByText('Weekly active people')).toBeVisible();
  noErrors();
});
