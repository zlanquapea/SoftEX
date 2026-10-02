locals {
  apis = [
    "run.googleapis.com",
    "sqladmin.googleapis.com",
    "secretmanager.googleapis.com",
    "artifactregistry.googleapis.com",
    "storage.googleapis.com",
    "iamcredentials.googleapis.com",
    "iam.googleapis.com",
    "cloudresourcemanager.googleapis.com",
    "monitoring.googleapis.com",
    "billingbudgets.googleapis.com",
  ]
  bucket_name = var.bucket_name != "" ? var.bucket_name : "${var.project_id}-kuu-files"
  public_url  = "https://${var.domain}"
  # Cloud Run mounts the instance at /cloudsql/<connection name>. "localhost" is a placeholder: Node rejects an empty host.
  db_url = "postgres://kuu:${random_password.db.result}@localhost/kuu?host=/cloudsql/${google_sql_database_instance.main.connection_name}"
}

resource "google_project_service" "apis" {
  for_each           = toset(local.apis)
  service            = each.value
  disable_on_destroy = false
}

# ----------------------------------------------------------------------------- service accounts

resource "google_service_account" "run" {
  account_id   = "kuu-run"
  display_name = "Küü runtime"
  depends_on   = [google_project_service.apis]
}

resource "google_service_account" "deploy" {
  account_id   = "kuu-deploy"
  display_name = "Küü CI deployer"
  depends_on   = [google_project_service.apis]
}

resource "google_project_iam_member" "run_sql_client" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.run.email}"
}

resource "google_project_iam_member" "deploy_run_developer" {
  project = var.project_id
  role    = "roles/run.developer"
  member  = "serviceAccount:${google_service_account.deploy.email}"
}

resource "google_service_account_iam_member" "deploy_acts_as_run" {
  service_account_id = google_service_account.run.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.deploy.email}"
}

# ----------------------------------------------------------------------------- artifact registry

resource "google_artifact_registry_repository" "kuu" {
  repository_id = "kuu"
  location      = var.region
  format        = "DOCKER"
  description   = "Küü container images"

  # Keep storage cost flat: only the 15 newest versions are kept.
  cleanup_policies {
    id     = "keep-recent"
    action = "KEEP"
    most_recent_versions {
      keep_count = 15
    }
  }
  cleanup_policies {
    id     = "delete-older"
    action = "DELETE"
    condition {
      older_than = "2592000s" # 30 days
    }
  }

  depends_on = [google_project_service.apis]
}

resource "google_artifact_registry_repository_iam_member" "deploy_writer" {
  repository = google_artifact_registry_repository.kuu.name
  location   = var.region
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${google_service_account.deploy.email}"
}

# ----------------------------------------------------------------------------- Cloud SQL

resource "random_password" "db" {
  length  = 32
  special = false # keeps the connection URL free of characters that need escaping
}

resource "google_sql_database_instance" "main" {
  name                = "kuu-db"
  region              = var.region
  database_version    = "POSTGRES_17"
  deletion_protection = true

  settings {
    tier                        = var.db_tier
    edition                     = "ENTERPRISE"
    availability_type           = "ZONAL"
    disk_size                   = var.db_storage_gb
    disk_autoresize             = true
    deletion_protection_enabled = true

    backup_configuration {
      enabled                        = true
      start_time                     = "03:00"
      point_in_time_recovery_enabled = true
      transaction_log_retention_days = 7
      backup_retention_settings {
        retained_backups = 7
      }
    }

    # Reached only through the Cloud SQL socket from Cloud Run; no network is authorised.
    ip_configuration {
      ipv4_enabled = true
      ssl_mode     = "ENCRYPTED_ONLY"
    }

    maintenance_window {
      day  = 7
      hour = 4
    }

    insights_config {
      query_insights_enabled = true
    }
  }

  depends_on = [google_project_service.apis]
}

resource "google_sql_database" "kuu" {
  name     = "kuu"
  instance = google_sql_database_instance.main.name
}

resource "google_sql_user" "kuu" {
  name     = "kuu"
  instance = google_sql_database_instance.main.name
  password = random_password.db.result
}

# ----------------------------------------------------------------------------- bucket for uploads

resource "google_storage_bucket" "files" {
  name                        = local.bucket_name
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false

  versioning {
    enabled = true
  }
  soft_delete_policy {
    retention_duration_seconds = 604800 # 7 days
  }
  lifecycle_rule {
    condition {
      days_since_noncurrent_time = 30
    }
    action {
      type = "Delete"
    }
  }

  depends_on = [google_project_service.apis]
}

resource "google_storage_bucket_iam_member" "run_objects" {
  bucket = google_storage_bucket.files.name
  role   = "roles/storage.objectUser"
  member = "serviceAccount:${google_service_account.run.email}"
}

# ----------------------------------------------------------------------------- secrets

resource "random_id" "secret_key" {
  byte_length = 32
}

resource "google_secret_manager_secret" "db_url" {
  secret_id = "kuu-db-url"
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "db_url" {
  secret      = google_secret_manager_secret.db_url.id
  secret_data = local.db_url
}

resource "google_secret_manager_secret" "secret_key" {
  secret_id = "kuu-secret-key"
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "secret_key" {
  secret      = google_secret_manager_secret.secret_key.id
  secret_data = random_id.secret_key.hex
}

resource "google_secret_manager_secret_iam_member" "run_reads" {
  for_each = {
    db_url     = google_secret_manager_secret.db_url.id
    secret_key = google_secret_manager_secret.secret_key.id
  }
  secret_id = each.value
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.run.email}"
}

resource "google_secret_manager_secret_iam_member" "run_reads_extra" {
  for_each  = toset(values(var.secret_env))
  secret_id = each.value
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.run.email}"
}

