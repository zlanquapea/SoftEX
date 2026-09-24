# SoftEX Product Documentation

**Version:** 0.1 | **Status:** Product concept and implementation brief | **Date:** 24 September 2026

## 1. Executive summary

SoftEX is a unified workspace for team communication, projects, documents, meetings, and company knowledge. Its central promise is simple: a person should be able to find a decision, understand what needs doing, collaborate with the right people, and move the work forward without switching among many disconnected tools.

The recommended first release combines channels and direct messages, tasks and projects, searchable files and knowledge pages, lightweight meetings, notifications, and administration. Later releases can add advanced video, automation, AI assistance, customer and vendor collaboration, and deeper business operations. SoftEX should initially integrate with existing calendars, email, and file services where replacing them would delay the launch.

This document is a proposed specification. Target customers, budget, regulatory obligations, hosting region, and launch date require confirmation before engineering estimates are committed.

## 2. Product goals and boundaries

### Goals

1. Keep conversation, decisions, files, meetings, and tasks connected to the work they concern.
2. Give every team member a clear view of priorities, owners, deadlines, and blockers.
3. Make company knowledge easy to find and maintain.
4. Reduce notification overload while preserving urgent communication.
5. Give administrators practical control over access, data, retention, and integrations.
6. Work well for distributed teams on desktop and mobile, including low-bandwidth situations.

### Initial boundaries

SoftEX is not intended to replace payroll, accounting, full CRM, or specialized design and engineering systems in its first release. It should link to or integrate with these systems. Full telephony, webinar hosting, and real-time collaborative office editing are later decisions, because they have substantial cost and operational complexity.

### Proposed success measures

| Measure | Initial target to validate in pilot |
| --- | --- |
| Weekly active users | At least 75% of invited pilot members by week 8 |
| Task ownership | At least 90% of active project tasks have one accountable owner |
| Decision capture | At least 70% of sampled project decisions are linked to a project or task |
| Search usefulness | At least 80% of pilot users can find a known document or decision within 2 minutes |
| Reliability | 99.9% monthly availability target after general release |
| Meeting quality | Measure join success, connection failures, and user-rated quality before setting a formal SLA |

These are hypotheses for a pilot, not promises or industry benchmarks.

## 3. Users and access model

| Role | Primary needs | Typical rights |
| --- | --- | --- |
| Workspace owner | Configure and govern the company workspace | Billing, policies, administrators, exports |
| Administrator | Manage users, security, and integrations | Identity, permissions, audit, retention |
| Team lead | Coordinate a team and its projects | Create team spaces, projects, reports |
| Member | Collaborate and deliver work | Messages, tasks, meetings, approved files |
| Guest | Work with a partner on limited items | Access only explicitly shared spaces |

Permissions should be role based with explicit exceptions at workspace, team, channel, project, and document levels. Private content must not become visible through search, AI summaries, notifications, previews, or exported reports. Guests should have an expiration date and a visible sponsor.

## 4. Core information model

A **workspace** contains teams. A **team** has channels, projects, and knowledge. A **channel** holds discussions and can be linked to a project. A **project** holds tasks, milestones, files, meetings, decisions, and status updates. A **task** has one owner, status, priority, due date, and optional subtasks or dependencies. A **document** has a version and access policy. A **meeting** has participants, agenda, notes, decisions, and follow-up tasks.

Every important object needs a stable link, ownership, created and updated timestamps, activity history, and permission checks. Search and activity feeds should respect the same permissions as the underlying objects.

## 5. Functional requirements

### 5.1 Communication

- Public and private channels, direct messages, group messages, threads, mentions, reactions, pinned items, saved items, and rich text.
- Message editing and deletion governed by workspace policy; clear edited and deleted indicators where appropriate.
- Attach files, link a task or project, convert a message into a task, and record a decision from a thread.
- Presence and availability with scheduled focus time and quiet hours.
- Announcement channels with restricted posting and acknowledgement tracking for critical notices.
- Search messages by person, channel, date, project, and attachment type.

### 5.2 Tasks and projects

- Tasks with one accountable owner, collaborators, due date, priority, status, description, checklist, comments, attachments, and activity log.
- Project views: list and board for the first release; timeline and workload views later.
- Milestones, dependencies, recurring tasks, templates, and project health updates.
- Personal “My work” view showing today, upcoming, overdue, blocked, and assigned-for-review items.
- Decision log, risk register, and weekly status summary linked to a project.
- Automations such as deadline reminders and handoff notifications, with transparent rules and opt-out controls where suitable.

### 5.3 Documents and knowledge

- File upload, preview, download, version history, ownership, labels, and permissions.
- Knowledge pages with simple editing, links to tasks and discussions, and review dates for time-sensitive content.
- Search across titles and permitted content, including files where extraction is supported.
- A project resource area that collects relevant links, files, meeting notes, and decisions.
- Retention, archival, and recovery controls. Malware scanning and file-type restrictions at upload.
- External file service connections can be linked in the first release; native editing and synchronization need separate design.

