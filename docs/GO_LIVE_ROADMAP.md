# Küü go-live roadmap: Google Cloud Run

Audience: the engineers and operators taking Küü to production on Google Cloud.
Status: proposal, based on a read of the repo at commit `a9035cb`. Items marked **(verify)** are assumptions to confirm in a spike, not facts.

---

## 0. Decisions (2 October 2026)

| Question (§11) | Answer | Consequence |
| --- | --- | --- |
| Architecture | Option A: single-container monolith on Cloud Run | Matches §2 |
| Database | Cloud SQL for PostgreSQL | Connect over the Cloud SQL unix socket (`--add-cloudsql-instances`). No VPC, connector or NAT is needed, which saves money. URL form in [DEPLOY_CLOUD_RUN.md](DEPLOY_CLOUD_RUN.md) |
| CPU / scaling | Instance-based CPU, min 1, max 1 | Jobs and the Postgres `LISTEN` connection keep running. See the concurrency warning below |
| Upload cap | 25 MB | Now the code default (`SOFTEX_MAX_UPLOAD_MB=25`), under Cloud Run's 32 MiB body limit. Meeting recordings share this cap |
| Launch scale | About 1k users and WebSockets | Sized in the warning below |
| Currency | USD | The plan catalog is already USD. `SOFTEX_LRD_PER_USD` can stay unset |
| Sign-up | Self-service | The existing 14-day trial, then the Free plan, stays as is |
| Domain | Decided, DNS on Cloudflare; **Cloud Run domain mapping** | No Google load balancer and no Cloudflare proxy: the record is DNS-only so Google can issue the certificate |
| Budget | Ceiling raised to **$70 a month** | Fits the estimate below with a little headroom |

### Two things the answers do not yet fit

1. **Concurrency ceiling.** Cloud Run counts every open WebSocket as a concurrent request, and the maximum per instance is 1000. With max-instances 1 and about 1k sockets, ordinary REST calls will be refused with 429 once the instance is full. Set `--concurrency=1000` and **max-instances 2**. The second instance only runs, and is only billed, when the first is busy. Realtime fan-out across two instances is already supported through Postgres `LISTEN/NOTIFY`.
2. **Budget (decided: $70).** These are rough list prices from memory (**verify in the pricing calculator**): one always-on 1 vCPU / 1 GiB instance is about $50 a month on its own (instance-based CPU is billed every second). The smallest Cloud SQL instance (`db-f1-micro`, shared core, no SLA, about 25 connections) is about $10 to $12 with storage and backups. Expect **$60 to $70** before a second instance, GCS, or email. **Decision: the ceiling is $70.** A second instance running for long periods would exceed it, so set a budget alert at $60 and watch instance-hours in the first weeks.

### Changes to the plan from these answers

- **No Cloud Armor, load balancer or Cloudflare proxy.** The domain mapping needs a DNS-only (grey cloud) record, so traffic goes straight to Google's front end. The edge protections in §4.2 are replaced by the app's own rate limits, Google's built-in DDoS protection, and Cloud Run's managed TLS. Cloud Run ingress stays `all`. Revisit a load balancer plus Cloud Armor if abuse appears.
- **Trust proxy.** With no Cloudflare in front, use `SOFTEX_TRUST_PROXY=1` and verify real client IPs in the audit log during staging.
- **Domain mapping caveats:** it is a preview feature, only in some regions, and adds latency compared with a load balancer. Pick a supported region in staging. Use a subdomain (for example `app.`) rather than the bare domain, because it is a single CNAME.

### Code changes delivered for these decisions

Structured JSON logs on Cloud Run; graceful SIGTERM shutdown (websocket clients get code 1001 and reconnect); HSTS; baseline API CSP; `connect-src` pinned to the public origin; native `GcsFileStore` (`SOFTEX_GCS_BUCKET`, no stored keys); 25 MB default upload cap; TCP keepalive on database connections; refusal to boot on Cloud Run with SQLite, local uploads, a non-https public URL or insecure cookies; Node 24 LTS base image; and an inert-until-configured `deploy-cloud-run` CI job using Workload Identity Federation. `/api/ready` was not added: the server only starts listening after migrations finish, so Cloud Run's startup probe on `/api/health` already means ready.

