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
