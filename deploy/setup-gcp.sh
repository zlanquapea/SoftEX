#!/usr/bin/env bash
# Creates Küü's Google Cloud foundation with gcloud: the same resources as deploy/terraform, for people who
# prefer a script. Safe to re-run: each step checks whether the thing already exists.
# Use ONE of the two for a given project. Mixing them makes Terraform try to create what the script made.
#
# Required:  PROJECT_ID  REGION  DOMAIN
# Optional:  BILLING_ACCOUNT (links billing and creates the budget)   GITHUB_REPO (default zlanquapea/softex)
#            DB_TIER (db-f1-micro)  MAX_INSTANCES (2)  REGISTRATION (first)  OPERATOR_EMAILS
#            BUCKET (<project>-kuu-files)  MONTHLY_BUDGET_USD (70)  CREATE_PROJECT=1 to create the project
set -euo pipefail

: "${PROJECT_ID:?set PROJECT_ID}" "${REGION:?set REGION}" "${DOMAIN:?set DOMAIN, e.g. app.example.com}"
GITHUB_REPO="${GITHUB_REPO:-zlanquapea/softex}"
DB_TIER="${DB_TIER:-db-f1-micro}"
MAX_INSTANCES="${MAX_INSTANCES:-2}"
REGISTRATION="${REGISTRATION:-first}"
OPERATOR_EMAILS="${OPERATOR_EMAILS:-}"
BUCKET="${BUCKET:-${PROJECT_ID}-kuu-files}"
MONTHLY_BUDGET_USD="${MONTHLY_BUDGET_USD:-70}"
RUN_SA="kuu-run@${PROJECT_ID}.iam.gserviceaccount.com"
DEPLOY_SA="kuu-deploy@${PROJECT_ID}.iam.gserviceaccount.com"
CONNECTION="${PROJECT_ID}:${REGION}:kuu-db"

step() { printf '\n==> %s\n' "$*"; }
exists() { "$@" >/dev/null 2>&1; }
gc() { gcloud --project "$PROJECT_ID" --quiet "$@"; }

# ---------------------------------------------------------------- 1. project, billing, APIs
step "Project and APIs"
if [ "${CREATE_PROJECT:-0}" = 1 ] && ! exists gcloud projects describe "$PROJECT_ID"; then
  gcloud projects create "$PROJECT_ID" --quiet
fi
if [ -n "${BILLING_ACCOUNT:-}" ]; then
  gcloud billing projects link "$PROJECT_ID" --billing-account "$BILLING_ACCOUNT" --quiet
fi
gc services enable run.googleapis.com sqladmin.googleapis.com secretmanager.googleapis.com \
  artifactregistry.googleapis.com storage.googleapis.com iamcredentials.googleapis.com iam.googleapis.com \
  cloudresourcemanager.googleapis.com monitoring.googleapis.com billingbudgets.googleapis.com

step "Service accounts"
exists gc iam service-accounts describe "$RUN_SA" || gc iam service-accounts create kuu-run --display-name "Küü runtime"
exists gc iam service-accounts describe "$DEPLOY_SA" || gc iam service-accounts create kuu-deploy --display-name "Küü CI deployer"
gc projects add-iam-policy-binding "$PROJECT_ID" --member "serviceAccount:$RUN_SA" --role roles/cloudsql.client --condition=None >/dev/null
gc projects add-iam-policy-binding "$PROJECT_ID" --member "serviceAccount:$DEPLOY_SA" --role roles/run.developer --condition=None >/dev/null
gc iam service-accounts add-iam-policy-binding "$RUN_SA" --member "serviceAccount:$DEPLOY_SA" --role roles/iam.serviceAccountUser >/dev/null

step "Artifact Registry"
exists gc artifacts repositories describe kuu --location "$REGION" ||
  gc artifacts repositories create kuu --repository-format docker --location "$REGION" --description "Küü container images"
