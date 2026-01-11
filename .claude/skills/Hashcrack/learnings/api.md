# API Learnings

Hashtopolis API v1 issues and database workarounds.

## API v1 Status

| Endpoint | Status | Alternative |
|----------|--------|-------------|
| createHashlist | Works | - |
| addFile | Works (with `source: inline`) | - |
| createTask | Broken ("Invalid query!") | Database insert |
| setTrusted | Works | Database UPDATE |

**ALWAYS use API v1 (`/api/user.php`), NOT API v2 (broken in 0.14.x).**

## Task Creation via Database

Since createTask API is unreliable, use database:

```sql
-- 1. TaskWrapper (links to hashlist)
INSERT INTO TaskWrapper (priority, maxAgents, taskType, hashlistId, accessGroupId, taskWrapperName, isArchived, cracked)
VALUES (100, 0, 0, 1, 1, 'TaskName', 0, 0);
SET @tw = LAST_INSERT_ID();

-- 2. Task (the actual job)
INSERT INTO Task (taskName, attackCmd, chunkTime, statusTimer, keyspace, keyspaceProgress, priority, maxAgents, color, isSmall, isCpuTask, useNewBench, skipKeyspace, crackerBinaryId, crackerBinaryTypeId, taskWrapperId, isArchived, notes, staticChunks, chunkSize, forcePipe, usePreprocessor, preprocessorCommand)
VALUES ('TaskName', '#HL# rockyou.txt -r OneRule.rule --force', 600, 5, 0, 0, 100, 0, '', 0, 1, 1, 0, 1, 1, @tw, 0, '', 0, 0, 0, 0, '');
SET @t = LAST_INSERT_ID();

-- 3. Link files
INSERT INTO FileTask (fileId, taskId) VALUES (1, @t);
INSERT INTO FileTask (fileId, taskId) VALUES (2, @t);
```

**CRITICAL:** Set `keyspace=0` for database-created tasks (agents calculate it).

## File Upload

**API upload is preferred** (registers metadata correctly):

```python
import base64, requests
with open('wordlist.txt', 'rb') as f:
    data = base64.b64encode(f.read()).decode('utf-8')
payload = {
    'section': 'file',
    'request': 'addFile',
    'accessKey': 'KEY',
    'filename': 'wordlist.txt',
    'fileType': 0,  # 0=wordlist, 1=rule
    'source': 'inline',
    'accessGroupId': 1,
    'data': data
}
requests.post('http://SERVER:8080/api/user.php', json=payload)
```

## Required Task Fields

Fields that cause "Invalid query!" if missing:
- `useNewBench` - Set to 0
- `crackerBinaryId` - Set to 1 (hashcat)
- `notes`, `preprocessorCommand` - Empty string, not NULL

## Keyspace Issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| keyspace=1 | Files corrupted on workers | Delete worker files, reset keyspace=0 |
| Task exhausts immediately | Wrong keyspace value | Set keyspace=0, let agents recalculate |
| "No task available!" | keyspace > 0 but not initialized | Reset keyspace=0 |

## Schema Notes

- Table names are **case-sensitive**: `Hashlist`, `Task`, `Agent` (not lowercase)
- Always qualify with `hashtopolis.` prefix in MySQL
