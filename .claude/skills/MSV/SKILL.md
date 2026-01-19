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
