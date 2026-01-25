# Monitor Workflow

Check job progress and worker status.

## Trigger

- "check status"
- "progress"
- "how's the job going"

## Execution

```bash
hashcrack status
```

## Output Format

```
╔════════════════════════════════════════════════════════════╗
║                    HASHCRACK STATUS                         ║
╚════════════════════════════════════════════════════════════╝

Server: https://192.168.99.101:8080
Workers: 5/5 active

Workers:
  ● worker-1 (192.168.99.102)
  ● worker-2 (192.168.99.103)
  ● worker-3 (192.168.99.104)
  ● worker-4 (192.168.99.105)
  ● worker-5 (192.168.99.106)

Current Job:
  Name: client-audit-2025
  Progress: 6,847/10,000 (68.5%)
  Active Tasks: 2

Active Tasks:
  Wordlist + Rules: [████████████░░░░░░░░] 61.2%
  Common Masks:     [██████████████████░░] 89.3%
```

## API Queries

### List Agents

```typescript
const agents = await client.listAgents();
// Returns: agentId, agentName, isActive, devices, lastIp
```

### Get Job Progress

```typescript
const progress = await client.getJobProgress(hashlistId);
// Returns: totalHashes, crackedHashes, percentCracked, activeTasks
```

### Get Task Status

```typescript
const status = await client.getTaskStatus(taskId);
// Returns: keyspace, keyspaceProgress, crackedHashes, speed, percentComplete
```

## Polling Interval

- Default: Every 10 seconds
- Recommended: 5-30 seconds depending on job size
- Avoid: Less than 5 seconds (adds overhead)

## Worker Health Indicators

| Symbol | Meaning |
|--------|---------|
| ● (green) | Active, processing chunks |
| ○ (red) | Inactive or disconnected |
| ◐ (yellow) | Active but idle (waiting for work) |

## Troubleshooting

| Issue | Cause | Solution |
|-------|-------|----------|
| 0% progress | Workers waiting for work | Check task priority |
| Workers offline | Network issue | SSH to worker, check agent service |
| Slow speed | CPU-only workers | Consider GPU instances |
| Task stuck | Large chunk size | Reduce chunkTime |

---

## CPU Utilization Monitoring

### Why CPU Shows 0% During Cracking

**Expected behavior:** For fast hashes (MD5/SHA1/NTLM) with small chunks, hashcat runs briefly (~6 seconds) then exits. During the gap between chunks, CPU shows idle.

```bash
# Check worker CPU (will often show ~0% for fast hashes)
ssh ubuntu@<WORKER_IP> "top -bn1 | head -5"
```

**What you'll see:**
- Fast hashes: 0-10% CPU (hashcat runs in bursts)
- Medium hashes: 30-50% CPU
- Slow hashes: 90-100% CPU

### Effective Utilization Metrics

Instead of CPU utilization, monitor these:

```bash
# 1. Worker throughput (most important)
ssh ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -e \"
SELECT agentId, agentName, ROUND(speed/1000000, 2) as speed_MHs
FROM Agent WHERE isActive=1;
\""

# 2. Chunks per worker (distribution check)
ssh ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -e \"
SELECT agentId, COUNT(*) as chunks_processed
FROM Chunk WHERE taskId=<TASK_ID> GROUP BY agentId;
\""

# 3. Chunk completion rate
ssh ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -e \"
SELECT
  COUNT(CASE WHEN state=5 THEN 1 END) as finished,
  COUNT(CASE WHEN state=2 THEN 1 END) as running,
  COUNT(CASE WHEN state=0 THEN 1 END) as pending
FROM Chunk WHERE taskId=<TASK_ID>;
\""
```

### Chunk Time Tuning for Better Utilization

| Symptom | Cause | Fix |
|---------|-------|-----|
| CPU always 0% | Chunks too small | Increase chunkTime to 1200 |
| Workers idle between chunks | High coordination overhead | Increase chunkTime to 1200 |
| CPU 100% for hours | Chunks too large | Decrease chunkTime to 600 |
| Uneven worker load | Wrong maxAgents setting | Set maxAgents=0 for distribution |

**Observed:** With 600s chunkTime on MD5, chunks complete in ~6 seconds. Increase to 1200s (20 min target) for better efficiency.

### Real-Time Monitoring Loop

```bash
# Poll every 30 seconds during cracking
while true; do
  # Get progress
  PROGRESS=$(ssh ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -sNe \"
    SELECT CONCAT(ROUND(keyspaceProgress/keyspace*100,1), '%') FROM Task WHERE taskId=<TASK_ID>;
  \"")

  # Get cracked count
  CRACKED=$(ssh ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -sNe \"
    SELECT COUNT(*) FROM Hash WHERE hashlistId=<HASHLIST_ID> AND isCracked=1;
  \"")

  echo "[$(date +%H:%M:%S)] Progress: $PROGRESS | Cracked: $CRACKED"
  sleep 30
done
```

### Agent Speed Analysis

```bash
# Compare agent speeds (should be similar for same instance type)
ssh ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -e \"
SELECT a.agentId, a.agentName,
  ROUND(AVG(s.speed)/1000000, 2) as avg_speed_MHs,
  COUNT(DISTINCT s.taskId) as tasks_worked
FROM Agent a
LEFT JOIN Speed s ON a.agentId = s.agentId
WHERE a.isActive = 1
GROUP BY a.agentId;
\""
```

**Expected speeds (MD5 on c5.xlarge):** ~3.8 MH/s per worker. If one worker shows <50% of others, check for issues.
