# Hashtopolis API Reference

Complete reference for the Hashtopolis REST API used by the Hashcrack skill.

## API Versions

Hashtopolis has two API versions:
- **API v1** (Legacy): `/api/user.php` - Uses API key in request body
- **API v2** (Current): `/api/v2/` - Uses JWT tokens with HTTP Basic Auth

The Docker deployment uses API v2 by default.

---

## API v2 Configuration (Recommended)

- **Base Endpoint**: `http://<server>:8080/api/v2`
- **Frontend**: `http://<server>:4200` (Angular UI)
- **Content-Type**: `application/json`
- **Authentication**: JWT Bearer token

### Get JWT Token

Use HTTP Basic Auth to obtain a JWT token:

```bash
curl -u 'username:password' \
  -X POST \
  -H 'Content-Type: application/json' \
  -d '{}' \
  'http://server:8080/api/v2/auth/token'
```

**Response**:
```json
{
    "token": "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9...",
    "expires": 1766723199
}
```

### Using the Token

Include the JWT in the Authorization header:

```bash
curl -H 'Authorization: Bearer <token>' \
  -H 'Content-Type: application/json' \
  'http://server:8080/api/v2/ui/agents'
```

### Token Refresh

Tokens expire after 2 hours. Refresh before expiry:

```bash
curl -H 'Authorization: Bearer <current-token>' \
  -X POST \
  'http://server:8080/api/v2/auth/refresh'
```

---

## API v1 Configuration (Legacy)

- **Endpoint**: `https://<server>/api/user.php`
- **Method**: POST (all requests)
- **Content-Type**: `application/json`
- **Authentication**: API key in request body

### Request Format

```json
{
  "section": "<section_name>",
  "request": "<action_name>",
  "accessKey": "<api_key>",
  ...additional parameters
}
```

### Response Format

```json
{
  "section": "<section_name>",
  "request": "<action_name>",
  "response": "OK" | "ERROR",
  ...response data or error message
}
```

## Hashlist Operations

### Create Hashlist

Upload hashes to crack.

```json
{
  "section": "hashlist",
  "request": "createHashlist",
  "accessKey": "your-api-key",
  "name": "Job-2025-12-25-001",
  "hashTypeId": 1000,
  "format": 0,
  "separator": ":",
  "isSalted": false,
  "isHexSalt": false,
  "accessGroupId": 1,
  "data": "base64-encoded-hashes",
  "useBrain": false,
  "brainFeatures": 0
}
```

**Parameters**:
| Parameter | Type | Description |
|-----------|------|-------------|
| name | string | Descriptive name for the hashlist |
| hashTypeId | int | Hashcat hash type (see Attack Strategies) |
| format | int | 0 = text, 1 = binary |
| separator | string | Field separator (usually ":") |
| isSalted | bool | Whether hashes include salt |
| isHexSalt | bool | Salt is hex encoded |
| accessGroupId | int | Access group (1 = default) |
| data | string | Base64-encoded hash data |

**Response**:
```json
{
  "section": "hashlist",
  "request": "createHashlist",
  "response": "OK",
  "hashlistId": 42
}
```

### Get Hashlist

```json
{
  "section": "hashlist",
  "request": "getHashlist",
  "accessKey": "your-api-key",
  "hashlistId": 42
}
```

### List Hashlists

```json
{
  "section": "hashlist",
  "request": "listHashlists",
  "accessKey": "your-api-key"
}
```

### Get Cracked Hashes

Retrieve cracked passwords (use carefully - security sensitive).

```json
{
  "section": "hashlist",
  "request": "getCracked",
  "accessKey": "your-api-key",
  "hashlistId": 42
}
```

**Response**:
```json
{
  "section": "hashlist",
  "request": "getCracked",
  "response": "OK",
  "cracked": [
    {"hash": "aad3b435b51404ee", "plain": "password123"},
    {"hash": "31d6cfe0d16ae931", "plain": "hunter2"}
  ]
}
```

## Task Operations

### Create Task

Define an attack job.

```json
{
  "section": "task",
  "request": "createTask",
  "accessKey": "your-api-key",
  "name": "Wordlist Attack - rockyou",
  "hashlistId": 42,
  "attackCmd": "#HL# -a 0 -r best64.rule rockyou.txt",
  "chunkTime": 600,
  "statusTimer": 5,
  "priority": 10,
  "maxAgents": 0,
  "color": "#00FF00",
  "isCpuTask": false,
  "isSmall": false,
  "skipKeyspace": 0,
  "crackerBinaryId": 1,
  "crackerBinaryTypeId": 1
}
```

**Parameters**:
| Parameter | Type | Description |
|-----------|------|-------------|
| name | string | Task name |
| hashlistId | int | Target hashlist ID |
| attackCmd | string | Hashcat command (`#HL#` = hashlist placeholder) |
| chunkTime | int | Seconds per chunk (600 default) |
| statusTimer | int | Status update interval |
| priority | int | Higher = runs first |
| maxAgents | int | Max workers (0 = unlimited) |
| color | string | Hex color for UI |
| isCpuTask | bool | CPU-only task |
| crackerBinaryId | int | Hashcat binary ID |

