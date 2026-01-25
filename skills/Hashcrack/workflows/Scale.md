# Scale Workflow

Dynamically adjust worker count during operation.

---

## ⛔ SCALING CHECKLIST (USE BEFORE EVERY SCALE OPERATION)

### Pre-Scale Decision

| Question | Action |
|----------|--------|
| **What hash type?** | Fast (MD5/NTLM) = fewer workers, Slow (bcrypt) = more workers |
| **Straight or Rule attack?** | Straight: scale workers. Rule: split hashes first! |
| **Current progress?** | >80% complete = don't scale up (diminishing returns) |
| **Budget remaining?** | Each c5.xlarge costs $0.08/hr spot |

### Scale UP Checklist

- [ ] Verify vouchers exist: `SELECT COUNT(*) FROM RegVoucher;` (must equal new total)
- [ ] Create additional vouchers if needed (one per new worker)
- [ ] Update terraform.tfvars with new `cpu_worker_count`
- [ ] Run `terraform apply -auto-approve`
- [ ] Wait for agents to register (~5 minutes)
- [ ] Trust new agents: `UPDATE Agent SET isTrusted = 1, cpuOnly = 1, cmdPars = '--force', ignoreErrors = 1 WHERE isTrusted = 0;`
- [ ] Verify all agents active: `SELECT agentId, agentName, isActive FROM Agent;`

### Scale DOWN Checklist (Graceful)

- [ ] Check pending chunks per agent: `SELECT agentId, COUNT(*) FROM Chunk WHERE state=2 GROUP BY agentId;`
- [ ] Deactivate agents to remove: `UPDATE Agent SET isActive = 0 WHERE agentId IN (...);`
- [ ] Wait for chunks to complete (poll until state!=2)
- [ ] Clean up agent records (FK references)
- [ ] Update terraform.tfvars with reduced `cpu_worker_count`
- [ ] Run `terraform apply -auto-approve`

### When NOT to Scale

| Scenario | Recommendation |
|----------|----------------|
| Rule attack | Scale doesn't help - split hashes instead |
| >90% complete | Don't scale - finish with current workers |
| <5 minutes remaining | Don't scale - overhead exceeds benefit |
| GPU-required hash | Don't add CPU workers - add GPUs |

### Cost Awareness

| Workers | Hourly Cost (spot) | 30 min | 1 hour |
|---------|-------------------|--------|--------|
| 2 CPU | $0.16 | $0.08 | $0.16 |
| 4 CPU | $0.32 | $0.16 | $0.32 |
| 8 CPU | $0.64 | $0.32 | $0.64 |
| 20 CPU | $1.60 | $0.80 | $1.60 |

---

## Trigger

- "add workers"
- "scale up"
- "scale down"
- "need more workers"

## Use Cases

### Scale Up
- Job taking too long
- More resources available
- Urgent deadline

### Scale Down
- Job nearly complete
- Save costs
- Workers sitting idle

## Scale Up Execution

```bash
cd ~/.claude/skills/Hashcrack/terraform

# Scale to specific count
terraform apply -var="worker_count=10" -auto-approve

# Workers will auto-register via voucher
```

## How Scale Up Works

1. Update `worker_count` in Terraform variables
2. Run `terraform apply`
3. New workers boot with cloud-init
4. Workers auto-register with server via voucher
5. Trust new agents (see below)
6. Hashtopolis distributes work to new workers

### Trust New Agents (REQUIRED)
After new workers register, trust them:
```bash
ssh ubuntu@<SERVER_IP> "sudo docker exec hashtopolis-db mysql -u hashtopolis -p<DB_PW> hashtopolis -e \"
UPDATE Agent SET isTrusted = 1 WHERE isTrusted = 0;
\""
```

## Scale Down Execution (Graceful)

**IMPORTANT:** Never just reduce worker_count. Follow graceful scale-down to avoid losing work.

### Step 1: Identify Workers to Remove
```bash
# Check which workers have pending chunks
ssh ubuntu@<SERVER_IP> "sudo docker exec hashtopolis-db mysql -u hashtopolis -p<DB_PW> hashtopolis -e \"
SELECT a.agentId, a.agentName, COUNT(c.chunkId) as pending_chunks
FROM Agent a
LEFT JOIN Chunk c ON a.agentId = c.agentId AND c.state = 2
GROUP BY a.agentId;
\""
# Remove workers with 0 pending_chunks first
```

### Step 2: Deactivate Agents (Stop New Work)
```bash
# For agents you want to remove (e.g., agentId 3,4)
ssh ubuntu@<SERVER_IP> "sudo docker exec hashtopolis-db mysql -u hashtopolis -p<DB_PW> hashtopolis -e \"
UPDATE Agent SET isActive = 0 WHERE agentId IN (3,4);
\""
```

### Step 3: Wait for Current Chunks to Complete
```bash
# Poll until chunks complete (state 2 = in-progress)
while true; do
  PENDING=$(ssh ubuntu@<SERVER_IP> "sudo docker exec hashtopolis-db mysql -u hashtopolis -p<DB_PW> hashtopolis -sNe \"
  SELECT COUNT(*) FROM Chunk WHERE agentId IN (3,4) AND state = 2;
  \"")
  [ "$PENDING" -eq 0 ] && break
  echo "Waiting for $PENDING chunks to complete..."
  sleep 30
done
```

