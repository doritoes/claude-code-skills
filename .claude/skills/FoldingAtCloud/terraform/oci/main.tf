# =============================================================================
# Folding@Cloud OCI Infrastructure
# =============================================================================

locals {
  compartment_id = var.compartment_ocid != "" ? var.compartment_ocid : var.tenancy_ocid

  common_tags = {
    Project     = var.project_name
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}

# =============================================================================
# Data Sources
# =============================================================================

data "oci_identity_availability_domains" "ads" {
  compartment_id = var.tenancy_ocid
}

# Ubuntu 24.04 image
data "oci_core_images" "ubuntu" {
  compartment_id           = local.compartment_id
  operating_system         = "Canonical Ubuntu"
  operating_system_version = "24.04"
  shape                    = var.worker_shape
  sort_by                  = "TIMECREATED"
  sort_order               = "DESC"
}

# =============================================================================
# VCN (Virtual Cloud Network)
# =============================================================================

resource "oci_core_vcn" "foldingcloud" {
  compartment_id = local.compartment_id
  cidr_blocks    = [var.vcn_cidr]
  display_name   = "${var.project_name}-vcn"
  dns_label      = "foldingcloud"

  freeform_tags = local.common_tags
}

# Internet Gateway
resource "oci_core_internet_gateway" "foldingcloud" {
  compartment_id = local.compartment_id
  vcn_id         = oci_core_vcn.foldingcloud.id
  display_name   = "${var.project_name}-igw"
  enabled        = true

  freeform_tags = local.common_tags
}

# Route Table
resource "oci_core_route_table" "public" {
  compartment_id = local.compartment_id
  vcn_id         = oci_core_vcn.foldingcloud.id
  display_name   = "${var.project_name}-public-rt"

  route_rules {
    destination       = "0.0.0.0/0"
    destination_type  = "CIDR_BLOCK"
    network_entity_id = oci_core_internet_gateway.foldingcloud.id
  }

  freeform_tags = local.common_tags
}

# Security List
resource "oci_core_security_list" "foldingcloud" {
  compartment_id = local.compartment_id
  vcn_id         = oci_core_vcn.foldingcloud.id
  display_name   = "${var.project_name}-seclist"

  # Allow SSH
  ingress_security_rules {
    protocol    = "6"  # TCP
    source      = "0.0.0.0/0"
    source_type = "CIDR_BLOCK"

    tcp_options {
      min = 22
      max = 22
    }
  }

  # Allow all outbound (FAH uses outbound connections)
  egress_security_rules {
    protocol    = "all"
    destination = "0.0.0.0/0"
  }

  freeform_tags = local.common_tags
}

# Public Subnet
resource "oci_core_subnet" "public" {
  compartment_id             = local.compartment_id
  vcn_id                     = oci_core_vcn.foldingcloud.id
  cidr_block                 = var.subnet_cidr
  display_name               = "${var.project_name}-public-subnet"
  dns_label                  = "public"
  prohibit_public_ip_on_vnic = false
  route_table_id             = oci_core_route_table.public.id
  security_list_ids          = [oci_core_security_list.foldingcloud.id]

  freeform_tags = local.common_tags
}

# =============================================================================
# FAH Worker Instances
# =============================================================================

resource "oci_core_instance" "workers" {
  count               = var.worker_count
  compartment_id      = local.compartment_id
  availability_domain = data.oci_identity_availability_domains.ads.availability_domains[var.availability_domain_index].name
  display_name        = "${var.project_name}-worker-${count.index + 1}"
  shape               = var.worker_shape

  # Flex shape configuration
  dynamic "shape_config" {
    for_each = length(regexall("Flex", var.worker_shape)) > 0 ? [1] : []
    content {
      ocpus         = var.worker_ocpus
      memory_in_gbs = var.worker_memory_gb
    }
  }

  # Preemptible configuration (optional)
  dynamic "preemptible_instance_config" {
    for_each = var.use_preemptible ? [1] : []
    content {
      preemption_action {
        type                 = "TERMINATE"
        preserve_boot_volume = false
      }
    }
  }

  source_details {
    source_type             = "image"
    source_id               = data.oci_core_images.ubuntu.images[0].id
    boot_volume_size_in_gbs = var.worker_disk_gb
  }

  create_vnic_details {
    subnet_id        = oci_core_subnet.public.id
    display_name     = "${var.project_name}-worker-${count.index + 1}-vnic"
    assign_public_ip = true
  }

  metadata = {
    ssh_authorized_keys = var.ssh_public_key
    user_data = base64encode(templatefile("${path.module}/cloud-init/fah-worker.yaml", {
      hostname          = "${var.fah_machine_prefix}-${count.index + 1}"
      machine_name      = "${var.fah_machine_prefix}-${count.index + 1}"
      fah_account_token = var.fah_account_token
      fah_team_id       = var.fah_team_id
      cpu_count         = var.worker_ocpus * 2  # OCPUs = 2 vCPUs each
    }))
  }

  freeform_tags = merge(local.common_tags, {
    Role        = "fah-worker"
    WorkerIndex = count.index + 1
    FAHMachine  = "${var.fah_machine_prefix}-${count.index + 1}"
  })

  lifecycle {
    ignore_changes = [metadata["user_data"]]
  }
}
