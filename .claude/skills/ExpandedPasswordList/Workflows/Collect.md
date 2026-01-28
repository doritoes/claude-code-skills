# Collect Workflow

Retrieve cracked passwords from Hashcrack and compile results.

## Prerequisites

- Crack stage submitted
- Tasks completed or partially completed

## Execution

```bash
bun .claude/skills/ExpandedPasswordList/Tools/ResultCollector.ts [options]
```

### Options

| Flag | Description |
|------|-------------|
| `--poll` | Poll until all tasks complete |
| `--interval <ms>` | Poll interval (default: 60000) |
| `--force` | Collect even if tasks not complete |

## Collection Process

1. Query Hashtopolis for task status
2. For each completed/partial task:
   - Fetch cracked hash:password pairs
   - Deduplicate against existing results
3. Extract uncracked hashes ("hard passwords")
4. Update state with totals

## Output Files

```
data/results/cracked.txt      # hash:password pairs
data/results/passwords.txt    # passwords only (sorted, deduped)
data/results/uncracked.txt    # SHA-1 hashes that survived cracking
```

## State Updates

Updates `data/state.json`:
```json
{
  "crack": {
    "totalCracked": 8500000
  },
  "results": {
    "crackedPasswords": 8500000,
    "hardPasswords": 1500000
  }
}
```

## Hashcrack API Usage

```typescript
const client = HashtopolisClient.fromEnv();

for (const hashlistId of state.crack.hashlistIds) {
  const cracked = await client.getCrackedHashes(hashlistId);
  // Process results...
}
```

## Hard Passwords

Passwords that survive:
1. Not in rockyou.txt (filtered in stage 2)
2. Not cracked by rockyou + OneRuleToRuleThemAll

These represent **strong breach passwords** - valuable for:
- Security auditing
- Wordlist augmentation
- Password policy research

## Proof of Concept

Collect after PoC cracking:
```bash
bun .claude/skills/ExpandedPasswordList/Tools/ResultCollector.ts --force
```
