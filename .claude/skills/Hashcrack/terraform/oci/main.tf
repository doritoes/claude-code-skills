# =============================================================================
# Hashcrack OCI Infrastructure - Main Configuration
# =============================================================================

locals {
  # Use tenancy as compartment if not specified
  compartment_id = var.compartment_ocid != "" ? var.compartment_ocid : var.tenancy_ocid
  
  # Generate random passwords if not provided
  db_password    = var.hashtopolis_db_password != "" ? var.hashtopolis_db_password : random_password.db_password[0].result
  admin_password = var.hashtopolis_admin_password != "" ? var.hashtopolis_admin_password : random_password.admin_password[0].result
  voucher_code   = var.worker_voucher != "" ? var.worker_voucher : random_string.voucher[0].result

  # Common tags
  common_tags = {
    Project     = var.project_name
    Environment = var.environment
    ManagedBy   = "terraform"
  }
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
  count   = var.worker_voucher == "" ? 1 : 0
  length  = 12
  special = false
  upper   = true
}

# =============================================================================
# Data Sources - Availability Domain and Image Lookup
# =============================================================================

data "oci_identity_availability_domains" "ads" {
  compartment_id = var.tenancy_ocid
}

# Ubuntu 24.04 image
data "oci_core_images" "ubuntu" {
  compartment_id           = local.compartment_id
  operating_system         = "Canonical Ubuntu"
  operating_system_version = "24.04"
  shape                    = var.server_shape
  sort_by                  = "TIMECREATED"
  sort_order               = "DESC"
}

# =============================================================================
# VCN (Virtual Cloud Network)
# =============================================================================

resource "oci_core_vcn" "hashcrack" {
  compartment_id = local.compartment_id
  cidr_blocks    = [var.vcn_cidr]
  display_name   = "${var.project_name}-vcn"
  dns_label      = var.project_name

  freeform_tags = local.common_tags
}

# =============================================================================
# Internet Gateway
# =============================================================================

resource "oci_core_internet_gateway" "hashcrack" {
  compartment_id = local.compartment_id
  vcn_id         = oci_core_vcn.hashcrack.id
  display_name   = "${var.project_name}-igw"
  enabled        = true

  freeform_tags = local.common_tags
}

# =============================================================================
# Route Table
# =============================================================================

resource "oci_core_route_table" "public" {
  compartment_id = local.compartment_id
  vcn_id         = oci_core_vcn.hashcrack.id
  display_name   = "${var.project_name}-public-rt"

  route_rules {
    destination       = "0.0.0.0/0"
    destination_type  = "CIDR_BLOCK"
    network_entity_id = oci_core_internet_gateway.hashcrack.id
  }

  freeform_tags = local.common_tags
}

# =============================================================================
# Public Subnet
# =============================================================================

resource "oci_core_subnet" "public" {
  compartment_id             = local.compartment_id
  vcn_id                     = oci_core_vcn.hashcrack.id
  cidr_block                 = var.subnet_cidr
  display_name               = "${var.project_name}-public-subnet"
  dns_label                  = "public"
  prohibit_public_ip_on_vnic = false
  route_table_id             = oci_core_route_table.public.id
  security_list_ids          = [oci_core_security_list.hashcrack.id]
  # Regional subnet (no AD restriction) allows instances in any AD
  # availability_domain      = data.oci_identity_availability_domains.ads.availability_domains[var.availability_domain_index].name

  freeform_tags = local.common_tags
}

# =============================================================================
# Wait for Server to be Ready
# =============================================================================

resource "time_sleep" "wait_for_server" {
  depends_on = [oci_core_instance.hashtopolis_server]

  create_duration = "120s"
}