gc artifacts repositories add-iam-policy-binding kuu --location "$REGION" --member "serviceAccount:$DEPLOY_SA" --role roles/artifactregistry.writer >/dev/null
# Keep storage flat: newest 15 versions are kept, anything else older than 30 days is deleted.
POLICY="$(mktemp)"
cat >"$POLICY" <<'JSON'
[
  {"name": "keep-recent", "action": {"type": "Keep"}, "mostRecentVersions": {"keepCount": 15}},
  {"name": "delete-older", "action": {"type": "Delete"}, "condition": {"olderThan": "2592000s"}}
]
JSON
gc artifacts repositories set-cleanup-policies kuu --location "$REGION" --policy "$POLICY" >/dev/null
rm -f "$POLICY"

# ---------------------------------------------------------------- 2. data stores and secrets
step "Cloud SQL (PostgreSQL 17, backups and point-in-time recovery on)"
DB_CREATED=0
if ! exists gc sql instances describe kuu-db; then
  gc sql instances create kuu-db --database-version POSTGRES_17 --edition ENTERPRISE --tier "$DB_TIER" \
    --region "$REGION" --availability-type ZONAL --storage-size 10GB --storage-auto-increase \
    --backup-start-time 03:00 --enable-point-in-time-recovery --retained-backups-count 7 \
    --retained-transaction-log-days 7 --ssl-mode ENCRYPTED_ONLY \
    --maintenance-window-day SUN --maintenance-window-hour 4 --insights-config-query-insights-enabled \
    --deletion-protection
  DB_CREATED=1
fi
exists gc sql databases describe kuu --instance kuu-db || gc sql databases create kuu --instance kuu-db

step "Bucket for uploaded files"
exists gc storage buckets describe "gs://$BUCKET" ||
  gc storage buckets create "gs://$BUCKET" --location "$REGION" --uniform-bucket-level-access --public-access-prevention
gc storage buckets update "gs://$BUCKET" --versioning --soft-delete-duration=7d >/dev/null
LIFECYCLE="$(mktemp)"
echo '{"rule":[{"action":{"type":"Delete"},"condition":{"daysSinceNoncurrentTime":30}}]}' >"$LIFECYCLE"
gc storage buckets update "gs://$BUCKET" --lifecycle-file "$LIFECYCLE" >/dev/null
rm -f "$LIFECYCLE"
gc storage buckets add-iam-policy-binding "gs://$BUCKET" --member "serviceAccount:$RUN_SA" --role roles/storage.objectUser >/dev/null

step "Secrets"
make_secret() { exists gc secrets describe "$1" || gc secrets create "$1" --replication-policy automatic; }
make_secret kuu-db-url
make_secret kuu-secret-key
if [ "$DB_CREATED" = 1 ]; then
  # The password is generated here, written straight to Secret Manager and never printed.
  DB_PASSWORD="$(openssl rand -hex 24)"
  gc sql users create kuu --instance kuu-db --password "$DB_PASSWORD"
  printf '%s' "postgres://kuu:${DB_PASSWORD}@localhost/kuu?host=/cloudsql/${CONNECTION}" | gc secrets versions add kuu-db-url --data-file=-
  unset DB_PASSWORD
elif ! exists gc secrets versions describe latest --secret kuu-db-url; then
  echo "The database exists but kuu-db-url has no value. Set the kuu user's password and add the URL by hand (see docs/DEPLOY_CLOUD_RUN.md)." >&2
  exit 1
fi
if ! exists gc secrets versions describe latest --secret kuu-secret-key; then
  openssl rand -hex 32 | tr -d '\n' | gc secrets versions add kuu-secret-key --data-file=-
  echo "!! Copy kuu-secret-key to a password manager now. Losing it makes stored SSO secrets unreadable:"
  echo "   gcloud secrets versions access latest --secret kuu-secret-key --project $PROJECT_ID"
fi
for secret in kuu-db-url kuu-secret-key; do
  gc secrets add-iam-policy-binding "$secret" --member "serviceAccount:$RUN_SA" --role roles/secretmanager.secretAccessor >/dev/null
done

# ---------------------------------------------------------------- 3. GitHub -> GCP without keys
step "Workload Identity Federation for GitHub Actions"
exists gc iam workload-identity-pools describe github --location global ||
  gc iam workload-identity-pools create github --location global --display-name "GitHub Actions"
