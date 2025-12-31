# Hashcrack Skill Learnings

Accumulated learnings from testing and operation to improve future runs.

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
