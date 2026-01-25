# =============================================================================
# Hashtopolis Server Proxmox VM
# =============================================================================

resource "proxmox_virtual_environment_vm" "server" {
  name      = "${var.project_name}-server"
  node_name = var.proxmox_node
  vm_id     = var.server_vmid

  tags = local.common_tags

  clone {
    vm_id = var.create_template ? var.cloud_init_template_id : var.template_id
    full  = true
  }

  cpu {
    cores = var.server_cpus
    type  = "host"
  }

  memory {
    dedicated = var.server_memory_mb
  }

  disk {
    datastore_id = var.storage_name
    interface    = "scsi0"
    size         = var.server_disk_gb
    file_format  = "raw"
  }

  network_device {
    bridge = var.network_bridge
    model  = "virtio"
  }

  # Enable QEMU guest agent
  agent {
    enabled = true
  }

  operating_system {
    type = "l26"  # Linux 2.6+ kernel
  }

  # Cloud-init configuration
  initialization {
    datastore_id = var.storage_name

    ip_config {
      ipv4 {
        address = var.use_dhcp ? "dhcp" : var.server_ip
        gateway = var.use_dhcp ? null : var.network_gateway
      }
    }

    # SSH user created by cloud-init - don't duplicate here
    user_data_file_id = proxmox_virtual_environment_file.server_cloud_init.id
  }

  # Wait for template to be created if we're creating it
  depends_on = [proxmox_virtual_environment_vm.cloud_init_template]

  lifecycle {
    ignore_changes = [
      initialization
    ]
  }
}

# =============================================================================
# Server Cloud-Init Configuration File
# =============================================================================

resource "proxmox_virtual_environment_file" "server_cloud_init" {
  content_type = "snippets"
  datastore_id = "local"
  node_name    = var.proxmox_node

  source_raw {
    data = templatefile("${path.module}/../cloud-init/server.yaml", {
      hostname       = "${var.project_name}-server"
      ssh_user       = var.ssh_user
      ssh_public_key = var.ssh_public_key
      db_password    = local.db_password
      admin_user     = var.hashtopolis_admin_user
      admin_password = local.admin_password
      voucher_code   = local.voucher_code
      all_vouchers   = local.all_vouchers
      worker_count   = var.worker_count
    })
    file_name = "${var.project_name}-server-cloud-init.yaml"
  }
}

# =============================================================================
# Server Credentials Output (Sensitive)
# =============================================================================

output "hashtopolis_credentials" {
  description = "Hashtopolis login credentials"
  depends_on  = [time_sleep.wait_for_server]
  value = {
    url      = "http://${local.server_ip_plain}:8080"
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
