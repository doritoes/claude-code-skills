# =============================================================================
# Oracle Cloud Infrastructure (OCI) Provider Configuration
# =============================================================================

terraform {
  required_version = ">= 1.0.0"

  required_providers {
    oci = {
      source  = "oracle/oci"
      version = ">= 5.0.0"
    }
    random = {
      source  = "hashicorp/random"
      version = ">= 3.0.0"
    }
    time = {
      source  = "hashicorp/time"
      version = ">= 0.9.0"
    }
  }
}

# =============================================================================
# OCI Provider
# Authentication via:
#   1. API Key (~/.oci/config) - recommended
#   2. Instance Principal (for running on OCI compute)
#   3. Environment variables (OCI_TENANCY_OCID, etc.)
# =============================================================================

provider "oci" {
  tenancy_ocid     = var.tenancy_ocid
  user_ocid        = var.user_ocid
  fingerprint      = var.fingerprint
  private_key_path = var.private_key_path
  region           = var.region
}
