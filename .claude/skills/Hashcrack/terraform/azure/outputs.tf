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

output "cpu_worker_ips" {
  description = "Private IPs of CPU workers (no public IPs needed)"
  value       = azurerm_network_interface.cpu_workers[*].private_ip_address
}

output "gpu_worker_ips" {
  description = "Private IPs of GPU workers (no public IPs needed)"
  value       = azurerm_network_interface.gpu_workers[*].private_ip_address
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

      CPU Workers: ${var.cpu_worker_count} (private IPs only)
      GPU Workers: ${var.gpu_worker_count} (private IPs only)

      Spot Instances: ${var.use_spot_instances ? "Yes" : "No (on-demand)"}
    ======================================================================
  EOT
}

output "ssh_commands" {
  value = <<-EOT
    # SSH to server (public IP)
    ssh ${var.ssh_user}@${azurerm_public_ip.server.ip_address}

    # Workers have private IPs only - SSH via server as jump host
    # ssh -J ${var.ssh_user}@${azurerm_public_ip.server.ip_address} ${var.ssh_user}@<worker_private_ip>
  EOT
}
