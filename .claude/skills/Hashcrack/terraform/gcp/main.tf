# =============================================================================
# Hashcrack GCP Infrastructure - Network Resources
# =============================================================================

# VPC Network
resource "google_compute_network" "hashcrack" {
  name                    = "${var.project_name}-vpc"
  auto_create_subnetworks = false
  description             = "Hashcrack VPC for distributed password cracking"
}

# Subnet
resource "google_compute_subnetwork" "hashcrack" {
  name          = "${var.project_name}-subnet"
  ip_cidr_range = var.network_cidr
  region        = var.gcp_region
  network       = google_compute_network.hashcrack.id

  private_ip_google_access = true
}

# =============================================================================
# Firewall Rules
# =============================================================================

# Allow SSH from specified CIDR
resource "google_compute_firewall" "allow_ssh" {
  name    = "${var.project_name}-allow-ssh"
  network = google_compute_network.hashcrack.name

  allow {
    protocol = "tcp"
    ports    = ["22"]
  }

  source_ranges = var.allowed_ssh_cidr
  target_tags   = ["${var.project_name}-server", "${var.project_name}-worker"]
}

# Allow Hashtopolis web UI from specified CIDR
resource "google_compute_firewall" "allow_hashtopolis_web" {
  name    = "${var.project_name}-allow-web"
  network = google_compute_network.hashcrack.name

  allow {
    protocol = "tcp"
    ports    = ["8080"]
  }

  source_ranges = var.allowed_ssh_cidr
  target_tags   = ["${var.project_name}-server"]
}

# Allow internal communication (workers to server)
resource "google_compute_firewall" "allow_internal" {
  name    = "${var.project_name}-allow-internal"
  network = google_compute_network.hashcrack.name

  allow {
    protocol = "tcp"
    ports    = ["0-65535"]
  }

  allow {
    protocol = "udp"
    ports    = ["0-65535"]
  }

  allow {
    protocol = "icmp"
  }

  source_ranges = [var.network_cidr]
  target_tags   = ["${var.project_name}-server", "${var.project_name}-worker"]
}

# =============================================================================
# Random Resources
# =============================================================================

resource "random_password" "db_password" {
  length  = 24
  special = false
}

# Local computed values
locals {
  voucher_code = var.worker_voucher
  db_password  = random_password.db_password.result

  # Common labels for all resources
  labels = {
    project     = var.project_name
    environment = var.environment
    managed-by  = "terraform"
  }
}
