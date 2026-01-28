# Crack Workflow

Submit filtered candidates to Hashcrack for password recovery.

## Prerequisites

- Filter stage completed
- Hashcrack skill configured
- Hashtopolis server accessible

## Execution

```bash
bun .claude/skills/ExpandedPasswordList/Tools/CrackSubmitter.ts [options]
```

### Options

| Flag | Description |
|------|-------------|
| `--batch <n>` | Submit specific batch number |
| `--all` | Submit all pending batches |
| `--workers <n>` | Number of parallel workers (splits hashes) |

## Cracking Strategy

Per PARALLELIZATION.md, rule attacks use 1 worker per task.

**Solution:** Split hashes across multiple hashlists.

```
10M candidates → 10 hashlists × 1M hashes each
Each hashlist → 1 task with maxAgents=1
Result: 10 workers running in parallel
```

## Attack Configuration

```typescript
{
  hashType: 100,  // SHA-1
  attackCmd: "#HL# -r OneRuleToRuleThemAll.rule rockyou.txt",
  chunkTime: 600,
  priority: 10,
  maxAgents: 1    // Force distribution
}
```

## State Updates

Updates `data/state.json`:
```json
{
  "crack": {
    "status": "in_progress",
    "hashlistIds": [101, 102, 103, ...],
    "taskIds": [201, 202, 203, ...],
    "totalSubmitted": 10000000,
    "totalCracked": 0
  }
}
```

## Hashcrack Integration

Uses HashtopolisClient from Hashcrack skill:
```typescript
import { HashtopolisClient, HASH_TYPES } from "../Hashcrack/tools/HashtopolisClient";

const client = HashtopolisClient.fromEnv();
const hashlistId = await client.createHashlist({
  name: "HIBP-expanded-batch-001",
  hashTypeId: HASH_TYPES.sha1,
  hashes: batch,
});
```

## Monitoring

Check progress via Hashcrack:
```bash
bun .claude/skills/Hashcrack/tools/HashtopolisClient.ts tasks
```

Or use Status workflow for aggregate view.

## Proof of Concept

Submit small batch manually:
```bash
bun .claude/skills/ExpandedPasswordList/Tools/CrackSubmitter.ts --batch 1
```
