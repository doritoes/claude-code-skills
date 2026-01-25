# =============================================================================
# AWS Configuration
# =============================================================================

variable "aws_region" {
  description = "AWS region to deploy to"
  type        = string
  default     = "us-east-1"
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
# VPC Configuration
# =============================================================================

variable "vpc_cidr" {
  description = "CIDR block for VPC"
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

variable "server_instance_type" {
  description = "EC2 instance type for Hashtopolis server"
  type        = string
  default     = "t3.medium"
}

variable "server_disk_gb" {
  description = "Root volume size in GB for Hashtopolis server"
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

variable "cpu_worker_instance_type" {
  description = "EC2 instance type for CPU workers (c5.large, c6i.large)"
  type        = string
  default     = "c5.large"
}

variable "gpu_worker_count" {
  description = "Number of GPU worker instances to create"
  type        = number
  default     = 0
}

variable "gpu_worker_instance_type" {
  description = "EC2 instance type for GPU workers (g4dn.xlarge has T4 GPU)"
  type        = string
  default     = "g4dn.xlarge"
}

variable "worker_disk_gb" {
  description = "Root volume size in GB per worker"
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
  description = "SSH public key for EC2 instance access"
  type        = string
}

variable "ssh_user" {
  description = "SSH username for instance access"
  type        = string
  default     = "ubuntu"
}

variable "allowed_ssh_cidr" {
  description = "CIDR block allowed for SSH access (default: anywhere)"
  type        = string
  default     = "0.0.0.0/0"
}
