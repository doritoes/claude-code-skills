# Hashcrack Skill Learnings

Accumulated learnings from testing and operation to improve future runs.

## CRITICAL GAP: Brute Force Not Working

**Status: MAJOR BLOCKER - Core functionality missing**

Brute force (mask) attacks are a core feature of distributed hash cracking. Currently:
- **createTask API v1**: Returns "Invalid query!" for all mask attacks
- **Database insertion**: Tasks don't dispatch (workPossible: false)
- **Manual UI creation**: Not tested due to time constraints

**Impact**: Without brute force, the skill can only run dictionary attacks. This limits crack rates to ~25-30% instead of potential 90%+ with exhaustive search.

**Required Fix**:
1. Test manual task creation in Hashtopolis UI to verify it works
2. If UI works, investigate what fields/state the UI sets that API doesn't
3. Consider upgrading to newer Hashtopolis version if API is broken
4. Document exact createTask parameters that work

**Workaround**: Use Hashtopolis UI to create mask/brute-force tasks manually after PAI deploys infrastructure.

## Deployment Issues

### Hashtopolis Password Hashing
**Format:** `bcrypt($PEPPER[1] + password + salt)`
- PEPPER: Server-side secret stored in config.json or generated during install
- salt: Per-user random string stored in `User.passwordSalt` column
- Cannot set password directly via SQL - must use Hashtopolis's Encryption class

**To reset password properly:**
1. Find PEPPER array in `/var/www/html/src/inc/config.json` or via PHP
2. Get user's salt from `User.passwordSalt`
3. Generate: `password_hash($PEPPER[1] . $password . $salt, PASSWORD_BCRYPT, ['cost' => 12])`
4. Update `User.passwordHash` with result

**Best Practice:** Set admin password via environment variable during deployment:
```yaml
HASHTOPOLIS_ADMIN_USER: hashcrack
HASHTOPOLIS_ADMIN_PASSWORD: <secure-password>
```

**CRITICAL:** Avoid special characters (`!@#$%^&*`) in passwords when using cloud-init.
Special chars cause YAML parsing/shell escaping issues, resulting in empty password.

**Default Credentials (set in terraform.tfvars):**
- Username: `hashcrack`
- Password: `Hashcrack2025Lab`

### Voucher Creation
**Problem:** Vouchers not created during server setup, causing agent registration failure.
**Solution:** Add voucher creation to cloud-init server.yaml:
```yaml
runcmd:
  - docker exec hashtopolis-db mysql -uhashtopolis -p$DB_PASSWORD hashtopolis -e "INSERT INTO RegVoucher (voucher, time) VALUES ('$VOUCHER', UNIX_TIMESTAMP());"
```

### API Key Creation
**Problem:** API key created with startValid=0, endValid=0 is expired.
**Solution:** Use proper timestamps:
```sql
INSERT INTO ApiKey (startValid, endValid, accessKey, accessCount, userId, apiGroupId)
VALUES (1, 2000000000, 'PAI_hashcrack_2025', 0, 1, 1);
```

### Agent Trust
**Problem:** Agents register but aren't trusted, can't receive work.
**Solution:** Auto-trust agents during registration via cloud-init or DB trigger:
```sql
UPDATE Agent SET isTrusted=1 WHERE isTrusted=0;
```

### SSH Host Keys
**Problem:** Host key changes when VMs are recreated at same IPs.
**Solution:** Clear host keys before connecting to new deployments:
```bash
ssh-keygen -R 192.168.99.X
```

## API Issues

### createTask API v1 Broken
**Problem:** API v1 createTask returns "Invalid query!" regardless of parameters.
**Root Cause:** Unknown - possibly missing hidden required fields.
**Workaround:** Create tasks directly in database with proper schema:
- TaskWrapper first (links to hashlist)
- Task second (references TaskWrapper)
- FileTask third (links files to task)

### Task Creation Schema
Required tables in order:
1. `TaskWrapper` - Links to hashlist, defines access group
2. `Task` - The actual attack job, references TaskWrapper
3. `FileTask` - Links wordlist files to task

## Cracking Optimization

### Intelligent Task Prioritization and Scheduling

**Key Insight:** The power of this skill is intelligent orchestration of attacks based on hash type speed and password reuse patterns.

#### Priority Hierarchy (higher number = runs first)

| Priority | Task Type | Description |
|----------|-----------|-------------|
| 150 | rockyou+OneRule | Primary attack on large wordlist + rules (multi-agent) |
| 140 | cracked+OneRule | Apply rules to already-cracked passwords (find variations) |
| 130 | Cross-reference | Cracked passwords against other hash types (password reuse) |
| 110 | top100k+OneRule | Smaller wordlist + rules |
| 80 | Basic Wordlist | Simple wordlist attacks |
| 70 | Brute Force | Exhaustive search (only when targeted) |
| 60 | Low-priority crossref | Background crossref tasks |
| 50 | Cleanup wordlists | Catch stragglers |

#### isSmall Flag Usage

| Task Type | isSmall | Reason |
|-----------|---------|--------|
| Small wordlists (<1M words) | 1 | Single agent sufficient |
| Cross-reference tasks | 1 | Small wordlist, high value |
| Large wordlists (rockyou) | 0 | Benefit from multiple agents |
| Brute force | 0 | Parallelization essential |

#### Attack Escalation Strategy

1. **Phase 1: Fast Hashes First**
   - Start with MD5, NTLM (fastest hash types)
   - Run rockyou+OneRule on all fast hashes in parallel
   - This builds the "cracked passwords" wordlist quickly

2. **Phase 2: Cross-Reference**
   - Extract cracked passwords as they're found
   - Immediately apply to ALL hash types (including slow ones)
   - Password reuse catches 30-40% of additional cracks

3. **Phase 3: Variation Attacks**
   - When plateaued, run cracked+OneRule
   - If "password123" was cracked, find "Password123!", "password1234", etc.

4. **Phase 4: Slow Hash Focus**
   - SHA512crypt, bcrypt are slow - crossref is most effective
   - Keep 1 agent on crossref for continuous password reuse detection
   - Other agents work on large wordlist+rule combinations

#### Worker Allocation

| Configuration | Agents | Strategy |
|---------------|--------|----------|
| 4 GPU workers | 3+1 | 3 on rockyou+OneRule, 1 on crossref |
| 8+ workers | 6+2 | 6 on large tasks, 2 on small/crossref |

**Key Insight:** Don't waste expensive GPU time on small wordlists. One worker can handle all small tasks; focus GPU power on large keyspaces.

#### Real-Time Monitoring Checks

1. **Every 2-5 minutes:**
   - Check cracked count per hashlist
   - Update crossref wordlist with new passwords
   - Verify all agents are actively working

2. **When plateaued:**
   - Create cracked+OneRule tasks (find variations)
   - Lower priority of stalled tasks
   - Consider mask attacks on fast hashes

3. **Chunk state verification:**
   - Don't trust keyspace progress - check `Chunk.state = 5` for completion
   - Abort low-priority chunks to free agents for high-value work

#### Dynamic Priority Adjustment

```sql
-- When stuck, reprioritize
UPDATE Task SET priority = 140 WHERE taskName LIKE '%cracked-OneRule%';
UPDATE TaskWrapper SET priority = 140 WHERE taskWrapperId IN
  (SELECT taskWrapperId FROM Task WHERE taskName LIKE '%cracked-OneRule%');
```

#### Cross-Reference Effectiveness (Test 5 AWS)

| Hash Type | Via Direct Attack | Via Cross-Reference |
|-----------|-------------------|---------------------|
| MD5 | 550/1250 (44%) | N/A (fast hash) |
| SHA512crypt | 3/1250 | 85/1250 (crossref found 96% of cracks!) |

**Lesson:** For slow hashes, crossref is MORE effective than direct wordlist attacks.

### Password Policy Awareness
**Ask the user about password policy!** This informs attack strategy:

| Platform | Typical Policy |
|----------|---------------|
| Unix/Linux | Often no policy, simple passwords possible |
| Windows AD | Min 8 chars, 3 of 4 classes (upper, lower, digit, symbol) |
| Legacy Windows | Min 6 chars, 2 of 3 classes |
| Web apps | Varies widely, often min 8 + complexity |

**Implications for attacks:**
- Windows: Skip pure lowercase attacks, focus on mixed patterns
- Unix: Include simple/short passwords in wordlists
- Pattern hints: "Ubuntu++" = dictionary + symbols (Unix-style)

