# ExpandedPasswordList Troubleshooting Guide

## Unresponsive Worker Detection and Recovery

### Symptoms
- Agent shows `lastTime` more than 60 seconds ago in database
- Chunks assigned to the agent are not progressing
- Other agents are working normally

### Diagnosis
```sql
-- Check agent last seen times (via SSH to hashtopolis server)
SELECT agentId, agentName,
  FROM_UNIXTIME(lastTime) as lastSeen,
  (UNIX_TIMESTAMP() - lastTime) as secAgo
FROM Agent ORDER BY lastTime DESC;
```

If an agent hasn't checked in for more than 60 seconds while others are checking in every 1-5 seconds, it's likely stuck.

### Getting Worker IP
```sql
SELECT agentId, agentName, lastIp FROM Agent WHERE agentId = <stuck_agent_id>;
```

### Recovery: Reboot via AWS CLI

1. **Find the instance ID**:
```bash
AWS_ACCESS_KEY_ID=<key> AWS_SECRET_ACCESS_KEY='<secret>' AWS_DEFAULT_REGION=us-west-2 \
  aws ec2 describe-instances \
  --filters "Name=private-ip-address,Values=<worker_private_ip>" \
  --query "Reservations[*].Instances[*].[InstanceId,PrivateIpAddress,State.Name,Tags[?Key=='Name'].Value|[0]]" \
  --output text
```

2. **Reboot the instance**:
```bash
AWS_ACCESS_KEY_ID=<key> AWS_SECRET_ACCESS_KEY='<secret>' AWS_DEFAULT_REGION=us-west-2 \
  aws ec2 reboot-instances --instance-ids <instance_id>
```

3. **Verify recovery** (after ~60 seconds):
```sql
SELECT agentId, agentName, (UNIX_TIMESTAMP() - lastTime) as secAgo FROM Agent;
```

The agent should start checking in again and automatically pick up available work.

### Post-Reboot: Fixing Stuck Chunks

After rebooting a worker, its old chunk may still be in DISPATCHED state (state=2) but not progressing. The agent will pick up a NEW task, leaving the old chunk orphaned.

**Check for stuck chunks assigned to the rebooted agent:**
```sql
SELECT c.chunkId, c.taskId, t.taskName, c.state, c.agentId, c.progress
FROM Chunk c
JOIN Task t ON c.taskId=t.taskId
WHERE c.agentId = <rebooted_agent_id> AND c.state = 2;
```

**If chunk progress is stale (not increasing over multiple checks):**
```sql
-- Abort the stuck chunk so it can be reassigned
UPDATE Chunk SET state=6 WHERE chunkId = <stuck_chunk_id> AND state=2;
```

**Verify the agent now has a healthy chunk:**
```sql
SELECT agentId, (SELECT COUNT(*) FROM Chunk c WHERE c.agentId=a.agentId AND c.state=2) as activeChunks
FROM Agent a WHERE agentId = <agent_id>;
```

### Important Notes
- **DO NOT** manually assign tasks to agents - let Hashtopolis handle assignment
- GPU VMs are expensive - fix unresponsive workers promptly
- The agent automatically starts on boot via systemd/init
- Rebooting clears any stuck agent process state
- After reboot, monitor chunk progress to ensure work is actually being done

### Root Cause: crackPos NULL Bug (Critical)

**Symptom**: Agent checks in frequently but chunk progress never increases.

**Log signature**:
```
PHP Fatal error: Uncaught PDOException: SQLSTATE[23000]: Integrity constraint violation:
1048 Column 'crackPos' cannot be null in AbstractModelFactory.class.php:805
```

Check backend logs:
```bash
ssh ubuntu@<server_ip> "sudo docker logs hashtopolis-backend --tail 50 2>&1 | grep -i error"
```

**Diagnosis**:
```sql
-- Compare progress over 30 seconds - if unchanged, chunk is stuck
SELECT chunkId, taskId, agentId, progress FROM Chunk WHERE state=2;
-- Wait 30 seconds and run again - stuck chunks show no progress change
```

