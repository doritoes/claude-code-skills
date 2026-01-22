# MSV Router Firmware Tracking - Implementation Plan

**Created:** 2026-01-21
**Status:** Planning
**Effort:** THOROUGH (THEALGORITHM)

---

## Executive Summary

Extend MSV to track minimum safe firmware versions for home wireless routers. This addresses the security gap for work-from-home employees using consumer routers with known vulnerabilities.

**Key Stats:**
- 79 router-related entries in CISA KEV (actively exploited)
- Top affected vendors: D-Link (20+), Zyxel (10+), Cisco Small Business (10+), NETGEAR (7+), TP-Link (5+)
- Target coverage: 2010-present consumer/SOHO routers

---

## Requirements

### Functional Requirements

1. **Model Lookup**
   - User input: Brand + Model (e.g., "NETGEAR R7000")
   - Handle hardware variants (e.g., "WRT160N v3")
   - Fuzzy matching for user input variations

2. **Firmware MSV Calculation**
   - Track firmware branches (some routers have multiple)
   - Determine minimum safe firmware version per branch
   - Cross-reference with CISA KEV for exploitation status

3. **EOL Tracking**
   - Track support status: `supported`, `security-only`, `eol`, `never-supported`, `unknown`
   - Display EOL date if available
   - Warn users about unsupported hardware

4. **Product Hierarchy**
   - Vendors → Families → Models → Hardware Versions → Firmware Branches
   - Example: Linksys → WRT Series → WRT160N → v3 → Firmware 3.x

5. **Vendor Security Evaluation**
   - Track vendor trust rating (bug bounty, response time, CNA status)
   - Link to vendor security pages

### Non-Functional Requirements

1. **Flexibility** - Schema must handle extreme variation in naming, versioning
2. **Scalability** - Support 500+ models across 15+ vendors
3. **Maintainability** - Easy to add new models without code changes
4. **Accuracy** - Prioritize correctness over coverage

---

## Top 3 Vendor Security Evaluation

### NETGEAR - Trust Rating: HIGH

- **Bug Bounty**: Active via Bugcrowd ($150-$15,000)
- **CNA Status**: No (uses coordinated disclosure)
- **Response Time**: Generally fast for critical issues
- **KEV Status**: 7+ entries, all patched
- **Security URL**: https://www.netgear.com/about/security
- **Strengths**:
  - Mature, well-funded bug bounty program
  - Dedicated security team
  - Regular firmware updates for supported models
- **Weaknesses**:
  - Legacy products (12+ years) still have vulnerabilities
  - Restrictive disclosure policy (no public disclosure allowed)
  - Some models reach EOL with unpatched issues

### ASUS - Trust Rating: MEDIUM-HIGH

- **Bug Bounty**: Security advisory portal
- **CNA Status**: Yes (since 2024)
- **Response Time**: Active patching, official statements on incidents
- **KEV Status**: 3 entries; recent critical flaws
- **Security URL**: https://www.asus.com/content/security-advisory/
- **Strengths**:
  - CNA status shows commitment to transparency
  - Regular firmware updates
  - Official statements addressing security concerns
- **Weaknesses**:
  - AyySSHush botnet exploited 9,000+ routers (March 2025)
  - AiCloud feature has recurring vulnerabilities
  - Some exploits persist across firmware updates

### TP-Link - Trust Rating: MEDIUM

- **Bug Bounty**: Via HackerOne
- **CNA Status**: Yes (since April 2025)
- **Response Time**: 90-day patching target
- **KEV Status**: 5+ entries, mid-range severity
- **Security URL**: https://www.tp-link.com/us/landing/security-commitment/
- **Strengths**:
  - CNA status as of 2025
  - Patches released for most KEV vulnerabilities
  - High market share = motivated to fix issues
- **Weaknesses**:
  - Potential US government ban discussions (security concerns)
  - Incomplete patches leading to new CVEs
  - Disputes some KEV listings
  - Lower-cost manufacturing may affect security

---

## Data Schema Design

### RouterCatalog.json Structure

