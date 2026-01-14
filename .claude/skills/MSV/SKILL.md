---
name: MSV
version: 1.1.0
description: Minimum Safe Version calculator for Windows software. USE WHEN user needs safe software versions OR user asks about vulnerability-free versions OR user mentions patching decisions OR user wants minimum version to upgrade to OR user asks about KEV vulnerabilities for specific software. Queries CISA KEV, VulnCheck, AppThreat, EPSS to determine lowest version free of known-exploited vulnerabilities.
---

# MSV (Minimum Safe Version)

Determine the lowest software version free of known-exploited vulnerabilities for Windows 11/Server software. Uses Admiralty Code ratings to convey confidence.

## Prerequisites

- **Bun** runtime (https://bun.sh)
- **VulnCheck API Key** (optional, for enhanced PoC data) - set in `.claude/.env`
- **AppThreat Database** (optional, for offline queries) - install with `pip install appthreat-vulnerability-db[oras] && vdb --download-image`

## Quick Start

```bash
# Run the CLI directly
bun run .claude/skills/MSV/tools/msv.ts query "chrome"

# Or create an alias
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
| NVD | None | C3 | CVE version data |
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
