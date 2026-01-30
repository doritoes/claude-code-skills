# =============================================================================
# XenOrchestra Connection
# =============================================================================

variable "xo_url" {
  description = "Xen Orchestra WebSocket URL"
  type        = string
  default     = "wss://192.168.99.206"
}

variable "xo_username" {
  description = "Xen Orchestra username"
  type        = string
  sensitive   = true
}

variable "xo_password" {
  description = "Xen Orchestra password"
  type        = string
  sensitive   = true
}

# =============================================================================
# Infrastructure Naming
# =============================================================================

variable "project_name" {
  description = "Project name prefix for all resources"
  type        = string
  default     = "hashcrack"
}

variable "environment" {
  description = "Environment name (lab, prod)"
  type        = string
  default     = "lab"
}

# =============================================================================
# XCP-ng Resources
# =============================================================================

variable "pool_name" {
  description = "XCP-ng pool name"
  type        = string
  default     = "xcp-ng-lab1"
}

variable "template_name" {
  description = "Ubuntu 24.04 cloud-init template name"
  type        = string
  default     = "Ubuntu 24.04 Cloud-Init (Hub)"
}

variable "network_name" {
  description = "Network for VMs"
  type        = string
  default     = "Pool-wide network associated with eth0"
}

variable "sr_name" {
  description = "Storage repository name"
  type        = string
  default     = "Local storage"
}

# =============================================================================
# Hashtopolis Server Configuration
# =============================================================================

variable "server_cpus" {
  description = "Number of vCPUs for Hashtopolis server"
  type        = number
  default     = 2
}

variable "server_memory_gb" {
  description = "RAM in GB for Hashtopolis server"
  type        = number
  default     = 4
}

variable "server_disk_gb" {
  description = "Disk size in GB for Hashtopolis server"
  type        = number
  default     = 250
}

# =============================================================================
# Worker Configuration
# =============================================================================

variable "worker_count" {
  description = "Number of worker VMs to create"
  type        = number
  default     = 2
}

variable "worker_cpus" {
  description = "Number of vCPUs per worker"
  type        = number
  default     = 4
}

variable "worker_memory_gb" {
  description = "RAM in GB per worker"
  type        = number
  default     = 4
}

variable "worker_disk_gb" {
  description = "Disk size in GB per worker"
  type        = number
  default     = 30
}

# =============================================================================
# Hashtopolis Configuration
# =============================================================================

variable "hashtopolis_admin_user" {
  description = "Hashtopolis admin username"
  type        = string
  default     = "hashcrack"
}

variable "hashtopolis_admin_password" {
  description = "Hashtopolis admin password"
  type        = string
  sensitive   = true
  default     = "" # Generated if empty
}

variable "hashtopolis_db_password" {
  description = "Hashtopolis database password"
  type        = string
  sensitive   = true
  default     = "" # Generated if empty
}

variable "worker_voucher" {
  description = "Voucher code for worker registration"
  type        = string
  default     = "" # Generated if empty
}

# =============================================================================
# SSH Configuration
# =============================================================================

variable "ssh_public_key" {
  description = "SSH public key for VM access"
  type        = string
  default     = ""
}

variable "ssh_user" {
  description = "SSH username for VM access"
  type        = string
  default     = "ubuntu"
}
