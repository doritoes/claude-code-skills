# =============================================================================
# Cloud-Init Template Creation
# =============================================================================
# This creates a cloud-init enabled Ubuntu template if it doesn't exist.
# The template is used for cloning Hashtopolis server and workers.
# =============================================================================

# Download Ubuntu 22.04 cloud image to Proxmox
resource "proxmox_virtual_environment_download_file" "ubuntu_cloud_image" {
  count = var.create_template ? 1 : 0

  content_type = "iso"
  datastore_id = "local"
  node_name    = var.proxmox_node

  url       = "https://cloud-images.ubuntu.com/jammy/current/jammy-server-cloudimg-amd64.img"
  file_name = "jammy-server-cloudimg-amd64.img"

  # Allow overwrite if exists (including files not managed by terraform)
  overwrite           = true
  overwrite_unmanaged = true
}

# Create the cloud-init template VM
resource "proxmox_virtual_environment_vm" "cloud_init_template" {
  count = var.create_template ? 1 : 0

  name      = "ubuntu-cloud-init"
  node_name = var.proxmox_node
  vm_id     = var.cloud_init_template_id

  # Don't start the template
  started = false
  on_boot = false

  # Template settings
  template = true

  cpu {
    cores = 2
    type  = "host"
  }

  memory {
    dedicated = 2048
  }

  # Use the downloaded cloud image
  disk {
    datastore_id = var.storage_name
    file_id      = proxmox_virtual_environment_download_file.ubuntu_cloud_image[0].id
    interface    = "scsi0"
    size         = 20
    file_format  = "raw"
  }

  # Enable cloud-init (initialization is configured when cloning)
  initialization {
    datastore_id = var.storage_name
    ip_config {
      ipv4 {
        address = "dhcp"
      }
    }
  }

  network_device {
    bridge = var.network_bridge
    model  = "virtio"
  }

  # Serial console for cloud-init output
  serial_device {}

  # QEMU guest agent
  agent {
    enabled = true
  }

  operating_system {
    type = "l26"
  }

  lifecycle {
    # Once created, don't modify the template
    ignore_changes = all
  }

  depends_on = [proxmox_virtual_environment_download_file.ubuntu_cloud_image]
}
