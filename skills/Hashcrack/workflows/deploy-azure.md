# Azure Deployment Workflow

Step-by-step deployment to Azure with GATE checkpoints.

---

## PRE-FLIGHT (MANDATORY)

### GATE 0: Clean State Check (CRITICAL SAFETY)

**⚠️ DO NOT SKIP THIS STEP - Prevents destroying active research**

```bash
cd ~/.claude/skills/Hashcrack/terraform/azure
source <(grep -E '^ARM_' ~/.claude/.env | sed 's/^/export /')

# Step 1: Check state count
STATE_COUNT=$(terraform state list 2>/dev/null | wc -l)
echo "Terraform state resources: $STATE_COUNT"
```

**If STATE_COUNT = 0:** Safe to proceed with new deployment.

**If STATE_COUNT > 0:** ACTIVE DEPLOYMENT EXISTS - Check for running jobs:
```bash
AZURE_SSH_KEY="$HOME/.ssh/azure_hashcrack"
SERVER_IP=$(terraform output -raw server_public_ip 2>/dev/null)
DB_PASS=$(terraform output -raw db_password 2>/dev/null)
ssh -i $AZURE_SSH_KEY -o ConnectTimeout=10 ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -e 'SELECT COUNT(*) as cracked FROM Hash WHERE isCracked=1; SELECT taskId, taskName, ROUND(keyspaceProgress/keyspace*100,2) as pct FROM Task WHERE isArchived=0;'" 2>/dev/null
```

| Cracked Count | Tasks Running? | Decision |
|---------------|----------------|----------|
| 0 | No tasks | Safe to destroy and redeploy |
| > 0 | Yes | **STOP - Active test running. Wait or use different provider.** |
| Unknown | Can't SSH | **STOP - Investigate before destroying** |

**NEVER destroy active deployments with cracked hashes > 0 without explicit user approval.**

### GATE 1: Azure Credentials
```bash
# Export from .env
source <(grep -E '^ARM_' ~/.claude/.env | sed 's/^/export /')

# Verify
echo "ARM_CLIENT_ID: ${ARM_CLIENT_ID:0:8}..."
az account show --query name -o tsv
```
**Expected:** Returns subscription name
**If fails:** Check ~/.claude/.env has ARM_CLIENT_ID, ARM_CLIENT_SECRET, ARM_TENANT_ID, ARM_SUBSCRIPTION_ID

---

## DEPLOYMENT STEPS

### Step 1: Initialize Terraform

```bash
cd ~/.claude/skills/Hashcrack/terraform/azure
terraform init
```
**GATE 2 PASS:** "Terraform has been successfully initialized"
**GATE 2 FAIL:** Check azurerm provider configuration

### Step 2: Configure Variables

Ensure `terraform.tfvars` has:
```hcl
location           = "eastus"
cpu_worker_count   = 4
use_spot_instances = true
ssh_public_key     = "ssh-rsa AAAA..."
```

### Step 3: Plan Deployment

```bash
terraform plan -out=tfplan
```
**GATE 3 PASS:** "Plan: X to add, 0 to change, 0 to destroy"
**GATE 3 FAIL:** Fix tfvars errors

### Step 4: Apply Infrastructure

```bash
terraform apply tfplan
```
**GATE 4 PASS:** "Apply complete! Resources: X added"
**GATE 4 FAIL:**
- "AADSTS" errors -> Credential issue, re-export ARM_* variables
- "QuotaExceeded" -> Request quota increase in Azure portal

### Step 5: Get Server IP and DB Password

```bash
SERVER_IP=$(terraform output -raw server_public_ip)
DB_PASS=$(terraform output -raw db_password)
echo "Server: $SERVER_IP"
```

### Step 6: Wait for Server SSH

**IMPORTANT:** Azure requires the specific SSH key generated for the deployment.

```bash
# Set SSH key path (REQUIRED for Azure)
AZURE_SSH_KEY="$HOME/.ssh/azure_hashcrack"

# MAX 2 minutes
for i in {1..8}; do
  ssh -i $AZURE_SSH_KEY -o ConnectTimeout=5 -o StrictHostKeyChecking=no ubuntu@$SERVER_IP "echo SSH OK" && break
  echo "Waiting for SSH... ($i/8)"
  sleep 15
done
```
**GATE 5 PASS:** "SSH OK"
**GATE 5 FAIL after 2 min:** Check NSG rules, VM state in Azure portal
**GATE 5 FAIL Permission denied:** Verify SSH key path matches terraform.tfvars `ssh_public_key`

