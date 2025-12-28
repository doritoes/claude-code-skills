---
name: Hashcrack
description: Highly scalable distributed password hash cracking using Hashtopolis. USE WHEN user wants to crack password hashes OR user has hash dumps to process OR user needs distributed cracking OR user mentions hashtopolis. Deploys infrastructure to XCP-ng, manages workers dynamically, monitors progress, stores results securely in .env.
---

# Hashcrack Skill

Distributed password hash cracking using Hashtopolis as the orchestration layer. The core value is **scalability** - distribute work across many workers, from a handful of local VMs to hundreds of cloud instances.

## Architecture

```
PAI Hashcrack CLI
       │
       ▼
Hashtopolis Server (orchestration)
       │
       ├── Worker 1 (XCP-ng)
       ├── Worker 2 (XCP-ng)
       ├── Worker N (cloud)
       └── ...scale to hundreds
```

## Quick Start

```bash
# Check prerequisites and create Ubuntu template (if needed)
hashcrack setup

# Deploy infrastructure
hashcrack deploy --workers 3

# Submit hash job (auto-detects format!)
hashcrack crack --input /etc/shadow
hashcrack crack --input ntds.dit.ntds
hashcrack crack --input pwdump.txt
hashcrack crack --input hashes.txt --type ntlm

# Or pipe directly
cat shadow | hashcrack crack
cat pwdump.txt | hashcrack crack

# Monitor progress
hashcrack status

# Scale workers mid-job
hashcrack scale --workers 10

# View results (automatically builds custom wordlist)
hashcrack results

# View Hashtopolis UI
hashcrack server

# Manage custom wordlist
hashcrack wordlist stats

# Cleanup
hashcrack teardown
```

## Workflow Routing

**When executing a workflow, do BOTH of these:**

1. **Call the notification script** (for observability tracking):
   ```bash
   ~/.claude/Tools/SkillWorkflowNotification WORKFLOWNAME Hashcrack
   ```

2. **Output the text notification** (for user visibility):
   ```
   Running the **WorkflowName** workflow from the **Hashcrack** skill...
   ```

| Workflow | Trigger | File |
|----------|---------|------|
| **Setup** | "setup hashcrack", "create template" | `workflows/CreateTemplate.md` |
| **Deploy** | "deploy hashcrack", "spin up workers" | `workflows/Deploy.md` |
| **Crack** | "crack hashes", "submit job" | `workflows/Crack.md` |
| **Monitor** | "check status", "progress" | `workflows/Monitor.md` |
| **Scale** | "add workers", "scale up/down" | `workflows/Scale.md` |
| **Results** | "get results", "cracked passwords" | `workflows/Results.md` |
| **Teardown** | "destroy", "cleanup", "teardown" | `workflows/Teardown.md` |

## Supported Input Formats

The skill automatically detects and parses various credential dump formats:

| Format | Example | Auto-Detection |
|--------|---------|----------------|
| **Linux Shadow** | `root:$6$salt$hash:...` | Detects `$N$` prefix |
| **Windows SAM (pwdump)** | `user:500:aad3b435:31d6cfe0:::` | RID + LM:NTLM pattern |
| **NTDS.dit (secretsdump)** | `DOMAIN\user:500:aad3b435:31d6cfe0:::` | Domain\\ prefix |
| **Plain Hashes** | `31d6cfe0d16ae931...` | Hex patterns |
| **Hashcat Potfile** | `hash:plaintext` | hash:value format |

### Shadow File Hash Types

| Prefix | Algorithm | Cracker |
|--------|-----------|---------|
| `$1$` | MD5crypt | hashcat (Hashtopolis) |
| `$2a$`/`$2b$` | bcrypt | hashcat (Hashtopolis) |
| `$5$` | SHA-256crypt | hashcat (Hashtopolis) |
| `$6$` | SHA-512crypt | hashcat (Hashtopolis) |
| `$y$` | yescrypt | **John the Ripper** (local) |
| `$7$` | scrypt | **John the Ripper** (local) |

**Note**: Ubuntu 24.04+ uses yescrypt (`$y$`) by default. These hashes are automatically routed to John the Ripper when available.

## Supported Hash Types