**Attack Command Placeholders**:
- `#HL#` - Hashlist file
- `#OPTS#` - Additional options

### Get Task Status

```json
{
  "section": "task",
  "request": "getTask",
  "accessKey": "your-api-key",
  "taskId": 123
}
```

**Response**:
```json
{
  "section": "task",
  "request": "getTask",
  "response": "OK",
  "taskId": 123,
  "name": "Wordlist Attack",
  "hashlistId": 42,
  "keyspace": 1000000000,
  "keyspaceProgress": 450000000,
  "crackedHashes": 12847,
  "hashCount": 30000,
  "isArchived": false,
  "speed": 1200000000
}
```

### List Tasks

```json
{
  "section": "task",
  "request": "listTasks",
  "accessKey": "your-api-key"
}
```

### Set Task Priority

```json
{
  "section": "task",
  "request": "setTaskPriority",
  "accessKey": "your-api-key",
  "taskId": 123,
  "priority": 100
}
```

## Agent Operations

### Create Voucher

Generate a registration code for new workers.

```json
{
  "section": "agent",
  "request": "createVoucher",
  "accessKey": "your-api-key",
  "voucher": "auto-generated-or-custom"
}
```

**Response**:
```json
{
  "section": "agent",
  "request": "createVoucher",
  "response": "OK",
  "voucher": "ABC123XYZ"
}
```

### List Agents

```json
{
  "section": "agent",
  "request": "listAgents",
  "accessKey": "your-api-key"
}
```

**Response**:
```json
{
  "section": "agent",
  "request": "listAgents",
  "response": "OK",
  "agents": [
    {
      "agentId": 1,
      "agentName": "worker-1",
      "devices": ["NVIDIA RTX 3080"],
      "isActive": true,
      "isTrusted": true,
      "lastAction": "2025-12-25T10:30:00Z",
      "lastIp": "192.168.99.101"
    }
  ]
}
```

### Set Agent Active

Enable/disable an agent.

```json
{
  "section": "agent",
  "request": "setAgentActive",
  "accessKey": "your-api-key",
  "agentId": 1,
  "isActive": true
}
```

### Set Agent Trusted

Trust agent to access sensitive data.

```json
{
  "section": "agent",
  "request": "setAgentTrusted",
  "accessKey": "your-api-key",
  "agentId": 1,
  "isTrusted": true
}
```

## File Operations

### Upload File (Wordlist/Rule)

```json
{
  "section": "file",
  "request": "addFile",
  "accessKey": "your-api-key",
  "filename": "rockyou.txt",
  "fileType": 0,
  "accessGroupId": 1,
  "data": "base64-encoded-content"
}
```

**File Types**:
- 0 = Wordlist
- 1 = Rule file

### List Files

```json
{
  "section": "file",
  "request": "listFiles",
  "accessKey": "your-api-key"
}
```

## Config Operations

### Get Server Config

```json
{
  "section": "config",
  "request": "listConfigs",
  "accessKey": "your-api-key"
}
```

### Set Config Value

```json
{
  "section": "config",
  "request": "setConfigValue",
  "accessKey": "your-api-key",
  "item": "voucherDeletion",
  "value": "0"
}
```

**Useful Config Items**:
| Item | Description |
|------|-------------|
| voucherDeletion | 0 = reusable vouchers |
| chunkTime | Default chunk duration |
| agentTimeout | Agent heartbeat timeout |
| statustimer | Status update interval |

## Error Handling

### Error Response

```json
{
  "section": "task",
  "request": "createTask",
  "response": "ERROR",
  "message": "Invalid hashlist ID"
}
```

### Common Errors

| Error | Cause | Solution |
|-------|-------|----------|
| `Invalid access key` | Wrong/expired API key | Regenerate key in UI |
| `Invalid hashlist ID` | Hashlist doesn't exist | Create hashlist first |
| `Hashtype not found` | Invalid hash type ID | Check hashcat modes |
| `Agent not found` | Invalid agent ID | List agents to verify |

## Rate Limiting

Hashtopolis doesn't enforce strict rate limits, but recommended:
- Status polling: Every 5-10 seconds
- Bulk operations: 1 request per second
- File uploads: Sequential, not parallel

## TypeScript Client Usage

```typescript
const client = new HashtopolisClient({
  serverUrl: process.env.HASHCRACK_SERVER_URL,
  apiKey: process.env.HASHCRACK_API_KEY
});

// Create hashlist
const hashlistId = await client.createHashlist({
  name: "NTLM Dump",
  hashTypeId: 1000,
  hashes: ["aad3b435b51404ee", "31d6cfe0d16ae931"]
});

// Create attack task
const taskId = await client.createTask({
  name: "Rockyou Attack",
  hashlistId,
  attackCmd: "#HL# -a 0 rockyou.txt"
});

// Monitor progress
const status = await client.getTaskStatus(taskId);
console.log(`Progress: ${status.keyspaceProgress / status.keyspace * 100}%`);

// Get results (write to file, never display)
const cracked = await client.getCrackedHashes(hashlistId);
await writeResultsToEnv(cracked);
```
