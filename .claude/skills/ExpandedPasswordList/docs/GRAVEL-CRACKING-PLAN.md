# GRAVEL → PEARLS + SAND Cracking Plan

## Objective
Crack 1B+ GRAVEL hashes (HIBP minus rockyou matches) using rockyou+OneRuleToRuleThemStill, producing PEARLS (cracked passwords) and SAND (uncracked hard hashes).

## Lessons Learned

| Issue | Root Cause | Prevention |
|-------|-----------|------------|
| Files not downloading | Directory empty after docker cp | GATE: Verify files exist BEFORE task creation |
| Wrong attack command | `-r rule wordlist` instead of `wordlist -r rule` | Fixed in DEFAULT_ATTACK_CMD |
| priority=0 | Database insert didn't set properly | Ensure priority≥10 in INSERT |
| useNewBench wrong | Didn't check benchmark format | Auto-detect from Assignment table |
| keyspace=1 | Agents couldn't measure due to missing files | Stage files first, test download |
| Agents stuck | Direct DB manipulation caused state issues | Follow Hashcrack skill gates exactly |
| **ENOMEM in filter** | completedPrefixes array grew to 1M strings (5MB+), O(n) includes checks, large countsBuffer (5MB) | Use 128KB bitmap file, reduce buffers, periodic state saves |

---

## Pre-Flight Checklist (MANDATORY)

Before ANY crack submission:

### GATE A: Infrastructure Ready
```bash
# Server accessible
ssh ubuntu@$SERVER_IP "echo OK"

# Docker running
ssh ubuntu@$SERVER_IP "sudo docker ps | grep hashtopolis"
```

### GATE B: Files Staged Correctly
```bash
# Files in correct location (NOT /var/www/... - WRONG PATH!)
ssh ubuntu@$SERVER_IP "sudo docker exec hashtopolis-backend ls -la /usr/local/share/hashtopolis/files/"
# Expected: rockyou.txt (139MB), OneRuleToRuleThemStill.rule (403KB)

# File download test
TOKEN=$(ssh ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -sNe 'SELECT token FROM Agent LIMIT 1;'")
ssh ubuntu@$SERVER_IP "curl -s -o /tmp/test.txt 'http://localhost:8080/getFile.php?file=1&token=$TOKEN' && ls -la /tmp/test.txt"
# Expected: 139MB file (rockyou.txt)
```

### GATE C: Agents Ready
```bash
# All agents registered, trusted, active
ssh ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -e 'SELECT COUNT(*) as ready FROM Agent WHERE isActive=1 AND isTrusted=1;'"
# Expected: equals worker count

# Files marked isSecret=1
ssh ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -e 'SELECT fileId, isSecret FROM File;'"
# Expected: isSecret=1 for both files
```

---

## Execution Steps

### Step 1: Deploy Infrastructure
```bash
cd .claude/skills/Hashcrack/terraform/aws
terraform apply -var="gpu_worker_count=8" -auto-approve
```

### Step 2: Wait for Boot + Registration
```bash
# Wait for all agents
while [ $(ssh ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -sNe 'SELECT COUNT(*) FROM Agent WHERE isActive=1;'") -lt 8 ]; do
  echo "Waiting for agents..."
  sleep 30
done
echo "All agents registered"
```

### Step 3: Trust Agents + Configure
```bash
ssh ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -e \"
UPDATE Agent SET isTrusted=1, cmdPars='--force', ignoreErrors=1 WHERE isTrusted=0;
UPDATE File SET isSecret=1;
\""
```

