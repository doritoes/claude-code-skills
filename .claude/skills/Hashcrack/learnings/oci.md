# OCI (Oracle Cloud) Learnings

## Benefits

- **10TB free egress** per month (vs ~$0.09/GB on AWS/GCP)
- Preemptible instances up to 50% cheaper
- Flex shapes allow custom OCPU/memory
- No minimum commitment
- **Free tier includes:** 2 AMD VMs (1 OCPU, 1GB RAM each) - always free

## Pre-Run Checklist

Before first OCI run:
1. [ ] Create OCI account at cloud.oracle.com
2. [ ] Generate API Key in Console → User Settings → API Keys
3. [ ] Download private key to `~/.oci/oci_api_key.pem`
4. [ ] Copy terraform.tfvars.example to terraform.tfvars
5. [ ] Fill in: tenancy_ocid, user_ocid, fingerprint, private_key_path
6. [ ] Update ssh_public_key with your key
7. [ ] Run `oci iam region list` to verify auth works

## Authentication Setup

1. Create API Key: OCI Console → User Settings → API Keys
2. Download private key and config
3. Set up `~/.oci/config` or use terraform.tfvars

```bash
# Install OCI CLI (optional but helpful)
bash -c "$(curl -L https://raw.githubusercontent.com/oracle/oci-cli/master/scripts/install/install.sh)"

# Verify authentication
oci iam region list
```

## Required OCIDs for terraform.tfvars

- `tenancy_ocid` - Your tenancy identifier
- `user_ocid` - Your user identifier
- `compartment_ocid` - (Optional) Compartment for resources
- `fingerprint` - API key fingerprint

## GPU Shapes

| Shape | GPU | Memory | Use Case |
|-------|-----|--------|----------|
| VM.GPU2.1 | 1x P100 | 16GB | Good for hashcracking |
| VM.GPU3.1 | 1x V100 | 16GB | Better performance |
| BM.GPU4.8 | 8x A100 | 40GB | Maximum throughput |

## CPU Shapes

| Shape | OCPUs | Memory | Notes |
|-------|-------|--------|-------|
| VM.Standard.E4.Flex | 1-64 | 1-1024GB | Custom sizing |
| VM.Standard3.Flex | 1-32 | 1-512GB | Intel Ice Lake |

## Cost Comparison

| Resource | OCI | AWS |
|----------|-----|-----|
| 4 vCPU VM | ~$0.10/hr | ~$0.17/hr |
| Egress (10TB) | $0 | ~$900 |