| Type | Hashcat Mode | Common Source |
|------|--------------|---------------|
| MD5 | 0 | Web applications |
| SHA1 | 100 | Legacy systems |
| SHA256 | 1400 | Modern hashing |
| MD5crypt | 500 | Legacy Linux |
| SHA256crypt | 7400 | Modern Linux |
| SHA512crypt | 1800 | Current Linux /etc/shadow |
| NTLM | 1000 | Windows SAM/AD |
| LM | 3000 | Legacy Windows |
| bcrypt | 3200 | Modern web apps |
| NetNTLMv1 | 5500 | Network captures |
| NetNTLMv2 | 5600 | Network captures |
| Kerberos AS-REP | 18200 | AD attacks |
| Kerberos TGS | 13100 | AD attacks |

## Custom Wordlist

The skill maintains a custom wordlist of cracked passwords that weren't found using standard dictionary attacks (like rockyou). This provides **significant time savings** when auditing local accounts that may reuse passwords.

### How It Works

1. When you run `hashcrack results`, novel passwords are automatically extracted
2. Passwords already in rockyou are skipped (no value in duplicating)
3. Novel passwords are saved to `.claude/skills/Hashcrack/data/custom_passwords.txt`
4. On subsequent cracks, custom wordlist is used **first** (priority 110)

### Managing Custom Wordlist

```bash
# View statistics
hashcrack wordlist stats

# Import from existing potfile
hashcrack wordlist import /path/to/hashcat.potfile

# Export for external use
hashcrack wordlist export /path/to/output.txt

# Upload to Hashtopolis server
hashcrack wordlist upload

# Clear all entries
hashcrack wordlist clear
```

### Why This Matters

- Local accounts often reuse passwords across systems
- Passwords cracked via rules/masks won't be in standard wordlists
- Custom wordlist catches these in seconds on future audits
- Builds organizational password intelligence over time

## Attack Strategy

The skill runs attacks in phases automatically with priority-based scheduling:

### Quick Strategy
| Priority | Attack | Description |
|----------|--------|-------------|
| 110 | Custom Wordlist | Previously cracked passwords (if available) |
| 105 | Custom + Rules | Custom with best64 mutations |
| 100 | rockyou.txt | Standard wordlist attack |

### Comprehensive Strategy (default)
| Priority | Attack | Description |
|----------|--------|-------------|
| 110 | Custom Wordlist | Previously cracked passwords |
| 105 | Custom + Rules | Custom with best64 mutations |
| 100 | rockyou.txt | Standard wordlist |
| 90 | rockyou + best64 | Wordlist with rule mutations |
| 80 | Common Masks | `?u?l?l?l?l?l?d?d?d?d` pattern |
| 75 | Season+Year | `Winter2024!` style patterns |

### Thorough Strategy
Adds combinator attacks, heavy rules (rockyou-30000, OneRule), and extended brute force.

**Note**: Custom wordlist is automatically used first when available, providing fast wins on password reuse.

## Security

- **NEVER display cracked passwords in terminal**
- Results written to `.claude/.env` as `HASHCRACK_RESULTS_<timestamp>`
- User must log into Hashtopolis UI to view actual passwords
- All jobs logged to `History/` for audit compliance
- Display authorization warning before processing

## Environment Variables

```bash
# XenOrchestra credentials
XO_HOST=192.168.99.206
XO_USER=admin
XO_PASSWORD=<password>
SSH_PUBLIC_KEY=ssh-ed25519 AAAA... user@host

# Hashtopolis (set after deployment)
# IMPORTANT: Use HTTP, not HTTPS
HASHCRACK_SERVER_URL=http://<server_ip>:8080
HASHCRACK_ADMIN_USER=hashcrack
HASHCRACK_ADMIN_PASSWORD=<generated>
HASHCRACK_API_KEY=<create via DB or UI>
HASHCRACK_VOUCHER=<from terraform output>
```

### Creating API Key
API keys must be created manually after deployment:
```sql
-- Via database
INSERT INTO ApiKey (startValid, endValid, accessKey, accessCount, userId, apiGroupId)
VALUES (0, 9999999999, 'PAI_<random_hex>', 0, 1, 1);
```

## Reference Documentation