### Step 4: Stage Files (if not already)
```bash
# Upload to server
scp rockyou.txt ubuntu@$SERVER_IP:/tmp/
scp OneRuleToRuleThemStill.rule ubuntu@$SERVER_IP:/tmp/

# Copy into container
ssh ubuntu@$SERVER_IP "sudo docker cp /tmp/rockyou.txt hashtopolis-backend:/usr/local/share/hashtopolis/files/rockyou.txt"
ssh ubuntu@$SERVER_IP "sudo docker cp /tmp/OneRuleToRuleThemStill.rule hashtopolis-backend:/usr/local/share/hashtopolis/files/OneRuleToRuleThemStill.rule"

# Fix ownership
ssh ubuntu@$SERVER_IP "sudo docker exec --user root hashtopolis-backend chown www-data:www-data /usr/local/share/hashtopolis/files/rockyou.txt /usr/local/share/hashtopolis/files/OneRuleToRuleThemStill.rule"

# Verify
ssh ubuntu@$SERVER_IP "sudo docker exec hashtopolis-backend ls -la /usr/local/share/hashtopolis/files/"
```

### Step 5: Run Pre-Flight Gates
Run ALL gates from the checklist above. **DO NOT PROCEED if any gate fails.**

### Step 6: Submit Batch
```bash
cd .claude/skills/ExpandedPasswordList
bun Tools/CrackSubmitter.ts --batch 1 --workers 8
```

### Step 7: Monitor Progress
```bash
# Check task progress
bun Tools/ProgressTracker.ts

# Or via database
ssh ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -e 'SELECT taskId, keyspace, keyspaceProgress, ROUND(keyspaceProgress/keyspace*100,2) as pct FROM Task WHERE isArchived=0;'"
```

### Step 8: Collect Results
```bash
bun Tools/ResultCollector.ts --all
```

---

## Batch Queue Strategy

### Queue Ahead Pattern
While batch N is cracking:
1. Prepare batch N+1 hashlists via API (fast)
2. Don't create tasks yet (agents might steal them)
3. When batch N completes → create tasks for N+1

### Batch Size Optimization
- 1M hashes per batch file
- Split into 8 hashlists (125K each for 8 workers)
- Rule attack keyspace: 125K × 14.3M × 52K = ~93 trillion per hashlist
- At ~14 GH/s per worker: ~1,850 hours per hashlist (!)

**CRITICAL: Rule attacks are SLOW.** Consider:
1. Use smaller rule set (best64.rule = 77 rules vs 52K)
2. Use straight attack first (just rockyou, no rules)
3. Accept lower coverage for faster turnaround

### Recommended Strategy
```
PHASE 1: Straight attack (rockyou only) - FAST
  - Keyspace: 14.3M passwords
  - Time: ~1 second per worker
  - Expected crack rate: ~5-10%

PHASE 2: Rule attack (rockyou + best64) - MEDIUM
  - Keyspace: 14.3M × 77 = 1.1B
  - Time: ~80 seconds per worker
  - Expected additional crack rate: ~5-10%

PHASE 3: Rule attack (rockyou + OneRule) - SLOW (optional)
  - Keyspace: 14.3M × 52K = 745B
  - Time: ~15 hours per worker
  - Expected additional crack rate: ~1-5%
```

---

## Files Changed

| File | Change |
|------|--------|
| `Tools/CrackSubmitter.ts` | Fixed attack command order, added database task creation |
| `docs/GRAVEL-CRACKING-PLAN.md` | This document |

## Memory-Efficient Filter

The filter step (`GravelFilter.ts --batched`) uses these memory optimizations:

| Optimization | Before | After |
|--------------|--------|-------|
| Progress tracking | 5MB+ string array | 128KB bitmap file |
| Completed prefix lookup | O(n) array.includes | O(1) bitmap lookup |
| Counts buffer | 100K strings (~5MB) | 10K strings (~500KB) |
| Candidate batch | 1M hashes (~40MB) | 500K hashes (~20MB) |
| State saves | Per-prefix (JSON stringify 1M array) | Every 30 seconds |

**Options to reduce memory further:**
- `--no-counts` - Skip counts-index.txt (saves ~500KB buffer)
- `--batch-size 250000` - Smaller output batches

---

## Next Steps

1. Update CrackSubmitter with full pre-flight gates
2. Add straight attack as Phase 1 (fast initial crack)
3. Add batch queue management
4. Test with small sample before full 1B hashes