### Step 7: Wait for Docker Containers

```bash
# MAX 5 minutes (Azure VMs can be slower)
for i in {1..10}; do
  ssh -i $AZURE_SSH_KEY ubuntu@$SERVER_IP 'sudo docker ps | grep -q hashtopolis-backend' && echo "Docker OK" && break
  echo "Waiting for cloud-init... ($i/10)"
  sleep 30
done
```
**GATE 6 PASS:** "Docker OK"
**GATE 6 FAIL after 5 min:** Check `cloud-init status` on server

### Step 8: Verify Login Works

```bash
ssh -i $AZURE_SSH_KEY ubuntu@$SERVER_IP 'curl -s -c /tmp/c.txt http://localhost:8080/ > /dev/null && \
  curl -s -c /tmp/c.txt -b /tmp/c.txt -L -X POST \
  -d "username=hashcrack&password=Hashcrack2025Lab&fw=" \
  http://localhost:8080/login.php | grep -qE "agents\.php" && echo "LOGIN OK" || echo "LOGIN FAILED"'
```
**GATE 7 PASS:** "LOGIN OK"
**GATE 7 FAIL:** Reset password with PHP script (see Deploy.md Step 8)

### Step 9: Verify Vouchers

**NOTE:** Cloud-init voucher creation is unreliable. Always verify and create manually if needed.

```bash
WORKER_COUNT=$(grep cpu_worker_count terraform.tfvars | grep -oE '[0-9]+')
VOUCHER_COUNT=$(ssh -i $AZURE_SSH_KEY ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -sNe 'SELECT COUNT(*) FROM RegVoucher;'" 2>/dev/null)
echo "Vouchers: $VOUCHER_COUNT / Workers: $WORKER_COUNT"
```
**GATE 8 PASS:** VOUCHER_COUNT >= WORKER_COUNT
**GATE 8 FAIL (COMMON):** Create vouchers using terraform output codes:

```bash
# Get voucher codes from terraform output (shown at end of apply)
# The format is: voucher_code = "ABC123..." (4 codes generated for 4 workers)
# If you didn't capture them, generate new ones:
for i in $(seq 1 $WORKER_COUNT); do
  ssh -i $AZURE_SSH_KEY ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -e \"INSERT INTO RegVoucher (voucher, time) VALUES ('AZURE_$(openssl rand -hex 6)', UNIX_TIMESTAMP());\"" 2>/dev/null
done

# Verify vouchers created
ssh -i $AZURE_SSH_KEY ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -e 'SELECT COUNT(*) as voucher_count FROM RegVoucher;'" 2>/dev/null
```

### Step 10: Wait for Agents and Trust

```bash
# Wait MAX 3 minutes for agents
for i in {1..6}; do
  AGENT_COUNT=$(ssh -i $AZURE_SSH_KEY ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -sNe 'SELECT COUNT(*) FROM Agent WHERE isActive=1;'")
  [ "$AGENT_COUNT" -ge "$WORKER_COUNT" ] && echo "Agents: $AGENT_COUNT" && break
  echo "Waiting for agents... ($AGENT_COUNT/$WORKER_COUNT)"
  sleep 30
done

# Trust and configure for CPU (with ignoreErrors for rule attacks)
ssh -i $AZURE_SSH_KEY ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -e \"
UPDATE Agent SET isTrusted = 1, cpuOnly = 1, cmdPars = '--force', ignoreErrors = 1 WHERE isTrusted = 0;
\""
```
**GATE 9 PASS:** All agents registered and trusted
**GATE 9 FAIL after 3 min:** Check worker cloud-init logs

### Step 11: Detect Benchmark Format (CRITICAL for Tasks)

**Wait 2-3 minutes after trust, then check:**

```bash
ssh -i $AZURE_SSH_KEY ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -e \"
SELECT agentId, benchmark FROM Assignment LIMIT 1;
\""
```

