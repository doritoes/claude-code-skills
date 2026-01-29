# Teardown Workflow

Gracefully terminate Folding@Home workers - **always finish work units before destroying VMs**.

---

## Critical Rule

**NEVER terminate workers mid-work-unit.**

This wastes compute and is bad F@H citizenship. Always:
1. Send `finish` command
2. Wait for work unit to complete
3. Only then destroy the VM

---

## Graceful Teardown Steps

### 1. Get Worker IPs

```bash
cd $PAI_DIR/.claude/skills/FoldingAtCloud/terraform/azure

# Get current workers
WORKER_IPS=$(terraform output -json worker_public_ips | jq -r '.[]')
echo "Workers to terminate: $WORKER_IPS"
```

### 2. Send Finish Commands (Parallel)

```bash
cd $PAI_DIR/.claude/skills/FoldingAtCloud/Tools

# Send finish to all workers in parallel
for IP in $WORKER_IPS; do
  echo "Sending finish to $IP..."
  bun run WorkerControl.ts finish $IP &
done
wait

echo "Finish commands sent to all workers"
```

### 3. Wait for All Workers to Pause

```bash
TIMEOUT=${FOLDING_GRACEFUL_TIMEOUT:-1800}

# Wait for each worker (parallel)
for IP in $WORKER_IPS; do
  echo "Waiting for $IP to finish work unit..."
  bun run WorkerControl.ts wait-paused $IP --timeout $TIMEOUT &
done
wait

echo "All workers paused or timed out"
```

**What happens:**
- Each worker completes its current work unit
- Results are uploaded to F@H servers
- Worker transitions to paused state
- Timeout (default 30 min) prevents indefinite waiting

### 4. Verify Paused State

```bash
# Check all workers are paused
for IP in $WORKER_IPS; do
  STATUS=$(bun run WorkerControl.ts status $IP)
  echo "$IP: $STATUS"
done
```

### 5. Destroy Infrastructure

```bash
cd $PAI_DIR/.claude/skills/FoldingAtCloud/terraform/azure

# Final confirmation
terraform plan -destroy

# Destroy (requires confirmation)
terraform destroy
```

Or with auto-approve:
```bash
terraform destroy -auto-approve
```

### 6. Verify Cleanup

```bash
# Confirm no resources remain
terraform state list

# Should output nothing
```

### 7. Update Budget Tracking

```bash
cd $PAI_DIR/.claude/skills/FoldingAtCloud/Tools

# Log final costs (estimate based on runtime)
# Actual costs will appear in cloud billing
bun run BudgetTracker.ts report
```

---

## Emergency Teardown

If graceful shutdown is not possible (e.g., runaway costs):

```bash
cd $PAI_DIR/.claude/skills/FoldingAtCloud/terraform/azure

# Force destroy without waiting
terraform destroy -auto-approve
```

**Warning:** This may waste work units in progress.

---

## Partial Teardown (Scale Down to Zero)

To stop folding but keep infrastructure for later:

```bash
# Send finish to all workers
for IP in $WORKER_IPS; do
  bun run WorkerControl.ts finish $IP
done

# Wait for completion
for IP in $WORKER_IPS; do
  bun run WorkerControl.ts wait-paused $IP --timeout 1800
done

# Scale to 0 workers (keeps resource group)
terraform apply -var="worker_count=0"
```

---

## Cleanup Checklist

- [ ] All workers received finish command
- [ ] All workers reached paused state (or timeout)
- [ ] Terraform destroy completed
- [ ] `terraform state list` returns empty
- [ ] FAH portal shows machines as offline
- [ ] Budget tracking updated

---

## FAQ

**Q: What if a work unit is very long?**
A: The timeout (30 min default) will eventually allow termination. Long WUs are rare on CPUs.

**Q: Will I lose points?**
A: No, if you wait for the WU to complete. If you force-terminate, the partial work is lost.

**Q: How do I know when it's safe?**
A: `WorkerControl.ts status` shows `"paused": true` when the WU is complete.