### Standard Attack Strategy
**Primary Attack:** rockyou.txt + OneRule.rule
This combination is extremely powerful and should be the go-to strategy.

**CRITICAL:** Never declare "plateau" or "remaining hashes are complex" until rockyou+OneRule has COMPLETED on ALL hash types. Slow hashes (SHA512crypt, bcrypt) take hours, not minutes - this doesn't mean the attack is ineffective, just slower.

**Attack Order:**
1. **Fast hashes (MD5, NTLM):** rockyou + OneRule
2. **Cross-reference:** Extract cracked passwords, apply to slow hashes
3. **Targeted attacks:** Dictionary + rules for specific patterns (e.g., "Ubuntu++")
4. **Brute force:** Only when above fails, constrained by policy

**OneRule:** The famous rule file that combines best transformations.
Download: https://github.com/NotSoSecure/password_cracking_rules/blob/master/OneRuleToRuleThemAll.rule

### Cross-Reference Passwords
**Key Insight:** Same password often used across different hash types in same environment.
**Strategy:**
1. Crack fast hash types first (MD5, NTLM)
2. Extract cracked passwords
3. Create targeted wordlist
4. Apply to slow hash types (SHA512crypt, bcrypt)

### Hash Type Priorities
| Type | Mode | Speed | Priority |
|------|------|-------|----------|
| MD5 | 0 | Very Fast | High |
| NTLM | 1000 | Very Fast | High |
| SHA256 | 1400 | Fast | Medium |
| SHA512crypt | 1800 | Slow | Low |
| bcrypt | 3200 | Very Slow | Low |
| yescrypt | 13400 | Extremely Slow | Skip |

### yescrypt Limitation
**Mode 13400** - Hashcat v6.2.6 does NOT support yescrypt at all.
**Verified:** `hashcat --help | grep yescrypt` returns nothing.
**Impact:** yescrypt hashes cannot be cracked with Hashtopolis/hashcat.
**Alternative:** Use John the Ripper which has yescrypt support.
Recommend: Skip yescrypt in Hashtopolis workflows entirely.

## Anti-Patterns

### Manual Task Assignment
**Don't:** Manually assign agents to tasks/chunks via database.
**Do:** Let agents self-select based on priority and access groups.
**Root cause of stuck agents:**
- Creating tasks for unsupported hash types (e.g., yescrypt on hashcat)
- Agents get stuck trying to benchmark/run impossible tasks
- Other agents then can't pick up new work

**Prevention:**
1. Only create tasks for supported hash types
2. If an agent gets stuck, archive the task (not just the chunk)
3. Verify hash type support before creating tasks

### Autonomous Stale Chunk Cleanup
**Symptom:** Task shows 100% dispatch, 0% searched in UI despite being complete.
**Cause:** Chunks remain in state=2 (dispatched) when keyspace is fully searched.

**Detection Query:**
```sql
SELECT t.taskId, t.taskName, t.keyspace, t.keyspaceProgress
FROM Task t
WHERE t.keyspace > 0 AND t.keyspace = t.keyspaceProgress
AND EXISTS (SELECT 1 FROM Chunk c WHERE c.taskId = t.taskId AND c.state = 2);
```

**Autonomous Fix:**
```sql
-- Mark stale dispatched chunks as complete
UPDATE Chunk c
JOIN Task t ON c.taskId = t.taskId
SET c.state = 5, c.solveTime = UNIX_TIMESTAMP()
WHERE t.keyspace > 0 AND t.keyspace = t.keyspaceProgress AND c.state = 2;

-- Clean up assignments for completed tasks
DELETE FROM Assignment WHERE taskId IN (
  SELECT taskId FROM Task WHERE keyspace > 0 AND keyspace = keyspaceProgress
);
```

**Key Learning:** Run this check every 5 minutes during active cracking to free agents stuck on completed tasks.

### isSmall Flag Transition
When consolidating workers to a primary task:
1. Complete all small tasks first (mark chunks state=5)
2. Set primary task `isSmall = 0` to allow multi-agent work
3. Clean up assignments for completed tasks
4. Agents will auto-pick up chunks from the primary task

### Mid-Job Worker Scaling (Add Workers)
Real-world scenario: adding resources to meet a deadline.

**Procedure:**
1. Update terraform.tfvars with new worker count
2. Run `terraform apply`
3. Wait for cloud-init to complete (~3-5 min for GPU)
4. **Create vouchers** for new workers (originals consumed):
   ```sql
   INSERT INTO RegVoucher (voucher, time) VALUES
     ('VOUCHER_NAME', UNIX_TIMESTAMP()),
     ('VOUCHER_NAME', UNIX_TIMESTAMP());
   UPDATE Config SET value = '0' WHERE item = 'voucherDeletion';
   ```
5. Restart agent service if needed: `systemctl restart hashtopolis-agent`
6. **Trust new agents**:
   ```sql
   UPDATE Agent SET isTrusted = 1 WHERE isTrusted = 0;
   ```
7. New agents auto-pick up chunks from highest priority task

**Key Learning:** Vouchers are consumed on first use. When scaling up, create N new vouchers for N new workers.

### Full Agent Reassignment Procedure
When agents are stuck on stale tasks and need to move to a priority task:

```sql
-- 1. Abort stale chunks (frees agents)
UPDATE Chunk SET state = 4, agentId = NULL
WHERE taskId IN (stale_task_ids) AND state = 2;

-- 2. Archive completed tasks (prevents re-assignment)
UPDATE Task SET isArchived = 1 WHERE taskId IN (stale_task_ids);
UPDATE TaskWrapper SET isArchived = 1 WHERE taskWrapperId IN (
  SELECT taskWrapperId FROM Task WHERE taskId IN (stale_task_ids)
);

-- 3. Ensure target task allows multi-agent
UPDATE Task SET isSmall = 0 WHERE taskId = target_task_id;
```

**Then restart agents:**
```bash
for ip in $WORKER_IPS; do
  ssh ubuntu@$ip 'sudo systemctl restart hashtopolis-agent' &
done
wait
```

**Result:** Agents will reconnect, find their old chunks aborted, and pick up new chunks from the highest-priority unarchived task.

### Task Deletion
**Don't:** Try to delete tasks with foreign key relationships.
**Do:** Archive tasks (isArchived=1) instead of deleting.

### Worker Teardown Cleanup
When destroying workers, clean up ONLY the specific agents being removed:
```sql
-- Get agent IDs for destroyed workers (by hostname pattern)
SET @agent_ids = (SELECT GROUP_CONCAT(agentId) FROM Agent
                  WHERE agentName IN ('hashcrack-worker-1', 'hashcrack-worker-2', ...));

-- Clean up FK references for SPECIFIC agents only
-- ORDER MATTERS due to foreign key constraints!
DELETE FROM Speed WHERE agentId IN (@agent_ids);
DELETE FROM AccessGroupAgent WHERE agentId IN (@agent_ids);
DELETE FROM Zap WHERE agentId IN (@agent_ids);
UPDATE Chunk SET agentId = NULL WHERE agentId IN (@agent_ids);  -- UPDATE not DELETE
DELETE FROM AgentZap WHERE agentId IN (@agent_ids);
DELETE FROM Assignment WHERE agentId IN (@agent_ids);
DELETE FROM AgentStat WHERE agentId IN (@agent_ids);
DELETE FROM AgentError WHERE agentId IN (@agent_ids);
DELETE FROM HealthCheckAgent WHERE agentId IN (@agent_ids);
DELETE FROM Agent WHERE agentId IN (@agent_ids);  -- LAST - parent table
```

**Why precision matters:**
- Other agents may still be working if scaling down partially
- Tasks remain intact for when new workers are added
- Shotgun DELETE wipes all data including active agents

**Anti-patterns to avoid:**
- `DELETE FROM Agent;` - Wipes ALL agents
- `DELETE FROM Assignment;` - Breaks ALL task assignments
- `DELETE FROM Chunk;` - Loses ALL progress

**Correct approach:** Always use WHERE clause with specific agent IDs.

## Recommended Improvements

### 1. Server Cloud-Init
Add to server.yaml:
- Create voucher(s) in DB
- Create API key with valid dates
- Configure reusable vouchers (voucherDeletion=0)

### 2. Worker Cloud-Init
Add to worker.yaml:
- Use correct HTTP URL (not HTTPS)
- Wait for server API before registration
- Retry registration with backoff
- Pre-install common wordlists (rockyou.txt at /usr/share/wordlists/)
- Consider: `apt install wordlists` on Debian/Ubuntu

