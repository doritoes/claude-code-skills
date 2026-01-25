# =============================================================================
# Hashcat CPU Worker EC2 Spot Instances
# =============================================================================

resource "aws_spot_instance_request" "cpu_workers" {
  count = var.cpu_worker_count

  ami                    = data.aws_ami.ubuntu.id
  instance_type          = var.cpu_worker_instance_type
  key_name               = aws_key_pair.hashcrack.key_name
  vpc_security_group_ids = [aws_security_group.worker.id]
  subnet_id              = aws_subnet.public.id

  spot_type            = "one-time"
  wait_for_fulfillment = true

  root_block_device {
    volume_size           = var.worker_disk_gb
    volume_type           = "gp3"
    delete_on_termination = true
  }

  user_data = templatefile("${path.module}/../cloud-init/worker.yaml", {
    hostname       = "${var.project_name}-cpu-worker-${count.index + 1}"
    worker_id      = count.index + 1
    ssh_user       = var.ssh_user
    ssh_public_key = var.ssh_public_key
    server_url     = aws_instance.hashtopolis_server.private_ip
    voucher_code   = local.voucher_codes[count.index]
  })

  tags = {
    Name = "${var.project_name}-cpu-worker-${count.index + 1}"
    Role = "cpu-worker-spot"
  }

  depends_on = [time_sleep.wait_for_server]

  lifecycle {
    ignore_changes = [user_data]
  }
}

# =============================================================================
# CPU Spot Instance Tagging (applies Name to actual instance, not just request)
# =============================================================================

resource "aws_ec2_tag" "cpu_worker_name" {
  count       = var.cpu_worker_count
  resource_id = aws_spot_instance_request.cpu_workers[count.index].spot_instance_id
  key         = "Name"
  value       = "${var.project_name}-cpu-worker-${count.index + 1}"
}

resource "aws_ec2_tag" "cpu_worker_role" {
  count       = var.cpu_worker_count
  resource_id = aws_spot_instance_request.cpu_workers[count.index].spot_instance_id
  key         = "Role"
  value       = "cpu-worker-spot"
}

# =============================================================================
# Hashcat GPU Worker EC2 On-Demand Instances
# =============================================================================

resource "aws_instance" "gpu_workers" {
  count = var.gpu_worker_count

  ami                    = data.aws_ami.ubuntu.id
  instance_type          = var.gpu_worker_instance_type
  key_name               = aws_key_pair.hashcrack.key_name
  vpc_security_group_ids = [aws_security_group.worker.id]
  subnet_id              = aws_subnet.public.id

  root_block_device {
    volume_size           = var.worker_disk_gb
    volume_type           = "gp3"
    delete_on_termination = true
  }

  user_data = templatefile("${path.module}/../cloud-init/worker-gpu.yaml", {
    hostname       = "${var.project_name}-gpu-worker-${count.index + 1}"
    worker_id      = 100 + count.index + 1
    ssh_user       = var.ssh_user
    ssh_public_key = var.ssh_public_key
    server_url     = aws_instance.hashtopolis_server.private_ip
    voucher_code   = local.voucher_codes[var.cpu_worker_count + count.index]
  })

  tags = {
    Name = "${var.project_name}-gpu-worker-${count.index + 1}"
    Role = "gpu-worker"
  }

  depends_on = [time_sleep.wait_for_server]

  lifecycle {
    ignore_changes = [user_data]
  }
}
