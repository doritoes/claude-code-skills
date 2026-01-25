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
# Cloud Router & NAT (for worker internet access - OPTIONAL)
# =============================================================================
# Only created if use_cloud_nat = true AND worker_public_ip = false
# Cost: ~$0.044/hr per VM using NAT + ~$0.045/GB data

# Cloud Router (required for Cloud NAT)
resource "google_compute_router" "hashcrack" {
  count   = var.use_cloud_nat && !var.worker_public_ip ? 1 : 0
  name    = "${var.project_name}-router"
  region  = var.gcp_region
  network = google_compute_network.hashcrack.id
}

# Cloud NAT - allows private instances to reach internet
resource "google_compute_router_nat" "hashcrack" {
  count                              = var.use_cloud_nat && !var.worker_public_ip ? 1 : 0
  name                               = "${var.project_name}-nat"
  router                             = google_compute_router.hashcrack[0].name
  region                             = var.gcp_region
  nat_ip_allocate_option             = "AUTO_ONLY"
  source_subnetwork_ip_ranges_to_nat = "ALL_SUBNETWORKS_ALL_IP_RANGES"

  log_config {
    enable = false
    filter = "ALL"
  }
}

# =============================================================================
# Random Resources
# =============================================================================

resource "random_password" "db_password" {
  length  = 24
  special = false
}

# Generate N unique vouchers (one per worker)
resource "random_string" "voucher" {
  count   = var.worker_voucher == "" ? (var.cpu_worker_count + var.gpu_worker_count) : 0
  length  = 12
  special = false
  upper   = true
}

# Local computed values
locals {
  total_worker_count = var.cpu_worker_count + var.gpu_worker_count
  voucher_codes      = var.worker_voucher != "" ? [var.worker_voucher] : random_string.voucher[*].result
  voucher_code       = length(local.voucher_codes) > 0 ? local.voucher_codes[0] : ""
  all_vouchers       = join(",", local.voucher_codes)
  db_password        = random_password.db_password.result

  # Common labels for all resources
  labels = {
    project     = var.project_name
    environment = var.environment
    managed-by  = "terraform"
  }
}
