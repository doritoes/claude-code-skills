# MSV Roadmap

**Last Updated:** 2026-02-03
**Current Version:** 1.9.0

This roadmap outlines planned improvements and future directions for the MSV (Minimum Safe Version) skill.

---

## Current State Summary

| Metric | Value |
|--------|-------|
| Software Catalog Entries | 189 |
| Router Catalog Models | 89 (21 vendors) |
| Test Coverage | 325 tests (107 router tests) |
| Vendor Advisory Fetchers | 18 (100% passing) |
| Data Sources | 7 (AppThreat, CISA KEV, VulnCheck, NVD, EPSS, Vendor, Router Catalog) |
| Supported Ecosystems | Windows desktop, GHSA (npm/pip/maven/nuget/go/rust), Router Firmware, ISP Gateways |
| Network Security Vendors | 11 (Fortinet, Palo Alto, Cisco, SonicWall, Citrix, Juniper, Ivanti, F5, Check Point, OPNsense, pfSense) |

---

## Version 1.4.0 - Enterprise Integration (Next)

**Theme:** Connect MSV to real enterprise software inventory tools

### Features

| Feature | Priority | Effort | Status |
|---------|----------|--------|--------|
| **osquery Adapter** | HIGH | Medium | Planned |
| **Software Name Normalizer** | HIGH | Medium | Planned |
| **Wazuh API Integration** | HIGH | Medium | Planned |
| **Fleet Integration** | MEDIUM | Low | Planned |

### osquery Adapter
Import software inventory from osquery JSON exports:
```bash
# Future command
msv import osquery software.json --report compliance.csv
```

**Implementation:**
- `OsqueryAdapter.ts` - Parse osquery JSON export
- Fuzzy name matching to MSV catalog
- Publisher-based software identification
- Confidence scoring for matches

### Software Name Normalizer
Map real-world software names to MSV catalog entries:

| osquery Output | MSV Catalog ID |
|----------------|----------------|
| `Google Chrome` | `chrome` |
| `PuTTY release 0.78` | `putty` |
| `7-Zip 23.01 (x64)` | `7-zip` |
| `Microsoft Edge` | `edge` |

**Implementation:**
- `SoftwareNormalizer.ts` - Multi-strategy matching
- Levenshtein distance for fuzzy matching
- Publisher lookup table
- Version extraction from name strings

### Wazuh Integration
Query Wazuh API for endpoint software inventory:
```bash
# Future command
msv import wazuh --server https://wazuh.local --agent agent-001
```

---

## Version 1.5.0 - Ecosystem Expansion

**Theme:** Extend coverage beyond Windows desktop software

### Features

| Feature | Priority | Effort | Status |
|---------|----------|--------|--------|
| **Home Router Firmware** | HIGH | High | **DONE** |
| **Electron App Tracking** | HIGH | Medium | Planned |
| **Microsoft Store Apps** | LOW | Low | Idea |

### Home Router Firmware ✅ COMPLETE

Track minimum safe firmware for consumer/SOHO routers.

**Implemented Components:**
- `RouterTypes.ts` - Full type system (Vendor, Model, HardwareVersion, FirmwareBranch)
- `RouterCatalog.json` - 35 models across 9 vendors with KEV CVE data
- `RouterClient.ts` - Fuzzy matching, version comparison, risk scoring
- `RouterNvdClient.ts` - CPE-based CVE queries for automated MSV lookup
- `RouterCatalogUpdater.ts` - Automated catalog refresh from NVD
- 53 tests covering all router functionality

**Supported Vendors (9):**

| Vendor | Models | Trust Rating | KEV CVEs |
|--------|--------|--------------|----------|
| NETGEAR | 5 | HIGH | 5 |
| ASUS | 6 | MEDIUM-HIGH | 2 |
| TP-Link | 7 | MEDIUM | 3 |
| D-Link | 13 | LOW | 25+ |
| Zyxel | 4 | MEDIUM | 12 |
| MikroTik | 1 | MEDIUM | 2 |
| DrayTek | 1 | MEDIUM-HIGH | 1 |
| Tenda | 2 | LOW | 4 |
| Ubiquiti | 1 | MEDIUM-HIGH | 1 |

