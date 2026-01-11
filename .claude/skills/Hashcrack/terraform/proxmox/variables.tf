# =============================================================================
# Proxmox Connection
# =============================================================================

variable "proxmox_url" {
  description = "Proxmox API URL (e.g., https://192.168.99.205:8006)"
  type        = string
}

variable "proxmox_user" {
  description = "Proxmox username (e.g., root@pam or terraform@pve)"
  type        = string
  default     = "root@pam"
}

variable "proxmox_password" {
  description = "Proxmox password"
  type        = string
  sensitive   = true
}

variable "proxmox_insecure" {
  description = "Allow self-signed certificates (lab environment)"
  type        = bool
  default     = true
}

# =============================================================================
# Proxmox Resources
# =============================================================================

variable "proxmox_node" {
  description = "Proxmox node name to deploy VMs on"
  type        = string
  default     = "proxmod-lab1"
}

variable "template_id" {
  description = "VM template ID for cloning (Ubuntu 24.04 cloud-init)"
  type        = number
  default     = 9000
}

variable "storage_name" {
  description = "Storage name for VM disks"
  type        = string
  default     = "local-lvm"
}

variable "network_bridge" {
  description = "Network bridge for VMs"
  type        = string
  default     = "vmbr0"
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
# VM ID Range
# =============================================================================

variable "server_vmid" {
  description = "VM ID for Hashtopolis server"
  type        = number
  default     = 200
}

variable "worker_vmid_start" {
  description = "Starting VM ID for workers"
  type        = number
  default     = 210
}

# =============================================================================
# Hashtopolis Server Configuration
# =============================================================================

variable "server_cpus" {
  description = "Number of vCPUs for Hashtopolis server"
  type        = number
  default     = 2
}

variable "server_memory_mb" {
  description = "RAM in MB for Hashtopolis server"
  type        = number
  default     = 4096  # 4 GB
}

variable "server_disk_gb" {
  description = "Disk size in GB for Hashtopolis server"
  type        = number
  default     = 50
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
  default     = 2
}

variable "worker_memory_mb" {
  description = "RAM in MB per worker"
  type        = number
  default     = 4096  # 4 GB
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
  default     = ""  # Generated if empty
}

variable "hashtopolis_db_password" {
  description = "Hashtopolis database password"
  type        = string
  sensitive   = true
  default     = ""  # Generated if empty
}

variable "worker_voucher" {
  description = "Voucher code for worker registration"
  type        = string
  default     = ""  # Generated if empty
}

# =============================================================================
# SSH Configuration
# =============================================================================

variable "ssh_public_key" {
  description = "SSH public key for VM access"
  type        = string
}

variable "ssh_user" {
  description = "SSH username for VM access (cloud-init user)"
  type        = string
  default     = "ubuntu"
}

# =============================================================================
# Network Configuration
# =============================================================================

variable "network_gateway" {
  description = "Network gateway IP"
  type        = string
  default     = "192.168.99.1"
}

variable "server_ip" {
  description = "Static IP for server (CIDR notation, e.g., 192.168.99.220/24)"
  type        = string
  default     = "192.168.99.220/24"
}

variable "worker_ip_start" {
  description = "Starting IP for workers (last octet)"
  type        = number
  default     = 221
}

variable "network_prefix" {
  description = "Network prefix (e.g., 192.168.99)"
  type        = string
  default     = "192.168.99"
}

variable "use_dhcp" {
  description = "Use DHCP instead of static IPs (recommended for short-lived VMs)"
  type        = bool
  default     = true
}

# =============================================================================
# Template Creation
# =============================================================================

variable "create_template" {
  description = "Create cloud-init template if it doesn't exist"
  type        = bool
  default     = false
}

variable "cloud_init_template_id" {
  description = "VM ID for the cloud-init template (if creating)"
  type        = number
  default     = 9000
}
