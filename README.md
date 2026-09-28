# Küü

Küü is a unified workplace app for team communication, projects, documents, meetings and company knowledge. It is built from [`SoftEX_Product_Documentation.md`](SoftEX_Product_Documentation.md), written under the product's working name, SoftEX, and implements the MVP scope in §7 of that document.

**Brand.** Küü, *Work moves forward together.* Terracotta `#B5461B` and cream `#FEF6EB`, with peach `#EA9C5E` for the dots. The logo, icons and link-preview image are in [`client/public/brand`](client/public/brand), and the colours are the `--brand-*` and `--accent*` variables at the top of `client/src/styles.css`. Server settings keep their `SOFTEX_` prefix, and internal names (database file, cookie, package names) are unchanged, so existing deployments keep working after the rename.

## What's included

| Area (spec §) | Features |
| --- | --- |
| **Communication** (5.1) | Public, private and announcement channels; direct and group messages; threads; @mentions; reactions; pins; saved items; Markdown; file attachments; typing indicators; edit/delete governed by workspace policy; announcement acknowledgement tracking; urgent messages; convert a message into a task; record a decision from a message |
| **Tasks & projects** (5.2) | Tasks with one accountable owner, reviewer, collaborators, status, priority, due date, checklist, comments, attachments, subtasks, dependencies (with cycle detection and handoff notifications), recurrence, and an activity log. Project list and board views, milestones, templates, health status updates, a rule-based weekly summary draft, a decision log and a risk register. **My work** shows overdue, today, blocked, for-review, upcoming and later items |
| **Knowledge & files** (5.3) | Markdown knowledge pages with owners, approval status, review dates, version history and restore, plus related discussions. File upload with versions, labels, previews, external links, archive and restore. Uploads are blocked for executable types and malware test signatures |
| **Meetings** (5.4) | Schedule from anywhere, including a channel or project; agenda; time-zone-aware display; RSVP; video link (Jitsi by default, configurable); notes; decisions; follow-up tasks; end-of-meeting summary notifications; `.ics` calendar export |
| **Focus & operations** (5.5) | Home answers "what matters today, what's blocked, what changed", and can be customized. Also: Inbox with filters and a 24-hour digest; focus time and quiet hours (urgent messages still get through); per-channel notification settings; daily check-ins; an onboarding checklist; requests and approvals; a directory with teams, time zones, working hours and expertise |
| **Administration** (5.7) | Invitations (members, leads, admins, and guests with an expiry date and a sponsor); roles; deactivation (which revokes sessions immediately); teams; workspace policies; required MFA (TOTP); an audit log; JSON data export |
| **Security** (3, 9) | Central authorization (`server/src/access.ts`) applied to every route **and** to search, activity feeds, notifications and exports. Also: scrypt password hashing, hashed session tokens in HttpOnly cookies, login rate limiting, cross-origin write rejection, CSP and security headers, and workspace isolation |
| **Email** (5.5, 5.7) | Invitations (with resend), password reset links, meeting invitations with calendar attachments, cancellations, a morning digest of unread notifications, and urgent-message alerts for people who are offline. Every email goes through a database outbox with retries, visible to admins |
| **Single sign-on** (5.7) | OpenID Connect (Google Workspace, Microsoft Entra ID, Okta, Auth0, Keycloak…) with PKCE, per-workspace email domain, automatic account creation, and an option to require SSO (owners keep a password fallback) |
| **Public API & webhooks** (5.7, 12) | Personal API tokens (read-only or read/write, with expiry, rate limits and revocation). HMAC-signed webhooks for task, message, document, meeting, decision and project events, with retries, a delivery log and protection against internal-address targets. See [docs/API.md](docs/API.md) |
| **Files** (5.3, 9) | Full-text search inside uploaded PDF, text, Markdown, CSV, HTML, Word, PowerPoint, Excel and OpenDocument files. Optional ClamAV malware scanning that refuses uploads when the scanner is unreachable |
| **Governed AI** (5.6) | Opt-in thread and meeting summaries, task suggestions a person reviews before anything is created, and weekly project brief drafts, powered by Claude. Off until the server has an API key **and** an admin enables it. It only reads what the requesting person can already open, channels and projects can opt out, and every use is audited without storing content |
| **Planning & automation** (5.2) | **Timeline** (Gantt) per project with drag-to-reschedule and milestones; a **workload** heat map of open work per person per week (with optional hour estimates); **automations** ("when a task moves to review, notify the reviewer") with templates, run logs and loop-proof execution under the creator's access; automatic **deadline reminders** the day before and when overdue |
| **Reminders & send later** (5.1, 5.5) | "Remind me" on any message or task, free-form reminders, and **scheduled messages** that post at a chosen time (checked again for permission at send time). Everything pending is listed under **Later** |
| **Ask Küü** (5.6) | Ask a question in the search box and get a short answer with numbered citations to the messages, pages, decisions, tasks, files and meetings it used, each linking back to its source. It only draws on what the person asking can open |
| **Insights** (2) | A dashboard for leads and admins that tracks the spec's success measures: weekly active people, task ownership, decisions and status updates per project, meeting follow-through, overdue share, cycle time and notification load. Aggregates only, no individual ranking |
| **Governance** (5.7, 9) | **SCIM 2.0** user provisioning and deprovisioning (Okta, Entra ID and others), **message retention** policies, and a **legal hold** that pauses all automatic deletion |
| **Hosted service (SaaS)** | With `SOFTEX_MODE=saas`: self-service sign-up with email confirmation, a 30-day Business trial, a permanent **Free** plan (10 members, core features) and paid **Standard** and **Business** plans priced per member. Usage limits on members, storage and AI; payment by Orange Money, MTN Mobile Money or bank transfer, confirmed by the operator; renewal and trial reminders; a public pricing page with Liberian-dollar amounts; an **operator console** to confirm payments, adjust plans and suspend abuse; and self-service workspace and account deletion. See [docs/DEPLOY_RAILWAY.md](docs/DEPLOY_RAILWAY.md) |
| **Devices & calendars** (5.4, 5.5, 9) | **Push notifications** on phones and computers when Küü is closed (mentions, assignments, urgent messages; they follow quiet hours and focus time, except urgent messages). **Where you're signed in**: see every device, sign one out or sign out everywhere else. A private **calendar subscription link** that puts your meetings in Google Calendar, Outlook or Apple Calendar |
| **Import** (7) | **Bulk invitations** from a pasted list or a CSV, and **task import** into a project from a Trello, Asana, Jira, Monday or spreadsheet CSV, with a preview first. Assignees get one summary notification |
| **Backups** (7, 9) | Automatic daily SQLite backups: a consistent snapshot, checked with an integrity check, compressed and kept in S3 storage (or the backup folder); the newest 7 are kept. Operators can back up now, download a backup, and restore one by setting `SOFTEX_RESTORE_BACKUP` |
| **Clients** (8, 11) | Responsive React web app: sidebar navigation on desktop, bottom navigation on mobile, ⌘K global search, dark mode, keyboard and screen-reader-friendly controls, and an installable web app that works offline: the app shell and recently viewed data stay available read-only on poor connections, and cached data is wiped on sign-out |

