# Monitor Workflow

Check job progress and worker status.

## Trigger

- "check status"
- "progress"
- "how's the job going"

## Execution

```bash
hashcrack status
```

## Output Format

```
╔════════════════════════════════════════════════════════════╗
║                    HASHCRACK STATUS                         ║
╚════════════════════════════════════════════════════════════╝

Server: https://192.168.99.101:8080
Workers: 5/5 active

Workers:
  ● worker-1 (192.168.99.102)
  ● worker-2 (192.168.99.103)
  ● worker-3 (192.168.99.104)
  ● worker-4 (192.168.99.105)
  ● worker-5 (192.168.99.106)

Current Job:
  Name: client-audit-2025
  Progress: 6,847/10,000 (68.5%)
  Active Tasks: 2

Active Tasks:
  Wordlist + Rules: [████████████░░░░░░░░] 61.2%
  Common Masks:     [██████████████████░░] 89.3%
```

## API Queries

### List Agents

```typescript
const agents = await client.listAgents();
// Returns: agentId, agentName, isActive, devices, lastIp
```

### Get Job Progress

```typescript
const progress = await client.getJobProgress(hashlistId);
// Returns: totalHashes, crackedHashes, percentCracked, activeTasks
```

### Get Task Status

```typescript
const status = await client.getTaskStatus(taskId);
// Returns: keyspace, keyspaceProgress, crackedHashes, speed, percentComplete
```

## Polling Interval

- Default: Every 10 seconds
- Recommended: 5-30 seconds depending on job size
- Avoid: Less than 5 seconds (adds overhead)

## Worker Health Indicators

| Symbol | Meaning |
|--------|---------|
| ● (green) | Active, processing chunks |
| ○ (red) | Inactive or disconnected |
| ◐ (yellow) | Active but idle (waiting for work) |

## Troubleshooting

| Issue | Cause | Solution |
|-------|-------|----------|
| 0% progress | Workers waiting for work | Check task priority |
| Workers offline | Network issue | SSH to worker, check agent service |
| Slow speed | CPU-only workers | Consider GPU instances |
| Task stuck | Large chunk size | Reduce chunkTime |
