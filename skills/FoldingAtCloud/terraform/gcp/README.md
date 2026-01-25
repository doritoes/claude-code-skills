# GCP GPU One-Shot Deployment

Deploy a single n1-standard-4 with NVIDIA T4 or L4 GPU for GPU folding.

## Features

- NVIDIA T4 or L4 GPU
- Ubuntu 24.04 LTS
- Two-phase boot (driver install → reboot → FAH start)
- One-shot mode: complete 1 GPU WU then pause

## Quick Start

```bash
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars

terraform init
terraform apply
```

## GPU Availability

- **T4**: Preferred, best FAH compatibility. May be limited in some zones.
- **L4**: Good availability, newer architecture.

Check availability:
```bash
gcloud compute accelerator-types list --filter="zone:us-central1-a"
```

## Outputs

| Output | Description |
|--------|-------------|
| `public_ip` | Instance IP address |
| `ssh_command` | SSH connection command |
| `gpu_type` | Deployed GPU type |

## Teardown

```bash
# Check completion
ssh foldingadmin@<ip> "lufah units"

terraform destroy
```
