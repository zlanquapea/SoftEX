# Küü Cloud Run migration plan

Audience: the engineer doing the launch. Decisions behind it are in [GO_LIVE_ROADMAP.md](GO_LIVE_ROADMAP.md) §0; flags and URL forms are in [DEPLOY_CLOUD_RUN.md](DEPLOY_CLOUD_RUN.md).

Fixed choices: one container on Cloud Run (instance-based CPU, min 1, max 2, concurrency 1000), Cloud SQL for PostgreSQL over the unix socket, GCS for files, Cloud Run domain mapping with a DNS-only Cloudflare record, 25 MB upload cap, USD, self-service sign-up, budget ceiling $70 a month.

Items marked **(verify)** are assumptions to confirm on the day. Prices are rough, from memory.

## Step 0. Before touching GCP (half a day)

1. Choose the region. It must support Cloud Run domain mappings **(verify the current list)**, and Cloud Run, Cloud SQL and the bucket must all be in it. For users in Liberia, a European region (`europe-west1` or `europe-west4`) is the likely latency winner.
2. Pick the hostname, as a subdomain such as `app.<domain>`. The bare domain cannot be mapped with a single CNAME.
3. Decide the mail provider (SendGrid, Postmark or SES) and get an account. Cloud Run blocks outbound port 25, so use the provider's API-style SMTP on 587. Add SPF, DKIM and DMARC records in Cloudflare.
4. Create the Anthropic key only if AI features will be on at launch.
5. Merge the branch with the code changes in this repo and confirm CI is green on `main`.

**Done when:** region, hostname and mail provider are written down.

## Steps 1 to 4 can be automated

[deploy/README.md](../deploy/README.md) has Terraform and a `gcloud` script that do Steps 1 to 4 below (and the domain mapping command from Step 5). Use one of them, or follow the manual commands. If you use them, read the steps anyway for the checks.

## Step 1. GCP project and baseline (1 hour)

One project (`kuu-prod`) for launch. A second staging project doubles the always-on cost, so staging is a separate **service** in the same project (Step 6), scaled to zero.

```bash
gcloud projects create kuu-prod && gcloud config set project kuu-prod
# link billing in the console, then:
gcloud services enable run.googleapis.com sqladmin.googleapis.com secretmanager.googleapis.com \
  artifactregistry.googleapis.com storage.googleapis.com iamcredentials.googleapis.com
```

1. Create a **budget** with alerts at 50%, 80% (about $56) and 100% of $70.
2. Create the Artifact Registry repo: `gcloud artifacts repositories create kuu --repository-format=docker --location=REGION`.
3. Create the service accounts `kuu-run` (runtime) and `kuu-deploy` (CI), with the roles listed in DEPLOY_CLOUD_RUN.md. Do not use the default compute account. Do not create key files.

**Done when:** the budget alert exists and both service accounts have only the listed roles.

## Step 2. Data stores (1 hour)

1. **Cloud SQL**, PostgreSQL 17 (matches CI):
   ```bash
   gcloud sql instances create kuu-db --database-version=POSTGRES_17 --edition=ENTERPRISE \
     --tier=db-f1-micro --region=REGION --storage-size=10GB --storage-auto-increase \
     --backup-start-time=03:00 --enable-point-in-time-recovery --deletion-protection \
     --maintenance-window-day=SUN --maintenance-window-hour=4
   gcloud sql databases create kuu --instance=kuu-db
   gcloud sql users create kuu --instance=kuu-db --password="$(openssl rand -base64 24)"
   ```
   `db-f1-micro` is shared-core with no SLA. If the load test (Step 7) shows CPU or connection pressure, move to `db-g1-small` (about $25) and accept the budget move. **(verify `max_connections` for the tier)** and keep `pool size x max instances + 2` below it. Pool size 5 and 2 instances needs about 12.
2. **Bucket**: `gcloud storage buckets create gs://BUCKET --location=REGION --uniform-bucket-level-access --public-access-prevention`, then enable versioning and soft delete, and grant `kuu-run` `roles/storage.objectUser` on it only.
3. **Secrets** in Secret Manager: `kuu-db-url` (the socket URL from DEPLOY_CLOUD_RUN.md), `kuu-secret-key` (`openssl rand -hex 32`), plus `kuu-smtp` and `kuu-anthropic` if used. **Store a second copy of `kuu-secret-key` in a password manager.** It encrypts SSO secrets and the push key, and losing it makes them unreadable. Grant `kuu-run` accessor on each.

**Done when:** `gcloud sql instances describe kuu-db` shows backups and PITR on, and the secrets exist.

## Step 3. CI to Artifact Registry (1 hour)

1. Create a Workload Identity pool and provider restricted to this repository and to `refs/heads/main` and `refs/tags/v*`. Allow `kuu-deploy` to be impersonated by it.
2. In GitHub, set the repository variables `GCP_PROJECT_ID`, `GCP_REGION`, `GCP_WORKLOAD_IDENTITY_PROVIDER`, `GCP_DEPLOY_SERVICE_ACCOUNT`, `CLOUD_RUN_SERVICE=kuu`.
3. Protect the `production` environment with a required reviewer.

The `deploy-cloud-run` job will fail on the first run, because the service does not exist yet and `gcloud run deploy` needs the full flags once. Create the service by hand in Step 4. After that, CI only swaps the image.

