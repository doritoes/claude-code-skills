---
name: FoldingAtCloud
description: Deploy Folding@Home workers on spare cloud credits. USE WHEN user wants to fold, donate compute cycles, F@H, Folding@Home, folding at home, spare credits, science donation. Deploys Ubuntu 24.04 VMs with FAH v8.5.5 client, manages via lufah, graceful scale-down, budget tracking.
---

# FoldingAtCloud

Convert spare cloud credits into Folding@Home compute donations. Deploys ephemeral Ubuntu 24.04 LTS VMs running FAH v8.5.5 client with graceful scale-down (finish work units before termination) and budget enforcement.

---

## Quick Start

```bash
# Deploy CPU workers on Azure
cd terraform/azure
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars with your credentials
terraform init && terraform apply

# Deploy GPU one-shot on AWS (T4)
cd terraform/aws
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars with your credentials
terraform init && terraform apply

# Check status via SSH
ssh user@worker-ip "lufah units"

# Graceful teardown (finish WUs first)
ssh user@worker-ip "lufah finish"
# Wait for units to complete, then:
terraform destroy
```

---

## Environment Variables

Required in `terraform.tfvars` per provider:

| Variable | Purpose |
|----------|---------|
| `fah_account_token` | Headless machine registration (from FAH portal) |
| `fah_team_id` | Team number (default: 245143) |
| `fah_passkey` | Points passkey (optional) |
| `ssh_public_key` | SSH public key for worker access |

Cloud provider credentials via standard methods (AWS CLI, Azure CLI, gcloud, OCI config).

---

## Workflow Routing

| Workflow | Trigger | File |
|----------|---------|------|
| **Deploy** | "deploy folding", "spin up folders" | `Workflows/Deploy.md` |
| **Monitor** | "check folding", "folding status" | `Workflows/Monitor.md` |
| **Scale** | "scale folding", "add/remove workers" | `Workflows/Scale.md` |
| **Teardown** | "stop folding", "teardown folding" | `Workflows/Teardown.md` |
| **Status** | "folding stats", "points earned" | `Workflows/Status.md` |

---

## Architecture

```
PAI FoldingAtCloud
       |
       v
Terraform (Azure / AWS / GCP / OCI)
       |
       v
Ubuntu 24.04 LTS VMs
  - fah-client v8.5.5
  - lufah (Python CLI)
  - python3 >= 3.9
  - NVIDIA drivers (GPU instances)
       |
       v
FAH Portal (v8-4.foldingathome.org)
  - Machine management
  - Points tracking
  - Work unit assignment
```

---

## Graceful Scale-Down

**Never terminate mid-work-unit.** The skill:

1. Sends `lufah finish` command to workers
2. Polls until worker reports `paused` state (no running units)
3. Only then terminates the VM
4. Timeout after `FOLDING_GRACEFUL_TIMEOUT` (default 30 min)

See `GracefulShutdown.md` for detailed procedures.

---

## Supported Providers

| Provider | Mode | Instance Type | Notes |
|----------|------|---------------|-------|
| Azure | CPU Multi-Worker | Standard_D2s_v3+ | Best for multi-worker CPU |
| AWS | GPU One-Shot | g4dn.xlarge (T4) | Best for GPU donations |
| GCP | GPU One-Shot | n1-standard-4 + T4/L4 | GPU alternative |
| OCI | CPU Multi-Worker | VM.Standard.E4.Flex | Cost-effective ARM option |

### Anti-Pattern: Spot/Preemptible Instances

**NEVER use spot/preemptible instances for Folding@Home.** When the cloud provider reclaims the instance, your work unit is abandoned. This:
- Damages your FAH reputation (potential points penalty)
- Wastes the partial computation (science lost)
- Is bad citizenship in the FAH community

All terraform configurations default to on-demand instances.

---

## GPU Support

For GPU folding (significantly faster than CPU):

1. **Two-phase boot**: GPU driver installation requires a reboot before the driver is usable
2. **One-shot mode**: Complete one GPU work unit, then pause (ideal for spare credits)
3. **T4 preferred**: NVIDIA T4 has best FAH compatibility; L4 works but may have issues

GPU WUs complete in 15-60 minutes vs 14+ hours for CPU.

---

## Tools

| Tool | Purpose |
|------|---------|
| `WorkerControl.ts` | lufah/SSH wrapper for finish/pause/status |
| `BudgetTracker.ts` | Cost tracking and enforcement |

---

## Security

- FAH credentials in `terraform.tfvars` only (gitignored)
- SSH key auth for worker access
- Minimal security group (SSH inbound, all outbound)
- Account token rotated after use (recommended)

---

## References

- [FAH v8.5 Client Guide](https://foldingathome.org/guides/v8-5-client-guide/)
- [lufah CLI](https://github.com/kbernhagen/lufah)
- [FAH v8 WebSocket API](https://github.com/FoldingAtHome/fah-client-bastet/discussions/215)
- [FAH Portal](https://v8-4.foldingathome.org/)
- [FAH v8.5.5 Release](https://download.foldingathome.org/releases/public/fah-client/debian-10-64bit/release/)