### 3. Automation Script
Create `hashcrack-init.sh` that:
- Creates API key
- Creates vouchers
- Trusts all agents
- Uploads common wordlists

### 4. Pretask Library
Create reusable pretasks:
- `Wordlist-rockyou` - Standard rockyou attack
- `Wordlist-custom` - Custom passwords
- `Rules-best64` - Wordlist + best64 rules
- `Mask-common` - Common password patterns

## AWS-Specific Issues

### IAM Permissions
**Problem:** Initial IAM policy missing `ec2:DescribeInstanceCreditSpecifications`.
**Cause:** Required for t3/t3a burstable instance types.
**Solution:** Add to IAM policy:
```json
{
    "Sid": "BurstableInstances",
    "Effect": "Allow",
    "Action": [
        "ec2:DescribeInstanceCreditSpecifications",
        "ec2:ModifyInstanceCreditSpecification"
    ],
    "Resource": "*"
}
```

### APIv2 for Frontend
**Problem:** Hashtopolis frontend (port 4200) requires APIv2.
**Solution:** Set `HASHTOPOLIS_APIV2_ENABLE: 1` in docker-compose.yml.
**Legacy Access:** Backend on port 8080 works without APIv2.

### Password Reset on AWS
Same as XCP-ng - password must be reset via bcrypt hash:
```bash
HASH=$(docker exec hashtopolis-backend php -r "echo password_hash(\"crackme123\", PASSWORD_BCRYPT);")
docker exec hashtopolis-db mysql -u hashtopolis -p$DB_PASSWORD hashtopolis \
  -e "UPDATE User SET passwordHash = '$HASH' WHERE username = 'hashcrack';"
```

### File Storage Path
**Problem:** Files uploaded to `/var/www/hashtopolis/files/` but Hashtopolis looks in `/usr/local/share/hashtopolis/files/`.
**Cause:** StoredValue `directory_files` set to different path than volume mount.
**Solution:** Copy files to correct location:
```bash
docker exec hashtopolis-backend cp /var/www/hashtopolis/files/* /usr/local/share/hashtopolis/files/
```

### Task Keyspace Issues
**Problem:** Tasks created with keyspace=1 or incorrect keyspace don't run properly.
**Cause:** Keyspace set manually instead of letting agent calculate.
**Solution:** Create tasks with `keyspace = 0` and let agent calculate on first run.

### Chunk Sizing for Slow Hashes (SHA512crypt, bcrypt)
**Problem:** Benchmark loop or micro-chunks (length=1) for slow hash + large wordlist tasks.
**Symptoms:**
- Agent logs show repeated "Benchmark task..." without "Start chunk..."
- Chunks created with `length=1` instead of proper sizes
- Speed shows 0 H/s or task never progresses

**Root Cause:** SHA512crypt benchmark takes too long, causing timeout or incorrect benchmark results.

**Solution:** Use `staticChunks=1` and `chunkSize=1000000` for slow hashes:
```sql
INSERT INTO Task (..., staticChunks, chunkSize, ...)
VALUES (..., 1, 1000000, ...);
```

**Also helpful:**
- Set `isSmall=1` for tasks that need to bypass benchmark issues
- Set `useNewBench=1` as alternative benchmark method

### rockyou+OneRule is THE Priority Attack
**Key Learning:** rockyou.txt + OneRule.rule is the most effective attack combination.

**Priority Rules:**
1. Run rockyou+OneRule on EVERY hash type to completion
2. Fast hashes (MD5, NTLM) complete in minutes
3. SHA512crypt with rockyou+OneRule takes ~37 hours per chunk at 108 H/s
4. Cross-reference is MORE effective for slow hashes (99% of SHA512crypt cracks)

**Time Estimates (single GPU, 108 H/s on SHA512crypt):**
- 1M chunk = ~2.5 hours (accounting for rules)
- Full rockyou (14.3M) = ~37 hours
- This is viable for overnight/multi-day audits

**If Stuck at 0% Progress:**
1. Check actual hashcat command: `ps aux | grep hashcat`
2. Verify wordlist file is correct (rockyou.txt not top100k.txt)
3. Check chunk length: `SELECT skip, length FROM Chunk WHERE taskId = X`
4. If length=1, recreate task with staticChunks=1, chunkSize=1000000

### Python RecursionError on AWS (Ubuntu 24.04 / Python 3.12)
**Problem:** Agent fails with `RecursionError: maximum recursion depth exceeded` in cookiejar.py.
**Cause:** Python 3.12 default recursion limit (1000) too low for Hashtopolis agent HTTP requests.
**Solution:** Increase to 10000 in systemd service:
```bash
ExecStart=/usr/bin/python3 -c "import sys; sys.setrecursionlimit(10000); exec(open('__main__.py').read())"
```
**Note:** 5000 still hits recursion errors; 10000 works reliably.

### Voucher Consumption Race Condition
**Problem:** Multiple workers trying to register consume voucher before others can use it.
**Cause:** `voucherDeletion=0` setting doesn't prevent race condition.
**Solution:** Create multiple copies of the same voucher:
```sql
INSERT INTO RegVoucher (voucher, time) VALUES
  ('VOUCHER_NAME', UNIX_TIMESTAMP()),
  ('VOUCHER_NAME', UNIX_TIMESTAMP()),
  ('VOUCHER_NAME', UNIX_TIMESTAMP());
-- Create N copies for N workers
```

### Spot Instance Quotas
**Problem:** `MaxSpotInstanceCountExceeded` error when adding GPU spot instances.
**Cause:** Default AWS account spot instance limits.
**Limits (us-east-1 defaults):**
- Standard instances: 5 vCPUs per instance family
- GPU instances (g4dn, p3): Often 0 until quota increase requested
**Solution:** Request quota increase via AWS Service Quotas console.

### Spot Instance Names
**Problem:** Spot instances show as "unnamed" in AWS console.
**Cause:** Tags are applied to spot request, not the instance.
**Solution:** Add `aws_ec2_tag` resource for spot instance tagging:
```hcl
resource "aws_ec2_tag" "spot_instance_name" {
  resource_id = aws_spot_instance_request.workers[count.index].spot_instance_id
  key         = "Name"
  value       = "worker-${count.index + 1}"
}
```

### AWS Test 1 Results (2026-01-04)
- Server: t3.medium, Worker: c5.large (CPU)
- Speed: ~8.77 MH/s on MD5 with rockyou + OneRule
- Cracked 1/4 test hashes:
  - `c53e479b03b3220d3d56da88c4cace20` = `P@$$w0rd`

## Session Statistics

### Test 2 Results (2025-12-31)
| Hash Type | Total | Cracked | Rate |
|-----------|-------|---------|------|
| MD5 | 10 | 9 | 90% |
| NTLM | 14 | 10* | 71% |
| SHA512crypt | 1 | 0 | 0% |
| yescrypt | 11 | 0 | 0% (unsupported) |

*NTLM: 9 via Hashtopolis + 1 verified locally (Ubuntu++)

**Cross-reference success:** Same 9 passwords cracked in both MD5 and NTLM.

### Test 3 Results - AWS Spot Instances (2026-01-05)
| Configuration | Value |
|--------------|-------|
| Server | t3.medium (on-demand) |
| Workers | 15 × c5.large (spot) |
| Cost Savings | ~70% vs on-demand |

| Hash Type | Total | Cracked | Rate |
|-----------|-------|---------|------|
| NTLM | 16 | 4 | 25% |

**Cracked Passwords:**
1. (empty) - Disabled accounts
2. Butterfly123! - word + digits + special
3. January2022 - month + year pattern
4. P@$$w0rd - l33t speak

## AWS Instance Type Comparison (Test 3)

### Cost-Effectiveness Analysis
| Instance Type | Role | Pricing | Effectiveness |
|--------------|------|---------|---------------|
| t3.medium | Server | On-demand ~$0.042/hr | ✅ Reliable, sufficient for orchestration |
| c5.large | CPU Worker (spot) | ~$0.03/hr (70% savings) | ✅ Best value for CPU cracking |
| g4dn.xlarge | GPU Worker (spot) | ~$0.16/hr (60% savings) | ❌ Account quota blocked |

### Spot Instance Recommendations
1. **Always use spot for workers** - 60-70% cost savings, acceptable interruption risk
2. **Use on-demand for server** - Needs stability for orchestration
3. **Request GPU quota increase BEFORE deployment** - Default quota is often 0
4. **CPU spot instances are most cost-effective** for dictionary + rule attacks

