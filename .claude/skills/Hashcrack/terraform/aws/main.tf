# =============================================================================
# Hashcrack AWS Infrastructure - Main Configuration
# =============================================================================

locals {
  # Generate random passwords if not provided
  db_password    = var.hashtopolis_db_password != "" ? var.hashtopolis_db_password : random_password.db_password[0].result
  admin_password = var.hashtopolis_admin_password != "" ? var.hashtopolis_admin_password : random_password.admin_password[0].result
  voucher_code   = var.worker_voucher != "" ? var.worker_voucher : random_string.voucher[0].result

  # Common tags (in addition to default_tags in provider)
  common_tags = {
    Project     = var.project_name
    Environment = var.environment
  }
}

# =============================================================================
# Random Password Generation
# =============================================================================

resource "random_password" "db_password" {
  count   = var.hashtopolis_db_password == "" ? 1 : 0
  length  = 24
  special = false
}

resource "random_password" "admin_password" {
  count   = var.hashtopolis_admin_password == "" ? 1 : 0
  length  = 16
  special = true
}

resource "random_string" "voucher" {
  count   = var.worker_voucher == "" ? 1 : 0
  length  = 12
  special = false
  upper   = true
}

# =============================================================================
# Data Sources - AMI Lookup
# =============================================================================

data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"] # Canonical

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

data "aws_availability_zones" "available" {
  state = "available"
}

# =============================================================================
# VPC and Networking
# =============================================================================

resource "aws_vpc" "hashcrack" {
  cidr_block           = var.vpc_cidr
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = {
    Name = "${var.project_name}-vpc"
  }
}

resource "aws_internet_gateway" "hashcrack" {
  vpc_id = aws_vpc.hashcrack.id

  tags = {
    Name = "${var.project_name}-igw"
  }
}

resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.hashcrack.id
  cidr_block              = var.subnet_cidr
  availability_zone       = data.aws_availability_zones.available.names[0]
  map_public_ip_on_launch = true

  tags = {
    Name = "${var.project_name}-public-subnet"
  }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.hashcrack.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.hashcrack.id
  }

  tags = {
    Name = "${var.project_name}-public-rt"
  }
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

# =============================================================================
# SSH Key Pair
# =============================================================================

resource "aws_key_pair" "hashcrack" {
  key_name   = "${var.project_name}-key"
  public_key = var.ssh_public_key

  tags = {
    Name = "${var.project_name}-key"
  }
}

# =============================================================================
# Wait for Server to be Ready
# =============================================================================

resource "time_sleep" "wait_for_server" {
  depends_on = [aws_instance.hashtopolis_server]

  create_duration = "90s"
}
