# =============================================================================
# OCI Authentication Configuration
# =============================================================================

variable "tenancy_ocid" {
  description = "OCI Tenancy OCID"
  type        = string
}

variable "user_ocid" {
  description = "OCI User OCID"
  type        = string
}

variable "fingerprint" {
  description = "OCI API Key fingerprint"
  type        = string
}

variable "private_key_path" {
  description = "Path to OCI API private key file"
  type        = string
  default     = "~/.oci/oci_api_key.pem"
}

variable "region" {
  description = "OCI region to deploy to"
  type        = string
  default     = "us-ashburn-1"
}

variable "compartment_ocid" {
  description = "OCI Compartment OCID (defaults to tenancy root)"
  type        = string
  default     = ""
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
# VCN Configuration
# =============================================================================

variable "vcn_cidr" {
  description = "CIDR block for VCN"
  type        = string
  default     = "10.0.0.0/16"
}

variable "subnet_cidr" {
  description = "CIDR block for public subnet"
  type        = string
  default     = "10.0.1.0/24"
}

# =============================================================================
# Hashtopolis Server Configuration
# =============================================================================

variable "server_shape" {
  description = "OCI compute shape for Hashtopolis server (VM.Standard.E4.Flex recommended)"
  type        = string
  default     = "VM.Standard.E4.Flex"
}

variable "server_ocpus" {
  description = "Number of OCPUs for server (flex shapes)"
  type        = number
  default     = 2
}

variable "server_memory_gb" {
  description = "Memory in GB for server (flex shapes)"
  type        = number
  default     = 8
}

variable "server_disk_gb" {
  description = "Boot volume size in GB for Hashtopolis server"
  type        = number
  default     = 50
}

# =============================================================================
# Worker Configuration
# =============================================================================

variable "cpu_worker_count" {
  description = "Number of CPU worker instances to create"
  type        = number
  default     = 1
}

variable "cpu_worker_shape" {
  description = "OCI compute shape for CPU workers"
  type        = string
  default     = "VM.Standard.E4.Flex"
}

variable "cpu_worker_ocpus" {
  description = "Number of OCPUs per CPU worker (flex shapes)"
  type        = number
  default     = 4
}

variable "cpu_worker_memory_gb" {
  description = "Memory in GB per CPU worker (flex shapes)"
  type        = number
  default     = 8
}

variable "gpu_worker_count" {
  description = "Number of GPU worker instances to create"
  type        = number
  default     = 0
}

variable "gpu_worker_shape" {
  description = "OCI compute shape for GPU workers (VM.GPU2.1 has P100, VM.GPU3.1 has V100)"
  type        = string
  default     = "VM.GPU2.1"
}

variable "worker_disk_gb" {
  description = "Boot volume size in GB per worker"
  type        = number
  default     = 30
}

variable "use_preemptible" {
  description = "Use preemptible (spot) instances for workers"
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
  default     = ""
}

variable "hashtopolis_db_password" {
  description = "Hashtopolis database password"
  type        = string
  sensitive   = true
  default     = ""
}

variable "worker_voucher" {
  description = "Voucher code for worker registration"
  type        = string
  default     = ""
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