## Architecture

```
server/   TypeScript + Express 5 API, SQLite (node:sqlite) or PostgreSQL, WebSockets (ws)
  src/db.ts        schema and the async data layer (SQLite and PostgreSQL engines)
  src/storage.ts   uploaded files on local disk or S3-compatible storage
  src/realtime.ts  WebSocket hub; shares events between servers over PostgreSQL
  src/access.ts    every permission rule in one place
  src/routes/*     auth, channels, projects, tasks, knowledge, meetings, workspace, home/search
  test/*           permission, isolation and workflow tests (vitest + supertest)
client/   React 19 + Vite + React Router single-page app
prototype/  the original static home-screen prototype
```

Messages are always saved to the database before they are pushed over the WebSocket. If a client reconnects, it refetches from the API, so nothing sent while it was offline is lost.

## Getting started

Requires **Node.js 22.5+** (for the built-in `node:sqlite`).

```bash
npm install
npm run seed            # creates a demo "Acme Studio" workspace (add -- --reset to start over)
npm run dev             # API on :4000, web app on http://localhost:5173
```

Demo accounts (password `softex-demo`): `alex@acme.test` (owner), `leo@acme.test` (admin), `maya@acme.test` (lead), `jordan@acme.test`, `nina@acme.test`, and `casey@northwind.test` (a guest who can only see one shared channel). You can also register a new workspace from the sign-in page.

