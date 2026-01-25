# =============================================================================
# Folding@Cloud AWS Outputs - One-Shot GPU
# =============================================================================

output "instance_id" {
  description = "EC2 instance ID"
  value       = aws_instance.fah_gpu.id
}

output "public_ip" {
  description = "Public IP address"
  value       = aws_instance.fah_gpu.public_ip
}

output "public_dns" {
  description = "Public DNS name"
  value       = aws_instance.fah_gpu.public_dns
}

output "ssh_command" {
  description = "SSH command to connect"
  value       = "ssh -i ~/.ssh/id_ed25519 ubuntu@${aws_instance.fah_gpu.public_ip}"
}

output "instance_type" {
  description = "Instance type"
  value       = var.instance_type
}

output "fah_machine_name" {
  description = "FAH machine name"
  value       = var.fah_machine_name
}

output "one_shot_mode" {
  description = "One-shot mode enabled"
  value       = var.one_shot_mode
}

output "fah_portal_url" {
  description = "FAH portal URL"
  value       = "https://v8-4.foldingathome.org/"
}

output "check_completion_command" {
  description = "Command to check if WU is complete"
  value       = "ssh -i ~/.ssh/id_ed25519 ubuntu@${aws_instance.fah_gpu.public_ip} 'test -f /tmp/fah-oneshot-complete && echo COMPLETE || echo RUNNING'"
}

output "destroy_command" {
  description = "Command to destroy after completion"
  value       = "terraform destroy -auto-approve"
}

output "vpc_id" {
  description = "VPC ID"
  value       = aws_vpc.fah_gpu.id
}

output "subnet_id" {
  description = "Subnet ID"
  value       = aws_subnet.fah_gpu.id
}
