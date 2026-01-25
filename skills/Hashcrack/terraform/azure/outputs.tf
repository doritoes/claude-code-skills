# =============================================================================
# Hashcrack Azure Terraform Outputs
# =============================================================================

output "resource_group_name" {
  value = azurerm_resource_group.hashcrack.name
}

output "server_public_ip" {
  value      = azurerm_public_ip.server.ip_address
  depends_on = [time_sleep.wait_for_server]
}

output "server_private_ip" {
  value = azurerm_network_interface.server.private_ip_address
}

output "server_url" {
  value      = "http://${azurerm_public_ip.server.ip_address}:8080"
  depends_on = [time_sleep.wait_for_server]
}

output "cpu_worker_private_ips" {
  description = "Private IPs of CPU workers"
  value       = azurerm_network_interface.cpu_workers[*].private_ip_address
}

output "cpu_worker_public_ips" {
  description = "Public IPs of CPU workers (for cloud-init internet access)"
  value       = azurerm_public_ip.cpu_workers[*].ip_address
}

output "gpu_worker_private_ips" {
  description = "Private IPs of GPU workers"
  value       = azurerm_network_interface.gpu_workers[*].private_ip_address
}

output "gpu_worker_public_ips" {
  description = "Public IPs of GPU workers (for cloud-init internet access)"
  value       = azurerm_public_ip.gpu_workers[*].ip_address
}

output "db_password" {
  value     = local.db_password
  sensitive = true
}

output "voucher_code" {
  value = local.voucher_code
}

output "deployment_summary" {
  depends_on = [time_sleep.wait_for_server]
  value      = <<-EOT
    ======================================================================
                      HASHCRACK AZURE DEPLOYMENT
    ======================================================================
      Resource Group: ${azurerm_resource_group.hashcrack.name}
      Location:       ${var.azure_location}

      Server: ${azurerm_public_ip.server.ip_address}
      URL:    http://${azurerm_public_ip.server.ip_address}:8080

      CPU Workers: ${var.cpu_worker_count} (with public IPs for cloud-init)
      GPU Workers: ${var.gpu_worker_count} (with public IPs for cloud-init)

      Spot Instances: ${var.use_spot_instances ? "Yes" : "No (on-demand)"}
    ======================================================================
  EOT
}

output "ssh_commands" {
  value = <<-EOT
    # SSH to server (public IP)
    ssh -i ~/.ssh/azure_hashcrack ${var.ssh_user}@${azurerm_public_ip.server.ip_address}

    # Workers have public IPs - can SSH directly
    # ssh -i ~/.ssh/azure_hashcrack ${var.ssh_user}@<worker_public_ip>
  EOT
}