### GPU Spot Instance Blockers
- Default AWS accounts have 0 GPU spot vCPU quota
- Must request increase via Service Quotas console
- Allow 24-48 hours for quota approval
- Region matters: us-east-1 has best spot availability

## Critical API/Task Dispatch Issues (Test 3)

### createTask API v1 - Still Broken
**Problem:** `createTask` returns "Invalid query!" for ALL mask/brute-force attacks.
**Tested Parameters:**
- name, hashlistId, attackCmd, chunkTime, statusTimer, priority ❌
- Added: maxAgents, isCpuTask, isSmall, crackerBinaryId ❌
- Added: chunksize, benchmarkType, isCpuOnly ❌

**Working:** Wordlist attacks created via earlier sessions still function.
**Not Working:** New mask attacks (-a 3) cannot be created via API.

### Database-Created Tasks Don't Dispatch
**Problem:** Tasks inserted directly into database are visible in API but agents report "No task available!"
**Symptoms:**
- Task appears in `listTasks` API response
- Task appears in Hashtopolis UI
- `getTask` shows `workPossible: false`
- Agents continuously poll with "No task available!"

**Attempted fixes that DIDN'T work:**
1. Setting keyspace manually
2. Creating chunks manually
3. Setting TaskWrapper priority to 100
4. Creating new TaskWrapper
5. Setting staticChunks=1
6. Restarting agents

**Root Cause:** Unknown - likely missing internal state that API sets during task creation.

### Pretasks and Supertasks - DO NOT USE
**Problem:** Pretasks and supertasks have never worked in this lab environment.
**Recommendation:** Avoid entirely. Use direct task creation only.

### What DOES Work
1. **Wordlist attacks** - Created in earlier sessions, work perfectly
2. **OneRule attacks** - `#HL# wordlist.txt -r onerule.rule` works
3. **Agents dispatch correctly** for existing tasks
4. **File uploads via API** - Work reliably
5. **Hashlist creation via API** - Works reliably

**IMPORTANT CLARIFICATION:** The high crack rates in Test 2 (90% MD5, 71% NTLM) were achieved
through **wordlist + OneRule**, NOT brute force. All cracked passwords (Butterfly123!,
returnofthejedi, J@sonHouse, etc.) match patterns that OneRule would find via dictionary
transformations. Brute force attacks were never successfully created in any test.

### What DOESN'T Work
1. **createTask API for new tasks** - Always fails with "Invalid query!"
2. **Mask/brute-force attacks via API** - Can't create via API
3. **Database-inserted tasks** - Don't dispatch to agents (workPossible: false)
4. **Pretasks/Supertasks** - Never functional in this environment

### Brute Force Status
**Brute force (mask) attacks have NEVER been successfully created via API or database.**
- Test 2: High crack rates were from rockyou + OneRule (dictionary attacks)
- Test 3: Attempted to create mask attacks, all methods failed
- Manual UI creation was not tested due to time constraints
- The API limitation means automated brute force deployment is not possible

## Recommended Workflow (Based on Test 3)

### For Reliable Cracking
1. **Deploy infrastructure** (server + spot workers)
2. **Upload wordlists and rules** via API (works)
3. **Create hashlist** via API (works)
4. **Create wordlist+rules task via UI** (only reliable method for new tasks)
5. **Trust agents** via database
6. **Monitor progress**

### Attack Priority (CPU Workers)
| Priority | Attack Type | Expected Results |
|----------|-------------|------------------|
| 1 | Wordlist (rockyou) | Fast, catches common passwords |
| 2 | Wordlist + OneRule | Catches mutations |
| 3 | Wordlist + best64 | Lighter rule set |
| 4 | UI-created mask attacks | If API ever fixed |

### Brute Force - Not Viable via API
Until createTask API is fixed, brute force attacks require:
- Manual task creation in Hashtopolis UI
- Or fixing the underlying Hashtopolis API bug

### Key Finding: yescrypt Broke Workflow
Creating a task for unsupported hash type (yescrypt mode 13400) caused:
1. Agent 4 got stuck trying to benchmark
2. Agent went inactive (isActive=0)
3. Remaining agents busy with long tasks
4. New tasks couldn't auto-dispatch

**Lesson:** Always verify hash type support before creating tasks.

### Verified Passwords
1. Butterfly123!
2. returnofthejedi
3. J@sonHouse
4. sillywombat11
5. January2022
6. P@$$w0rd
7. Ewug4
8. ieMuth6
9. covidsucks
10. Ubuntu++ (NTLM only, verified locally)

### Remaining Hashes
- MD5: `2f43b4850a2ecd83471d7e938d54a636` (1 remaining - hint: 8 chars alphanumeric)
- NTLM: 4 remaining (includes 31d6cfe0d16ae931b73c59d7e0c089c0 = empty password)
- SHA512crypt: `$6$2RHYtP04uMlJVCrA$...` (ubuntu user - password unknown)
- yescrypt: 11 hashes - cannot crack with hashcat, need John the Ripper

## Test 4 Results - XCP-ng Brute Force (2026-01-06)

### Session Summary
- **Platform:** XCP-ng local lab
- **Duration:** ~75 minutes (including troubleshooting)
- **Goal:** Learn brute force task creation for 6-char MD5 hashes
- **Result:** 49/50 hashes cracked (98%), 1 hash >6 chars

### Brute Force Task Creation - WORKING METHOD

**CRITICAL DISCOVERY:** Database task insertion DOES work for brute force!

**Working SQL pattern:**
```sql
INSERT INTO TaskWrapper (priority, maxAgents, taskType, hashlistId, accessGroupId, taskWrapperName, isArchived, cracked)
VALUES (10, 0, 0, HASHLIST_ID, 1, 'brute6', 0, 0);
SET @tw = LAST_INSERT_ID();

INSERT INTO Task (
  taskName, attackCmd, chunkTime, statusTimer, keyspace, keyspaceProgress,
  priority, maxAgents, color, isSmall, isCpuTask, useNewBench, skipKeyspace,
  crackerBinaryId, crackerBinaryTypeId, taskWrapperId, isArchived, notes,
  staticChunks, chunkSize, forcePipe, usePreprocessor, preprocessorCommand
)
VALUES (
  'brute6', '#HL# -a 3 ?a?a?a?a?a?a', 600, 5, 0, 0,
  10, 0, '00A000', 0, 1, 0, 0,
  1, 1, @tw, 0, 'brute force 6-char',
  0, 0, 0, 0, ''
);
```

**Key parameters:**
- `attackCmd`: `#HL# -a 3 ?a?a?a?a?a?a` (hashlist placeholder + mask)
- `isCpuTask`: 1 for CPU workers
- `priority`: >= 10
- `crackerBinaryId`: 1 (hashcat)
- Leave `keyspace = 0` - agents calculate automatically

### Hashlist Upload - WORKING METHOD

**Requires base64 encoding + source:inline:**
```bash
HASH_DATA=$(base64 -w0 hashlist.txt)
curl -X POST http://SERVER:8080/api/user.php \
  -H 'Content-Type: application/json' \
  -d "{
    \"section\": \"hashlist\",
    \"request\": \"createHashlist\",
    \"accessKey\": \"API_KEY\",
    \"name\": \"hashlist-name\",
    \"isSalted\": false,
    \"isSecret\": true,
    \"isHexSalt\": false,
    \"separator\": \":\",
    \"format\": 0,
    \"hashtypeId\": 0,
    \"accessGroupId\": 1,
    \"source\": \"inline\",
    \"data\": \"$HASH_DATA\",
    \"useBrain\": false
  }"
```

### Critical Deployment Issues Found

#### 1. Voucher Not Created
**Problem:** Terraform creates voucher variable but doesn't insert into DB.
**Impact:** All workers fail to register.
**Fix Required:** Add to server cloud-init:
```sql
INSERT INTO RegVoucher (voucher, time) VALUES ('VOUCHER', UNIX_TIMESTAMP());
UPDATE Config SET value = '0' WHERE item = 'voucherDeletion';
```

#### 2. Single Voucher Consumed
**Problem:** Voucher deleted after first use, other workers can't register.
**Fix:** Disable voucher deletion + create multiple vouchers.

#### 3. Worker Registration Not Verified
**Problem:** PAI proceeded without confirming all 4 workers registered.
**Impact:** Worker 4 was zombie for entire session - wasted resources.
**Fix Required:** Add verification step:
```bash
# Wait until expected agent count reached
while [ $(mysql ... "SELECT COUNT(*) FROM Agent") -lt $WORKER_COUNT ]; do
  sleep 15
done
```

