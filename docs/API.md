# Küü API and webhooks

Küü has a JSON REST API under `/api`. The web app uses the same API, so anything you can do in the app you can script.

## Authentication

Create a **personal API token** in *Settings → API tokens*. Send it as a bearer token:

```bash
curl -H "Authorization: Bearer sx_…" https://softex.example.com/api/my-work
```

- A token acts **as you**, with exactly your permissions. It can never see private channels, projects or files that you can't see.
- Read-only tokens can only make `GET` requests. Read-and-write tokens can also create and update records.
- Tokens can't manage your account (`/api/me/*`) or integrations (`/api/integrations/*`).
- The limit is 600 requests per minute per token. Revoke a token at any time. Revoked, expired and deactivated users' tokens stop working immediately.

Errors use standard HTTP status codes with a JSON body: `{"error": "message", "details": …}`.

## Common endpoints

| Method & path | Purpose |
| --- | --- |
| `GET /api/me` | Your profile, workspace and role |
| `GET /api/home` | Today's focus, blocked work, meetings, mentions, decisions, recent changes |
| `GET /api/my-work` | Your tasks grouped into overdue, today, upcoming, blocked, review and later |
| `GET /api/search?q=…&type=all\|messages\|tasks\|pages\|files\|projects\|decisions\|meetings\|people` | Permission-aware search, including text inside uploaded files |
| `GET /api/projects` · `POST /api/projects` · `GET/PATCH /api/projects/:id` | Projects |
| `GET /api/tasks?projectId=…` · `POST /api/tasks` · `GET/PATCH/DELETE /api/tasks/:id` | Tasks (`title`, `projectId`, `ownerId`, `dueDate` as YYYY-MM-DD, `priority`, `status`) |
| `POST /api/tasks/:id/comments` · `POST /api/tasks/:id/checklist` | Task comments and checklist items |
| `GET /api/channels` · `GET /api/channels/:id/messages` · `POST /api/channels/:id/messages` | Channels and messages (`body`, optional `parentId` for thread replies) |
| `POST /api/messages/:id/task` · `POST /api/decisions` | Turn a message into a task, or record a decision |
| `GET /api/pages` · `POST /api/pages` · `GET/PATCH /api/pages/:id` | Knowledge pages (Markdown `body`) |
| `GET /api/files` · `POST /api/files` (multipart `file`) · `GET /api/files/:id/download` | Files |
| `GET /api/meetings?range=upcoming\|past` · `POST /api/meetings` · `GET /api/meetings/:id/ics` | Meetings and calendar invites |
| `GET /api/people` · `GET /api/teams` | Directory |
| `GET /api/notifications` | Inbox |
| `GET /api/export` | Everything you can access, as JSON |
| `GET /api/workload?weeks=4&projectId=…&teamId=…` | Open tasks per person per due week |
| `GET/POST /api/projects/:id/automations` · `PATCH/DELETE /api/automations/:id` · `GET /api/automations/:id/runs` | Project automations and their run log |
| `GET/POST /api/reminders` · `DELETE /api/reminders/:id` | Your reminders (`remindAt` ISO time, optional `note`, `messageId` or `taskId`) |
| `GET /api/scheduled-messages` · `POST /api/channels/:id/scheduled-messages` · `PATCH/DELETE /api/scheduled-messages/:id` | Messages to send later (`body`, `sendAt`, optional `parentId`) |
| `POST /api/ai/ask` | Ask a question and get an answer with cited sources (when AI is enabled) |
| `GET /api/admin/insights` | Workspace success measures (leads and admins) |
| `GET /api/public/plans` | Plans and prices (no sign-in needed) |
| `GET /api/billing` · `POST /api/billing/payments` · `DELETE /api/billing/payments/:id` | Current plan, usage and payments; submit a mobile money or bank payment for confirmation (admins, SaaS mode) |
| `DELETE /api/admin/workspace` | Permanently delete the workspace (owner; `password`, `confirmName`, and `code` when MFA is on) |
| `DELETE /api/me` | Delete your own account (`password`, and `code` when MFA is on) |
| `POST /api/projects/:id/import/tasks` | Import tasks from CSV text (`csv`; `dryRun: true` previews without saving). Recognises columns such as Title/Name, Description, Status/List, Priority, Due date, Start date, Assignee (email or name) and Estimate; up to 500 rows |
| `POST /api/admin/invitations/bulk` | Invite every email address found in `text` (a list or CSV) with one `role`; up to 200. Returns `invited` and `skipped` |

