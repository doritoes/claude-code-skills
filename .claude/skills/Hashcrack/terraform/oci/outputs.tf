# =============================================================================
# OCI Infrastructure Outputs
# =============================================================================

output "server_ip" {
  description = "Hashtopolis server public IP address"
  value       = oci_core_instance.hashtopolis_server.public_ip
}

output "server_private_ip" {
  description = "Hashtopolis server private IP address"
  value       = oci_core_instance.hashtopolis_server.private_ip
}

output "cpu_worker_ips" {
  description = "CPU worker public IP addresses"
  value       = [for w in oci_core_instance.cpu_workers : w.public_ip]
}

output "gpu_worker_ips" {
  description = "GPU worker public IP addresses"
  value       = [for w in oci_core_instance.gpu_workers : w.public_ip]
}

output "hashtopolis_url" {
  description = "Hashtopolis web interface URL"
  value       = "http://${oci_core_instance.hashtopolis_server.public_ip}:8080"
}

output "ssh_connection" {
  description = "SSH connection command for server"
  value       = "ssh ${var.ssh_user}@${oci_core_instance.hashtopolis_server.public_ip}"
}

output "vcn_id" {
  description = "VCN OCID"
  value       = oci_core_vcn.hashcrack.id
}

output "subnet_id" {
  description = "Public subnet OCID"
  value       = oci_core_subnet.public.id
}

# =============================================================================
# Cost Estimate Info
# =============================================================================

output "instance_info" {
  description = "Instance configuration summary"
  value = {
    server = {
      shape  = var.server_shape
      ocpus  = var.server_ocpus
      memory = var.server_memory_gb
    }
    cpu_workers = {
      count       = var.cpu_worker_count
      shape       = var.cpu_worker_shape
      ocpus       = var.cpu_worker_ocpus
      memory      = var.cpu_worker_memory_gb
      preemptible = var.use_preemptible
    }
    gpu_workers = {
      count       = var.gpu_worker_count
      shape       = var.gpu_worker_shape
      preemptible = var.use_preemptible
    }
  }
}
