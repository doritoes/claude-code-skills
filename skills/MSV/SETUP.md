# MSV Skill Setup Guide

This guide helps you install and configure the MSV (Minimum Safe Version) skill for Claude Code.

## System Requirements

| Requirement | Version | Required | Notes |
|-------------|---------|----------|-------|
| **Bun** | 1.0+ | Yes | JavaScript/TypeScript runtime |
| **Python** | 3.8+ | Optional | Only for AppThreat offline database |
| **Node.js** | 18+ | Optional | Alternative to Bun (slower) |

## Installation Steps

### Step 1: Install Bun Runtime

Bun is the recommended runtime for MSV. It's faster than Node.js and has built-in TypeScript support.

**Windows (PowerShell):**
```powershell
powershell -c "irm bun.sh/install.ps1 | iex"
```

**macOS/Linux:**
```bash
curl -fsSL https://bun.sh/install | bash
```

**Verify installation:**
```bash
bun --version
# Should show 1.x.x
```

### Step 2: Copy the MSV Skill

Copy the MSV skill folder to your Claude Code skills directory:

```bash
# The skill should be at:
# Windows: %USERPROFILE%\.claude\skills\MSV\
# macOS/Linux: ~/.claude/skills/MSV/

# Example copy command (adjust source path):
cp -r /path/to/MSV ~/.claude/skills/
```

**Directory structure after installation:**
```
~/.claude/skills/MSV/
├── SKILL.md              # Skill definition (required)
├── SETUP.md              # This file
├── tools/
│   ├── msv.ts            # Main CLI tool
│   ├── msv.test.ts       # Test suite
│   ├── CisaKevClient.ts  # CISA KEV API
│   ├── EpssClient.ts     # EPSS API
│   ├── NvdClient.ts      # NVD API
│   ├── VulnCheckClient.ts # VulnCheck API
│   ├── AppThreatClient.ts # Offline database
│   ├── VendorAdvisory.ts  # Vendor advisories
│   └── ...
├── data/
│   └── SoftwareCatalog.json  # Supported software
└── docs/
    ├── AddingSoftware.md
    └── FutureExpansion.md
```

### Step 3: Verify Basic Installation

Test that MSV runs correctly:

```bash
# Navigate to the skill directory
cd ~/.claude/skills/MSV

# Run a simple query (uses free APIs only)
bun run tools/msv.ts query "chrome"
```

**Expected output:**
```
Software: Google Chrome (windows, server)
Minimum Safe Version: 122.0.6261.94
Admiralty Rating: B2
...
```

### Step 4: Run Tests

Verify the skill is working correctly:

```bash
cd ~/.claude/skills/MSV/tools
bun test msv.test.ts
```

**Expected output:**
```
 31 pass
 2 skip
 0 fail
```

## Optional Enhancements

### Option A: VulnCheck API Key (Recommended)

VulnCheck provides enhanced exploit/PoC intelligence. Free tier available.

1. **Get API Key:** Sign up at https://vulncheck.com (free tier available)

2. **Add to environment:**

   **Windows (PowerShell):**
   ```powershell
   # Add to your PowerShell profile or set permanently:
   $env:VULNCHECK_API_KEY = "vulncheck_your_key_here"
   ```

   **macOS/Linux:**
   ```bash
   # Add to ~/.bashrc or ~/.zshrc:
   export VULNCHECK_API_KEY="vulncheck_your_key_here"
   ```

   **Or create `.claude/.env` file:**
   ```bash
   # Create file at ~/.claude/.env
   VULNCHECK_API_KEY=vulncheck_your_key_here
   ```

3. **Verify:**
   ```bash
   bun run tools/msv.ts query "chrome"
   # Should show "VulnCheck" in Sources if working
   ```

### Option B: AppThreat Offline Database (Advanced)

For faster queries and offline capability, install the AppThreat vulnerability database.

1. **Install Python package:**
   ```bash
   pip install appthreat-vulnerability-db[oras]
   ```

2. **Download the database:**
   ```bash
   vdb --download-image
   ```
   This downloads ~2GB to `~/AppData/Local/vdb/vdb/` (Windows) or `~/.local/share/vdb/` (Linux/macOS).

3. **Verify:**
   ```bash
   bun run tools/msv.ts db status
   # Should show database location and statistics
   ```

4. **Keep updated:**
   ```bash
   # Update database periodically:
   vdb --download-image

   # Or use MSV command:
   bun run tools/msv.ts db update
   ```