---

## 1. What we are deploying (as the code stands today)

| Fact | Where | Why it matters on Cloud Run |
| --- | --- | --- |
| One Node process serves the REST API, the built React SPA, `/ws` WebSockets, SCIM and background jobs | [server/src/app.ts](../server/src/app.ts), [server/src/index.ts](../server/src/index.ts) | A monolith that already fits one container |
| PostgreSQL via `SOFTEX_DATABASE_URL`; SQLite is the default | [server/src/db.ts](../server/src/db.ts) | **Production must use Postgres** (Cloud SQL). Cloud Run's disk is ephemeral, so SQLite is not an option |
| Multi-server ready: realtime fan-out over Postgres `LISTEN/NOTIFY`, rate limits in the DB, advisory locks for migrations and jobs | [server/src/realtime.ts](../server/src/realtime.ts), [server/src/jobs.ts](../server/src/jobs.ts) | Horizontal scaling works, with the caveats in §3 |
| Files go to local disk or S3-compatible storage | [server/src/storage.ts](../server/src/storage.ts) | Use object storage (GCS). Local disk is lost on every instance restart |
| Background jobs run in-process on `setInterval` (5 s queues, 10 min periodic) | [server/src/jobs.ts](../server/src/jobs.ts) | Cloud Run throttles CPU between requests by default, so jobs would stall |
| ClamAV scanning is a TCP call to `SOFTEX_CLAMAV_HOST` and uploads are refused if it is unreachable | [server/src/scanner.ts](../server/src/scanner.ts) | Needs a sidecar or a separate service |
| Dockerfile is multi-stage, runs as non-root, has a healthcheck and `/api/health` | [Dockerfile](../Dockerfile) | Already close to Cloud Run-ready |
| CI builds, Trivy-scans, SBOM/provenance-signs and pushes to GHCR; deploy is a generic webhook | [.github/workflows/docker.yml](../.github/workflows/docker.yml) | Retarget to Artifact Registry and `gcloud run deploy` |
| `npm audit`, CodeQL, gitleaks, dependency review, Dependabot already exist | [.github/workflows/security.yml](../.github/workflows/security.yml) | A good baseline to keep |

### Gaps found that block or weaken a Cloud Run launch

1. **No SIGTERM handling.** Cloud Run sends SIGTERM and gives about 10 s before SIGKILL. Today there is no `process.on('SIGTERM')` in `server/src`, so open WebSockets, in-flight uploads and job runs are cut off on every deploy and scale-in.
2. **Background jobs depend on CPU between requests.** See §3.
3. **Uploads are written to local disk first** (`multer dest: uploadDir/incoming`), up to `SOFTEX_MAX_UPLOAD_MB` (default 100 MB). On Cloud Run the filesystem is in-memory, so a 100 MB upload consumes 100 MB of instance RAM. Cloud Run also caps HTTP/1 request bodies at 32 MiB, which rules out larger direct uploads **(verify against current limits)**.
4. **No HSTS header.** The CSP is only set on the SPA HTML response, not on API responses.
5. **Backups only cover SQLite** ([server/src/backup.ts](../server/src/backup.ts)). With Postgres, backups are entirely Cloud SQL's job and need to be configured and drilled.
6. **`SOFTEX_SECRET_KEY` has no rotation path.** It encrypts SSO client secrets and the VAPID private key (AES-256-GCM, key derived from the string). Changing it breaks those records.
7. **Health check is shallow.** `/api/health` runs `SELECT 1` only, which is right for liveness but not a readiness signal.
8. **Per-instance state.** Presence and WebSocket sessions are local to an instance and shared through Postgres NOTIFY. Correct, but it puts a real load on the DB connection budget (§3).

---

## 2. Architecture strategies compared

### A. Single-container monolith on Cloud Run (recommended for launch)

```
Internet → Global external Application LB (+ Cloud Armor, managed TLS)
         → Cloud Run service "kuu" (1 image: API + SPA + WS + jobs)
              ├─ Cloud SQL for PostgreSQL (private IP)
              ├─ Cloud Storage bucket (uploads, backups)
              ├─ Secret Manager (secrets as env/volumes)
              └─ SMTP provider / Anthropic API (egress)
```

