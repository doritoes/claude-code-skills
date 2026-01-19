# Crack Workflow

Submit password hashes for distributed cracking.

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

### Step D: Trust All Agents

```bash
ssh ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -e 'UPDATE Agent SET isTrusted = 1 WHERE isTrusted = 0;'"
```
**Verify:** Re-run Step C, all `isTrusted=1`

### Step E: Stage Files (Wordlists + Rules)

```bash
# Copy wordlist and rules to server
scp rockyou.txt ubuntu@$SERVER_IP:/tmp/
scp OneRuleToRuleThemStill.rule ubuntu@$SERVER_IP:/tmp/

# Copy into Docker volume (FLAT - no subdirectories!)
ssh ubuntu@$SERVER_IP "sudo docker cp /tmp/rockyou.txt hashtopolis-backend:/usr/local/share/hashtopolis/files/"
ssh ubuntu@$SERVER_IP "sudo docker cp /tmp/OneRuleToRuleThemStill.rule hashtopolis-backend:/usr/local/share/hashtopolis/files/"
```

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

```bash
# Create hashlist (API unreliable - ALWAYS use database)
ssh ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -e \"
INSERT INTO Hashlist (hashlistId, hashlistName, format, hashTypeId, hashCount, cracked, isArchived, isSecret, accessGroupId)
VALUES (NULL, 'job-$(date +%Y%m%d-%H%M)', 0, <HASH_TYPE_ID>, <HASH_COUNT>, 0, 0, 0, 1);
\""

# Get the hashlistId
HASHLIST_ID=$(ssh ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -sNe 'SELECT MAX(hashlistId) FROM Hashlist;'")
```
**Replace `<HASH_TYPE_ID>` with:** 0=MD5, 100=SHA1, 1400=SHA256, 1000=NTLM, 1800=sha512crypt

### Step J: Import Hashes

```bash
# Copy hash file to server and import
scp hashes.txt ubuntu@$SERVER_IP:/tmp/
ssh ubuntu@$SERVER_IP "while read hash; do
  echo \"INSERT INTO Hash (hashlistId, hash, isCracked) VALUES ($HASHLIST_ID, '\$hash', 0);\"
done < /tmp/hashes.txt | sudo docker exec -i hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis"
```

### Step K: Create Task with ALL Required Fields

```bash
ssh ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -e \"
INSERT INTO TaskWrapper (taskWrapperId, priority, taskType, hashlistId, accessGroupId, taskWrapperName, isArchived, cracked)
VALUES (NULL, 10, 0, $HASHLIST_ID, 1, 'RockYou+OneRule', 0, 0);
\""

WRAPPER_ID=$(ssh ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -sNe 'SELECT MAX(taskWrapperId) FROM TaskWrapper;'")

# Calculate keyspace: wordlist_lines × rule_lines
WORDLIST_LINES=$(wc -l < rockyou.txt)
RULE_LINES=$(wc -l < OneRuleToRuleThemStill.rule)
KEYSPACE=$((WORDLIST_LINES * RULE_LINES))

ssh ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -e \"
INSERT INTO Task (taskId, taskName, attackCmd, chunkTime, statusTimer, keyspace, keyspaceProgress, priority, maxAgents, color, isSmall, isCpuTask, useNewBench, skipKeyspace, crackerBinaryId, crackerBinaryTypeId, taskWrapperId, isArchived, forcePipe, preprocessorId, preprocessorCommand, usePreprocessor, staticChunks, chunkSize, isActive)
VALUES (NULL, 'RockYou+OneRule', '#HL# rockyou.txt -r OneRuleToRuleThemStill.rule --force', 600, 5, $KEYSPACE, 0, 10, 0, NULL, 0, 1, 1, 0, 1, 1, $WRAPPER_ID, 0, 0, 0, '', 0, 0, 0, 1);
\""

TASK_ID=$(ssh ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -sNe 'SELECT MAX(taskId) FROM Task;'")
```
**CRITICAL fields:**
- `crackerBinaryId=1` (NOT NULL!)
- `priority > 0` (task won't dispatch if 0!)
- `keyspace = wordlist_lines × rule_lines` for rule attacks
- `isActive=1`
- `isCpuTask=1` for CPU workers

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
