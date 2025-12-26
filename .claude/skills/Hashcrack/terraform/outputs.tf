# =============================================================================
# Hashtopolis Server Outputs
# =============================================================================

output "server_id" {
  description = "Hashtopolis server VM ID"
  value       = xenorchestra_vm.hashtopolis_server.id
}

output "server_ip" {
  description = "Hashtopolis server IP address"
  value       = try(xenorchestra_vm.hashtopolis_server.ipv4_addresses[0], "pending")
  depends_on  = [time_sleep.wait_for_server_ip]
}

output "server_url" {
  description = "Hashtopolis web UI URL"
  value       = try("https://${xenorchestra_vm.hashtopolis_server.ipv4_addresses[0]}:8080", "pending")
  depends_on  = [time_sleep.wait_for_server_ip]
}

output "server_name" {
  description = "Hashtopolis server hostname"
  value       = xenorchestra_vm.hashtopolis_server.name_label
}

# =============================================================================
# Worker Outputs
# =============================================================================

output "worker_ids" {
  description = "List of worker VM IDs"
  value       = xenorchestra_vm.workers[*].id
}

output "worker_ips" {
  description = "List of worker IP addresses"
  value       = [for w in xenorchestra_vm.workers : try(w.ipv4_addresses[0], "pending")]
}

output "worker_names" {
  description = "List of worker hostnames"
  value       = xenorchestra_vm.workers[*].name_label
}

output "worker_count" {
  description = "Number of workers deployed"
  value       = var.worker_count
}

# =============================================================================
# Connection Info
# =============================================================================

output "ssh_command_server" {
  description = "SSH command to connect to server"
  value       = "ssh ${var.ssh_user}@${try(xenorchestra_vm.hashtopolis_server.ipv4_addresses[0], "pending")}"
  depends_on  = [time_sleep.wait_for_server_ip]
}

output "ssh_command_workers" {
  description = "SSH commands to connect to workers"
  value = [
    for i, worker in xenorchestra_vm.workers :
    "ssh ${var.ssh_user}@${try(worker.ipv4_addresses[0], "pending")}"
  ]
}

# =============================================================================
# Ansible Inventory (JSON format)
# =============================================================================

output "ansible_inventory" {
  description = "Dynamic Ansible inventory in JSON format"
  depends_on  = [time_sleep.wait_for_server_ip]
  value = jsonencode({
    all = {
      children = {
        server = {
          hosts = {
            (xenorchestra_vm.hashtopolis_server.name_label) = {
              ansible_host = try(xenorchestra_vm.hashtopolis_server.ipv4_addresses[0], "pending")
              ansible_user = var.ssh_user
            }
          }
        }
        workers = {
          hosts = {
            for i, worker in xenorchestra_vm.workers :
            worker.name_label => {
              ansible_host = try(worker.ipv4_addresses[0], "pending")
              ansible_user = var.ssh_user
            }
          }
        }
      }
      vars = {
        hashtopolis_server_url = try("https://${xenorchestra_vm.hashtopolis_server.ipv4_addresses[0]}:8080", "pending")
        ansible_ssh_common_args = "-o StrictHostKeyChecking=no"
      }
    }
  })
  sensitive = false
}

# =============================================================================
# Configuration Summary
# =============================================================================

output "deployment_summary" {
  description = "Summary of deployed infrastructure"
  depends_on  = [time_sleep.wait_for_server_ip]
  value = <<-EOT

    ╔══════════════════════════════════════════════════════════════════╗
    ║                    HASHCRACK DEPLOYMENT SUMMARY                  ║
    ╠══════════════════════════════════════════════════════════════════╣
    ║  Server:                                                         ║
    ║    Name: ${xenorchestra_vm.hashtopolis_server.name_label}
    ║    IP:   ${try(xenorchestra_vm.hashtopolis_server.ipv4_addresses[0], "pending")}
    ║    URL:  https://${try(xenorchestra_vm.hashtopolis_server.ipv4_addresses[0], "pending")}:8080
    ║                                                                  ║
    ║  Workers: ${var.worker_count} deployed
    ║    ${join("\n    ", [for w in xenorchestra_vm.workers : "${w.name_label}: ${try(w.ipv4_addresses[0], "pending")}"])}
    ║                                                                  ║
    ║  SSH Access:                                                     ║
    ║    ssh ${var.ssh_user}@${try(xenorchestra_vm.hashtopolis_server.ipv4_addresses[0], "pending")}
    ║                                                                  ║
    ╚══════════════════════════════════════════════════════════════════╝
  EOT
}
