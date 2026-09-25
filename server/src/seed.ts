/**
 * Seed a demo workspace through the real HTTP API so the data follows the same
 * validation and permission rules as production use.
 *
 *   npm run seed            # seed server/data/softex.db if it has no users
 *   npm run seed -- --reset # delete the database and uploads first
 */
import { existsSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.SOFTEX_DATA_DIR ?? join(resolve(here, '..'), 'data');
const dbPath = process.env.SOFTEX_DB ?? join(dataDir, 'softex.db');

const databaseUrl = process.env.SOFTEX_DATABASE_URL || undefined;
if (process.argv.includes('--reset')) {
  if (databaseUrl) {
    console.error('--reset only works with the SQLite file. For PostgreSQL, seed an empty database (or a new ?schema=).');
    process.exit(1);
  }
  for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, join(dataDir, 'uploads')]) if (existsSync(p)) rmSync(p, { recursive: true, force: true });
}

const { server, ctx, close } = createApp({ dbPath, databaseUrl, uploadDir: join(dataDir, 'uploads') });
if (await ctx.db.get('SELECT 1 FROM users LIMIT 1')) {
  console.log('Database already has data. Use `npm run seed -- --reset` to start over.');
  await close();
  process.exit(0);
}

await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;

class Client {
  cookie = '';
  async call<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', cookie: this.cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0];
    const data = await res.json();
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${JSON.stringify(data)}`);
    return data as T;
  }
  post = <T = any>(p: string, b: unknown = {}) => this.call<T>('POST', p, b);
  patch = <T = any>(p: string, b: unknown) => this.call<T>('PATCH', p, b);
  get = <T = any>(p: string) => this.call<T>('GET', p);
}

const PASSWORD = 'softex-demo';
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const at = (dayOffset: number, hour: number, minute = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
};
const m = (name: string, id: string) => `@[${name}](${id})`;

const alex = new Client();
const me = await alex.post('/auth/register', { name: 'Alex Parker', email: 'alex@acme.test', password: PASSWORD, workspaceName: 'Acme Studio' });
await alex.patch('/me', { title: 'Head of Product', timezone: 'Europe/London', expertise: ['Product strategy', 'Roadmaps'] });

async function addPerson(name: string, email: string, role: string, profile: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const inv = await alex.post('/admin/invitations', { email, role, ...extra });
  const c = new Client();
  const res = await c.post(`/invitations/${inv.token}/accept`, { name, password: PASSWORD });
  await c.patch('/me', profile);
  return { c, id: res.user.id as string, name };
}

const maya = await addPerson('Maya Singh', 'maya@acme.test', 'lead', { title: 'Brand Lead', timezone: 'Europe/Berlin', expertise: ['Brand', 'Copywriting', 'Figma'] });
const jordan = await addPerson('Jordan Wells', 'jordan@acme.test', 'member', { title: 'Mobile Engineer', timezone: 'America/New_York', expertise: ['React Native', 'TypeScript'] });
const nina = await addPerson('Nina Kaur', 'nina@acme.test', 'member', { title: 'User Researcher', timezone: 'Asia/Kolkata', expertise: ['Interviews', 'Synthesis', 'Accessibility'] });
const leo = await addPerson('Leo Ramos', 'leo@acme.test', 'admin', { title: 'Operations Manager', timezone: 'America/Los_Angeles', expertise: ['Finance', 'Vendors', 'IT'] });

const channels = await alex.get<any[]>('/channels');
const general = channels.find((c) => c.name === 'general');
const announcements = channels.find((c) => c.name === 'announcements');

// Teams
await alex.post('/teams', { name: 'Marketing', description: 'Brand, content and campaigns', memberIds: [maya.id] });
await alex.post('/teams', { name: 'Product', description: 'Product management, design and engineering', memberIds: [jordan.id, nina.id] });
await alex.post('/teams', { name: 'Operations', description: 'People, finance and tools', memberIds: [leo.id] });

// Projects
const brand = await alex.post('/projects', {
  name: 'Brand refresh',
  description: 'Refresh the Acme visual identity and launch messaging ahead of Q4.\n\n**Outcome:** a consistent brand across web, product and sales materials.',
  color: 'purple',
  memberIds: [maya.id, nina.id, jordan.id],
  template: 'product_launch',
  dueDate: day(30),
});
const mobile = await alex.post('/projects', {
  name: 'Mobile app',
  description: 'Ship the first version of the Acme mobile app with offline-friendly task lists.',
  color: 'blue',
  memberIds: [jordan.id, nina.id, maya.id],
  dueDate: day(55),
});
const research = await nina.c.post('/projects', {
  name: 'User research',
  description: 'Continuous discovery: monthly interviews and a shared insight library.',
  color: 'orange',
  memberIds: [me.user.id, maya.id],
});
const leadership = await alex.post('/projects', {
  name: 'Leadership planning',
  description: 'Private planning space for budget and hiring.',
  color: 'gold',
  visibility: 'private',
  memberIds: [leo.id],
  createChannel: true,
});

// Brand tasks
const brandTasks = await alex.get<any[]>(`/tasks?projectId=${brand.id}`);
await alex.patch(`/tasks/${brandTasks[0].id}`, { status: 'done' });
await alex.patch(`/tasks/${brandTasks[1].id}`, { status: 'done', ownerId: nina.id });
await alex.patch(`/tasks/${brandTasks[2].id}`, { status: 'in_progress', ownerId: maya.id, dueDate: day(2) });
const messaging = await alex.patch(`/tasks/${brandTasks[3].id}`, { title: 'Finalize Q4 launch messaging', ownerId: me.user.id, dueDate: day(0), priority: 'high', status: 'in_progress' });
await alex.patch(`/tasks/${brandTasks[4].id}`, { ownerId: maya.id, dueDate: day(12), reviewerId: me.user.id });
await alex.post(`/tasks/${messaging.id}/checklist`, { text: 'Draft headline options' });
await alex.post(`/tasks/${messaging.id}/checklist`, { text: 'Review with Maya' });
await alex.post(`/tasks/${messaging.id}/checklist`, { text: 'Legal sign-off' });
const logo = await maya.c.post('/tasks', { title: 'Export final logo files for web and print', projectId: brand.id, ownerId: maya.id, dueDate: day(-1), priority: 'high' });
await maya.c.post('/tasks', { title: 'Update email templates with new palette', projectId: brand.id, ownerId: jordan.id, dueDate: day(6) });
const guidelines = await maya.c.post('/tasks', {
  title: 'Publish brand guidelines page',
  projectId: brand.id,
  ownerId: maya.id,
  dueDate: day(8),
  status: 'blocked',
});
await maya.c.patch(`/tasks/${guidelines.id}`, { blockedReason: 'Waiting on final logo exports' });
await maya.c.post(`/tasks/${guidelines.id}/dependencies`, { dependsOnId: logo.id });

// Mobile tasks
const nav = await jordan.c.post('/tasks', { title: 'Review mobile navigation prototype', projectId: mobile.id, ownerId: me.user.id, dueDate: day(0), priority: 'medium' });
await jordan.c.post('/tasks', { title: 'Implement offline task sync', projectId: mobile.id, ownerId: jordan.id, dueDate: day(9), status: 'in_progress', priority: 'high' });
await jordan.c.post('/tasks', { title: 'Push notification permissions flow', projectId: mobile.id, ownerId: jordan.id, dueDate: day(14) });
const beta = await jordan.c.post('/tasks', { title: 'Set up beta distribution', projectId: mobile.id, ownerId: leo.id, dueDate: day(-2), status: 'blocked' });
await jordan.c.patch(`/tasks/${beta.id}`, { blockedReason: 'Need a company developer account — see purchase request' });
await jordan.c.post('/tasks', { title: 'Accessibility audit of core screens', projectId: mobile.id, ownerId: nina.id, dueDate: day(20) });
await jordan.c.post(`/projects/${mobile.id}/milestones`, { name: 'Internal beta', dueDate: day(21) });
await jordan.c.post(`/projects/${mobile.id}/milestones`, { name: 'Public launch', dueDate: day(55) });
await alex.patch(`/projects/${mobile.id}`, { health: 'at_risk' });
await jordan.c.post(`/projects/${mobile.id}/updates`, {
  health: 'at_risk',
  body: 'Offline sync is harder than expected — conflict handling needs another week. Beta distribution is blocked on the developer account purchase.',
});
await jordan.c.post(`/projects/${mobile.id}/risks`, { title: 'Offline sync conflicts corrupt local data', impact: 'high', mitigation: 'Server wins by default; add conflict log', ownerId: jordan.id });

// Research tasks
await nina.c.post('/tasks', { title: 'Share research synthesis with the team', projectId: research.id, ownerId: nina.id, dueDate: day(0) });
await nina.c.post('/tasks', { title: 'Recruit 6 participants for October interviews', projectId: research.id, ownerId: nina.id, dueDate: day(5), recurrence: 'monthly' });

// Personal task and private project task
await alex.post('/tasks', { title: 'Prepare 1:1 notes for Maya', dueDate: day(1) });
await alex.post('/tasks', { title: 'Draft 2027 hiring plan', projectId: leadership.id, ownerId: me.user.id, dueDate: day(10) });

// Conversations
const brandChannel = brand.channel_id;
await maya.c.post(`/channels/${brandChannel}/messages`, { body: `Morning! The updated logo direction is in Figma. ${m('Alex Parker', me.user.id)} can you take a look before 2pm?` });
const proposal = await nina.c.post(`/channels/${brandChannel}/messages`, {
  body: 'From the interviews: customers read our current tagline as "enterprise-only". Proposal: lead with **"Work, connected."** instead.',
});
await jordan.c.post(`/channels/${brandChannel}/messages`, { body: '+1, it also fits much better in the app header.', parentId: proposal.id });
await alex.post(`/channels/${brandChannel}/messages`, { body: 'Agreed — let’s go with it and update the launch copy.', parentId: proposal.id });
await alex.post(`/messages/${proposal.id}/reactions`, { emoji: '🎉' });
await maya.c.post(`/messages/${proposal.id}/reactions`, { emoji: '👍' });
await alex.post('/decisions', { title: 'Lead Q4 messaging with “Work, connected.”', rationale: 'Interview feedback showed the old tagline read as enterprise-only.', messageId: proposal.id });
await alex.post(`/messages/${proposal.id}/pin`);
const copyMsg = await maya.c.post(`/channels/${brandChannel}/messages`, { body: 'Someone needs to update the website hero copy with the new line.' });
await alex.post(`/messages/${copyMsg.id}/task`, { ownerId: maya.id, dueDate: day(3) });

await jordan.c.post(`/channels/${mobile.channel_id}/messages`, { body: 'Nav prototype v3 is ready for review — bottom tabs for Home, Inbox, Chats, My work and Search, per the spec.' });
await nina.c.post(`/channels/${mobile.channel_id}/messages`, { body: `${m('Jordan Wells', jordan.id)} the tab labels tested well. One participant missed the search tab, maybe add a label?` });

await leo.c.post(`/channels/${general.id}/messages`, { body: 'Welcome to Küü, everyone 👋 Use **#announcements** for company notices and project channels for day-to-day work.' });
await nina.c.post(`/channels/${general.id}/messages`, { body: 'Lunch & learn on Friday: “What customers told us in September”. Bring questions!' });
await alex.post(`/channels/${announcements.id}/messages`, { body: '**Office closed Monday** for the public holiday. Urgent issues: page Leo via Küü with the *Urgent* flag.' });

const dm = await maya.c.post('/dms', { userIds: [me.user.id] });
await maya.c.post(`/channels/${dm.id}/messages`, { body: 'Do you have 10 minutes after the sync to go through the launch copy?' });

// Meetings
const sync = await alex.post('/meetings', {
  title: 'Weekly product sync',
  startsAt: at(0, 16),
  durationMin: 45,
  projectId: mobile.id,
  participantIds: [jordan.id, nina.id, maya.id],
  agenda: '1. Beta blockers\n2. Offline sync plan\n3. Research highlights',
});
await jordan.c.post(`/meetings/${sync.id}/respond`, { response: 'accepted' });
await maya.c.post('/meetings', {
  title: 'Design critique',
  startsAt: at(1, 14),
  durationMin: 60,
  projectId: brand.id,
  location: 'Studio 2',
  video: false,
  participantIds: [me.user.id, nina.id],
  agenda: 'Logo lockups and colour contrast checks.',
});
const kickoff = await alex.post('/meetings', {
  title: 'Brand refresh kickoff',
  startsAt: at(-3, 10),
  durationMin: 30,
  projectId: brand.id,
  participantIds: [maya.id, nina.id],
  agenda: 'Goals, scope, owners.',
});
await alex.patch(`/meetings/${kickoff.id}`, { notes: '- Scope: web, product, sales deck\n- Maya owns the visual system\n- Nina to bring interview insights' });
await alex.post('/decisions', { title: 'Launch the refreshed brand on the website first', meetingId: kickoff.id });
await alex.post('/tasks', { title: 'Collect current sales deck versions', meetingId: kickoff.id, projectId: brand.id, ownerId: nina.id, dueDate: day(4) });
await alex.post(`/meetings/${kickoff.id}/end`);

// Knowledge
await leo.c.post('/pages', {
  title: 'Travel and expense policy',
  status: 'approved',
  reviewDate: day(90),
  body: `# Travel and expense policy

Applies to all employees and contractors travelling on Acme business.

## Booking
- Book **economy** for flights under 6 hours.
- Use the company travel account; personal bookings need prior approval.

## Expenses
1. Submit receipts within 30 days.
2. Meals up to the local daily allowance are reimbursed.
3. Anything over £500 needs an approval request in Küü (**Requests → Purchase**).

> Questions? Ask the page owner from the button above.`,
});
await alex.post('/pages', {
  title: 'How we use Küü',
  status: 'approved',
  reviewDate: day(-2),
  body: `# How we use Küü

- **Channels** for team and project discussion; **Chats** for quick 1:1s.
- Every task has **one owner** and a due date.
- Record decisions where they happen: message menu → *Record decision*.
- Post a project status update every Friday.
- Use focus time freely — urgent messages still get through.`,
});
await nina.c.post('/pages', {
  title: 'September interview insights',
  projectId: research.id,
  body: '## Top themes\n\n1. Customers want fewer tools, not more features.\n2. Search is the #1 frustration in current tools.\n3. Managers want status without meetings.',
});

// Requests, check-ins, onboarding
await jordan.c.post('/requests', { kind: 'purchase', title: 'Apple developer account (£79/yr)', details: 'Needed for beta distribution of the mobile app.', approverId: me.user.id });
await nina.c.post('/checkins', { projectId: research.id, done: 'Finished synthesis for 8 interviews', next: 'Share highlights at the sync', blockers: '' });
await jordan.c.post('/checkins', { projectId: mobile.id, done: 'Nav prototype v3', next: 'Offline sync conflict handling', blockers: 'Developer account for beta builds' });
for (const item of [
  { title: 'Complete your profile', description: 'Add your title, time zone and expertise so people can find you.', link: '/settings' },
  { title: 'Read “How we use Küü”', description: 'Our working agreements in five bullet points.', link: '/knowledge' },
  { title: 'Turn on multifactor authentication', description: 'Settings → Security.', link: '/settings?tab=security' },
  { title: 'Say hello in #general', link: `/channels/${general.id}` },
]) {
  await alex.post('/onboarding/items', item);
}

// A guest from a client, limited to one channel.
const client = await alex.post('/channels', { name: 'client-northwind', kind: 'private', topic: 'Shared with Northwind (external guest)', memberIds: [maya.id] });
await addPerson('Casey Morgan', 'casey@northwind.test', 'guest', { title: 'Marketing Director, Northwind' }, { channelIds: [client.id], guestDays: 45 });

await new Promise((r) => setTimeout(r, 50));
await close();
console.log(`
Seeded the “Acme Studio” demo workspace.

Sign in with any of these accounts (password: ${PASSWORD}):
  alex@acme.test    Owner
  leo@acme.test     Admin
  maya@acme.test    Team lead
  jordan@acme.test  Member
  nina@acme.test    Member
  casey@northwind.test  Guest (sees only #client-northwind)
`);
