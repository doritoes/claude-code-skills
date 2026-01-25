# Crack Workflow

Submit password hashes for distributed cracking.

---

## ⛔ CRITICAL: RULE ATTACK PARALLELIZATION

**Before creating ANY task, understand this:**

| Attack Type | Workers Active | Explanation |
|-------------|----------------|-------------|
| **Straight** (wordlist only) | ALL workers | Hashtopolis chunks wordlist, distributes to workers |
| **Mask** (brute force) | ALL workers | Hashtopolis chunks keyspace, distributes to workers |
| **Rule** (wordlist + rules) | **1 worker only** | hashcat `-s` skip doesn't work for rules |

**If you need parallel rule attacks:** Split HASHES into multiple hashlists, create separate tasks. See below.

**If you accept sequential processing:** Create single task, 1 worker will process entire keyspace while others wait.

---

## ⛔ PARALLEL RULE ATTACK PROCEDURE (USE THIS FOR 4+ WORKERS)

**Split hashes into N hashlists where N = worker count:**

### Local: Split Hash File
```bash
# For 4 workers, split 5000 hashes into 4 files of 1250 each
WORKER_COUNT=4
HASH_FILE="sample/sha256.txt"
TOTAL=$(wc -l < "$HASH_FILE")
PER_WORKER=$((TOTAL / WORKER_COUNT))

split -l $PER_WORKER -d --additional-suffix=.txt "$HASH_FILE" hash_chunk_
# Creates: hash_chunk_00.txt, hash_chunk_01.txt, hash_chunk_02.txt, hash_chunk_03.txt
```

### Server: Create N Hashlists
```bash
for i in $(seq 0 $((WORKER_COUNT-1))); do
  ssh ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -e \"
  INSERT INTO Hashlist (hashlistName, format, hashTypeId, hashCount, isArchived, isSecret, accessGroupId, hexSalt, isSalted, notes, brainId, brainFeatures)
  VALUES ('chunk-$i', 0, 1400, $PER_WORKER, 0, 0, 1, 0, 0, '', 0, 0);
  \""
done
```

### Server: Import Hashes to Each Hashlist
```bash
for i in $(seq 0 $((WORKER_COUNT-1))); do
  HASHLIST_ID=$((i+1))  # Adjust based on actual IDs
  # Create import SQL and execute for each chunk
done
```

### Server: Create N Tasks (One Per Hashlist) with maxAgents=1
```bash
# CRITICAL: Set maxAgents=1 to force agent distribution across tasks
for i in $(seq 0 $((WORKER_COUNT-1))); do
  HASHLIST_ID=$((i+1))
  WRAPPER_ID=$((i+1))
  # Create TaskWrapper with maxAgents=0 (will be overridden at Task level)
  ssh ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -e \"
  INSERT INTO TaskWrapper (priority, taskType, hashlistId, accessGroupId, taskWrapperName, isArchived, cracked, maxAgents)
  VALUES (10, 0, $HASHLIST_ID, 1, 'Parallel-Rule-$i', 0, 0, 0);
  \""

  # Create Task with maxAgents=1 (forces one agent per task)
  ssh ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -e \"
  INSERT INTO Task (taskName, attackCmd, chunkTime, statusTimer, keyspace, keyspaceProgress, priority, maxAgents, color, isSmall, isCpuTask, useNewBench, skipKeyspace, crackerBinaryId, crackerBinaryTypeId, taskWrapperId, isArchived, notes, staticChunks, chunkSize, forcePipe, usePreprocessor, preprocessorCommand)
  VALUES ('RockYou-OneRule-$i', '#HL# rockyou.txt -r OneRuleToRuleThemStill.rule --force', 600, 5, $KEYSPACE, 0, 10, 1, NULL, 0, 1, 0, 0, 1, 1, $WRAPPER_ID, 0, '', 0, 0, 0, 0, '');
  \""

  # Link files
  ssh ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -e \"
  INSERT INTO FileTask (fileId, taskId) SELECT fileId, $((i+1)) FROM File WHERE filename IN ('rockyou.txt', 'OneRuleToRuleThemStill.rule');
  \""
done
```