#### 4. SSH Host Key Conflicts
**Problem:** Reused IPs have stale host keys in known_hosts.
**Fix:** Clear before deployment:
```bash
for ip in $WORKER_IPS; do ssh-keygen -R $ip 2>/dev/null; done
```

### Skill Improvements Required

**Priority 1 - Deploy Workflow:**
1. Add voucher creation + disable deletion to server cloud-init
2. Create N vouchers for N workers
3. Add worker registration verification loop
4. Only proceed after ALL workers registered and trusted

**Priority 2 - Monitoring:**
1. Verify agent count matches worker count before creating tasks
2. Alert if any workers are "zombie" (not registered)
3. Auto-fix common issues (voucher missing, agent untrusted)

**Priority 3 - Task Creation:**
1. Use database insertion for brute force (API unreliable)
2. Use API only for hashlists and file uploads
3. Document working command formats

### Performance Results

| Metric | Value |
|--------|-------|
| Hashes | 50 MD5 |
| Cracked | 49 (98%) |
| Time | ~25 min active cracking |
| Workers | 3 active (4th zombie) |
| Speed | ~215 MH/s aggregate |
| Keyspace | 81,450,625 (95^4 chunks) |

## Test 5 Results - AWS GPU Workers (2026-01-06/07)

### Session Summary
- **Platform:** AWS us-east-1
- **Server:** t3.medium (on-demand)
- **Workers:** 4 × g4dn.xlarge GPU (on-demand, NOT spot)
- **Hash Types:** MD5, SHA1, SHA256, NTLM, SHA512crypt (1250 each = 6250 total)
- **Duration:** Multi-hour session with intelligent task orchestration

### Final Results

| Hash Type | Cracked | Total | Rate |
|-----------|---------|-------|------|
| MD5 | 561 | 1250 | 44.9% |
| NTLM | 553 | 1250 | 44.2% |
| SHA1 | 538 | 1250 | 43.0% |
| SHA256 | 525 | 1250 | 42.0% |
| SHA512crypt | 142+ | 1250 | 11.4%+ |
| **TOTAL** | **2319+** | **6250** | **37.1%+** |

### Key Learnings

#### 1. GPU Workers: Use On-Demand, Not Spot
- GPU spot instances have quota issues and availability problems
- On-demand provides stability for critical cracking jobs
- Cost difference is acceptable for reliability

#### 2. Cross-Reference Effectiveness
- 99% of SHA512crypt cracks came from password reuse detection
- Fast hash → crossref → slow hash is the optimal pattern
- Always implement cross-reference attacks in multi-hash audits

#### 3. Chunk Sizing for Slow Hashes
For SHA512crypt/bcrypt tasks with large wordlists:
```sql
staticChunks = 1
chunkSize = 1000000
```
Without this, Hashtopolis creates micro-chunks (length=1) causing 0% progress.

#### 4. Autonomous Task Management
- Run stale chunk cleanup every 5 minutes
- Archive completed tasks to prevent re-assignment
- Restart agents after chunk abort to force reassignment
- Consolidate all workers to priority task when small tasks complete

#### 5. Never Declare Plateau Prematurely
- rockyou+OneRule is THE primary attack
- Must complete on ALL hash types before concluding
- Slow hashes take hours, not minutes - patience required

### GPU Performance (g4dn.xlarge / Tesla T4)

| Hash Type | Speed per GPU | Combined (4 GPU) |
|-----------|---------------|------------------|
| SHA512crypt | ~107-130 H/s | ~465 H/s |
| Time for 14M keyspace | ~37 hours | ~8.5 hours |

### Attack Orchestration Pattern

1. **Phase 1:** rockyou+OneRule on fast hashes (MD5, NTLM, SHA1, SHA256)
2. **Phase 2:** Extract cracked passwords → create crossref wordlist
3. **Phase 3:** Crossref attack on ALL hash types (especially slow ones)
4. **Phase 4:** rockyou+OneRule on slow hashes (SHA512crypt)
5. **Phase 5:** cracked+OneRule for password variations

### hashcat --keyspace vs --total-candidates (NOT A BUG)

**CLARIFICATION: This is NOT a hashcat bug - it's intentional behavior.**

Initial investigation suggested hashcat had a keyspace calculation bug, but further testing revealed:

| Command | Returns | Value for `?a?a?a?a?a?a` |
|---------|---------|--------------------------|
| `--keyspace` | Base keyspace for parallelization | 81,450,625 (95^4) |
| `--total-candidates` | Actual search space | 735,091,890,625 (95^6) |

**Why different values?**
- `--keyspace`: Returns base keyspace used for chunk distribution and parallelization
- `--total-candidates`: Returns actual number of password candidates to try

**Verification - hashcat DOES search full keyspace:**
```bash
hashcat -m 0 -a 3 hash.txt "?a?a?a?a?a?a"
# Progress.........: 2,448,171,008/735,091,890,625 (0.33%)
#                    ^ Shows full 735B search space
```

**What this means:**
- hashcat correctly searches all 735B candidates for 6-char ?a mask
- 49/50 cracks (98%) was legitimate - those passwords appeared early in keyspace
- `beachV` not cracked because its hash position is later in the 735B keyspace

**Hashtopolis Progress Tracking Issue:**
The confusion arose because Hashtopolis uses `--keyspace` output (81M) for progress tracking
instead of `--total-candidates` (735B). This makes the UI show misleading progress percentages.

**Recommendation:** When using Hashtopolis for mask attacks:
- Don't trust the "keyspace exhausted" progress in UI
- Monitor actual chunk completion and cracked count instead
- Long mask attacks may appear "complete" in UI but still be running

### Progress Reporting for Slow Hashes (SHA512crypt, bcrypt)

**Issue:** Hashtopolis shows 0% "searched" despite active GPU work.

**Example:**
- Portal shows: `dispatched: 41.83% / searched: 0.00%`
- Database shows: `keyspaceProgress = 6,000,000 / 14,344,384`
- Chunks show: `state=2 (DISPATCHED), progress=0, speed=109-138`

**Why this happens:**
1. SHA512crypt is extremely slow (~130 H/s per T4 GPU)
2. With staticChunks, each chunk = 1,000,000 keyspace units
3. At 130 H/s, one chunk takes ~2.1 hours to complete
4. Hashtopolis only updates "searched" % at checkpoints or chunk completion
5. Until first chunk completes, "searched" stays at 0%

**How to verify work is happening:**
```bash
# Check chunk speed values (should be non-zero)
SELECT chunkId, progress, speed, agentName FROM Chunk c
JOIN Agent a ON c.agentId = a.agentId WHERE taskId = X;

# Check GPU utilization on workers
nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader
# Should show 99%
```

**Metrics that DO update during slow hash cracking:**
- `keyspaceProgress` - increments when chunks are dispatched
- `speed` in Chunk table - shows current cracking speed
- GPU utilization on workers - should be 99%
- `cracked` count - updates when passwords found

**Metrics that DON'T update until chunk completion:**
- `progress` in Chunk table - stays 0 until checkpoint
- "searched" percentage in UI - stays 0 until chunks finish

**ETA calculation for slow hashes:**
```
Remaining keyspace = total keyspace - keyspaceProgress
Combined speed = sum of all chunk speeds
ETA = remaining keyspace / combined speed / 3600 hours
```

Example with 6 GPU workers on SHA512crypt:
- Remaining: 8,344,384 keyspace units
- Combined speed: ~780 H/s (6 workers × 130 H/s)
- ETA: 8,344,384 / 780 / 3600 = ~3 hours

### Mid-Job Worker Scaling (Tested Successfully)

**Scenario:** Adding more workers mid-job to meet deadline.

**Procedure:**
1. Update `terraform.tfvars` with new worker count
2. Run `terraform apply` - new workers deploy in parallel
3. Wait for cloud-init (~3-5 min for GPU workers)
4. **CRITICAL: Create vouchers for new workers** - originals consumed:
   ```sql
   INSERT INTO RegVoucher (voucher, time) VALUES
     ('VOUCHER_NAME', UNIX_TIMESTAMP()),
     ('VOUCHER_NAME', UNIX_TIMESTAMP());
   UPDATE Config SET value = '0' WHERE item = 'voucherDeletion';
   ```
5. Fix agent startup issues if needed:
   ```bash
   # Enable and start service
   sudo systemctl enable hashtopolis-agent
   sudo systemctl start hashtopolis-agent
   # Clear lock file if exists
   sudo rm -f /opt/hashtopolis-agent/lock.pid
   ```