### Step 4: Clean Up Agent Records
```bash
# Remove agent FK references (SAME as Teardown.md)
ssh ubuntu@<SERVER_IP> "sudo docker exec hashtopolis-db mysql -u hashtopolis -p<DB_PW> hashtopolis -e \"
DELETE FROM Speed WHERE agentId IN (3,4);
DELETE FROM AccessGroupAgent WHERE agentId IN (3,4);
DELETE FROM Zap WHERE agentId IN (3,4);
UPDATE Chunk SET agentId = NULL WHERE agentId IN (3,4);
DELETE FROM AgentZap WHERE agentId IN (3,4);
DELETE FROM Assignment WHERE agentId IN (3,4);
DELETE FROM AgentStat WHERE agentId IN (3,4);
DELETE FROM AgentError WHERE agentId IN (3,4);
DELETE FROM HealthCheckAgent WHERE agentId IN (3,4);
DELETE FROM Agent WHERE agentId IN (3,4);
\""
```

### Step 5: Destroy Worker VMs
```bash
# Now safe to destroy the specific workers
# Using terraform taint for specific workers:
terraform taint 'xenorchestra_vm.workers[2]'  # worker index 2
terraform taint 'xenorchestra_vm.workers[3]'  # worker index 3
terraform apply -var="worker_count=2" -auto-approve  # keep 2 workers
```

## Timing

| Action | Time |
|--------|------|
| Terraform apply | 1-2 min |
| VM boot | 2-3 min |
| Cloud-init | 3-5 min |
| Agent registration | 1 min |
| **Total scale-up** | **7-11 min** |

Graceful scale-down: 5-15 min (depends on chunk completion)
Fast scale-down (not recommended): 1-2 min

## Hashtopolis Behavior

When workers are added:
- New agents appear in "Agents" list
- Trust new agents to assign work
- Work is automatically distributed
- No job restart required

When workers are removed:
- Active chunks are redistributed
- No data loss
- Remaining workers continue

## CLI Usage

```bash
# Scale to 5 workers
hashcrack scale --workers 5

# Scale to 20 workers
hashcrack scale --workers 20

# Scale down to 2 workers
hashcrack scale --workers 2

# Remove all workers (keep server)
hashcrack scale --workers 0
```

## Cost Optimization

### During Attack Phases

| Phase | Recommended Workers |
|-------|---------------------|
| Quick wordlist | 2-3 |
| Rules + wordlist | 5-10 |
| Mask attacks | 10-20 |
| Extended brute | Maximum available |

### By Hash Type

| Hash Type | Complexity | Workers |
|-----------|------------|---------|
| MD5, NTLM | Fast | 3-5 |
| SHA256 | Medium | 5-10 |
| sha512crypt | Slow | 10-20 |
| bcrypt | Very slow | Maximum |

## Monitoring After Scale

```bash
# Watch workers come online
watch -n 5 'hashcrack status'
```

## GCP-Specific Scale Operations

### Scale Up on GCP
```bash
cd ~/.claude/skills/Hashcrack/terraform/gcp

# Create unique vouchers for new workers BEFORE terraform apply
ssh -i ~/.ssh/gcp_hashcrack ubuntu@<SERVER_IP> 'sudo docker exec hashtopolis-db mysql -u hashtopolis -p<DB_PW> hashtopolis -e "
INSERT INTO RegVoucher (voucher, time) VALUES
  (\"PAI_GCP_W8\", UNIX_TIMESTAMP()),
  (\"PAI_GCP_W9\", UNIX_TIMESTAMP()),
  (\"PAI_GCP_W10\", UNIX_TIMESTAMP());
"'

# Update terraform.tfvars with new worker count
# Then apply
terraform apply -auto-approve

# After new workers boot, configure each with unique voucher
# Then trust new agents
```

### GCP Quota Considerations
- `CPUS_ALL_REGIONS` is the global limit (not regional quotas)
- Each n2-standard-4 uses 4 vCPU
- Server uses 2 vCPU (e2-medium)
- Max workers = (quota - 2) / 4

### Scale Down on GCP
Same procedure as other platforms, but remember:
- Cloud NAT costs ~$0.045/hr per VM - scale down saves money
- Deactivate agents BEFORE destroying workers
- GCP VMs destroy quickly (~30 sec)

## Chunk State Verification (CRITICAL)

**NEVER trust keyspaceProgress alone!** Verify actual chunk completion:

```sql
-- Check actual chunk states
SELECT
  SUM(CASE WHEN state = 5 THEN 1 ELSE 0 END) as finished,
  SUM(CASE WHEN state != 5 THEN 1 ELSE 0 END) as not_finished,
  COUNT(*) as total
FROM Chunk WHERE taskId = X;

-- Task is ONLY complete when ALL chunks are state=5
```

**Chunk States:**
| State | Meaning |
|-------|---------|
| 0 | PENDING - waiting |
| 2 | DISPATCHED - running |
| 4 | ABORTED - agent died |
| 5 | FINISHED - complete |

## Aborted Chunk Management

During cracking, monitor and reset aborted chunks every 5 minutes:

```sql
-- Check for aborted chunks
SELECT COUNT(*) as aborted FROM Chunk WHERE taskId = X AND state = 4;

-- Reset aborted chunks to allow re-dispatch
UPDATE Chunk SET state = 0, agentId = NULL WHERE taskId = X AND state = 4;
```

## Limitations

- Maximum workers depend on XCP-ng resources
- Cloud providers may have instance limits (GCP: CPUS_ALL_REGIONS quota)
- Network bandwidth may bottleneck at high scale
- Hashtopolis server may need more resources for 50+ workers
