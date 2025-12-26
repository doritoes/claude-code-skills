# Deploy Workflow

Deploy Hashtopolis infrastructure to XCP-ng for distributed password cracking.

## Trigger

- "deploy hashcrack"
- "spin up workers"
- "create cracking infrastructure"

## Prerequisites

1. **XenOrchestra credentials** in `.claude/.env`:
   ```bash
   XO_HOST=https://192.168.99.206
   XO_USER=admin
   XO_PASSWORD=<password>
   ```

2. **Terraform or OpenTofu** installed

3. **Ubuntu 24.04 cloud-init template** available in XCP-ng

4. **SSH public key** (optional, for direct VM access)

## Execution Steps

### Step 1: Validate Prerequisites

```bash
# Check XO credentials exist
grep -q "XO_HOST" ~/.claude/.env || echo "Missing XO_HOST"

# Check Terraform
terraform version || tofu version
```

### Step 2: Initialize Terraform

```bash
cd ~/.claude/skills/Hashcrack/terraform
terraform init
```

### Step 3: Configure Variables

Create `terraform.tfvars` with deployment settings:

```hcl
xo_url       = "https://192.168.99.206"
xo_username  = "admin"
xo_password  = "<password>"
worker_count = 3
```

### Step 4: Plan Infrastructure

```bash
terraform plan -out=tfplan
```

Review the plan:
- 1 Hashtopolis server VM
- N worker VMs
- Network and storage attachments

### Step 5: Apply Infrastructure

```bash
terraform apply tfplan
```

Wait for:
- VMs to boot
- Cloud-init to complete
- Docker containers to start

### Step 6: Retrieve Outputs

```bash
terraform output -json
```

Save to `.claude/.env`:
- `HASHCRACK_SERVER_URL`
- `HASHCRACK_ADMIN_PASSWORD`
- `HASHCRACK_VOUCHER`

### Step 7: Verify Deployment

```bash
# Check server
curl -sk https://<server-ip>:8080

# Check workers registered
bun run tools/HashtopolisClient.ts agents
```

## CLI Usage

```bash
# Deploy with default settings (2 workers)
hashcrack deploy

# Deploy with specific worker count
hashcrack deploy --workers 5

# Deploy with custom resources
hashcrack deploy --workers 3 --server-memory 8 --worker-cpus 8
```

## Output

On success:
- Server URL saved to env
- Admin credentials saved to env
- Worker voucher saved to env

## Troubleshooting

| Issue | Solution |
|-------|----------|
| VM creation fails | Check XO template exists |
| Workers don't connect | Wait 2-3 min for cloud-init |
| API key missing | Generate in Hashtopolis UI |

## Rollback

If deployment fails:

```bash
terraform destroy -auto-approve
```
