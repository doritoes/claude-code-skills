# Hashtopolis Cluster Management Strategy

**Purpose:** Optimal operational procedures for managing a running Hashtopolis cluster during active cracking jobs.

---

## ⛔ MANAGEMENT LOOP (EXECUTE EVERY 5-10 MINUTES)

### Quick Status Check

```bash
# 1. Check task progress
ssh ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -e \"
SELECT taskId, taskName, ROUND(keyspaceProgress/keyspace*100,1) as pct,
  (SELECT SUM(isCracked) FROM Hash WHERE hashlistId=tw.hashlistId) as cracked,
  (SELECT COUNT(*) FROM Hash WHERE hashlistId=tw.hashlistId) as total
FROM Task t JOIN TaskWrapper tw ON t.taskWrapperId = tw.taskWrapperId
WHERE t.isArchived=0 AND t.priority > 0
ORDER BY t.priority DESC;
\""

# 2. Check worker health
ssh ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -e \"
SELECT agentId, agentName, isActive, lastTime,
  TIMESTAMPDIFF(SECOND, FROM_UNIXTIME(lastTime), NOW()) as seconds_since_contact
FROM Agent WHERE isActive=1;
\""

# 3. Check for aborted chunks (need reset)
ssh ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -e \"
SELECT taskId, COUNT(*) as aborted FROM Chunk WHERE state=4 GROUP BY taskId;
\""
```

---

## Task Lifecycle Management

### Task States

| Priority | Meaning | Action |
|----------|---------|--------|
| > 0 | Active, dispatching | Monitor |
| = 0 | Complete or paused | Archive if done |

| Archived | Meaning |
|----------|---------|
| 0 | Active |
| 1 | Completed or abandoned |

### When to Archive Tasks

- All hashes cracked (even if progress < 100%)
- Progress < 1% after extended time (impractical)
- Rule attack with >100B keyspace on CPU

```sql
-- Archive completed tasks
UPDATE Task t
JOIN TaskWrapper tw ON t.taskWrapperId = tw.taskWrapperId
SET t.isArchived=1, tw.isArchived=1, t.priority=0
WHERE (SELECT COUNT(*) FROM Hash WHERE hashlistId=tw.hashlistId AND isCracked=0) = 0;
```

### Requeuing Stalled Tasks

```sql
-- Check if task is stalled (no progress in 5 minutes)
SELECT taskId, keyspaceProgress,
  TIMESTAMPDIFF(MINUTE, FROM_UNIXTIME(lastActivity), NOW()) as minutes_stalled
FROM Task WHERE isArchived=0 AND priority > 0;

-- Boost priority for stalled tasks
UPDATE Task SET priority = priority + 10 WHERE taskId = X;
```

---

## Chunk Management

### Chunk States

| State | Meaning | Action |
|-------|---------|--------|
| 0 | PENDING | Waiting for dispatch |
| 2 | DISPATCHED | Currently running |
| 4 | ABORTED | Agent died mid-chunk |
| 5 | FINISHED | Complete |

### Reset Aborted Chunks (CRITICAL)

**Run every 5 minutes during active cracking:**

```sql
-- Count aborted chunks
SELECT COUNT(*) FROM Chunk WHERE state = 4;

-- Reset aborted chunks for re-dispatch
UPDATE Chunk SET state = 0, agentId = NULL WHERE state = 4;
```

### Verify Chunk Coverage

```sql
-- Ensure all keyspace is covered
SELECT
  taskId,
  keyspace,
  SUM(length) as total_chunk_coverage,
  ROUND(SUM(length)/keyspace*100, 2) as coverage_pct,
  SUM(CASE WHEN state=5 THEN length ELSE 0 END) as finished_coverage
FROM Task t
JOIN Chunk c USING (taskId)
WHERE t.isArchived=0
GROUP BY taskId, keyspace;
```

---

## Worker Management

### Worker Health Indicators

| Metric | Healthy | Warning | Critical |
|--------|---------|---------|----------|
| seconds_since_contact | < 60 | 60-300 | > 300 |
| Active chunks | > 0 | 0 (idle) | - |
| Speed | Expected for hash type | < 50% expected | 0 |

### Handling Unresponsive Workers

```bash
# 1. Check if worker VM is running
ssh ubuntu@$WORKER_IP "uptime"

# 2. Check agent service
ssh ubuntu@$WORKER_IP "ps aux | grep python"
ssh ubuntu@$WORKER_IP "journalctl -u hashtopolis-agent --since '5 minutes ago'"

# 3. Restart agent if needed
ssh ubuntu@$WORKER_IP "sudo systemctl restart hashtopolis-agent"
```

### Worker Removal (Graceful)

```sql
-- 1. Deactivate agent (stops new work)
UPDATE Agent SET isActive = 0 WHERE agentId = X;

-- 2. Wait for current chunks to finish
SELECT COUNT(*) FROM Chunk WHERE agentId = X AND state = 2;

-- 3. Clean up (when chunks done)
DELETE FROM Speed WHERE agentId = X;
DELETE FROM Assignment WHERE agentId = X;
UPDATE Chunk SET agentId = NULL WHERE agentId = X;
DELETE FROM Agent WHERE agentId = X;
```

