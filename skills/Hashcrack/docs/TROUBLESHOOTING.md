# Troubleshooting Guide

## Docker Images

- **Use `hashtopolis/backend` + `hashtopolis/frontend`** (NOT `hashtopolis/server`)
- The old `hashtopolis/server` image does not exist
- Environment variables for backend:
  - `HASHTOPOLIS_DB_HOST`, `HASHTOPOLIS_DB_USER`, `HASHTOPOLIS_DB_PASS`, `HASHTOPOLIS_DB_DATABASE`
  - `HASHTOPOLIS_ADMIN_USER`, `HASHTOPOLIS_ADMIN_PASSWORD`
  - `HASHTOPOLIS_APIV2_ENABLE: 0` (disable broken API v2)

## API Version

- **Use API v1** (`/api/user.php`), NOT API v2
- API v2 returns 500 errors in Hashtopolis 0.14.x - routes not implemented
- API v1 uses `accessKey` in request body for authentication

## API Parameter Gotchas

| Endpoint | Required Parameter | Notes |
|----------|-------------------|-------|
| `createHashlist` | `isSecret` | Required field. Let it be `true` (secret) - trust agents instead |
| `addFile` | - | Defaults to secret. Trust agents rather than trying to set `isSecret:false` |
| `setTrusted` | `trusted: true` | NOT `isTrusted`. Request is `setTrusted`, NOT `setAgentTrusted` |
| `createTask` | `priority: 10` | Must be >= 10, NOT 0. Priority 0 may prevent task dispatch |

**Best Practice**: Don't fight the secret defaults. Trust your agents first, then secrets work automatically.

## Server URL

- Use **HTTP** not HTTPS: `http://SERVER_IP:8080`
- HTTPS requires valid certificates which cloud-init doesn't set up
- **Always use port 8080** (classic PHP UI) - the Angular frontend on 4200 requires API v2 which is broken

## Agent Setup

1. **Download**: Use tar.gz from GitHub, not zip
   - URL: `https://github.com/hashtopolis/agent-python/archive/refs/tags/v0.7.4.tar.gz`
   - Extract with `tar xzf agent.tar.gz --strip-components=1`
2. **Entry point**: `python3 __main__.py` (NOT `hashtopolis.zip`)
3. **Dependencies**: `requests`, `psutil` - install system-wide for root service
   - `pip3 install requests psutil --break-system-packages`
4. **Config**: Use HTTP in URL, e.g., `http://SERVER_IP:8080/api/server.php`

## Agent Stability

- Use systemd service with `Restart=always` and `RestartSec=30`
- WorkingDirectory must be `/opt/hashtopolis-agent`
- Run as root to avoid permission issues with hashcat

## Python RecursionError Fix (Ubuntu 24.04 / Python 3.12)

The Hashtopolis Python agent can hit `RecursionError: maximum recursion depth exceeded` during HTTP requests on Python 3.12.

**Symptoms:**
```
File "/usr/lib/python3.12/http/cookiejar.py", line 642, in eff_request_host
    erhn = req_host = request_host(request)
RecursionError: maximum recursion depth exceeded
```

**Fix:** Increase Python recursion limit in systemd service:
```bash
[Service]
Type=simple
User=root
WorkingDirectory=/opt/hashtopolis-agent
ExecStart=/usr/bin/python3 -c "import sys; sys.setrecursionlimit(5000); exec(open('__main__.py').read())"
Restart=always
RestartSec=30
```

## SSH Access

- Use `ubuntu` user, NOT `pai`
- Cloud-init creates `ubuntu` user with sudo access

## Password Authentication

Hashtopolis uses **PEPPER + password + salt** for password hashing, NOT plain bcrypt.

**Wrong approach (fails login):**
```php
$hash = password_hash("mypassword", PASSWORD_BCRYPT);  // WRONG!
```

**Correct approach:** See `workflows/Deploy.md` for the PHP script pattern.

**Password structure:**
- `PEPPER[1]` (32 char random string) + `password` + `passwordSalt` (from User table)
- Hashed with bcrypt cost 12

## Database Access

- Password is in container env, not hardcoded
- Get password: `sudo docker exec hashtopolis-db env | grep MYSQL_PASSWORD`

