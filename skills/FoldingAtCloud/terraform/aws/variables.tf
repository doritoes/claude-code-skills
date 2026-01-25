# =============================================================================
# Folding@Cloud AWS Variables - One-Shot GPU
# =============================================================================

variable "aws_region" {
  description = "AWS region"
  type        = string
  default     = "us-east-1"
}

variable "instance_type" {
  description = "EC2 instance type with GPU"
  type        = string
  default     = "g4dn.xlarge"  # T4 GPU, 4 vCPUs, 16GB RAM
}

variable "ami_id" {
  description = "AMI ID (Ubuntu 24.04 with NVIDIA drivers)"
  type        = string
  default     = ""  # Will use data source if not specified
}

variable "key_name" {
  description = "SSH key pair name"
  type        = string
}

variable "ssh_public_key" {
  description = "SSH public key content (used if key_name doesn't exist)"
  type        = string
}

# Folding@Home Configuration
variable "fah_account_token" {
  description = "FAH account token"
  type        = string
  sensitive   = true
}

variable "fah_machine_name" {
  description = "FAH machine name"
  type        = string
  default     = "pai-fold-gpu-aws"
}

variable "fah_team_id" {
  description = "FAH team ID"
  type        = string
  default     = "245143"
}

variable "fah_passkey" {
  description = "FAH passkey"
  type        = string
  sensitive   = true
  default     = ""
}

variable "one_shot_mode" {
  description = "Enable one-shot mode"
  type        = bool
  default     = true
}