Browser-only (not available to API tokens):

| Method & path | Purpose |
| --- | --- |
| `GET /api/me/sessions` · `DELETE /api/me/sessions/:id` · `POST /api/me/sessions/revoke-others` | Where you're signed in |
| `GET/POST/DELETE /api/me/calendar-feed` | Your private calendar subscription link (the link is only returned by `POST`, which also replaces any earlier link). Calendar apps read it at `GET /api/calendar/<token>.ics` |
| `GET /api/push/config` · `POST/DELETE /api/me/push` · `POST /api/me/push/test` | Push notifications for this device (Web Push subscription `endpoint` and `keys`) |

Example: create a task in a project.

```bash
curl -X POST https://softex.example.com/api/tasks \
  -H "Authorization: Bearer sx_…" -H "Content-Type: application/json" \
  -d '{"title":"Renew SSL certificate","projectId":"<project id>","dueDate":"2026-10-15","priority":"high"}'
```

## SCIM 2.0 provisioning

Admins generate a SCIM token under **Administration → Provisioning** and give the identity provider:

- **Base URL:** `https://<your Küü host>/scim/v2`
- **Authentication:** HTTP header `Authorization: Bearer scim_…`

Supported: `ServiceProviderConfig`, `ResourceTypes`, and `Users` with `GET` (filters `userName eq`, `externalId eq`, `emails eq`; paging with `startIndex` and `count`), `POST`, `PUT`, `PATCH` (`replace` of `active`, `displayName`, `name`, `title`, `externalId`) and `DELETE`.

- Setting `active` to `false`, or `DELETE`, deactivates the member. This signs them out everywhere, revokes their API tokens and closes their live connections. Their content is kept.
- Workspace owners cannot be deactivated through SCIM.
- New users join as members. Roles are managed in Küü.

## Webhooks

Admins add webhooks in *Administration → Webhooks*. Küü sends an HTTPS `POST` for each subscribed event:

```json
{
  "id": "b7c0…",
  "type": "task.status_changed",
  "created_at": "2026-09-24T15:04:05.000Z",
  "workspace_id": "…",
  "data": { "id": "…", "title": "Ship beta", "status": "done", "previous_status": "review", "project_id": "…" }
}
```

The events are `message.created`, `task.created`, `task.assigned`, `task.status_changed`, `document.version_added`, `meeting.ended`, `decision.recorded` and `project.created`. You can also subscribe to `*` for all of them.

- **Privacy:** events about private channels, private projects, direct messages and personal tasks are never sent.
- **Delivery:** at least once. If your endpoint doesn't reply with a 2xx status within 10 seconds, Küü retries up to 8 times with exponential backoff. Use `id` (also sent as `X-SoftEX-Delivery`) to ignore duplicates.
- **Security:** webhook URLs must be public `https` addresses. Private and internal network addresses are refused.

### Verifying signatures

Every request carries `X-Kuu-Event`, `X-Kuu-Delivery`, `X-Kuu-Timestamp` and `X-Kuu-Signature: sha256=<hex>` (the same headers are also sent with the product's former `X-SoftEX-` prefix, for integrations built before the rename). The signature is the HMAC-SHA256 of `"<timestamp>.<raw body>"`, keyed with the webhook's signing secret. Reject requests with a bad signature, and requests whose timestamp is more than 5 minutes old.

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(req, rawBody, secret) {
  const ts = req.headers['x-softex-timestamp'];
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const expected = 'sha256=' + createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex');
  const given = String(req.headers['x-softex-signature'] ?? '');
  return given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}
```