6. **Trust new agents:**
   ```sql
   UPDATE Agent SET isTrusted = 1 WHERE isTrusted = 0;
   ```
7. New agents auto-pick up chunks from highest priority task

**Validated Result:** Scaled from 4 to 6 GPU workers mid-job. All 6 running at 99% GPU utilization within 10 minutes of terraform apply.

### Autonomous Stale Chunk Cleanup

**Pattern:** Tasks showing "100% dispatched / 0% searched" with actual 0 cracked.

**Detection:**
```sql
-- Find stale tasks (100% dispatched but no progress)
SELECT t.taskId, t.taskName, t.keyspace, t.keyspaceProgress,
       (SELECT COUNT(*) FROM Chunk WHERE taskId = t.taskId AND state IN (2,4)) as stale_chunks
FROM Task t
WHERE t.keyspaceProgress = t.keyspace
  AND t.keyspace > 0
  AND EXISTS (SELECT 1 FROM Chunk WHERE taskId = t.taskId AND state IN (2,4));
```

**Cleanup procedure:**
```sql
-- Mark stale chunks as completed
UPDATE Chunk SET state = 5 WHERE taskId = X AND state IN (2, 4);

-- Archive the task (if truly complete)
UPDATE Task SET isArchived = 1 WHERE taskId = X;
UPDATE TaskWrapper SET isArchived = 1
WHERE taskWrapperId = (SELECT taskWrapperId FROM Task WHERE taskId = X);
```

**When to run:** After any worker restart, scaling event, or when portal shows 100%/0% mismatch.

## Cloud Provider SSH Key Requirements

| Provider | Key Types Supported | Notes |
|----------|---------------------|-------|
| XCP-ng | ed25519, RSA | Any standard SSH key |
| AWS | ed25519, RSA | Both work |
| Azure | **RSA only** | ed25519 NOT supported |
| GCP | ed25519, RSA | Both work |

**Azure RSA key generation:**
```bash
ssh-keygen -t rsa -b 4096 -f ~/.ssh/azure_hashcrack -N "" -C "hashcrack-azure"
```

Store separate keys per provider in terraform.tfvars or use RSA universally.

## CRITICAL: Test Objectives Before Scaling

### Test 5 Failure - Lost Test Objective

**Original objective:** Verify brute force task creation works (pending since Test 3)

**What happened instead:**
1. Jumped straight to 4 GPU workers
2. Created impossible SHA512crypt+OneRule attack (196,000 years)
3. Added 2 more GPU workers when progress stalled
4. Destroyed server before testing brute force

**Impact:** Brute force task creation is STILL unverified after 3 test sessions.

**Correct approach for next deployment:**
1. Deploy server + 1 CPU worker only
2. Create simple brute force task (6-char mask on MD5)
3. Verify task dispatches and completes
4. ONLY THEN scale up workers
5. ONLY THEN add complex attacks

**Never scale workers before core functionality is verified.**

## CRITICAL: Attack Feasibility Calculations (MUST DO BEFORE CREATING TASKS)

### The Costly Mistake (Test 5)

**What happened:** Created rockyou+OneRule task for SHA512crypt without calculating feasibility. Recommended adding more GPU workers when the attack was fundamentally impossible. Wasted hours and GPU costs.

**The math I should have done BEFORE creating the task:**

```
Attack: rockyou.txt + OneRule.rule on SHA512crypt
- rockyou.txt: 14.3M words
- OneRule.rule: 52,014 rules
- Total candidates: 14.3M × 52K = 744 TRILLION candidates
- SHA512crypt speed (T4 GPU): ~120 H/s
- Time for 1 GPU: 744T / 120 = 6.2 trillion seconds = 196,000 YEARS
- Time for 6 GPUs: 196,000 / 6 = 32,700 YEARS
```

**The chunking didn't help:**
```
- Chunk size: 1M words
- Candidates per chunk: 1M × 52K rules = 52 BILLION
- Time per chunk (6 GPUs @ 720 H/s): 52B / 720 = 72M seconds = 2.3 YEARS
```

### Mandatory Pre-Task Calculation

**BEFORE creating any task, calculate:**

```
Time = (wordlist_lines × rule_count) / hash_speed / num_workers / 3600
```

**Reference speeds (per T4 GPU):**
| Hash Type | Speed | 24hr Capacity |
|-----------|-------|---------------|
| MD5 | ~25 GH/s | 2.16 quadrillion |
| NTLM | ~20 GH/s | 1.73 quadrillion |
| SHA1 | ~8 GH/s | 691 trillion |
| SHA256 | ~3 GH/s | 259 trillion |
| SHA512crypt | ~120 H/s | 10.4 million |
| bcrypt | ~25 KH/s | 2.16 billion |

**Rule file sizes:**
| Rule File | Rules | Multiplier |
|-----------|-------|------------|
| best64.rule | 77 | 77× |
| d3ad0ne.rule | 34,101 | 34K× |
| OneRule.rule | 52,014 | 52K× |
| rockyou-30000.rule | 30,000 | 30K× |

### Feasibility Matrix (24-hour window, 4 GPUs)

| Attack | MD5 | SHA512crypt |
|--------|-----|-------------|
| rockyou (14M) | ✅ <1 sec | ✅ 13 hours |
| rockyou + best64 (1.1B) | ✅ <1 sec | ❌ 42 days |
| rockyou + OneRule (744T) | ✅ 31 sec | ❌ 196,000 years |
| top100k + OneRule (5.2B) | ✅ <1 sec | ❌ 150 days |
| 6-char brute (95^6=735B) | ✅ 31 sec | ❌ 23,000 years |

### Viable SHA512crypt Attacks (24-hour, 4 GPUs)

| Attack | Candidates | Time | Viability |
|--------|------------|------|-----------|
| rockyou (no rules) | 14M | 13 hr | ✅ |
| top100k (no rules) | 100K | 6 min | ✅ |
| Cross-reference (cracked) | <10K | <1 min | ✅ BEST |
| Custom wordlist | <1M | <1 hr | ✅ |
| rockyou + best64 | 1.1B | 42 days | ❌ |

### Key Insight: Cross-Reference is King for Slow Hashes

In Test 5, cross-reference cracked 99% of SHA512crypt hashes:
- Fast hashes cracked ~550 passwords each
- Cross-reference wordlist: ~550 passwords
- 550 × 1 (no rules) = 550 candidates
- Time: <1 second
- Result: 141/142 SHA512crypt cracks

**For slow hashes, ALWAYS prioritize:**
1. Cross-reference from fast hash cracks
2. Small targeted wordlists (no rules)
3. Accept lower crack rates rather than impossible attacks

### Decision Framework

Before recommending more workers, ask:
1. What is the total candidate count? (wordlist × rules)
2. At current speed, how long to complete?
3. Is completion possible in the audit window?
4. Would 10× more workers make it feasible? 100×?

**If the answer to #3 is "no" and #4 is still "no":**
- Do NOT add workers
- Change the attack strategy
- Use smaller wordlist or fewer/no rules
- Accept current crack rate as maximum

### Red Flags That Should Trigger Calculation Review

1. Progress stuck at 0% for >30 minutes on any hash type
2. Chunk duration >2 hours
3. Any task with large rule file (>1000 rules) on slow hash
4. User asking to add workers to "speed up" slow task

## Roadmap

### John the Ripper Integration (HIGH PRIORITY)

**Why needed:**
- yescrypt (Ubuntu 24.04 default) not supported by hashcat
- JtR has different performance characteristics for some hash types
- JtR's incremental mode is more flexible than hashcat masks
- Can run locally without Hashtopolis overhead

**Implementation:**
- Create wrapper scripts for JtR
- Auto-detect hash types that should route to JtR
- Support hybrid mode: fast hashes to Hashtopolis, slow/unsupported to JtR
- Store results in same format for unified reporting

**Target hash types for JtR:**
- yescrypt ($y$)
- scrypt ($7$)
- SHA512crypt (as alternative to Hashtopolis for small jobs)
- bcrypt (when attack is small enough for local processing)

### Other Roadmap Items

1. **Pre-task feasibility calculator** - Mandatory check before task creation
2. **Attack recommendation engine** - Suggest viable attacks based on hash type and time window
3. **Cost estimator** - Show estimated cloud costs before deployment
4. **Progress anomaly detection** - Alert when progress doesn't match expected rate
5. **Automatic attack escalation** - Start simple, only escalate if time permits

## Azure-Specific Issues (Test 6/7 - 2026-01-07)

