# =============================================================================
# Folding@Cloud OCI Outputs
# =============================================================================

output "worker_count" {
  description = "Number of FAH workers deployed"
  value       = var.worker_count
}

output "worker_public_ips" {
  description = "Public IP addresses of FAH workers"
  value       = [for instance in oci_core_instance.workers : instance.public_ip]
}

output "worker_private_ips" {
  description = "Private IP addresses of FAH workers"
  value       = [for instance in oci_core_instance.workers : instance.private_ip]
}

output "worker_names" {
  description = "Names of FAH worker instances"
  value       = [for instance in oci_core_instance.workers : instance.display_name]
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
  value       = [for instance in oci_core_instance.workers : "ssh ${var.ssh_user}@${instance.public_ip}"]
}

output "worker_shape" {
  description = "OCI compute shape used"
  value       = var.worker_shape
}

output "worker_ocpus" {
  description = "OCPUs per worker"
  value       = var.worker_ocpus
}

output "total_ocpus" {
  description = "Total OCPUs deployed"
  value       = var.worker_count * var.worker_ocpus
}

output "fah_portal_url" {
  description = "URL to manage FAH machines"
  value       = "https://v8-4.foldingathome.org/"
}

output "vcn_id" {
  description = "VCN OCID"
  value       = oci_core_vcn.foldingcloud.id
}

output "availability_domain" {
  description = "Availability domain used"
  value       = data.oci_identity_availability_domains.ads.availability_domains[var.availability_domain_index].name
}
