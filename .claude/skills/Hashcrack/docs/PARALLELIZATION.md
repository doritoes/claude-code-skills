# Parallelization Guide: Leveraging Hashtopolis for Massive Scale

**PURPOSE:** Understand how to scale to 10, 50, 100+ workers and MAXIMIZE parallel cracking.

---

## ⛔ CRITICAL: Attack Type Determines Parallelization

| Attack Type | Workers Active | Why | Strategy |
|-------------|----------------|-----|----------|
| **Straight** (wordlist only) | ALL workers | Chunks divide wordlist | Use for max parallelism |
| **Mask** (brute force) | ALL workers | Chunks divide keyspace | Use for max parallelism |
| **Rule** (wordlist + rules) | **1 worker** | hashcat -s skips WORDS not keyspace | Split HASHES, not wordlists |
| **Combinator** | ALL workers | Chunks work | Use for max parallelism |

**ROOT CAUSE of Rule Attack Limitation:**
```
Hashtopolis creates chunks with skip values: chunk 0 (skip=0), chunk 1 (skip=6B), etc.
hashcat's -s parameter skips WORDLIST ENTRIES, not keyspace positions.
For rule attacks: skip=6B means "skip 6 billion words" but wordlist only has 14M words.
Result: Only chunk 0 (skip=0) works. All other chunks fail immediately.
```

---

## Strategy Selection Matrix

### When You Want SPEED (max parallelization):

| Scenario | Strategy |
|----------|----------|
| Simple wordlist | Straight attack, 1 task, ALL workers |
| Need rules | Split HASHES into N hashlists, N tasks, N workers |
| Brute force | Mask attack, 1 task, ALL workers |

### When You Want COVERAGE (thorough):

| Scenario | Strategy |
|----------|----------|
| RockYou + Rules | Accept sequential, monitor progress, let Hashtopolis manage |
| Multiple wordlists | Create task per wordlist, all parallel |
| Mixed attacks | Queue in priority order |

---

## Parallel Rule Attacks: Split HASHES

**Problem:** 10 workers, rule attack, but only 1 worker active.

**Solution:** Split the HASHLIST into multiple hashlists, each with its own task.

```sql
-- Instead of: 1 hashlist with 5000 hashes, 1 task
-- Do this: 10 hashlists with 500 hashes each, 10 tasks

-- Step 1: Create multiple hashlists
INSERT INTO Hashlist (hashlistName, format, hashTypeId, hashCount, isSecret, accessGroupId)
VALUES
  ('chunk-1', 0, 1400, 500, 0, 1),
  ('chunk-2', 0, 1400, 500, 0, 1),
  ...
  ('chunk-10', 0, 1400, 500, 0, 1);

-- Step 2: Distribute hashes across hashlists (round-robin)
-- Step 3: Create identical tasks for each hashlist
-- Step 4: Each worker picks a different task = parallel rule attacks!
```

**Result:** 10 workers, each attacking different hashes with same rules = 10x throughput.

---

## Straight Attack Parallelization (Default)

**This is what Hashtopolis does best.** No special configuration needed.

```
Workers: 10
Wordlist: rockyou.txt (14M words)
Chunks: ~14 (1M words each)
Result: All 10 workers active, cracking different wordlist chunks
```