- **Official Docs**: https://docs.hashtopolis.org/
- **GitHub Wiki**: https://github.com/hashtopolis/server/wiki
- `HashtopolisAPI.md` - REST API endpoints and authentication
- `AttackStrategies.md` - Detailed attack configurations and hash types

## John the Ripper Integration

For hash types not supported by hashcat (like yescrypt), the skill automatically routes to John the Ripper.

### Automatic Routing

When processing a shadow file with mixed hash types:
```
ubuntu:$6$...:...   → Hashtopolis (distributed)
alpha:$y$...:...    → John the Ripper (local)
```

### Installation

```bash
# Ubuntu/Debian
sudo apt install john

# macOS
brew install john

# Windows
# Download from https://www.openwall.com/john/
```

### Manual Usage

```bash
# Check if John is available
bun JohnClient.ts check

# Crack yescrypt hashes
bun JohnClient.ts crack shadow.txt --format crypt

# Show results
bun JohnClient.ts show shadow.txt
```

**Limitation**: John runs locally, not distributed. For large yescrypt hash lists, consider dedicated GPU hardware.

## CLI Tools

| Tool | Purpose |
|------|---------|
| `HashcrackCLI.ts` | Main orchestrator - deploy, crack, status, wordlist, teardown |
| `HashtopolisClient.ts` | Hashtopolis REST API client library |
| `InputParsers.ts` | Credential format parsers (shadow, SAM, NTDS, pwdump) |
| `CustomWordlist.ts` | Custom password list manager |
| `JohnClient.ts` | John the Ripper integration for yescrypt/scrypt |
| `CreateTemplate.ts` | Ubuntu template creation for XCP-ng |

## Infrastructure

- **Server**: Ubuntu 24.04 LTS, Docker Compose (Hashtopolis containers)
- **Workers**: Ubuntu 24.04 LTS, hashcat + Hashtopolis agent
- **Provisioning**: Terraform (XenOrchestra provider)
- **Configuration**: Ansible (roles for server, agents, wordlists)

## Critical Setup Requirements

### Correct Order of Operations for Secret Data

**The secure approach**: Keep files and hashlists as secret (default), and trust agents to access them.

```
1. Deploy infrastructure (server + workers)
2. Wait for agents to register with server
3. TRUST AGENTS FIRST (before creating tasks!)
4. Upload wordlists/rules (they will be secret by default - this is OK)
5. Create hashlists (they will be secret by default - this is OK)
6. Create tasks with PRIORITY >= 10 (not 0!)
7. Agents will now receive and process tasks
```

### Step-by-Step Configuration

**1. Wait for Agents to Register** (2-5 minutes after deploy)
```bash
# Check agents via API
curl -X POST http://SERVER:8080/api/user.php \
  -H 'Content-Type: application/json' \
  -d '{"section":"agent","request":"listAgents","accessKey":"YOUR_KEY"}'
```

**2. Trust All Agents** (CRITICAL - do this BEFORE uploading files!)
```bash
# Via API (for each agent)
curl -X POST http://SERVER:8080/api/user.php \
  -H 'Content-Type: application/json' \
  -d '{"section":"agent","request":"setTrusted","accessKey":"YOUR_KEY","agentId":1,"trusted":true}'

# Or via database (trust all at once)
sudo docker exec hashtopolis-db mysql -u hashtopolis -p<password> \
  -e "UPDATE hashtopolis.Agent SET isTrusted = 1;"
```

**3. Upload Wordlists** (they will be secret - trusted agents can access)
```bash
# Via API - file will be secret by default, which is correct
curl -X POST http://SERVER:8080/api/user.php \
  -H 'Content-Type: application/json' \
  -d '{"section":"file","request":"addFile","accessKey":"YOUR_KEY",...}'

# Verify file was written to disk
sudo docker exec hashtopolis-backend ls -la /var/www/hashtopolis/files/
```

**4. Create Hashlist** (will be secret by default - trusted agents can access)

**5. Create Task with Priority >= 10**
```bash
# IMPORTANT: Set priority to 10 or higher, NOT 0
curl -X POST http://SERVER:8080/api/user.php \
  -H 'Content-Type: application/json' \
  -d '{
    "section":"task",
    "request":"createTask",
    "accessKey":"YOUR_KEY",
    "name":"Wordlist Attack",
    "hashlistId":1,
    "attackCmd":"#HL# -a 0 rockyou.txt",
    "priority":10,
    ...
  }'
```

