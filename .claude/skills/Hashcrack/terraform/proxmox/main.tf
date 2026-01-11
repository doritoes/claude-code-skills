# =============================================================================
# Hashcrack Proxmox Infrastructure - Main Configuration
# =============================================================================

locals {
  # Generate random passwords if not provided
  db_password    = var.hashtopolis_db_password != "" ? var.hashtopolis_db_password : random_password.db_password[0].result
  admin_password = var.hashtopolis_admin_password != "" ? var.hashtopolis_admin_password : random_password.admin_password[0].result
  voucher_code   = var.worker_voucher != "" ? var.worker_voucher : random_string.voucher[0].result

  # Extract server IP without CIDR
  server_ip_plain = split("/", var.server_ip)[0]
  
  # Common tags (Proxmox tags cannot contain colons or special chars)
  common_tags = [
    "hashcrack",
    "lab",
    "terraform"
  ]
}

# =============================================================================
# Random Password Generation
# =============================================================================

resource "random_password" "db_password" {
  count   = var.hashtopolis_db_password == "" ? 1 : 0
  length  = 24
  special = false
}

resource "random_password" "admin_password" {
  count   = var.hashtopolis_admin_password == "" ? 1 : 0
  length  = 16
  special = false  # Avoid special chars for cloud-init compatibility
}

resource "random_string" "voucher" {
  count   = var.worker_voucher == "" ? 1 : 0
  length  = 12
  special = false
  upper   = true
}

# =============================================================================
# Wait for Server to be Ready
# =============================================================================

resource "time_sleep" "wait_for_server" {
  depends_on = [proxmox_virtual_environment_vm.server]

  create_duration = "120s"
}
