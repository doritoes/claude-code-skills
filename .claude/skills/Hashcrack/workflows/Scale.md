# Scale Workflow

Dynamically adjust worker count during operation.

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

## Limitations

- Maximum workers depend on XCP-ng resources
- Cloud providers may have instance limits
- Network bandwidth may bottleneck at high scale
- Hashtopolis server may need more resources for 50+ workers
