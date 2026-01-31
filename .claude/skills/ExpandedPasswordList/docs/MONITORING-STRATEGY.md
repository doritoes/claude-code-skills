# ExpandedPasswordList Monitoring Strategy

## Overview
This document defines the monitoring strategy for managing the HIBP hash cracking pipeline with 8 GPU workers.

## PREFERRED: Use Automated Tools

**Instead of running manual SQL queries, use the consolidated tools:**

```bash
# Comprehensive pipeline health check (RECOMMENDED)
bun Tools/PipelineMonitor.ts              # Full health checks
bun Tools/PipelineMonitor.ts --quick      # Quick status only
bun Tools/PipelineMonitor.ts --fix        # Auto-fix simple issues

# Safe task archiving with validation (REQUIRED before archiving)
bun Tools/SafeArchiver.ts --check batch-0020     # Validate before archive
bun Tools/SafeArchiver.ts --batch batch-0020     # Archive after validation
```

**Benefits:**
- Built-in validation prevents premature archiving
- Automatic chunk progress advancement detection
- Crack count consistency checking
- Priority alignment verification
- Reduces manual SQL errors

**See also:** `docs/LESSONS-LEARNED.md` for critical anti-patterns to avoid.

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

**Detection (MANDATORY - run this check regularly):**
```sql
-- Run twice, 20-30 seconds apart - if progress unchanged, chunk is stuck
SELECT c.chunkId, c.taskId, t.taskName, c.agentId, c.progress, c.cracked
FROM Chunk c
JOIN Task t ON c.taskId = t.taskId
WHERE c.state=2;
```

**Alert Threshold:** Progress unchanged over 20+ seconds while agent is checking in.

**Verification - Check backend logs:**
```bash
ssh ubuntu@<server_ip> "sudo docker logs hashtopolis-backend --tail 20 2>&1 | grep error"
```
Look for: `Column 'crackPos' cannot be null`

**Resolution:**
```sql
-- Abort the stuck chunk (MUST set agentId=NULL)
UPDATE Chunk SET state=6, agentId=NULL WHERE chunkId=<stuck_chunk_id>;

-- CRITICAL: After aborting, reset keyspaceProgress since work wasn't done
-- Check chunk's skip+progress vs task's keyspaceProgress
UPDATE Task SET keyspaceProgress = 0 WHERE taskId = <task_id>;

-- Reset chunk to NEW if you want to retry immediately
UPDATE Chunk SET state=0, agentId=NULL, progress=0, dispatchTime=0, solveTime=0
WHERE chunkId=<stuck_chunk_id>;
```
Agent will pick up new work on next check-in.

**IMPORTANT:** After aborting a chunk, the task's keyspaceProgress may be inflated.
The chunk was allocated keyspace but didn't complete the work. Reset keyspaceProgress
to allow Hashtopolis to create new chunks for the remaining work.

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

**CRITICAL: NEVER trust keyspaceProgress alone! ALWAYS check chunk status.**

**Safe Archiving Checklist (ALL must be true):**

1. **Verify all tasks show keyspaceProgress >= keyspace:**
   ```sql
   SELECT COUNT(*) FROM Task
   WHERE taskName LIKE '%batch-00XX%'
   AND (keyspaceProgress < keyspace OR keyspace = 0);
   ```
   Should return 0.

2. **CRITICAL: Verify NO active or pending chunks:**
   ```sql
   SELECT COUNT(*) FROM Chunk c
   JOIN Task t ON c.taskId = t.taskId
   WHERE t.taskName LIKE '%batch-00XX%'
   AND c.state IN (0, 2);  -- 0=NEW, 2=DISPATCHED
   ```
   **MUST return 0 before archiving!**

