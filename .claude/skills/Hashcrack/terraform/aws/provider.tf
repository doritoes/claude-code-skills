# =============================================================================
# AWS Provider Configuration
# =============================================================================

terraform {
  required_version = ">= 1.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.0"
    }
    time = {
      source  = "hashicorp/time"
      version = "~> 0.9"
    }
  }
}

provider "aws" {
  region = var.aws_region

  # Credentials from environment variables:
  # AWS_ACCESS_KEY_ID
  # AWS_SECRET_ACCESS_KEY

  default_tags {
    tags = {
      Project     = var.project_name
      Environment = var.environment
      ManagedBy   = "terraform"
      Owner       = "pai"
    }
  }
}
