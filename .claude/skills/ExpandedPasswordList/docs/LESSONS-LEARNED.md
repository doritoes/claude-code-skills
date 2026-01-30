# ExpandedPasswordList: Lessons Learned

## Date: 2026-01-30

This document captures critical lessons learned from the pipeline operation session.

---

## Critical Errors Made (DO NOT REPEAT)

### 1. Archiving Without Validation
**What happened:** batch-0001 was archived while all 8 parts showed 0% progress.
**Root cause:** Checked `keyspaceProgress >= keyspace` without verifying chunk states.
**Prevention:** ALWAYS use `SafeArchiver.ts --check` before archiving. Never archive based on keyspaceProgress alone.

### 2. Resetting Wrong Chunk State
**What happened:** Reset chunk 245 from state=9 (TRIMMED) thinking it was stuck.
**Root cause:** Didn't understand that state=9 means chunk was already split/completed.
**Prevention:** Check chunk state BEFORE modifying. State=9 (TRIMMED) is a valid completion state.

### 3. Setting epoch timestamps
**What happened:** Set dispatchTime=0 when resetting chunks, causing "1970-01-01" display.
**Root cause:** Used `dispatchTime=0` to clear the field.
**Prevention:** Use `dispatchTime=NULL` or `dispatchTime=UNIX_TIMESTAMP()` when resetting.

### 4. Updating Task.priority without TaskWrapper.priority
**What happened:** Priority changes kept reverting.
**Root cause:** Hashtopolis uses BOTH `Task.priority` AND `TaskWrapper.priority`.
**Prevention:** ALWAYS update both:
```sql
UPDATE Task SET priority=X WHERE taskId=Y;
UPDATE TaskWrapper tw JOIN Task t ON tw.taskWrapperId=t.taskWrapperId
SET tw.priority=t.priority WHERE t.taskId=Y;
```

### 5. Not checking chunk progress advancement
**What happened:** Assumed chunks were progressing because agents were checking in.
**Root cause:** crackPos NULL bug causes chunks to stop progressing despite agent activity.
**Prevention:** Always check progress advancing every 20-30 seconds. Use `PipelineMonitor.ts`.

### 6. Cleaning up "orphaned chunks" without investigation
**What happened:** Cleaned up chunks for archived tasks without checking if tasks were archived in error.
**Root cause:** Assumed archived = completed.
**Prevention:** Before cleaning orphaned chunks, verify the parent task was CORRECTLY archived (100% complete).

---

## Hashtopolis Behavior (Reference)

### Chunk States
| State | Name | Meaning |
|-------|------|---------|
| 0 | NEW | Not assigned yet |
| 2 | DISPATCHED | Being worked on |
| 4 | FINISHED | Completed successfully |
| 6 | ABORTED | Interrupted, will be reassigned |
| 9 | TRIMMED | Split into smaller chunks (completion state) |

### Priority Auto-Reset
- Hashtopolis sets `priority=0` when `keyspaceProgress >= keyspace`
- This is by design, not a bug
- Cannot rely on priority values for historical tracking
- Use task naming convention for batch identification

### crackPos NULL Bug
- Symptom: Agent checks in frequently but chunk progress never increases
- Cause: APISendProgress.class.php line 249 has undefined array key
- The work IS being done, but progress can't be saved
- Cracked passwords ARE collected (check `cracked` field)
- Fix: Abort stuck chunk with `SET state=6, agentId=NULL`

---

## Monitoring Checklist (Follow Every Session)

### Before Starting GPU VMs
1. Check server health: `ssh ubuntu@<server_ip> "df -h /; docker ps"`
2. Review pending batches: `SELECT taskName, priority FROM Task WHERE isArchived=0`

### During Operation
1. Run `PipelineMonitor.ts` every 5-10 minutes
2. Check chunk progress is advancing (20-30 second intervals)
3. Verify crack counts within batch are consistent (within 2 std dev)
4. Watch for unresponsive agents (lastTime > 60s)

