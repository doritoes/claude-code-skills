# =============================================================================
# Hashtopolis Server GCP Compute Instance
# =============================================================================

# Static external IP for server
resource "google_compute_address" "server" {
  name   = "${var.project_name}-server-ip"
  region = var.gcp_region
}

# Server instance
resource "google_compute_instance" "server" {
  name         = "${var.project_name}-server"
  machine_type = var.server_machine_type
  zone         = var.gcp_zone

  tags = ["${var.project_name}-server"]

  boot_disk {
    initialize_params {
      image = "ubuntu-os-cloud/ubuntu-2404-lts-amd64"
      size  = var.server_disk_gb
      type  = "pd-ssd"
    }
  }

  network_interface {
    subnetwork = google_compute_subnetwork.hashcrack.id

    access_config {
      nat_ip = google_compute_address.server.address
    }
  }

  # Cloud-init configuration (reuse existing template)
  metadata = {
    user-data = templatefile("${path.module}/../cloud-init/server.yaml", {
      hostname       = "${var.project_name}-server"
      ssh_user       = var.ssh_user
      ssh_public_key = var.ssh_public_key
      db_password    = local.db_password
      admin_user     = var.hashtopolis_admin_user
      admin_password = var.hashtopolis_admin_password
      voucher_code   = local.voucher_code
      all_vouchers   = local.all_vouchers
      worker_count   = local.total_worker_count
    })
    ssh-keys = "${var.ssh_user}:${var.ssh_public_key}"
  }

  labels = local.labels

  # Allow stopping for updates
  allow_stopping_for_update = true

  lifecycle {
    ignore_changes = [
      metadata["user-data"] # Don't recreate on cloud-init changes
    ]
  }
}

# Wait for server to initialize (Docker + Hashtopolis startup)
resource "time_sleep" "wait_for_server" {
  depends_on = [google_compute_instance.server]

  create_duration = "180s"
}
