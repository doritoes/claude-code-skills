# Download Workflow

Download HIBP Pwned Passwords dataset by prefix ranges.

## Prerequisites

- Internet connectivity
- ~17GB disk space available

## Execution

```bash
bun .claude/skills/ExpandedPasswordList/Tools/HibpDownloader.ts [options]
```

### Options

| Flag | Description |
|------|-------------|
| `--prefix <hex>` | Download single prefix (e.g., `00000`) |
| `--range <start-end>` | Download prefix range (e.g., `00000-000FF`) |
| `--resume` | Continue from last state |
| `--parallel <n>` | Concurrent downloads (default: 10) |

## State Updates

Updates `data/state.json`:
```json
{
  "download": {
    "status": "in_progress",
    "completedPrefixes": ["00000", "00001", ...],
    "totalHashes": 1000000000
  }
}
```

## Output

Files written to `data/hibp/`:
```
data/hibp/00000.txt
data/hibp/00001.txt
...
```

Each file contains SHA-1 suffixes + counts:
```
0018A45C4D1DEF81644B54AB7F969B88D65:3
00D4F6E8FA6EECAD2A3AA415EEC418D38EC:2
```

## Rate Limiting

- Default: 10 concurrent requests
- ~1500 requests/minute to HIBP API
- Built-in retry with exponential backoff

## Proof of Concept

For PoC, download single prefix:
```bash
bun .claude/skills/ExpandedPasswordList/Tools/HibpDownloader.ts --prefix 00000
```

Expected: ~1000 hashes, <1 second