3. **CRITICAL: Verify ALL chunks are FINISHED (state=4), not ABORTED (state=6):**
   ```sql
   -- Check chunk states for the batch
   SELECT t.taskId, t.taskName, c.chunkId, c.state,
     CASE c.state
       WHEN 0 THEN 'NEW'
       WHEN 2 THEN 'DISPATCHED'
       WHEN 4 THEN 'FINISHED'
       WHEN 6 THEN 'ABORTED'
     END as state_name
   FROM Task t
   JOIN Chunk c ON t.taskId = c.taskId
   WHERE t.taskName LIKE '%batch-00XX%';
   ```
   **ALL chunks must show state=4 (FINISHED)!**
   If ANY chunk is state=6 (ABORTED), the work was NOT completed - DO NOT ARCHIVE!

4. **Only then archive:**
   ```sql
   UPDATE Task SET isArchived=1, priority=0 WHERE taskName LIKE '%batch-00XX%';
   ```

**WHY THIS MATTERS:**
- keyspaceProgress can show 100% while chunks are still in DISPATCHED state
- Archiving a task with active chunks ABORTS those chunks
- This kills the agent's work and causes it to become unresponsive
- Cracked results may not be fully reported yet

**Combined Safe Archive Query:**
```sql
-- Archive AND set priority=0 for tasks with NO active chunks
-- Setting priority=0 cleans up the tasks.php web UI
UPDATE Task t SET t.isArchived=1, t.priority=0
WHERE t.taskName LIKE '%batch-00XX%'
AND t.keyspaceProgress >= t.keyspace
AND t.keyspace > 0
AND NOT EXISTS (
  SELECT 1 FROM Chunk c
  WHERE c.taskId = t.taskId
  AND c.state IN (0, 2)
);
```

### When Queuing New Batches
1. Set priority 10 lower than current lowest (ensure older batches complete first)
2. Verify files are linked to tasks
3. Update both Task.priority AND TaskWrapper.priority

---

## Anti-Patterns to Avoid

1. **DO NOT** manually assign tasks to agents
2. **DO NOT** manually create chunks
3. **DO NOT** run hashcat outside of Hashtopolis
4. **DO NOT** archive tasks based on keyspaceProgress alone - ALWAYS check chunk state
5. **DO NOT** trust the keyspace display - always verify with chunk queries
6. **DO NOT** reset chunk timestamps/state without understanding consequences
7. **DO NOT** assume orphaned chunks are safe to delete - investigate WHY first
8. **DO** let Hashtopolis handle work distribution
9. **DO** only intervene for:
   - Infrastructure issues (worker reboot)
   - Bug workarounds (crackPos null)
   - Priority correction

### Chunk State Reference
| State | Name | Meaning |
|-------|------|---------|
| 0 | NEW | Pending, ready for assignment |
| 2 | DISPATCHED | Currently being worked by an agent |
| 4 | FINISHED | Completed successfully |
| 6 | ABORTED | Cancelled or failed |
| 9 | TRIMMED | Split into smaller chunks (leave alone!) |

### Hashtopolis Auto-Priority Reset
**Hashtopolis automatically sets priority=0 when:**
- A task reaches keyspaceProgress >= keyspace (100% complete)
- This happens even if you manually set a higher priority

**Implication:** You cannot override priority on a "complete" task.
If keyspaceProgress shows 100% but work remains, you may need to:
1. Verify chunks actually cover the full keyspace
2. Check if overlapping chunks inflated coverage reporting
3. Manually adjust keyspaceProgress if chunks were aborted mid-work

### CRITICAL ANTI-PATTERN: Premature Archiving

**NEVER do this:**
```sql
-- WRONG! This can kill active chunks!
UPDATE Task SET isArchived=1 WHERE keyspaceProgress >= keyspace;
```

**ALWAYS check chunks first:**
```sql
-- CORRECT: Only archive if ALL chunks are FINISHED (state=4)
SELECT chunkId, state FROM Chunk WHERE taskId=<id> AND state NOT IN (4, 9);
-- Must return EMPTY before archiving! (state 9 = TRIMMED is OK)
```

