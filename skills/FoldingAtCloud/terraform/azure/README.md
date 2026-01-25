# Azure CPU Multi-Worker Deployment

Deploy multiple Standard_D2s_v3 (or larger) VMs for CPU folding.

## Features

- Multiple parallel workers
- Ubuntu 24.04 LTS
- FAH v8.5.5 with lufah
- On-demand instances (NOT spot)

## Quick Start

```bash
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars
# NOTE: Azure requires RSA SSH keys (not ed25519)

terraform init
terraform apply
```

## Outputs

| Output | Description |
|--------|-------------|
| `worker_public_ips` | List of worker IPs |
| `ssh_commands` | SSH commands for each worker |
| `worker_count` | Number of deployed workers |

## CPU WU Timing

CPU work units typically complete in 14+ hours.

## Graceful Teardown

```bash
# Signal all workers to finish
for ip in $(terraform output -json worker_public_ips | jq -r '.[]'); do
  ssh foldingadmin@$ip "lufah finish"
done

# Wait for completion, then:
terraform destroy
```
