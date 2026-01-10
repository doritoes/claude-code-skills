# =============================================================================
# Hashcat CPU Worker OCI Instances (Preemptible/Spot)
# =============================================================================

# Get Ubuntu image compatible with CPU worker shape
data "oci_core_images" "ubuntu_cpu_worker" {
  compartment_id           = local.compartment_id
  operating_system         = "Canonical Ubuntu"
  operating_system_version = "24.04"
  shape                    = var.cpu_worker_shape
  sort_by                  = "TIMECREATED"
  sort_order               = "DESC"
}

resource "oci_core_instance" "cpu_workers" {
  count = var.cpu_worker_count

  compartment_id      = local.compartment_id
  availability_domain = data.oci_identity_availability_domains.ads.availability_domains[0].name
  display_name        = "${var.project_name}-cpu-worker-${count.index + 1}"
  shape               = var.cpu_worker_shape

  # Flex shape configuration
  dynamic "shape_config" {
    for_each = length(regexall("Flex", var.cpu_worker_shape)) > 0 ? [1] : []
    content {
      ocpus         = var.cpu_worker_ocpus
      memory_in_gbs = var.cpu_worker_memory_gb
    }
  }

  # Preemptible (spot) configuration
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
    source_id               = data.oci_core_images.ubuntu_cpu_worker.images[0].id
    boot_volume_size_in_gbs = var.worker_disk_gb
  }

  create_vnic_details {
    subnet_id        = oci_core_subnet.public.id
    display_name     = "${var.project_name}-cpu-worker-${count.index + 1}-vnic"
    assign_public_ip = true
    hostname_label   = "cpuworker${count.index + 1}"
  }

  metadata = {
    ssh_authorized_keys = var.ssh_public_key
    user_data = base64encode(templatefile("${path.module}/../cloud-init/worker.yaml", {
      hostname       = "${var.project_name}-cpu-worker-${count.index + 1}"
      worker_id      = count.index + 1
      ssh_user       = var.ssh_user
      ssh_public_key = var.ssh_public_key
      server_url     = oci_core_instance.hashtopolis_server.private_ip
      voucher_code   = local.voucher_code
    }))
  }

  freeform_tags = merge(local.common_tags, {
    "Role" = var.use_preemptible ? "cpu-worker-preemptible" : "cpu-worker"
  })

  depends_on = [time_sleep.wait_for_server]

  lifecycle {
    ignore_changes = [metadata["user_data"]]
  }
}

# =============================================================================
# Hashcat GPU Worker OCI Instances
# =============================================================================

# Get Ubuntu image compatible with GPU worker shape
data "oci_core_images" "ubuntu_gpu_worker" {
  count                    = var.gpu_worker_count > 0 ? 1 : 0
  compartment_id           = local.compartment_id
  operating_system         = "Canonical Ubuntu"
  operating_system_version = "24.04"
  shape                    = var.gpu_worker_shape
  sort_by                  = "TIMECREATED"
  sort_order               = "DESC"
}

resource "oci_core_instance" "gpu_workers" {
  count = var.gpu_worker_count

  compartment_id      = local.compartment_id
  availability_domain = data.oci_identity_availability_domains.ads.availability_domains[0].name
  display_name        = "${var.project_name}-gpu-worker-${count.index + 1}"
  shape               = var.gpu_worker_shape

  # Preemptible (spot) configuration for GPU
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
    source_id               = data.oci_core_images.ubuntu_gpu_worker[0].images[0].id
    boot_volume_size_in_gbs = var.worker_disk_gb
  }

  create_vnic_details {
    subnet_id        = oci_core_subnet.public.id
    display_name     = "${var.project_name}-gpu-worker-${count.index + 1}-vnic"
    assign_public_ip = true
    hostname_label   = "gpuworker${count.index + 1}"
  }

  metadata = {
    ssh_authorized_keys = var.ssh_public_key
    user_data = base64encode(templatefile("${path.module}/../cloud-init/worker-gpu.yaml", {
      hostname       = "${var.project_name}-gpu-worker-${count.index + 1}"
      worker_id      = 100 + count.index + 1
      ssh_user       = var.ssh_user
      ssh_public_key = var.ssh_public_key
      server_url     = oci_core_instance.hashtopolis_server.private_ip
      voucher_code   = local.voucher_code
    }))
  }

  freeform_tags = merge(local.common_tags, {
    "Role" = var.use_preemptible ? "gpu-worker-preemptible" : "gpu-worker"
  })

  depends_on = [time_sleep.wait_for_server]

  lifecycle {
    ignore_changes = [metadata["user_data"]]
  }
}