- **Pros:** matches how the code is built and tested (CI already runs the same single image). One deploy artifact, one rollback, no inter-service auth, lowest cost and cognitive load. The multi-server design already handles N instances.
- **Cons:** jobs, realtime and web traffic scale together. A noisy job can compete with request handling in the same instance.
- **Fits:** launch through the first few thousand active users. This is the default plan.

### B. Monolith + sidecar (A plus ClamAV)

Cloud Run supports multi-container instances. Run `clamav/clamav` as a sidecar and set `SOFTEX_CLAMAV_HOST=localhost`.

- **Pros:** scanning without a second service or network hop.
- **Cons:** ClamAV needs about 1–2 GiB RAM and a slow start for signature loading (the compose file uses a 180 s start period), and it is paid for in every app instance. The signature database must refresh at runtime **(verify)**.
- **Alternative:** one separate small Cloud Run service `kuu-clamav` with `min-instances=1`, reached over internal ingress. Scales independently, and one scanner serves all app instances. **Prefer this once instance count exceeds 2–3.**

### C. Split by workload: web / api / worker (adopt when metrics demand it)

```
Cloud Storage + CDN (or Firebase Hosting)  ← static SPA
Cloud Run "kuu-api"      ← REST + WebSockets, request-driven scaling
Cloud Run "kuu-worker"   ← jobs only, min=1, CPU always on, no public ingress
Cloud SQL, GCS, Secret Manager as in A
```

- **Pros:** jobs never steal CPU from requests; the API can scale to zero-ish and the worker stays small; static assets get CDN caching.
- **Cons / code cost:** needs a role flag (for example `SOFTEX_ROLE=api|worker|all`) so `startBackgroundJobs` runs only in the worker. The SPA is currently served by Express with an injected `publicUrl`, so splitting it means two origins, with CORS/cookie/CSP work. Doing so would also touch the origin check in `app.ts`, which assumes same-origin. Two services to deploy and keep version-compatible.
- **Do the cheap half first:** the role flag alone (api and worker run the same image from the same repo) gives most of the benefit without splitting the SPA.

### D. Full microservices (auth, chat, tasks, collab, billing…) — not recommended

The routes share one schema and one access layer ([server/src/access.ts](../server/src/access.ts)), and security relies on every surface going through it. Splitting would duplicate or network-ify that layer and multiply failure modes for no current benefit.

### Database options on GCP

| Option | Verdict |
| --- | --- |
| **Cloud SQL for PostgreSQL** (Enterprise, HA, private IP) | **Recommended.** Managed backups, PITR, patching, HA failover. Matches the CI-tested Postgres 17 |
| AlloyDB | Overkill now. Revisit if the DB becomes the bottleneck |
| Self-managed Postgres on GCE/GKE | Avoid: all the ops burden, no benefit |
| SQLite + volume | Not viable: Cloud Run has no durable local disk. Cloud Storage FUSE is unsuitable for SQLite locking |

### Decision

Ship **A**, with the ClamAV container as a **separate internal service** from day one if uploads are enabled. Plan **C-lite** (role flag, worker service) as Phase 5 work, triggered by the metrics in §8. Skip D.

---

## 3. Cloud Run–specific design decisions

