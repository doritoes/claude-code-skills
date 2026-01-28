# ExpandedPasswordList Setup

## Requirements

### Runtime
- **Bun** - TypeScript runtime (already installed for PAI)
- **~35GB disk space** - For HIBP data + processing

### Dependencies
- Hashcrack skill configured (for cracking pipeline)
- GitHub CLI (`gh`) authenticated (for publishing)

### Environment Variables

Add to `.claude/.env`:
```bash
# Optional: GitHub repo for publishing results
EXPANDED_PASSWORDS_REPO=doritoes/expanded-passwords
```

## Storage Layout

```
.claude/skills/ExpandedPasswordList/data/
├── state.json           # Pipeline state persistence
├── rockyou-sha1.bin     # Binary SHA-1 hashes of rockyou.txt (286MB)
├── hibp/                # Downloaded HIBP prefix files
│   ├── 00000.txt        # Each prefix ~15KB compressed
│   ├── 00001.txt
│   └── ...              # 1,048,576 prefix files
├── candidates/          # Filtered hashes (not in rockyou)
│   ├── batch-001.txt    # Split for Hashcrack submission
│   └── ...
└── results/             # Cracked passwords
    ├── cracked.txt      # hash:password pairs
    └── uncracked.txt    # "hard" passwords that survived cracking
```

## Initial Setup

1. **Verify rockyou.txt exists:**
   ```bash
   ls -la ~/AI-Projects/rockyou.txt
   # Should be ~139MB, 14.3M lines
   ```

2. **Generate rockyou SHA-1 hashes:**
   ```bash
   bun .claude/skills/ExpandedPasswordList/Tools/RockyouHasher.ts
   ```

3. **Verify Hashcrack connection:**
   ```bash
   bun .claude/skills/Hashcrack/tools/HashtopolisClient.ts test
   ```

## Pipeline Execution

Run stages sequentially:
1. `/expandedpasswordlist download` - Fetch HIBP data
2. `/expandedpasswordlist filter` - Remove rockyou matches
3. `/expandedpasswordlist crack` - Submit to Hashcrack
4. `/expandedpasswordlist collect` - Gather cracked results
5. `/expandedpasswordlist publish` - Push to GitHub

Or check status anytime:
- `/expandedpasswordlist status` - View pipeline progress