```json
{
  "version": "1.0.0",
  "lastUpdated": "2026-01-21",
  "vendors": {
    "netgear": {
      "displayName": "NETGEAR",
      "securityUrl": "https://www.netgear.com/about/security/",
      "bugBounty": true,
      "bugBountyUrl": "https://bugcrowd.com/netgear/",
      "cnaStatus": false,
      "trustRating": "high",
      "families": {
        "nighthawk": {
          "displayName": "Nighthawk",
          "category": "wifi-router",
          "targetMarket": "consumer",
          "models": ["R7000", "R7800", "R8000", "RAX50", "RAX80"]
        },
        "orbi": {
          "displayName": "Orbi",
          "category": "mesh",
          "targetMarket": "consumer",
          "models": ["RBK50", "RBK852", "RBK853"]
        }
      }
    }
  },
  "models": {
    "netgear_r7000": {
      "vendor": "netgear",
      "family": "nighthawk",
      "model": "R7000",
      "displayName": "NETGEAR R7000 Nighthawk",
      "aliases": [
        "r7000",
        "nighthawk r7000",
        "netgear nighthawk",
        "netgear r7000 nighthawk"
      ],
      "category": "wifi-router",
      "releaseYear": 2014,
      "wifiStandard": "ac1900",
      "cpePrefix": "cpe:2.3:h:netgear:r7000",
      "hardwareVersions": {
        "v1": {
          "chipset": "Broadcom BCM4709",
          "supportStatus": "eol",
          "eolDate": "2023-06-01",
          "supportUrl": "https://www.netgear.com/support/product/R7000",
          "firmwareBranches": {
            "1.0.11.x": {
              "branchName": "1.0.11",
              "msv": "1.0.11.134",
              "msvDate": "2022-11-15",
              "msvCves": ["CVE-2022-48196", "CVE-2022-37337"],
              "latest": "1.0.11.140",
              "latestDate": "2023-05-15",
              "downloadUrl": "https://www.netgear.com/support/product/R7000#download",
              "eol": false
            },
            "1.0.9.x": {
              "branchName": "1.0.9",
              "msv": "1.0.9.88",
              "latest": "1.0.9.88",
              "eol": true,
              "eolNote": "Upgrade to 1.0.11.x branch"
            }
          },
          "kevCves": ["CVE-2017-5521"]
        }
      }
    },
    "linksys_wrt160n": {
      "vendor": "linksys",
      "family": "wrt",
      "model": "WRT160N",
      "displayName": "Linksys WRT160N",
      "aliases": ["wrt160n", "wrt-160n", "wrt 160n", "linksys wrt160n"],
      "category": "wifi-router",
      "releaseYear": 2008,
      "wifiStandard": "n300",
      "cpePrefix": "cpe:2.3:h:linksys:wrt160n",
      "hardwareVersions": {
        "v1": {
          "chipset": "Broadcom BCM4716",
          "supportStatus": "eol",
          "eolDate": "2015-01-01",
          "firmwareBranches": {
            "8.x": {
              "msv": "8.0.08",
              "latest": "8.0.08",
              "eol": true
            }
          }
        },
        "v2": {
          "chipset": "Broadcom BCM4716",
          "supportStatus": "eol",
          "firmwareBranches": {
            "8.x": {
              "msv": "8.0.05",
              "latest": "8.0.05",
              "eol": true
            }
          }
        },
        "v3": {
          "chipset": "Marvell 88F5281",
          "supportStatus": "eol",
          "note": "Different chipset than v1/v2 - different firmware",
          "firmwareBranches": {
            "3.x": {
              "msv": "3.0.03",
              "latest": "3.0.03",
              "eol": true
            }
          }
        }
      }
    }
  }
}
```

### Support Status Enum

| Status | Description | User Action |
|--------|-------------|-------------|
| `supported` | Active firmware updates | Keep updated |
| `security-only` | Only critical security patches | Consider upgrade |
| `eol` | End of life, no updates | Replace device |
| `never-supported` | OEM/white-label, no vendor | Replace immediately |
| `unknown` | Cannot determine | Research needed |

### Trust Rating Enum

| Rating | Description | Criteria |
|--------|-------------|----------|
| `high` | Strong security posture | Bug bounty + fast response + CNA |
| `medium-high` | Good security posture | Bug bounty OR CNA + regular patches |
| `medium` | Adequate security | Publishes advisories, patches issues |
| `low` | Poor security posture | Slow/no response, minimal transparency |
| `unknown` | No data | Insufficient information |

---

## Data Sources

### Tier 1: Automated (Daily/Weekly)

| Source | Data | Method | Priority |
|--------|------|--------|----------|
| CISA KEV | Exploited CVEs | API | P0 |
| NVD API | CVE details, affected versions | API | P1 |
| AppThreat DB | Offline CVE lookup | SQLite | P1 |

### Tier 2: Semi-Automated (Monthly)

