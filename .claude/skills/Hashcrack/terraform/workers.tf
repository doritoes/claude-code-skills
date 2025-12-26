# =============================================================================
# Hashcat Worker VMs
# =============================================================================

resource "xenorchestra_vm" "workers" {
  count = var.worker_count

  name_label       = "${var.project_name}-worker-${count.index + 1}"
  name_description = "Hashcat worker ${count.index + 1} - PAI Hashcrack skill"
  template         = data.xenorchestra_template.ubuntu.id

  memory_max = var.worker_memory_gb * 1024 * 1024 * 1024
  cpus       = var.worker_cpus

  # Cloud-init configuration
  # Note: Server URL uses placeholder - Ansible will configure the actual URL
  # after both server and workers have their IPs assigned
  cloud_config = templatefile("${path.module}/cloud-init/worker.yaml", {
    hostname       = "${var.project_name}-worker-${count.index + 1}"
    worker_id      = count.index + 1
    ssh_user       = var.ssh_user
    ssh_public_key = var.ssh_public_key
    server_url     = "https://HASHTOPOLIS_SERVER:8080"  # Placeholder, configured by Ansible
    voucher_code   = local.voucher_code
  })

  cloud_network_config = templatefile("${path.module}/cloud-init/network.yaml", {
    # DHCP by default
  })

  # Network interface
  network {
    network_id = data.xenorchestra_network.network.id
  }

  # Primary disk
  disk {
    sr_id      = data.xenorchestra_sr.storage.id
    name_label = "${var.project_name}-worker-${count.index + 1}-disk"
    size       = var.worker_disk_gb * 1024 * 1024 * 1024
  }

  tags = concat(local.common_tags, ["worker"])

  # Workers wait for server to get its IP address
  depends_on = [time_sleep.wait_for_server_ip]

  lifecycle {
    ignore_changes = [
      cloud_config,
      cloud_network_config
    ]
  }
}
