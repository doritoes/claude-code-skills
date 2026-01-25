# OCI (Oracle Cloud) Hashcrack Deployment

## Prerequisites

- OCI account
- API key configured in ~/.oci/config
- Required OCIDs: tenancy, user, compartment

## Benefits

- **10TB free egress per month** (vs ~$0.09/GB on AWS/GCP)
- Preemptible instances up to 50% cheaper
- Flex shapes for custom OCPU/memory
- No minimum commitment

## Instance Types (Shapes)

| Role | Shape | Specs | Notes |
|------|-------|-------|-------|
| Server | VM.Standard.E4.Flex | 2 OCPU, 4 GB | Configurable |
| CPU Worker | VM.Standard.E4.Flex | 4 OCPU, 8 GB | Good for hashcat |
| GPU Worker | VM.GPU2.1 | 1x P100 | Hashcracking |
| GPU Worker | VM.GPU3.1 | 1x V100 | Better performance |

## Deployment

```bash
cd terraform/oci
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars with your OCIDs

terraform init
terraform plan
terraform apply
```

## Authentication

```bash
# Install OCI CLI
bash -c "$(curl -L https://raw.githubusercontent.com/oracle/oci-cli/master/scripts/install/install.sh)"

# Configure
oci setup config

# Verify
oci iam region list
```

## Required terraform.tfvars

```hcl
tenancy_ocid     = "ocid1.tenancy.oc1.."
user_ocid        = "ocid1.user.oc1.."
compartment_ocid = "ocid1.compartment.oc1.."
fingerprint      = "xx:xx:xx:..."
private_key_path = "~/.oci/oci_api_key.pem"
region           = "us-ashburn-1"
```

## Cleanup

```bash
terraform destroy
```