exists gc iam workload-identity-pools providers describe github --location global --workload-identity-pool github ||
  gc iam workload-identity-pools providers create-oidc github --location global --workload-identity-pool github \
    --issuer-uri https://token.actions.githubusercontent.com \
    --attribute-mapping "google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
    --attribute-condition "assertion.repository == '${GITHUB_REPO}' && (assertion.ref == 'refs/heads/main' || assertion.ref.startsWith('refs/tags/v'))"
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format 'value(projectNumber)')"
POOL="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github"
gc iam service-accounts add-iam-policy-binding "$DEPLOY_SA" --role roles/iam.workloadIdentityUser \
  --member "principalSet://iam.googleapis.com/${POOL}/attribute.repository/${GITHUB_REPO}" >/dev/null

# ---------------------------------------------------------------- 4. Cloud Run service (sample image until CI deploys)
step "Cloud Run service"
# The sample image makes the service exist with every setting in place. CI then deploys the real image by digest,
# which keeps these settings. The server only listens after migrating, so a TCP startup probe means "ready".
gc run deploy kuu --region "$REGION" --image us-docker.pkg.dev/cloudrun/container/hello \
  --service-account "$RUN_SA" --allow-unauthenticated --ingress all \
  --cpu 1 --memory 1Gi --no-cpu-throttling --cpu-boost \
  --min-instances 1 --max-instances "$MAX_INSTANCES" --concurrency 1000 --timeout 3600 \
  --add-cloudsql-instances "$CONNECTION" \
  --startup-probe "tcpSocket.port=8080,periodSeconds=5,timeoutSeconds=3,failureThreshold=36" \
  --set-env-vars "^|^NODE_ENV=production|SOFTEX_MODE=saas|SOFTEX_PUBLIC_URL=https://${DOMAIN}|SOFTEX_SECURE_COOKIES=true|SOFTEX_TRUST_PROXY=1|SOFTEX_DB_POOL_SIZE=5|SOFTEX_GCS_BUCKET=${BUCKET}|SOFTEX_MAX_UPLOAD_MB=25|SOFTEX_DATA_DIR=/tmp/kuu|SOFTEX_REGISTRATION=${REGISTRATION}|SOFTEX_OPERATOR_EMAILS=${OPERATOR_EMAILS}" \
  --set-secrets "SOFTEX_DATABASE_URL=kuu-db-url:latest,SOFTEX_SECRET_KEY=kuu-secret-key:latest"

# ---------------------------------------------------------------- 5. budget
if [ -n "${BILLING_ACCOUNT:-}" ]; then
  step "Budget alerts (50%, 80%, 100% of \$${MONTHLY_BUDGET_USD})"
  if gcloud billing budgets list --billing-account "$BILLING_ACCOUNT" --filter "displayName=Küü monthly" --format 'value(name)' | grep -q .; then
    echo "Budget already exists."
  else
    gcloud billing budgets create --billing-account "$BILLING_ACCOUNT" --display-name "Küü monthly" \
      --filter-projects "projects/${PROJECT_ID}" --budget-amount "${MONTHLY_BUDGET_USD}USD" \
      --threshold-rule percent=0.5 --threshold-rule percent=0.8 --threshold-rule percent=1.0
  fi
fi

cat <<DONE

Done. Next:
1. Set these GitHub repository variables:
     GCP_PROJECT_ID=$PROJECT_ID
     GCP_REGION=$REGION
     GCP_WORKLOAD_IDENTITY_PROVIDER=${POOL}/providers/github
     GCP_DEPLOY_SERVICE_ACCOUNT=$DEPLOY_SA
     CLOUD_RUN_SERVICE=kuu
2. Verify $DOMAIN for your Google account, then map it (see docs/CLOUD_RUN_MIGRATION_PLAN.md, Step 5):
     gcloud beta run domain-mappings create --service kuu --domain $DOMAIN --region $REGION --project $PROJECT_ID
   and add the DNS records it prints in Cloudflare as DNS-only (grey cloud).
3. Push to main so CI deploys the real image.
DONE
