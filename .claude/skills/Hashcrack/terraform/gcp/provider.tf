# =============================================================================
# GCP Provider Configuration
# =============================================================================

terraform {
  required_version = ">= 1.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.0"
    }
    time = {
      source  = "hashicorp/time"
      version = "~> 0.9"
    }
  }
}

provider "google" {
  project = var.gcp_project
  region  = var.gcp_region
  zone    = var.gcp_zone

  # Credentials from environment variable:
  # GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
  # Or use: gcloud auth application-default login
}
