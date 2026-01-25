output "server_id" {
  value = aws_instance.hashtopolis_server.id
}
output "server_ip" {
  description = "Server public IP (alias for server_public_ip)"
  value       = aws_instance.hashtopolis_server.public_ip
  depends_on  = [time_sleep.wait_for_server]
}
output "server_public_ip" {
  description = "Server public IP address"
  value       = aws_instance.hashtopolis_server.public_ip
  depends_on  = [time_sleep.wait_for_server]
}
output "server_url" {
  value      = "http://${aws_instance.hashtopolis_server.public_ip}:8080"
  depends_on = [time_sleep.wait_for_server]
}
output "cpu_worker_ids" {
  value = aws_spot_instance_request.cpu_workers[*].spot_instance_id
}
output "cpu_worker_ips" {
  value = aws_spot_instance_request.cpu_workers[*].public_ip
}
output "gpu_worker_ids" {
  value = aws_instance.gpu_workers[*].id
}
output "gpu_worker_ips" {
  value = aws_instance.gpu_workers[*].public_ip
}
output "vpc_id" {
  value = aws_vpc.hashcrack.id
}
output "deployment_summary" {
  depends_on = [time_sleep.wait_for_server]
  value = <<-EOT
    ======================================================================
                      HASHCRACK AWS DEPLOYMENT
    ======================================================================
      Server: ${aws_instance.hashtopolis_server.public_ip}
      URL:    http://${aws_instance.hashtopolis_server.public_ip}:8080

      CPU Workers (SPOT): ${var.cpu_worker_count}
      ${join("\n      ", [for i, w in aws_spot_instance_request.cpu_workers : "cpu-${i + 1}: ${w.public_ip}"])}

      GPU Workers (ON-DEMAND): ${var.gpu_worker_count}
      ${join("\n      ", [for i, w in aws_instance.gpu_workers : "gpu-${i + 1}: ${w.public_ip}"])}
    ======================================================================
  EOT
}
