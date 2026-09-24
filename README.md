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
| **Clients** (8, 11) | Responsive React web app: sidebar navigation on desktop, bottom navigation on mobile, ⌘K global search, dark mode, keyboard and screen-reader-friendly controls, and an installable web-app manifest |

The AI assistance features in §5.6 are intentionally left out. The spec says they should come after governance is in place.

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

Or with Docker: `docker build -t softex . && docker run -p 4000:4000 -v softex-data:/app/server/data softex`

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4000` | HTTP port |
| `SOFTEX_DATA_DIR` | `server/data` | Database and uploaded files |
| `SOFTEX_MEETING_BASE_URL` | `https://meet.jit.si` | Base URL for generated video meeting links |
| `SOFTEX_MAX_UPLOAD_MB` | `25` | Upload size limit |
| `SOFTEX_SECURE_COOKIES` | `false` | Set to `true` behind HTTPS |

### Checks

```bash
npm test                # server test suite
npm run typecheck       # server + client
```

## Next steps

These follow the spec's release plan and are not built yet: email delivery for invitations and digests (invite links are currently shown to the person who creates them), single sign-on and automated provisioning, a managed video provider, full-text extraction from uploaded files, a real antivirus scanning service (the hook is `scanUpload` in `server/src/routes/knowledge.ts`), PostgreSQL with object storage for multi-instance deployments, a public API and webhooks, and governed AI assistance.
