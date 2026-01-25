# =============================================================================
# Security Groups
# =============================================================================

# Hashtopolis Server Security Group
resource "aws_security_group" "server" {
  name        = "${var.project_name}-server-sg"
  description = "Security group for Hashtopolis server"
  vpc_id      = aws_vpc.hashcrack.id

  # SSH access
  ingress {
    description = "SSH"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = [var.allowed_ssh_cidr]
  }

  # Hashtopolis API (backend)
  ingress {
    description = "Hashtopolis API"
    from_port   = 8080
    to_port     = 8080
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # Hashtopolis Frontend
  ingress {
    description = "Hashtopolis Frontend"
    from_port   = 4200
    to_port     = 4200
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # Allow all outbound traffic
  egress {
    description = "All outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "${var.project_name}-server-sg"
  }
}

# Worker Security Group
resource "aws_security_group" "worker" {
  name        = "${var.project_name}-worker-sg"
  description = "Security group for Hashcat workers"
  vpc_id      = aws_vpc.hashcrack.id

  # SSH access
  ingress {
    description = "SSH"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = [var.allowed_ssh_cidr]
  }

  # Allow all outbound traffic (needed to reach Hashtopolis server)
  egress {
    description = "All outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "${var.project_name}-worker-sg"
  }
}