**Done when:** a push to `main` copies the image into Artifact Registry.

## Step 4. First deployment, no public traffic yet (1 hour)

1. Run the full `gcloud run deploy` command from DEPLOY_CLOUD_RUN.md with the digest CI pushed. Add the Cloud SQL connection to the `kuu-run` service-account bindings and the secrets.
2. Open the `*.run.app` URL. Check `/api/health`, then sign up, create a workspace, upload a file, and confirm the object appears in the bucket.
3. In the logs, confirm entries have real severities (the JSON log format) and that startup shows no configuration error.
4. Set `SOFTEX_OPERATOR_EMAILS` to your address and `SOFTEX_REGISTRATION=first` for now, so only you can create the first workspace while you test. Set it back to `open` at launch (Step 9).
5. Set the startup probe to `/api/health` with a generous timeout. Migrations run on first boot.

**Done when:** you can use the whole app on the `run.app` URL.

## Step 5. Domain mapping (1 hour plus DNS wait)

1. Verify domain ownership for the Google account that owns the project (Search Console, or `gcloud domains verify`) **(verify current requirement)**.
2. `gcloud beta run domain-mappings create --service=kuu --domain=app.<domain> --region=REGION`.
3. In Cloudflare, add the records shown by `gcloud beta run domain-mappings describe` (for a subdomain this is a CNAME to `ghs.googlehosted.com`). **Set the record to DNS-only (grey cloud).** A proxied record blocks Google's certificate issuance and defeats the mapping.
4. Wait for the certificate (minutes to an hour). Then update the service: `SOFTEX_PUBLIC_URL=https://app.<domain>`, `SOFTEX_TRUST_PROXY=1`, and redeploy.
5. Check from outside: HTTPS loads, HTTP redirects, the `Strict-Transport-Security` header is present, WebSockets connect (open two browsers and watch live typing).
6. Confirm the real client IP appears in the audit log, not a Google address. If every user shows one IP, the proxy hop count is wrong.

**Done when:** the app works on your domain over WSS with real client IPs.

## Step 6. Staging service (optional but recommended, 30 minutes)

A second Cloud Run service, `kuu-staging`, with min 0, its own database inside the same Cloud SQL instance (`kuu_staging`), and its own bucket prefix. It costs almost nothing when idle. Point CI's `main` deploys at staging and the `v*` tags at production. Run the Playwright suite against it: `PLAYWRIGHT_BASE_URL=... npm run test:e2e` **(check how the config takes a base URL)**.

## Step 7. Load and failure checks (1 to 2 days)

Do this before real users arrive.

1. **Load**: k6 or Artillery against staging with about 1000 WebSockets and a typical REST mix. Record p95 latency, Cloud Run CPU and memory, instance count, and Cloud SQL connections and CPU. Pass: p95 under 500 ms for core reads, memory under 70%, DB connections under 70% of the max.
2. **Two instances**: force a second instance (lower concurrency temporarily) and confirm realtime events, presence and sign-out reach clients on both.
3. **Deploy during use**: keep several browsers connected and deploy. They should reconnect within seconds and lose no messages (the app refetches after reconnect).
4. **Upload limit**: a 24 MB file succeeds and a 26 MB file gets a clear error. Test through the real domain.
5. **Restore drill**: restore a Cloud SQL backup to a scratch instance, point a local `SOFTEX_DATABASE_URL` at it, and sign in. Write down how long it took.
6. **Email**: sign-up verification, invite and password reset arrive and are not marked spam.

**Done when:** the numbers above are met and the restore drill is written up.

## Step 8. Operations setup (half a day)

1. Cloud Monitoring uptime check on `https://app.<domain>/api/health` from multiple regions, alerting to your email or chat.
2. Alerts: Cloud Run 5xx rate, instance memory above 80%, Cloud SQL CPU above 80% and connections above 70%, and the budget.
3. A short runbook: how to roll back (shift traffic to the previous revision), how to rotate the DB password, who is on call.
4. Check the legal pages, `SOFTEX_COMPANY_*`, `SOFTEX_SUPPORT_EMAIL`, the USD prices (`SOFTEX_PRICE_*`) and payment instructions end to end.

## Step 9. Launch

1. Take a manual Cloud SQL backup.
2. Set `SOFTEX_REGISTRATION=open` and redeploy.
3. Watch the dashboards for the first day. Check the audit log for the real client IPs and for sign-up abuse.
4. After a week inside the targets, review actual cost against the $70 ceiling.

## Rollback

- **Bad release:** `gcloud run services update-traffic kuu --to-revisions=PREVIOUS=100`. No rebuild. Schema changes must stay backward compatible so the previous revision still runs.
- **Bad data:** restore from Cloud SQL point-in-time recovery into a new instance and repoint `kuu-db-url`.
- **Domain problem:** the `*.run.app` URL keeps working, and `SOFTEX_PUBLIC_URL` can be changed back.

## After launch (not blocking)

Penetration test focused on tenant isolation; a key-versioning scheme for `SOFTEX_SECRET_KEY`; splitting background jobs into a separate worker service when job runs affect request latency; and moving to a load balancer with Cloud Armor if abuse appears.