**Interpret the result:**
| Benchmark Value | Format | useNewBench Setting |
|-----------------|--------|---------------------|
| `2672:24760.24` (contains `:`) | OLD | `useNewBench=0` |
| `24760.24` (number only) | NEW | `useNewBench=1` |

**GATE 10 PASS:** Benchmark format identified, save for task creation
**GATE 10 FAIL:** Wait longer for benchmark, or check agent is running task

---

## DEPLOYMENT COMPLETE

```
Azure Hashtopolis Ready!

URL: http://$SERVER_IP:8080
Username: hashcrack
Password: Hashcrack2025Lab

Workers: $WORKER_COUNT agents registered and trusted
```

---

## FILE STAGING (CRITICAL - DO NOT SKIP)

### GATE F1: Upload Files to Server

```bash
# Upload from local machine to server /tmp/
scp -i $AZURE_SSH_KEY rockyou.txt ubuntu@$SERVER_IP:/tmp/
scp -i $AZURE_SSH_KEY OneRuleToRuleThemStill.rule ubuntu@$SERVER_IP:/tmp/
```

### GATE F2: Copy Files INTO Container at CORRECT Path

**CRITICAL PATH:** `/usr/local/share/hashtopolis/files/` (NOT `/var/www/hashtopolis/files/`)

```bash
ssh -i $AZURE_SSH_KEY ubuntu@$SERVER_IP "sudo docker cp /tmp/rockyou.txt hashtopolis-backend:/usr/local/share/hashtopolis/files/rockyou.txt"
ssh -i $AZURE_SSH_KEY ubuntu@$SERVER_IP "sudo docker cp /tmp/OneRuleToRuleThemStill.rule hashtopolis-backend:/usr/local/share/hashtopolis/files/OneRuleToRuleThemStill.rule"
```

**ANTI-PATTERNS:**
- `/var/www/hashtopolis/files/` - WRONG, causes ERR3 "file not present"
- `/var/lib/docker/volumes/hashtopolis_files/_data/` - WRONG

### GATE F3: Fix File Ownership (Use Explicit Filenames!)

```bash
# CRITICAL: Must use -u root flag for docker exec to have permission!
# CRITICAL: Do NOT use glob (*) - shell expansion fails in SSH!
ssh -i $AZURE_SSH_KEY ubuntu@$SERVER_IP "sudo docker exec -u root hashtopolis-backend chown www-data:www-data /usr/local/share/hashtopolis/files/rockyou.txt /usr/local/share/hashtopolis/files/OneRuleToRuleThemStill.rule"
```

**If chown fails with "Operation not permitted":** Ensure you have `-u root` in the docker exec command.

### GATE F4: Verify Files Exist with Correct Ownership

```bash
ssh -i $AZURE_SSH_KEY ubuntu@$SERVER_IP "sudo docker exec hashtopolis-backend ls -la /usr/local/share/hashtopolis/files/"
```
**Expected:** Both files with `www-data www-data` ownership

### GATE F5: Register Files in Database with isSecret=1

**CRITICAL:** `isSecret=1` is REQUIRED for trusted agents to download files!

```bash
# Get file sizes
ROCKYOU_SIZE=$(ssh -i $AZURE_SSH_KEY ubuntu@$SERVER_IP "stat -c %s /tmp/rockyou.txt")
ROCKYOU_LINES=$(ssh -i $AZURE_SSH_KEY ubuntu@$SERVER_IP "wc -l < /tmp/rockyou.txt")
RULE_SIZE=$(ssh -i $AZURE_SSH_KEY ubuntu@$SERVER_IP "stat -c %s /tmp/OneRuleToRuleThemStill.rule")
RULE_LINES=$(ssh -i $AZURE_SSH_KEY ubuntu@$SERVER_IP "wc -l < /tmp/OneRuleToRuleThemStill.rule")

ssh -i $AZURE_SSH_KEY ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -e \"
INSERT INTO File (filename, size, isSecret, fileType, accessGroupId, lineCount)
VALUES
  ('rockyou.txt', $ROCKYOU_SIZE, 1, 0, 1, $ROCKYOU_LINES),
  ('OneRuleToRuleThemStill.rule', $RULE_SIZE, 1, 1, 1, $RULE_LINES)
ON DUPLICATE KEY UPDATE isSecret=1, size=VALUES(size), lineCount=VALUES(lineCount);
\""
```

