variable "project_id" {
  description = "An existing GCP project with billing linked (gcloud projects create ...)."
  type        = string
}

variable "region" {
  description = "Region for Cloud Run, Cloud SQL and the bucket. Must support Cloud Run domain mappings."
  type        = string
}

variable "domain" {
  description = "Hostname users visit, for example app.example.com. Use a subdomain."
  type        = string
}

variable "create_domain_mapping" {
  description = "Create the Cloud Run domain mapping. Needs the domain verified for your Google account first; set false until then."
  type        = bool
  default     = true
}

variable "github_repo" {
  description = "owner/name of the GitHub repository allowed to deploy through Workload Identity Federation."
  type        = string
  default     = "zlanquapea/softex"
}

variable "billing_account" {
  description = "Billing account ID (XXXXXX-XXXXXX-XXXXXX) for the budget alerts. Leave empty to skip the budget."
  type        = string
  default     = ""
}

variable "monthly_budget_usd" {
  type    = number
  default = 70
}

variable "db_tier" {
  description = "Cloud SQL machine tier. db-f1-micro is shared-core with no SLA; db-g1-small is the next step up."
  type        = string
  default     = "db-f1-micro"
}

variable "db_storage_gb" {
  type    = number
  default = 10
}

variable "bucket_name" {
  description = "Bucket for uploaded files. Defaults to <project>-kuu-files."
  type        = string
  default     = ""
}

variable "registration" {
  description = "SOFTEX_REGISTRATION: keep 'first' until launch (only the first workspace can be created), then 'open'."
  type        = string
  default     = "first"
}

variable "operator_emails" {
  description = "SOFTEX_OPERATOR_EMAILS: comma-separated addresses that get the operator console."
  type        = string
  default     = ""
}

variable "max_instances" {
  description = "Cloud Run max instances. Every open WebSocket counts toward the 1000-request concurrency, so keep this at 2 or more."
  type        = number
  default     = 2
}

variable "extra_env" {
  description = "Further SOFTEX_* settings as plain environment variables (company details, prices, mail sender...). Secrets do not belong here."
  type        = map(string)
  default     = {}
}

variable "secret_env" {
  description = "Extra secrets created by hand in Secret Manager, as ENV_NAME = secret name, for example { SOFTEX_SMTP_URL = \"kuu-smtp\", ANTHROPIC_API_KEY = \"kuu-anthropic\" }. Create each secret and its first version before applying."
  type        = map(string)
  default     = {}
}
