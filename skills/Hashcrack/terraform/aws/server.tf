# =============================================================================
# Hashtopolis Server EC2 Instance
# =============================================================================

resource "aws_instance" "hashtopolis_server" {
  ami                    = data.aws_ami.ubuntu.id
  instance_type          = var.server_instance_type
  key_name               = aws_key_pair.hashcrack.key_name
  vpc_security_group_ids = [aws_security_group.server.id]
  subnet_id              = aws_subnet.public.id

  root_block_device {
    volume_size           = var.server_disk_gb
    volume_type           = "gp3"
    delete_on_termination = true
  }

  # Cloud-init configuration (reuse existing template)
  user_data = templatefile("${path.module}/../cloud-init/server.yaml", {
    hostname       = "${var.project_name}-server"
    ssh_user       = var.ssh_user
    ssh_public_key = var.ssh_public_key
    db_password    = local.db_password
    admin_user     = var.hashtopolis_admin_user
    admin_password = local.admin_password
    voucher_code   = local.voucher_code
    all_vouchers   = local.all_vouchers
    worker_count   = local.total_worker_count
  })

  tags = {
    Name = "${var.project_name}-server"
    Role = "server"
  }

  lifecycle {
    ignore_changes = [
      user_data # Don't recreate on cloud-init changes
    ]
  }
}

# =============================================================================
# Server Credentials Output (Sensitive)
# =============================================================================

output "hashtopolis_credentials" {
  description = "Hashtopolis login credentials"
  depends_on  = [time_sleep.wait_for_server]
  value = {
    url      = "http://${aws_instance.hashtopolis_server.public_ip}:8080"
    username = var.hashtopolis_admin_user
    password = local.admin_password
  }
  sensitive = true
}

output "db_password" {
  description = "Hashtopolis database password"
  value       = local.db_password
  sensitive   = true
}

output "voucher_code" {
  description = "Worker registration voucher code"
  value       = local.voucher_code
  sensitive   = true
}