| Topic | Decision | Reason |
| --- | --- | --- |
| **CPU allocation** | **Instance-based (CPU always allocated)** with `--min-instances=1` for the monolith | In-process jobs (`setInterval`) and the Postgres `LISTEN` connection must keep running when no request is active. With request-based CPU they stall. Alternative under C: move jobs to Cloud Scheduler hitting an authenticated endpoint, which needs new code |
| **Min / max instances** | min 1 (2 for HA once live), max capped (e.g. 10) | Warm WebSocket and listener, and the cap protects the DB connection budget |
| **Connection budget** | `SOFTEX_DB_POOL_SIZE × max-instances + 1 LISTEN per instance` must stay under Cloud SQL `max_connections` (and leave headroom). Start with pool 5, max 10 instances | Default pool is 10 per instance |
| **Pooling** | Connect **directly**, not through PgBouncer in transaction mode | `LISTEN/NOTIFY` and `pg_advisory_lock` (used for migrations and jobs) need session-level connections **(verify with any pooler)** |
| **Cloud SQL connectivity** | Private IP via **Direct VPC egress**, or the Cloud SQL connector/unix socket. Confirm `SOFTEX_DATABASE_URL` parsing handles the socket form (`?host=/cloudsql/...`) because `db.ts` parses the URL with `new URL` **(verify)** | |
| **WebSockets** | Supported. Set request timeout to 3600 s (max). Clients will be disconnected at timeout and on every deploy. Because the app persists before publishing and clients refetch over REST, a reconnect is safe. Confirm the client reconnect/backoff path in [client/src/realtime.ts](../client/src/realtime.ts) | |
| **Graceful shutdown** | Add SIGTERM handler: stop accepting, close WS with a "going away" code, finish current job tick, close pool, exit within ~8 s | Gap 1 |
| **Proxy trust** | `SOFTEX_TRUST_PROXY=2` behind LB + Cloud Run (hop count must be tested: rate limits and audit IPs must show real client IPs) | Wrong value makes all users share one rate-limit bucket or lets clients spoof IPs |
| **Public URL / cookies** | `SOFTEX_PUBLIC_URL=https://<domain>`, `SOFTEX_SECURE_COOKIES=true` | Defaults are localhost and insecure cookies |
| **Mode / registration** | `SOFTEX_MODE=saas` for hosted, `SOFTEX_REGISTRATION` as appropriate | Per [README.md](../README.md) |
| **Files** | GCS bucket. Two routes: (1) S3 interop endpoint `https://storage.googleapis.com` with HMAC keys, which needs a spike because newer AWS SDK checksum headers can break GCS compat **(verify)**; (2) **write a small native `GcsFileStore`** implementing the 4-method `FileStore` interface, using Application Default Credentials with no long-lived keys. **Prefer (2)** | Removes static credentials entirely |
| **Large uploads** | Phase 0: lower `SOFTEX_MAX_UPLOAD_MB` to ≤ 30 and size instance memory for it. Later: signed-URL direct-to-GCS uploads, then scan asynchronously | 32 MiB request cap and in-memory disk |
| **Email** | External SMTP/API provider (SendGrid, Postmark, SES) via `SOFTEX_SMTP_URL`. Cloud Run blocks outbound port 25 | Deliverability: SPF, DKIM, DMARC on the sending domain |
| **Region** | Choose by customer location and latency; keep Cloud Run, Cloud SQL and GCS in the **same region** | Latency and egress cost; also data-residency commitments |

### Reference service configuration (starting point)

```bash
gcloud run deploy kuu \
  --image=REGION-docker.pkg.dev/PROJECT/kuu/kuu@sha256:DIGEST \
  --region=REGION \
  --service-account=kuu-run@PROJECT.iam.gserviceaccount.com \
  --ingress=internal-and-cloud-load-balancing \
  --no-allow-unauthenticated   # LB invokes via IAM; see §4 note
  --cpu=1 --memory=1Gi --no-cpu-throttling \
  --min-instances=1 --max-instances=10 \
  --concurrency=80 --timeout=3600 \
  --network=VPC --subnet=SUBNET --vpc-egress=private-ranges-only \
  --set-env-vars=NODE_ENV=production,SOFTEX_MODE=saas,SOFTEX_PUBLIC_URL=https://app.example.com,SOFTEX_SECURE_COOKIES=true,SOFTEX_TRUST_PROXY=2,SOFTEX_DB_POOL_SIZE=5 \
  --set-secrets=SOFTEX_DATABASE_URL=kuu-db-url:latest,SOFTEX_SECRET_KEY=kuu-secret-key:latest,ANTHROPIC_API_KEY=kuu-anthropic:latest,SOFTEX_SMTP_URL=kuu-smtp:latest
```

Notes: browsers cannot supply IAM tokens, so a public site behind the load balancer normally uses `--allow-unauthenticated` together with `--ingress=internal-and-cloud-load-balancing`. That makes the LB the only door while the app does its own authentication. Treat the flags above as a template and finalize them in the staging spike.

---

## 4. Production-grade security plan

### 4.1 Identity and access (GCP)

