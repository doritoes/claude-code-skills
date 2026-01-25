# SQL Monitoring Queries

Reference for direct database queries when monitoring Hashtopolis jobs.

## Database Schema Key Points

| Table | Column | Type | Notes |
|-------|--------|------|-------|
| Hash | `isCracked` | tinyint | Boolean flag (0/1), **NOT `cracked`** |
| Hash | `plaintext` | varchar | Cracked password |
| Chunk | `cracked` | int | Count of hashes cracked in this chunk |
| Chunk | `progress` | int | Position within chunk |
| Chunk | `state` | int | 0=pending, 1=dispatched, 2=searching, 3=completed, 4=error |
| Task | `keyspace` | bigint | Total keyspace size |
| Task | `keyspaceProgress` | bigint | Current position in keyspace |
| Agent | `isActive` | tinyint | Boolean flag |
| Agent | `lastAct` | varchar | Last action taken |

## Core Monitoring Query

Use this for monitoring progress:

```sql
SELECT
  (SELECT COUNT(*) FROM Hash WHERE hashlistId=1 AND isCracked=1) as cracked,
  (SELECT COUNT(*) FROM Hash WHERE hashlistId=1) as total,
  (SELECT keyspaceProgress FROM Task WHERE taskId=1) as progress,
  (SELECT keyspace FROM Task WHERE taskId=1) as keyspace,
  ROUND((SELECT keyspaceProgress FROM Task WHERE taskId=1) /
        (SELECT keyspace FROM Task WHERE taskId=1) * 100, 1) as pct,
  (SELECT COUNT(*) FROM Chunk WHERE taskId=1) as chunks,
  (SELECT COUNT(*) FROM Agent WHERE isActive=1) as active_agents;
```

## Detailed Status Query

```sql
-- Task overview
SELECT taskId, taskName, keyspace, keyspaceProgress,
       ROUND(keyspaceProgress/keyspace*100, 1) as pct,
       priority, isArchived
FROM Task;

-- Agent status
SELECT agentId, agentName, isActive, lastAct, isTrusted, cpuOnly
FROM Agent;

-- Chunk distribution
SELECT
  state,
  COUNT(*) as count,
  SUM(cracked) as cracked,
  SUM(length) as keyspace_covered
FROM Chunk WHERE taskId=1
GROUP BY state;

-- Worker performance
SELECT
  a.agentName,
  COUNT(c.chunkId) as chunks_completed,
  SUM(c.cracked) as hashes_cracked,
  AVG(c.speed) as avg_speed
FROM Agent a
LEFT JOIN Chunk c ON a.agentId = c.agentId AND c.state = 3
GROUP BY a.agentId
ORDER BY hashes_cracked DESC;
```

## Error Detection

```sql
-- Agent errors (recent first)
SELECT ae.agentId, a.agentName, ae.error, ae.time
FROM AgentError ae
JOIN Agent a ON ae.agentId = a.agentId
ORDER BY ae.time DESC LIMIT 10;

-- Stalled chunks (progress hasn't updated)
SELECT chunkId, agentId, progress, state, dispatchTime
FROM Chunk
WHERE state = 1 AND dispatchTime < UNIX_TIMESTAMP() - 600;
```

## Bash One-Liner for Monitoring

```bash
# Replace $SERVER_IP, $DB_PASS
watch -n 10 "ssh ubuntu@\$SERVER_IP \"docker exec hashtopolis-db mysql -u hashtopolis -p'\$DB_PASS' hashtopolis -e \\\"
SELECT
  (SELECT COUNT(*) FROM Hash WHERE hashlistId=1 AND isCracked=1) as cracked,
  (SELECT keyspaceProgress FROM Task WHERE taskId=1) as progress,
  (SELECT keyspace FROM Task WHERE taskId=1) as keyspace,
  ROUND((SELECT keyspaceProgress FROM Task WHERE taskId=1) / (SELECT keyspace FROM Task WHERE taskId=1) * 100, 1) as pct;
\\\"\""
```

## Common Mistakes

| Wrong | Correct | Table |
|-------|---------|-------|
| `SUM(cracked)` | `COUNT(*) WHERE isCracked=1` | Hash |
| `Hash.cracked` | `Hash.isCracked` | Hash |
| `Chunk.isCracked` | `Chunk.cracked` | Chunk |
| `Agent.active` | `Agent.isActive` | Agent |

## Performance Tips

1. **Don't query Hash table frequently** - can be millions of rows
2. **Use Chunk.cracked for running totals** - aggregate on smaller table
3. **Index on isCracked** - speeds up crack count queries
4. **Use LIMIT on AgentError** - table grows indefinitely
