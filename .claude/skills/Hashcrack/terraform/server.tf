# =============================================================================
# Hashtopolis Server VM
# =============================================================================

resource "xenorchestra_vm" "hashtopolis_server" {
  name_label       = "${var.project_name}-server"
  name_description = "Hashtopolis server - PAI Hashcrack skill"
  template         = data.xenorchestra_template.ubuntu.id

  memory_max = var.server_memory_gb * 1024 * 1024 * 1024
  cpus       = var.server_cpus

  # Cloud-init configuration
  cloud_config = templatefile("${path.module}/cloud-init/server.yaml", {
    hostname       = "${var.project_name}-server"
    ssh_user       = var.ssh_user
    ssh_public_key = var.ssh_public_key
    db_password    = local.db_password
    admin_user     = var.hashtopolis_admin_user
    admin_password = local.admin_password
    voucher_code   = local.voucher_code
  })

  cloud_network_config = templatefile("${path.module}/cloud-init/network.yaml", {
    # DHCP by default, can be customized for static IP
  })

  # Network interface
  network {
    network_id = data.xenorchestra_network.network.id
  }

  # Primary disk
  disk {
    sr_id      = data.xenorchestra_sr.storage.id
    name_label = "${var.project_name}-server-disk"
    size       = var.server_disk_gb * 1024 * 1024 * 1024
  }

  tags = concat(local.common_tags, ["server"])

  # Note: wait_for_ip removed in newer provider versions
  # Cloud-init will handle initialization

  lifecycle {
    ignore_changes = [
      # Ignore changes to cloud_config after creation
      cloud_config,
      cloud_network_config
    ]
  }
}

# =============================================================================
# Server Credentials Output (Sensitive)
# =============================================================================

output "hashtopolis_credentials" {
  description = "Hashtopolis login credentials"
  depends_on  = [time_sleep.wait_for_server_ip]
  value = {
    url      = try("http://${xenorchestra_vm.hashtopolis_server.ipv4_addresses[0]}:8080", "pending")
    username = var.hashtopolis_admin_user
    password = local.admin_password
  }
  sensitive = true
}

output "db_password" {
  description = "Hashtopolis database password"
  value       = local.db_password
  sensitive   = true
}

output "voucher_code" {
  description = "Worker registration voucher code"
  value       = local.voucher_code
  sensitive   = true
}