**Usage:**
```bash
# Query router MSV
msv router query "NETGEAR R7000"
msv router query "TP-Link Archer AX21" --firmware 1.1.2

# Check compliance with current firmware
msv router query "ASUS RT-AX88U" --firmware 3.0.0.4.388_24198

# List vendors and models
msv router vendors
msv router models netgear

# Automated catalog update (dry-run)
msv router update

# Query single model's NVD data
msv router update netgear_r7000
```

**Risk Scoring:**
- 0-19: MINIMAL - Firmware compliant, trusted vendor
- 20-39: LOW - Firmware compliant, some concerns
- 40-59: MEDIUM - Firmware outdated, no KEV CVEs
- 60-79: HIGH - Firmware outdated with concerns
- 80-100: CRITICAL - KEV CVEs, EOL, or untrusted vendor

**Future Router Improvements (Phase 4):**
1. **Additional Models** - More consumer routers from existing vendors
2. **Version History** - Track firmware release timeline
3. **Alternative Firmware** - DD-WRT, OpenWrt, Tomato support status
4. **Automated Advisory Scraping** - When vendors add RSS/API feeds
5. **CVE Timeline** - Show days since disclosure vs. patch availability

### Electron App Tracking
Track embedded Chromium versions in Electron apps:

**Challenge:** Electron apps inherit Chromium vulnerabilities but often lag behind Chrome releases.

**Target Apps:**
- Slack, Discord, Teams (classic)
- VS Code, Notion, Obsidian
- 1Password, Bitwarden (desktop)
- Signal Desktop, WhatsApp Desktop

**Approach:**
```
MSV for Electron App = MAX(
  App-specific MSV,
  Chromium MSV mapped to Electron version
)
```

---

## Version 2.0.0 - Major Release

**Theme:** Full enterprise vulnerability management platform

### Features

| Feature | Priority | Effort | Status |
|---------|----------|--------|--------|
| **Multi-OS Support** | HIGH | High | Planned |
| **SBOM Pipeline** | MEDIUM | Medium | In Progress |
| **Browser Extension Security** | MEDIUM | High | Idea |
| **API Server Mode** | MEDIUM | Medium | Idea |

### Multi-OS Support
Extend beyond Windows to macOS and Linux:

**macOS Additions:**
- Homebrew packages
- macOS system updates
- Safari

**Linux Additions:**
- Package manager integration (apt, yum, dnf)
- Kernel version tracking
- Container base images

### Full SBOM Pipeline
End-to-end SBOM vulnerability assessment:

```bash
# Generate SBOM from installed software
msv sbom generate --format cyclonedx > bom.json

# Assess SBOM for vulnerabilities
msv sbom scan bom.json --report compliance.html

# CI/CD gate
msv sbom scan bom.json --fail-on critical
```

### Browser Extension Security
Track vulnerabilities in browser extensions:

**Categories:**
- Password managers (LastPass, Bitwarden, 1Password)
- Ad blockers (uBlock Origin, AdBlock Plus)
- VPN/Proxy extensions
- Developer tools

**Challenges:**
- No central CVE tracking
- Extension IDs are platform-specific
- Removed extensions still installed locally

---

## Next Priorities (v2.0.0 Track)

### HIGH: Fallback Data Quality System
**Discovered:** During v1.9.0 fetcher stabilization
**Problem:** 6 fetchers rely on hardcoded fallback versions that can become stale

**Current Fallback Fetchers:**
| Fetcher | Fallback Data | Risk |
|---------|---------------|------|
| Fortinet FortiOS | 7.6.4, 7.4.8, 7.2.10, 7.0.17, 6.4.16 | HIGH - Active releases |
| Palo Alto PAN-OS | 11.2.6, 11.1.6, 11.0.7, 10.2.12, 10.1.14 | HIGH - Active releases |
| Cisco ASA | 9.22.1, 9.21.2, 9.20.3, etc. | MEDIUM - Slower release cycle |
| Atlassian | Confluence 9.3.1/8.5.17, Jira 10.6.0 | MEDIUM - Quarterly releases |
| Citrix | NetScaler 14.1-29.72, 13.1-55.36 | MEDIUM - Quarterly releases |
| Adobe | Acrobat DC 25.001.20432 | HIGH - Monthly patches |