### Before Archiving
1. ALWAYS run `SafeArchiver.ts --check <batch>` first
2. Verify: keyspaceProgress >= keyspace
3. Verify: No active chunks (state 0 or 2)
4. Verify: No ABORTED chunks (state 6) - indicates incomplete work
5. Verify: Has finished chunks (state 4 or 9)
6. Verify: Crack counts consistent across batch parts

### Before Powering Down
1. All active chunks have progressed recently
2. No high-priority work pending
3. Document any outstanding issues in TROUBLESHOOTING.md

---

## Tools Created to Prevent Errors

### PipelineMonitor.ts
Consolidates ALL health checks into single command:
- Agent health (alive/stale)
- **Task initialization (keyspace=0 detection)** - NEW, auto-fixable
- **Idle agent detection** - NEW, warns when workers have no work
- Chunk progress advancement (20s wait)
- Priority alignment (Task vs TaskWrapper)
- Archive readiness validation
- Crack distribution across batches

Run with `--fix` flag to automatically apply fixes for keyspace=0 and priority misalignment.

### CrackSubmitter.ts (Updated)
Now includes duplicate prevention:
- `checkTaskExists()` - Prevents re-creating existing tasks
- `checkBatchExists()` - Prevents re-submitting entire batches
- Skips submission with warning if duplicates detected

### AgentManager.ts (NEW)
Reliable agent-to-instance mapping and health management:
- `bun AgentManager.ts` - Show agent status with instance IDs
- `bun AgentManager.ts --fix` - Remediate stale/critical agents
- `bun AgentManager.ts --watch` - Continuous monitoring (60s interval)

Features:
- Deterministic agent→EC2 instance mapping via private IP
- Auto-detects stale (>2min) and critical (>5min) agents
- Auto-frees stuck chunks before rebooting
- Auto-reboots critical agents in watch mode

### SafeArchiver.ts
Validates ALL conditions before archiving:
1. keyspaceProgress >= keyspace (100% complete)
2. No active/pending chunks (state 0 or 2)
3. No ABORTED chunks (state 6)
4. Has finished chunks (state 4)
5. Chunk coverage matches keyspace
6. Crack counts consistent within batch

### 7. Duplicate Task Submission (CRITICAL)
**What happened:** Tasks 237 and 246 were both "Crack-HIBP-batch-0026-part3" - duplicate work.
**Root cause:** CrackSubmitter.ts submitted same batch multiple times without checking for existing tasks.
**Impact:** Wasted GPU compute time on duplicate work.
**Prevention:** Added `checkTaskExists()` and `checkBatchExists()` functions to CrackSubmitter.ts.
Always check for existing tasks before creating new ones.

### 8. Tasks with keyspace=0 Cause Idle GPU Workers (CRITICAL)
**What happened:** Agent 1 sat idle for 10+ minutes while 7 other agents worked.
**Root cause:** Task 272 (batch-0027-part6) had keyspace=0, meaning no work could be assigned.
**Impact:** Expensive GPU VM sitting idle, wasting money.
**Prevention:** Added `checkUninitializedTasks()` to PipelineMonitor.ts with auto-fix:
```sql
UPDATE Task SET useNewBench = 1 WHERE keyspace = 0 AND isArchived = 0
```
Run `PipelineMonitor.ts --fix` to automatically initialize uninitialized tasks.

### 9. Free Chunks Before Rebooting Stalled Workers
**What happened:** If a worker is rebooted while holding a dispatched chunk, that chunk stays stuck.
**Root cause:** No cleanup process for worker restarts.
**Prevention:** Before rebooting a stalled worker:
```sql
UPDATE Chunk SET state=6, agentId=NULL WHERE agentId=<stalled_agent_id> AND state=2
```
This releases the chunk for another worker to pick up.

### 10. Agent-to-Instance Mapping Confusion (CRITICAL)
**What happened:** Confused agent IDs with EC2 instance IDs, rebooted wrong instance for 15+ minutes.
**Root cause:** No reliable mapping between Hashtopolis agents and AWS instances. Ad-hoc queries prone to error.
**Impact:** Agent 6's instance was stop/started while agent 2 remained broken. Wasted significant time.
**Prevention:** Created AgentManager.ts which:
1. Queries agent's lastIp from Hashtopolis DB
2. Queries AWS for instances by private IP
3. Creates deterministic agent→instance mapping
4. Use `bun AgentManager.ts` before any remediation action

