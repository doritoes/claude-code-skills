# =============================================================================
# Folding@Cloud OCI Variables
# =============================================================================

# OCI Authentication
variable "tenancy_ocid" {
  description = "OCI tenancy OCID"
  type        = string
}

variable "user_ocid" {
  description = "OCI user OCID"
  type        = string
}

variable "fingerprint" {
  description = "OCI API key fingerprint"
  type        = string
}

variable "private_key_path" {
  description = "Path to OCI API private key file"
  type        = string
  default     = "~/.oci/oci_api_key.pem"
}

variable "oci_region" {
  description = "OCI region"
  type        = string
  default     = "us-ashburn-1"
}

variable "compartment_ocid" {
  description = "OCI compartment OCID (uses tenancy root if not specified)"
  type        = string
  default     = ""
}

variable "availability_domain_index" {
  description = "Index of availability domain to use (0, 1, or 2)"
  type        = number
  default     = 0
}

# -----------------------------------------------------------------------------
# Project Configuration
# -----------------------------------------------------------------------------

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

# -----------------------------------------------------------------------------
# Network Configuration
# -----------------------------------------------------------------------------

variable "vcn_cidr" {
  description = "CIDR block for VCN"
  type        = string
  default     = "10.200.0.0/16"
}

variable "subnet_cidr" {
  description = "CIDR block for public subnet"
  type        = string
  default     = "10.200.1.0/24"
}

# -----------------------------------------------------------------------------
# Worker Configuration
# -----------------------------------------------------------------------------

variable "worker_count" {
  description = "Number of FAH worker instances"
  type        = number
  default     = 4
}

variable "worker_shape" {
  description = "OCI compute shape for workers"
  type        = string
  default     = "VM.Standard.E4.Flex"  # AMD EPYC, flexible
  # Alternatives:
  # VM.Standard.A1.Flex - ARM-based, Always Free eligible
  # VM.Standard.E2.1.Micro - Always Free, 1 OCPU
}

variable "worker_ocpus" {
  description = "Number of OCPUs per worker (Flex shapes)"
  type        = number
  default     = 2
}

variable "worker_memory_gb" {
  description = "Memory in GB per worker (Flex shapes)"
  type        = number
  default     = 8
}

variable "worker_disk_gb" {
  description = "Boot volume size in GB"
  type        = number
  default     = 50
}

variable "use_preemptible" {
  description = "Use preemptible instances (lower cost but can be terminated)"
  type        = bool
  default     = false
}

# -----------------------------------------------------------------------------
# SSH Configuration
# -----------------------------------------------------------------------------

variable "ssh_public_key" {
  description = "SSH public key for instance access"
  type        = string
}

variable "ssh_user" {
  description = "SSH username"
  type        = string
  default     = "ubuntu"
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
  default     = "pai-fold-oci"
}

variable "fah_team_id" {
  description = "FAH team number"
  type        = string
  default     = "0"
}
