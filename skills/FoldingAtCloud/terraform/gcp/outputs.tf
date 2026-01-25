# =============================================================================
# Folding@Cloud GCP Outputs - One-Shot GPU
# =============================================================================

output "instance_name" {
  description = "Name of the GPU instance"
  value       = google_compute_instance.fah_gpu.name
}

output "instance_zone" {
  description = "Zone of the GPU instance"
  value       = google_compute_instance.fah_gpu.zone
}

output "public_ip" {
  description = "Public IP address of the GPU instance"
  value       = google_compute_instance.fah_gpu.network_interface[0].access_config[0].nat_ip
}

output "ssh_command" {
  description = "SSH command to connect"
  value       = "ssh ${var.ssh_user}@${google_compute_instance.fah_gpu.network_interface[0].access_config[0].nat_ip}"
}

output "gpu_type" {
  description = "GPU type attached"
  value       = var.gpu_type
}

output "machine_type" {
  description = "Machine type"
  value       = var.machine_type
}

output "spot_enabled" {
  description = "Whether spot/preemptible pricing is enabled"
  value       = var.use_spot
}

output "fah_machine_name" {
  description = "FAH machine name"
  value       = var.fah_machine_name
}

output "one_shot_mode" {
  description = "Whether one-shot mode is enabled"
  value       = var.one_shot_mode
}

output "fah_portal_url" {
  description = "URL to manage FAH machines"
  value       = "https://v8-4.foldingathome.org/"
}

output "check_completion_command" {
  description = "Command to check if one-shot WU is complete"
  value       = "ssh ${var.ssh_user}@${google_compute_instance.fah_gpu.network_interface[0].access_config[0].nat_ip} 'test -f /tmp/fah-oneshot-complete && echo COMPLETE || echo RUNNING'"
}

output "destroy_command" {
  description = "Command to destroy after WU completion"
  value       = "terraform destroy -auto-approve"
}