### Production

```bash
npm run build
npm start               # serves the API and the built web app on :4000
```

Or with Docker Compose, which bundles ClamAV and a local test inbox (Mailpit at http://localhost:8025):

```bash
SOFTEX_SECRET_KEY=$(openssl rand -hex 32) docker compose up -d
```

**Railway:** see [docs/DEPLOY_RAILWAY.md](docs/DEPLOY_RAILWAY.md) for a step-by-step guide (`railway.json` is included).

Every push to `main` publishes an image to `ghcr.io/zlanquapea/softex` (see *CI/CD* below).

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4000` | HTTP port |
| `SOFTEX_DATABASE_URL` | *(unset)* | `postgres://…` to use PostgreSQL instead of SQLite (required to run several servers). Add `?schema=name` to keep the tables in their own schema |
| `SOFTEX_DB_POOL_SIZE` | `10` | PostgreSQL connections per server |
| `SOFTEX_S3_BUCKET` | *(unset)* | Store uploaded files in S3-compatible storage (AWS S3, Cloudflare R2, Backblaze B2, MinIO) instead of `SOFTEX_DATA_DIR`. Also set `SOFTEX_S3_ENDPOINT`, `SOFTEX_S3_REGION`, `SOFTEX_S3_ACCESS_KEY_ID`, `SOFTEX_S3_SECRET_ACCESS_KEY`, and optionally `SOFTEX_S3_FORCE_PATH_STYLE` and `SOFTEX_S3_PREFIX` |
| `SOFTEX_COMPANY_NAME` / `SOFTEX_COMPANY_ADDRESS` / `SOFTEX_LEGAL_EMAIL` | *(unset)* | Business details shown on the website and in the Terms of Service and Privacy Policy (SaaS mode) |
| `SOFTEX_DATA_DIR` | `server/data` | Database and uploaded files |
| `SOFTEX_MEETING_BASE_URL` | `https://meet.jit.si` | Base URL for generated video meeting links |
| `SOFTEX_MAX_UPLOAD_MB` | `100` | Upload size limit (phone videos are often 30–100 MB) |
| `SOFTEX_SECURE_COOKIES` | `false` | Set to `true` behind HTTPS |
| `SOFTEX_PUBLIC_URL` | `http://localhost:4000` | Public address used in email links and the SSO redirect URI |
| `SOFTEX_SMTP_URL` | *(unset)* | e.g. `smtps://user:pass@smtp.example.com:465`. Without it, emails are kept in the admin outbox but not sent |
| `SOFTEX_MAIL_FROM` | `Küü <no-reply@softex.local>` | Sender address |
| `SOFTEX_SECRET_KEY` | *(unset)* | Long random string used to encrypt stored secrets. Required for single sign-on |
| `SOFTEX_CLAMAV_HOST` / `SOFTEX_CLAMAV_PORT` | *(unset)* / `3310` | ClamAV daemon for malware scanning of uploads |
| `ANTHROPIC_API_KEY` | *(unset)* | Makes AI assistance available (admins still have to enable it) |
| `SOFTEX_AI_MODEL` | `claude-opus-5` | Claude model used for AI assistance |
| `SOFTEX_REGISTRATION` | `open` | Who may create a workspace from the sign-up page: `open` (anyone), `first` (only the first person on a new server) or `closed` |
| `SOFTEX_TRUST_PROXY` | `loopback` | Express *trust proxy* setting. Behind a hosting proxy (Railway, Render, a load balancer) set a hop count such as `1` so rate limits and the audit log see real client addresses |
| `SOFTEX_MODE` | `self_hosted` | `saas` turns on plans, trials, usage limits, email confirmation, billing and the operator console |
| `SOFTEX_OPERATOR_EMAILS` | *(unset)* | Comma-separated emails of the people who run the service (SaaS mode). They must use MFA |
| `SOFTEX_PRICE_STANDARD` / `SOFTEX_PRICE_BUSINESS` | `1.50` / `3` | Price per member per month in USD (SaaS mode) |
| `SOFTEX_TRIAL_DAYS` / `SOFTEX_TRIAL_AI_REQUESTS` | `30` / `100` | Length of the Business trial, and AI requests allowed during it |
| `SOFTEX_LRD_PER_USD` | *(unset)* | Optional exchange rate to show prices in Liberian dollars too |
| `SOFTEX_PAYMENT_INSTRUCTIONS` | *(unset)* | Markdown shown to customers when they pay (mobile money numbers, bank details); `\n` for new lines |
| `SOFTEX_SUPPORT_EMAIL` | *(unset)* | Billing contact shown to customers |
| `SOFTEX_ALLOW_PRIVATE_WEBHOOKS` | `false` | Development only: allow webhooks to local addresses |
| `SOFTEX_BACKUPS` | `on` | `off` turns off automatic SQLite backups |
| `SOFTEX_BACKUP_HOURS` / `SOFTEX_BACKUP_KEEP` | `24` / `7` | How often to back up, and how many backups to keep |
| `SOFTEX_BACKUP_DIR` | `SOFTEX_DATA_DIR/backups` | Where backups go when files aren't in S3 (with S3 they go to the bucket under `backups/`) |
| `SOFTEX_RESTORE_BACKUP` | *(unset)* | A backup file name to restore on start-up (the current database is kept beside it). Remove it after the restore |
| `SOFTEX_PUSH` | `on` | `off` turns off push notifications |
| `SOFTEX_VAPID_PUBLIC_KEY` / `SOFTEX_VAPID_PRIVATE_KEY` / `SOFTEX_VAPID_SUBJECT` | *(generated)* | Web Push keys. Without them, a key pair is generated once and stored in the database (encrypted with `SOFTEX_SECRET_KEY` when set) |

### Checks

```bash
npm test                # server test suite (permissions, workflows, email, SSO, webhooks, AI governance)
SOFTEX_TEST_DATABASE_URL=postgres://user:pass@localhost:5432/db npm test   # the same suite on PostgreSQL, plus multi-server tests
npm run typecheck       # server + client
npm run build && npm run test:e2e   # browser smoke tests (Playwright)
```

## CI/CD

GitHub Actions run on every pull request and on `main`:

- **CI** (`.github/workflows/ci.yml`): type checks, server tests on Node 22 and 24, production build, and Playwright browser smoke tests on desktop and mobile.
- **Security** (`security.yml`, also weekly):
  - `npm audit` (fails on high or critical advisories in production dependencies)
  - CodeQL static analysis
  - Dependency review on pull requests (fails on high-severity advisories and disallowed licenses)
  - gitleaks secret scanning
- **Container** (`docker.yml`):
  - Builds the image, starts it and checks `/api/health`.
  - Scans it with Trivy. Findings go to the Security tab, and the job fails on critical vulnerabilities.
  - On `main` and on `v*` tags, publishes to GitHub Container Registry with an SBOM and signed build provenance.
  - An optional `DEPLOY_HOOK_URL` secret (in a `production` environment) triggers your hosting provider's deploy hook.
- **Dependabot** keeps npm packages, Actions and the base image up to date.

See [SECURITY.md](SECURITY.md) for how to report vulnerabilities.

## Next steps

- **Automatic payment confirmation** through the MTN MoMo or Orange Money merchant APIs, or card payments through a processor available to your company. Today the operator confirms each mobile money or bank payment by hand.
- **A managed video provider**, following the spec's cost and privacy review. Meeting links use Jitsi by default and can be changed with `SOFTEX_MEETING_BASE_URL`.
- **OCR for scanned images and image-only PDFs**, which today are searchable by file name only.
- **Queued offline writes.** Offline mode is read-only today; messages and edits need a connection.