**Requirements:**
- `useNewBench` set correctly (0 for OLD format, 1 for NEW)
- `ignoreErrors=1` NOT needed (straight attacks don't fail on skip)
- Workers trusted and active

---

## Scaling Decision Tree

```
START: User wants to crack hashes
       |
       +-- How many hashes?
           |
           +-- < 100: Single hashlist, single task
           |
           +-- 100-10000: Consider splitting for rule attacks
           |
           +-- > 10000: DEFINITELY split for parallel rule attacks
       |
       +-- What attack type?
           |
           +-- Straight/Mask: Single task, all workers parallel (DEFAULT)
           |
           +-- Rules:
               |
               +-- Need speed? Split hashes into N hashlists
               |
               +-- Need simplicity? Accept sequential, 1 worker at a time
```

---

## Worker Scaling Guide

| Workers | Best For | Notes |
|---------|----------|-------|
| 1-4 | Development, testing | Minimal cost |
| 5-10 | Standard engagements | Good parallelism for straight attacks |
| 10-20 | Large hash sets | Split hashes for rule attacks |
| 20-50 | Enterprise audits | Significant cost, plan carefully |
| 50-100+ | Time-critical engagements | Maximum parallel, split hashes mandatory |

---

## Monitoring Parallelization

**Check how many workers are ACTUALLY working:**

```sql
-- Active chunks (workers currently cracking)
SELECT COUNT(DISTINCT agentId) as active_workers
FROM Chunk WHERE state = 2;  -- 2 = DISPATCHED

-- If active_workers < total_workers for rule attack:
-- This is EXPECTED behavior. Workers queue for chunk 0.
```

**Check task dispatch rate:**

```sql
-- Tasks with agents assigned
SELECT t.taskId, t.taskName, COUNT(a.agentId) as assigned_agents
FROM Task t
JOIN Assignment a ON t.taskId = a.taskId
GROUP BY t.taskId;
```

---

## Anti-Patterns

| Anti-Pattern | Why It Fails | Correct Approach |
|--------------|--------------|------------------|
| Split WORDLIST for rule attacks | Doesn't adapt when workers scale | Split HASHES instead |
| Expect 10 workers on 1 rule task | hashcat -s doesn't work for rules | Accept 1 worker OR split hashes |
| maxAgents=0 with split hash tasks | All agents go to task 1 | **Use maxAgents=1 for parallel rule attacks** |
| Create 1 task per worker | Over-engineering for straight attacks | Create 1 task for straight, N tasks for rules |

### CRITICAL: maxAgents Setting for Attack Types

| Attack Type | maxAgents Setting | Why |
|-------------|-------------------|-----|
| Straight (wordlist only) | `0` (unlimited) | Chunks distribute work automatically |
| Mask (brute force) | `0` (unlimited) | Chunks distribute work automatically |
| **Rule (parallel hash split)** | `1` per task | **Forces agents to different tasks** |

**For parallel rule attacks:** Setting `maxAgents=1` on each task ensures agents distribute across tasks instead of all piling onto task 1.

---

## Quick Reference Commands

**Check worker utilization:**
```bash
ssh ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -e \"
SELECT
  (SELECT COUNT(*) FROM Agent WHERE isActive=1) as total_workers,
  (SELECT COUNT(DISTINCT agentId) FROM Chunk WHERE state=2) as active_workers,
  (SELECT COUNT(*) FROM Chunk WHERE state=0) as pending_chunks;
\""
```

**Split hashes for parallel rule attacks:**
```bash
# Split 5000 hashes into 10 files of 500 each
split -l 500 hashes.txt hash_chunk_
# Then create separate hashlists and tasks for each
```

---

## The Power of Hashtopolis

**Let Hashtopolis do its job:**
- Chunks wordlists automatically
- Distributes work to available workers
- Handles worker failures gracefully
- Tracks progress and cracked passwords

**Don't micromanage (for STRAIGHT/MASK attacks):**
- Don't set maxAgents artificially low for straight/mask attacks
- Don't create manual assignments
- Don't split wordlists (split HASHES instead for rule attacks)
- Don't bypass the portal with hidden tasks

**DO micromanage (for RULE attacks with split hashes):**
- Set `maxAgents=1` per task to force agent distribution
- Split hashes into N hashlists with N tasks
- Result: N workers running parallel rule attacks on different hash subsets

**The user (pen tester) MUST see:**
- All tasks in the Tasks view
- Worker status in Agents view
- Progress in real-time
- Cracked passwords in Hashes view
