# SoftEX

SoftEX is a unified workplace app for team communication, projects, documents, meetings and company knowledge. It is built from [`SoftEX_Product_Documentation.md`](SoftEX_Product_Documentation.md) and implements the MVP scope in §7 of that document.

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
| **Ask SoftEX** (5.6) | Ask a question in the search box and get a short answer with numbered citations to the messages, pages, decisions, tasks, files and meetings it used, each linking back to its source. It only draws on what the person asking can open |
| **Insights** (2) | A dashboard for leads and admins that tracks the spec's success measures: weekly active people, task ownership, decisions and status updates per project, meeting follow-through, overdue share, cycle time and notification load. Aggregates only, no individual ranking |
| **Governance** (5.7, 9) | **SCIM 2.0** user provisioning and deprovisioning (Okta, Entra ID and others), **message retention** policies, and a **legal hold** that pauses all automatic deletion |
| **Clients** (8, 11) | Responsive React web app: sidebar navigation on desktop, bottom navigation on mobile, ⌘K global search, dark mode, keyboard and screen-reader-friendly controls, and an installable web app that works offline: the app shell and recently viewed data stay available read-only on poor connections, and cached data is wiped on sign-out |

## Architecture

```
server/   TypeScript + Express 5 API, SQLite (node:sqlite), WebSockets (ws)
  src/db.ts        schema (portable SQL, ready to move to PostgreSQL)
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

Every push to `main` publishes an image to `ghcr.io/zlanquapea/softex` (see *CI/CD* below).

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4000` | HTTP port |
| `SOFTEX_DATA_DIR` | `server/data` | Database and uploaded files |
| `SOFTEX_MEETING_BASE_URL` | `https://meet.jit.si` | Base URL for generated video meeting links |
| `SOFTEX_MAX_UPLOAD_MB` | `25` | Upload size limit |
| `SOFTEX_SECURE_COOKIES` | `false` | Set to `true` behind HTTPS |
| `SOFTEX_PUBLIC_URL` | `http://localhost:4000` | Public address used in email links and the SSO redirect URI |
| `SOFTEX_SMTP_URL` | *(unset)* | e.g. `smtps://user:pass@smtp.example.com:465`. Without it, emails are kept in the admin outbox but not sent |
| `SOFTEX_MAIL_FROM` | `SoftEX <no-reply@softex.local>` | Sender address |
| `SOFTEX_SECRET_KEY` | *(unset)* | Long random string used to encrypt stored secrets. Required for single sign-on |
| `SOFTEX_CLAMAV_HOST` / `SOFTEX_CLAMAV_PORT` | *(unset)* / `3310` | ClamAV daemon for malware scanning of uploads |
| `ANTHROPIC_API_KEY` | *(unset)* | Makes AI assistance available (admins still have to enable it) |
| `SOFTEX_AI_MODEL` | `claude-opus-5` | Claude model used for AI assistance |
| `SOFTEX_ALLOW_PRIVATE_WEBHOOKS` | `false` | Development only: allow webhooks to local addresses |

### Checks

```bash
npm test                # server test suite (permissions, workflows, email, SSO, webhooks, AI governance)
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

- **PostgreSQL and object storage** for running several server instances behind a load balancer. The schema is portable SQL, and all queries go through `server/src/db.ts`.
- **A managed video provider**, following the spec's cost and privacy review. Meeting links use Jitsi by default and can be changed with `SOFTEX_MEETING_BASE_URL`.
- **OCR for scanned images and image-only PDFs**, which today are searchable by file name only.
- **Queued offline writes.** Offline mode is read-only today; messages and edits need a connection.
