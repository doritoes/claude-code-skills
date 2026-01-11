# =============================================================================
# Proxmox Deployment Outputs
# =============================================================================

output "server_vmid" {
  description = "Server VM ID"
  value       = proxmox_virtual_environment_vm.server.vm_id
}

output "server_ip" {
  description = "Server IP address"
  value       = local.server_ip_plain
  depends_on  = [time_sleep.wait_for_server]
}

output "server_url" {
  description = "Hashtopolis web UI URL"
  value       = "http://${local.server_ip_plain}:8080"
  depends_on  = [time_sleep.wait_for_server]
}

output "worker_vmids" {
  description = "Worker VM IDs"
  value       = proxmox_virtual_environment_vm.workers[*].vm_id
}

output "worker_ips" {
  description = "Worker IP addresses"
  value       = [for i in range(var.worker_count) : "${var.network_prefix}.${var.worker_ip_start + i}"]
}

output "deployment_summary" {
  description = "Deployment summary"
  depends_on  = [time_sleep.wait_for_server]
  value = <<-EOT
    ======================================================================
                      HASHCRACK PROXMOX DEPLOYMENT
    ======================================================================
      Proxmox Node: ${var.proxmox_node}
      
      Server: ${local.server_ip_plain} (VM ID: ${var.server_vmid})
      URL:    http://${local.server_ip_plain}:8080
      vCPUs:  ${var.server_cpus}
      RAM:    ${var.server_memory_mb} MB

      Workers: ${var.worker_count}
      ${join("\n      ", [for i in range(var.worker_count) : "worker-${i + 1}: ${var.network_prefix}.${var.worker_ip_start + i} (VM ID: ${var.worker_vmid_start + i}, ${var.worker_cpus} vCPU, ${var.worker_memory_mb} MB)"])}
      
      Total Resources:
      - vCPUs: ${var.server_cpus + (var.worker_count * var.worker_cpus)}
      - RAM: ${var.server_memory_mb + (var.worker_count * var.worker_memory_mb)} MB
    ======================================================================
  EOT
}