### 11. Slow Response to Agent Issues
**What happened:** Agent 1 was idle for 55 minutes before detection. Agent 6 stale for 4+ minutes.
**Root cause:** Monitoring was reactive, not proactive. Checked status only when asked.
**Impact:** GPU VMs sitting idle = wasted money.
**Prevention:** AgentManager.ts --watch mode checks every 60 seconds and auto-remediates critical agents (>5 min stale).

### 12. Stuck Chunk Progress (crackPos NULL Bug)
**What happened:** Agent 2's chunk showed 20.44% for 50+ minutes despite agent "sending progress".
**Root cause:** crackPos NULL bug in Hashtopolis - progress can't be saved.
**Prevention:** Check chunk progress is ADVANCING over 30 second window, not just that agent is active.
```sql
-- Run twice, 30s apart. Same progress = stuck.
SELECT chunkId, progress FROM Chunk WHERE state=2
```

### 13. Aborting Chunks Can Crash the Agent
**What happened:** After aborting chunk 634, agent 4 stopped responding and went stale.
**Root cause:** The hashcat process on the worker may crash when its chunk is forcibly aborted.
**Impact:** Agent becomes stale and needs reboot.
**Improved stuck chunk resolution process:**
```sql
-- Step 1: Abort the chunk
UPDATE Chunk SET state=6, agentId=NULL WHERE chunkId=X;
-- Step 2: Reset to NEW state
UPDATE Chunk SET state=0, progress=0 WHERE chunkId=X;
-- Step 3: EXPECT agent crash - monitor for 30s, reboot if stale
```
The agent that had the stuck chunk should be monitored and rebooted if it goes stale after the abort.

### 14. Submitting New Batches Without Verifying Previous Ones (CRITICAL)
**What happened:** Submitted batches 38-50 while batches 38-44 had keyspace=0 and were never being worked.
**Root cause:** Focused on submitting more work instead of monitoring existing work.
**Impact:** 40+ tasks sat with keyspace=0, then got incorrectly archived as "complete."
**Prevention:** After submitting batches, ALWAYS verify:
1. `keyspace > 0` on newly submitted tasks
2. Chunks are being created
3. Agents are picking up work
```sql
-- Run after every batch submission
SELECT taskId, taskName, keyspace,
  (SELECT COUNT(*) FROM Chunk c WHERE c.taskId=t.taskId) as chunks
FROM Task t WHERE t.taskName LIKE '%batch-00XX%' AND t.isArchived=0;
```
Do NOT submit more batches until previous submissions are confirmed working.

### 15. Archiving Tasks with keyspace=0 (CRITICAL)
**What happened:** Archived batches 38, 39, 42-44 because they had "no active chunks."
**Root cause:** Archive logic checked for active chunks but not whether task was ever initialized.
**Impact:** Tasks archived at 0% - same as batch-0001 error. Wasted time re-discovering.
**Prevention:** NEVER archive a task with keyspace=0. Add to SafeArchiver validation:
```sql
-- Pre-archive check: keyspace MUST be > 0
SELECT taskId, taskName, keyspace FROM Task
WHERE taskName LIKE '%batch-00XX%' AND keyspace=0 AND isArchived=0;
-- If any results: DO NOT ARCHIVE - task was never worked
```
A task with keyspace=0 has no chunks, no work done, nothing to archive.

### 16. Manually Setting keyspace is an ANTIPATTERN (CRITICAL)
**What happened:** Tried to "fix" keyspace=0 tasks by manually setting keyspace=14344384.
**Root cause:** Misunderstanding of Hashtopolis benchmark process.
**Impact:** 120+ tasks appeared ready but had no chunks, no work done, then got archived.
**Why it's wrong:**
1. Tasks are created with keyspace=0, useNewBench=1
2. When agent picks up task, it benchmarks → determines keyspace → creates chunks
3. Manually setting keyspace BYPASSES the benchmark, so NO CHUNKS are created
4. Task looks ready (keyspace>0) but can't run (no chunks)
5. Archive check passes (keyspace>0) but no work was done (keyspaceProgress=0)