### GATE F6: Verify File Download Works

```bash
TOKEN=$(ssh -i $AZURE_SSH_KEY ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -sNe 'SELECT token FROM Agent LIMIT 1;'")
ssh -i $AZURE_SSH_KEY ubuntu@$SERVER_IP "curl -s -o /tmp/test_download.txt 'http://localhost:8080/getFile.php?file=1&token=$TOKEN' && ls -la /tmp/test_download.txt"
```
**GATE F6 PASS:** File size matches source (139MB for rockyou.txt)
**GATE F6 FAIL:** Returns <1KB or ERR3 = wrong path, re-check GATE F2

---

## PARALLEL RULE ATTACK SETUP (REQUIRED FOR 4+ WORKERS)

**CRITICAL:** For rule attacks, only 1 worker is active at a time because hashcat's `-s` skip parameter doesn't work for rules.

**SOLUTION:** Split HASHES into N hashlists, create N tasks with `maxAgents=1`, resulting in N workers running parallel.

### GATE P1: Split Hash File Locally

```bash
WORKER_COUNT=4
HASH_FILE="sample/sha256.txt"
TOTAL=$(wc -l < "$HASH_FILE")
PER_WORKER=$((TOTAL / WORKER_COUNT))

# Split into N files
split -l $PER_WORKER -d --additional-suffix=.txt "$HASH_FILE" hash_chunk_
# Creates: hash_chunk_00.txt, hash_chunk_01.txt, hash_chunk_02.txt, hash_chunk_03.txt
ls -la hash_chunk_*.txt
```
**Expected:** 4 files with ~equal line counts

### GATE P2: Upload Hash Chunks to Server

```bash
for i in $(seq 0 $((WORKER_COUNT-1))); do
  CHUNK_FILE="hash_chunk_0$i.txt"
  scp -i $AZURE_SSH_KEY "$CHUNK_FILE" ubuntu@$SERVER_IP:/tmp/
done
```

### GATE P3: Create N Hashlists (One Per Worker)

```bash
for i in $(seq 0 $((WORKER_COUNT-1))); do
  HASH_COUNT=$(wc -l < "hash_chunk_0$i.txt")
  ssh -i $AZURE_SSH_KEY ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -e \"
  INSERT INTO Hashlist (hashlistName, format, hashTypeId, hashCount, cracked, isArchived, isSecret, accessGroupId, hexSalt, isSalted, notes, brainId, brainFeatures)
  VALUES ('azure-chunk-$i', 0, 1400, $HASH_COUNT, 0, 0, 0, 1, 0, 0, 'Azure parallel chunk $i', 0, 0);
  \""
done

# Verify hashlists created
ssh -i $AZURE_SSH_KEY ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -e 'SELECT hashlistId, hashlistName, hashCount FROM Hashlist;'"
```

### GATE P4: Import Hashes to Each Hashlist

```bash
for i in $(seq 0 $((WORKER_COUNT-1))); do
  HASHLIST_ID=$((i+1))  # Assumes first hashlists are 1,2,3,4
  CHUNK_FILE="hash_chunk_0$i.txt"

  # Create import SQL
  awk -v hlid="$HASHLIST_ID" '{print "INSERT INTO Hash (hashlistId, hash, isCracked, crackPos) VALUES (" hlid ", '\''" $1 "'\'', 0, 0);"}' "$CHUNK_FILE" > /tmp/import_chunk_$i.sql

  # Copy and execute
  scp -i $AZURE_SSH_KEY /tmp/import_chunk_$i.sql ubuntu@$SERVER_IP:/tmp/
  ssh -i $AZURE_SSH_KEY ubuntu@$SERVER_IP "sudo docker cp /tmp/import_chunk_$i.sql hashtopolis-db:/tmp/ && sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -e 'source /tmp/import_chunk_$i.sql;'"

  echo "Imported chunk $i to hashlist $HASHLIST_ID"
done

# Verify hash counts
ssh -i $AZURE_SSH_KEY ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -e 'SELECT hashlistId, hashCount, (SELECT COUNT(*) FROM Hash WHERE Hash.hashlistId=Hashlist.hashlistId) as actual FROM Hashlist;'"
```

