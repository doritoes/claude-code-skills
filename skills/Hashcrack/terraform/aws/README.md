# AWS Hashcrack Deployment

## Prerequisites

- AWS account with programmatic access
- IAM user/role with EC2, VPC permissions
- AWS CLI configured: `aws configure`

## Instance Types

| Role | Instance | Specs | Cost/hr |
|------|----------|-------|---------|
| Server | t3.medium | 2 vCPU, 4 GB | $0.042 |
| CPU Worker | c5.xlarge | 4 vCPU, 8 GB | $0.17 |
| GPU Worker | g4dn.xlarge | 4 vCPU, T4 | $0.526 |

## Deployment

```bash
cd terraform/aws
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars with your config

terraform init
terraform plan
terraform apply
```

## Authentication

```bash
# Option 1: Environment variables
export AWS_ACCESS_KEY_ID="..."
export AWS_SECRET_ACCESS_KEY="..."
export AWS_DEFAULT_REGION="us-east-1"

# Option 2: AWS credentials file
aws configure

# Option 3: IAM role (if running on EC2)
# Automatic via instance metadata
```

## Spot Instances

Set `use_spot_instances = true` in terraform.tfvars for ~70% cost savings.

## Recommended Regions

- **Primary:** us-east-1 (best spot availability)
- **Backup:** us-west-2

## Cleanup

```bash
terraform destroy
```
