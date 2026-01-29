# ExpandedPasswordList Monitoring Strategy

## Overview
This document defines the monitoring strategy for managing the HIBP hash cracking pipeline with 8 GPU workers.

## Monitoring Intervals

| Check | Interval | Purpose |
|-------|----------|---------|
| Agent Health | 60 seconds | Detect unresponsive workers |
| Chunk Progress | 60 seconds | Verify work is progressing |
| Batch Completion | 2-3 minutes | Track pipeline progress |
| PEARLS Count | 5 minutes | Track cracking success rate |
| Disk Space | 15 minutes | Prevent disk full crashes |
| Priority Alignment | On batch change | Ensure oldest batches first |

## Quick Status Query
```sql
SELECT
  (SELECT COUNT(*) FROM Agent WHERE UNIX_TIMESTAMP() - lastTime < 60) as alive_agents,
  (SELECT COUNT(*) FROM Chunk WHERE state=2) as active_chunks,
  (SELECT SUM(isCracked) FROM Hash) as cracked
FROM DUAL;
```
Expected: 8 agents, 8 chunks, increasing cracked count.

---

## Issue Detection & Resolution

### 1. Unresponsive Worker (Agent not checking in)

**Detection:**
```sql
SELECT agentId, agentName, (UNIX_TIMESTAMP() - lastTime) as secAgo
FROM Agent WHERE (UNIX_TIMESTAMP() - lastTime) > 60;
```

**Alert Threshold:** Agent not seen for >60 seconds while others check in every 1-5 seconds.

**Resolution:**
1. Get worker IP: `SELECT lastIp FROM Agent WHERE agentId=<id>;`
2. Find AWS instance:
   ```bash
   aws ec2 describe-instances --region us-west-2 \
     --filters "Name=private-ip-address,Values=<ip>" \
     --query "Reservations[*].Instances[*].[InstanceId]" --output text
   ```
3. Reboot: `aws ec2 reboot-instances --region us-west-2 --instance-ids <instance_id>`
4. Verify recovery after ~60 seconds

---

### 2. Chunk Not Progressing (crackPos NULL bug)

**Detection:**
```sql
-- Run twice, 30 seconds apart - if progress unchanged, chunk is stuck
SELECT c.chunkId, c.taskId, c.agentId, c.progress
FROM Chunk c WHERE c.state=2;
```

**Alert Threshold:** Progress unchanged over 30+ seconds.

**Verification - Check backend logs:**
```bash
ssh ubuntu@<server_ip> "sudo docker logs hashtopolis-backend --tail 20 2>&1 | grep error"
```
Look for: `Column 'crackPos' cannot be null`

**Resolution:**
```sql
-- Abort the stuck chunk (MUST set agentId=NULL)
UPDATE Chunk SET state=6, agentId=NULL WHERE chunkId=<stuck_chunk_id>;
```
Agent will pick up new work on next check-in.

---

### 3. Priority Misalignment (Lower priority batches worked first)

**Detection:**
```sql
-- Active chunks should be from highest priority batches
SELECT c.chunkId, t.taskName, t.priority, tw.priority as wrapperPriority
FROM Chunk c
JOIN Task t ON c.taskId = t.taskId
JOIN TaskWrapper tw ON t.taskWrapperId = tw.taskWrapperId
WHERE c.state = 2
ORDER BY t.priority DESC;
```

**Alert Threshold:** Chunks from priority <50 batches while priority 100 batches have incomplete tasks.

**Resolution:**
1. Update Task priorities (older batches = higher priority):
   ```sql
   UPDATE Task SET priority=100 WHERE taskName LIKE '%batch-0006%' AND isArchived=0;
   -- Continue with descending priority for newer batches
   ```

2. **CRITICAL: Sync TaskWrapper priorities:**
   ```sql
   UPDATE TaskWrapper tw
   JOIN Task t ON tw.taskWrapperId = t.taskWrapperId
   SET tw.priority = t.priority
   WHERE t.isArchived = 0;
   ```

3. Abort low-priority chunks to free agents:
   ```sql
   UPDATE Chunk c
   JOIN Task t ON c.taskId = t.taskId
   SET c.state=6, c.agentId=NULL
   WHERE t.priority < 50 AND c.state=2;

   DELETE FROM Assignment WHERE taskId IN (
     SELECT taskId FROM Task WHERE priority < 50
   );
   ```

---

### 4. Too Many Concurrent Batches (Disk Space Risk)

