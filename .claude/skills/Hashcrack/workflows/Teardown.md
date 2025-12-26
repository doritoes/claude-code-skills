# Teardown Workflow

Destroy all Hashcrack infrastructure to save resources.

## Trigger

- "destroy"
- "cleanup"
- "teardown hashcrack"
- "delete infrastructure"

## Warning

**This action is irreversible!**

Teardown will:
- Destroy all worker VMs
- Destroy Hashtopolis server VM
- Delete all data on those VMs
- Remove Terraform state

## Pre-Teardown Checklist

Before teardown, ensure:

- [ ] All jobs are complete
- [ ] Results have been retrieved (`hashcrack results`)
- [ ] Results are backed up if needed
- [ ] User has approved destruction

## Execution Steps

### Step 1: Check for Active Jobs

```bash
hashcrack status
```

If jobs are in progress, warn user.

### Step 2: Confirm with User

```
⚠ WARNING: This will destroy ALL hashcrack VMs and data!

Resources to be destroyed:
  - hashcrack-server (192.168.99.101)
  - hashcrack-worker-1 (192.168.99.102)
  - hashcrack-worker-2 (192.168.99.103)
  - hashcrack-worker-3 (192.168.99.104)

Continue? (yes/no)
```

### Step 3: Destroy Infrastructure

```bash
cd ~/.claude/skills/Hashcrack/terraform
terraform destroy -auto-approve
```

### Step 4: Clean Environment Variables

Remove from `.claude/.env`:
- `HASHCRACK_SERVER_URL`
- `HASHCRACK_API_KEY`
- `HASHCRACK_ADMIN_PASSWORD`
- `HASHCRACK_VOUCHER`
- `HASHCRACK_CURRENT_HASHLIST`
- `HASHCRACK_CURRENT_JOB`

### Step 5: Verify Destruction

```bash
# Confirm VMs are gone
terraform show
# Should show: No state
```

## CLI Usage

```bash
hashcrack teardown
```

## Partial Teardown

To keep the server but remove workers (cost savings):

```bash
hashcrack scale --workers 0
```

To pause workers without destroying:
```bash
# In Hashtopolis UI: Deactivate agents
```

## Recovery

If you accidentally teardown:

1. Run `hashcrack deploy` again
2. Re-submit hash jobs
3. Previous results in `.env` are preserved

## Cost Considerations

**Pause vs Teardown:**

| Action | Cost | Data |
|--------|------|------|
| Teardown | $0 | Lost (VMs deleted) |
| Scale to 0 | Server only | Preserved |
| Pause agents | Full infra | Preserved |

Recommendation:
- Short break (hours): Pause agents
- Long break (days): Scale to 0
- Job complete: Teardown
