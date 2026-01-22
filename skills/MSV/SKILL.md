---
name: MSV
version: 1.3.0
description: Minimum Safe Version calculator for Windows software. USE WHEN user needs safe software versions OR user asks about vulnerability-free versions OR user mentions patching decisions OR user wants minimum version to upgrade to OR user asks about KEV vulnerabilities for specific software. Queries CISA KEV, VulnCheck, AppThreat, EPSS to determine lowest version free of known-exploited vulnerabilities.
---

# MSV (Minimum Safe Version)

Determine the lowest software version free of known-exploited vulnerabilities for Windows 11/Server software. Uses Admiralty Code ratings to convey confidence.

## First-Time Setup

**For detailed installation instructions, see `SETUP.md`.**

### Quick Setup (Minimum Required)

1. **Install Bun** (required runtime):
   ```bash
   # Windows PowerShell
   powershell -c "irm bun.sh/install.ps1 | iex"

   # macOS/Linux
   curl -fsSL https://bun.sh/install | bash
   ```

2. **Verify installation**:
   ```bash
   bun --version  # Should show 1.x.x
   ```

3. **Test MSV** (from skill directory):
   ```bash
   bun run tools/msv.ts query "chrome"
   ```

### Optional Enhancements

| Enhancement | Purpose | Setup |
|-------------|---------|-------|
| VulnCheck API | Exploit/PoC intelligence | Free key at vulncheck.com, set `VULNCHECK_API_KEY` |
| AppThreat DB | Offline queries, faster | `pip install appthreat-vulnerability-db[oras] && vdb --download-image` |
| **NVD API Key** | **10x faster batch queries** | Free key at nvd.nist.gov, set `NVD_API_KEY` |

### NVD API Key (Recommended)

The NVD API has strict rate limits. **Getting a free API key provides 10x throughput:**

| Mode | Rate Limit | Batch of 100 Products |
|------|------------|----------------------|
| Without key | 5 req/30s | ~10 minutes |
| **With key** | 50 req/30s | **~1 minute** |

**Get your free key:** https://nvd.nist.gov/developers/request-an-api-key

The MSV client includes:
- **Token bucket rate limiting** - Proactively prevents 429 errors
- **Exponential backoff** - Automatic retry on rate limit hits (2s → 4s → 8s → 16s → 32s)
- **Request queuing** - Smooth request distribution

See `SETUP.md` for complete instructions, troubleshooting, and `.env.example` for all config options.

## Quick Start

```bash
# Run the CLI directly (from skill directory)
bun run tools/msv.ts query "chrome"

# Or create an alias for easier use
alias msv="bun run ~/.claude/skills/MSV/tools/msv.ts"
msv query "putty"
```

## Data Sources (Priority Order)

| Source | Auth | Admiralty | Purpose |
|--------|------|-----------|---------|
| Vendor Advisory | None | A2 | Vendor-confirmed versions (Wireshark, etc.) |
| AppThreat | None | B2 | Offline multi-source database (NVD+OSV+GitHub) |
| CISA KEV | None | A1 | Active exploitation ground truth |
| VulnCheck | API Key | B2 | Public PoC tracking |
| NVD | Optional | C3 | CVE version data (API key = 10x rate limit) |
| EPSS | None | B3 | Exploitation probability |

## Admiralty Code Ratings

| Rating | Meaning |
|--------|---------|
| A1 | Completely Reliable, Confirmed (CISA KEV active exploitation) |
| A2 | Completely Reliable, Probably True (Vendor advisory) |
| B2 | Usually Reliable, Probably True (VulnCheck PoC verified) |
| B3 | Usually Reliable, Possibly True (High EPSS score) |
| C3 | Fairly Reliable, Possibly True (Critical CVSS) |
| D5 | Not Usually Reliable, Improbable (Limited evidence) |

## CLI Usage

```bash
# Single query
msv query "Google Chrome"
msv query "Microsoft Edge" --format json

# Compliance check (with installed versions)
msv check inventory.csv --csv

# Batch query
msv batch software-list.txt --format markdown

# Database management (AppThreat)
msv db status              # Show database status
msv db update              # Download/update database

# Cache management
msv refresh                # Refresh API caches
msv list                   # List supported software
msv stats                  # Show catalog statistics
```

## Output Format

**Multi-branch software (with vendor advisory):**
```
Software: Wireshark (windows, server)
Minimum Safe Version: 0.99.8 (oldest safe)
Recommended Version: 4.6.2 (latest safe)
Admiralty Rating: A2
Justification: Vendor advisory confirms MSV
Sources: Vendor Advisory

Version Branches:
  4.6.x: MSV 4.6.2 (latest: 4.6.2)
  4.4.x: MSV 4.4.12 (latest: 4.4.12)
  ...
```

**Single-version software (NVD/KEV data):**
```
Software: Google Chrome (windows, server)
Minimum Safe Version: 122.0.6261.94
Admiralty Rating: B2
Justification: MSV determined from NVD version data
Sources: CISA KEV, NVD, EPSS
```

