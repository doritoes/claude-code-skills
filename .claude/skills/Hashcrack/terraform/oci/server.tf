# =============================================================================
# Hashtopolis Server OCI Instance
# =============================================================================

resource "oci_core_instance" "hashtopolis_server" {
  compartment_id      = local.compartment_id
  availability_domain = data.oci_identity_availability_domains.ads.availability_domains[var.availability_domain_index].name
  display_name        = "${var.project_name}-server"
  shape               = var.server_shape

  # Flex shape configuration
  dynamic "shape_config" {
    for_each = can(regex("Flex", var.server_shape)) ? [1] : []
    content {
      ocpus         = var.server_ocpus
      memory_in_gbs = var.server_memory_gb
    }
  }

  source_details {
    source_type             = "image"
    source_id               = data.oci_core_images.ubuntu.images[0].id
    boot_volume_size_in_gbs = var.server_disk_gb
  }

  create_vnic_details {
    subnet_id        = oci_core_subnet.public.id
    display_name     = "${var.project_name}-server-vnic"
    assign_public_ip = true
    hostname_label   = "server"
  }

  metadata = {
    ssh_authorized_keys = var.ssh_public_key
    user_data = base64encode(templatefile("${path.module}/../cloud-init/server.yaml", {
      hostname       = "${var.project_name}-server"
      ssh_user       = var.ssh_user
      ssh_public_key = var.ssh_public_key
      db_password    = local.db_password
      admin_user     = var.hashtopolis_admin_user
      admin_password = local.admin_password
      voucher_code   = local.voucher_code
    }))
  }

  freeform_tags = merge(local.common_tags, {
    Role = "server"
  })

  lifecycle {
    ignore_changes = [
      metadata["user_data"]
    ]
  }
}

# =============================================================================
# Server Credentials Output (Sensitive)
# =============================================================================

output "hashtopolis_credentials" {
  description = "Hashtopolis login credentials"
  depends_on  = [time_sleep.wait_for_server]
  value = {
    url      = "http://${oci_core_instance.hashtopolis_server.public_ip}:8080"
    username = var.hashtopolis_admin_user
    password = local.admin_password
  }
  sensitive = true
}

output "db_password" {
  description = "Hashtopolis database password"
  value       = local.db_password
  sensitive   = true
}

output "voucher_code" {
  description = "Worker registration voucher code"
  value       = local.voucher_code
  sensitive   = true
}