**Proposed Solutions:**
1. **Version Freshness Checker** - Compare fallback versions against vendor release pages
2. **Confidence Rating Adjustment** - Lower Admiralty rating when using fallback data (B2 → C3)
3. **Staleness Warning** - Display warning when fallback data > 30 days old
4. **Automated Scraping** - Periodically scrape vendor release notes for latest versions

**Trigger:** `use the algorithm to evaluate fallback fetchers`

### HIGH: API Change Monitoring
**Discovered:** VMware, Atlassian, Citrix APIs all changed without notice

**Proposed Solutions:**
1. **Health Check Endpoint** - Daily test of all fetcher endpoints
2. **Response Schema Validation** - Detect when API response structure changes
3. **Alert on Degradation** - Notify when fetcher starts returning fallback data
4. **Canary Tests** - Automated tests that run periodically

**Trigger:** `add API monitoring to MSV fetchers`

### HIGH: Enterprise Integration (osquery/Wazuh)
**Status:** Planned (highest value-add remaining)
**Details:** See FutureExpansion.md Section 6

**What It Enables:**
- Import real software inventory from endpoints
- Batch compliance checking across fleet
- Automated pipeline from osquery → MSV → compliance report

**Trigger:** `add osquery integration to MSV`

### MEDIUM: New Vendor Fetchers
**Aligned with Seth's network security focus:**

| Vendor | Priority | Data Source | Notes |
|--------|----------|-------------|-------|
| **Juniper JunOS** | HIGH | NVD API + fallback | ✅ DONE - 8 branches (25.2R1 to 21.4R3) |
| **Ivanti** | HIGH | Ivanti RSS feed | ✅ DONE - Connect Secure, Policy Secure, ZTA, EPMM |
| **F5 BIG-IP** | HIGH | NVD API + fallback | ✅ DONE - 6 branches (17.1 to 13.1), K articles |
| **Check Point** | HIGH | NVD API + fallback | ✅ DONE - 8 branches (R82 to R77.30), sk articles |

**Trigger:** `add F5 fetcher to MSV`

---

## Ongoing Improvements

### Catalog Expansion

| Milestone | Target | Status |
|-----------|--------|--------|
| 200 entries | Q1 2026 | In Progress |
| 250 entries | Q2 2026 | Planned |
| 300 entries | Q3 2026 | Planned |

**Priority Additions:**
- More enterprise security tools (EDR, SIEM, DLP)
- Database servers (PostgreSQL, MySQL, MongoDB)
- Container tools (Docker, Kubernetes, containerd)
- CI/CD tools (Jenkins, GitLab, GitHub Actions runners)

### Test Coverage

| Milestone | Target | Status |
|-----------|--------|--------|
| 250 tests | Q1 2026 | Planned |
| 300 tests | Q2 2026 | Planned |

**Focus Areas:**
- Integration tests for all vendor fetchers
- Edge cases for version comparison
- Error recovery scenarios
- Performance benchmarks

### Performance Optimizations

| Optimization | Impact | Status |
|--------------|--------|--------|
| SQLite query caching | 10x faster repeat queries | Done (AppThreat) |
| Parallel API requests | 5x faster batch | Done |
| NVD API key support | 10x rate limit | Done |
| Request deduplication | Reduce redundant calls | Planned |
| Background cache refresh | Fresh data without blocking | Planned |

### Code Quality

| Improvement | Priority | Status |
|-------------|----------|--------|
| Structured logging (Logger.ts) | HIGH | Done |
| Error codes (MsvError.ts) | HIGH | Done |
| Type safety (types.ts) | MEDIUM | Done |
| Code splitting (format.ts, catalog.ts) | MEDIUM | Done |
| HTTP timeouts | MEDIUM | Partial |
| Shell completions | LOW | Done |

---

## Completed Milestones

