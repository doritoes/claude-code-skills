# =============================================================================
# Folding@Cloud Azure Variables
# =============================================================================

variable "project_name" {
  description = "Project name for resource naming"
  type        = string
  default     = "foldingcloud"
}

variable "environment" {
  description = "Environment tag"
  type        = string
  default     = "production"
}

variable "location" {
  description = "Azure region"
  type        = string
  default     = "eastus"
}

# -----------------------------------------------------------------------------
# Worker Configuration
# -----------------------------------------------------------------------------

variable "worker_count" {
  description = "Number of FAH worker VMs"
  type        = number
  default     = 1
}

variable "worker_vm_size" {
  description = "Azure VM size for workers"
  type        = string
  default     = "Standard_D2s_v3"  # 2 vCPU, 8 GB RAM
}

variable "worker_disk_gb" {
  description = "OS disk size in GB"
  type        = number
  default     = 30
}

variable "use_spot_instances" {
  description = "Use Azure Spot VMs for cost savings"
  type        = bool
  default     = true
}

variable "spot_max_price" {
  description = "Maximum price per hour for Spot VMs (-1 = on-demand price)"
  type        = number
  default     = -1
}

# -----------------------------------------------------------------------------
# SSH Configuration
# -----------------------------------------------------------------------------

variable "ssh_user" {
  description = "SSH username for VMs"
  type        = string
  default     = "foldingadmin"
}

variable "ssh_public_key" {
  description = "SSH public key for VM access"
  type        = string
}

# -----------------------------------------------------------------------------
# Folding@Home Configuration
# -----------------------------------------------------------------------------

variable "fah_account_token" {
  description = "FAH account token for headless machine registration"
  type        = string
  sensitive   = true
}

variable "fah_machine_prefix" {
  description = "Prefix for FAH machine names"
  type        = string
  default     = "pai-fold"
}

variable "fah_team_id" {
  description = "FAH team number"
  type        = string
  default     = "0"
}

variable "fah_passkey" {
  description = "FAH passkey for bonus points"
  type        = string
  default     = ""
  sensitive   = true
}
