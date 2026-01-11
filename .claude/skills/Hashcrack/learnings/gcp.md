# GCP-Specific Learnings

## Instance Types

| Role | Type | Specs | Cost/hr |
|------|------|-------|---------|
| Server | e2-medium | 2 vCPU, 4GB | $0.034 |
| CPU Worker | c2-standard-4 | 4 vCPU, 16GB | $0.188 |
| GPU Worker | n1-standard-4 + T4 | T4 GPU | ~$0.45 |

## CRITICAL: Cloud NAT Required

GCP VMs with private IPs **cannot reach internet** without Cloud NAT (unlike AWS/Azure).

The terraform config includes Cloud Router + Cloud NAT automatically.

## Quota Limits

- `CPUS_ALL_REGIONS`: Global limit overrides regional quotas
- New projects default to 32 vCPU globally
- Request increases: Console → IAM & Admin → Quotas

## Preemptible Instances

- Use `use_preemptible = true` for 60-70% savings
- Max 24-hour runtime
- Tasks auto-recover on termination

## GPU Deployment Issues

- GPU quotas are separate from CPU quotas
- Request `NVIDIA_T4_GPUS` quota increase
- Check `gcloud compute regions describe REGION` for availability

## SSH Key Requirements

- GCP supports ed25519 and RSA keys
- Use `ssh_public_key` variable

## Performance Notes

- **Fastest CPU performance** of cloud providers tested
- ~8h vs AWS 9h, Azure 9h 41m for same workload