### 5.4 Meetings

- Schedule or start a meeting from a channel or project; invite participants and attach an agenda.
- Video, audio, screen sharing, chat, participant controls, and meeting links.
- Notes, decisions, and follow-up tasks tied to the meeting and project.
- Calendar integration and time-zone-aware scheduling.
- Captions, recording, and transcripts as opt-in later capabilities, subject to participant notice, consent, access, and retention settings.
- A managed real-time communications provider is the recommended initial route; the choice requires a cost, privacy, and reliability review.

### 5.5 Focus and company operations

- Unified home screen with priorities, meetings, unread mentions, blockers, and recent decisions.
- Daily or weekly check-in that can roll up into project status without requiring a meeting.
- Notification digest, per-channel settings, quiet hours, and urgent escalation rules.
- Structured onboarding checklist for new employees, with role-specific resources and approvals.
- Lightweight requests and approvals for access, purchases, leave handoffs, or internal support; connect to systems of record where applicable.
- Company directory with teams, roles, time zones, working hours, and expertise tags.

### 5.6 AI assistance, after governance is established

- Permission-aware summaries of long threads and meetings, with links to source material.
- Suggested task extraction and duplicate knowledge detection; a human confirms creation or publication.
- Natural-language search that cites accessible sources and indicates uncertainty.
- Weekly project brief drafted from activity, with owner review before sharing.
- Workspace controls for model providers, data processing, retention, opt-in, audit, and content excluded from AI features. AI must never expand a user's access to underlying information.

### 5.7 Administration and integrations

- User invitations, deactivation, groups, roles, guest policies, and workspace settings.
- Single sign-on and automated provisioning for business plans; multifactor authentication for all users.
- Audit logs for administrative and sensitive data actions, data export, retention policies, and legal hold if required.
- Calendar, email, cloud file storage, and common development or CRM integrations through scoped permissions.
- Public API and webhooks after the internal permission model and rate limiting are mature.

## 6. Representative workflows

**Turn a discussion into delivery.** A team discusses an issue in a project channel. A member records the decision, creates a task from the relevant message, assigns an owner and date, and links a document. The task appears in the owner's My work view and the project's status report.

**Run a project meeting.** The lead schedules from the project, adds an agenda, and starts a video session. Participants capture notes and decisions. Follow-up tasks inherit the project link, and the summary is visible to authorized members.

**Find a policy.** A member searches for a policy. Results include the latest approved page, owner, review date, and related discussions. The member can request clarification without losing the source context.

**Bring in a partner.** An administrator grants a guest time-limited access to one private channel and selected project resources. An audit trail records the invitation and later removal.

## 7. Release plan

| Phase | Outcome | Scope |
| --- | --- | --- |
| Discovery and design | Validate workflows and constraints | Interviews, prototype, data model, security review, vendor selection, measurable pilot criteria |
| MVP | One coherent daily workspace | Identity, teams, channels and DMs, threads, notifications, task/project basics, file upload and links, basic knowledge pages, search, meeting links and managed video, admin controls |
| Pilot hardening | Reliable use by real teams | Mobile usability, accessibility, performance, import tools, analytics, support processes, backups, incident playbooks |
| Expansion | Reduce routine coordination work | Project templates, dependencies, reporting, decision log, calendar sync, automation, guest collaboration, advanced search |
| Advanced capabilities | Add differentiated assistance | Governed AI, captions and transcripts, richer approvals, API, broader integrations |

The MVP should be released to a small pilot before a general launch. Exit criteria include successful core workflows, no unresolved critical security issues, verified backups and restore, measured meeting quality, and acceptable support volume.

## 8. Technical architecture proposal

- **Clients:** Responsive web application first; mobile application or installable web app according to pilot needs. Design for keyboard access and screen readers from the start.
- **Application services:** Identity and authorization, messaging, projects, files and knowledge, meetings, search, notifications, integrations, and administration. Start with a modular backend and clear domain boundaries; separate services only when scale or operations justify them.
- **Data:** Relational database for core records, object storage for files, search index for permitted content, cache and queue for delivery and background jobs. Backups must include consistency checks and restore drills.
- **Real time:** WebSocket or equivalent for messaging and presence; durable message persistence and retry behavior for reconnection.
- **Video:** Managed conferencing or WebRTC infrastructure with region, recording, scale, and cost requirements specified before procurement.
- **Interfaces:** Versioned APIs, signed upload flows, event processing for notifications and integrations, and observability across all components.

A suggested stack for estimation is TypeScript-based web UI, a TypeScript or equivalent backend, PostgreSQL, object storage, a search engine, a job queue, and a managed video provider. This is a proposal, not a mandated vendor choice.

## 9. Security, privacy, accessibility, and reliability

