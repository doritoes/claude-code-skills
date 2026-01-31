# Publish Workflow

Push cracked passwords to GitHub repository.

## Prerequisites

- Collect stage completed
- GitHub CLI (`gh`) authenticated
- Repository created (or auto-create)

## Execution

```bash
bun .claude/skills/ExpandedPasswordList/Tools/GitHubPublisher.ts [options]
```

### Options

| Flag | Description |
|------|-------------|
| `--repo <owner/repo>` | Target repository |
| `--create` | Create repo if doesn't exist |
| `--dry-run` | Show what would be published |

## Repository Structure

```
github.com/doritoes/expanded-passwords/
├── README.md                     # Documentation + stats
├── passwords/
│   ├── batch-001.txt             # Per-batch results
│   ├── combined.txt              # All passwords merged
│   └── combined.txt.gz           # Compressed version
├── statistics/
│   └── stats.json                # Machine-readable metrics
└── hard-passwords/
    └── uncracked-sha1.txt        # Surviving hashes
```

## README Template

Auto-generated with:
- Total passwords recovered
- HIBP source date
- Crack methodology
- Statistics breakdown

## State Updates

Updates `data/state.json`:
```json
{
  "results": {
    "lastPublished": "2026-01-27T10:30:00Z",
    "publishedCommit": "abc123..."
  }
}
```

## Statistics Format

`statistics/stats.json`:
```json
{
  "generated": "2026-01-27T10:30:00Z",
  "source": "HIBP Pwned Passwords v8",
  "pipeline": {
    "hibpHashes": 1000000000,
    "rockyouFiltered": 14344391,
    "candidates": 985655609,
    "cracked": 850000000,
    "uncracked": 135655609
  },
  "crackRate": 86.2,
  "methodology": "rockyou.txt + OneRuleToRuleThemStill.rule"
}
```

## Git Operations

```typescript
// Clone or update
await $`gh repo clone ${repo} ./publish-tmp || (cd ./publish-tmp && git pull)`;

// Copy files
await $`cp data/results/passwords.txt ./publish-tmp/passwords/combined.txt`;
await $`gzip -k ./publish-tmp/passwords/combined.txt`;

// Commit and push
await $`cd ./publish-tmp && git add . && git commit -m "Update passwords" && git push`;
```

## Security Notes

- Repository should be PUBLIC for community benefit
- Never include hashes in commit messages
- Stats only - no PII or attribution
