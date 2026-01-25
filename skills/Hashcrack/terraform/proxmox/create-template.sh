#!/bin/bash
# Create cloud-init enabled Ubuntu template on Proxmox
# Run this script on the Proxmox host: ssh root@proxmox 'bash -s' < create-template.sh

set -e

VMID=${1:-9000}
TEMPLATE_NAME=${2:-"ubuntu-cloud-init"}
STORAGE=${3:-"local-lvm"}

echo "=== Creating Cloud-Init Ubuntu Template ==="
echo "VMID: $VMID"
echo "Name: $TEMPLATE_NAME"
echo "Storage: $STORAGE"

# Download Ubuntu 22.04 cloud image if not exists
CLOUD_IMG="/var/lib/vz/template/iso/jammy-server-cloudimg-amd64.img"
if [ ! -f "$CLOUD_IMG" ]; then
    echo "Downloading Ubuntu 22.04 cloud image..."
    wget -q --show-progress -O "$CLOUD_IMG" https://cloud-images.ubuntu.com/jammy/current/jammy-server-cloudimg-amd64.img
    echo "Download complete"
else
    echo "Cloud image already exists at $CLOUD_IMG"
fi

# Check if VMID already in use
if qm status $VMID &>/dev/null; then
    echo "VMID $VMID already exists"
    read -p "Destroy and recreate? (y/N) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        qm destroy $VMID --purge || true
    else
        echo "Aborting"
        exit 1
    fi
fi

# Create new VM
echo "Creating VM $VMID..."
qm create $VMID --name "$TEMPLATE_NAME" --memory 2048 --cores 2 --net0 virtio,bridge=vmbr0

# Import cloud image as disk
echo "Importing cloud image as disk..."
qm importdisk $VMID "$CLOUD_IMG" $STORAGE

# Attach disk to VM
echo "Attaching disk..."
qm set $VMID --scsihw virtio-scsi-pci --scsi0 $STORAGE:vm-$VMID-disk-0

# Add cloud-init drive
echo "Adding cloud-init drive..."
qm set $VMID --ide2 $STORAGE:cloudinit

# Set boot order
qm set $VMID --boot c --bootdisk scsi0

# Add serial console for cloud-init output
qm set $VMID --serial0 socket --vga serial0

# Enable QEMU guest agent
qm set $VMID --agent enabled=1

# Convert to template
echo "Converting to template..."
qm template $VMID

echo ""
echo "=== Template $VMID created successfully ==="
echo ""
qm config $VMID
echo ""
echo "To use this template, update terraform.tfvars:"
echo "  template_id = $VMID"
