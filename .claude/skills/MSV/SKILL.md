---
name: MSV
description: Minimum Safe Version calculator for Windows software. USE WHEN user needs safe software versions OR user asks about vulnerability-free versions OR user mentions patching decisions OR user wants minimum version to upgrade to OR user asks about KEV vulnerabilities for specific software. Queries CISA KEV, VulnCheck, EPSS to determine lowest version free of known-exploited vulnerabilities.
---

# MSV (Minimum Safe Version)

Determine the lowest software version free of known-exploited vulnerabilities for Windows 11/Server software. Uses Admiralty Code ratings to convey confidence.

## Workflow Routing

**When executing a workflow, do BOTH of these:**

1. **Call the notification script** (for observability tracking):
   ```bash
   ~/.claude/Tools/SkillWorkflowNotification WORKFLOWNAME MSV
   ```

2. **Output the text notification** (for user visibility):
   ```
   Running the **WorkflowName** workflow from the **MSV** skill...
   ```

| Workflow | Trigger | File |
|----------|---------|------|
| **Query** | "msv for", "safe version", "minimum version" | `workflows/Query.md` |
| **Batch** | "check all", "batch query", "from file" | `workflows/Batch.md` |
| **Refresh** | "refresh cache", "update vuln data" | `workflows/Refresh.md` |

## Data Sources (Priority Order)

| Source | Auth | Admiralty | Purpose |
|--------|------|-----------|---------|
| CISA KEV | None | A1 | Active exploitation ground truth |
| VulnCheck | API Key | B2 | Public PoC tracking |
| MSRC | None | A2 | Windows-specific patches |
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

# Batch query
msv batch software-list.txt --format markdown

# Cache management
msv refresh
msv list
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
