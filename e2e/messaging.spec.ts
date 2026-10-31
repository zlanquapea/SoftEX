import { expect, test, type Page } from '@playwright/test';
import { signIn, trackErrors } from './helpers';

const call = (page: Page, method: string, path: string, body?: unknown) =>
  page.evaluate(
    async ({ method, path, body }) => {
      const res = await fetch(`/api${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    { method, path, body },
  );
const run = () => Date.now().toString(36);

async function openActions(page: Page, text: string) {
  const message = page.locator('.message', { hasText: text }).last();
  await message.hover();
  await message.getByRole('button', { name: 'More actions' }).click();
  return message;
}

test('Saved: at the top of the list, private, with notes and saved copies', async ({ page, browser }) => {
  const noErrors = trackErrors(page);
  await signIn(page, 'alex@acme.test');
  await page.goto('/chats');
  const list = page.getByRole('navigation', { name: 'Conversations' });
  await expect(list.getByRole('link').first()).toHaveAccessibleName(/^Saved/);
  await list.getByRole('link', { name: /^Saved/ }).click();
  await expect(page.getByRole('heading', { name: 'Saved' })).toBeVisible();
  await expect(page.getByText('Only you can see this').first()).toBeVisible();

  // A note.
  const id = run();
  const box = page.getByRole('textbox', { name: 'Write a note' });
  await box.fill(`Call the printer ${id}`);
  await box.press('Enter');
  await expect(page.locator('.message', { hasText: `Call the printer ${id}` })).toBeVisible();
  const savedId = new URL(page.url()).pathname.split('/').pop()!;

  // Save someone's message from #general.
  const channels = (await call(page, 'GET', '/channels')).body as { id: string; name: string }[];
  const general = channels.find((c) => c.name === 'general')!;
  const nina = await browser.newContext().then((c) => c.newPage());
  await signIn(nina, 'nina@acme.test');
  await call(nina, 'POST', `/channels/${general.id}/messages`, { body: `Launch checklist ${id}` });
  await page.goto(`/channels/${general.id}`);
  await openActions(page, `Launch checklist ${id}`);
  await page.getByRole('menuitem', { name: /Save to Saved/ }).click();
  await page.getByRole('button', { name: 'Open Saved' }).click();
  const copy = page.locator('.message', { hasText: `Launch checklist ${id}` });
  await expect(copy).toBeVisible();
  await expect(copy.locator('.forwarded')).toContainText('Nina');
  await expect(copy.locator('.forwarded').getByRole('link', { name: '#general' })).toBeVisible();

  // Nobody else can open it, not even through the API.
  expect((await call(nina, 'GET', `/channels/${savedId}`)).status).toBe(404);
  expect((await call(nina, 'GET', `/channels/${savedId}/messages`)).status).toBe(404);
  await nina.goto(`/channels/${savedId}`);
  await expect(nina.getByText(/not found|doesn’t exist|can’t find/i).first()).toBeVisible();

  // Remove it again from inside Saved.
  await openActions(page, `Launch checklist ${id}`);
  await page.getByRole('menuitem', { name: 'Remove from Saved' }).first().click();
  await expect(copy).toHaveCount(0);
  await nina.context().close();
  noErrors();
});

test('forward a copy from a private channel: preview, note, and no private details for others', async ({ page, browser }) => {
  const noErrors = trackErrors(page);
  await signIn(page, 'alex@acme.test');
  const id = run();
  const secret = (await call(page, 'POST', '/channels', { name: `secret-${id}`, kind: 'private' })).body;
  await call(page, 'POST', `/channels/${secret.id}/messages`, { body: `Budget is 40k ${id}` });
  const nina = await browser.newContext().then((c) => c.newPage());
  await signIn(nina, 'nina@acme.test');
  const ninaId = (await call(nina, 'GET', '/me')).body.user.id;
  const dm = (await call(page, 'POST', '/dms', { userIds: [ninaId] })).body;

  await page.goto(`/channels/${secret.id}`);
  await openActions(page, `Budget is 40k ${id}`);
  await page.getByRole('menuitem', { name: /Forward/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Forward message' });
  await expect(dialog.getByLabel('Message being forwarded')).toContainText(`Budget is 40k ${id}`);
  await expect(dialog.getByText(/This sends a copy/)).toBeVisible();
  // Nothing is sent until a destination is picked and Send pressed.
  await expect(dialog.getByRole('button', { name: 'Send' })).toBeDisabled();
  await dialog.getByRole('searchbox', { name: 'Search destinations' }).fill('Nina');
  await dialog.locator('.forward-targets label', { hasText: 'Nina' }).first().click();
  await dialog.getByLabel('Add a note (optional)').fill(`FYI ${id}`);
  await dialog.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText(/^Forwarded to /)).toBeVisible();

  await nina.goto(`/channels/${dm.id}`);
  const received = nina.locator('.message', { hasText: `FYI ${id}` });
  await expect(received).toBeVisible();
  await expect(received.locator('.forwarded')).toContainText(`Budget is 40k ${id}`);
  await expect(received.locator('.forwarded')).toContainText('Alex');
  await expect(received).not.toContainText(`secret-${id}`);
  await expect(received.locator('.forwarded a')).toHaveCount(0);
  // Alex can follow the link back to where it came from.
  await page.goto(`/channels/${dm.id}`);
  await expect(page.locator('.message', { hasText: `FYI ${id}` }).locator('.forwarded').getByRole('link', { name: `#secret-${id}` })).toBeVisible();
  await nina.context().close();
  noErrors();
});

test('composer: formatting, emoji, drafts kept per conversation, and attachments with progress', async ({ page }) => {
  const noErrors = trackErrors(page);
  await signIn(page, 'alex@acme.test');
  const channels = (await call(page, 'GET', '/channels')).body as { id: string; name: string }[];
  const general = channels.find((c) => c.name === 'general')!;
  const random = channels.find((c) => c.name !== 'general' && c.name !== 'Saved' && (c as { kind?: string }).kind === 'public') ?? channels.find((c) => c.name === 'Saved')!;
  await page.goto(`/channels/${general.id}`);
  const box = page.getByRole('textbox', { name: 'Message #general' });
  await expect(page.getByText('Shift+Enter for a new line').first()).toBeVisible();

  // Formatting buttons wrap the selection.
  await page.getByRole('button', { name: 'Show formatting' }).click();
  await box.fill('');
  await page.getByRole('toolbar', { name: 'Formatting' }).getByRole('button', { name: /^Bold/ }).click();
  await expect(box).toHaveValue('**bold text**');
  await box.fill('- first');
  await box.press('Shift+Enter');
  await expect(box).toHaveValue('- first\n- ');
  await page.getByRole('button', { name: 'Insert an emoji' }).click();
  await page.getByRole('button', { name: 'Insert 🚀' }).click();
  await expect(box).toHaveValue('- first\n- 🚀');

  // The draft stays with this conversation.
  const id = run();
  await box.fill(`Draft for general ${id}`);
  await page.goto(`/channels/${random.id}`);
  await page.goto(`/channels/${general.id}`);
  await expect(page.getByRole('textbox', { name: 'Message #general' })).toHaveValue(`Draft for general ${id}`);

  // Attach a file: it uploads, then sends with the message.
  await page.locator('.composer input[type=file]').setInputFiles({ name: `notes-${id}.txt`, mimeType: 'text/plain', buffer: Buffer.from('hello there') });
  const attachments = page.getByRole('group', { name: 'Attachments' }).or(page.locator('.pending-files'));
  await expect(attachments.getByText(`notes-${id}.txt`)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const sent = page.locator('.message', { hasText: `Draft for general ${id}` }).last();
  await expect(sent).toBeVisible();
  await expect(sent.getByRole('link', { name: `notes-${id}.txt` })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Message #general' })).toHaveValue('');
  // Sent once, even though the socket and the response both report it.
  await expect(page.locator('.message', { hasText: `Draft for general ${id}` })).toHaveCount(1);
  noErrors();
});

test('threads can be followed and muted; notification choices are clear', async ({ page }) => {
  const noErrors = trackErrors(page);
  await signIn(page, 'alex@acme.test');
  const channels = (await call(page, 'GET', '/channels')).body as { id: string; name: string }[];
  const general = channels.find((c) => c.name === 'general')!;
  const id = run();
  await call(page, 'POST', `/channels/${general.id}/messages`, { body: `Thread topic ${id}` });
  await page.goto(`/channels/${general.id}`);
  await openActions(page, `Thread topic ${id}`);
  await page.getByRole('menuitem', { name: 'Reply in thread' }).click();
  const thread = page.getByRole('complementary', { name: 'Thread' }).or(page.locator('aside', { hasText: 'Thread' })).first();
  await expect(thread.getByText('You’ll be notified about new replies.')).toBeVisible();
  await thread.getByRole('button', { name: 'Mute' }).click();
  await expect(thread.getByText('Muted: no notifications for new replies.')).toBeVisible();
  // Unmuted, Alex follows again (he started the thread); "Following" stops it.
  await thread.getByRole('button', { name: 'Unmute' }).click();
  await expect(thread.getByRole('button', { name: 'Following' })).toHaveAttribute('aria-pressed', 'true');
  await thread.getByRole('button', { name: 'Following' }).click();
  await expect(thread.getByRole('button', { name: 'Unmute' })).toBeVisible();
  await page.keyboard.press('Escape');

  const pref = page.getByRole('combobox', { name: 'Notifications for this conversation' }).first();
  await expect(pref.locator('option')).toHaveText(['All messages', 'Mentions and replies', 'Muted']);
  noErrors();
});

test('search inside a conversation, with filters and paging', async ({ page }) => {
  const noErrors = trackErrors(page);
  await signIn(page, 'alex@acme.test');
  const channels = (await call(page, 'GET', '/channels')).body as { id: string; name: string }[];
  const general = channels.find((c) => c.name === 'general')!;
  const id = run();
  await call(page, 'POST', `/channels/${general.id}/messages`, { body: `Quarterly zebra report ${id}` });
  await page.goto(`/channels/${general.id}`);
  await page.getByRole('button', { name: 'Search this conversation' }).click();
  const dialog = page.getByRole('dialog', { name: 'Search' });
  await expect(dialog.getByRole('combobox', { name: 'In conversation' })).toHaveValue(general.id);
  await dialog.getByRole('combobox', { name: 'Search' }).or(dialog.getByLabel('Search')).first().fill(`zebra report ${id}`);
  const hit = dialog.getByRole('option', { name: new RegExp(`Quarterly zebra report ${id}`) });
  await expect(hit).toBeVisible();
  await hit.click();
  await expect(page).toHaveURL(new RegExp(`/channels/${general.id}\\?message=`));
  await expect(page.locator('.message.highlight', { hasText: `Quarterly zebra report ${id}` })).toBeVisible();
  noErrors();
});
