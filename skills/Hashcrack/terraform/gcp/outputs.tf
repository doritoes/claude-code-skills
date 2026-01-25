# =============================================================================
# Hashcrack GCP Terraform Outputs
# =============================================================================

output "server_public_ip" {
  description = "Public IP address of Hashtopolis server"
  value       = google_compute_address.server.address
  depends_on  = [time_sleep.wait_for_server]
}

output "server_private_ip" {
  description = "Private IP address of Hashtopolis server"
  value       = google_compute_instance.server.network_interface[0].network_ip
}

output "server_url" {
  description = "Hashtopolis web UI URL"
  value       = "http://${google_compute_address.server.address}:8080"
  depends_on  = [time_sleep.wait_for_server]
}

output "cpu_worker_ips" {
  description = "Private IPs of CPU workers"
  value       = google_compute_instance.cpu_workers[*].network_interface[0].network_ip
}

output "gpu_worker_ips" {
  description = "Private IPs of GPU workers"
  value       = google_compute_instance.gpu_workers[*].network_interface[0].network_ip
}

output "gpu_worker_public_ips" {
  description = "Public IPs of GPU workers (if enabled)"
  value       = var.worker_public_ip ? [for w in google_compute_instance.gpu_workers : w.network_interface[0].access_config[0].nat_ip] : []
}

output "db_password" {
  description = "Database password"
  value       = local.db_password
  sensitive   = true
}

output "voucher_code" {
  description = "Worker registration voucher"
  value       = local.voucher_code
}

output "deployment_summary" {
  description = "Deployment summary"
  depends_on  = [time_sleep.wait_for_server]
  value       = <<-EOT
    ======================================================================
                      HASHCRACK GCP DEPLOYMENT
    ======================================================================
      Project:    ${var.gcp_project}
      Region:     ${var.gcp_region}
      Zone:       ${var.gcp_zone}

      Server: ${google_compute_address.server.address}
      URL:    http://${google_compute_address.server.address}:8080

      CPU Workers: ${var.cpu_worker_count} × ${var.cpu_worker_machine_type}
      GPU Workers: ${var.gpu_worker_count} × ${var.gpu_worker_machine_type}

      Preemptible: ${var.use_preemptible ? "Yes" : "No (on-demand)"}
    ======================================================================
  EOT
}

output "ssh_commands" {
  description = "SSH connection commands"
  value       = <<-EOT
    # SSH to server (public IP)
    ssh ${var.ssh_user}@${google_compute_address.server.address}

    # Or use gcloud compute ssh:
    gcloud compute ssh ${var.ssh_user}@${var.project_name}-server --zone=${var.gcp_zone}

    # Workers have private IPs only - SSH via server as jump host:
    # ssh -J ${var.ssh_user}@${google_compute_address.server.address} ${var.ssh_user}@<worker_private_ip>
  EOT
}