### Why This Order Matters

- **Files/hashlists default to secret** - this is the secure design
- **Agents default to untrusted** - they cannot access secrets
- **If you upload files BEFORE trusting agents**, tasks won't dispatch
- **If task priority is 0**, tasks may not be picked up
- **Trust agents FIRST**, then everything else works automatically

## Known Issues & Workarounds

### Docker Images (IMPORTANT)
- **Use `hashtopolis/backend` + `hashtopolis/frontend`** (NOT `hashtopolis/server`)
- The old `hashtopolis/server` image does not exist
- Environment variables for backend:
  - `HASHTOPOLIS_DB_HOST`, `HASHTOPOLIS_DB_USER`, `HASHTOPOLIS_DB_PASS`, `HASHTOPOLIS_DB_DATABASE`
  - `HASHTOPOLIS_ADMIN_USER`, `HASHTOPOLIS_ADMIN_PASSWORD`
  - `HASHTOPOLIS_APIV2_ENABLE: 0` (disable broken API v2)

### API Version
- **Use API v1** (`/api/user.php`), NOT API v2
- API v2 returns 500 errors in Hashtopolis 0.14.x - routes not implemented
- API v1 uses `accessKey` in request body for authentication

### API Parameter Gotchas
| Endpoint | Required Parameter | Notes |
|----------|-------------------|-------|
| `createHashlist` | `isSecret` | Required field. Let it be `true` (secret) - trust agents instead |
| `addFile` | - | Defaults to secret. Trust agents rather than trying to set `isSecret:false` |
| `setTrusted` | `trusted: true` | NOT `isTrusted`. Request is `setTrusted`, NOT `setAgentTrusted` |
| `createTask` | `priority: 10` | Must be >= 10, NOT 0. Priority 0 may prevent task dispatch |

**Best Practice**: Don't fight the secret defaults. Trust your agents first, then secrets work automatically.

### Server URL
- Use **HTTP** not HTTPS: `http://SERVER_IP:8080`
- HTTPS requires valid certificates which cloud-init doesn't set up
- **Always use port 8080** (classic PHP UI) - the Angular frontend on 4200 requires API v2 which is broken
- When user asks to "log in to Hashtopolis", provide: `http://SERVER_IP:8080`

### Agent Setup
1. **Download**: Use tar.gz from GitHub, not zip
   - URL: `https://github.com/hashtopolis/agent-python/archive/refs/tags/v0.7.4.tar.gz`
   - Extract with `tar xzf agent.tar.gz --strip-components=1`
2. **Entry point**: `python3 __main__.py` (NOT `hashtopolis.zip`)
3. **Dependencies**: `requests`, `psutil` - install system-wide for root service
   - `pip3 install requests psutil --break-system-packages`
4. **Config**: Use HTTP in URL, e.g., `http://SERVER_IP:8080/api/server.php`

### Agent Stability
- Use systemd service with `Restart=always` and `RestartSec=30`
- WorkingDirectory must be `/opt/hashtopolis-agent`
- Run as root to avoid permission issues with hashcat

### SSH Access
- Use `ubuntu` user, NOT `pai`
- Cloud-init creates `ubuntu` user with sudo access

### Password Authentication (IMPORTANT)

Hashtopolis uses **PEPPER + password + salt** for password hashing, NOT plain bcrypt. When setting passwords:

**Wrong approach (fails login):**
```php
$hash = password_hash("mypassword", PASSWORD_BCRYPT);  // WRONG!
```

