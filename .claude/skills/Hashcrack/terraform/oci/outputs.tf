# =============================================================================
# OCI Deployment Outputs
# =============================================================================

output "server_id" {
  description = "Server instance OCID"
  value       = oci_core_instance.hashtopolis_server.id
}

output "server_ip" {
  description = "Server public IP address"
  value       = oci_core_instance.hashtopolis_server.public_ip
  depends_on  = [time_sleep.wait_for_server]
}

output "server_private_ip" {
  description = "Server private IP address"
  value       = oci_core_instance.hashtopolis_server.private_ip
}

output "server_url" {
  description = "Hashtopolis web UI URL"
  value       = "http://${oci_core_instance.hashtopolis_server.public_ip}:8080"
  depends_on  = [time_sleep.wait_for_server]
}

output "cpu_worker_ids" {
  description = "CPU worker instance OCIDs"
  value       = oci_core_instance.cpu_workers[*].id
}

output "cpu_worker_ips" {
  description = "CPU worker public IP addresses"
  value       = oci_core_instance.cpu_workers[*].public_ip
}

output "cpu_worker_private_ips" {
  description = "CPU worker private IP addresses"
  value       = oci_core_instance.cpu_workers[*].private_ip
}

output "gpu_worker_ids" {
  description = "GPU worker instance OCIDs"
  value       = oci_core_instance.gpu_workers[*].id
}

output "gpu_worker_ips" {
  description = "GPU worker public IP addresses"
  value       = oci_core_instance.gpu_workers[*].public_ip
}

output "gpu_worker_private_ips" {
  description = "GPU worker private IP addresses"
  value       = oci_core_instance.gpu_workers[*].private_ip
}

output "vcn_id" {
  description = "VCN OCID"
  value       = oci_core_vcn.hashcrack.id
}

output "subnet_id" {
  description = "Public subnet OCID"
  value       = oci_core_subnet.public.id
}

output "deployment_summary" {
  description = "Deployment summary"
  depends_on  = [time_sleep.wait_for_server]
  value = <<-EOT
    ======================================================================
                      HASHCRACK OCI DEPLOYMENT
    ======================================================================
      Server: ${oci_core_instance.hashtopolis_server.public_ip}
      URL:    http://${oci_core_instance.hashtopolis_server.public_ip}:8080

      CPU Workers${var.use_preemptible ? " (PREEMPTIBLE)" : ""}: ${var.cpu_worker_count}
      ${join("\n      ", [for i, w in oci_core_instance.cpu_workers : "cpu-${i + 1}: ${w.public_ip}"])}

      GPU Workers${var.use_preemptible ? " (PREEMPTIBLE)" : ""}: ${var.gpu_worker_count}
      ${join("\n      ", [for i, w in oci_core_instance.gpu_workers : "gpu-${i + 1}: ${w.public_ip}"])}

      Region: ${var.oci_region}
      Shape:  ${var.cpu_worker_shape} (${var.cpu_worker_ocpus} OCPU, ${var.cpu_worker_memory_gb}GB)
    ======================================================================
  EOT
}
