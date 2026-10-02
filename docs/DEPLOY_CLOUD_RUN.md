# Deploying Küü on Google Cloud Run

Reference for the settings Küü needs on Cloud Run. The full plan and the reasons are in [GO_LIVE_ROADMAP.md](GO_LIVE_ROADMAP.md).

## Service settings

```bash
gcloud run deploy kuu \
  --image=REGION-docker.pkg.dev/PROJECT/kuu/kuu@sha256:DIGEST \
  --region=REGION \
  --service-account=kuu-run@PROJECT.iam.gserviceaccount.com \
  --allow-unauthenticated --ingress=all \
  --cpu=1 --memory=1Gi --no-cpu-throttling \
  --min-instances=1 --max-instances=2 \
  --concurrency=1000 --timeout=3600 \
  --add-cloudsql-instances=PROJECT:REGION:kuu-db \
  --set-env-vars=NODE_ENV=production,SOFTEX_MODE=saas,SOFTEX_PUBLIC_URL=https://YOUR.DOMAIN,SOFTEX_SECURE_COOKIES=true,SOFTEX_TRUST_PROXY=1,SOFTEX_DB_POOL_SIZE=5,SOFTEX_GCS_BUCKET=YOUR-BUCKET,SOFTEX_MAX_UPLOAD_MB=25,SOFTEX_DATA_DIR=/tmp/kuu \
  --set-secrets=SOFTEX_DATABASE_URL=kuu-db-url:latest,SOFTEX_SECRET_KEY=kuu-secret-key:latest
```

- Every open WebSocket counts toward `--concurrency` (maximum 1000), so one instance cannot hold about 1k sockets and also serve normal requests. Keep max-instances at 2 or more.
- `--timeout=3600` is the longest a WebSocket lives before the browser reconnects, which the client does automatically.
- Uploads are staged under `SOFTEX_DATA_DIR`, which is in-memory on Cloud Run, then moved to the bucket. A 25 MB upload briefly uses 25 MB of the instance's memory.
- The app refuses to start on Cloud Run (it detects `K_SERVICE`) if it has no PostgreSQL URL, no bucket, an `http://` public URL or insecure cookies.

## Database URL (Cloud SQL socket)

Cloud Run mounts the instance at `/cloudsql/<connection name>`. Node's URL parser rejects an empty host, so use `localhost` as a placeholder; `host` in the query string wins:

```
postgres://kuu:URL_ENCODED_PASSWORD@localhost/kuu?host=/cloudsql/PROJECT:REGION:kuu-db
```

Budget connections: `SOFTEX_DB_POOL_SIZE x max-instances`, plus one `LISTEN` connection per instance, must stay below Cloud SQL's `max_connections` (about 25 on `db-f1-micro`; check the flag value).

## Service accounts

- Runtime (`kuu-run`): `roles/cloudsql.client`, `roles/storage.objectUser` on the one bucket, `roles/secretmanager.secretAccessor` on its two secrets.
- Deployer (used by CI through Workload Identity Federation): `roles/run.developer`, `roles/iam.serviceAccountUser` on `kuu-run`, `roles/artifactregistry.writer`.

## CI

[docker.yml](../.github/workflows/docker.yml) has a `deploy-cloud-run` job that does nothing until the repository variable `GCP_PROJECT_ID` is set. Also set `GCP_REGION`, `GCP_WORKLOAD_IDENTITY_PROVIDER`, `GCP_DEPLOY_SERVICE_ACCOUNT` and (optionally) `CLOUD_RUN_SERVICE`. The job copies the scanned image by digest into Artifact Registry and deploys that digest.
