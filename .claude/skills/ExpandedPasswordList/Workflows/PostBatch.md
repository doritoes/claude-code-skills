# Post-Batch Workflow

## Purpose
After all attacks in a SAND batch complete, run this workflow to collect results,
generate feedback, and prepare for the next batch.

## CRITICAL: Execution Order

The order matters because later steps delete data that earlier steps need.

```bash
cd .claude/skills/ExpandedPasswordList

# Step 1: Export cracked passwords (backup before any archiving)
bun Tools/PasswordExporter.ts

# Step 2: Collect DIAMONDS (needs Hash rows — MUST run before HashlistArchiver)
bun Tools/DiamondCollector.ts --batch batch-NNNN --glass --force

# Step 3: Archive completed tasks (marks tasks as archived in Hashtopolis)
bun Tools/SandArchiver.ts --batch batch-NNNN --no-collect
# If tasks fail due to stale assignments, clear them:
#   DELETE FROM Assignment WHERE taskId IN (...)
# Then re-run SandArchiver

# Step 4: Archive hashlists + reclaim DB space (DELETES Hash rows)
bun Tools/HashlistArchiver.ts

# Step 5: Analyze DIAMONDS (produces BETA.txt, UNOBTAINIUM.rule, cohort report)
bun Tools/DiamondAnalyzer.ts --full data/diamonds/passwords-batch-NNNN.txt

# Step 6: Generate feedback + upload to Hashtopolis
bun Tools/DiamondFeedback.ts --batch batch-NNNN --upload

# Step 7: Rebuild nocap-plus.txt (cohort files may have changed)
"C:/Program Files/Python312/python.exe" scripts/rebuild-nocap-plus.py

# Step 8: Upload updated nocap-plus.txt to Hashtopolis (if changed)
# (DiamondFeedback handles BETA.txt and UNOBTAINIUM.rule upload)
```

## Why This Order

| Step | Depends On | Destroys |
|------|-----------|----------|
| PasswordExporter | Hash rows exist | Nothing |
| DiamondCollector | Hash rows exist | Nothing |
| SandArchiver | Tasks exist | Archives tasks |
| HashlistArchiver | Tasks archived | **Deletes Hash rows** |
| DiamondAnalyzer | Diamond files from step 2 | Nothing |
| DiamondFeedback | Diamond files from step 2 | Nothing |
| rebuild-nocap-plus | Cohort files updated by step 5 | Overwrites nocap-plus.txt |

**The critical constraint:** DiamondCollector reads cracked passwords from the Hash table.
HashlistArchiver deletes Hash rows. If you run HashlistArchiver first, DiamondCollector
gets 0 results.

## Verification

After completing the workflow:
```bash
bun Tools/PipelineMonitor.ts
```

Expected:
- Active Hashlists: 0
- Active Tasks: 0
- BATCH COMPLETE banner (if tasks still visible) or clean state