| Source | Data | Method | Priority |
|--------|------|--------|----------|
| OpenWrt ToH | Hardware specs, chipsets | Wiki scrape | P2 |
| DD-WRT Database | Supported models | Wiki scrape | P2 |
| Vendor security pages | Advisories | Custom scrapers | P2 |

### Tier 3: Manual Curation (Quarterly)

| Data | Source | Notes |
|------|--------|-------|
| EOL dates | Vendor support pages | Often not published |
| Hardware versions | Product research | From device labels |
| Firmware downloads | Vendor sites | Version + date |
| Family categorization | Manual | Initial setup |

---

## Implementation Phases

### Phase 1: Foundation (Week 1-2)

**Goal:** Core infrastructure and KEV-priority models

1. **Create RouterCatalog.json schema**
   - Define TypeScript types
   - Create validation logic
   - Initial vendor entries (NETGEAR, TP-Link, ASUS, D-Link, Linksys)

2. **Implement RouterClient.ts**
   - Model lookup with fuzzy matching
   - Hardware version detection
   - Firmware branch selection

3. **Seed KEV-priority models**
   - Add all 79 router models from CISA KEV
   - Research EOL status for each
   - Document firmware branches

### Phase 2: CLI Integration (Week 3)

**Goal:** User-facing commands

1. **Add `msv router` command**
   ```bash
   msv router "NETGEAR R7000"
   msv router "R7000" --vendor netgear
   msv router "WRT160N v3"
   msv router "R7000" --firmware 1.0.11.126
   ```

2. **Add `msv router list` commands**
   ```bash
   msv router list --vendor netgear
   msv router list --eol
   msv router vendors
   ```

3. **Output formatting**
   - Text/JSON/Markdown output
   - Risk score calculation
   - EOL warnings

### Phase 3: Data Expansion (Week 4-5)

**Goal:** Comprehensive coverage

1. **Expand model database**
   - Top 50 models per major vendor
   - Focus on 2015-present models first
   - Add hardware version details

2. **Vendor security page scrapers**
   - NETGEAR advisory scraper
   - ASUS advisory scraper
   - TP-Link advisory scraper

3. **OpenWrt integration**
   - Import hardware specs
   - Map chipsets to models
   - Link to alternative firmware options

### Phase 4: Automation (Week 6)

**Goal:** Reduce manual maintenance

1. **Automated CVE correlation**
   - Match new KEV entries to catalog
   - Flag models needing review

2. **Firmware version tracking**
   - Monitor vendor download pages
   - Alert on new firmware releases

3. **EOL monitoring**
   - Track vendor support page changes
   - Update status automatically

---

## CLI Commands

### Query Commands

```bash
# Basic query
msv router "NETGEAR R7000"

# With hardware version
msv router "WRT160N v3"
msv router "WRT160N" --hw-version v3

# Check specific firmware
msv router "R7000" --firmware 1.0.11.126

# With explicit vendor (for ambiguous models)
msv router "R7000" --vendor netgear

# JSON output
msv router "R7000" --format json
```

### List Commands

```bash
# List all vendors
msv router vendors

# Vendor details
msv router vendor netgear

# List models by vendor
msv router list --vendor netgear

# List models by family
msv router list --family nighthawk

# List EOL models
msv router list --eol

# List KEV-affected models
msv router list --kev

# Search/discover
msv router discover "archer"
```

### Batch Commands

```bash
# Check inventory file
msv router check inventory.csv
# CSV format: brand,model,hw_version,firmware
# Example: NETGEAR,R7000,v1,1.0.11.126

# Compliance report
msv router check inventory.csv --format markdown --output report.md
```

---

## Output Examples

### Standard Query Output

```
Router: NETGEAR R7000 Nighthawk
════════════════════════════════════════════════════════════════════

Hardware Version:  v1 (Broadcom BCM4709)
Support Status:    ⚠️  END OF LIFE (since 2023-06-01)

Firmware Branch: 1.0.11.x
  Minimum Safe Version: 1.0.11.134
  Latest Version:       1.0.11.140 (2023-05-15)

KEV Vulnerabilities: 1
  CVE-2017-5521 - Authentication Bypass [CRITICAL]

Vendor: NETGEAR
  Trust Rating:    HIGH
  Bug Bounty:      Yes (Bugcrowd)
  Security Page:   https://www.netgear.com/about/security

Risk Score: 45/100 MEDIUM
════════════════════════════════════════════════════════════════════
⚠️  WARNING: This router is END OF LIFE
   No further security updates will be released.

   RECOMMENDATION:
   - If you must keep this device, ensure firmware is at least 1.0.11.134
   - Consider replacing with a supported model (e.g., RAX50, RAX80)
```

