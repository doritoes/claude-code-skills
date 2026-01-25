# GCP Hashcrack Deployment

## Prerequisites

- GCP project with Compute Engine API enabled
- gcloud CLI configured: `gcloud auth application-default login`

## Instance Types

| Role | Machine Type | Specs | Cost/hr |
|------|--------------|-------|---------|
| Server | e2-medium | 2 vCPU, 4 GB | $0.034 |
| CPU Worker | c2-standard-4 | 4 vCPU, 16 GB | $0.188 |
| GPU Worker | n1-standard-4 + T4 | 4 vCPU, T4 | ~$0.70 |

## Deployment

```bash
cd terraform/gcp
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars with your config

terraform init
terraform plan
terraform apply
```

## Authentication

```bash
# Option 1: User credentials (development)
gcloud auth application-default login

# Option 2: Service account (production)
export GOOGLE_APPLICATION_CREDENTIALS="/path/to/service-account-key.json"
```

## Preemptible VMs

Set `use_preemptible = true` in terraform.tfvars for ~60-70% savings.

## Notes

- Cloud NAT included (required for private IP workers)
- Workers have private IPs only (SSH via server jump host)
- GPU quota required for GPU workers

## Recommended Regions

- **Primary:** us-central1
- **Backup:** us-east1

## Cleanup

```bash
terraform destroy
```
