# =============================================================================
# Hashcrack Infrastructure - Main Configuration
# =============================================================================

locals {
  # Generate random passwords if not provided
  db_password    = var.hashtopolis_db_password != "" ? var.hashtopolis_db_password : random_password.db_password[0].result
  admin_password = var.hashtopolis_admin_password != "" ? var.hashtopolis_admin_password : random_password.admin_password[0].result

  # Generate N vouchers (one per worker) to prevent race conditions
  # If worker_voucher is provided, use it for all (legacy behavior for single-worker)
  # Otherwise, generate unique vouchers for each worker
  voucher_codes  = var.worker_voucher != "" ? [var.worker_voucher] : random_string.voucher[*].result
  voucher_code   = length(local.voucher_codes) > 0 ? local.voucher_codes[0] : ""  # First voucher for backward compat
  all_vouchers   = join(",", local.voucher_codes)  # Comma-separated for cloud-init

  # Common tags for all resources
  common_tags = [
    var.project_name,
    var.environment,
    "pai-managed"
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
  special = true
}

resource "random_string" "voucher" {
  count   = var.worker_voucher == "" ? var.worker_count : 0
  length  = 12
  special = false
  upper   = true
}

# =============================================================================
# Data Sources - XCP-ng Resources
# =============================================================================

data "xenorchestra_pool" "pool" {
  name_label = var.pool_name
}

data "xenorchestra_template" "ubuntu" {
  name_label = var.template_name
}

data "xenorchestra_network" "network" {
  name_label = var.network_name
  pool_id    = data.xenorchestra_pool.pool.id
}

data "xenorchestra_sr" "storage" {
  name_label = var.sr_name
  pool_id    = data.xenorchestra_pool.pool.id
}

# =============================================================================
# Wait for Server IP Assignment
# =============================================================================

# Wait for cloud-init to complete and DHCP to assign IP
resource "time_sleep" "wait_for_server_ip" {
  depends_on = [xenorchestra_vm.hashtopolis_server]

  create_duration = "90s"
}

# Helper local to safely get server IP
locals {
  server_ip = try(xenorchestra_vm.hashtopolis_server.ipv4_addresses[0], "pending")
}