**Fix**: Abort the stuck chunk and clear agent assignment:
```sql
-- MUST set agentId to NULL or the agent will reset state back to 2
UPDATE Chunk SET state=6, agentId=NULL WHERE chunkId=<stuck_chunk_id>;
```

**Root Cause**: Hashtopolis 0.14.x has a bug in `APISendProgress.class.php` line 249 where array key 3 is undefined. This causes progress updates to fail with 500 errors. The work IS being done by hashcat, but progress cannot be reported to the server.

**Investigation TODO** (use /algorithm):
1. Review Hashtopolis source code at `src/inc/api/APISendProgress.class.php` line 249
2. Identify what data structure causes the undefined array key
3. Create a patch or workaround
4. Consider upgrading to newer Hashtopolis version if fixed

**Workaround**: When this bug hits a chunk:
1. The hashcat work may actually be happening, but progress isn't saved
2. Cracked passwords ARE being collected (check `cracked` field on chunk)
3. After aborting, the remaining keyspace will be re-assigned as a new chunk

## Orphaned Chunks

If a task is archived but its chunk remains in DISPATCHED state (state=2):

```sql
-- Abort orphaned chunks for archived tasks
UPDATE Chunk SET state=6 WHERE taskId IN (SELECT taskId FROM Task WHERE isArchived=1) AND state=2;

-- Clear orphaned assignments
DELETE FROM Assignment WHERE taskId IN (SELECT taskId FROM Task WHERE isArchived=1);
```

## Priority Management (Critical for Queue Order)

### Problem: Lower Priority Tasks Being Worked First
Agents may work on low-priority batches while high-priority batches sit idle. This wastes disk space and GPU time.

**Diagnosis**:
```sql
-- Check what agents are working on vs priorities
SELECT a.agentId, a.agentName, ass.taskId, t.taskName, t.priority
FROM Agent a
LEFT JOIN Assignment ass ON a.agentId=ass.agentId
LEFT JOIN Task t ON ass.taskId=t.taskId
ORDER BY t.priority DESC;
```

### Root Cause: Task AND TaskWrapper Priorities
Hashtopolis uses **both** `Task.priority` and `TaskWrapper.priority`. Both MUST be updated:

```sql
-- Update Task priority (batch-0006 highest, descending for newer batches)
UPDATE Task SET priority=100 WHERE taskName LIKE '%batch-0006%' AND isArchived=0;
UPDATE Task SET priority=90 WHERE taskName LIKE '%batch-0007%' AND isArchived=0;
-- ... continue descending for newer batches

-- CRITICAL: Sync TaskWrapper priorities to match!
UPDATE TaskWrapper tw
JOIN Task t ON tw.taskWrapperId = t.taskWrapperId
SET tw.priority = t.priority
WHERE t.isArchived = 0;
```

### Forcing Agents to Pick Up High-Priority Tasks
If agents are stuck on low-priority tasks after updating priorities:

```sql
-- Abort low-priority active chunks to free agents
UPDATE Chunk c
JOIN Task t ON c.taskId = t.taskId
SET c.state=6, c.agentId=NULL
WHERE t.priority < 50 AND c.state=2;

-- Clear those assignments
DELETE FROM Assignment WHERE taskId IN (
  SELECT taskId FROM Task WHERE priority < 50
);
```

Agents will then pick up the highest-priority available work.

### Priority Strategy
- **Batch-0006**: priority 100 (oldest, finish first)
- **Batch-0007**: priority 90
- **Batch-0008**: priority 80
- Continue descending by 10 for each new batch
- This ensures older batches complete first, minimizing concurrent disk usage

## Disk Space

### Server Disk
```bash
ssh ubuntu@<server_ip> "df -h /"
```

### Worker Disk (via WorkerCleanup.ts)
```bash
bun run Tools/WorkerCleanup.ts --status
```

If workers show as unreachable via SSH but are active in Hashtopolis, they're working correctly - the SSH connectivity is a network topology issue (workers only accessible from within VPC).