## Environment Variables Reference

| Variable | Required | Description |
|----------|----------|-------------|
| `VULNCHECK_API_KEY` | No | VulnCheck API key for PoC intelligence |
| `NVD_API_KEY` | No | NVD API key for higher rate limits |
| `MSV_CACHE_DIR` | No | Custom cache directory (default: skill's data/ folder) |

## Troubleshooting

### "bun: command not found"

Bun is not installed or not in PATH.

**Fix:**
```bash
# Reinstall Bun
curl -fsSL https://bun.sh/install | bash

# Reload shell
source ~/.bashrc  # or ~/.zshrc
```

### "Software catalog not found"

The `data/SoftwareCatalog.json` file is missing.

**Fix:**
```bash
# Ensure the data directory exists with the catalog
ls ~/.claude/skills/MSV/data/SoftwareCatalog.json
```

### "EPSS API error" or "NVD rate limit exceeded"

API rate limits hit. These are free APIs with usage limits.

**Fix:**
- Wait a few minutes and retry
- Install AppThreat database for offline queries
- Use `--no-epss` or `--no-nvd` flags to skip those sources

### "VulnCheck API error: 401"

Invalid or missing VulnCheck API key.

**Fix:**
- Verify your API key is correct
- Check the environment variable is set: `echo $VULNCHECK_API_KEY`
- MSV works without VulnCheck, it just provides less PoC data

### Tests failing

**Fix:**
```bash
# Run tests with verbose output
cd ~/.claude/skills/MSV/tools
bun test msv.test.ts --verbose

# If TypeScript errors, check Bun version
bun --version  # Should be 1.0+
```

### AppThreat database not found

The vdb database wasn't downloaded or is in unexpected location.

**Fix:**
```bash
# Check database status
bun run tools/msv.ts db status

# Re-download if needed
vdb --download-image

# Expected locations:
# Windows: C:\Users\<user>\AppData\Local\vdb\vdb\
# Linux/macOS: ~/.local/share/vdb/
```

## Usage Examples

After installation, you can use MSV in several ways:

### Direct CLI Usage

```bash
# Single query
bun run ~/.claude/skills/MSV/tools/msv.ts query "firefox"

# Batch query
bun run ~/.claude/skills/MSV/tools/msv.ts batch software-list.txt

# JSON output
bun run ~/.claude/skills/MSV/tools/msv.ts query "edge" --format json
```

### Create Shell Alias (Recommended)

Add to your shell profile (`~/.bashrc`, `~/.zshrc`, or PowerShell profile):

**Bash/Zsh:**
```bash
alias msv="bun run ~/.claude/skills/MSV/tools/msv.ts"
```

**PowerShell:**
```powershell
function msv { bun run "$env:USERPROFILE\.claude\skills\MSV\tools\msv.ts" $args }
```

Then use:
```bash
msv query "chrome"
msv list
msv stats
```

### Through Claude Code

Just ask Claude Code naturally:

- "What's the minimum safe version of Chrome?"
- "Check if PuTTY 0.79 is vulnerable"
- "Show me the MSV for Wireshark"

Claude Code will automatically invoke the MSV skill when appropriate.

## Updating the Skill

To update MSV to a newer version:

```bash
# Backup your current installation (optional)
cp -r ~/.claude/skills/MSV ~/.claude/skills/MSV.backup

# Copy new version over existing
cp -r /path/to/new/MSV ~/.claude/skills/

# Verify
bun run ~/.claude/skills/MSV/tools/msv.ts --version
```

## Getting Help

- **Skill documentation:** See `SKILL.md` in this folder
- **Adding software:** See `docs/AddingSoftware.md`
- **Future plans:** See `docs/FutureExpansion.md`
- **Issues:** Report at the skill's repository

## Quick Reference Card

```
MSV Commands
============
msv query <software>     Query single software MSV
msv query <sw> --json    Output as JSON
msv batch <file>         Query multiple from file
msv check <file>         Check installed vs MSV
msv list                 List supported software
msv stats                Show catalog statistics
msv db status            Show AppThreat DB status
msv db update            Update AppThreat DB
msv refresh              Clear API caches
msv help                 Show help

Environment Variables
====================
VULNCHECK_API_KEY        VulnCheck API (optional)
NVD_API_KEY              NVD API key (optional)
MSV_CACHE_DIR            Custom cache location
```