### Firmware Check Output

```
Router: NETGEAR R7000 Nighthawk (v1)
Firmware: 1.0.11.126

❌ BELOW MINIMUM SAFE VERSION

  Your Version:    1.0.11.126
  MSV Required:    1.0.11.134
  Latest:          1.0.11.140

Vulnerabilities in 1.0.11.126:
  - CVE-2022-48196 (Command Injection) - Fixed in 1.0.11.134
  - CVE-2022-37337 (Buffer Overflow) - Fixed in 1.0.11.134

ACTION REQUIRED: Update firmware immediately
Download: https://www.netgear.com/support/product/R7000#download
```

### EOL Model Output

```
Router: Linksys WRT160N (v3)

🛑 CRITICAL: UNSUPPORTED HARDWARE

This router model reached END OF LIFE in 2015.
No security updates are available.

Known Vulnerabilities:
  - CVE-2014-100005 (Command Injection) - UNPATCHED
  - Multiple unpatched issues discovered since EOL

Risk Score: 85/100 CRITICAL

RECOMMENDATION: REPLACE THIS DEVICE IMMEDIATELY

This router is over 10 years old and cannot be secured.
Consider modern alternatives:
  - Linksys Velop (mesh)
  - NETGEAR Nighthawk RAX50
  - ASUS RT-AX86U
```

---

## File Structure

```
MSV/
├── data/
│   ├── SoftwareCatalog.json      # Existing software catalog
│   └── RouterCatalog.json        # NEW: Router catalog
├── tools/
│   ├── msv.ts                    # Main CLI (add router subcommand)
│   ├── RouterClient.ts           # NEW: Router lookup client
│   ├── RouterFirmwareCompare.ts  # NEW: Firmware version comparison
│   ├── RouterModelMatcher.ts     # NEW: Fuzzy model matching
│   └── scrapers/
│       ├── NetgearAdvisoryScraper.ts   # NEW
│       ├── AsusAdvisoryScraper.ts      # NEW
│       └── TplinkAdvisoryScraper.ts    # NEW
└── docs/
    ├── RouterFirmwarePlan.md     # This document
    └── AddingRouters.md          # NEW: Guide for adding routers
```

---

## Testing Strategy

### Unit Tests

- RouterClient model lookup
- Fuzzy matching accuracy
- Firmware version comparison
- Hardware version detection

### Integration Tests

- KEV correlation for known routers
- Vendor scraper accuracy
- End-to-end query flow

### Data Validation

- Schema validation for RouterCatalog.json
- CPE prefix validity
- URL accessibility checks

---

## Success Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| KEV coverage | 100% | All 79 KEV routers in catalog |
| Top vendor coverage | 90% | Top 50 models per vendor |
| Lookup accuracy | 95% | Fuzzy match success rate |
| False positive rate | <5% | Incorrect model matches |
| Data freshness | <30 days | Time since last catalog update |

---

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Vendor naming inconsistency | High | Multiple aliases, fuzzy matching |
| Missing hardware versions | Medium | Default to latest HW version |
| Outdated firmware info | Medium | Automated monitoring |
| Vendor page changes | Medium | Scraper resilience, manual fallback |
| Scope creep | High | Focus on KEV models first |

---

## Dependencies

- Existing MSV infrastructure (CLI, caching, output formatting)
- CISA KEV API access
- NVD API access (with API key for rate limits)
- Web scraping capabilities (for vendor pages)

---

## Timeline

| Week | Milestone | Deliverables |
|------|-----------|--------------|
| 1 | Schema & Types | RouterCatalog.json schema, TypeScript types |
| 2 | KEV Models | 79 KEV router entries, basic RouterClient |
| 3 | CLI Integration | `msv router` command, output formatting |
| 4 | Vendor Expansion | Top 50 models for NETGEAR, TP-Link, ASUS |
| 5 | Scrapers | Vendor advisory scrapers |
| 6 | Automation | CVE correlation, firmware monitoring |

---

## Next Steps

1. **Approve this plan** - Review and confirm approach
2. **Create RouterCatalog.json** - Initial schema with 5-10 test models
3. **Implement RouterClient.ts** - Core lookup logic
4. **Seed KEV models** - Populate all 79 KEV router entries
5. **CLI integration** - Add `msv router` subcommand

---

*Plan created using THEALGORITHM (THOROUGH effort)*
