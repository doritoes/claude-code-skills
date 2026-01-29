---
name: FoldingAtCloud
description: Deploy Folding@Home workers on spare cloud credits. USE WHEN user wants to fold, donate compute cycles, F@H, Folding@Home, folding at home, spare credits, science donation. Deploys Ubuntu 24.04 VMs with FAH v8.5.5 client, manages via lufah, graceful scale-down, budget tracking.
---

# FoldingAtCloud

Convert spare cloud credits into Folding@Home compute donations. Deploys ephemeral Ubuntu 24.04 LTS VMs running FAH v8.5.5 client with graceful scale-down (finish work units before termination) and budget enforcement.

---

## CRITICAL SAFETY RULES

**These rules are non-negotiable. Violation causes lost research.**

1. **SSH failure does NOT mean VM stopped.** SSH can fail for many reasons. NEVER assume a VM is stopped because SSH timed out. Verify via cloud provider API.

2. **Only `paused: true` is safe to stop.** The ONLY signal that a worker is safe to terminate is `"paused": true` from `lufah state`. Nothing else.

3. **FAH Portal is the source of truth.** Not SSH output, not inferred state. The Portal shows actual worker status.

4. **User confirms each worker.** Claude assists but NEVER autonomously powers off a VM. Each worker requires explicit user confirmation.

5. **Use documented tools.** Use `WorkerControl.ts`, not ad-hoc bash scripts. The tools have safety checks built in.

**See `GracefulShutdown.md` ANTI-PATTERNS section for details.**

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
| **SafeTeardown** | "stop folding", "teardown folding" | `Workflows/SafeTeardown.md` |
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
| `WorkerControl.ts` | lufah/SSH wrapper for finish/pause/status/can-stop |
| `MonitorWorkers.ts` | READ-ONLY monitoring (NO destructive actions) |
| `ProviderControl.ts` | Cloud API operations with safety checks |
| `StateTracker.ts` | Persistent state across context boundaries |
| `AuditLog.ts` | Audit logging for destructive actions |
| `BudgetTracker.ts` | Cost tracking and enforcement |

### WorkerControl.ts Commands

```bash
# Get worker status (JSON output)
bun run WorkerControl.ts status <ip> --provider azure

# Send finish command (complete WU then pause)
bun run WorkerControl.ts finish <ip> --provider azure

# SAFETY CHECK - Must use before any stop action
bun run WorkerControl.ts can-stop <ip> --provider azure
# Returns: {safe: true/false, reason: "...", status: {...}}

# Wait until paused (for graceful shutdown)
bun run WorkerControl.ts wait-paused <ip> --timeout 1800 --provider azure
```

### Provider-Specific SSH Credentials

Set in `.claude/.env`:
```
AZURE_SSH_USER=foldingadmin
AZURE_SSH_KEY=$HOME/.ssh/azure_hashcrack
OCI_SSH_USER=ubuntu
OCI_SSH_KEY=$HOME/.ssh/id_ed25519
```

### MonitorWorkers.ts (READ-ONLY)

```bash
# List workers from terraform state
bun run MonitorWorkers.ts list azure

# Get FAH status of all workers
bun run MonitorWorkers.ts status azure

# Continuous monitoring (Ctrl+C to stop)
bun run MonitorWorkers.ts watch azure --interval 60
```

### ProviderControl.ts (Cloud API with Safety)

```bash
# Get VM power state
bun run ProviderControl.ts vm-state azure foldingcloud-worker-1

# List VMs
bun run ProviderControl.ts vm-list azure

# Stop VM (requires safety checks + --confirm)
bun run ProviderControl.ts vm-stop azure foldingcloud-worker-1 --confirm --ip 20.120.1.100
```

### StateTracker.ts (Persistent State)

```bash
# Record worker state
bun run StateTracker.ts record 20.120.1.100 PAUSED --provider azure --name pai-fold-1

# List all recorded states
bun run StateTracker.ts list

# Check age of state
bun run StateTracker.ts age 20.120.1.100
```

### AuditLog.ts

```bash
# View recent audit entries
bun run AuditLog.ts show 20

# Search audit log
bun run AuditLog.ts search "STOP"
```

---

## Safe Teardown Workflow

**Always use `Workflows/SafeTeardown.md` for graceful shutdown.**

Summary:
1. Send FINISH signal to all workers
2. User monitors FAH Portal for PAUSED state
3. Verify each worker with `can-stop` before stopping
4. User confirms each worker before power-off
5. Destroy infrastructure only after ALL workers stopped

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