**Prevention:** NEVER manually set keyspace. Let Hashtopolis benchmark process run:
```sql
-- WRONG: Manual keyspace fix (ANTIPATTERN!)
UPDATE Task SET keyspace=14344384 WHERE keyspace=0;

-- RIGHT: Let agents benchmark naturally
-- Just ensure useNewBench=1 and wait for agents to pick up tasks
SELECT taskId, taskName, useNewBench FROM Task WHERE keyspace=0 AND useNewBench=0;
-- If useNewBench=0, set it to 1 to trigger benchmark on next pickup
UPDATE Task SET useNewBench=1 WHERE keyspace=0 AND useNewBench=0;
```

### 17. Benchmark Format Mismatch Prevents Task Initialization (CRITICAL)
**What happened:** 97 tasks stuck at keyspace=0 despite useNewBench=1 being set.
**Root cause:** Agent benchmarks use OLD format (time:speed like "84480:6512.17") but tasks had useNewBench=1 (NEW format).
**Technical detail:** Hashtopolis benchmark formats:
- OLD format: "time:speed" (e.g., "84480:6512.17") → useNewBench=0
- NEW format: just speed number → useNewBench=1
**Impact:** Tasks never get benchmarked, keyspace stays 0, no chunks created, no work done.
**Prevention:** CrackSubmitter.ts GATE E checks existing benchmarks and sets useNewBench accordingly:
```sql
-- Check benchmark format before creating tasks
SELECT benchmark FROM Assignment LIMIT 1;
-- If contains ":", use useNewBench=0 (OLD format)
-- Otherwise use useNewBench=1 (NEW format)
```
**Fix for existing tasks:**
```sql
UPDATE Task SET useNewBench=0 WHERE isArchived=0 AND keyspace=0;
```

### 18. Archive Validation Must Check keyspaceProgress > 0 (CRITICAL)
**What happened:** After manually setting keyspace, archive check (keyspace>0) passed but tasks were never worked.
**Root cause:** Archive only checked keyspace>0, not keyspaceProgress>0 or chunks exist.
**Impact:** 120+ tasks archived with 0% progress.
**Prevention:** Archive validation must check ALL:
1. keyspace > 0 (task was initialized)
2. keyspaceProgress > 0 (work was actually done)
3. finishedChunks > 0 (chunks completed)
```sql
-- Correct pre-archive validation
SELECT taskId, taskName FROM Task t WHERE t.isArchived=0
AND (t.keyspace = 0 OR t.keyspaceProgress = 0
     OR NOT EXISTS(SELECT 1 FROM Chunk c WHERE c.taskId=t.taskId AND c.state=4));
-- If any results: DO NOT ARCHIVE
```

### 18. Server IP Changes on Stop/Start (CRITICAL)
**What happened:** Stopped/started server to fix unresponsive state; workers couldn't connect to new IP.
**Root cause:** EC2 public IP changes on stop/start. Workers use private IP (10.0.x.x) within VPC.
**Impact:** Initial panic that workers lost connectivity (actually fine since they use private IP).
**Key insight:** Workers connect via PRIVATE IP which is stable. Only management SSH uses public IP.
**Prevention:**
1. Consider Elastic IP for server to prevent management IP changes
2. Update terraform to output new IP when server restarts
3. When public IP changes, update local tools/scripts
```bash
# Get new server IP after restart
aws ec2 describe-instances --instance-ids i-0eaf169037648f0ed --region us-west-2 \
  --query "Reservations[*].Instances[*].PublicIpAddress" --output text
```

### 19. Server Health Monitoring Required (CRITICAL)
**What happened:** Server became unresponsive (SSH and HTTP timeout) without warning.
**Root cause:** MEMORY EXHAUSTION - hashtopolis-backend uses 2.91GB (77%), total 92% RAM.
**Technical detail:** Apache spawns ~9 workers at ~255MB each. On t3.medium (4GB), this leaves <400MB free.
**Symptom pattern:** TCP connections ESTABLISH but applications don't respond (memory pressure causes hangs).
**Impact:** Workers continued running but couldn't report progress; wasted GPU time.
**Resolution:** UPGRADED server from t3.medium (4GB) to t3.large (8GB). Cost: ~$50/month more.
**Prevention:** Add server health monitoring to pipeline:
1. Check disk space before and during operations: `df -h /`
2. Check memory: `free -h`
3. Check Docker health: `sudo docker ps`
4. Monitor server uptime: `uptime`
5. Set alerts for >80% disk usage