**Full validation before archiving:**
```sql
-- 1. Check no active/pending chunks
SELECT COUNT(*) FROM Chunk WHERE taskId=<id> AND state IN (0, 2);
-- Must be 0

-- 2. Check all chunks are FINISHED or TRIMMED (not ABORTED)
SELECT COUNT(*) FROM Chunk WHERE taskId=<id> AND state = 6;
-- Must be 0 (no ABORTED chunks)

-- 3. Verify chunk coverage matches keyspace
SELECT t.keyspace, MAX(c.skip + c.length) as covered
FROM Task t JOIN Chunk c ON t.taskId = c.taskId
WHERE t.taskId=<id> AND c.state = 4
GROUP BY t.keyspace;
-- covered should equal keyspace
```

**Consequence of premature archiving:**
- Active chunks get aborted mid-work
- Agents become unresponsive (need reboot)
- Some cracked results may be lost
- GPU time wasted on aborted work
- **batch-0001 was archived at 0% - total loss of work!**

### CRITICAL: Verify Chunk Progress is Advancing

**Run this check every 20-30 seconds when chunks are active:**
```sql
SELECT c.chunkId, c.taskId, c.progress, c.cracked FROM Chunk c WHERE c.state=2;
```

If progress is unchanged after 20+ seconds, the chunk is STUCK (likely crackPos NULL bug).
**Resolution:** Abort chunk, reset keyspaceProgress, let Hashtopolis create new chunk.

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

### CrackSubmitter Auto-Priority (v2.0+)
CrackSubmitter now **automatically calculates priority** from batch number:
- **Formula:** `priority = 1000 - batch_number`
- **Result:** Older batches get higher priority, ensuring they complete first
- **CRITICAL:** Minimum priority is 1, NOT 0! Priority=0 is reserved for completed tasks.

| Batch | Auto-Priority |
|-------|---------------|
| batch-0001 | 999 |
| batch-0006 | 994 |
| batch-0100 | 900 |
| batch-0500 | 500 |
| batch-1000 | 1 (minimum) |

This formula scales to 1000 batches while maintaining relative order.

**Override:** `bun CrackSubmitter.ts --batch 17 --workers 8 --priority 90`

### Legacy Tasks (pre-auto-priority)
Tasks created before auto-priority may have priority=10 or priority=0.
**Fix manually:**
```sql
-- Update both Task AND TaskWrapper priorities
UPDATE Task SET priority=70 WHERE taskName LIKE '%batch-0006%' AND isArchived=0;
UPDATE TaskWrapper tw
JOIN Task t ON tw.taskWrapperId = t.taskWrapperId
SET tw.priority = t.priority
WHERE t.taskName LIKE '%batch-0006%' AND t.isArchived = 0;
```

### Archiving and Web UI (CRITICAL LEARNING)

**Hashtopolis Web UI logic:**
- `tasks.php` shows tasks with: (isArchived=0) OR (priority > 0)
- `tasks.php?archived=true` shows tasks with isArchived=1

**IMPORTANT: priority > 0 OVERRIDES isArchived and task still shows on tasks.php!**

**Visibility rules:**
| isArchived | priority | Shown on tasks.php? |
|------------|----------|---------------------|
| 0 | any | YES |
| 1 | 0 | NO (archived only) |
| 1 | >0 | YES (priority overrides!) |

**Hashtopolis resets priority to 0 when a task completes normally.**
This is automatic behavior, not something we control.

**Correct archiving process:**
1. Verify task is complete (keyspaceProgress >= keyspace, no pending chunks)
2. Set `isArchived=1`
3. Verify `priority=0` (should be automatic on completion)
4. If priority > 0 on a completed task, set it to 0 manually

**SQL for proper cleanup:**
```sql
-- Archive completed tasks AND ensure priority=0
UPDATE Task SET isArchived=1, priority=0
WHERE keyspaceProgress >= keyspace AND keyspace > 0
AND NOT EXISTS (SELECT 1 FROM Chunk c WHERE c.taskId = Task.taskId AND c.state IN (0,2));
```

- **Key insight:** Tasks with priority>0 show on tasks.php regardless of isArchived
- **Key insight:** For clean UI, archived tasks MUST have priority=0

