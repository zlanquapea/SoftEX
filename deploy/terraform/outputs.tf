output "service_url" {
  description = "The run.app address (works before the domain is ready)."
  value       = google_cloud_run_v2_service.kuu.uri
}

output "dns_records" {
  description = "Add these in Cloudflare as DNS-only (grey cloud) records."
  value       = var.create_domain_mapping ? google_cloud_run_domain_mapping.app[0].status[0].resource_records : []
}

output "db_connection_name" {
  value = google_sql_database_instance.main.connection_name
}

output "bucket" {
  value = google_storage_bucket.files.name
}

output "github_variables" {
  description = "Set these as repository variables in GitHub (Settings, Secrets and variables, Actions, Variables)."
  value = {
    GCP_PROJECT_ID                 = var.project_id
    GCP_REGION                     = var.region
    GCP_WORKLOAD_IDENTITY_PROVIDER = google_iam_workload_identity_pool_provider.github.name
    GCP_DEPLOY_SERVICE_ACCOUNT     = google_service_account.deploy.email
    CLOUD_RUN_SERVICE              = google_cloud_run_v2_service.kuu.name
  }
}