**Correct approach:**
```bash
# Create a PHP script on the server
ssh ubuntu@SERVER 'cat > /tmp/set_password.php << '\''PHPEOF'\''
<?php
$config = json_decode(file_get_contents("/usr/local/share/hashtopolis/config/config.json"), true);
$PEPPER = $config["PEPPER"];

$pdo = new PDO("mysql:host=hashtopolis-db;dbname=hashtopolis", "hashtopolis", "DB_PASSWORD");
$stmt = $pdo->query("SELECT passwordSalt FROM User WHERE userId = 1");
$salt = $stmt->fetch()["passwordSalt"];

$password = "newpassword123";
$CIPHER = $PEPPER[1] . $password . $salt;
$hash = password_hash($CIPHER, PASSWORD_BCRYPT, ["cost" => 12]);

$stmt = $pdo->prepare("UPDATE User SET passwordHash = ? WHERE userId = 1");
$stmt->execute([$hash]);
echo "Password updated!\n";
PHPEOF
sudo docker cp /tmp/set_password.php hashtopolis-backend:/tmp/set_password.php
sudo docker exec hashtopolis-backend php /tmp/set_password.php'
```

**Where PEPPER is stored:** `/usr/local/share/hashtopolis/config/config.json`

**Password structure:**
- `PEPPER[1]` (32 char random string) + `password` + `passwordSalt` (from User table)
- Hashed with bcrypt cost 12

**ALWAYS test credentials before providing to user:**
```bash
# Test login via curl - must see "agents.php" in response, NOT "Wrong username/password"
curl -s -c /tmp/cookies.txt http://SERVER:8080/index.php > /dev/null
curl -s -c /tmp/cookies.txt -b /tmp/cookies.txt -L -X POST \
  -d "username=hashcrack&password=mypassword&fw=" \
  http://SERVER:8080/login.php | grep -E "(agents\.php|Wrong)"
```

### Database Access
- Password is in container env, not hardcoded
- Get password: `sudo docker exec hashtopolis-db env | grep MYSQL_PASSWORD`

