# =============================================================================
# Folding@Cloud AWS Main - One-Shot GPU
# Self-contained VPC with GPU instance
# =============================================================================

# Get latest Ubuntu 24.04 AMI
data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"]  # Canonical

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

# VPC
resource "aws_vpc" "fah_gpu" {
  cidr_block           = "10.0.0.0/16"
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = {
    Name = "fah-gpu-oneshot-vpc"
  }
}

# Internet Gateway
resource "aws_internet_gateway" "fah_gpu" {
  vpc_id = aws_vpc.fah_gpu.id

  tags = {
    Name = "fah-gpu-oneshot-igw"
  }
}

# Public Subnet
resource "aws_subnet" "fah_gpu" {
  vpc_id                  = aws_vpc.fah_gpu.id
  cidr_block              = "10.0.1.0/24"
  map_public_ip_on_launch = true
  availability_zone       = "${var.aws_region}a"

  tags = {
    Name = "fah-gpu-oneshot-subnet"
  }
}

# Route Table
resource "aws_route_table" "fah_gpu" {
  vpc_id = aws_vpc.fah_gpu.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.fah_gpu.id
  }

  tags = {
    Name = "fah-gpu-oneshot-rt"
  }
}

# Route Table Association
resource "aws_route_table_association" "fah_gpu" {
  subnet_id      = aws_subnet.fah_gpu.id
  route_table_id = aws_route_table.fah_gpu.id
}

# Create key pair if needed
resource "aws_key_pair" "fah_gpu" {
  key_name   = var.key_name
  public_key = var.ssh_public_key

  lifecycle {
    ignore_changes = [public_key]
  }
}

# Security group
resource "aws_security_group" "fah_gpu" {
  name        = "fah-gpu-oneshot-sg"
  description = "Security group for FAH GPU one-shot"
  vpc_id      = aws_vpc.fah_gpu.id

  ingress {
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
    description = "SSH"
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
    description = "All outbound"
  }

  tags = {
    Name = "fah-gpu-oneshot-sg"
  }
}

# GPU Instance
resource "aws_instance" "fah_gpu" {
  ami           = data.aws_ami.ubuntu.id
  instance_type = var.instance_type
  key_name      = aws_key_pair.fah_gpu.key_name
  subnet_id     = aws_subnet.fah_gpu.id

  vpc_security_group_ids = [aws_security_group.fah_gpu.id]

  root_block_device {
    volume_size = 50
    volume_type = "gp3"
  }

  user_data = templatefile("${path.module}/cloud-init/fah-gpu.yaml", {
    hostname          = "fah-gpu-aws"
    machine_name      = var.fah_machine_name
    fah_account_token = var.fah_account_token
    fah_team_id       = var.fah_team_id
    fah_passkey       = var.fah_passkey
    one_shot_mode     = var.one_shot_mode
  })

  tags = {
    Name = "fah-gpu-oneshot"
  }

  # Don't replace on user_data change
  lifecycle {
    ignore_changes = [user_data]
  }
}
