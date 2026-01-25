# =============================================================================
# Folding@Cloud GCP Main - One-Shot GPU
# =============================================================================

# -----------------------------------------------------------------------------
# Network (use default VPC)
# -----------------------------------------------------------------------------

resource "google_compute_firewall" "fah_ssh" {
  name    = "fah-gpu-ssh"
  network = "default"

  allow {
    protocol = "tcp"
    ports    = ["22"]
  }

  source_ranges = ["0.0.0.0/0"]
  target_tags   = ["fah-gpu"]
}

# -----------------------------------------------------------------------------
# GPU Instance
# -----------------------------------------------------------------------------

resource "google_compute_instance" "fah_gpu" {
  name         = "fah-gpu-oneshot"
  machine_type = var.machine_type
  zone         = var.gcp_zone

  tags = ["fah-gpu"]

  # Spot/Preemptible configuration
  scheduling {
    preemptible                 = var.use_spot
    automatic_restart           = false
    on_host_maintenance         = "TERMINATE"
    provisioning_model          = var.use_spot ? "SPOT" : "STANDARD"
    instance_termination_action = var.use_spot ? "STOP" : null
  }

  boot_disk {
    initialize_params {
      image = "ubuntu-os-cloud/ubuntu-2404-lts-amd64"
      size  = var.disk_size_gb
      type  = "pd-ssd"
    }
  }

  # GPU configuration
  guest_accelerator {
    type  = var.gpu_type
    count = var.gpu_count
  }

  network_interface {
    network = "default"
    access_config {
      // Ephemeral public IP
    }
  }

  metadata = {
    ssh-keys  = "${var.ssh_user}:${var.ssh_public_key}"
    user-data = templatefile("${path.module}/cloud-init/fah-gpu.yaml", {
      hostname          = "fah-gpu-oneshot"
      machine_name      = var.fah_machine_name
      fah_account_token = var.fah_account_token
      fah_team_id       = var.fah_team_id
      fah_passkey       = var.fah_passkey
      one_shot_mode     = var.one_shot_mode
    })
  }

  # Allow stopping for updates
  allow_stopping_for_update = true

  lifecycle {
    ignore_changes = [
      metadata["ssh-keys"]
    ]
  }
}
