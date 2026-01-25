# AWS GPU One-Shot Deployment

Deploy a single g4dn.xlarge (NVIDIA T4) instance for GPU folding in one-shot mode.

## Features

- NVIDIA T4 GPU (16GB VRAM)
- Ubuntu 24.04 LTS
- Two-phase boot (driver install → reboot → FAH start)
- One-shot mode: complete 1 GPU WU then pause
- Self-contained VPC

## Quick Start

```bash
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars

terraform init
terraform apply
```

## Outputs

| Output | Description |
|--------|-------------|
| `public_ip` | Instance IP address |
| `ssh_command` | SSH connection command |
| `check_completion_command` | Check if WU is complete |

## GPU WU Timing

GPU work units typically complete in 15-60 minutes.

## Teardown

```bash
# Check completion first
ssh ubuntu@<ip> "test -f /tmp/fah-oneshot-complete && echo DONE"

terraform destroy
```
