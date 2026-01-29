# Scale Workflow

Scale Folding@Home workers up or down.

---

## Scale Up

Adding more workers is straightforward - no graceful handling needed.

### 1. Check Budget

```bash
cd $PAI_DIR/.claude/skills/FoldingAtCloud/Tools

# Current budget status
bun run BudgetTracker.ts check

# Estimate new costs
bun run BudgetTracker.ts estimate --workers 4 --hours 24
```

**GATE:** Must have budget headroom for additional workers.

### 2. Apply New Worker Count

```bash
cd $PAI_DIR/.claude/skills/FoldingAtCloud/terraform/azure

# Scale from current to 4 workers
terraform apply -var="worker_count=4"
```

### 3. Wait for New Workers

```bash
# Wait for cloud-init
sleep 180

# Get new worker IPs
terraform output worker_public_ips

# Verify FAH running on new workers
NEW_IPS=$(terraform output -json worker_public_ips | jq -r '.[]')
for IP in $NEW_IPS; do
  ssh -o StrictHostKeyChecking=no foldingadmin@$IP "systemctl is-active fah-client"
done
```

### 4. Verify in FAH Portal

Check https://v8-4.foldingathome.org/ for new machines.

---

## Scale Down (Graceful)

**Critical:** Always finish work units before removing workers.

### 1. Identify Workers to Remove

Terraform removes the highest-indexed workers first. If scaling from 4 to 2:
- Keeps: worker-1, worker-2
- Removes: worker-3, worker-4

```bash
cd $PAI_DIR/.claude/skills/FoldingAtCloud/terraform/azure

# Current workers
CURRENT=$(terraform output -raw worker_count)
TARGET=2

# Workers to remove
IPS=$(terraform output -json worker_public_ips | jq -r '.[]')
REMOVE_IPS=$(echo "$IPS" | tail -n $((CURRENT - TARGET)))
echo "Workers to remove: $REMOVE_IPS"
```

### 2. Send Finish Commands

```bash
cd $PAI_DIR/.claude/skills/FoldingAtCloud/Tools

for IP in $REMOVE_IPS; do
  echo "Finishing $IP..."
  bun run WorkerControl.ts finish $IP &
done
wait
```

### 3. Wait for Paused State

```bash
TIMEOUT=${FOLDING_GRACEFUL_TIMEOUT:-1800}

for IP in $REMOVE_IPS; do
  echo "Waiting for $IP..."
  bun run WorkerControl.ts wait-paused $IP --timeout $TIMEOUT &
done
wait

echo "Workers ready for removal"
```

### 4. Apply Reduced Count

```bash
cd $PAI_DIR/.claude/skills/FoldingAtCloud/terraform/azure

terraform apply -var="worker_count=$TARGET"
```

### 5. Verify

```bash
# Confirm new count
terraform output worker_count
terraform output worker_public_ips
```

---

## Scale to Zero (Pause All Folding)

```bash
# Get all workers
cd $PAI_DIR/.claude/skills/FoldingAtCloud/terraform/azure
WORKER_IPS=$(terraform output -json worker_public_ips | jq -r '.[]')

# Finish all
cd $PAI_DIR/.claude/skills/FoldingAtCloud/Tools
for IP in $WORKER_IPS; do
  bun run WorkerControl.ts finish $IP &
done
wait

# Wait for all to pause
for IP in $WORKER_IPS; do
  bun run WorkerControl.ts wait-paused $IP --timeout 1800 &
done
wait

# Remove all workers
cd $PAI_DIR/.claude/skills/FoldingAtCloud/terraform/azure
terraform apply -var="worker_count=0"
```

---

## Quick Scale Commands

```bash
# Scale up (no waiting needed)
terraform apply -var="worker_count=N"

# Scale down (graceful - use this script)
./graceful-scale-down.sh TARGET_COUNT
```

---

## Budget-Triggered Scale Down

If budget alerts trigger:

```bash
cd $PAI_DIR/.claude/skills/FoldingAtCloud/Tools

# Check budget
BUDGET_OK=$(bun run BudgetTracker.ts check 2>&1)

if echo "$BUDGET_OK" | grep -q "EXCEEDED"; then
  echo "Budget exceeded - scaling to 0"
  # Execute graceful scale to 0
  # (Use Teardown workflow or scale to 0)
fi
```

---

## Autoscaling (Future)

Planned features:
- Auto scale-down when budget hits 80%
- Auto scale-up when new credits detected
- Time-based scheduling (fold only at night)