### Priority Best Practices
1. Let CrackSubmitter auto-calculate priority (default behavior)
2. Only override with `--priority` flag when necessary
3. Always update BOTH Task.priority AND TaskWrapper.priority when fixing legacy tasks
4. Re-verify priorities after batch completion (completed tasks stay at their priority)

---

## Key Metrics to Track

| Metric | Target | Alert Threshold |
|--------|--------|-----------------|
| Alive Agents | 8/8 | <8 for >60s |
| Active Chunks | 8 | <6 sustained |
| Crack Rate | ~25-30%/batch | <20% indicates bad passwords |
| Oldest Incomplete Batch | N | N+3 or more batches active |
| Server Disk Usage | <80% | >85% critical |

---

## Validation Techniques

### Cross-Check Cracks Per Task (Batch Validation)
Tasks within a batch should have similar crack counts since they use the same hash type and attack.

**Query:**
```sql
SELECT t.taskName, tw.cracked
FROM Task t
JOIN TaskWrapper tw ON t.taskWrapperId = tw.taskWrapperId
WHERE t.taskName LIKE '%batch-00XX%'
ORDER BY t.taskName;
```

**Expected:** All tasks in the batch should have crack counts within ~2 standard deviations.
**Alert:** If one task has significantly fewer cracks, it may have:
- Been aborted mid-work
- Had stuck chunks that didn't complete
- Encountered errors

**Example (healthy batch-0020):**
| Task | Cracked |
|------|---------|
| part1 | 18,914 |
| part2 | 18,603 |
| ... | ~18,600 |
| part8 | 18,600 |

Range of ~300 = healthy. If one part shows 5,000 while others show 18,000, investigate!

### Chunk State Reference
| State | Name | Meaning |
|-------|------|---------|
| 0 | NEW | Pending, not yet assigned |
| 2 | DISPATCHED | Currently being worked |
| 4 | FINISHED | Completed successfully |
| 6 | ABORTED | Cancelled/failed |
| 9 | TRIMMED | Split into smaller chunks |

---

## Disk Space Management

### When to Check Disk Space
- Every 15 minutes during active operation
- After archiving batches
- Before starting new batches

### Server Disk Check
```bash
ssh ubuntu@<server_ip> "df -h /"
```

Target: <80% used. Alert at >85%.

### Cleanup Strategy

**After Archiving Batches:**
1. **Verify batch is truly complete** (safe archiving criteria met)
2. **Extract cracked results** before cleanup:
   ```sql
   -- Get cracked passwords for archived batch
   SELECT h.plaintext FROM Hash h
   JOIN Hashlist hl ON h.hashlistId = hl.hashlistId
   WHERE hl.name LIKE '%batch-00XX%' AND h.isCracked = 1;
   ```
3. **Save PEARLS to local storage**
4. **Delete hashlists** (optional, saves disk space):
   ```sql
   -- Only after results are extracted!
   DELETE FROM Hash WHERE hashlistId IN (
     SELECT hashlistId FROM Hashlist WHERE name LIKE '%batch-00XX%'
   );
   DELETE FROM Hashlist WHERE name LIKE '%batch-00XX%';
   ```

**Cleanup Timing:**
| Event | Cleanup Action |
|-------|----------------|
| Batch archived | Extract results, mark for cleanup |
| 3+ batches behind | Prioritize cleanup of oldest |
| Disk >70% | Immediate cleanup of oldest archived |
| Disk >85% | CRITICAL: Stop new batches, cleanup now |

### Worker Disk (Limited Visibility)
Workers store:
- hashcat binaries (~500MB)
- Attack files (rockyou.txt ~139MB, rules ~1MB)
- Temporary potfiles

Workers are NOT directly accessible via SSH from outside VPC.
Monitor via Hashtopolis agent status - if agent becomes unresponsive after long operation, disk full is a possible cause.

**Worker cleanup** happens automatically when:
- Agent restarts (clears temp files)
- VM is rebooted