**CRITICAL: maxAgents=1** - Without this, all agents go to Task 1 (same priority = same task).

**Result:** 4 workers, 4 tasks, 4 hashlists, maxAgents=1 = **4x parallel throughput** for rule attacks.

### Alternative: In-Database Hash Redistribution (Faster)

If hashes are already imported into a single hashlist, redistribute in-place:

```sql
-- Create N hashlists for N workers
INSERT INTO Hashlist (hashlistName, format, hashTypeId, hashCount, isArchived, isSecret, accessGroupId, hexSalt, isSalted, notes, brainId, brainFeatures)
VALUES
  ('Split-1', 0, 1400, 0, 0, 0, 1, 0, 0, 'Split 1/4', 0, 0),
  ('Split-2', 0, 1400, 0, 0, 0, 1, 0, 0, 'Split 2/4', 0, 0),
  ('Split-3', 0, 1400, 0, 0, 0, 1, 0, 0, 'Split 3/4', 0, 0),
  ('Split-4', 0, 1400, 0, 0, 0, 1, 0, 0, 'Split 4/4', 0, 0);

-- Redistribute hashes by hashId range (5000 hashes / 4 = 1250 each)
UPDATE Hash SET hashlistId=2 WHERE hashId <= 1250;
UPDATE Hash SET hashlistId=3 WHERE hashId > 1250 AND hashId <= 2500;
UPDATE Hash SET hashlistId=4 WHERE hashId > 2500 AND hashId <= 3750;
UPDATE Hash SET hashlistId=5 WHERE hashId > 3750;

-- Update counts
UPDATE Hashlist h SET hashCount=(SELECT COUNT(*) FROM Hash WHERE hashlistId=h.hashlistId) WHERE hashlistId IN (2,3,4,5);

-- Archive original hashlist
UPDATE Hashlist SET isArchived=1 WHERE hashlistId=1;
```

**Then create TaskWrapper + Task for EACH new hashlist** (one TaskWrapper per hashlist, one Task per TaskWrapper, maxAgents=1).

---

## ⛔ WORKER SIZING GUIDE (READ BEFORE DEPLOYING)

**Use this to predict worker counts BEFORE terraform apply.**

### Quick Decision Matrix

| Hash Type | Hash Count | Attack Type | Workers | Instance | Expected Time |
|-----------|------------|-------------|---------|----------|---------------|
| Fast (MD5/SHA1/NTLM) | <100 | Straight | 2 CPU | c5.xlarge | <5 min |
| Fast (MD5/SHA1/NTLM) | 100-1K | Straight | 2-4 CPU | c5.xlarge | 5-30 min |
| Fast (MD5/SHA1/NTLM) | 1K-10K | Straight | 4-8 CPU | c5.xlarge | 30-120 min |
| Medium (SHA256) | Any | Straight | 2-4x above | c5.xlarge | 2-4x above |
| Slow (bcrypt/sha512crypt) | Any | Any | GPU REQUIRED | g4dn.xlarge | See GPU section |
| Any | Any | Rule | Split hashes | N workers | N hashlists |

### Hash Speed Tiers (CPU c5.xlarge)

| Tier | Hash Types | Speed | Full rockyou (14M) | CPU Viable? |
|------|------------|-------|-------------------|-------------|
| **FAST** | MD5, SHA1, NTLM | 3-4 MH/s | ~4 seconds/worker | ✅ Yes |
| **MEDIUM** | SHA256, SHA512 | 0.8-1.2 MH/s | ~12-18 seconds/worker | ✅ Yes (2-4x slower) |
| **SLOW** | bcrypt, sha512crypt | 200-500 H/s | 8-20 HOURS/worker | ❌ GPU required |

### Worker Count Formula (Straight/Mask Attacks)

