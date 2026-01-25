# =============================================================================
# Folding@Cloud GCP Variables - One-Shot GPU
# =============================================================================

# -----------------------------------------------------------------------------
# GCP Configuration
# -----------------------------------------------------------------------------

variable "gcp_project" {
  description = "GCP project ID"
  type        = string
}

variable "gcp_region" {
  description = "GCP region"
  type        = string
  default     = "us-central1"
}

variable "gcp_zone" {
  description = "GCP zone"
  type        = string
  default     = "us-central1-a"
}

# -----------------------------------------------------------------------------
# Instance Configuration
# -----------------------------------------------------------------------------

variable "machine_type" {
  description = "GCP machine type (must support GPU attachment)"
  type        = string
  default     = "n1-standard-4"  # 4 vCPUs, 15GB RAM - good for T4
}

variable "gpu_type" {
  description = "GPU accelerator type"
  type        = string
  default     = "nvidia-tesla-t4"
}

variable "gpu_count" {
  description = "Number of GPUs to attach"
  type        = number
  default     = 1
}

variable "use_spot" {
  description = "Use spot/preemptible instance (NOT RECOMMENDED - WUs abandoned on preemption)"
  type        = bool
  default     = false  # Never use spot for FAH - WUs get abandoned
}

variable "disk_size_gb" {
  description = "Boot disk size in GB"
  type        = number
  default     = 50
}

# -----------------------------------------------------------------------------
# SSH Configuration
# -----------------------------------------------------------------------------

variable "ssh_user" {
  description = "SSH username"
  type        = string
  default     = "foldingadmin"
}

variable "ssh_public_key" {
  description = "SSH public key for access"
  type        = string
}

# -----------------------------------------------------------------------------
# Folding@Home Configuration
# -----------------------------------------------------------------------------

variable "fah_account_token" {
  description = "FAH account token for authentication"
  type        = string
  sensitive   = true
}

variable "fah_machine_name" {
  description = "Machine name in FAH portal"
  type        = string
  default     = "pai-fold-gpu-gcp"
}

variable "fah_team_id" {
  description = "FAH team ID"
  type        = string
  default     = "245143"
}

variable "fah_passkey" {
  description = "FAH passkey for bonus points"
  type        = string
  sensitive   = true
  default     = ""
}

# -----------------------------------------------------------------------------
# One-Shot Configuration
# -----------------------------------------------------------------------------

variable "one_shot_mode" {
  description = "Enable one-shot mode (finish after 1 WU)"
  type        = bool
  default     = true
}