### Test 7 Results (Successful with D2s_v3, Failed with F4s_v2)
- **Platform:** Azure eastus2
- **Server:** Standard_D2s_v3 (2 vCPU, 8 GB)
- **Workers:** 4 × Standard_D2s_v3 CPU workers
- **Hashes:** 5000 MD5
- **Cracked (rockyou):** 1081/5000 (21.6%)
- **Cracked (rockyou+OneRule):** 1955/5000 (39.1%)
- **Speed:** ~380 MH/s combined (4 CPU workers) - ~26 MH/s with rules

**Test 7 Failure - F4s_v2 Not Available:**
- Attempted to scale to Standard_F4s_v2 workers
- Azure returned: `SkuNotAvailable: Standard_F4s_v2 is currently not available in location 'eastus2'`
- Terraform destroyed server during failed apply (lost cracking progress temporarily)
- **Lesson:** F-series VMs have capacity restrictions - ALWAYS use D-series as default

**rockyou+OneRule Performance:**
- 4 × D2s_v3 = 8 vCPU total
- Speed with rules: ~26 MH/s (vs ~380 MH/s without rules)
- Found 874 additional passwords (1081 → 1955)
- **Lesson:** Always run rockyou+OneRule - it's the primary attack

### Azure VM Recommendations

**CRITICAL: F-series VMs often unavailable in eastus2 due to capacity restrictions!**

| Role | VM Size | Cores | Status | Notes |
|------|---------|-------|--------|-------|
| Server | Standard_D2s_v3 | 2 | **VERIFIED** | Reliable, always available |
| CPU Worker | Standard_D2s_v3 | 2 | **VERIFIED** | Best choice - always available |
| CPU Worker (alt) | Standard_D4s_v3 | 4 | Available | If D-series quota permits |
| GPU Worker | Standard_NC4as_T4_v3 | 4+T4 | **Quota = 0** | Requires paid subscription + quota request |

**VM Families Tested in eastus2:**
| Family | Availability | Notes |
|--------|--------------|-------|
| Standard_D2s_v3 | **AVAILABLE** | Use this for CPU workers |
| Standard_D4s_v3 | **AVAILABLE** | 4 vCPU option |
| Standard_F4s_v2 | **NOT AVAILABLE** | Capacity restrictions - DO NOT USE |
| Standard_F2as_v6 | May be available | AMD variant, test first |
| Standard_NC4as_T4_v3 | Quota = 0 | Free trial cannot request GPU quota |

**Per-Family Quota Limit: 10 cores** (standardDSv3Family, standardFSv2Family, etc.)

**Practical CPU Worker Limits (D-series):**
- 5 × Standard_D2s_v3 (2 vCPU each = 10 cores)
- OR 2 × Standard_D4s_v3 (4 vCPU each = 8 cores)

### GPU Quota Requirements (CRITICAL)

**Free Trial Limitation:**
- Free trials are NOT eligible for GPU quota increases
- Must upgrade to Pay-As-You-Go before requesting GPU quota
- GPU families (NCASv3_T4, etc.) default to 0 quota

**Quota Request Process:**
1. Azure Portal → Search "Quotas" → Compute
2. Filter: Location = your region, search "NCASv3_T4"
3. Click row → "Request quota increase"
4. Enter new limit (4 for 1 VM, 8 for 2 VMs)
5. Provide justification
6. Wait 24-48 hours for approval

### Session Summary (Test 6)

### Core Quota Structure
Azure has TWO quota limits:
- **Total Regional vCPU:** 60 cores (Pay-As-You-Go)
- **Per-Family vCPU:** 10 cores each (standardDSv3Family, standardFSv2Family, etc.)

**To maximize 60 cores, must use 6 different VM families.**

### Available VM Families for CPU Cracking
| Family | Quota | VM Size | Cores/VM | Max VMs |
|--------|-------|---------|----------|---------|
| standardDSv3Family | 10 | Standard_D2s_v3 | 2 | 5 |
| StandardFasv6Family | 10 | Standard_F2as_v6 | 2 | 5 |
| standardDv3Family | 10 | Standard_D2_v3 | 2 | 5 |
| standardESv3Family | 10 | Standard_E2s_v3 | 2 | 5 |
| standardDSv4Family | 10 | Standard_D2s_v4 | 2 | 5 |
| standardBSFamily | 10 | Standard_B2s | 2 | 5 |

**Multi-family terraform would be required to use full 60-core quota.**

### SSH Key Requirements (CRITICAL)
**Azure does NOT support ed25519 keys - must use RSA!**

```bash
# Generate Azure-compatible key
ssh-keygen -t rsa -b 4096 -f ~/.ssh/azure_hashcrack -N "" -C "hashcrack-azure"
```

### Worker Private IP Strategy (Correct)
Workers correctly deploy with private IPs only:
- Reduces cost (no public IP charge)
- Improves security
- Workers communicate with server via private network
- SSH to workers via server as jump host: `ssh -J ubuntu@SERVER ubuntu@WORKER_PRIVATE_IP`

### Voucher Consumption Fix (CRITICAL - Do This EARLY!)
**Problem:** Voucher consumed by first worker, others can't register.

**Fix - Add to server cloud-init or immediately after deploy:**
```sql
-- Disable voucher deletion (make reusable)
UPDATE Config SET value = '0' WHERE item = 'voucherDeletion';

-- Create multiple vouchers (N for N workers)
INSERT INTO RegVoucher (voucher, time) VALUES
  ('YOURPAIVOUCHER', UNIX_TIMESTAMP()),
  ('YOURPAIVOUCHER', UNIX_TIMESTAMP()),
  ('YOURPAIVOUCHER', UNIX_TIMESTAMP()),
  ('YOURPAIVOUCHER', UNIX_TIMESTAMP());
```

**This must happen BEFORE workers try to register!**

### cpuOnly / isCpuTask Matching
For CPU workers using PoCL (Portable OpenCL):
```sql
-- Set agent as CPU-only
UPDATE Agent SET cpuOnly = 1;

-- Task must have matching flag
UPDATE Task SET isCpuTask = 1;
```
If these don't match, tasks won't dispatch to agents.

### "No Hashes Loaded" Error (CRITICAL - Root Cause Found)
**Root Cause:** Hashes inserted directly to database don't create proper hash files.

**Symptoms:**
- Agent errors show "No hashes loaded"
- Chunks abort with state=4
- keyspace=1 or stuck
- Task shows correct hash count but hashcat can't load them

**Cause:** Hashtopolis expects hashes uploaded via API to create internal hash files. Direct DB inserts bypass this - the Hash table entries exist but the actual hash file that hashcat reads is never created.

**ANTI-PATTERNS that DON'T WORK:**
- Direct INSERT INTO Hash table
- Python batch imports to Hash table
- Manual hashlist creation with DB inserts
- Any method that bypasses the API

**WORKING SOLUTION - Use API v1 createHashlist:**
```bash
# Base64 encode the hash file
HASH_DATA=$(base64 -w0 hashlist.txt)

# Create hashlist via API with source:inline
curl -X POST http://SERVER:8080/api/user.php \
  -H 'Content-Type: application/json' \
  -d "{
    \"section\": \"hashlist\",
    \"request\": \"createHashlist\",
    \"accessKey\": \"API_KEY\",
    \"name\": \"MD5-hashes\",
    \"isSalted\": false,
    \"isSecret\": true,
    \"isHexSalt\": false,
    \"separator\": \":\",
    \"format\": 0,
    \"hashtypeId\": 0,
    \"accessGroupId\": 1,
    \"source\": \"inline\",
    \"data\": \"$HASH_DATA\",
    \"useBrain\": false
  }"
```

**Key parameters:**
- `source: inline` - Required for direct upload
- `data` - Base64-encoded hash content (one hash per line)
- `hashtypeId` - Hash mode (0=MD5, 1000=NTLM, 1800=SHA512crypt, etc.)
- `isSecret: true` - Keep hashes protected (trusted agents can access)

**For large hashlists (>50MB):** Split into chunks and upload separately, then create tasks for each hashlist.

### Hashcat --force Flag for PoCL
Ubuntu 22.04 with PoCL (CPU OpenCL) requires `--force`:
```sql
-- Attack command must include --force
UPDATE Task SET attackCmd = '#HL# -a 0 rockyou.txt --force';
```

Without this, hashcat rejects PoCL as "outdated runtime".

### D-series vs F-series Availability
In eastus2:
- **D2s_v3:** Reliably available
- **F2s_v2:** May show "SkuNotAvailable"
- **F2as_v6:** Available (AMD variant)

