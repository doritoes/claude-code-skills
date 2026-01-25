# FoldingAtCloud Setup Guide

## Prerequisites

### Required
- [Terraform](https://terraform.io) >= 1.0
- Cloud provider CLI configured:
  - AWS: `aws configure`
  - Azure: `az login`
  - GCP: `gcloud auth login`
  - OCI: `~/.oci/config`
- SSH key pair

### Recommended
- [Bun](https://bun.sh) - For running TypeScript tools
- [jq](https://jqlang.github.io/jq/) - For JSON parsing

## Quick Start

### 1. Get FAH Account Token

1. Go to [Folding@Home Portal](https://v8-4.foldingathome.org/)
2. Create account or sign in
3. Go to Settings → Account Token
4. Copy the token

### 2. Configure Provider

Choose your provider and configure:

#### AWS (GPU One-Shot)
```bash
cd terraform/aws
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars with your credentials
```

#### Azure (CPU Multi-Worker)
```bash
cd terraform/azure
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars with your credentials
# NOTE: Azure requires RSA SSH keys (not ed25519)
```

#### GCP (GPU One-Shot)
```bash
cd terraform/gcp
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars with your credentials
```

#### OCI (CPU Multi-Worker)
```bash
cd terraform/oci
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars with your credentials
```

### 3. Deploy

```bash
terraform init
terraform apply
```

### 4. Verify

```bash
# Get worker IP from terraform output
terraform output

# Check FAH status
ssh user@worker-ip "lufah units"
```

## Configuration Reference

### Common Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `fah_account_token` | Yes | From FAH portal Settings |
| `ssh_public_key` | Yes | Your SSH public key |
| `fah_team_id` | No | Team number (default: 245143) |
| `fah_passkey` | No | For bonus points |

### Provider-Specific

#### AWS
| Variable | Default | Description |
|----------|---------|-------------|
| `aws_region` | us-east-1 | AWS region |
| `instance_type` | g4dn.xlarge | EC2 type (T4 GPU) |
| `one_shot_mode` | true | Complete 1 WU then pause |

#### Azure
| Variable | Default | Description |
|----------|---------|-------------|
| `location` | eastus | Azure region |
| `worker_count` | 5 | Number of workers |
| `worker_vm_size` | Standard_D2s_v3 | VM size |

#### GCP
| Variable | Default | Description |
|----------|---------|-------------|
| `gcp_project` | (required) | GCP project ID |
| `gpu_type` | nvidia-tesla-t4 | GPU accelerator |
| `use_spot` | false | Never use for FAH |

#### OCI
| Variable | Default | Description |
|----------|---------|-------------|
| `tenancy_ocid` | (required) | OCI tenancy |
| `worker_count` | 4 | Number of workers |
| `worker_shape` | VM.Standard.E4.Flex | Compute shape |

## Verification

### Check FAH Client
```bash
ssh user@worker-ip "lufah units"
```

### Check GPU (GPU instances)
```bash
ssh user@worker-ip "nvidia-smi"
ssh user@worker-ip "lufah state | jq '.info.gpus'"
```

### View Logs
```bash
ssh user@worker-ip "tail -50 /var/log/fah-gpu-setup.log"
```

## Graceful Teardown

**Never terminate workers mid-work-unit.**

```bash
# Signal finish
ssh user@worker-ip "lufah finish"

# Wait for completion (status shows 0 running units)
ssh user@worker-ip "lufah units"

# Then destroy
terraform destroy
```

## Troubleshooting

### FAH shows "No resources"
Run: `ssh user@ip "lufah -a / config cpus N"` (N = CPU count)

### GPU not detected
Check: `ssh user@ip "nvidia-smi"` - should show GPU
If not, the two-phase boot may have failed. Check `/var/log/fah-gpu-setup.log`

### Azure SSH fails
Azure requires RSA keys. Generate with: `ssh-keygen -t rsa -b 4096`

### lufah commands fail
Wait for FAH websocket. Check: `ssh user@ip "systemctl status fah-client"`
