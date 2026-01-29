# FoldingAtCloud

A PAI (Personal AI Infrastructure) skill to deploy [Folding@Home](https://foldingathome.org) workers on spare cloud credits. Convert unused cloud resources into medical research compute donations.

## Features

- **Multi-Cloud Support**: Azure, AWS, GCP, OCI with provider-specific optimizations
- **GPU & CPU Modes**: One-shot GPU for quick donations, multi-worker CPU for sustained folding
- **Graceful Shutdown**: Never abandons work units mid-computation
- **Budget Tracking**: Monitor and enforce spending limits
- **Infrastructure as Code**: Fully automated via Terraform

## Quick Start

### Prerequisites

- [Terraform](https://terraform.io) >= 1.0
- Cloud provider CLI configured (aws, az, gcloud, or oci)
- FAH account token from [foldingathome.org](https://v8-4.foldingathome.org/)
- SSH key pair

### Deploy GPU One-Shot on AWS

```bash
cd terraform/aws
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars with your credentials
terraform init
terraform apply
```

### Deploy CPU Workers on Azure

```bash
cd terraform/azure
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars with your credentials
terraform init
terraform apply
```

### Monitor Workers

```bash
# Check work unit status
ssh user@worker-ip "lufah units"

# Check if GPU is being used (GPU instances)
ssh user@worker-ip "lufah state | jq '.info.gpus'"
```

### Graceful Teardown

```bash
# Signal workers to finish current work unit
ssh user@worker-ip "lufah finish"

# Wait for completion (status shows "Paused" with 0 units)
ssh user@worker-ip "lufah units"

# Then destroy infrastructure
terraform destroy
```

## Supported Providers

| Provider | Mode | Instance Type | Notes |
|----------|------|---------------|-------|
| **Azure** | CPU Multi-Worker | Standard_D2s_v3+ | Multi-worker support |
| **AWS** | GPU One-Shot | g4dn.xlarge (T4) | Best for quick GPU donations |
| **GCP** | GPU One-Shot | n1-standard-4 + T4/L4 | GPU alternative |
| **OCI** | CPU Multi-Worker | VM.Standard.E4.Flex | Cost-effective option |

## Important: Never Use Spot Instances

**Spot/preemptible instances are NOT suitable for Folding@Home.**

When the cloud provider reclaims a spot instance, your work unit is abandoned:
- FAH reputation damage (potential points penalty)
- Partial computation is lost (wasted science)
- Bad citizenship in the FAH community

All terraform configurations default to on-demand instances.

## Configuration

### Required Variables

| Variable | Description |
|----------|-------------|
| `fah_account_token` | From FAH portal (Settings > Account Token) |
| `ssh_public_key` | Your SSH public key for worker access |

### Optional Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `fah_team_id` | 245143 | FAH team number |
| `fah_passkey` | (none) | For bonus points |
| `worker_count` | varies | Number of workers (CPU mode) |

## GPU Folding Notes

1. **Two-phase boot**: GPU drivers require a reboot to load. Cloud-init handles this automatically.
2. **One-shot mode**: GPU workers complete one work unit then pause, ideal for spare credits.
3. **T4 preferred**: NVIDIA T4 GPUs have best FAH compatibility.
4. **Typical timing**: GPU WUs complete in 15-60 minutes vs 14+ hours for CPU.

## Project Structure

```
FoldingAtCloud/
├── skill.md                 # PAI skill manifest
├── GracefulShutdown.md     # Graceful termination procedures
├── README.md               # This file
├── learnings/              # Deployment learnings and anti-patterns
├── terraform/
│   ├── aws/               # AWS GPU one-shot
│   ├── azure/             # Azure CPU multi-worker
│   ├── gcp/               # GCP GPU one-shot
│   └── oci/               # OCI CPU multi-worker
├── Tools/                  # TypeScript utilities
└── Workflows/             # Operational procedures
```

## Tools

- **WorkerControl.ts**: SSH wrapper for lufah commands (finish, pause, status)
- **BudgetTracker.ts**: Cost tracking and enforcement

## Security

- Credentials stored only in `terraform.tfvars` (gitignored)
- SSH key authentication (no passwords)
- Minimal security groups (SSH inbound only)
- Rotate FAH account token after use (recommended)

## References

- [Folding@Home](https://foldingathome.org)
- [FAH v8.5 Client Guide](https://foldingathome.org/guides/v8-5-client-guide/)
- [lufah CLI](https://github.com/kbernhagen/lufah)
- [FAH Portal](https://v8-4.foldingathome.org/)

## Contributing

Contributions welcome! Please ensure:
1. Never commit `terraform.tfvars` or `.tfstate` files
2. Test on at least one cloud provider before submitting
3. Update documentation for any new features

## License

MIT License - See LICENSE file for details.

---

*Part of the [PAI (Personal AI Infrastructure)](https://github.com/danielmiessler/Personal_AI_Infrastructure) ecosystem.*