# ----------------------------------------------------------------------------- GitHub -> GCP (Workload Identity Federation)

resource "google_iam_workload_identity_pool" "github" {
  workload_identity_pool_id = "github"
  display_name              = "GitHub Actions"
  depends_on                = [google_project_service.apis]
}

resource "google_iam_workload_identity_pool_provider" "github" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github"
  display_name                       = "GitHub"

  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.repository" = "assertion.repository"
    "attribute.ref"        = "assertion.ref"
  }
  # Only this repository, and only from main or a version tag.
  attribute_condition = "assertion.repository == '${var.github_repo}' && (assertion.ref == 'refs/heads/main' || assertion.ref.startsWith('refs/tags/v'))"

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "google_service_account_iam_member" "github_impersonates_deploy" {
  service_account_id = google_service_account.deploy.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/${var.github_repo}"
}

# ----------------------------------------------------------------------------- Cloud Run service

# Terraform creates the service with Google's sample image so it exists with every setting in place.
# After that CI deploys the real image by digest (`gcloud run deploy --image`), which keeps these settings,
# so the image and CI bookkeeping are ignored below.
resource "google_cloud_run_v2_service" "kuu" {
  name                = "kuu"
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = true

  template {
    service_account                  = google_service_account.run.email
    timeout                          = "3600s"
    max_instance_request_concurrency = 1000

    scaling {
      min_instance_count = 1
      max_instance_count = var.max_instances
    }

    volumes {
      name = "cloudsql"
      cloud_sql_instance {
        instances = [google_sql_database_instance.main.connection_name]
      }
    }

    containers {
      image = "us-docker.pkg.dev/cloudrun/container/hello"

      resources {
        limits = {
          cpu    = "1"
          memory = "1Gi"
        }
        cpu_idle          = false # instance-based CPU: background jobs and the realtime listener keep running
        startup_cpu_boost = true
      }

      volume_mounts {
        name       = "cloudsql"
        mount_path = "/cloudsql"
      }

      # The server only starts listening after the database is migrated, so an open port means ready.
      startup_probe {
        tcp_socket {
          port = 8080
        }
        period_seconds    = 5
        timeout_seconds   = 3
        failure_threshold = 36
      }

      dynamic "env" {
        for_each = merge(
          {
            NODE_ENV               = "production"
            SOFTEX_MODE            = "saas"
            SOFTEX_PUBLIC_URL      = local.public_url
            SOFTEX_SECURE_COOKIES  = "true"
            SOFTEX_TRUST_PROXY     = "1"
            SOFTEX_DB_POOL_SIZE    = "5"
            SOFTEX_GCS_BUCKET      = google_storage_bucket.files.name
            SOFTEX_MAX_UPLOAD_MB   = "25"
            SOFTEX_DATA_DIR        = "/tmp/kuu"
            SOFTEX_REGISTRATION    = var.registration
            SOFTEX_OPERATOR_EMAILS = var.operator_emails
          },
          var.extra_env,
        )
        content {
          name  = env.key
          value = env.value
        }
      }

      dynamic "env" {
        for_each = var.secret_env
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }

      env {
        name = "SOFTEX_DATABASE_URL"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.db_url.secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "SOFTEX_SECRET_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.secret_key.secret_id
            version = "latest"
          }
        }
      }
    }
  }

  lifecycle {
    ignore_changes = [
      client,
      client_version,
      template[0].revision,
      template[0].labels,
      template[0].containers[0].image,
    ]
  }

  depends_on = [
    google_secret_manager_secret_version.db_url,
    google_secret_manager_secret_version.secret_key,
    google_secret_manager_secret_iam_member.run_reads,
    google_secret_manager_secret_iam_member.run_reads_extra,
    google_project_iam_member.run_sql_client,
    google_sql_database.kuu,
    google_sql_user.kuu,
  ]
}

# Public site; the app does its own authentication. If an org policy blocks allUsers, use a Cloud Run IAM exception.
resource "google_cloud_run_v2_service_iam_member" "public" {
  name     = google_cloud_run_v2_service.kuu.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}

resource "google_cloud_run_domain_mapping" "app" {
  count    = var.create_domain_mapping ? 1 : 0
  name     = var.domain
  location = var.region

  metadata {
    namespace = var.project_id
  }
  spec {
    route_name = google_cloud_run_v2_service.kuu.name
  }
}

# ----------------------------------------------------------------------------- budget

resource "google_billing_budget" "monthly" {
  count           = var.billing_account != "" ? 1 : 0
  billing_account = var.billing_account
  display_name    = "Küü monthly"

  budget_filter {
    projects = ["projects/${var.project_id}"]
  }
  amount {
    specified_amount {
      currency_code = "USD"
      units         = tostring(var.monthly_budget_usd)
    }
  }
  threshold_rules {
    threshold_percent = 0.5
  }
  threshold_rules {
    threshold_percent = 0.8
  }
  threshold_rules {
    threshold_percent = 1.0
  }

  depends_on = [google_project_service.apis]
}
