# Hashcrack Skill Setup Guide

This guide helps you install and configure the Hashcrack skill for Claude Code. Hashcrack deploys Hashtopolis-based distributed password cracking infrastructure across multiple cloud providers and local hypervisors.

## System Requirements

| Requirement | Version | Required | Notes |
|-------------|---------|----------|-------|
| **Bun** | 1.0+ | Yes | JavaScript/TypeScript runtime |
| **Terraform** | 1.0+ | Yes | Infrastructure deployment |
| **SSH Key** | ed25519 | Yes | Worker access |

### Cloud Provider CLIs (Optional - for respective deployments)

| Provider | CLI | Installation |
|----------|-----|--------------|
| AWS | `aws` | `winget install Amazon.AWSCLI` |
| Azure | `az` | `winget install Microsoft.AzureCLI` |
| GCP | `gcloud` | [cloud.google.com/sdk](https://cloud.google.com/sdk/docs/install) |
| OCI | `oci` | [docs.oracle.com/en-us/iaas/Content/API/SDKDocs/cliinstall.htm](https://docs.oracle.com/en-us/iaas/Content/API/SDKDocs/cliinstall.htm) |

## Installation Steps

### Step 1: Install Bun Runtime

**Windows (PowerShell):**
```powershell
powershell -c "irm bun.sh/install.ps1 | iex"
```

**macOS/Linux:**
```bash
curl -fsSL https://bun.sh/install | bash
```

**Verify:**
```bash
bun --version
```

### Step 2: Install Terraform

**Windows (PowerShell):**
```powershell
winget install Hashicorp.Terraform
```

**macOS:**
```bash
brew install terraform
```

**Linux:**
```bash
# Ubuntu/Debian
wget -O- https://apt.releases.hashicorp.com/gpg | sudo gpg --dearmor -o /usr/share/keyrings/hashicorp-archive-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/hashicorp-archive-keyring.gpg] https://apt.releases.hashicorp.com $(lsb_release -cs) main" | sudo tee /etc/apt/sources.list.d/hashicorp.list
sudo apt update && sudo apt install terraform
```

**Verify:**
```bash
terraform --version
```

### Step 3: Generate SSH Key (if needed)

```bash
ssh-keygen -t ed25519 -C "hashcrack" -f ~/.ssh/hashcrack
```

Copy the public key (you'll need it for terraform.tfvars):
```bash
cat ~/.ssh/hashcrack.pub
```

### Step 4: Copy the Hashcrack Skill

```bash
# The skill should be at:
# Windows: %USERPROFILE%\.claude\skills\Hashcrack\
# macOS/Linux: ~/.claude/skills/Hashcrack/

# Example copy command:
cp -r /path/to/Hashcrack ~/.claude/skills/
```

### Step 5: Configure Environment Variables

Copy the example environment file:
```bash
cp ~/.claude/skills/Hashcrack/.env.example ~/.claude/.env
```

Edit `~/.claude/.env` with your credentials:
```bash
# At minimum for AWS deployment:
AWS_ACCESS_KEY_ID=your-key-id
AWS_SECRET_ACCESS_KEY=your-secret
AWS_DEFAULT_REGION=us-east-1
```

### Step 6: Configure Terraform Variables

Choose your deployment target and configure:

**AWS:**
```bash
cd ~/.claude/skills/Hashcrack/terraform/aws
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars with your settings
```

**Azure:**
```bash
cd ~/.claude/skills/Hashcrack/terraform/azure
cp terraform.tfvars.example terraform.tfvars
```

**GCP:**
```bash
cd ~/.claude/skills/Hashcrack/terraform/gcp
cp terraform.tfvars.example terraform.tfvars
```

**Proxmox:**
```bash
cd ~/.claude/skills/Hashcrack/terraform/proxmox
cp terraform.tfvars.example terraform.tfvars
```

### Step 7: Initialize Terraform

```bash
cd ~/.claude/skills/Hashcrack/terraform/aws  # or your chosen provider
terraform init
```

## Cloud Provider Authentication

### AWS

**Option 1: Environment variables (recommended for automation)**
```bash
export AWS_ACCESS_KEY_ID="your-key-id"
export AWS_SECRET_ACCESS_KEY="your-secret"
```

**Option 2: AWS CLI**
```bash
aws configure
# Enter your credentials when prompted
```

### Azure

**Option 1: Interactive login (recommended for development)**
```bash
az login
```

**Option 2: Service Principal (for automation)**
```bash
az ad sp create-for-rbac --name "hashcrack-sp" --role="Contributor"
# Use the output to set AZURE_* environment variables
```

### GCP

**Option 1: Application Default Credentials**
```bash
gcloud auth application-default login
```

**Option 2: Service Account**
```bash
export GOOGLE_APPLICATION_CREDENTIALS="/path/to/service-account.json"
```

### OCI

Create API key in OCI Console:
1. Go to User Settings → API Keys
2. Add API Key → Generate API Key Pair
3. Download private key to `~/.oci/oci_api_key.pem`
4. Copy fingerprint to terraform.tfvars

### Proxmox

No special authentication needed - credentials go directly in terraform.tfvars.

## Verification

### Test Basic Skill Loading

```bash
cd ~/.claude/skills/Hashcrack
bun run tools/HashcrackCLI.ts --help
```

### Test Terraform Configuration

```bash
cd ~/.claude/skills/Hashcrack/terraform/aws  # or your provider
terraform validate
terraform plan
```

### Deploy Test Infrastructure

```bash
terraform apply
# Review the plan and type 'yes' to deploy
```

## Directory Structure

```
~/.claude/skills/Hashcrack/
├── SKILL.md                    # Skill definition (required)
├── SETUP.md                    # This file
├── .env.example                # Environment variable template
├── .gitignore                  # Excludes sensitive files
├── LEARNINGS.md                # Operational knowledge
├── AttackStrategies.md         # Hash cracking strategies
├── HashtopolisAPI.md           # API reference
├── tools/
│   ├── HashcrackCLI.ts         # Main CLI tool
│   ├── HashtopolisClient.ts    # Server API client
│   ├── JohnClient.ts           # John the Ripper client
│   └── ...
├── terraform/
│   ├── aws/                    # AWS deployment
│   │   ├── main.tf
│   │   ├── terraform.tfvars.example
│   │   └── .gitignore
│   ├── azure/                  # Azure deployment
│   ├── gcp/                    # GCP deployment
│   ├── oci/                    # Oracle Cloud deployment
│   └── proxmox/                # Proxmox local deployment
└── workflows/
    ├── Deploy.md               # Deployment workflow
    ├── Teardown.md             # Cleanup workflow
    └── ...
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| `terraform init` fails | Check internet connection, run `terraform init -upgrade` |
| AWS authentication error | Run `aws sts get-caller-identity` to verify credentials |
| Azure subscription error | Run `az account show` to verify subscription |
| GCP project error | Run `gcloud config get-value project` to verify project |
| SSH key rejected | Ensure key is ed25519 or RSA, check public key in tfvars |
| Worker can't reach server | Check security group allows port 8080 from workers |
| Cloud-init password issues | Avoid special characters (!@#$%^&*) in passwords |

## Cost Estimates

| Provider | Minimum Cost | Notes |
|----------|--------------|-------|
| AWS | ~$5/day | 1 server + 2 CPU workers |
| Azure | ~$5/day | 1 server + 2 CPU workers |
| GCP | ~$5/day | 1 server + 2 CPU workers |
| OCI | Free tier | Always-free eligible shapes available |
| Proxmox | $0 | Uses existing hardware |

**IMPORTANT:** Always run `terraform destroy` when done to avoid unexpected charges.

## Next Steps

1. Read `SKILL.md` for usage instructions
2. Check `AttackStrategies.md` for hash cracking techniques
3. Review `workflows/Deploy.md` for deployment procedures
4. Ask Claude: "Deploy a hashcrack cluster with 4 workers on AWS"
