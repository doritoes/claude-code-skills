# SAND Batch Restart Path

## Overview

This document provides the verified working path to restart SAND batch processing after the batch-0001 abort on 2026-02-06.

## Pre-Requisites Checklist

Before starting ANY SAND batch:

### 1. Verify GRAVEL Batches Complete
```bash
# Check HIBP batches 1-162 are fully processed
bun Tools/StateManager.ts
# Expected: Filter completed, Crack completed for batches 1-162

# Verify PEARLS collected
ls -la data/results/
# Should have: cracked.txt, passwords.txt (PEARLS)
```

### 2. Verify Attack Files Staged
```bash
# List files in Hashtopolis
bun Tools/FileUploader.ts --list

# Required files (minimum):
# ID 1: rockyou.txt (~133MB)
# ID 2: OneRuleToRuleThemAll.rule (~393KB)
# ID 3: OneRuleToRuleThemStill.rule (~475KB)
```

### 3. Verify Workers Online
```bash
# Check worker health
bun Tools/WorkerHealthCheck.ts

# Check agents registered
bun Tools/PipelineMonitor.ts --quick
```

## SAND Batch 001 Restart Procedure

### Step 1: Reset SAND State (if needed)
```bash
# Check current state
bun Tools/SandStateManager.ts

# If batch-0001 shows "failed", reset it:
bun Tools/SandStateManager.ts --reset
```

### Step 2: Prepare SAND Hashlist

The SAND hashlist contains hashes that survived the initial rockyou+OneRule attack from GRAVEL batches.

**Source file:** HIBP batches where cracked < hashCount (uncracked hashes)

```bash
# Generate SAND hashlist from uncracked HIBP hashes
bun Tools/ResultCollector.ts --force
# This creates: data/results/uncracked.txt (SAND hashes)
```

### Step 3: Validate Attack Configuration

The SAND attacks are defined in `Tools/SandStateManager.ts`:

**Attack Order (optimized):**
1. `newwords-rizzyou-onerule` - New GenZ wordlist + rules
2. `brute-5` - 5-character brute force
3. `brute-6` - 6-character brute force
4. `brute-7` - 7-character brute force
5. `hybrid-rockyou-4digit` - Append 4 digits
6. `hybrid-rockyou-year` - Append year (19XX, 20XX)
7. `hybrid-rizzyou-4digit` - GenZ + 4 digits
8. `hybrid-rockyou-special-digits` - Special char + digits
9. `mask-*` - Pattern-based masks

### Step 4: Upload Required Files (if not present)

```bash
# Upload rizzyou.txt (GenZ wordlist)
bun Tools/FileUploader.ts --upload data/rizzyou.txt --id 4

# Verify downloads work
bun Tools/FileUploader.ts --verify 1,3,4
```

### Step 5: Run WarmStart (after power-on)

**CRITICAL:** Files must be copied to the correct path after VM restart.

```bash
bun Tools/WarmStart.ts
# This copies files from /var/www/hashtopolis/files/
# to /usr/local/share/hashtopolis/files/
```

### Step 6: Submit SAND Batch

```bash
# Submit batch 001 with SandProcessor
bun Tools/SandProcessor.ts --batch 1

# Or with custom workers
bun Tools/SandProcessor.ts --batch 1 --workers 8
```

### Step 7: Monitor Progress

```bash
# Watch progress
bun Tools/PipelineMonitor.ts --watch

# Check SAND state
bun Tools/SandStateManager.ts
```

## Known Issues and Fixes

### Issue 1: "Keyspace measure failed!"

**Symptoms:** Worker repeatedly fails with keyspace measure errors
**Causes:**
- Attack files not at expected path
- Incompatible attack mode (e.g., `--increment` with chunking)
- File corrupted (ERR3 error)

**Fix:**
```bash
# Verify files
bun Tools/WorkerHealthCheck.ts

# Run WarmStart to copy files
bun Tools/WarmStart.ts

# Restart agents
bun Tools/AgentManager.ts --restart-all
```

### Issue 2: ERR3 File Not Found

**Symptoms:** File downloads return 23 bytes with "ERR3" message
**Cause:** Docker volume mounts to wrong path

**Fix:**
```bash
bun Tools/WarmStart.ts
# Copies files to /usr/local/share/hashtopolis/files/
```

### Issue 3: nocap-genz Attack Fails

**Note:** The `newwords-nocap-genz` attack (14M words × 48K rules) causes keyspace calculation issues on workers. Consider:
- Using smaller wordlists with fewer rules
- Breaking into multiple smaller attacks
- Skipping this attack if it consistently fails

## Attack File Requirements

| Attack | Files Required | FileIDs |
|--------|----------------|---------|
| brute-* | None (mask only) | - |
| hybrid-rockyou-* | rockyou.txt | 1 |
| hybrid-rizzyou-* | rizzyou.txt | 4 |
| newwords-rizzyou-onerule | rizzyou.txt, OneRuleToRuleThemStill.rule | 4, 3 |
| mask-* | None (mask only) | - |

## Validation Gates

Before task creation, these gates must pass:

1. **GATE A:** Files exist at `/var/www/hashtopolis/files/`
2. **GATE B:** File downloads don't return ERR3 (< 100 bytes)
3. **GATE C:** Agents are registered and online

If any gate fails, the tool should refuse to proceed.

## Output Files

After SAND batch completes:

| File | Description |
|------|-------------|
| `data/results/diamonds-batch-XXXX.txt` | Cracked from SAND |
| `data/results/glass-batch-XXXX.txt` | Uncracked (GLASS) |
| `data/sand-state.json` | Batch state tracking |

## Recovery from Failed Batch

If a batch fails mid-processing:

```bash
# 1. Archive all tasks
bun Tools/SafeArchiver.ts --batch batch-XXXX --force

# 2. Update state to failed
# Edit data/sand-state.json: set status = "failed"

# 3. Clean up files (optional)
# Delete uploaded files that were batch-specific

# 4. Reset state for fresh start
bun Tools/SandStateManager.ts --reset
```

## Lessons from Batch-0001 Abort

1. **File staging is critical** - WarmStart must run after every power-on
2. **Large wordlist × large rule combinations fail** - nocap.txt × nocap.rule caused issues
3. **--increment doesn't work** - Hashtopolis chunking conflicts with hashcat --increment
4. **Test file downloads before task creation** - GATE B catches ERR3 errors early
5. **Archive completely, don't abandon** - Use SafeArchiver --force to properly close out

## Quick Reference

```bash
# Full restart sequence
bun Tools/WarmStart.ts                    # Fix file paths
bun Tools/PipelineMonitor.ts --quick      # Check health
bun Tools/SandStateManager.ts --reset     # Clear failed state
bun Tools/SandProcessor.ts --batch 1      # Start fresh
bun Tools/PipelineMonitor.ts --watch      # Monitor
```