---

## Monitoring Dashboard Queries

### Real-Time Progress (Run Every 30 Seconds)

```bash
while true; do
  PROGRESS=$(ssh ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -sNe \"
    SELECT CONCAT(taskName, ': ', ROUND(keyspaceProgress/keyspace*100,1), '%')
    FROM Task WHERE isArchived=0 AND priority > 0 LIMIT 1;
  \"")
  CRACKED=$(ssh ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -sNe \"
    SELECT SUM(isCracked) FROM Hash h
    JOIN Hashlist hl ON h.hashlistId = hl.hashlistId
    JOIN TaskWrapper tw ON hl.hashlistId = tw.hashlistId
    WHERE tw.isArchived=0;
  \"")
  echo "[$(date +%H:%M:%S)] $PROGRESS | Total cracked: $CRACKED"
  sleep 30
done
```

### Performance Metrics

```sql
-- Worker speeds
SELECT a.agentName, ROUND(s.speed/1000000, 2) as speed_MHs, s.taskId
FROM Speed s JOIN Agent a ON s.agentId = a.agentId
WHERE s.time > UNIX_TIMESTAMP() - 300;

-- Chunks per minute
SELECT
  FLOOR((UNIX_TIMESTAMP() - dispatchTime)/60) as minutes_ago,
  COUNT(*) as chunks_completed
FROM Chunk
WHERE state = 5 AND dispatchTime > UNIX_TIMESTAMP() - 600
GROUP BY minutes_ago;
```

---

## Cost Management

### Estimate Remaining Time

```sql
-- Calculate ETA based on current speed
SELECT
  t.taskId,
  t.taskName,
  t.keyspace - t.keyspaceProgress as remaining,
  (SELECT SUM(s.speed) FROM Speed s WHERE s.taskId = t.taskId) as total_speed,
  ROUND((t.keyspace - t.keyspaceProgress) / NULLIF((SELECT SUM(s.speed) FROM Speed s WHERE s.taskId = t.taskId), 0) / 3600, 2) as hours_remaining
FROM Task t
WHERE t.isArchived = 0 AND t.priority > 0;
```

### When to Scale Down

| Condition | Action |
|-----------|--------|
| Progress > 95% | Consider scale down |
| All easy hashes cracked | Consider stopping |
| Estimated time > budget | Stop or reduce workers |
| Workers idle > 5 min | Reduce worker count |

### Cost Check Before Long Operations

```bash
# Before starting rule attack
KEYSPACE=695000000000  # 695B
SPEED=3800000  # 3.8 MH/s per worker
WORKERS=2
COST_PER_HOUR=0.18

HOURS=$((KEYSPACE / (SPEED * WORKERS) / 3600))
COST=$(echo "$HOURS * $COST_PER_HOUR" | bc)
echo "Estimated time: $HOURS hours"
echo "Estimated cost: \$$COST"
```

---

## Error Recovery

### Common Issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| 0% progress | priority=0 or no agents | Set priority > 0, trust agents |
| Chunks stuck at state=2 | Agent died | Reset: `UPDATE Chunk SET state=0 WHERE state=2 AND agentId=X` |
| Worker shows 0 speed | Benchmark failed | Re-benchmark: Delete Assignment, wait |
| All workers on 1 task | maxAgents not set | Set maxAgents=1 for parallel tasks |

### Database Reset (Last Resort)

```sql
-- Reset a task completely (DESTRUCTIVE)
DELETE FROM Chunk WHERE taskId = X;
UPDATE Task SET keyspaceProgress = 0 WHERE taskId = X;
DELETE FROM Assignment WHERE taskId = X;
-- Workers will re-benchmark and restart
```

---

## Cluster Shutdown Procedure

### 1. Save Results First

```bash
# Export cracked hashes
ssh ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -e \"
SELECT h.hash, h.plaintext FROM Hash h WHERE h.isCracked=1;
\"" > cracked_results.txt
```

### 2. Archive All Tasks

```sql
UPDATE Task SET isArchived=1, priority=0;
UPDATE TaskWrapper SET isArchived=1;
```

### 3. Deactivate Workers

```sql
UPDATE Agent SET isActive = 0;
```

### 4. Verify No Active Chunks

```sql
SELECT COUNT(*) FROM Chunk WHERE state = 2;
-- Must be 0
```

### 5. Destroy Infrastructure

```bash
cd terraform/aws
terraform destroy -auto-approve
```

---

## Summary Checklist

Every 5-10 minutes during active cracking:

- [ ] Check task progress
- [ ] Check worker health (seconds_since_contact < 60)
- [ ] Reset aborted chunks (state=4 → state=0)
- [ ] Archive completed tasks (all hashes cracked)
- [ ] Monitor cost vs estimated completion time

Before shutdown:

- [ ] Export cracked results
- [ ] Archive all tasks
- [ ] Verify no active chunks
- [ ] Destroy infrastructure