- Enforce authorization on every request and search result; test cross-tenant isolation.
- Encrypt traffic and stored data, manage secrets centrally, and rotate credentials.
- Use multifactor authentication, session controls, least privilege, and administrative audit trails.
- Scan uploads, validate file types and sizes, rate limit abuse, and protect against malicious links and content.
- Define data ownership, retention, deletion, export, breach response, and regional residency requirements with counsel and customers.
- Let users and admins control recording and AI use; show clear indicators when either is active.
- Aim for WCAG 2.2 AA in the product design and test key workflows with assistive technology.
- Define recovery objectives, monitor availability and latency, and exercise incident and restore procedures before general release.

Compliance claims such as SOC 2, HIPAA, or GDPR conformity should only be made after assessing the actual product, operations, contracts, and target markets.

## 10. Nonfunctional requirements to refine in discovery

| Area | Proposed requirement |
| --- | --- |
| Performance | Common navigation and message interactions feel immediate on ordinary connections; measure p95 latency in pilot |
| Scale | Size for pilot headcount and expected concurrent meetings, then load test the forecast |
| Availability | Target 99.9% monthly availability after general release, with published maintenance policy |
| Data durability | Automated backups and tested restore procedures; define RPO and RTO with business owners |
| Accessibility | Keyboard and screen reader support across core flows; contrast and captions |
| Portability | Export messages, tasks, pages, and file metadata in documented formats |
| Localization | Time zones and date formats at launch; languages and data regions based on target customers |

## 11. Key screens and navigation

A persistent left navigation should provide Home, Inbox, Chats, Channels, My work, Projects, Knowledge, Meetings, and Directory. Global search remains accessible from every screen. The main content area shows the selected work; a contextual side panel exposes related tasks, files, participants, and decisions. Mobile navigation should prioritize Home, Inbox, Chats, My work, and Search.

Home should answer three questions: What matters today? What is blocked? What changed since I last checked? It should allow people to tune what they see without hiding urgent assigned work.

## 12. Data and event examples

Core entities include Workspace, User, Membership, Team, Channel, Message, Thread, Project, Task, Milestone, Document, DocumentVersion, KnowledgePage, Meeting, Decision, Notification, AuditEvent, IntegrationConnection, and AccessGrant. Relationships and deletion behavior need an explicit schema design before implementation.

Examples of events are `message.created`, `task.assigned`, `task.status_changed`, `document.version_added`, `meeting.ended`, and `decision.recorded`. Consumers must handle retries and duplicate delivery safely. Sensitive event payloads should contain only data needed by each consumer.

## 13. Delivery team and indicative sequence

A working delivery team needs product management, product design and research, frontend and backend engineering, quality engineering, security input, infrastructure operations, and customer support. Meeting infrastructure and mobile development may need specialist capacity. Avoid treating the following as a fixed estimate until requirements and vendor choices are validated.

1. Weeks 1 to 4: interviews, workflow mapping, prototype, architecture and threat model.
2. Weeks 5 to 8: design system, identity, workspace setup, initial messaging and project model.
3. Weeks 9 to 16: tasks, files, search, notifications, meeting integration, admin controls, and end-to-end testing.
4. Weeks 17 to 20: pilot, fixes, migration, observability, and release readiness.

This 20-week outline assumes a dedicated experienced team and managed meeting technology. Scope, team size, and procurement can materially change it.

## 14. Risks and decisions

| Risk or decision | Why it matters | Recommended next action |
| --- | --- | --- |
| Trying to match every established platform at launch | Lengthens delivery and weakens core experience | Protect the MVP around connected communication and execution |
| Video quality and cost | Infrastructure and support burden can rise rapidly | Prototype two providers with realistic usage |
| Permission leakage through search or AI | Can expose private company information | Centralize authorization and test every derived surface |
| Migration and adoption | Empty channels and knowledge bases have little value | Import selected content and pilot with committed teams |
| Notification overload | Can undermine the focus goal | Ship granular controls and measure interruption load |
| Data residency and regulated content | Determines vendors and hosting | Confirm target markets and compliance needs early |
| Integration sprawl | Adds maintenance and security exposure | Rank integrations by pilot demand |

## 15. Discovery questions and next decisions

Before locking the build scope, decide:

1. Is SoftEX for one internal company or a multi-company SaaS product?
2. How many users, teams, guests, and concurrent meetings are expected at launch and in year one?
3. Which current tools must be imported or integrated first?
4. What budget, launch deadline, hosting region, and compliance obligations apply?
5. Which platforms are mandatory at launch: web, iOS, Android, or desktop?
6. Who owns product decisions, security approval, and pilot feedback?

The immediate next artifact should be a clickable prototype of Home, a project channel, a task, a project overview, and a meeting follow-up. Test those flows with representative employees, then turn the validated MVP into an estimated engineering backlog and architecture decision records.