## Examples

**Example 1: Single Software Query**
```
User: "What is the minimum safe version of Chrome?"
-> Invokes Query workflow
-> Queries CISA KEV, VulnCheck, EPSS for Chrome CVEs
-> Returns MSV with Admiralty rating
```

**Example 2: Batch Query**
```
User: "Check MSV for Chrome, Edge, and Firefox"
-> Invokes Batch workflow
-> Queries all three in parallel
-> Returns formatted table with ratings
```

**Example 3: Windows Server**
```
User: "What's the safe version for Windows Server 2022?"
-> Invokes Query workflow with MSRC data
-> Returns KB-based minimum with patch details
```

## Adding New Software

See `docs/AddingSoftware.md` for complete guide.

**Quick reference:**

1. **Basic** (5 min): Add entry to `data/SoftwareCatalog.json` with vendor/product names from NVD
2. **Full** (1-2 hrs): Add vendor advisory fetcher to `tools/VendorAdvisory.ts` for A2 rating

```json
// Example catalog entry
{
  "id": "acme_widget",
  "displayName": "ACME Widget Pro",
  "vendor": "acme",
  "product": "widget_pro",
  "category": "utility",
  "priority": "medium",
  "aliases": ["widget", "acme widget"],
  "platforms": ["windows"]
}
```

## File Structure

```
MSV/
├── SKILL.md              # This file - skill definition
├── SETUP.md              # Installation & setup guide
├── .env.example          # Environment variable template
├── .gitignore            # Git ignore rules
├── tools/
│   ├── msv.ts            # Main CLI entrypoint
│   ├── msv.test.ts       # Test suite (bun test)
│   ├── CisaKevClient.ts  # CISA KEV API client
│   ├── EpssClient.ts     # EPSS API client
│   ├── NvdClient.ts      # NVD API client
│   ├── VulnCheckClient.ts # VulnCheck API client
│   ├── AppThreatClient.ts # Offline DB client
│   ├── VendorAdvisory.ts  # Vendor advisory fetchers
│   ├── VersionCompare.ts  # Version comparison utils
│   ├── AdmiraltyScoring.ts # Rating calculation
│   └── ...
├── data/
│   └── SoftwareCatalog.json  # Supported software definitions
└── docs/
    ├── AddingSoftware.md     # How to add new software
    └── FutureExpansion.md    # Roadmap & future plans
```

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "bun: command not found" | Install Bun: `curl -fsSL https://bun.sh/install \| bash` |
| "Software catalog not found" | Ensure `data/SoftwareCatalog.json` exists |
| "NVD rate limit exceeded" | Get free API key (10x faster): https://nvd.nist.gov/developers/request-an-api-key |
| Slow batch queries | Set `NVD_API_KEY` for 50 req/30s (vs 5 req/30s without key) |
| Tests failing | Run `bun test tools/msv.test.ts --verbose` for details |

See `SETUP.md` for comprehensive troubleshooting guide.

---

## Standalone Usage (Without Claude Code)

The MSV skill can be used entirely without Claude Code as a standalone CLI tool. This is useful for:
- CI/CD pipelines
- Scheduled compliance scans
- Integration with other tools
- Manual security assessments

### Installation (Standalone)

```bash
# 1. Clone or copy the MSV skill directory
git clone <your-repo> ~/msv-tool
# Or copy from existing Claude Code installation:
cp -r ~/.claude/skills/MSV ~/msv-tool

# 2. Install Bun (if not installed)
# Windows PowerShell:
powershell -c "irm bun.sh/install.ps1 | iex"
# macOS/Linux:
curl -fsSL https://bun.sh/install | bash

# 3. Install dependencies
cd ~/msv-tool
bun install

# 4. (Optional) Set up API keys for enhanced features
cp .env.example .env
# Edit .env and add:
#   NVD_API_KEY=your-key-here      # 10x faster queries
#   VULNCHECK_API_KEY=your-key     # Exploit intelligence
```

### Create Shell Alias

```bash
# Add to ~/.bashrc, ~/.zshrc, or PowerShell profile
alias msv="bun run ~/msv-tool/tools/msv.ts"

# Or for Windows PowerShell ($PROFILE):
function msv { bun run "$HOME\msv-tool\tools\msv.ts" $args }
```

### Software MSV Commands

```bash
# Query single software
msv query "Google Chrome"
msv query "PuTTY" --format json
msv query "Adobe Acrobat DC" --verbose

# Batch query from file
msv batch software-list.txt
msv batch software-list.txt --format markdown
msv batch software-list.txt --filter kev  # Only KEV-affected

# Compliance check with versions
msv check "Chrome 120.0.1, Edge 121.0.2, PuTTY 0.80"
msv check inventory.csv --format csv
msv check inventory.json --concurrency 10

# Scan installed software (Windows)
msv scan                    # Detect via winget/chocolatey
msv scan --format json

# Pre-warm cache for faster queries
msv warm                    # Critical priority
msv warm high               # High+ priority
msv warm all                # All software

# Database management
msv db status               # AppThreat DB status
msv db update               # Download/update offline DB

# Catalog management
msv list                    # List all supported software
msv list browsers           # List by category
msv stats                   # Catalog statistics
msv discover "WinRAR"       # Search NVD for new software
```