### GATE P5: Calculate Keyspace

```bash
WORDLIST_LINES=$(ssh -i $AZURE_SSH_KEY ubuntu@$SERVER_IP "wc -l < /tmp/rockyou.txt")
RULE_LINES=$(ssh -i $AZURE_SSH_KEY ubuntu@$SERVER_IP "wc -l < /tmp/OneRuleToRuleThemStill.rule")
KEYSPACE=$((WORDLIST_LINES * RULE_LINES))
echo "Keyspace: $WORDLIST_LINES words x $RULE_LINES rules = $KEYSPACE"
```

### GATE P6: Verify Cracker Binary ID

```bash
CRACKER_ID=$(ssh -i $AZURE_SSH_KEY ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -sNe 'SELECT crackerBinaryId FROM CrackerBinary LIMIT 1;'")
echo "Cracker Binary ID: $CRACKER_ID"
```
**Expected:** `1` (or similar integer, NOT NULL)

### GATE P7: Create N Tasks with maxAgents=1

**CRITICAL:** `maxAgents=1` forces agents to distribute across tasks instead of all piling on task 1.

```bash
for i in $(seq 0 $((WORKER_COUNT-1))); do
  HASHLIST_ID=$((i+1))
  WRAPPER_ID=$((i+1))

  # Create TaskWrapper
  ssh -i $AZURE_SSH_KEY ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -e \"
  INSERT INTO TaskWrapper (priority, taskType, hashlistId, accessGroupId, taskWrapperName, isArchived, cracked, maxAgents)
  VALUES (10, 0, $HASHLIST_ID, 1, 'Azure-Parallel-$i', 0, 0, 0);
  \""

  # Create Task with maxAgents=1 (CRITICAL!)
  ssh -i $AZURE_SSH_KEY ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -e \"
  INSERT INTO Task (taskName, attackCmd, chunkTime, statusTimer, keyspace, keyspaceProgress, priority, maxAgents, color, isSmall, isCpuTask, useNewBench, skipKeyspace, crackerBinaryId, crackerBinaryTypeId, taskWrapperId, isArchived, notes, staticChunks, chunkSize, forcePipe, usePreprocessor, preprocessorCommand)
  VALUES ('RockYou-OneRule-$i', '#HL# rockyou.txt -r OneRuleToRuleThemStill.rule --force', 600, 5, $KEYSPACE, 0, 10, 1, NULL, 0, 1, 0, 0, $CRACKER_ID, 1, $WRAPPER_ID, 0, 'Azure parallel task $i', 0, 0, 0, 0, '');
  \""

  echo "Created task $i for hashlist $HASHLIST_ID with maxAgents=1"
done
```

### GATE P8: Link Files to Each Task

```bash
# Get file IDs
ROCKYOU_ID=$(ssh -i $AZURE_SSH_KEY ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -sNe \"SELECT fileId FROM File WHERE filename='rockyou.txt';\"")
RULE_ID=$(ssh -i $AZURE_SSH_KEY ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -sNe \"SELECT fileId FROM File WHERE filename='OneRuleToRuleThemStill.rule';\"")

for i in $(seq 1 $WORKER_COUNT); do
  TASK_ID=$i  # Assumes first tasks are 1,2,3,4
  ssh -i $AZURE_SSH_KEY ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -e \"
  INSERT INTO FileTask (fileId, taskId) VALUES ($ROCKYOU_ID, $TASK_ID), ($RULE_ID, $TASK_ID);
  \""
  echo "Linked files to task $TASK_ID"
done
```

### GATE P9: Verify Parallel Setup

```bash
ssh -i $AZURE_SSH_KEY ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -e \"
SELECT t.taskId, t.taskName, t.maxAgents, t.priority, t.crackerBinaryId, tw.hashlistId
FROM Task t
JOIN TaskWrapper tw ON t.taskWrapperId = tw.taskWrapperId
WHERE t.isArchived = 0;
\""
```
**Expected:** N tasks, each with `maxAgents=1`, `priority=10`, `crackerBinaryId=1`

---

## MONITORING PARALLEL CRACKING

### Check Active Workers Per Task

