# =============================================================================
# Proxmox Provider Configuration
# =============================================================================
# Uses bpg/proxmox provider (actively maintained, feature-rich)
# Docs: https://registry.terraform.io/providers/bpg/proxmox/latest/docs
# =============================================================================

terraform {
  required_version = ">= 1.0"

  required_providers {
    proxmox = {
      source  = "bpg/proxmox"
      version = "~> 0.38"
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

provider "proxmox" {
  endpoint = var.proxmox_url
  username = var.proxmox_user
  password = var.proxmox_password
  insecure = var.proxmox_insecure  # Allow self-signed certificates (lab)

  ssh {
    agent    = true
    username = "root"
  }
}
