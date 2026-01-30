# =============================================================================
# Hashcrack Azure Terraform Variables
# =============================================================================

variable "azure_location" {
  description = "Azure region for deployment"
  type        = string
  default     = "eastus"
}

variable "project_name" {
  description = "Project name used for resource naming"
  type        = string
  default     = "hashcrack"
}

variable "environment" {
  description = "Environment tag (lab, dev, prod)"
  type        = string
  default     = "lab"
}

# =============================================================================
# Server Configuration
# =============================================================================

variable "server_vm_size" {
  description = "Azure VM size for Hashtopolis server"
  type        = string
  default     = "Standard_B2s"  # 2 vCPU, 4 GB RAM - similar to t3.medium
}

variable "server_disk_gb" {
  description = "Server OS disk size in GB"
  type        = number
  default     = 250
}

# =============================================================================
# Worker Configuration
# =============================================================================

variable "cpu_worker_count" {
  description = "Number of CPU worker VMs"
  type        = number
  default     = 0
}

variable "cpu_worker_vm_size" {
  description = "Azure VM size for CPU workers"
  type        = string
  default     = "Standard_F4s_v2"  # 4 vCPU, 8 GB RAM - compute optimized
}

variable "gpu_worker_count" {
  description = "Number of GPU worker VMs"
  type        = number
  default     = 0
}

variable "gpu_worker_vm_size" {
  description = "Azure VM size for GPU workers"
  type        = string
  default     = "Standard_NC4as_T4_v3"  # Tesla T4 GPU, similar to g4dn.xlarge
}

variable "worker_disk_gb" {
  description = "Worker OS disk size in GB"
  type        = number
  default     = 50
}

variable "use_spot_instances" {
  description = "Use Azure Spot VMs for workers (significant cost savings)"
  type        = bool
  default     = false  # On-demand by default for GPU reliability
}

variable "spot_max_price" {
  description = "Maximum price for spot instances (-1 = on-demand price)"
  type        = number
  default     = -1
}

# =============================================================================
# SSH Configuration
# =============================================================================

variable "ssh_public_key" {
  description = "SSH public key for VM access"
  type        = string
}

variable "ssh_user" {
  description = "SSH username for VMs"
  type        = string
  default     = "ubuntu"
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
  description = "Hashtopolis admin password (avoid special chars for cloud-init)"
  type        = string
  default     = "Hashcrack2025Lab"
  sensitive   = true
}

variable "worker_voucher" {
  description = "Voucher code for worker registration"
  type        = string
  default     = "YOURPAIVOUCHER"
}

# =============================================================================
# Network Configuration
# =============================================================================

variable "vnet_cidr" {
  description = "CIDR block for Virtual Network"
  type        = string
  default     = "10.0.0.0/16"
}

variable "subnet_cidr" {
  description = "CIDR block for subnet"
  type        = string
  default     = "10.0.1.0/24"
}

variable "allowed_ssh_cidr" {
  description = "CIDR blocks allowed for SSH access"
  type        = list(string)
  default     = ["0.0.0.0/0"]  # Restrict in production
}
