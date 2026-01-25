# =============================================================================
# Hashcat CPU Worker Proxmox VMs
# =============================================================================

resource "proxmox_virtual_environment_vm" "workers" {
  count = var.worker_count

  name      = "${var.project_name}-worker-${count.index + 1}"
  node_name = var.proxmox_node
  vm_id     = var.worker_vmid_start + count.index

  tags = concat(local.common_tags, ["worker"])

  clone {
    vm_id = var.create_template ? var.cloud_init_template_id : var.template_id
    full  = true
  }

  cpu {
    cores = var.worker_cpus
    type  = "host"
  }

  memory {
    dedicated = var.worker_memory_mb
  }

  disk {
    datastore_id = var.storage_name
    interface    = "scsi0"
    size         = var.worker_disk_gb
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
    type = "l26"
  }

  # Cloud-init configuration
  initialization {
    datastore_id = var.storage_name

    ip_config {
      ipv4 {
        address = var.use_dhcp ? "dhcp" : "${var.network_prefix}.${var.worker_ip_start + count.index}/24"
        gateway = var.use_dhcp ? null : var.network_gateway
      }
    }

    # SSH user created by cloud-init - don't duplicate here
    user_data_file_id = proxmox_virtual_environment_file.worker_cloud_init[count.index].id
  }

  depends_on = [time_sleep.wait_for_server]

  lifecycle {
    ignore_changes = [
      initialization
    ]
  }
}

# =============================================================================
# Worker Cloud-Init Configuration Files
# =============================================================================

resource "proxmox_virtual_environment_file" "worker_cloud_init" {
  count = var.worker_count

  content_type = "snippets"
  datastore_id = "local"
  node_name    = var.proxmox_node

  source_raw {
    data = templatefile("${path.module}/../cloud-init/worker.yaml", {
      hostname       = "${var.project_name}-worker-${count.index + 1}"
      worker_id      = count.index + 1
      ssh_user       = var.ssh_user
      ssh_public_key = var.ssh_public_key
      server_url     = local.server_ip_plain
      voucher_code   = local.voucher_codes[count.index]
    })
    file_name = "${var.project_name}-worker-${count.index + 1}-cloud-init.yaml"
  }
}