```
Workers = CEIL(Keyspace / (Speed × Target_Seconds))

Example: MD5, rockyou (14.3M), 30-minute target:
  Workers = CEIL(14,344,391 / (3,800,000 × 1800))
  Workers = CEIL(14,344,391 / 6,840,000,000)
  Workers = 1 (single worker sufficient)
```

**Minimum recommendations:**
- Development/testing: 2 workers (validate parallel distribution)
- Production <1K hashes: 2 workers
- Production 1K-10K hashes: 4 workers
- Production >10K hashes: 8+ workers

### Rule Attack Sizing (CRITICAL - DIFFERENT FORMULA)

**Rule attacks use only 1 worker** (hashcat -s skip doesn't work for rules). To parallelize:

```
Workers = N where N = number of hash chunks
Strategy: Split HASHES into N hashlists, create N tasks with maxAgents=1
```

**Rule keyspace is MASSIVE:**
```
rockyou (14.3M) × best64 (77 rules) = 1.1 BILLION
rockyou (14.3M) × OneRuleToRuleThemStill (48K rules) = 695 BILLION
```

**Time estimate (single worker MD5 on c5.xlarge):**
```
695B keyspace / 3.8M speed = 183,000,000 seconds = 5,800 YEARS
```

**Solution:** Use smaller wordlists (top 10K) or split hashes for parallel processing.

### Chunk Time Optimization

| Scenario | chunkTime | Rationale |
|----------|-----------|-----------|
| Fast hashes (MD5/NTLM) | 1200 (20 min) | Reduce coordination overhead |
| Medium hashes (SHA256) | 900 (15 min) | Balance overhead and visibility |
| Slow hashes (bcrypt) | 600 (10 min) | More frequent progress updates |
| Testing/validation | 300 (5 min) | Quick feedback |

**Observed:** 6-second chunks have ~30% overhead. 20-minute chunks reduce overhead to <1%.

### Cost Estimation (AWS Spot)

| Configuration | Hourly Cost | 1-hour job |
|---------------|-------------|------------|
| Server (t3.medium) | $0.02 | $0.02 |
| 2 CPU workers (c5.xlarge) | $0.16 | $0.16 |
| 4 CPU workers (c5.xlarge) | $0.32 | $0.32 |
| 2 GPU workers (g4dn.xlarge) | $0.50 | $0.50 |

**See also:** `docs/RESOURCE_SIZING.md` for detailed formulas and examples.

---

## Trigger

- "crack hashes"
- "submit job"
- "crack these passwords"

## Prerequisites

1. **Hashtopolis deployed** (run Deploy workflow first)
2. **API key configured** in `.claude/.env`
3. **Hash file** or hashes to paste

---

## PRE-FLIGHT CHECKLIST (MANDATORY)

**CRITICAL:** Execute EVERY step below BEFORE submitting crack jobs. Do NOT skip or summarize.

### Step A: Verify Database Connection

```bash
# Get server IP and DB password from terraform
SERVER_IP=$(terraform output -raw server_ip)
DB_PASS=$(terraform output -raw db_password)

# Test database connectivity
ssh ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -e 'SELECT 1;'"
```
**Expected:** Returns `1`

### Step B: Verify Vouchers Exist (One Per Worker)

```bash
ssh ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -sNe 'SELECT COUNT(*) FROM RegVoucher;'"
```
**Expected:** Number matches or exceeds `worker_count` from terraform.tfvars

### Step C: Verify All Agents Registered

```bash
ssh ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -sNe 'SELECT agentId, agentName, isActive, isTrusted FROM Agent;'"
```
**Expected:** One row per worker, all `isActive=1`

### Step D: Trust All Agents and Configure for CPU

```bash
ssh ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -e \"
UPDATE Agent SET isTrusted = 1, cpuOnly = 1, cmdPars = '--force', ignoreErrors = 1 WHERE isTrusted = 0;
\""
```
**CRITICAL settings for CPU workers:**
- `cmdPars='--force'` - REQUIRED for PoCL, prevents benchmark exit code 255
- `ignoreErrors=1` - REQUIRED for rule attacks, prevents "Restore value > keyspace" deactivation

**Verify:** Re-run Step C, all `isTrusted=1`, `cpuOnly=1`

### Step E: Stage Files (Wordlists + Rules)

**CRITICAL: Hashtopolis looks for files at `/usr/local/share/hashtopolis/files/` (from StoredValue.directory_files)**

**The Docker volume path `/var/www/hashtopolis/files/` is WRONG and will cause ERR3 "file not present"!**

```bash
# 1. Upload files to server /tmp/
scp rockyou.txt ubuntu@$SERVER_IP:/tmp/
scp OneRuleToRuleThemStill.rule ubuntu@$SERVER_IP:/tmp/

# 2. Copy INTO CONTAINER at the CORRECT path (use docker cp)
ssh ubuntu@$SERVER_IP "sudo docker cp /tmp/rockyou.txt hashtopolis-backend:/usr/local/share/hashtopolis/files/rockyou.txt"
ssh ubuntu@$SERVER_IP "sudo docker cp /tmp/OneRuleToRuleThemStill.rule hashtopolis-backend:/usr/local/share/hashtopolis/files/OneRuleToRuleThemStill.rule"

# 3. Fix ownership (explicit filenames - glob expansion fails in SSH!)
ssh ubuntu@$SERVER_IP "sudo docker exec hashtopolis-backend chown www-data:www-data /usr/local/share/hashtopolis/files/rockyou.txt /usr/local/share/hashtopolis/files/OneRuleToRuleThemStill.rule"

# 4. Verify files are in CORRECT location with correct ownership
ssh ubuntu@$SERVER_IP "sudo docker exec hashtopolis-backend ls -la /usr/local/share/hashtopolis/files/"
```
**Expected:** Both files listed with `www-data www-data` ownership

**VERIFY FILE DOWNLOAD WORKS (MANDATORY GATE):**
```bash
# Get an agent token and test download
TOKEN=$(ssh ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -sNe 'SELECT token FROM Agent LIMIT 1;'")
ssh ubuntu@$SERVER_IP "curl -s -o /tmp/test_download.txt 'http://localhost:8080/getFile.php?file=1&token=$TOKEN' && ls -la /tmp/test_download.txt"
```
**GATE PASS:** File size matches (139MB for rockyou.txt)
**GATE FAIL:** Returns <1KB or "ERR3" = wrong path, files not staged correctly

**ANTI-PATTERNS:**
- Do NOT use glob `*` with chown - shell expansion fails in SSH commands
- Do NOT use `/var/www/hashtopolis/files/` - WRONG PATH, getFile.php won't find files
- Do NOT use `/var/lib/docker/volumes/hashtopolis_files/_data/` - WRONG PATH

### Step F: Register Files in Database with isSecret=1

```bash
ssh ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -e \"
INSERT INTO File (filename, size, isSecret, fileType, accessGroupId, lineCount)
VALUES
  ('rockyou.txt', $(wc -c < rockyou.txt), 1, 0, 1, $(wc -l < rockyou.txt)),
  ('OneRuleToRuleThemStill.rule', $(wc -c < OneRuleToRuleThemStill.rule), 1, 1, 1, $(wc -l < OneRuleToRuleThemStill.rule))
ON DUPLICATE KEY UPDATE isSecret=1;
\""
```
**CRITICAL:** `isSecret=1` is REQUIRED for trusted agents to download files!

### Step G: Verify Files Accessible

```bash
ssh ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -e 'SELECT fileId, filename, isSecret FROM File;'"
```
**Expected:** Both files listed with `isSecret=1`

### Step H: Verify Cracker Binary Exists

```bash
ssh ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -sNe 'SELECT crackerBinaryId, binaryName FROM CrackerBinary LIMIT 1;'"
```
**Expected:** Returns `1  hashcat` or similar. **Save the crackerBinaryId for task creation.**

### Step I: Create Hashlist via Database

**CRITICAL:** Include ALL required fields (no defaults in schema):

```bash
# Create hashlist - ALL REQUIRED FIELDS
ssh ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -e \"
INSERT INTO Hashlist (hashlistName, format, hashTypeId, hashCount, cracked, isArchived, isSecret, accessGroupId, hexSalt, isSalted, notes, brainId, brainFeatures)
VALUES ('job-$(date +%Y%m%d-%H%M)', 0, <HASH_TYPE_ID>, <HASH_COUNT>, 0, 0, 0, 1, 0, 0, '', 0, 0);
\""

# Get the hashlistId
HASHLIST_ID=$(ssh ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -sNe 'SELECT MAX(hashlistId) FROM Hashlist;'")
```
**Required fields with no defaults:** hashCount, cracked, hexSalt, isSalted, notes, brainId, brainFeatures
**Replace `<HASH_TYPE_ID>` with:** 0=MD5, 100=SHA1, 1400=SHA256, 1000=NTLM, 1800=sha512crypt

### Step J: Import Hashes

**CRITICAL:** Hash table requires `crackPos` field (no default value).

**ANTI-PATTERN:** Do NOT use inline shell loops with MySQL - shell escaping breaks. Always use SQL file import.

```bash
# 1. Create SQL import file LOCALLY (avoids shell escaping issues)
cat hashes.txt | while read hash; do
  echo "INSERT INTO Hash (hashlistId, hash, isCracked, crackPos) VALUES ($HASHLIST_ID, '$hash', 0, 0);"
done > /tmp/import_hashes.sql

# Verify SQL file looks correct
head -3 /tmp/import_hashes.sql

# 2. Copy SQL file to server
scp /tmp/import_hashes.sql ubuntu@$SERVER_IP:/tmp/

# 3. Execute via docker exec with stdin redirection (CORRECT METHOD)
# Note: The -i flag is REQUIRED for stdin to work
ssh ubuntu@$SERVER_IP "sudo docker exec -i hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis < /tmp/import_hashes.sql"

# 4. Verify count
ssh ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -sNe 'SELECT COUNT(*) FROM Hash WHERE hashlistId=$HASHLIST_ID;'"
```

**ANTI-PATTERNS (these FAIL):**
```bash
# FAILS: Shell variable expansion breaks inside SSH+docker
ssh ubuntu@$SERVER_IP 'cat /tmp/hashes.txt | while read hash; do
  sudo docker exec hashtopolis-db mysql ... "INSERT ... VALUES (\$hash, ...);"
done'

# FAILS: source command inside docker exec
ssh ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql ... -e 'source /tmp/import.sql;'"

# WORKS: stdin redirection with -i flag
ssh ubuntu@$SERVER_IP "sudo docker exec -i hashtopolis-db mysql ... < /tmp/import.sql"
```

### Step K: Create Task with ALL Required Fields

**CRITICAL:** TaskWrapper requires `maxAgents` field (no default):

```bash
ssh ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -e \"
INSERT INTO TaskWrapper (priority, taskType, hashlistId, accessGroupId, taskWrapperName, isArchived, cracked, maxAgents)
VALUES (10, 0, $HASHLIST_ID, 1, 'RockYou+OneRule', 0, 0, 0);
\""

WRAPPER_ID=$(ssh ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -sNe 'SELECT MAX(taskWrapperId) FROM TaskWrapper;'")

# Calculate keyspace: wordlist_lines × rule_lines
WORDLIST_LINES=$(wc -l < rockyou.txt)
RULE_LINES=$(wc -l < OneRuleToRuleThemStill.rule)
KEYSPACE=$((WORDLIST_LINES * RULE_LINES))

ssh ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -e \"
INSERT INTO Task (taskName, attackCmd, chunkTime, statusTimer, keyspace, keyspaceProgress, priority, maxAgents, color, isSmall, isCpuTask, useNewBench, skipKeyspace, crackerBinaryId, crackerBinaryTypeId, taskWrapperId, isArchived, notes, staticChunks, chunkSize, forcePipe, usePreprocessor, preprocessorCommand)
VALUES ('RockYou+OneRule', '#HL# rockyou.txt -r OneRuleToRuleThemStill.rule --force', 600, 5, \$KEYSPACE, 0, 10, 0, NULL, 0, 1, 1, 0, 1, 1, \$WRAPPER_ID, 0, '', 0, 0, 0, 0, '');
\""

TASK_ID=$(ssh ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -sNe 'SELECT MAX(taskId) FROM Task;'")
```
**CRITICAL fields:**
- `crackerBinaryId=1` (NOT NULL!)
- `priority > 0` (task won't dispatch if 0!)
- `keyspace = wordlist_lines × rule_lines` for rule attacks
- `isActive=1`
- `isCpuTask=1` for CPU workers
- `useNewBench` - **CRITICAL FOR CHUNK SIZING** (see Step K.1 below)

### Step K.1: Determine useNewBench Value (BEFORE Task Creation)

**This step is MANDATORY to prevent tiny chunk or giant chunk failures.**

**CRITICAL: Check ASSIGNMENT table, not Agent table!** Agents must be assigned to a task first to benchmark.

```bash
# Wait for agents to benchmark (~2-3 minutes after trust)
# Check Assignment table for actual benchmark values
ssh ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -e \"
SELECT agentId, benchmark FROM Assignment LIMIT 3;
\""
```

**Interpret benchmark format:**
| Benchmark Value | Contains ":" ? | Format | useNewBench Setting |
|-----------------|----------------|--------|---------------------|
| `1:39.96` | YES | OLD (time:speed) | `0` |
| `2672:24760.24` | YES | OLD (time:speed) | `0` |
| `39.96` | NO | NEW (speed only) | `1` |
| `24760.24` | NO | NEW (speed only) | `1` |

**Detection Logic:**
```bash
BENCHMARK=$(ssh ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -sNe 'SELECT benchmark FROM Assignment LIMIT 1;'")
if [[ "$BENCHMARK" == *":"* ]]; then
  echo "OLD format detected -> useNewBench=0"
  USE_NEW_BENCH=0
else
  echo "NEW format detected -> useNewBench=1"
  USE_NEW_BENCH=1
fi
```

**FAILURE MODES:**
- Wrong useNewBench=1 with OLD format → Chunks consume entire keyspace instantly (task completes with 0 cracked)
- Wrong useNewBench=0 with NEW format → Tiny chunks, incomplete coverage

**ANTI-PATTERN:** Do NOT use `chunkSize` or `staticChunks` to fix chunk sizing issues - these mask the real problem. Always set correct `useNewBench` first.

### Step L: Link Files to Task

```bash
ssh ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -e \"
INSERT INTO FileTask (fileId, taskId)
SELECT fileId, $TASK_ID FROM File WHERE filename IN ('rockyou.txt', 'OneRuleToRuleThemStill.rule');
\""
```

### Step M: Final Verification

```bash
ssh ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -e \"
SELECT t.taskId, t.taskName, t.priority, t.isActive, t.crackerBinaryId, t.keyspace, t.keyspaceProgress
FROM Task t WHERE t.taskId = $TASK_ID;
\""
```
**Expected:**
- `priority > 0`
- `isActive = 1`
- `crackerBinaryId = 1` (NOT NULL)
- `keyspace > 0`
- `keyspaceProgress = 0`

### Step N: MANDATORY Chunk Coverage Verification (5 minutes after start)

**CRITICAL:** After agents start cracking (~5 minutes), verify chunks are sized correctly:

```bash
ssh ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -e \"
SELECT
  COUNT(*) as chunk_count,
  SUM(length) as total_coverage,
  (SELECT keyspace FROM Task WHERE taskId=$TASK_ID) as target_keyspace,
  ROUND(SUM(length) / (SELECT keyspace FROM Task WHERE taskId=$TASK_ID) * 100, 2) as coverage_pct
FROM Chunk WHERE taskId=$TASK_ID;
\""
```

**Expected Results:**
| Keyspace | Expected Chunks | Min Coverage After 5min |
|----------|-----------------|------------------------|
| ~84M (smoke test) | 10-50 | >50% |
| ~746B (RockYou+OneRule) | 1,500-2,500 | >5% |

**FAILURE INDICATORS:**
- `coverage_pct` < 1% after 5 minutes = CHUNKS TOO SMALL
- Thousands of tiny chunks (< 100K length) = BENCHMARK MISMATCH
- Single giant chunk (>50% keyspace) = BENCHMARK TOO HIGH

**RECOVERY (if chunks broken):**
```bash
# Archive broken task and create new one with fixed chunkSize
ssh ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -e \"
UPDATE Task SET isArchived=1, priority=0 WHERE taskId=$TASK_ID;
DELETE FROM Chunk WHERE taskId=$TASK_ID;
\""

# Re-create task with explicit chunkSize (367M for RockYou+OneRule)
# ... re-run Step K with chunkSize=367000000
```

---

## Execution Steps

### Step 1: Validate Input

Accept hashes from:
- File path (`--input /path/to/hashes.txt`)
- Piped stdin (`cat hashes.txt | hashcrack crack`)
- Direct paste in terminal

### Step 2: Detect Hash Type

Auto-detection based on:
- Hash length (32=MD5/NTLM, 40=SHA1, 64=SHA256)
- Hash prefix ($6$=sha512crypt, $2a$=bcrypt)

Override with `--type`:
```bash
hashcrack crack --input hashes.txt --type ntlm
```

### Step 3: Connect to Hashtopolis

Verify server connectivity:
```bash
bun run tools/HashtopolisClient.ts test
```

### Step 4: Create Hashlist

Upload hashes to Hashtopolis:
```typescript
const hashlistId = await client.createHashlist({
  name: "job-2025-12-25",
  hashTypeId: 1000,  // NTLM
  hashes: hashArray
});
```

### Step 5: Configure Attack Strategy

| Strategy | Description |
|----------|-------------|
| `quick` | rockyou.txt only |
| `comprehensive` | Wordlists + best64 rules + masks |
| `thorough` | All above + heavy rules + extended masks |

### Step 6: Create Tasks

For comprehensive strategy:
```
Task 1: Wordlist - rockyou (priority 100)
Task 2: Wordlist + Rules - best64 (priority 90)
Task 3: Common Masks (priority 80)
```

### Step 7: Monitor Progress

```bash
hashcrack status
```

Output:
```
Job: job-2025-12-25
Progress: 4,521/10,000 (45.2%)
Speed: 1.2 GH/s
Active Tasks: 2
```

## CLI Usage

```bash
# From file
hashcrack crack --input /pentest/hashes.txt --type ntlm

# From stdin
cat extracted_hashes.txt | hashcrack crack --type sha512crypt

# With custom strategy
hashcrack crack --input hashes.txt --type ntlm --strategy thorough

# With job name
hashcrack crack --input hashes.txt --type md5 --name "client-audit-2025"
```

## Security

- Hashes are transmitted to server over HTTPS
- Cracked passwords are NEVER displayed in terminal
- Results saved to `.claude/.env` (base64 encoded)
- View actual passwords in Hashtopolis UI only

## Output

```
╔════════════════════════════════════════════════════════════╗
║                    JOB SUBMITTED                            ║
╚════════════════════════════════════════════════════════════╝

  Job Name:    client-audit-2025
  Hashlist ID: 42
  Hash Count:  10,000
  Hash Type:   ntlm (1000)
  Strategy:    comprehensive
  Tasks:       3
```

## Supported Hash Types

| Type | ID | Command |
|------|-----|---------|
| MD5 | 0 | `--type md5` |
| SHA1 | 100 | `--type sha1` |
| SHA256 | 1400 | `--type sha256` |
| NTLM | 1000 | `--type ntlm` |
| sha512crypt | 1800 | `--type sha512crypt` |
| bcrypt | 3200 | `--type bcrypt` |
| NetNTLMv2 | 5600 | `--type netntlmv2` |
