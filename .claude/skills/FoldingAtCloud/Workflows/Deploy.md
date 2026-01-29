# Deploy Workflow

Deploy Folding@Home workers to donate compute cycles.

---

## Prerequisites

1. **Environment variables** set in `.claude/.env`:
   - `FAH_ACCOUNT_TOKEN` - Your FAH account token
   - `FAH_TEAM_ID` - Team number (245143)
   - `SSH_PUBLIC_KEY` - For worker access
   - Cloud provider credentials (Azure: `ARM_*` or `az login`)

2. **Budget headroom** - Check with BudgetTracker before deployment

---

## Deployment Steps

### 1. Validate Environment

```bash
# Check required variables
echo "FAH_ACCOUNT_TOKEN: ${FAH_ACCOUNT_TOKEN:0:10}..."
echo "FAH_TEAM_ID: $FAH_TEAM_ID"
echo "SSH_PUBLIC_KEY: ${SSH_PUBLIC_KEY:0:30}..."
```

### 2. Check Budget

```bash
cd $PAI_DIR/.claude/skills/FoldingAtCloud/Tools
bun run BudgetTracker.ts check

# Estimate cost for deployment
bun run BudgetTracker.ts estimate --workers 2 --hours 24
```

**GATE:** Budget must have headroom. If daily/monthly budget exceeded, abort deployment.

### 3. Create terraform.tfvars

```bash
cd $PAI_DIR/.claude/skills/FoldingAtCloud/terraform/azure

cat > terraform.tfvars << 'EOF'
project_name       = "foldingcloud"
environment        = "production"
location           = "eastus"

worker_count       = 2
worker_vm_size     = "Standard_D2s_v3"
worker_disk_gb     = 30
use_spot_instances = true
spot_max_price     = -1

ssh_user       = "foldingadmin"
ssh_public_key = "${SSH_PUBLIC_KEY}"

fah_account_token  = "${FAH_ACCOUNT_TOKEN}"
fah_machine_prefix = "pai-fold"
fah_team_id        = "${FAH_TEAM_ID}"
fah_passkey        = "${FAH_PASSKEY}"
EOF
```

### 4. Initialize Terraform

```bash
cd $PAI_DIR/.claude/skills/FoldingAtCloud/terraform/azure

# Initialize
terraform init

# Validate
terraform validate
```

**GATE:** `terraform validate` must succeed.

### 5. Plan Deployment

```bash
terraform plan -out=tfplan
```

Review the plan:
- Confirm worker count
- Verify VM size
- Check spot instance settings

### 6. Apply Deployment

```bash
terraform apply tfplan
```

### 7. Wait for Cloud-Init

Workers need time to:
1. Install FAH client v8.5
2. Install lufah
3. Configure and start the client
4. Register with FAH portal

```bash
# Wait for cloud-init (usually 2-3 minutes)
sleep 180

# Get worker IPs
WORKER_IPS=$(terraform output -json worker_public_ips | jq -r '.[]')

# Check each worker
for IP in $WORKER_IPS; do
  echo "Checking $IP..."
  ssh -o StrictHostKeyChecking=no foldingadmin@$IP "systemctl is-active fah-client"
done
```

**GATE:** All workers must have `fah-client` service active.

### 8. Verify FAH Portal Registration

1. Open https://v8-4.foldingathome.org/
2. Login with your credentials
3. Verify new machines appear (pai-fold-1, pai-fold-2, etc.)
4. Machines should show "Folding" status

### 9. Log Cost Estimate

```bash
cd $PAI_DIR/.claude/skills/FoldingAtCloud/Tools

# Log estimated daily cost
WORKERS=$(terraform -chdir=../terraform/azure output -raw worker_count)
HOURLY_COST=0.02  # Approximate spot rate for D2s_v3
DAILY_COST=$(echo "$WORKERS * $HOURLY_COST * 24" | bc)

bun run BudgetTracker.ts log \
  --amount $DAILY_COST \
  --provider azure \
  --workers $WORKERS \
  --hours 24 \
  --desc "Deployment estimate"
```

---

## Outputs

After successful deployment:

```bash
terraform output
```

Key outputs:
- `worker_public_ips` - SSH access
- `fah_machine_names` - Names in FAH portal
- `ssh_commands` - Ready-to-use SSH commands

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Cloud-init timeout | SSH to worker, check `/var/log/cloud-init-output.log` |
| FAH client not starting | Check `journalctl -u fah-client` |
| Not appearing in portal | Verify `FAH_ACCOUNT_TOKEN` is correct |
| Spot VM not available | Try different region or VM size |

---

## Next Steps

- Monitor with: `Workflows/Monitor.md`
- Scale with: `Workflows/Scale.md`
- Teardown with: `Workflows/Teardown.md`