- **Separate projects** per environment (`kuu-staging`, `kuu-prod`), under one organization with an org policy baseline.
- **Dedicated runtime service account** `kuu-run` with only: `roles/cloudsql.client`, object read/write on its one bucket, `secretmanager.secretAccessor` on its own secrets. Never use the default compute service account.
- **Separate deployer service account** used by CI: `run.developer`, `iam.serviceAccountUser` on `kuu-run`, `artifactregistry.writer`. No owner/editor roles anywhere.
- **GitHub → GCP via Workload Identity Federation** (OIDC, no JSON keys), restricted to this repo and the `main` branch/tags and protected `production` environment.
- Human access via groups, MFA enforced, break-glass account, no standing prod admin; use time-limited elevation.
- Org policies: disable service-account key creation, restrict public IPs on Cloud SQL, restrict resource locations, require OS Login where VMs exist.

### 4.2 Network edge

- **Global external Application Load Balancer** with a serverless NEG → Cloud Run, Google-managed TLS cert, HTTP→HTTPS redirect, TLS ≥ 1.2.
- **Cloud Armor** policy: preconfigured OWASP rules (SQLi, XSS, LFI, RCE), per-IP rate limiting on `/api/auth/*` and `/api/*` (an outer layer to the app's own limiter), geo/IP allowlisting for `/api/operator` if feasible, adaptive DDoS protection.
- Cloud Run ingress locked to `internal-and-cloud-load-balancing` so the default `*.run.app` URL cannot be used to bypass Armor.
- Set a header or WAF rule that denies `/scim/v2` from everywhere except the IdP ranges, if the IdP publishes them.
- Egress: Direct VPC egress with `private-ranges-only` for the DB, and Cloud NAT with a static IP if third parties (SMTP, STT) need an allowlist. Firewall egress rules blocking the metadata server from user-influenced requests as defense in depth for the webhook SSRF guard (the app already restricts webhooks to public HTTPS; **verify DNS-rebinding handling** in [server/src/webhooks.ts](../server/src/webhooks.ts)).

### 4.3 Data protection

- **Cloud SQL:** private IP only, no public IP, SSL required, automated daily backups + **point-in-time recovery**, HA (regional) for prod, deletion protection, maintenance window set, query insights on. IAM database authentication is optional (needs a code change: the app uses a password URL today). Optional CMEK.
- **Least-privilege DB user:** the migration runs `CREATE TABLE`/`ALTER TABLE` at startup, so the app role needs DDL rights today. A later hardening step is a separate migrator role. Note this in the risk register.
- **GCS bucket:** uniform bucket-level access, public access prevention enforced, versioning + soft delete, lifecycle rules, separate bucket (or prefix + IAM condition) for backups, optional CMEK. Serve files only through the app (already auth-checked) or short-lived signed URLs.
- **Secrets:** Secret Manager only; no secrets in env files, image layers, or CI logs. Version-pin secrets in production deploys. Define a **rotation runbook**: DB password, SMTP, Anthropic key (all straightforward). `SOFTEX_SECRET_KEY` needs a code change first (key-ID envelope plus re-encrypt job) before it can be rotated safely.
- Encryption in transit everywhere (LB TLS, Cloud SQL SSL); at rest by default with Google-managed keys.

### 4.4 Application hardening (code changes)

| Change | File | Notes |
| --- | --- | --- |
| Add `Strict-Transport-Security: max-age=31536000; includeSubDomains` (preload only after a soak period) | [server/src/app.ts](../server/src/app.ts) | Only when `secureCookies`/https public URL |
| Send a baseline CSP (`default-src 'none'; frame-ancestors 'none'`) on API responses too | `app.ts` | Currently only the HTML route has CSP |
| Review CSP `style-src 'unsafe-inline'` and the wide `connect-src ws: wss:` (tighten to the public origin) | `app.ts` | Reduces XSS blast radius |
| Cookie hardening: `Secure`, `HttpOnly`, `SameSite=Lax`, consider `__Host-` prefix | [server/src/routes/auth.ts](../server/src/routes/auth.ts) | Verify current attributes |
| SIGTERM/SIGINT graceful shutdown | [server/src/index.ts](../server/src/index.ts) | Gap 1 |
| Separate `/api/ready` (DB reachable + migrations done) from `/api/health` (process alive); use startup probe on ready | `app.ts` | Prevents traffic before migrations finish |
| Structured JSON logs with `severity` and trace field for Cloud Logging; scrub PII | server-wide | Currently `console.log/error` |
| Error handler must never leak stack traces in production | `errorHandler` | Verify |
| Operator console: keep MFA + allowlist; add Cloud Armor/IAP-style IP restriction | [server/src/routes/billing.ts](../server/src/routes/billing.ts) | Highest-privilege surface |
| Lower default `SOFTEX_MAX_UPLOAD_MB` in the Cloud Run profile; verify executable-type blocking and ClamAV fail-closed (already designed) | storage/knowledge routes | |
| Registration: use `first` or `closed` plus invites during beta; keep email confirmation (already in SaaS mode) | env | Limits abuse before launch |

### 4.5 Supply chain and CI/CD

- Retarget [docker.yml](../.github/workflows/docker.yml): push to **Artifact Registry** (keep GHCR as an optional mirror), keep Trivy gate, SBOM and provenance.
- Enable **Artifact Registry vulnerability scanning** and **Binary Authorization** (require attestation from the CI build for prod). Deploy by **digest**, never by tag.
- Pin GitHub Actions to commit SHAs, keep Dependabot, require CODEOWNERS + review on `main`, protected `production` environment with manual approval.
- Consider moving the base image from `node:25-slim` (a non-LTS release line) to the current LTS, or to a distroless Node image, for a smaller attack surface and longer patch support. Confirm Node ≥ 22.5 for `node:sqlite` (the code imports it even in Postgres mode).
- Keep gitleaks, CodeQL, `npm audit` gates; add a DAST pass (OWASP ZAP baseline) against staging.

### 4.6 Detection, audit, response

- **Cloud Audit Logs** (Admin Activity default; enable Data Access for Cloud SQL, GCS and Secret Manager) exported to a locked log bucket / BigQuery with retention.
- Log-based alerts: auth failure spikes, operator-console actions, 5xx rate, Cloud Armor blocks, IAM policy changes, secret access by unexpected principals.
- **Security Command Center** (standard/premium as budget allows) for misconfiguration findings.
- Incident response runbook and on-call rota; the repo's `engineering:incident-response` skill is a good template. Publish `security.txt`, keep the existing [SECURITY.md](../SECURITY.md) disclosure process.
- Schedule an **external penetration test** before general availability, focused on multi-tenant isolation (the `access.ts` layer), SSO/SCIM, file upload, and the operator console.

### 4.7 Compliance and privacy

- Privacy policy, terms, subprocessors list (Google Cloud, email provider, Anthropic for AI features), data-retention and deletion behaviour (the app already has workspace/account deletion and retention) in line with [Legal.tsx](../client/src/pages/Legal.tsx).
- Decide data residency and sign a DPA with Google Cloud. Confirm what AI prompt data goes to Anthropic and disclose it.
- Map controls to SOC 2 / ISO 27001 if enterprise customers will ask; start evidence collection (access reviews, change logs) from day one.

---

## 5. Docker / build plan

The existing image is a sound base. Changes for Cloud Run:

1. Keep multi-stage build and non-root user; **remove reliance on a writable `/app/server/data` volume** (set `SOFTEX_DATA_DIR=/tmp/kuu` for scratch only).
2. Confirm the container listens on `$PORT` (it does: `PORT ?? 4000`) and on all interfaces. Cloud Run injects `PORT=8080`.
3. Drop the Dockerfile `HEALTHCHECK` for Cloud Run (it is ignored) or keep it for compose; configure Cloud Run startup/liveness probes against `/api/ready` and `/api/health`.
4. Add `--init`-style signal handling or rely on the new SIGTERM handler. `CMD ["node", ...]` as PID 1 is fine once handled.
5. Reproducible builds: pin base image by digest, run `npm ci`, build in CI, scan, sign.
6. Local parity: keep [docker-compose.yml](../docker-compose.yml) and add a Postgres service plus a `fake-gcs-server` (or MinIO) for local production-like testing.
7. Alternative to a Dockerfile: Cloud Buildpacks. Not recommended here, since the existing Dockerfile already hardens the image (apt upgrade, npm removal).

---

## 6. Phased roadmap

Effort is rough, for one or two engineers. Each phase has an exit gate.

### Phase 0: Readiness fixes in the codebase (about 1 week)

- [ ] SIGTERM graceful shutdown (HTTP, WS, jobs, DB pool)
- [ ] `/api/ready` + startup probe semantics
- [ ] HSTS, API CSP, `connect-src` tightening, cookie review
- [ ] Structured JSON logging for Cloud Logging
- [ ] `GcsFileStore` (or validated S3-interop spike) + tests alongside [storage.test.ts](../server/test/storage.test.ts)
- [ ] Upload path review: size cap for Cloud Run, plan for signed-URL uploads
- [ ] Optional `SOFTEX_ROLE` flag (`all|api|worker`) gating `startBackgroundJobs`
- [ ] `SOFTEX_SECRET_KEY` key-versioning design (implement before first rotation, not necessarily before launch)
- [ ] Verify Postgres connection via Cloud SQL (private IP and unix socket forms)

**Exit gate:** CI green on Postgres matrix, container passes smoke test with `PORT=8080`, graceful shutdown covered by a test.

### Phase 1: GCP foundation as code (about 1 week)

- [ ] Terraform (or Pulumi) for projects, APIs, VPC/subnet, Cloud SQL (HA, PITR, private IP), GCS buckets, Artifact Registry, Secret Manager, service accounts, Workload Identity Federation
- [ ] Remote state, plan-on-PR in CI
- [ ] Org policies and budget alerts
- [ ] Domain, DNS, managed certificate, ALB + serverless NEG + Cloud Armor
- [ ] Mail domain: SPF, DKIM, DMARC, provider account

**Exit gate:** `terraform apply` from scratch builds an empty staging environment; no human-created resources.

### Phase 2: Staging deployment and CI/CD (about 1 week)

- [ ] Update `docker.yml`: build → Trivy → push to Artifact Registry → deploy to staging by digest on `main`
- [ ] Production deploy on version tag with manual approval, using `--no-traffic` plus tag-based canary (§7)
- [ ] ClamAV service deployed and wired (`SOFTEX_CLAMAV_HOST`)
- [ ] Seed staging with representative data (`npm run seed`)
- [ ] Run Playwright e2e suite against staging URL

**Exit gate:** a merge to `main` reaches staging with no manual steps; e2e passes through the load balancer, including WebSockets and live collaboration.

### Phase 3: Hardening, load and resilience (about 2 weeks)

- [ ] Load test (k6/Artillery): REST mix, 500–2000 concurrent WebSockets, collab edits, upload bursts. Record p95 latency, DB connections, instance count
- [ ] Tune concurrency, pool size, memory, max instances from results
- [ ] Multi-instance correctness: two or more instances, verify realtime fan-out, presence, one job runner at a time, rate limits shared
- [ ] Failure drills: kill instance mid-job, Cloud SQL failover, deploy during active WebSockets, secret rotation
- [ ] **Backup restore drill** from Cloud SQL PITR and GCS versioning into a scratch project; record RTO/RPO
- [ ] ZAP baseline scan, then the external pen test (start booking early; it is the long lead item)
- [ ] Alerting, dashboards and SLOs (§8) live; on-call runbooks written

**Exit gate:** SLO targets met under load; restore drill passed and documented; no open high/critical pen-test findings.

### Phase 4: Production launch (about 1 week, then watch)

- [ ] Pre-launch checklist run (use the `engineering:deploy-checklist` skill)
- [ ] Production environment applied from the same Terraform
- [ ] Registration set to `first`/`closed` or invite-only for a **private beta** cohort
- [ ] Canary: new revision gets 5% → 25% → 100% with a hold at each step, watching error rate and latency; rollback = shift traffic back to the previous revision
- [ ] Status page, support inbox, legal pages, billing config (`SOFTEX_PRICE_*`, payment instructions) verified end-to-end
- [ ] Open registration after the beta soak period

**Exit gate:** a week of beta traffic inside SLO with no sev-1 incidents.

### Phase 5: Scale and refine (ongoing)

- [ ] Split worker into its own Cloud Run service when jobs affect request latency (C-lite)
- [ ] Signed-URL direct uploads; asynchronous scanning
- [ ] Move the SPA to CDN-served static hosting if egress or latency justifies the origin split
- [ ] Separate migrator DB role; evaluate IAM DB auth
- [ ] Multi-region DR plan if required by customers (cross-region Cloud SQL replica, bucket dual-region)
- [ ] Cost reviews: committed use discounts, right-size instances
- [ ] Quarterly access reviews, annual pen test, dependency and base-image refresh

---

## 7. Release and rollback strategy

- Immutable image, deployed by digest. Each release creates a new Cloud Run **revision**.
- Deploy with `--no-traffic --tag=candidate`, run smoke tests against the tagged URL, then `gcloud run services update-traffic` in stages. Rollback is a one-command traffic shift to the prior revision, with no rebuild.
- **Schema changes must be backward-compatible** (expand → migrate → contract). Migrations run at app start under an advisory lock ([db.ts](../server/src/db.ts)), so the new revision migrates before the old one drains; old code must tolerate new columns. Never ship a destructive migration in the same release as the code that stops using the column.
- Feature flags/env toggles for risky features (AI, STT, registration mode).

## 8. Observability and SLOs

- **SLIs:** availability (non-5xx on `/api`), p95 API latency, WebSocket connect success, job lag (age of oldest queued email/webhook), upload success rate.
- **Starting SLOs:** 99.5% availability, p95 < 500 ms for core reads. Tighten after the first month of real data.
- **Dashboards:** Cloud Run (instances, CPU, memory, concurrency, cold starts), Cloud SQL (connections, CPU, replication, locks), LB (4xx/5xx, latency), job queue depth.
- **Uptime checks** from multiple regions against `/api/health` via the public domain; alert to chat + paging for sev-1.
- **Triggers to adopt Phase 5 splits:** sustained CPU > 60% on API instances caused by job runs; DB connections > 70% of max; p95 latency regression correlated with job ticks; static asset egress above a cost threshold.

## 9. Cost shape (order of magnitude, verify with the GCP pricing calculator)

The always-on costs dominate at small scale: Cloud SQL HA (the largest line), one or two always-on Cloud Run instances, the load balancer forwarding rule, Cloud Armor, and NAT if used. Traffic-driven costs (requests, egress, GCS) are small until real usage. Budget alerts at 50/80/100% from Phase 1. A non-HA single-zone Cloud SQL is acceptable for staging only.

## 10. Risk register (top items)

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Jobs stall under CPU throttling | Emails, webhooks, reminders silently stop | CPU always allocated, queue-age alert |
| DB connection exhaustion on scale-out | Outage | Pool size × max instances budget, max-instances cap, alert at 70% |
| Deploy drops WebSockets/uploads | Poor UX, data loss risk on uploads | SIGTERM handler, client reconnect, deploy off-peak |
| Bad migration | Data loss, rollback impossible | Expand/contract, PITR, staging rehearsal on prod-sized data |
| Lost or leaked `SOFTEX_SECRET_KEY` | SSO secrets undecryptable or exposed | Secret Manager, restricted access, escrow copy, rotation design |
| Tenant isolation bug | Cross-customer data leak | Existing permission tests, pen test, audit logging, review of any new route |
| Upload malware / abuse | Compromise of users | ClamAV fail-closed, type blocking, size caps, Armor rate limits |
| AI cost abuse | Bill shock | Per-workspace caps (exists), budget alert on the key |
| Single region outage | Downtime | Documented RTO/RPO, restore drill; multi-region only if contractually needed |

## 11. Open questions for the team

1. Expected users and concurrent WebSocket count at launch and at 12 months. This sizes instances and the DB tier.
2. Target region and any data-residency commitments (customers appear to be Liberia-focused per the LRD billing settings; pick the closest low-latency region).
3. Self-serve public sign-up at launch, or invite-only beta first?
4. Is uploads/recordings (100 MB class files) a launch feature, or can it start capped at 30 MB?
5. Compliance targets (SOC 2, ISO 27001, GDPR) and any enterprise deadlines.
6. Is the hosted domain decided, and who owns DNS and the mail domain?
7. Budget ceiling per month for infrastructure.