```bash
ssh -i $AZURE_SSH_KEY ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -e \"
SELECT t.taskId, t.taskName, COUNT(DISTINCT c.agentId) as active_workers
FROM Task t
LEFT JOIN Chunk c ON t.taskId = c.taskId AND c.state = 2
WHERE t.isArchived = 0
GROUP BY t.taskId;
\""
```
**Expected:** Each task has 1 active worker (maxAgents=1 enforced)

### Check Overall Progress

```bash
ssh -i $AZURE_SSH_KEY ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -e \"
SELECT
  (SELECT COUNT(*) FROM Hash WHERE isCracked=1) as cracked,
  (SELECT COUNT(*) FROM Hash) as total,
  ROUND((SELECT COUNT(*) FROM Hash WHERE isCracked=1) / (SELECT COUNT(*) FROM Hash) * 100, 2) as pct;
\""
```

### Check Per-Task Progress

```bash
ssh -i $AZURE_SSH_KEY ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -e \"
SELECT t.taskId, t.taskName, t.keyspaceProgress, t.keyspace,
  ROUND(t.keyspaceProgress / t.keyspace * 100, 2) as pct
FROM Task t WHERE t.isArchived = 0;
\""
```

---

## AZURE-SPECIFIC NOTES

| Topic | Detail |
|-------|--------|
| Worker networking | Workers have public IPs for cloud-init internet access |
| Spot instances | Use priority "Spot" with eviction policy |
| Performance | Slowest CPU of cloud providers tested |
| GPU option | Standard_NC4as_T4_v3 for T4 GPU |
| Credentials | ARM_* variables required for all terraform commands |
| NSG timing | Destroy may need retry due to NetworkSecurityGroupOldReferencesNotCleanedUp |
| SSH key | **ALWAYS use `-i ~/.ssh/azure_hashcrack` for ALL SSH commands** |
| File path | `/usr/local/share/hashtopolis/files/` NOT `/var/www/hashtopolis/files/` |
| isSecret | **REQUIRED** `isSecret=1` for trusted agents to download files |
| maxAgents | **Set `maxAgents=1`** per task for parallel rule attacks |

---

## QUICK REFERENCE: ALL VARIABLES

Set these at the start of your session:
```bash
# Source terraform outputs
cd ~/.claude/skills/Hashcrack/terraform/azure
source <(grep -E '^ARM_' ~/.claude/.env | sed 's/^/export /')
SERVER_IP=$(terraform output -raw server_public_ip)
DB_PASS=$(terraform output -raw db_password)
AZURE_SSH_KEY="$HOME/.ssh/azure_hashcrack"
WORKER_COUNT=$(grep cpu_worker_count terraform.tfvars | grep -oE '[0-9]+')
```

## QUICK REFERENCE: COMMON COMMANDS

```bash
# SSH to server
ssh -i $AZURE_SSH_KEY ubuntu@$SERVER_IP

# Check agent status
ssh -i $AZURE_SSH_KEY ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -e 'SELECT agentId, agentName, isActive, isTrusted FROM Agent;'" 2>/dev/null

# Check task progress
ssh -i $AZURE_SSH_KEY ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -e 'SELECT taskId, taskName, ROUND(keyspaceProgress/keyspace*100,2) as pct FROM Task WHERE isArchived=0;'" 2>/dev/null

# Check cracked count
ssh -i $AZURE_SSH_KEY ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -sNe 'SELECT COUNT(*) FROM Hash WHERE isCracked=1;'" 2>/dev/null

# View cracked passwords (first 10)
ssh -i $AZURE_SSH_KEY ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -e 'SELECT hash, plaintext FROM Hash WHERE isCracked=1 LIMIT 10;'" 2>/dev/null
```

---

## TEARDOWN

**Azure destroy may fail first time due to NSG cleanup timing**

```bash
# GATE D1: Check state
cd ~/.claude/skills/Hashcrack/terraform/azure
terraform state list | wc -l

# GATE D2: Export credentials
source <(grep -E '^ARM_' ~/.claude/.env | sed 's/^/export /')

# GATE D3: Destroy (may need retry)
terraform destroy -auto-approve
# If "NetworkSecurityGroupOldReferencesNotCleanedUp" error:
sleep 60
terraform destroy -auto-approve

# GATE D4: Verify clean
terraform state list | wc -l  # Must be 0
```
