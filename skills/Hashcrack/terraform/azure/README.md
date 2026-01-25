# Azure Hashcrack Deployment

## Prerequisites

- Azure subscription
- Azure CLI: `az login`

## Instance Types

| Role | VM Size | Specs | Cost/hr |
|------|---------|-------|---------|
| Server | Standard_B2s | 2 vCPU, 4 GB | $0.042 |
| CPU Worker | Standard_F4s_v2 | 4 vCPU, 8 GB | $0.17 |
| GPU Worker | Standard_NC4as_T4_v3 | 4 vCPU, T4 | $0.53 |

## Deployment

```bash
cd terraform/azure
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars with your config

terraform init
terraform plan
terraform apply
```

## Authentication

```bash
# Option 1: Azure CLI
az login

# Option 2: Service Principal
export ARM_CLIENT_ID="..."
export ARM_CLIENT_SECRET="..."
export ARM_TENANT_ID="..."
export ARM_SUBSCRIPTION_ID="..."
```

## Spot VMs

Set `use_spot_instances = true` in terraform.tfvars for cost savings.

## Notes

- Resource group auto-created with project name
- Workers have private IPs only (SSH via server jump host)

## Recommended Regions

- **Primary:** eastus
- **Backup:** westus2

## Cleanup

```bash
terraform destroy
```
