# =============================================================================
# Folding@Cloud Azure Outputs
# =============================================================================

output "resource_group_name" {
  description = "Name of the resource group"
  value       = azurerm_resource_group.foldingcloud.name
}

output "worker_count" {
  description = "Number of FAH workers deployed"
  value       = var.worker_count
}

output "worker_public_ips" {
  description = "Public IP addresses of FAH workers"
  value       = azurerm_public_ip.workers[*].ip_address
}

output "worker_private_ips" {
  description = "Private IP addresses of FAH workers"
  value       = azurerm_network_interface.workers[*].private_ip_address
}

output "worker_names" {
  description = "Names of FAH worker VMs"
  value       = azurerm_linux_virtual_machine.workers[*].name
}

output "fah_machine_names" {
  description = "FAH machine names (as registered in portal)"
  value       = [for i in range(var.worker_count) : "${var.fah_machine_prefix}-${i + 1}"]
}

output "ssh_user" {
  description = "SSH username for worker access"
  value       = var.ssh_user
}

output "ssh_commands" {
  description = "SSH commands for each worker"
  value       = [for i, ip in azurerm_public_ip.workers[*].ip_address : "ssh ${var.ssh_user}@${ip}"]
}

output "spot_enabled" {
  description = "Whether Spot VMs are being used"
  value       = var.use_spot_instances
}

output "vm_size" {
  description = "VM size used for workers"
  value       = var.worker_vm_size
}

output "fah_portal_url" {
  description = "URL to manage FAH machines"
  value       = "https://v8-4.foldingathome.org/"
}