**Health check command:**
```bash
ssh ubuntu@SERVER "df -h / && free -h | head -2 && sudo docker ps --format 'table {{.Names}}\t{{.Status}}'"
```

### 20. Investigate Before Rebooting
**What happened:** Server unresponsive → immediately rebooted → lost diagnostic info.
**Root cause:** Reactive troubleshooting instead of investigation.
**Impact:** Couldn't determine root cause of failure; may recur.
**Prevention:** Before rebooting unresponsive server:
1. Try EC2 Serial Console if SSH fails
2. Check CloudWatch metrics (CPU, memory, disk)
3. Check EC2 instance status checks
4. If possible, check `/var/log/` for errors
5. Document findings before remediation

---

## Server Health Checklist

Run before starting GPU workers:
```bash
# 1. Verify server is healthy
ssh ubuntu@SERVER "
  echo '=== Disk ===' && df -h / | tail -1 &&
  echo '=== Memory ===' && free -h | grep Mem &&
  echo '=== Docker ===' && sudo docker ps --format 'table {{.Names}}\t{{.Status}}' &&
  echo '=== Uptime ===' && uptime
"

# 2. Verify workers can reach server (via private IP)
# Workers use 10.0.x.x which is stable within VPC
```

Run during operations (every 30 minutes):
```bash
# Check disk isn't filling up
ssh ubuntu@SERVER "df -h / | awk 'NR==2 {print \$5}'"
# If >80%, investigate and potentially archive completed tasks
```

---

## Outstanding Issues to Resolve

### batch-0001: Archived at 0%
- **Status:** RESOLVED
- **Resolution:** Re-submitted as tasks 186-193, completed with ~148K cracks

### Task 173 (batch-0019-part4): Stuck at 51.9%
- **Status:** RESOLVED
- **Resolution:** Recreated as Task 194, completed successfully

---

## Key Principles

1. **Investigate before acting** - Understand WHY before fixing
2. **Validate before archiving** - Use SafeArchiver.ts, never manual
3. **Check progress, not just activity** - Agents checking in != work being done
4. **Cross-validate results** - Crack counts should be similar within batch
5. **Document issues immediately** - Add to TROUBLESHOOTING.md Outstanding Issues
6. **Use tools, not manual SQL** - Tools have validation built in

---

## SQL Quick Reference (When Tools Insufficient)

### Check chunk states
```sql
SELECT taskId, state, COUNT(*) as cnt FROM Chunk
WHERE taskId IN (SELECT taskId FROM Task WHERE taskName LIKE '%batch-00XX%')
GROUP BY taskId, state;
```

### Check chunk progress (run twice, 30s apart)
```sql
SELECT chunkId, taskId, progress,
  (UNIX_TIMESTAMP() - dispatchTime) as secSinceDispatch
FROM Chunk WHERE state=2;
```

### Validate before archive
```sql
SELECT t.taskId, t.taskName, t.keyspace, t.keyspaceProgress,
  (SELECT COUNT(*) FROM Chunk c WHERE c.taskId=t.taskId AND c.state IN (0,2)) as active,
  (SELECT COUNT(*) FROM Chunk c WHERE c.taskId=t.taskId AND c.state=6) as aborted,
  (SELECT COUNT(*) FROM Chunk c WHERE c.taskId=t.taskId AND c.state=4) as finished
FROM Task t WHERE t.taskName LIKE '%batch-00XX%' AND t.isArchived=0;
```

### Crack count consistency
```sql
SELECT t.taskName, tw.cracked FROM Task t
JOIN TaskWrapper tw ON t.taskWrapperId=tw.taskWrapperId
WHERE t.taskName LIKE '%batch-00XX%'
ORDER BY t.taskName;
```
