# =============================================================================
# GCP Configuration
# =============================================================================

variable "gcp_project" {
  description = "GCP project ID"
  type        = string
}

variable "gcp_region" {
  description = "GCP region to deploy to"
  type        = string
  default     = "us-central1"
}

variable "gcp_zone" {
  description = "GCP zone within region"
  type        = string
  default     = "us-central1-a"
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
# Network Configuration
# =============================================================================

variable "network_cidr" {
  description = "CIDR block for VPC subnet"
  type        = string
  default     = "10.0.1.0/24"
}

# =============================================================================
# Hashtopolis Server Configuration
# =============================================================================

variable "server_machine_type" {
  description = "GCP machine type for Hashtopolis server"
  type        = string
  default     = "e2-medium"  # 2 vCPU, 4 GB - sufficient for orchestration
}

variable "server_disk_gb" {
  description = "Boot disk size in GB for Hashtopolis server"
  type        = number
  default     = 50
}

# =============================================================================
# Worker Configuration
# =============================================================================

variable "cpu_worker_count" {
  description = "Number of CPU worker instances to create"
  type        = number
  default     = 2
}

variable "cpu_worker_machine_type" {
  description = "GCP machine type for CPU workers"
  type        = string
  default     = "c2-standard-4"  # 4 vCPU, 16 GB - compute-optimized
}

variable "gpu_worker_count" {
  description = "Number of GPU worker instances to create"
  type        = number
  default     = 0
}

variable "gpu_worker_machine_type" {
  description = "GCP machine type for GPU workers (must support GPU attachment)"
  type        = string
  default     = "n1-standard-4"  # 4 vCPU, 15 GB - required for T4 GPU
}

variable "gpu_type" {
  description = "GPU type to attach to GPU workers"
  type        = string
  default     = "nvidia-tesla-t4"  # T4 GPU - good price/performance
}

variable "gpu_count" {
  description = "Number of GPUs per worker"
  type        = number
  default     = 1
}

variable "worker_disk_gb" {
  description = "Boot disk size in GB per worker"
  type        = number
  default     = 50
}

variable "use_preemptible" {
  description = "Use preemptible (spot) instances for workers"
  type        = bool
  default     = false
}

variable "worker_public_ip" {
  description = "Give workers public IPs (avoids Cloud NAT cost but exposes workers)"
  type        = bool
  default     = false
}

variable "use_cloud_nat" {
  description = "Create Cloud NAT for private IP workers (costs ~$0.044/hr per VM)"
  type        = bool
  default     = true
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
  default     = "Hashcrack2025Lab"
}

variable "worker_voucher" {
  description = "Voucher code for worker registration"
  type        = string
  default     = "YOURPAIVOUCHER"
}

# =============================================================================
# SSH Configuration
# =============================================================================

variable "ssh_public_key" {
  description = "SSH public key for instance access"
  type        = string
}

variable "ssh_user" {
  description = "SSH username for instance access"
  type        = string
  default     = "ubuntu"
}

variable "allowed_ssh_cidr" {
  description = "CIDR blocks allowed for SSH access"
  type        = list(string)
  default     = ["0.0.0.0/0"]
}
