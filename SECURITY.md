# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Use GitHub's *Report a vulnerability* button on the repository's Security tab (private vulnerability reporting). Include steps to reproduce and the impact you observed. We aim to acknowledge reports within 3 working days.

## How SoftEX protects data

- **Authorization:** every request, and every derived surface (search, activity feeds, notifications, emails, webhooks, exports and AI prompts), goes through the checks in `server/src/access.ts`. The tests in `server/test/` cover isolation between workspaces, private channels and projects, and guest access.
- **Accounts:**
  - Passwords are hashed with scrypt, and session and API tokens are stored only as SHA-256 hashes.
  - Session cookies are HttpOnly with `SameSite=Lax`, and cross-origin writes are rejected.
  - Optional TOTP multifactor authentication can be required for a whole workspace.
  - OIDC single sign-on uses PKCE and verifies the nonce and the ID token's signature.
- **Secrets at rest:** SSO client secrets are encrypted with AES-256-GCM using `SOFTEX_SECRET_KEY`.
- **Uploads:**
  - Executable types are blocked.
  - Files are scanned with ClamAV when `SOFTEX_CLAMAV_HOST` is set. If the scanner is unreachable, the upload is refused.
  - Files are served with `nosniff` and a sandboxing Content-Security-Policy.
- **Outbound requests:** webhook targets must be public HTTPS addresses, which prevents server-side request forgery. Webhook payloads are signed with HMAC.
- **Automations and scheduled messages** run with their creator's current access, checked again every time they run. Automations never trigger other automations, and can only post to private channels in their own project.
- **Provisioning:** SCIM tokens are stored only as hashes and can be rotated or revoked at any time. Deprovisioning revokes sessions and tokens immediately.
- **Retention:** workspaces can delete messages older than a set period. A legal hold pauses all automatic deletion, and every retention run is audited.
- **Offline cache:** the service worker keeps recently loaded workspace data for read-only offline use. It never caches sign-in, exports, downloads, admin or AI responses, and it deletes cached data on sign-out, on workspace switch and whenever the server reports the session has ended.
- **Audit:** sign-ins, role changes, exports, integrations and AI use are recorded in the audit log. AI entries record which item was used, never its content.

## Automated checks (GitHub Actions)

| Workflow | What it does |
| --- | --- |
| `ci.yml` | Type checks, server tests on Node 22 and 24, production build, browser smoke tests |
| `security.yml` | `npm audit`, CodeQL static analysis (security-extended), dependency review on pull requests, gitleaks secret scanning, plus a weekly scheduled run |
| `docker.yml` | Builds the image, smoke-tests it, scans it with Trivy (fails on critical findings), then publishes to GHCR with SBOM and build provenance |
| Dependabot | Weekly updates for npm packages, GitHub Actions and the Docker base image |
