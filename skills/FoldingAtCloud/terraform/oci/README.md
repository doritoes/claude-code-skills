# OCI CPU Multi-Worker Deployment

Deploy multiple VM.Standard.E4.Flex (or A1.Flex ARM) instances for CPU folding.

## Features

- Flexible shapes (configure OCPUs and memory)
- Ubuntu 24.04 LTS
- FAH v8.5.5 with lufah
- On-demand instances

## Quick Start

```bash
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars with OCI credentials

terraform init
terraform apply
```

## OCI Authentication

Requires:
- `tenancy_ocid`
- `user_ocid`
- `fingerprint`
- `private_key_path` (default: `~/.oci/oci_api_key.pem`)

Get these from OCI Console → User Settings → API Keys.

## Outputs

| Output | Description |
|--------|-------------|
| `worker_public_ips` | List of worker IPs |
| `ssh_commands` | SSH commands for each worker |
| `total_ocpus` | Total OCPUs deployed |

## Shapes

| Shape | Type | Notes |
|-------|------|-------|
| VM.Standard.E4.Flex | AMD EPYC | Default, good performance |
| VM.Standard.A1.Flex | ARM Ampere | Always Free eligible |

## Graceful Teardown

```bash
# Signal all workers to finish
for ip in $(terraform output -json worker_public_ips | jq -r '.[]'); do
  ssh ubuntu@$ip "lufah finish"
done

# Wait for completion, then:
terraform destroy
```
