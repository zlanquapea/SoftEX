import { expect, test } from '@playwright/test';
import { signIn, trackErrors } from './helpers';

test('signed-in devices, calendar link, task import and bulk invites', async ({ page }) => {
  const noErrors = trackErrors(page);
  const run = Date.now().toString(36);
  await signIn(page, 'alex@acme.test');

  // Where you're signed in.
  await page.goto('/settings?tab=security');
  await expect(page.getByRole('heading', { name: 'Where you’re signed in' })).toBeVisible();
  await expect(page.getByText('This device')).toBeVisible();

  // Push notifications card renders (the production build registers a service worker).
  await page.goto('/settings?tab=notifications');
  await expect(page.getByRole('heading', { name: 'Notifications on this device' })).toBeVisible();

  // Calendar subscription link.
  await page.goto('/meetings');
  await page.getByRole('button', { name: 'Add to my calendar' }).click();
  await page.getByRole('button', { name: /Create my calendar link|Make a new link/ }).click();
  const url = (await page.locator('.token-reveal code').textContent())!;
  expect(url).toMatch(/\/api\/calendar\/.+\.ics$/);
  const feed = await page.request.get(new URL(url).pathname);
  expect(feed.status()).toBe(200);
  expect(await feed.text()).toContain('BEGIN:VCALENDAR');
  await page.keyboard.press('Escape');

  // Import tasks from a CSV into a project.
  await page.goto('/projects');
  await page.locator('.project-card, a[href^="/projects/"]').first().click();
  await page.getByRole('button', { name: 'Import tasks' }).click();
  await page.getByLabel('CSV file').setInputFiles({
    name: 'tasks.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(`Title,Status,Due date,Assignee\nImported A ${run},Doing,2026-12-01,maya@acme.test\nImported B ${run},,12/15/2026,\n`),
  });
  await page.getByRole('button', { name: 'Preview' }).click();
  await expect(page.getByRole('cell', { name: `Imported A ${run}` })).toBeVisible();
  await page.getByRole('button', { name: 'Import 2 tasks' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();

  // Invite several people at once.
  await page.goto('/admin?tab=invitations');
  await page.getByRole('button', { name: 'Invite many people at once' }).click();
  await page.getByLabel('Email addresses').fill(`one-${run}@example.com\ntwo-${run}@example.com, jordan@acme.test`);
  await page.getByRole('button', { name: 'Send invitations' }).click();
  await expect(page.getByText('2 invitations sent.')).toBeVisible();
  await expect(page.getByText('jordan@acme.test · Already a member')).toBeVisible();
  noErrors();
});
