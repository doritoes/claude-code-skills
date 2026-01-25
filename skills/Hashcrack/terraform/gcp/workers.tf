# =============================================================================
# Hashcat CPU Worker Instances
# =============================================================================

# CPU Workers (private IPs only - communicate with server internally)
resource "google_compute_instance" "cpu_workers" {
  count        = var.cpu_worker_count
  name         = "${var.project_name}-cpu-worker-${count.index + 1}"
  machine_type = var.cpu_worker_machine_type
  zone         = var.gcp_zone

  tags = ["${var.project_name}-worker"]

  # Preemptible (spot) instance configuration
  scheduling {
    preemptible         = var.use_preemptible
    automatic_restart   = var.use_preemptible ? false : true
    on_host_maintenance = var.use_preemptible ? "TERMINATE" : "MIGRATE"
  }

  boot_disk {
    initialize_params {
      image = "ubuntu-os-cloud/ubuntu-2404-lts-amd64"
      size  = var.worker_disk_gb
      type  = "pd-ssd"
    }
  }

  network_interface {
    subnetwork = google_compute_subnetwork.hashcrack.id

    # Public IP if enabled (avoids Cloud NAT cost)
    dynamic "access_config" {
      for_each = var.worker_public_ip ? [1] : []
      content {
        network_tier = "STANDARD"  # Cheaper than PREMIUM
      }
    }
  }

  # Cloud-init configuration
  metadata = {
    user-data = templatefile("${path.module}/../cloud-init/worker.yaml", {
      hostname       = "${var.project_name}-cpu-worker-${count.index + 1}"
      worker_id      = count.index + 1
      ssh_user       = var.ssh_user
      ssh_public_key = var.ssh_public_key
      server_url     = google_compute_instance.server.network_interface[0].network_ip
      voucher_code   = local.voucher_codes[count.index]
    })
    ssh-keys = "${var.ssh_user}:${var.ssh_public_key}"
  }

  labels = merge(local.labels, {
    role = "cpu-worker"
  })

  allow_stopping_for_update = true

  depends_on = [time_sleep.wait_for_server]

  lifecycle {
    ignore_changes = [
      metadata["user-data"]
    ]
  }
}

# =============================================================================
# Hashcat GPU Worker Instances
# =============================================================================

# GPU Workers (private IPs only)
resource "google_compute_instance" "gpu_workers" {
  count        = var.gpu_worker_count
  name         = "${var.project_name}-gpu-worker-${count.index + 1}"
  machine_type = var.gpu_worker_machine_type
  zone         = var.gcp_zone

  tags = ["${var.project_name}-worker"]

  # GPU workers: preemptible optional, but must terminate on maintenance
  scheduling {
    preemptible         = var.use_preemptible
    automatic_restart   = var.use_preemptible ? false : true
    on_host_maintenance = "TERMINATE"  # Required for GPU instances
  }

  # Attach GPU
  guest_accelerator {
    type  = var.gpu_type
    count = var.gpu_count
  }

  boot_disk {
    initialize_params {
      image = "ubuntu-os-cloud/ubuntu-2404-lts-amd64"
      size  = var.worker_disk_gb
      type  = "pd-ssd"
    }
  }

  network_interface {
    subnetwork = google_compute_subnetwork.hashcrack.id

    # Public IP if enabled (avoids Cloud NAT cost)
    dynamic "access_config" {
      for_each = var.worker_public_ip ? [1] : []
      content {
        network_tier = "STANDARD"
      }
    }
  }

  # Cloud-init configuration (uses GPU template)
  metadata = {
    user-data = templatefile("${path.module}/../cloud-init/worker-gpu.yaml", {
      hostname       = "${var.project_name}-gpu-worker-${count.index + 1}"
      worker_id      = 100 + count.index + 1
      ssh_user       = var.ssh_user
      ssh_public_key = var.ssh_public_key
      server_url     = google_compute_instance.server.network_interface[0].network_ip
      voucher_code   = local.voucher_codes[var.cpu_worker_count + count.index]
    })
    ssh-keys = "${var.ssh_user}:${var.ssh_public_key}"
  }

  labels = merge(local.labels, {
    role = "gpu-worker"
  })

  allow_stopping_for_update = true

  depends_on = [time_sleep.wait_for_server]

  lifecycle {
    ignore_changes = [
      metadata["user-data"]
    ]
  }
}