## Task Creation

- **Do NOT insert tasks directly into database** - bypasses proper initialization
- Use API for task creation (agents won't pick up DB-inserted tasks)
- TaskWrapper connects tasks to hashlists in Hashtopolis 0.14.x
- Keyspace must be calculated before chunks can be dispatched

## Task Dispatch Issues

If agents report "No task available!" but tasks exist:

1. **Trust agents first** - most common issue
   ```sql
   UPDATE hashtopolis.Agent SET isTrusted = 1;
   ```

2. **Check task priority** - must be >= 10, not 0
   ```sql
   SELECT taskId, taskName, priority FROM Task;
   ```

3. **Check TaskWrapper priority** - also must be > 0
   ```sql
   UPDATE TaskWrapper SET priority=100 WHERE priority=0;
   ```

4. **Verify agent is in correct AccessGroup** (usually auto-assigned to group 1)

5. **Do NOT manually insert into Assignment table** - this is an anti-pattern

6. **Check for stale agents after worker deletion**

   When workers are destroyed/rebuilt, old agent entries remain in the database:
   - Get assigned chunks but can't complete them
   - Show `speed: 0` in task details
   - Cause `workPossible: false` on tasks
   - Block real workers from getting work

   **Detection:**
   ```sql
   SELECT agentId, agentName, isActive, lastTime FROM hashtopolis.Agent;
   ```

   **Fix:**
   ```sql
   -- Reset chunks assigned to stale agent
   UPDATE hashtopolis.Chunk SET state = 0, agentId = NULL
   WHERE agentId = STALE_ID AND state IN (2, 4);
   -- Remove task assignments
   DELETE FROM hashtopolis.Assignment WHERE agentId = STALE_ID;
   -- Deactivate stale agent
   UPDATE hashtopolis.Agent SET isActive = 0 WHERE agentId = STALE_ID;
   ```

## File Upload

**Files MUST be uploaded via API with `source: inline`**. Manually placing files in the container returns "ERR3 - file not present".

**Working approach:**
```python
import base64
import requests

with open('wordlist.txt', 'rb') as f:
    data = base64.b64encode(f.read()).decode('utf-8')

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

**For large files (>50MB):** Split into chunks and upload separately.

## CPU-Only Workers

```sql
-- Tasks must have isCpuTask=1 to be dispatched to CPU-only workers
UPDATE Task SET isCpuTask = 1 WHERE taskId IN (1, 2, 3);
```

Cloud-init installs PoCL (Portable OpenCL) for CPU-based hashcat.

## Agent Activation Issues

```sql
-- Check agent status
SELECT agentId, agentName, isActive, isTrusted FROM Agent;

-- Reactivate inactive agents
UPDATE Agent SET isActive = 1 WHERE isActive = 0;
```

## Task Queue Management

**Keep tasks queued** - agents become inactive when no valid tasks available.

**Why agents report "No task available!" despite pending tasks:**
1. Agent inactive - `UPDATE Agent SET isActive = 1`
2. Agent untrusted - `UPDATE Agent SET isTrusted = 1`
3. Task files broken - File references created via `import` don't work
4. Task priority = 0 - Tasks must have priority > 0
5. crackerBinaryId NULL - Must be set to valid cracker binary ID

## API Limitations

1. **`runPretask`** - Does NOT exist as an API endpoint
2. **`importSupertask`** - Requires many undocumented params
3. **File references** - Stored by fileId (integer), not filename on disk
4. **Keyspace calculation** - Must happen via agent benchmark before task dispatch

## When Direct Database Access is Needed

| Operation | API Support | Database Alternative |
|-----------|-------------|---------------------|
| Create API key | ❌ No | `INSERT INTO ApiKey (...)` |
| Create voucher | Limited | `INSERT INTO RegVoucher (voucher, time)` |
| Bulk trust agents | ❌ No | `UPDATE Agent SET isTrusted = 1` |
| Create tasks with files | ❌ Error | Insert TaskWrapper + Task + FileTask |
| Fix stuck tasks | ❌ No | Update Chunk states, reset keyspaceProgress |

## Database Recovery Patterns

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