### v1.10.0 (2026-02-03)
- **Network Security Vendor Expansion - Enterprise + Open Source Firewalls**
  - **F5 BIG-IP Fetcher**: NVD API + fallback for 6 branches (17.1, 17.0, 16.1, 15.1, 14.1, 13.1)
    - Products: LTM, ASM, APM, GTM, AFM, F5OS, BIG-IP Next
    - K article format (K######)
    - Critical infrastructure: load balancers, WAF, access management
  - **Check Point Gaia OS Fetcher**: NVD API + fallback for 8 branches (R82 to R77.30)
    - Products: Security Gateway, Management Server, CloudGuard, Maestro, VSX
    - sk article format (sk######)
    - Seth's primary firewall vendor (CCSE/CCME certified)
  - **OPNsense Fetcher**: endoflife.date API + NVD for 5 branches (26.1 to 24.1)
    - Open-source FreeBSD-based firewall (fork of pfSense)
    - Calendar versioning: YY.R (24.7, 25.1, 26.1)
    - Uses structured JSON from endoflife.date for accurate release tracking
  - **pfSense Fetcher**: NVD API + fallback for Plus and CE editions
    - pfSense Plus (commercial): YY.MM format (25.11, 24.11)
    - pfSense CE (community): X.Y.Z format (2.8.1, 2.7.2)
    - Advisory format: pfSense-SA-YY_XX.component
  - **Network Security Vendors now at 11**: Fortinet, Palo Alto, Cisco, SonicWall, Citrix, Juniper, Ivanti, F5, Check Point, OPNsense, pfSense
  - **Total Vendor Fetchers: 18** (up from 14)

### v1.9.0 (2026-02-03)
- **Vendor Advisory Fetcher Stabilization - 100% Pass Rate**
  - **All 14 fetchers now passing** (was 5/12 before fixes)
  - **New Network Security Fetchers:**
    - **Juniper JunOS**: NVD API + fallback data for 8 branches (25.2R1 to 21.4R3)
    - **Ivanti**: RSS feed (ivanti.com/blog/topics/security-advisory/rss), 19+ advisories
      - Products: Connect Secure, Policy Secure, ZTA Gateway, EPMM, Avalanche
      - WARNING: Ivanti products are frequent CISA KEV targets
  - **API Format Fixes:**
    - Microsoft MSRC: Fixed title field extraction (`{Value: "..."}` → string)
    - VMware: Updated for new API format (`data.list` vs `advisoryList`)
    - Atlassian: Removed pagination params (API change caused 400 errors)
  - **Timeout/Error Handling:**
    - Adobe: Increased timeout to 60s, graceful fallback on timeout
    - Citrix: Added fallback data (page became JavaScript SPA)
  - **Branch Calculation Fixes:**
    - Oracle: Added fallback branches for Java, MySQL, VirtualBox, WebLogic
    - Fortinet/Cisco: Added fallback branch data
  - **Fetcher Distribution:**
    - 7 with live API data: Firefox, Edge, VMware, Curl, Oracle, SonicWall, Ivanti
    - 7 with fallback branches: Fortinet, Palo Alto, Cisco, Atlassian, Citrix, Adobe, Juniper
  - **Test Harness:** `test-all-fetchers.ts` for validating all 14 fetchers

### v1.8.0 (2026-01-22)
- **Router Phase 7 - Popular Retail Models (Newegg/Amazon Best Sellers)**
  - **TP-Link Archer AX11000** (User Request)
    - WiFi 6 tri-band gaming router
    - **MSV: 1.0.0 Build 20230523** (fixes CVE-2023-40357 OS command injection)
    - Latest: 1.2.7 Build 20240126
  - **WiFi 7 Flagship Routers:**
    - ASUS RT-BE96U (BE19000 flagship, dual 10G, 320MHz, MLO)
    - ASUS RT-BE88U (BE9300, dual 10G + SFP+)
    - NETGEAR Nighthawk RS700S (BE19000, tri-band)
    - NETGEAR RS90 (BE3600, budget WiFi 7)
    - Ubiquiti Dream Router 7 (BE9300, UniFi OS)
  - **TP-Link WiFi 7 Lineup:**
    - Archer GE800 (BE19000 gaming, Tom's Hardware Best Gaming)
    - Archer BE9700 (BE9300, Tom's Hardware Best Overall)
    - Archer BE3600 (BE5800, Best Budget WiFi 7)
  - **WiFi 6/6E Popular:**
    - Archer AXE75 (AX5400 WiFi 6E, PCMag 2025 Editor's Choice)
    - ASUS RT-AX86U Pro (AX5700, popular WiFi 6 upgrade)
  - **Coverage Improvements:**
    - 11 new models (78 → 89 total)
    - Added ax5700 WiFi standard
    - Models based on Newegg/Amazon best sellers
  - **Testing:**
    - 15 new Phase 7 tests (92 → 107 total router tests)
    - Tests for WiFi 7 flagships, TP-Link lineup, catalog stats
  - **RouterCatalog v2.4.0**

### v1.7.0 (2026-01-22)
- **Router Phase 6 - WFH Router Coverage 2010-Present**
  - **New Vendors (5):**
    - **Belkin** - 8 models (N750, N600, N450, N300, AC1200, AC1900, F9K1122 extender, F9K1015 extender)
      - Trust rating: LOW (Foxconn subsidiary, poor vulnerability response)
      - Multiple CVEs including command injection and buffer overflow
    - **ARRIS/Motorola** - 5 models (SBG6580, SBG7580, SBG8300, NVG589, NVG599)
      - Trust rating: LOW (hardcoded credentials, RCE vulnerabilities)
      - ISP gateway support for AT&T U-verse (NVG series)
    - **Buffalo** - 3 models (WZR-HP-G300NH, WZR-1750DHP, WSR-3200AX4S)
      - Trust rating: MEDIUM (popular in Asia, CVE-2021-20090 path traversal)
      - DD-WRT/OpenWrt support for older models
    - **Actiontec** - 4 models (MI424WR, C1000A, C2000A, T3200)
      - Trust rating: LOW (CSRF, backdoor accounts)
      - ISP gateways for Verizon FiOS and CenturyLink
    - **Huawei** - 5 models (HG532, HG8245, WS5200, WS7100, AX3)
      - Trust rating: MEDIUM (CNA with bug bounty, but CVE-2017-17215 Mirai target)
      - HG532 marked as CRITICAL KEV CVE - Mirai botnet target
  - **Coverage Improvements:**
    - Added routers from 2010-2025 to cover WFH workers with legacy equipment
    - 25 new router models (53 → 78 total)
    - 5 new vendors (15 → 21 total, including ISP sub-brands)
    - WiFi standards: added ax1500, ac1600 to type system
  - **KEV/CVE Tracking:**
    - Huawei HG532: CVE-2017-17215 (CISA KEV - Mirai botnet)
    - Buffalo WZR-1750DHP: CVE-2021-20090 (path traversal)
    - Belkin N600: CVE-2015-5987/5988/5989/5990 (multiple vulns)
    - Actiontec MI424WR: CVE-2014-0357/0358 (CSRF)
  - **Testing:**
    - 29 new Phase 6 tests (63 → 92 total router tests)
    - Tests for all new vendors: Belkin, ARRIS, Buffalo, Actiontec, Huawei
    - Alias matching tests (Motorola → ARRIS, Verizon FiOS → Actiontec)
    - Catalog stats validation (70+ models, 20+ vendors)
  - **RouterCatalog v2.3.0**

### v1.6.0 (2026-01-22)
- **Router Phase 5 - Major Expansion**
  - **ISP Gateway Support**
    - New category: `isp-gateway`
    - New type: `IspGatewayInfo` with OEM vendor, ISP model, bridge mode availability
    - New type: `IspProvider` enum (xfinity, verizon, att, spectrum, cox, centurylink, frontier)
    - 6 ISP gateway models: Xfinity XB7/XB8, Verizon G1100/G3100, AT&T BGW210/BGW320
    - 3 new vendors: xfinity, verizon, att
  - **WiFi 7 Router Support**
    - New WiFi standards: be5800, be9300, be19000, be24000 (WiFi 7)
    - WiFi 6E support: ax4200
    - 4 WiFi 7 models: TP-Link Archer BE550, ASUS RT-BE58U, ASUS ROG GT-BE98 Pro, Netgear Orbi 370
  - **New Consumer Vendors**
    - Amazon (eero): eero Pro 6E mesh system
    - Google: Nest WiFi Pro mesh system
    - Linksys: Velop MX5300, Hydra Pro 6E
  - **Expanded Alternative Firmware**
    - OpenWrt/DD-WRT data for: TP-Link Archer AX21 (v1, v3), ASUS RT-AX86U, D-Link DIR-859
    - EOL devices show alt firmware as secure alternative option
  - **Type System Additions**
    - `FirmwareRelease` type for version history tracking
    - `versionHistory` field on `FirmwareBranch`
    - `ispGateway` field on `RouterModel`
  - **Catalog Expansion**
    - RouterCatalog v2.2.0
    - 53 models (up from 35)
    - 15 vendors (up from 9)
    - 37 KEV-affected entries
  - **Testing**
    - 17 new Phase 5 tests (63 total router tests)
    - Tests for ISP gateways, WiFi 7, new vendors, expanded altFirmware

### v1.5.0 (2026-01-22)
- **Router Phase 4 - Advanced Features**
  - Alternative firmware support (DD-WRT, OpenWrt, Tomato)
    - New types: `AltFirmwareStatus`, `AltFirmwareInfo`
    - `altFirmware` field on `HardwareVersion`
    - Display in `formatRouterResult`
  - CVE timeline tracking
    - New type: `CveTimeline` with disclosure dates, days-since-disclosure
    - `cveTimeline` field on `RouterResult`
    - Timeline display in KEV CVE output
  - Batch router compliance (batchQuery with CSV support)
  - 8 new Phase 4 tests (61 total router tests)
  - RouterCatalog v2.1.0 with altFirmware data for NETGEAR R7000

### v1.4.0 (2026-01-21)
- **Home Router Firmware Support** - Complete implementation
  - RouterTypes.ts - Full type system for router firmware tracking
  - RouterCatalog.json - 35 models, 9 vendors, 36 KEV-affected entries
  - RouterClient.ts - Fuzzy matching, version comparison, risk scoring
  - RouterNvdClient.ts - CPE-based CVE queries from NVD
  - RouterCatalogUpdater.ts - Automated catalog refresh
  - `msv router` CLI with query, vendors, models, stats, update subcommands
  - 53 new tests (38 RouterClient + 15 RouterNvdClient)

### v1.3.0 (2026-01-21)
- MSRC client for Microsoft products
- Structured logging
- Test stability fixes

### v1.2.0 (2026-01-19)
- Risk scoring (0-100 scale)
- 5 vendor fetchers (curl, Mozilla, VMware, Atlassian, Citrix)
- Data contamination fixes
- 153 catalog entries

### v1.1.0 (2026-01-14)
- Vendor advisory framework
- Multi-branch MSV support
- Compliance checking
- AppThreat offline DB

### v1.0.0 (2026-01-13)
- Initial release
- Core MSV calculation
- 120 catalog entries
- CISA KEV, NVD, EPSS, VulnCheck integration

---

## Example Improvement Areas

### From Recent CSV Testing (2026-01-21)

The CSV parsing tests demonstrated working functionality:
- `applications.csv` (names only) - batch processing works
- `applications_with_versions.csv` (name + version) - compliance check works

**Potential Improvements Identified:**
1. **Better unknown handling** - Notepad++ returned "undetermined" (no CVE data in NVD for this product)
2. **Version branch awareness** - Wireshark correctly uses branch-aware MSV
3. **Data freshness** - Cache was 2 days old; could benefit from background refresh

### From FutureExpansion.md Review

**HIGH Priority (Next Steps):**
1. Wazuh/osquery integration - enables real enterprise workflows
2. Home routers - WFH security gap
3. Electron apps - enterprise tools with inherited Chromium vulns

**MEDIUM Priority:**
1. Browser extensions - high risk but hard to inventory
2. Microsoft Store apps - auto-updates reduce urgency

---

## Contributing

To propose roadmap items:
1. Open an issue with the `roadmap` label
2. Describe the use case and expected impact
3. Include data source availability assessment

---

## References

- [CISA KEV Catalog](https://www.cisa.gov/known-exploited-vulnerabilities-catalog)
- [AppThreat/vulnerability-db](https://github.com/AppThreat/vulnerability-db)
- [NVD API 2.0](https://nvd.nist.gov/developers/vulnerabilities)
- [osquery](https://osquery.io/)
- [Wazuh](https://wazuh.com/)
