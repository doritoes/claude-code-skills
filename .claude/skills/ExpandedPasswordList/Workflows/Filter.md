# Filter Workflow

Filter downloaded HIBP hashes to remove those already in rockyou.txt.

## Prerequisites

- Download stage completed
- rockyou-sha1.bin generated (`bun Tools/RockyouHasher.ts`)

## Execution

```bash
bun .claude/skills/ExpandedPasswordList/Tools/SetDifference.ts [options]
```

### Options

| Flag | Description |
|------|-------------|
| `--prefix <hex>` | Filter single prefix |
| `--resume` | Continue from last state |
| `--batch-size <n>` | Hashes per output batch (default: 1M) |

## Algorithm

For each HIBP prefix file:
1. Load prefix file (~1000 hashes)
2. For each hash:
   - Reconstruct full SHA-1 (prefix + suffix)
   - Binary search in rockyou-sha1.bin
   - If NOT found → write to candidates
3. Update state with progress

## Binary Search Performance

```
rockyou-sha1.bin: 14.3M entries × 20 bytes = 286MB
Binary search: O(log 14.3M) = ~24 comparisons
Per hash lookup: <1ms
```

## State Updates

Updates `data/state.json`:
```json
{
  "filter": {
    "status": "in_progress",
    "completedPrefixes": ["00000", ...],
    "rockyouMatches": 14344391,
    "candidates": 985655609
  }
}
```

## Output

Candidates written to `data/candidates/`:
```
data/candidates/batch-001.txt  (1M hashes)
data/candidates/batch-002.txt  (1M hashes)
...
```

Format: One SHA-1 hash per line (40 hex chars)

## Memory Usage

Peak: ~100MB
- One prefix buffer: ~40KB
- Binary search buffer: ~100MB (memory-mapped)

## Proof of Concept

Filter single prefix:
```bash
bun .claude/skills/ExpandedPasswordList/Tools/SetDifference.ts --prefix 00000
```

Expected: ~950 candidates (95% not in rockyou)
