# Status Workflow

Check pipeline progress across all stages.

## Execution

```bash
bun .claude/skills/ExpandedPasswordList/Tools/ProgressTracker.ts
```

## Output Example

```
ExpandedPasswordList Pipeline Status
====================================

DOWNLOAD: completed ✓
  Prefixes: 1,048,576 / 1,048,576 (100%)
  Total hashes: 1,000,000,000
  Completed: 2026-01-25T14:30:00Z

FILTER: completed ✓
  Prefixes: 1,048,576 / 1,048,576 (100%)
  Rockyou matches: 14,344,391 (filtered out)
  Candidates: 985,655,609
  Completed: 2026-01-26T08:15:00Z

CRACK: in_progress ⟳
  Hashlists: 100
  Tasks: 100 (12 complete, 88 running)
  Submitted: 985,655,609
  Cracked: 425,000,000 (43.1%)
  Speed: ~2.5B/hour

RESULTS: pending ○
  Cracked passwords: 0 (collect not run)
  Hard passwords: 0

PUBLISH: pending ○
  Last published: never

Next action: Wait for cracking to complete, then run Collect workflow
```

## State Reading

Reads from `data/state.json` and queries Hashtopolis for live data:

```typescript
const state = stateManager.load();
const client = HashtopolisClient.fromEnv();

// Get live task status
for (const taskId of state.crack.taskIds) {
  const status = await client.getTaskStatus(taskId);
  // Aggregate progress...
}
```

## Machine-Readable Output

```bash
bun .claude/skills/ExpandedPasswordList/Tools/ProgressTracker.ts --json
```

Returns:
```json
{
  "download": { "status": "completed", "progress": 100 },
  "filter": { "status": "completed", "progress": 100 },
  "crack": { "status": "in_progress", "progress": 43.1 },
  "results": { "status": "pending", "progress": 0 },
  "publish": { "status": "pending", "progress": 0 }
}
```

## Proof of Concept

Check status after any stage:
```bash
bun .claude/skills/ExpandedPasswordList/Tools/ProgressTracker.ts
```
