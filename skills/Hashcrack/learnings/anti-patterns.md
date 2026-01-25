# Anti-Patterns to Avoid

Common mistakes that cause failures or wasted time.

---

## ⛔⛔⛔ ABSOLUTE RULES (NEVER VIOLATE) ⛔⛔⛔

| Rule | Why | Consequence of Violation |
|------|-----|--------------------------|
| **USE PROVIDED FILE PATHS** | User expects their data cracked | Results meaningless if using generated test data |
| **LET HASHTOPOLIS MANAGE TASKS** | Portal visibility required | Hidden tasks = pen tester cannot verify work |
| **1 TASK FOR RULE ATTACKS** | Rule attacks = 1 worker regardless | Splitting wordlists doesn't help, wastes time |
| **SPLIT HASHES FOR PARALLEL RULES** | Only way to parallelize rule attacks | Split HASHES, not wordlists |
| **VERIFY BENCHMARK FORMAT** | useNewBench mismatch = broken chunks | Check Assignment table BEFORE task creation |
| **SET ignoreErrors=1 AT TRUST** | Rule attacks fail on skip>0 chunks | Agents deactivate, cracking stops |
| **FILES GO TO /usr/local/share/hashtopolis/files/** | StoredValue.directory_files defines path | ERR3 "file not present" if wrong path |

---

## ⛔ AI AGENT ANTI-PATTERNS (MOST CRITICAL)

These patterns cause Claude to ignore instructions and fail repeatedly:

| Anti-Pattern | Why It Happens | How to Avoid |
|--------------|----------------|--------------|
| **Ignoring explicit file paths** | Claude generates own test data | USE THE FILE PATH PROVIDED - never generate test hashes |
| **Sleep-on-immediate-error** | Claude treats all errors the same | Classify error first (see ai-discipline.md) |
| **Skipping GATE checks** | Claude "summarizes" workflow | Execute EVERY gate, verify before proceeding |
| **Using generic Deploy.md** | Ignores provider differences | Use `deploy-{provider}.md` workflows |
| **Not reading learnings first** | Claude improvises solutions | Read in order: ai-discipline → anti-patterns → provider |
| **Assuming benchmark format** | Different providers = different formats | ALWAYS check Assignment table before task creation |
| **Retrying without diagnosis** | Same error, same result | Diagnose error type, fix root cause |
| **Proceeding after GATE failure** | Cascading failures | STOP at failed gate, fix, then continue |
| **Starting next provider before current works** | Parallel debugging is impossible | VERIFY current provider is cracking with ALL workers before starting next |
| **Not linking files to tasks** | FileTask table is required | INSERT INTO FileTask for EVERY file-task combination |
| **Wrong file staging location** | Container path differs from host | Use `/var/lib/docker/volumes/hashtopolis_files/_data/` on host |
| **Using wrong SSH key for Azure** | Azure has specific key | Use `~/.ssh/azure_hashcrack` for Azure |
| **Manual IP discovery** | Terraform outputs exist | Use `terraform output -raw server_ip` or `server_public_ip` |

### The "Horrible Session" Pattern (What to Avoid)

```
❌ WRONG PATTERN:
1. Error occurs
2. Sleep 60s
3. Same error
4. Sleep 60s
5. Same error
6. Give up or ask user

✅ CORRECT PATTERN:
1. Error occurs
2. Classify error (immediate/timing/resource)
3. If immediate: fix NOW, no sleep
4. If timing: sleep with MAX 3 retries
5. If resource: verify state, re-run command
```

---

## Database Schema Anti-Patterns

| Anti-Pattern | Why It Fails | Correct Approach |
|--------------|--------------|------------------|
| `INSERT INTO Hash` without `crackPos` | Field has no default | Include `crackPos=0` in INSERT |
| `INSERT INTO Hashlist` without all fields | Multiple NOT NULL fields | Include: hexSalt, isSalted, notes, brainId, brainFeatures |
| Line-by-line hash import via shell loop | Slow, escaping issues | Create SQL file locally, scp, source |

## Task/Agent Anti-Patterns

| Anti-Pattern | Why It Fails | Correct Approach |
|--------------|--------------|------------------|
| Manual Assignment table insert | Bypasses task initialization | Use API createTask or database TaskWrapper+Task |
| **Manually assigning agents via INSERT INTO Assignment** | Micromanagement, breaks Hashtopolis logic | Let Hashtopolis assign via task discovery |
| **maxAgents=0 with split hashes** | All agents go to Task 1 | Use `maxAgents=1` per task to distribute agents across hash splits |
| Deleting tasks | Breaks references | Archive instead: `SET isArchived=1, priority=0` |
| Archiving task without clearing Assignment | Agents stuck on archived task | `DELETE FROM Assignment WHERE taskId=X` after archive |
| Creating duplicate tasks from retries | Agents pick wrong task | Check task count before insert, archive duplicates |
| Trusting agents after file upload | Files default to secret | Trust agents FIRST, then upload |
| **Manually creating vouchers** | Cloud-init creates N vouchers | WAIT for cloud-init to complete - terraform handles N vouchers automatically |
| Single voucher for all workers | Race conditions | Terraform generates N vouchers via `random_string.voucher[count]` |
| Priority = 0 tasks | Won't dispatch | Use priority >= 10 |
| **File size mismatch in DB** | Download verification fails | Verify DB sizes match actual file sizes |

## Infrastructure Anti-Patterns

| Anti-Pattern | Why It Fails | Correct Approach |
|--------------|--------------|------------------|
| **Retrying terraform with locked state file** | Orphaned terraform-provider processes hold locks | Kill ALL terraform-provider-* processes first (see below) |
| **Tainting worker without DB cleanup** | Old agent entry becomes stale, new worker gets new IP | Archive stale agent in DB BEFORE terraform apply (see below) |
| Destroying working workers to fix broken ones | Loses progress | Taint broken workers only |
| NAT Gateway for file downloads | Expensive ($30-45/month) | Server as file proxy |
| HTTPS for Hashtopolis | No cert setup | Use HTTP on port 8080 |
| Static IPs with DHCP enabled | Wrong IP in config | Use actual DHCP-assigned IP |
| **DHCP: Deploying server + workers together** | Workers get wrong server IP | Deploy server FIRST, get DHCP IP, then deploy workers |
| **DHCP: Trusting terraform state IPs** | DHCP leases change, terraform doesn't know | Verify actual IP before SSH/API calls; user-provided IPs are truth |
| **Orphaned cloud resources** | $15-20+/day wasted | Pre-flight checks + verify teardown |
| Starting new deployment without state check | Creates duplicate resources | `terraform state list \| wc -l` must equal 0 |
| Skipping teardown after test completion | Accumulates costs overnight | Always destroy after each test run |

**CRITICAL: Cloud Resource Pre-Flight Check (MANDATORY before every deployment):**
```bash
# MUST verify 0 resources before terraform apply
cd terraform/<provider>
terraform state list | wc -l  # Must be 0

# If not zero, destroy first:
terraform destroy -auto-approve
terraform state list | wc -l  # Verify now 0
```

**Post-Teardown Verification:**
```bash
# ALWAYS verify after destroy
terraform state list | wc -l  # Must be 0
# If not 0, run destroy again
```

## Code/Automation Anti-Patterns

| Anti-Pattern | Why It Fails | Correct Approach |
|--------------|--------------|------------------|
| Waiting fixed time for cloud-init | May finish earlier or later | Check completion signal |
| Hardcoded DB password | Auto-generated | Get from container env |
| API v2 endpoints | Broken in 0.14.x | Use API v1 |
| Special chars in cloud-init passwords | YAML/shell escaping | Alphanumeric only |
| **Using `python3` on Windows** | Not found on Windows | Use `python` (Windows alias) |
| **Prompting user for SSH login** | Interrupts automation, bad UX | Use credentials from `.claude/.env` |
| **Not setting Python recursion limit** | Ubuntu 24.04 + Python 3.12 crashes | Add `sys.setrecursionlimit(50000)` to htpclient/__main__.py in cloud-init |

## Cloud Provider File Staging (CRITICAL)

**Problem:** Files staged to wrong location cause "ERR3 - file not present" errors.

**Root Cause:** Hashtopolis uses `StoredValue.directory_files` to find files:
```sql
SELECT val FROM StoredValue WHERE storedValueId = 'directory_files';
-- Returns: /usr/local/share/hashtopolis/files
```

**The Docker volume path `/var/www/hashtopolis/files/` is WRONG!**
Hashtopolis looks at `/usr/local/share/hashtopolis/files/` inside the container.

**CORRECT Staging Process:**
```bash
# 1. Upload files to server /tmp
scp rockyou.txt ubuntu@$SERVER_IP:/tmp/
scp OneRuleToRuleThemStill.rule ubuntu@$SERVER_IP:/tmp/

# 2. Copy INTO CONTAINER at the CORRECT path (use docker cp)
ssh ubuntu@$SERVER_IP "sudo docker cp /tmp/rockyou.txt hashtopolis-backend:/usr/local/share/hashtopolis/files/rockyou.txt"
ssh ubuntu@$SERVER_IP "sudo docker cp /tmp/OneRuleToRuleThemStill.rule hashtopolis-backend:/usr/local/share/hashtopolis/files/OneRuleToRuleThemStill.rule"

# 3. Fix ownership (use -u root, explicit filenames - glob expansion fails!)
ssh ubuntu@$SERVER_IP "sudo docker exec -u root hashtopolis-backend chown www-data:www-data /usr/local/share/hashtopolis/files/rockyou.txt /usr/local/share/hashtopolis/files/OneRuleToRuleThemStill.rule"

# 4. Verify files are in CORRECT location
ssh ubuntu@$SERVER_IP "sudo docker exec hashtopolis-backend ls -la /usr/local/share/hashtopolis/files/"

# 5. Register in File table with isSecret=1
# 6. Link to tasks via FileTask table (REQUIRED!)
```

**Test Download Works:**
```bash
# Get an agent token and test
TOKEN=$(ssh ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -sNe 'SELECT token FROM Agent LIMIT 1;'")
ssh ubuntu@$SERVER_IP "curl -s -o /tmp/test.txt 'http://localhost:8080/getFile.php?file=1&token=$TOKEN' && ls -la /tmp/test.txt"
# Should show full file size (139MB for rockyou.txt), NOT 10-400 bytes
```

**FileTask Linking (MANDATORY):**
```sql
-- Files won't download without FileTask entries!
INSERT INTO FileTask (fileId, taskId)
SELECT fileId, $TASK_ID FROM File WHERE filename IN ('rockyou.txt', 'OneRuleToRuleThemStill.rule');
```

## Cloud Provider Authentication

| Provider | Auth Method | NOT This |
|----------|-------------|----------|
| AWS | Environment vars: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | - |
| **Azure** | Azure CLI: `az login` (browser auth) | NOT ARM_* env vars |
| GCP | `gcloud auth application-default login` | - |
| OCI | OCI CLI config or env vars | - |

**Azure Authentication:**
```bash
# Login via browser (run once, persists)
az login

# Verify logged in
az account show

# Terraform will automatically use CLI credentials
```

## Cloud Provider VM Images

| Provider | Correct Image | NOT This |
|----------|---------------|----------|
| AWS | `ami-*` (region-specific Ubuntu 24.04) | - |
| Azure | `Canonical:ubuntu-24_04-lts:server:latest` | - |
| **GCP** | `ubuntu-os-cloud/ubuntu-2404-lts-amd64` | NOT `ubuntu-2404-lts` (missing `-amd64`) |
| OCI | `ocid1.image.*` (compartment-specific) | - |

## Cloud Provider SSH Keys

| Provider | SSH Key Location |
|----------|------------------|
| AWS | `~/.ssh/id_ed25519` (default) |
| **Azure** | `~/.ssh/azure_hashcrack` (specific!) |
| GCP | `~/.ssh/gcp_hashcrack` or `~/.ssh/google_compute_engine` |
| OCI | Check terraform.tfvars for configured key |

## Terraform IP Discovery (USE THIS)

**Never manually discover IPs** - use terraform output:

```bash
# AWS
SERVER_IP=$(terraform output -raw server_public_ip)
DB_PASS=$(terraform output -raw db_password)

# Azure
SERVER_IP=$(terraform output -raw server_public_ip)
DB_PASS=$(terraform output -raw db_password)

# GCP
SERVER_IP=$(terraform output -raw server_ip)
DB_PASS=$(terraform output -raw db_password)
```

## Attack Strategy Anti-Patterns

| Anti-Pattern | Why It Fails | Correct Approach |
|--------------|--------------|------------------|
| **Expecting parallel rule attacks** | hashcat -s (skip) doesn't work for rules | Accept 1 worker for rule attacks OR split wordlist |
| Overfitted masks (from cracked passwords) | Wastes compute on unlikely matches | Generic patterns only |
| Brute force 8+ chars without estimate | Takes too long | Calculate feasibility first |
| Single wordlist for all hash types | Misses cross-reference | Run cracked passwords against all types |
| Ignoring password policy | Attacks impossible passwords | Ask about policy first |

### CRITICAL: Rule Attacks Cannot Parallelize via Chunks

**Problem:** Hashtopolis creates chunks with skip values. hashcat's `-s` parameter skips WORDLIST ENTRIES, not keyspace positions. For rule attacks, skip=6B means "skip 6 billion words" but wordlist only has 14M words.

**Result:** Only chunk 0 (skip=0) works. Chunks with skip>0 fail with "Restore value is greater than keyspace."

**SCALABLE Solution (adapts to worker count changes):**
- **Use straight attack (no rules) for parallel keyspace** - Rules prevent chunk parallelization
- **Accept sequential rule processing** - One chunk at a time, all workers queue for chunk 0
- **Split HASHES not wordlists** - Create multiple hashlists, each worker attacks different hashes

**NON-SCALABLE (avoid for dynamic worker counts):**
- Split wordlist into N files - Doesn't adapt when workers scale up/down
- Pre-expand wordlist - Creates huge files, memory issues

**Recovery (if agents stuck in clientError with "Restore value is greater than keyspace"):**
```sql
-- 1. Clear Hash chunkId references for pending chunks
UPDATE Hash SET chunkId=NULL WHERE chunkId IN (SELECT chunkId FROM Chunk WHERE state=0);

-- 2. Delete pending chunks (skip > 0) - they will never work for rule attacks
DELETE FROM Chunk WHERE state=0;

-- 3. Mark tasks as complete (chunk 0 already processed the full wordlist)
UPDATE Task SET keyspaceProgress = keyspace;

-- 4. Clear assignments so agents can pick up new tasks
DELETE FROM Assignment;
```
This recovers agents from clientError state. Chunk 0 (skip=0) already processed the full wordlist with all rules.

## Benchmark/Chunk Anti-Patterns (CRITICAL)

| Anti-Pattern | Why It Fails | Correct Approach |
|--------------|--------------|------------------|
| Using `chunkSize` or `staticChunks` | Masks root cause, doesn't fix benchmark interpretation | Set correct `useNewBench` value |
| Using `useNewBench=1` with OLD format agents | Agents report `time:speed`, server expects `speed` only | Use `useNewBench=0` for OLD format |
| Not verifying chunk coverage | Tiny chunks = incomplete coverage | Check SUM(length) vs keyspace after first chunks |
| Changing useNewBench after task starts | Corrupts chunk calculation | Set correctly at task creation, or reset chunks |
| Assuming all providers benchmark same | Different agent versions report different formats | Verify benchmark format per provider |

**Benchmark Format Detection:**
```sql
-- Check what format agents report
SELECT agentId, benchmark FROM Agent WHERE isActive=1;
-- OLD format: "2672:24760.24" (time:speed) -> useNewBench=0
-- NEW format: "24760.24" (speed only) -> useNewBench=1
```

**MANDATORY VERIFICATION (after ~5 minutes of cracking):**
```sql
SELECT COUNT(*) as chunks, SUM(length) as covered,
       (SELECT keyspace FROM Task WHERE taskId=X) as target
FROM Chunk WHERE taskId=X;
-- covered MUST approach target. If covered << target, useNewBench is wrong
```

**Recovery (if chunks broken due to wrong useNewBench):**
```sql
-- MUST clear FK references BEFORE deleting chunks!
UPDATE Hash SET chunkId=NULL WHERE chunkId IN (SELECT chunkId FROM Chunk WHERE taskId=X);
DELETE FROM Chunk WHERE taskId=X;
UPDATE Task SET useNewBench=0, keyspaceProgress=0 WHERE taskId=X;  -- or useNewBench=1
DELETE FROM Assignment WHERE taskId=X;  -- Force agents to re-benchmark
-- Agents will re-benchmark and create correct chunks
```

## Recovery from Anti-Patterns

**Task stuck (wrong Assignment):**
```sql
DELETE FROM Assignment WHERE agentId = X;
UPDATE Chunk SET state = 0, agentId = NULL WHERE agentId = X;
```

**Workers destroyed with chunks in progress:**
```sql
UPDATE Chunk SET state = 0, agentId = NULL WHERE state IN (2, 4);
```

**Stale agents after worker rebuild:**
```sql
DELETE FROM Assignment WHERE agentId = OLD_ID;
UPDATE Agent SET isActive = 0 WHERE agentId = OLD_ID;
```

## Terraform State Lock Recovery (Windows)

**Problem:** "Error acquiring the state lock" or "Device or resource busy" on terraform.tfstate

**Root Cause:** Orphaned `terraform-provider-*` processes from interrupted terraform runs hold Windows file locks. These persist even after terraform.exe is killed.

**Detection:**
```bash
# Download Sysinternals Handle if needed
# Check what's holding terraform locks
handle64.exe -a "terraform" | head -20
# Look for terraform-provider-azurerm_v*.exe, terraform-provider-google_v*.exe, etc.
```

**Recovery:**
```powershell
# Create kill script: C:/temp/kill-terraform.ps1
$procs = Get-Process | Where-Object { $_.ProcessName -like '*terraform*' }
foreach ($p in $procs) {
    Write-Host "Killing $($p.ProcessName) (PID: $($p.Id))"
    Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
}
Write-Host "Done killing terraform processes"
```

```bash
# Run the kill script
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:/temp/kill-terraform.ps1"

# Then clean up state files
rm -f terraform.tfstate .terraform.tfstate.lock.info

# Re-initialize and run
terraform init
terraform apply
```

**Prevention:** When canceling terraform operations, always kill child processes:
```bash
# BEFORE canceling terraform
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:/temp/kill-terraform.ps1"
```

## Worker Taint Procedure (CRITICAL)

**Problem:** Tainting a worker destroys VM but leaves stale agent in Hashtopolis DB.

**CORRECT Procedure:**
```bash
# 1. Get worker name and agent ID BEFORE taint
WORKER_NAME="hashcrack-cpu-worker-1"
AGENT_ID=$(ssh ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -sNe \"SELECT agentId FROM Agent WHERE agentName='$WORKER_NAME';\"")

# 2. Archive stale agent in DB
ssh ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -e \"
DELETE FROM Assignment WHERE agentId=$AGENT_ID;
UPDATE Agent SET isActive=0 WHERE agentId=$AGENT_ID;
\""

# 3. NOW taint and apply
terraform taint 'google_compute_instance.cpu_workers[0]'
terraform apply -auto-approve

# 4. Wait for new worker to register with new agent entry
```
