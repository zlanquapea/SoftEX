terraform {
  required_version = ">= 1.6"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # State contains the generated database password and SECRET_KEY. Keep it in a private bucket, not in git:
  #   backend "gcs" { bucket = "YOUR-STATE-BUCKET", prefix = "kuu" }
  # Create that bucket by hand first (versioning on, public access prevention on).
}

provider "google" {
  project = var.project_id
  region  = var.region
}
