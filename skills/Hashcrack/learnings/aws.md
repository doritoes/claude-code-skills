# AWS-Specific Learnings

## Instance Types

| Role | Type | Specs | Cost/hr |
|------|------|-------|---------|
| Server | t3.medium | 2 vCPU, 4GB | $0.042 |
| CPU Worker | c5.xlarge | 4 vCPU, 8GB | $0.17 |
| GPU Worker | g4dn.xlarge | T4 GPU | $0.526 |

## Spot Instances

- Use `use_spot_instances = true` for 60-90% savings
- Spot capacity varies by region/AZ
- Workers can be interrupted - tasks auto-recover

## SSH Key Requirements

- AWS supports **RSA and ed25519** keys
- Upload via terraform `ssh_public_key` variable

## Networking

- Workers get private IPs by default
- Use server as jump host for SSH to workers
- **No NAT Gateway needed** - use server as file proxy

## GPU Worker Notes

- g4dn.xlarge: 1× T4 GPU, 4 vCPU, 16GB
- ~106x faster than CPU for SHA256
- 5 minutes vs 9 hours for same workload