### Task Creation
- **Do NOT insert tasks directly into database** - bypasses proper initialization
- Use API for task creation (agents won't pick up DB-inserted tasks)
- TaskWrapper connects tasks to hashlists in Hashtopolis 0.14.x
- Keyspace must be calculated before chunks can be dispatched

### Task Dispatch Issues
If agents report "No task available!" but tasks exist:

1. **Trust agents first** - most common issue
   ```bash
   sudo docker exec hashtopolis-db mysql -u hashtopolis -p<password> \
     -e "UPDATE hashtopolis.Agent SET isTrusted = 1;"
   ```

2. **Check task priority** - must be >= 10, not 0
   ```sql
   SELECT taskId, taskName, priority FROM Task;
   -- If priority is 0, tasks won't dispatch
   ```

3. **Check TaskWrapper priority** - also must be > 0
   ```sql
   UPDATE TaskWrapper SET priority=100 WHERE priority=0;
   ```

4. **Verify agent is in correct AccessGroup** (usually auto-assigned to group 1)

5. **Do NOT manually insert into Assignment table** - this is an anti-pattern

### File Upload - CRITICAL DISCOVERY

**Files MUST be uploaded via API with `source: inline`**. Manually placing files in the container does NOT work - the server returns "ERR3 - file not present" even though files exist on disk.

**Working approach:**
```python
import base64
import requests

# Read file and base64 encode
with open('wordlist.txt', 'rb') as f:
    data = base64.b64encode(f.read()).decode('utf-8')

# Upload via API
payload = {
    'section': 'file',
    'request': 'addFile',
    'accessKey': 'YOUR_KEY',
    'filename': 'wordlist.txt',
    'fileType': 0,  # 0=wordlist, 1=rule
    'source': 'inline',
    'accessGroupId': 1,
    'data': data,
    'isSecret': False
}
resp = requests.post('http://SERVER:8080/api/user.php', json=payload)
```

**For large files (>50MB):** Split into chunks and upload separately:
```bash
# Split rockyou.txt into 500k line chunks
head -500000 rockyou.txt > rockyou_chunk1.txt
tail -n +500001 rockyou.txt | head -500000 > rockyou_chunk2.txt
# Upload each chunk via API, then create separate tasks for each
```

**Why manual file placement fails:**
- Hashtopolis stores files by internal metadata, not just filesystem path
- API upload triggers proper registration with database
- Files placed via `docker cp` don't have required metadata

### CPU-Only Workers

Workers without GPU support need special configuration:

```sql
-- Workers auto-detect as cpuOnly=1 when no GPU found
-- Tasks must have isCpuTask=1 to be dispatched to CPU-only workers
UPDATE Task SET isCpuTask = 1 WHERE taskId IN (1, 2, 3);
```

**Cloud-init installs PoCL (Portable OpenCL)** for CPU-based hashcat:
- `ocl-icd-libopencl1` and `opencl-headers` packages
- Hashcat uses CPU cores via OpenCL backend
- Typical speed: ~35 MH/s for MD5 on modern CPU

### Agent Activation Issues

Agents may become inactive during operation. Check and fix:

```sql
-- Check agent status
SELECT agentId, agentName, isActive, isTrusted FROM Agent;

-- Reactivate inactive agents
UPDATE Agent SET isActive = 1 WHERE isActive = 0;
```

**Signs of inactive agent:**
- "No task available!" in agent logs despite pending tasks
- Agent's `lastAct` timestamp not updating
- Tasks with high priority not being picked up

### Task Queue Management (CRITICAL for Cloud)

**Keep tasks queued** - agents become inactive when no valid tasks available. In cloud environments, idle workers = wasted cost.

**Why agents report "No task available!" despite pending tasks:**
1. **Agent inactive** - Check and reactivate: `UPDATE Agent SET isActive = 1`
2. **Agent untrusted** - Trust the agent: `UPDATE Agent SET isTrusted = 1`
3. **Task files broken** - File references created via `import` don't work
4. **Task priority = 0** - Tasks must have priority > 0
5. **crackerBinaryId NULL** - Must be set to valid cracker binary ID

**Database task creation with all required fields:**
```sql
INSERT INTO TaskWrapper (priority, maxAgents, taskType, hashlistId, accessGroupId, taskWrapperName, isArchived, cracked)
VALUES (80, 0, 0, 1, 1, 'TaskName', 0, 0);
SET @tw = LAST_INSERT_ID();

INSERT INTO Task (
  taskName, attackCmd, chunkTime, statusTimer, keyspace, keyspaceProgress,
  priority, maxAgents, color, isSmall, isCpuTask, useNewBench, skipKeyspace,
  crackerBinaryId, crackerBinaryTypeId, taskWrapperId, isArchived, notes,
  staticChunks, chunkSize, forcePipe, usePreprocessor, preprocessorCommand
)
VALUES (
  'TaskName', '#HL# -a 3 ?l?l?l?l?l?l', 600, 5, 0, 0,
  80, 0, '#FF6600', 1, 1, 0, 0,
  1, 1, @tw, 0, '',
  0, 0, 0, 0, ''
);
```

**Key fields that cause "Invalid query!" if missing:**
- `useNewBench` - Set to 0
- `crackerBinaryId` - Set to 1 (hashcat)
- `notes`, `preprocessorCommand` - Empty string, not NULL

**Monitoring worker utilization:**
- Check CPU usage on worker VM (should be maxed during cracking)
- Check via XCP-ng/hypervisor for host-level stats
- Idle workers = wasted resources in cloud environments

### Start Simple - Avoid Supertasks Initially
**Recommendation**: Use basic tasks until the workflow is reliable, then introduce advanced features.

| Feature | Complexity | Recommendation |
|---------|------------|----------------|
| Basic Task | Simple | ✅ Start here |
| Pretask | Medium | Add after basics work |
| Supertask | Advanced | Only after pretasks work |

**Simple task creation pattern:**
```bash
# Create task directly linked to hashlist
curl -X POST http://SERVER:8080/api/user.php \
  -H 'Content-Type: application/json' \
  -d '{
    "section":"task",
    "request":"createTask",
    "accessKey":"YOUR_KEY",
    "name":"MD5-Wordlist",
    "hashlistId":1,
    "attackCmd":"#HL# -a 0 rockyou.txt",
    "chunkTime":600,
    "statusTimer":5,
    "priority":10,
    "maxAgents":0,
    "isCpuTask":false,
    "isSmall":true,
    "crackerBinaryId":1,
    "crackerBinaryTypeId":1
  }'
```

### API Limitations Discovered
1. **`runPretask`** - Does NOT exist as an API endpoint
2. **`importSupertask`** - Requires many undocumented params (isCpuOnly, isSmall, masks)
3. **File references** - Stored by fileId (integer), not filename on disk
4. **Keyspace calculation** - Must happen via agent benchmark before task dispatch

### Why Direct Database Access is Sometimes Needed

The Hashtopolis API v1 doesn't support all operations. Database access is required for:

| Operation | API Support | Database Alternative |
|-----------|-------------|---------------------|
| Create API key | ❌ No | `INSERT INTO ApiKey (...)` |
| Create voucher | Limited | `INSERT INTO RegVoucher (voucher, time)` |
| Bulk trust agents | ❌ No | `UPDATE Agent SET isTrusted = 1` |
| Create tasks with files | ❌ Error | Insert TaskWrapper + Task + FileTask |
| Check detailed status | Limited | Query Task, TaskWrapper, Chunk tables |
| Fix stuck tasks | ❌ No | Update Chunk states, reset keyspaceProgress |

**Pattern for task creation via database:**
```sql
-- 1. Create TaskWrapper (links to hashlist)
INSERT INTO TaskWrapper (priority, maxAgents, taskType, hashlistId, accessGroupId, taskWrapperName, isArchived, cracked)
VALUES (100, 0, 0, 1, 1, 'MyTask', 0, 0);
SET @wrapper = LAST_INSERT_ID();

-- 2. Create Task (the actual job)
INSERT INTO Task (taskName, attackCmd, ..., taskWrapperId, isCpuTask, ...)
VALUES ('MyTask', '#HL# wordlist.txt', ..., @wrapper, 1, ...);
SET @task = LAST_INSERT_ID();

-- 3. Link files to task
INSERT INTO FileTask (fileId, taskId) VALUES (5, @task);
```

**When to use API vs Database:**
- ✅ **API**: File uploads, hashlist creation, status queries
- ✅ **Database**: Task creation with file links, bulk operations, recovery

### Database Patterns for Recovery
```sql
-- Check all file references
SELECT f.fileId, f.filename, f.isSecret, ft.taskId
FROM File f LEFT JOIN FileTask ft ON f.fileId = ft.fileId;

-- Check task wrapper to task mapping
SELECT tw.taskWrapperId, tw.hashlistId, tw.priority, t.taskId, t.taskName
FROM TaskWrapper tw LEFT JOIN Task t ON tw.taskWrapperId = t.taskWrapperId;

-- Check chunk states (0=NEW, 4=ABORTED, 5=FINISHED)
SELECT chunkId, taskId, state, agentId, progress
FROM Chunk ORDER BY chunkId DESC LIMIT 10;

-- Find stuck/orphaned tasks
SELECT taskId, taskName, keyspace, keyspaceProgress, priority
FROM Task WHERE keyspaceProgress < keyspace AND keyspace > 0;
```

## Examples

### Crack Linux shadow file (auto-detected)
```bash
hashcrack crack --input /etc/shadow
# Detected format: shadow
# Hash type: sha512crypt (1800)
# Parsed 42 valid hashes, skipped 3 disabled accounts
```

### Crack Windows domain dump (secretsdump output)
```bash
hashcrack crack --input ntds.dit.ntds
# Detected format: secretsdump
# Hash type: ntlm (1000)
# Parsed 15,847 valid hashes
```

### Crack SAM dump (pwdump format)
```bash
hashcrack crack --input sam_dump.txt
# Detected format: pwdump
# Hash type: ntlm (1000)
```

### Pipe credentials directly
```bash
cat /extracted/shadow | hashcrack crack
cat pwdump.txt | hashcrack crack
```

### Custom wordlist management
```bash
# View stats
hashcrack wordlist stats

# Import from potfile
hashcrack wordlist import /path/to/hashcat.potfile

# Skip custom wordlist for this job
hashcrack crack --input hashes.txt --skip-custom
```

### Scale up workers for faster cracking
```bash
hashcrack scale --workers 20
```

### Check job progress
```bash
hashcrack status
# Output: Job 42% complete | 12,847/30,000 cracked | Speed: 1.2 GH/s
```

### View and save results
```bash
hashcrack results
# Cracked: 847 passwords
# Custom Wordlist: 234 novel passwords added
```

## Legal Warning

This skill is for **authorized security testing only**. Before use:

1. Ensure you have written authorization to test the target systems
2. Document the scope and authorization
3. Use only on systems you own or have explicit permission to test

Unauthorized password cracking is illegal and unethical.