**Detection:**
```sql
SELECT
  SUBSTRING_INDEX(taskName, '-part', 1) as batch,
  SUM(CASE WHEN keyspaceProgress < keyspace OR keyspace = 0 THEN 1 ELSE 0 END) as incomplete
FROM Task WHERE isArchived=0
GROUP BY batch
HAVING incomplete > 0;
```

**Alert Threshold:** More than 3-4 batches with incomplete work.

**Resolution:**
1. Ensure priority alignment (see #3)
2. Archive completed batches:
   ```sql
   UPDATE Task SET isArchived=1 WHERE taskId IN (
     SELECT taskId FROM (
       SELECT taskId FROM Task
       WHERE keyspaceProgress >= keyspace AND keyspace > 0
     ) as completed
   );
   ```

---

### 5. Orphaned Chunks (Task archived but chunk still active)

**Detection:**
```sql
SELECT c.chunkId, c.taskId, t.isArchived
FROM Chunk c
JOIN Task t ON c.taskId = t.taskId
WHERE c.state = 2 AND t.isArchived = 1;
```

**Resolution:**
```sql
UPDATE Chunk SET state=6, agentId=NULL
WHERE taskId IN (SELECT taskId FROM Task WHERE isArchived=1) AND state=2;

DELETE FROM Assignment
WHERE taskId IN (SELECT taskId FROM Task WHERE isArchived=1);
```

---

## Batch Lifecycle Management

### When Batch Completes (8/8 tasks done)
1. Verify all tasks complete:
   ```sql
   SELECT COUNT(*) FROM Task
   WHERE taskName LIKE '%batch-00XX%'
   AND (keyspaceProgress < keyspace OR keyspace = 0);
   ```
   Should return 0.

2. Archive the batch:
   ```sql
   UPDATE Task SET isArchived=1 WHERE taskName LIKE '%batch-00XX%';
   ```

3. Adjust priorities for remaining batches (move next batch to highest).

### When Queuing New Batches
1. Set priority 10 lower than current lowest (ensure older batches complete first)
2. Verify files are linked to tasks
3. Update both Task.priority AND TaskWrapper.priority

---

## Anti-Patterns to Avoid

1. **DO NOT** manually assign tasks to agents
2. **DO NOT** manually create chunks
3. **DO NOT** run hashcat outside of Hashtopolis
4. **DO** let Hashtopolis handle work distribution
5. **DO** only intervene for:
   - Infrastructure issues (worker reboot)
   - Bug workarounds (crackPos null)
   - Priority correction

---

## Monitoring Script Template

```bash
#!/bin/bash
SERVER_IP="16.147.88.9"
DB_PASS="<password>"

while true; do
    result=$(ssh ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' -N -e '
    SELECT
      (SELECT COUNT(*) FROM Agent WHERE UNIX_TIMESTAMP() - lastTime < 60),
      (SELECT COUNT(*) FROM Chunk WHERE state=2),
      (SELECT SUM(isCracked) FROM Hash)
    ' hashtopolis 2>/dev/null")

    alive=$(echo $result | cut -d' ' -f1)
    chunks=$(echo $result | cut -d' ' -f2)
    cracked=$(echo $result | cut -d' ' -f3)

    echo "$(date '+%H:%M:%S') | Agents: $alive/8 | Chunks: $chunks | PEARLS: $cracked"

    if [ "$alive" -lt 8 ]; then
        echo "ALERT: Only $alive agents alive - investigate!"
    fi

    sleep 60
done
```

---

## Priority Behavior Notes

### Default Priority
- New tasks created without explicit priority: **priority=10** (CrackSubmitter default)
- TaskWrapper priority must match Task priority for correct assignment

### Priority=0 Meaning
- Priority 0 is the **lowest** priority
- Tasks often get priority=0 when:
  1. They were created with default priority and never updated
  2. They completed before priority management was implemented
- **Archived tasks retain their last priority** (archiving doesn't change priority)

### Priority Best Practices
1. Set high priority (100) on oldest incomplete batches immediately after creation
2. Always update BOTH Task.priority AND TaskWrapper.priority
3. Re-verify priorities after batch completion (completed tasks stay at their priority)
4. Use descending priority: batch N=100, batch N+1=90, batch N+2=80, etc.

---

## Key Metrics to Track

| Metric | Target | Alert Threshold |
|--------|--------|-----------------|
| Alive Agents | 8/8 | <8 for >60s |
| Active Chunks | 8 | <6 sustained |
| Crack Rate | ~25-30%/batch | <20% indicates bad passwords |
| Oldest Incomplete Batch | N | N+3 or more batches active |
| Server Disk Usage | <80% | >85% critical |