Use D-series as fallback when F-series unavailable.

### Terraform State Cleanup
When Azure deployment partially completes:
```bash
cd terraform/azure
rm -f terraform.tfstate terraform.tfstate.backup
terraform init
terraform apply -auto-approve  # Fresh deploy
```

Alternatively, use `terraform destroy` then reapply, but this is slower.

## CRITICAL: Teardown Procedures

### Destroying Workers vs Full Teardown

**NEVER run `terraform destroy` without `-target` when server has valuable data!**

| Command | Effect |
|---------|--------|
| `terraform destroy -auto-approve` | **DESTROYS EVERYTHING** - server, workers, VPC, all data |
| `terraform destroy -target=aws_instance.gpu_workers -auto-approve` | Destroys only workers, keeps server |
| `terraform destroy -target=aws_instance.cpu_workers -auto-approve` | Destroys only CPU workers |

### Test 5 Data Loss (2026-01-07)

**What happened:** User requested "destroy the workers". I ran `terraform destroy -auto-approve` which destroyed the ENTIRE infrastructure including the server with all crack results.

**What was lost:**
- Hashtopolis database with all task history
- 2319 cracked passwords (MD5: 561, SHA1: 538, SHA256: 525, NTLM: 553, SHA512crypt: 142)
- Potfiles and crack results
- All configuration and agent registrations

**Correct procedure when user says "destroy workers":**
```bash
# ONLY destroy workers
terraform destroy -target=aws_instance.gpu_workers -target=aws_instance.cpu_workers -auto-approve

# Verify server is still accessible
curl -s http://SERVER_IP:8080 | head -5

# ONLY destroy server after user confirms data is saved
terraform destroy -target=aws_instance.hashtopolis_server -auto-approve

# ONLY destroy networking after server is gone
terraform destroy -auto-approve  # Now safe - only VPC/SG remain
```

### Data Export Before Teardown

**ALWAYS offer to export results before ANY destruction:**

1. Export cracked passwords:
   ```bash
   ssh ubuntu@SERVER 'sudo docker exec hashtopolis-db mysql -u hashtopolis -p$PASS -sN -e "
     SELECT h.plaintext FROM hashtopolis.Hash h WHERE h.isCracked = 1;
   "' > cracked_passwords.txt
   ```

2. Export potfile format:
   ```bash
   ssh ubuntu@SERVER 'sudo docker exec hashtopolis-db mysql -u hashtopolis -p$PASS -sN -e "
     SELECT CONCAT(h.hash, '\'':'\'', h.plaintext) FROM hashtopolis.Hash h WHERE h.isCracked = 1;
   "' > hashcat.potfile
   ```

3. Export task summary:
   ```bash
   ssh ubuntu@SERVER 'sudo docker exec hashtopolis-db mysql -u hashtopolis -p$PASS -e "
     SELECT taskName, keyspace, keyspaceProgress, cracked FROM Task;
   "'
   ```

## GCP-Specific Information (Prepared for Test 8)

### GCP VM Recommendations

| Role | Machine Type | vCPUs | Memory | Status | Notes |
|------|--------------|-------|--------|--------|-------|
| Server | e2-medium | 2 | 4 GB | Recommended | Cost-effective for orchestration |
| Server (alt) | e2-standard-2 | 2 | 8 GB | Available | If more RAM needed |
| CPU Worker | c2-standard-4 | 4 | 16 GB | Recommended | Compute-optimized |
| CPU Worker (alt) | n2-standard-4 | 4 | 16 GB | Available | General purpose |
| CPU Worker (budget) | e2-standard-4 | 4 | 16 GB | Available | Cost-effective |
| GPU Worker | n1-standard-4 + T4 | 4 | 15 GB | Requires quota | T4 GPU attached |

### GCP Region Selection

**Recommended regions for GPU availability:**
| Region | T4 Availability | Preemptible Pricing | Notes |
|--------|-----------------|---------------------|-------|
| us-central1 | Good | ~$0.11/hr | Best overall availability |
| us-east1 | Good | ~$0.11/hr | East coast option |
| us-west1 | Good | ~$0.11/hr | West coast option |
| europe-west1 | Limited | ~$0.12/hr | EU compliance |

### GCP Quota Requirements

**Default quotas (new projects):**
| Resource | Default | Needed | Request If |
|----------|---------|--------|------------|
| CPUs (per region) | 8-24 | 10+ | Using multiple workers |
| NVIDIA T4 GPUs | 0 | 1-4 | Using GPU workers |
| NVIDIA V100 GPUs | 0 | 1+ | High-performance cracking |
| Preemptible CPUs | 24 | 20+ | Using spot instances |

**Request quota increase:**
1. GCP Console → IAM & Admin → Quotas
2. Filter by: Compute Engine API, your region
3. Select quota → Edit Quotas → Request Increase
4. Provide justification (security testing, research)
5. Wait 24-48 hours for approval

### GCP Authentication Setup

```bash
# Option 1: User credentials (development)
gcloud auth application-default login

# Option 2: Service account (recommended for automation)
export GOOGLE_APPLICATION_CREDENTIALS="/path/to/service-account-key.json"

# Create service account with required roles:
# - Compute Admin
# - Service Account User
# - Storage Admin (if using GCS for wordlists)
```

### GCP SSH Key Support

**GCP supports both ed25519 and RSA keys** (unlike Azure which requires RSA only).

```bash
# Generate SSH key for GCP
ssh-keygen -t ed25519 -f ~/.ssh/gcp_hashcrack -N "" -C "hashcrack-gcp"

# Or RSA if needed
ssh-keygen -t rsa -b 4096 -f ~/.ssh/gcp_hashcrack -N "" -C "hashcrack-gcp"
```

### GCP Cost Comparison (us-central1)

| Configuration | On-Demand/hr | Preemptible/hr | Savings |
|---------------|--------------|----------------|---------|
| e2-medium (server) | ~$0.034 | ~$0.010 | 70% |
| c2-standard-4 (CPU worker) | ~$0.188 | ~$0.057 | 70% |
| n1-standard-4 + T4 (GPU worker) | ~$0.45 | ~$0.16 | 65% |

**4-hour audit cost estimate (4 CPU workers):**
- On-demand: ~$3.00 (server + 4 workers)
- Preemptible: ~$0.95 (67% savings)

### GCP Terraform Commands

```bash
cd .claude/skills/Hashcrack/terraform/gcp

# Initialize (first time)
terraform init

# Preview changes
terraform plan

# Deploy
terraform apply -auto-approve

# Destroy workers only (keep server)
terraform destroy -target=google_compute_instance.cpu_workers -target=google_compute_instance.gpu_workers -auto-approve

# Full teardown
terraform destroy -auto-approve

# Get outputs
terraform output
terraform output -json
```

### GCP-Specific Firewall Notes

GCP uses firewall rules attached to network tags instead of security groups:
- Server tag: `hashcrack-server`
- Worker tag: `hashcrack-worker`
- Rules allow SSH (22) and Hashtopolis (8080) from specified CIDRs
- Internal traffic allowed between all instances in subnet

### GCP Worker Private IP Strategy

Workers deploy with private IPs only (no external IP):
- Reduces cost (~$0.004/hr per static IP saved)
- Improves security
- Workers communicate with server via internal network
- SSH to workers via server as jump host:
  ```bash
  ssh -J ubuntu@SERVER_PUBLIC_IP ubuntu@WORKER_PRIVATE_IP
  ```

### GCP Preemptible Instance Behavior

Preemptible VMs can be terminated with 30-second warning:
- Set `use_preemptible = true` in terraform.tfvars
- Hashtopolis handles agent reconnection automatically
- Chunks are reassigned if worker is terminated mid-task
- Maximum runtime: 24 hours (then terminated)
- **Recommendation:** Use preemptible for workers, on-demand for server

### Cloud Provider Comparison Summary

| Feature | AWS | Azure | GCP |
|---------|-----|-------|-----|
| SSH Keys | ed25519/RSA | **RSA only** | ed25519/RSA |
| GPU Quota | Often 0 | Often 0 | Often 0 |
| Spot/Preemptible | 60-70% savings | 60-80% savings | 60-70% savings |
| T4 GPU Instance | g4dn.xlarge | NC4as_T4_v3 | n1-standard-4 + T4 |
| Best CPU Worker | c5.large | D2s_v3 | c2-standard-4 |
| VM Availability | Good | **Capacity issues** | Good |
| Quota Request | AWS Console | Azure Portal | GCP Console |
