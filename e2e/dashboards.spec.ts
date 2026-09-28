import { expect, test } from '@playwright/test';
import { signIn, trackErrors } from './helpers';

test('build a dashboard of charts', async ({ page }) => {
  const noErrors = trackErrors(page);
  await signIn(page, 'alex@acme.test');
  await page.getByLabel('Workspace navigation').getByRole('link', { name: 'Dashboards' }).click();
  const name = `Weekly review ${Date.now().toString(36)}`;
  await page.getByRole('button', { name: 'New dashboard' }).click();
  await page.getByLabel('Name').fill(name);
  await page.getByRole('dialog').getByRole('button', { name: 'Create' }).click();

  // The starter layout draws real numbers and charts.
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
  const open = page.getByRole('region', { name: 'Open tasks', exact: true });
  await expect(open.locator('.big-metric strong')).toHaveText(/^\d+$/);
  await expect(page.getByRole('region', { name: 'Tasks by status' }).getByRole('img')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Created and completed per week' }).locator('polyline')).toHaveCount(2);

  // Add a note and a priority chart, then remove a widget.
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByRole('button', { name: 'Add widget' }).click();
  await page.getByLabel('Show').selectOption('priority');
  await page.getByRole('dialog').getByRole('button', { name: 'Add widget' }).click();
  await expect(page.getByRole('region', { name: 'Open tasks by priority' }).locator('.bar-chart')).toBeVisible();
  await page.getByRole('button', { name: 'Add widget' }).click();
  await page.getByLabel('Show').selectOption('note');
  await page.getByRole('textbox', { name: /^Text/ }).fill('Review **blocked** work first.');
  await page.getByRole('dialog').getByRole('button', { name: 'Add widget' }).click();
  await expect(page.locator('.dash-widget strong', { hasText: 'blocked' })).toBeVisible();
  const before = await page.locator('.dash-widget').count();
  await page.getByRole('region', { name: 'Blocked' }).getByRole('button', { name: 'Remove widget' }).click();
  await expect(page.locator('.dash-widget')).toHaveCount(before - 1);
  await page.getByRole('button', { name: 'Done', exact: true }).click();

  // The layout was saved.
  await page.reload();
  await expect(page.getByRole('region', { name: 'Open tasks by priority' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Blocked' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Add to favorites' }).click();
  await expect(page.getByLabel('Favorites').getByRole('link', { name })).toBeVisible();
  noErrors();
});