### Router Firmware Commands

```bash
# Query router MSV
msv router query "NETGEAR R7000"
msv router query "ASUS ZenWiFi XT8"
msv router query "TP-Link Archer AX21" --firmware 1.1.2

# List vendors and models
msv router vendors
msv router models netgear
msv router models asus

# Catalog statistics
msv router stats

# Update catalog (dry-run)
msv router update
msv router update --verbose
```

### Output Formats

All commands support multiple output formats:

```bash
# Text (default) - human readable
msv query "Chrome"

# JSON - for programmatic parsing
msv query "Chrome" --format json

# Markdown - for reports
msv batch inventory.txt --format markdown

# CSV - for spreadsheets
msv check inventory.csv --format csv
```

### Example: CI/CD Integration

```yaml
# GitHub Actions example
name: Security Compliance Check
on:
  schedule:
    - cron: '0 6 * * 1'  # Weekly Monday 6am

jobs:
  msv-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Bun
        uses: oven-sh/setup-bun@v1

      - name: Install MSV
        run: |
          git clone https://github.com/your-org/msv-tool
          cd msv-tool && bun install

      - name: Run compliance check
        env:
          NVD_API_KEY: ${{ secrets.NVD_API_KEY }}
        run: |
          cd msv-tool
          bun run tools/msv.ts check ../inventory.csv --format json > results.json

      - name: Upload results
        uses: actions/upload-artifact@v4
        with:
          name: msv-results
          path: msv-tool/results.json
```

### Example: Scheduled Scan Script

```bash
#!/bin/bash
# msv-daily-scan.sh - Run daily MSV compliance check

MSV_DIR="$HOME/msv-tool"
OUTPUT_DIR="$HOME/msv-reports"
DATE=$(date +%Y-%m-%d)

cd "$MSV_DIR"

# Software compliance
bun run tools/msv.ts check inventory.csv --format json > "$OUTPUT_DIR/software-$DATE.json"

# Router firmware check
bun run tools/msv.ts router query "NETGEAR R7000" --format json > "$OUTPUT_DIR/router-$DATE.json"

# Generate markdown report
bun run tools/msv.ts batch inventory.txt --format markdown > "$OUTPUT_DIR/report-$DATE.md"

echo "MSV scan complete: $OUTPUT_DIR"
```

### Example: PowerShell Compliance Report

```powershell
# MSV-ComplianceReport.ps1
$MsvPath = "$env:USERPROFILE\msv-tool"
$ReportPath = "$env:USERPROFILE\Documents\MSV-Reports"
$Date = Get-Date -Format "yyyy-MM-dd"

# Ensure report directory exists
New-Item -ItemType Directory -Force -Path $ReportPath | Out-Null

# Run MSV scan
Set-Location $MsvPath
$results = bun run tools/msv.ts scan --format json | ConvertFrom-Json

# Filter non-compliant
$nonCompliant = $results | Where-Object { $_.status -eq "NON_COMPLIANT" }

if ($nonCompliant.Count -gt 0) {
    Write-Host "WARNING: $($nonCompliant.Count) non-compliant software found!" -ForegroundColor Red
    $nonCompliant | Format-Table -Property software, currentVersion, msv, status

    # Save report
    $results | ConvertTo-Json | Out-File "$ReportPath\scan-$Date.json"
} else {
    Write-Host "All software compliant!" -ForegroundColor Green
}
```

### Input File Formats

**CSV format (inventory.csv):**
```csv
software,version
Google Chrome,120.0.6099.109
PuTTY,0.80
Wireshark,4.2.0
```

**JSON format (inventory.json):**
```json
[
  {"software": "Google Chrome", "version": "120.0.6099.109"},
  {"software": "PuTTY", "version": "0.80"},
  {"software": "Wireshark", "version": "4.2.0"}
]
```

**Text format (software-list.txt):**
```
Google Chrome
PuTTY
Wireshark
Adobe Acrobat DC
```

### Environment Variables

| Variable | Purpose | Required |
|----------|---------|----------|
| `NVD_API_KEY` | NVD API key (10x faster queries) | Recommended |
| `VULNCHECK_API_KEY` | VulnCheck exploit intelligence | Optional |
| `MSV_CACHE_DIR` | Custom cache directory | Optional |
| `MSV_LOG_LEVEL` | Logging: debug, info, warn, error | Optional |

### Running Tests

```bash
cd ~/msv-tool

# Run all tests
bun test

# Run specific test file
bun test tools/tests/RouterClient.test.ts

# Run with coverage
bun test --coverage

# Run in watch mode
bun test --watch
```
