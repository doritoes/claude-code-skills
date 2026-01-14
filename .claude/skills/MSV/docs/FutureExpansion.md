# MSV Skill - Future Expansion Ideas

This document captures ideas for expanding the MSV (Minimum Safe Version) skill beyond traditional Windows desktop software.

---

## 1. Microsoft Store Apps

**Scope:** UWP and packaged apps from Microsoft Store

**Rationale:**
- Enterprise environments increasingly use Store apps for deployment
- Store apps have different update mechanisms than traditional software
- Some Store apps have had CVEs (e.g., Windows Terminal, PowerToys)

**Implementation Considerations:**
- Microsoft Store API for version information
- Package family names vs. display names
- Auto-update behavior differs from traditional software
- MSIX/AppX versioning schemes

**Example Products:**
- Windows Terminal
- Microsoft PowerToys
- Windows Subsystem for Linux (WSL)
- Your Phone / Phone Link
- Snipping Tool (new version)
- Microsoft To Do
- Sticky Notes

**Data Sources:**
- Microsoft Security Response Center (MSRC)
- Microsoft Store catalog API
- NVD (limited coverage)

---

## 2. Electron Apps

**Scope:** Desktop applications built on Electron framework

**Rationale:**
- Electron apps inherit Chromium vulnerabilities
- Many enterprise tools are Electron-based
- Embedded Chromium version often lags behind Chrome releases
- Single Chromium CVE can affect dozens of apps

**Implementation Considerations:**
- Need to track both app version AND embedded Chromium version
- Many Electron apps don't disclose Chromium version
- Update frequency varies widely by vendor
- Some apps bundle outdated Electron versions for years

**Example Products:**
- Visual Studio Code
- Slack
- Discord
- Microsoft Teams (classic)
- Notion
- Figma
- Postman
- GitHub Desktop
- Atom (deprecated)
- 1Password (desktop)
- Bitwarden (desktop)
- Signal Desktop
- WhatsApp Desktop
- Obsidian
- Typora

**Data Sources:**
- Electron releases (electronjs.org)
- Chrome releases (for Chromium version mapping)
- Individual vendor security advisories
- electron-version detection tools

**Technical Approach:**
```
MSV for Electron App = MAX(
  App-specific MSV,
  Chromium MSV mapped to Electron version
)
```

---

## 3. Browser Extensions

**Scope:** Extensions for Chrome, Edge, Firefox, Brave

**Rationale:**
- Extensions have broad permissions (read all data, modify pages)
- Supply chain attacks via extensions are increasing
- Compromised extensions can steal credentials, inject ads
- Enterprise often lacks visibility into installed extensions

**Implementation Considerations:**
- Extension IDs are platform-specific
- Version numbering varies by developer
- No central CVE tracking for most extensions
- Need to track both vulnerable AND malicious extensions
- Chrome Web Store vs. Edge Add-ons vs. Firefox Add-ons

**Categories to Track:**
| Category | Risk Level | Examples |
|----------|------------|----------|
| Password Managers | Critical | LastPass, Bitwarden, 1Password |
| Ad Blockers | High | uBlock Origin, AdBlock Plus |
| VPN/Proxy | High | NordVPN, ExpressVPN |
| Developer Tools | Medium | React DevTools, Redux DevTools |
| Productivity | Medium | Grammarly, Todoist |

**Data Sources:**
- CRXcavator (Chrome extension security analysis)
- Extension Defender
- Vendor security advisories
- Chrome Web Store API
- Browser-specific extension policies

**Special Concerns:**
- Manifest V3 migration affecting extension capabilities
- Extensions removed from stores but still installed locally
- Side-loaded/enterprise extensions not in public stores

---

## 4. Home Router Firmware

**Scope:** Consumer/SOHO routers used by work-from-home employees

**Rationale:**
- WFH employees connect to corporate resources through home networks
- Router vulnerabilities can enable MitM, DNS hijacking, lateral movement
- Most home routers never get firmware updates
- Many routers have known vulnerabilities with public exploits
- CISA KEV includes router vulnerabilities (NETGEAR, D-Link, TP-Link, etc.)

**Implementation Considerations:**
- Thousands of router models from dozens of vendors
- Firmware version formats vary wildly
- Some routers have multiple firmware branches (stock vs. ISP-branded)
- EOL routers with no available patches
- Need make + model + firmware version for accurate MSV

**Major Vendors to Track:**
| Vendor | Priority | Notes |
|--------|----------|-------|
| NETGEAR | Critical | Multiple KEV entries, Nighthawk series popular |
| TP-Link | Critical | High market share, frequent vulnerabilities |
| ASUS | High | ROG/gaming routers, AiMesh systems |
| Linksys | High | Velop mesh systems |
| D-Link | High | Legacy devices, slow patching |
| Ubiquiti | High | UniFi/AmpliFi, prosumer market |
| Synology | Medium | RT series routers |
| Eero | Medium | Amazon-owned, mesh systems |
| Google | Medium | Nest WiFi |
| Arris/Motorola | Medium | ISP-provided devices |

**Data Sources:**
- CISA KEV (has router entries)
- Router Security (routersecurity.org)
- Vendor security advisories
- NVD CPE for network devices
- Shodan/Censys for exposure data

**Input Format Proposal:**
```
# Router inventory format
make,model,firmware_version
NETGEAR,R7000,1.0.11.126
TP-Link,Archer AX6000,1.3.2
ASUS,RT-AX86U,3.0.0.4.388.22525
```

**Output Example:**
```
Router: NETGEAR R7000 (Nighthawk)
Current Firmware: 1.0.11.126
Minimum Safe Firmware: 1.0.11.134
Status: NON_COMPLIANT
CVEs: CVE-2021-45388 (KEV), CVE-2022-30078
Action: CRITICAL UPGRADE - Remote code execution vulnerability
```

**Additional Considerations:**
- ISP-provided routers (often locked firmware)
- Mesh systems (multiple nodes to track)
- Router/modem combos (gateway devices)
- Business-class routers in home offices (Cisco RV series, etc.)

---

## 5. AppThreat/vulnerability-db Integration

**Scope:** Offline-capable multi-source vulnerability database backend

**Project:** [github.com/AppThreat/vulnerability-db](https://github.com/AppThreat/vulnerability-db)
**Status:** Active, v6.5.1 (Dec 2025), MIT License
**Language:** Python 3.10+

### Rationale

AppThreat/vulnerability-db represents a paradigm shift from real-time API queries to a pre-compiled SQLite database approach. This could fundamentally enhance MSV's capabilities:

1. **Offline Operation** - No API rate limits, no network dependency
2. **Multi-Source Aggregation** - NVD + OSV + GitHub + Linux distros in one query
3. **Speed** - Local SQLite queries vs. 6-second NVD rate limits
4. **Coverage** - 12 Linux distros, npm, PyPI, Go, Rust, and more
5. **Standards-Based** - CVE 5.2 schema, PURL, CPE, VERS formats

### Key Features

| Feature | Benefit for MSV |
|---------|-----------------|
| Pre-built SQLite databases | ~700MB apps-only, refreshed every 6 hours |
| Multi-format queries | CPE, PURL, CVE ID, git URL all supported |
| CVE 5.2 schema | Structured access to descriptions, affected versions, fixes |
| Custom vulnerability data | Add private CVEs, override false positives |
| CycloneDX SBOM processing | Batch vulnerability assessment |
| MCP server | AI/LLM integration built-in |

### Data Sources Aggregated

```
┌─────────────────────────────────────────────────────────────┐
│                 AppThreat vulnerability-db                   │
├─────────────────────────────────────────────────────────────┤
│  NVD (2002-present)  │  OSV (Google)  │  GitHub Advisories  │
├──────────────────────┼────────────────┼─────────────────────┤
│  Linux vuln-list:                                           │
│  Alpine, Debian, Ubuntu, RHEL, CentOS, Rocky, Alma,         │
│  Oracle, Amazon, SUSE, Photon, Chainguard                   │
├─────────────────────────────────────────────────────────────┤
│  Ecosystems: npm, PyPI, Go, Rust, Maven, NuGet, Cargo       │
└─────────────────────────────────────────────────────────────┘
```

### Integration Architecture

```
Current MSV Architecture:
┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
│ CISA KEV │───▶│ VulnCheck│───▶│   NVD    │───▶│   EPSS   │
│  (API)   │    │  (API)   │    │  (API)   │    │  (API)   │
└──────────┘    └──────────┘    └──────────┘    └──────────┘
     │               │               │               │
     └───────────────┴───────────────┴───────────────┘
                           │
                    Rate Limited, Online Required

Proposed Hybrid Architecture:
┌─────────────────────────────────────────────────────────────┐
│              AppThreat SQLite Database (Primary)             │
│         ~700MB, refreshed daily, offline queries             │
└─────────────────────────────────────────────────────────────┘
                           │
              ┌────────────┴────────────┐
              ▼                         ▼
    ┌──────────────────┐      ┌──────────────────┐
    │   Fast Offline   │      │  API Enrichment  │
    │   CVE Lookup     │      │  (KEV, EPSS)     │
    └──────────────────┘      └──────────────────┘
```

### Implementation Approach

**Phase 1: Database Integration**
```typescript
// New: AppThreatClient.ts
interface AppThreatConfig {
  databasePath: string;      // Path to data.vdb6
  indexPath: string;         // Path to data.index.vdb6
  autoUpdate: boolean;       // Download if stale
  maxAgeDays: number;        // Staleness threshold
}

class AppThreatClient {
  async searchByCpe(cpe: string): Promise<VulnResult[]>;
  async searchByPurl(purl: string): Promise<VulnResult[]>;
  async searchByCveId(cveId: string): Promise<CVE52>;
  async needsUpdate(): Promise<boolean>;
  async downloadDatabase(): Promise<void>;
}
```

**Phase 2: Query Flow Enhancement**
```
1. Check AppThreat SQLite (instant, offline)
2. Enrich with CISA KEV status (is it actively exploited?)
3. Enrich with EPSS scores (exploitation probability)
4. Fall back to live APIs only if SQLite miss
```

**Phase 3: New Capabilities**
- SBOM-based batch vulnerability assessment
- PURL support for package manager ecosystems (npm, PyPI, NuGet)
- Linux server software coverage
- Private vulnerability tracking

### Benefits

| Benefit | Impact | Notes |
|---------|--------|-------|
| **Offline capability** | Critical | Air-gapped environments, travel, outages |
| **Query speed** | High | Milliseconds vs. seconds per query |
| **No rate limits** | High | Batch thousands of queries instantly |
| **Multi-source confidence** | High | Cross-reference NVD + OSV + GitHub |
| **Ecosystem expansion** | High | npm, PyPI, Go, Rust, Maven support |
| **Linux coverage** | Medium | Server software (nginx, Apache, etc.) |
| **SBOM integration** | Medium | CycloneDX/SPDX batch processing |
| **CVE 5.2 schema** | Medium | Structured data, better parsing |
| **Private CVEs** | Medium | Internal vulnerability tracking |

### Expected Challenges

| Challenge | Severity | Mitigation |
|-----------|----------|------------|
| **Database size** | Medium | ~700MB download; use apps-only variant |
| **Staleness** | Medium | 6-hour refresh cycle; supplement with KEV API |
| **Windows CPE gaps** | Medium | NVD still primary for Windows desktop apps |
| **Python dependency** | Low | Use SQLite directly from TypeScript/Bun |
| **Schema learning curve** | Low | CVE 5.2 is well-documented |
| **Initial download** | Low | One-time 700MB; incremental updates |

### Database Access from TypeScript

The `.vdb6` files are standard SQLite databases. Direct access from Bun/TypeScript:

```typescript
import { Database } from "bun:sqlite";

const db = new Database("data.vdb6", { readonly: true });

// Query by CPE
const results = db.query(`
  SELECT cve_id, source_data
  FROM vulnerabilities
  WHERE cpe_match LIKE ?
`).all("%putty%");

// Parse CVE 5.2 JSON
for (const row of results) {
  const cve = JSON.parse(row.source_data);
  console.log(cve.containers.cna.descriptions[0].value);
}
```

### New CLI Commands (Proposed)

```bash
# Database management
msv db update              # Download/update AppThreat database
msv db status              # Show database version, age, size
msv db search "putty"      # Direct database search

# SBOM processing
msv sbom scan bom.json     # Scan CycloneDX SBOM for vulnerabilities
msv sbom generate          # Generate SBOM from installed software

# Package ecosystem queries
msv query "pkg:npm/lodash@4.17.20"
msv query "pkg:pypi/requests@2.28.0"
```

### Comparison: Current vs. With AppThreat

| Metric | Current (API-only) | With AppThreat |
|--------|-------------------|----------------|
| Query latency | 6-30 seconds | <100ms |
| Offline support | None | Full |
| Rate limits | 5 req/30s (NVD) | Unlimited |
| Data sources | 4 (KEV, NVD, EPSS, VulnCheck) | 15+ |
| Ecosystems | Windows desktop | Windows + npm + PyPI + Go + Linux |
| Batch queries | Minutes | Seconds |
| Coverage freshness | Real-time | 6 hours |

### Priority Assessment

| Factor | Rating | Justification |
|--------|--------|---------------|
| Value add | **HIGH** | Transforms MSV from online-only to hybrid |
| Implementation effort | **MEDIUM** | SQLite integration straightforward |
| Maintenance burden | **LOW** | Upstream project actively maintained |
| Risk | **LOW** | MIT license, standard formats |

**Recommendation:** HIGH PRIORITY - This integration would be transformative for MSV's capabilities, enabling offline operation, batch processing, and ecosystem expansion beyond Windows desktop software.

---

## 6. Wazuh/osquery Endpoint Integration

**Scope:** Import software inventory from enterprise endpoint visibility tools

**Project References:**
- [Wazuh](https://wazuh.com/) - Open source SIEM/XDR with agent-based inventory
- [osquery](https://osquery.io/) - Facebook's endpoint visibility tool (SQL interface)

**Status:** Planned
**Priority:** HIGH - Enables real enterprise workflows

### Rationale

MSV is only useful if you can feed it real software inventory data. Enterprise tools like Wazuh and osquery provide this data but use different naming conventions than MSV's catalog.

1. **Bridge the gap** - Connect endpoint visibility to vulnerability assessment
2. **Normalize naming** - Map "Google Chrome for Enterprise" → "chrome"
3. **Batch processing** - Assess hundreds of endpoints in seconds
4. **Compliance reporting** - Generate audit-ready reports

### Supported Tools (Priority Order)

| Tool | License | Complexity | Data Quality |
|------|---------|------------|--------------|
| **osquery standalone** | Apache 2.0 | Low | High |
| **Wazuh** | GPL v2 | Medium | High |
| **Velociraptor** | AGPL v3 | Medium | High |
| **Fleet** | MIT | Medium | High |

### osquery Data Format

```sql
-- Windows software inventory query
SELECT name, version, publisher, install_date
FROM programs;

-- Output example:
-- name                        | version           | publisher
-- Google Chrome               | 120.0.6099.130    | Google LLC
-- PuTTY release 0.78          | 0.78.0.0          | Simon Tatham
-- 7-Zip 23.01 (x64)           | 23.01             | Igor Pavlov
-- IBM MQ                      | 9.3.0.15          | IBM Corp
```

### Integration Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Endpoint Sources                          │
├──────────────┬──────────────┬──────────────┬────────────────┤
│   osquery    │    Wazuh     │ Velociraptor │   Fleet        │
│   (JSON)     │   (API/CSV)  │    (JSON)    │   (API)        │
└──────┬───────┴──────┬───────┴──────┬───────┴───────┬────────┘
       │              │              │               │
       └──────────────┴──────────────┴───────────────┘
                              │
                              ▼
               ┌──────────────────────────────┐
               │   MSV Import Adapter Layer    │
               │  ┌────────────────────────┐  │
               │  │  Name Normalizer       │  │
               │  │  - Fuzzy matching      │  │
               │  │  - Publisher mapping   │  │
               │  │  - Version extraction  │  │
               │  └────────────────────────┘  │
               └──────────────────────────────┘
                              │
                              ▼
               ┌──────────────────────────────┐
               │      MSV Compliance Check     │
               │  - Map to catalog entries    │
               │  - Query AppThreat/APIs      │
               │  - Generate report           │
               └──────────────────────────────┘
```

### Name Normalization Challenge

| osquery Output | Expected MSV Input | Mapping Strategy |
|----------------|-------------------|------------------|
| `Google Chrome` | `chrome` | Direct alias match |
| `PuTTY release 0.78` | `putty` | Regex extraction |
| `7-Zip 23.01 (x64)` | `7-zip` | Strip version/arch |
| `Microsoft Edge` | `edge` | Publisher + name |
| `IBM MQ Explorer` | `ibm_mq` | Fuzzy match |
| `Adobe Acrobat Reader DC` | `acrobat_reader_dc` | Alias lookup |

### Implementation Approach

**Phase 1: osquery Adapter**
```typescript
// New: OsqueryAdapter.ts
interface OsqueryProgram {
  name: string;
  version: string;
  publisher?: string;
  install_date?: string;
}

interface NormalizedSoftware {
  originalName: string;
  msvId: string | null;       // Matched catalog ID
  version: string;
  confidence: number;         // 0-1 match confidence
  matchMethod: 'exact' | 'alias' | 'fuzzy' | 'publisher';
}

class OsqueryAdapter {
  async parseJsonExport(path: string): Promise<OsqueryProgram[]>;
  async normalize(programs: OsqueryProgram[]): Promise<NormalizedSoftware[]>;
  async generateComplianceInput(normalized: NormalizedSoftware[]): Promise<string>;
}
```

**Phase 2: Name Normalizer**
```typescript
// New: SoftwareNormalizer.ts
class SoftwareNormalizer {
  // Exact alias match from catalog
  matchByAlias(name: string): string | null;

  // Publisher-based matching
  matchByPublisher(name: string, publisher: string): string | null;

  // Fuzzy string matching (Levenshtein distance)
  matchFuzzy(name: string, threshold: number): string | null;

  // Extract version from name (e.g., "7-Zip 23.01" → "23.01")
  extractVersion(name: string): string | null;

  // Clean name for matching (lowercase, remove version/arch)
  cleanName(name: string): string;
}
```

**Phase 3: CLI Commands**
```bash
# Import from osquery JSON export
msv import osquery software.json

# Import from Wazuh API
msv import wazuh --server https://wazuh.local --agent agent-001

# Import with manual mapping review
msv import osquery software.json --review

# Generate mapping report (shows unmatched software)
msv import osquery software.json --dry-run
```

### Output Formats

**Compliance Report:**
```
Endpoint Software Compliance Report
Generated: 2026-01-14 10:30:00
Source: osquery export (workstation-001)
================================================================================

SUMMARY
  Total Software: 45
  Matched to Catalog: 38 (84%)
  Compliant: 31
  Non-Compliant: 5
  Unknown (no MSV data): 2
  Unmatched: 7

NON-COMPLIANT SOFTWARE
  Software              Installed    MSV Required    Gap
  ─────────────────────────────────────────────────────────
  Google Chrome         120.0.6099   131.0.6778      CRITICAL
  PuTTY                 0.78         0.81            HIGH
  7-Zip                 23.01        25.00           MEDIUM
  IBM MQ                9.3.0.15     9.4.0.7         MEDIUM
  Firefox               128.0        133.0           MEDIUM

UNMATCHED SOFTWARE (add to catalog or ignore)
  - Microsoft Visual C++ 2019 Redistributable
  - Intel Graphics Driver
  - Dell SupportAssist
  - HP Wolf Security
  ...
```

**CSV Export:**
```csv
software,installed_version,msv_required,status,match_confidence
Google Chrome,120.0.6099.130,131.0.6778.204,NON_COMPLIANT,1.0
PuTTY,0.78,0.81,NON_COMPLIANT,0.95
7-Zip,23.01,25.00,NON_COMPLIANT,1.0
Microsoft Edge,120.0.2210.91,120.0.2210.91,COMPLIANT,1.0
```

### Wazuh-Specific Integration

```bash
# Wazuh syscollector packages query
GET /syscollector/{agent_id}/packages

# Response includes:
{
  "name": "google-chrome-stable",
  "version": "120.0.6099.130-1",
  "vendor": "Google LLC",
  "install_time": "2024-01-15T10:30:00Z"
}
```

### Quick Start (Lab Setup)

```powershell
# 1. Install osquery on Windows
winget install osquery.osquery

# 2. Export software inventory
osqueryi --json "SELECT name, version, publisher FROM programs" > software.json

# 3. Run MSV compliance check (future command)
msv import osquery software.json --report compliance.csv
```

### Benefits

| Benefit | Impact |
|---------|--------|
| **Real enterprise data** | Stop using synthetic test data |
| **Automated pipeline** | Scheduled compliance checks |
| **Gap identification** | Find software not in catalog |
| **Audit trail** | Historical compliance tracking |
| **Multi-endpoint** | Aggregate across fleet |

### Expected Challenges

| Challenge | Severity | Mitigation |
|-----------|----------|------------|
| Name variations | HIGH | Fuzzy matching + alias expansion |
| Version format inconsistency | MEDIUM | Robust version parser |
| Unmatched software | MEDIUM | Manual mapping workflow |
| Wazuh API auth | LOW | Support API key + basic auth |
| Large datasets | LOW | Streaming/pagination |

### Priority Assessment

| Factor | Rating | Justification |
|--------|--------|---------------|
| Value add | **HIGH** | Enables real enterprise use cases |
| Implementation effort | **MEDIUM** | Name normalization is the hard part |
| Maintenance burden | **LOW** | osquery format is stable |
| Risk | **LOW** | Open source, well-documented APIs |

**Recommendation:** HIGH PRIORITY - This integration transforms MSV from a manual lookup tool into an automated compliance pipeline. Start with osquery standalone (simplest), then add Wazuh support.

---

## 7. IoT Devices (Future)

**Scope:** Smart home devices that may affect corporate security

**Rationale:**
- IoT devices on same network as work devices
- Can be entry points for lateral movement
- Often have hardcoded credentials, no updates

**Example Categories:**
- Smart speakers (Alexa, Google Home)
- Smart cameras (Ring, Nest, Wyze)
- Smart TVs
- NAS devices (Synology, QNAP - already have KEV entries)

---

## Implementation Priority

| Category | Priority | Effort | Impact | Status |
|----------|----------|--------|--------|--------|
| **Community Release Fixes** | **CRITICAL** | Low | **Blocking** | 🔴 4 critical, 6 high issues |
| **AppThreat Integration** | **DONE** | Medium | **Transformative** | ✅ Implemented |
| **Wazuh/osquery Integration** | **HIGH** | Medium | High - Enterprise workflows | Planned |
| Home Routers | HIGH | Medium | High - WFH security | Planned |
| Electron Apps | HIGH | Medium | High - Enterprise tools | Planned |
| Browser Extensions | MEDIUM | High | Medium - Hard to inventory | Idea |
| Microsoft Store | LOW | Low | Low - Auto-updates | Idea |
| IoT Devices | LOW | High | Low - Scope creep | Idea |

---

## Data Model Extensions

### Router Entry Schema
```json
{
  "id": "netgear_r7000",
  "displayName": "NETGEAR R7000 (Nighthawk)",
  "vendor": "netgear",
  "product": "r7000",
  "category": "router",
  "firmwareBranches": [
    {"branch": "1.0.11", "msv": "1.0.11.134", "latest": "1.0.11.140"},
    {"branch": "1.0.9", "msv": "1.0.9.88", "latest": "1.0.9.88", "eol": true}
  ],
  "platforms": ["firmware"],
  "notes": "Popular consumer router. Multiple KEV entries."
}
```

### Electron App Entry Schema
```json
{
  "id": "slack_desktop",
  "displayName": "Slack Desktop",
  "vendor": "slack",
  "product": "slack",
  "category": "electron",
  "electronVersion": "25.9.0",
  "chromiumVersion": "114.0.5735.289",
  "chromiumMsv": "114.0.5735.198",
  "platforms": ["windows"],
  "notes": "Electron-based. Check embedded Chromium version."
}
```

---

## 8. Community Release Readiness - Critical Review

**Review Date:** 2026-01-14
**Methodology:** THE ALGORITHM (THOROUGH effort)
**Scope:** Architecture, code quality, documentation, user experience

This section documents issues that must be addressed before packaging MSV as a community-shareable skill pack.

### Executive Summary

| Severity | Count | Status |
|----------|-------|--------|
| **CRITICAL** | 4 | Must fix before release |
| **HIGH** | 6 | Should fix before release |
| **MEDIUM** | 5 | Nice to have |
| **LOW** | 4 | Future improvements |

**Overall Assessment:** MSV is functionally solid but has several issues that would cause friction for community users. The most critical issues are missing infrastructure files (.gitignore, empty workflows) and hardcoded paths.

---

### CRITICAL Issues (Blocking Release)

These issues will cause the skill to fail or confuse users immediately.

#### C1. Missing .gitignore File
**Impact:** Cache files, temp files, and sensitive data committed to git
**Location:** `.claude/skills/MSV/` (missing)
**Evidence:**
- 50+ NVD CVE cache files in `data/` directory
- `msv-cache.json` with query results
- `tmpclaude-*` temp files in root and tools directories

**Fix Required:**
```gitignore
# MSV .gitignore
data/*.json
!data/SoftwareCatalog.json
tmpclaude-*
*.log
.env
```

#### C2. Empty Workflows Directory
**Impact:** SKILL.md references non-existent workflow files
**Location:** `workflows/` directory is empty
**Evidence:** SKILL.md lines 24-28 reference:
- `workflows/Query.md` - does not exist
- `workflows/Batch.md` - does not exist
- `workflows/Refresh.md` - does not exist

**Fix Required:** Either create the workflow files or remove references from SKILL.md.

#### C3. Hardcoded User Path in Output
**Impact:** Shows developer's username to all users
**Location:** `tools/msv.ts:1464`
**Evidence:**
```typescript
Location:      C:\\Users\\sethh\\AppData\\Local\\vdb\\vdb\\
```

**Fix Required:** Use dynamic path resolution:
```typescript
Location:      ${join(homedir(), 'AppData', 'Local', 'vdb', 'vdb')}
```

#### C4. Debug Script in Production
**Impact:** Confuses users, clutters codebase
**Location:** `tools/query-nvd.ts`
**Evidence:** 38-line test script with hardcoded Wireshark query, not used by main CLI

**Fix Required:** Delete `tools/query-nvd.ts` or move to `tests/` directory.

---

### HIGH Priority Issues (Should Fix)

These issues affect reliability and user experience.

#### H1. No Timeout on HTTP Requests
**Impact:** Requests can hang indefinitely, blocking the CLI
**Location:** `CisaKevClient.ts`, `NvdClient.ts`, `EpssClient.ts`
**Evidence:** Only `VulnCheckClient.ts` implements timeout handling

**Fix Required:** Add timeout to all fetch calls:
```typescript
const response = await fetch(url, {
  signal: AbortSignal.timeout(30000) // 30 second timeout
});
```

#### H2. Silent Error Swallowing
**Impact:** Errors hidden from users, hard to debug
**Location:** 10+ empty `catch {}` blocks across codebase
**Evidence:**
```
AppThreatClient.ts:187, 212, 230
CisaKevClient.ts:85
EpssClient.ts:90
MsvCache.ts:68
NvdClient.ts:153, 366
```

**Fix Required:** At minimum, log errors to stderr:
```typescript
} catch (error) {
  console.error(`[MSV] Error: ${error.message}`);
  return null;
}
```

#### H3. SKILL.md Outdated - Missing AppThreat
**Impact:** Documentation doesn't reflect actual capabilities
**Location:** `SKILL.md` Data Sources table (lines 30-37)
**Evidence:** AppThreat (B2 rating, offline queries) not listed despite being integrated

**Fix Required:** Update Data Sources table to include AppThreat.

#### H4. Temp Files Polluting Directories
**Impact:** Unprofessional appearance, confuses users
**Location:** Root directory and tools/
**Evidence:**
```
tmpclaude-24af-cwd, tmpclaude-2f3e-cwd, tmpclaude-562d-cwd
tmpclaude-87b4-cwd, tmpclaude-b01f-cwd, tmpclaude-e230-cwd
```

**Fix Required:** Clean up temp files, add to .gitignore.

#### H5. No Version Number in Skill
**Impact:** Users can't track which version they have
**Location:** SKILL.md, package metadata
**Evidence:** Version only defined in `msv.ts:1518` as `MSV_VERSION = "1.1.0"`

**Fix Required:** Add version to SKILL.md frontmatter and create CHANGELOG.md.

#### H6. No Installation/Setup Documentation
**Impact:** Users don't know prerequisites
**Location:** Missing
**Evidence:** No mention of:
- Bun runtime requirement
- VulnCheck API key setup (optional but recommended)
- AppThreat database installation
- Windows-only limitation

**Fix Required:** Create `docs/Installation.md` or add to SKILL.md.

---

### MEDIUM Priority Issues (Nice to Have)

These issues affect code quality but don't block usage.

#### M1. No Test Suite
**Impact:** No confidence in refactoring, hard to verify fixes
**Location:** Missing `tests/` directory
**Evidence:** 5,900 lines of TypeScript with 0 tests

**Fix Required:** Add basic test coverage for:
- Version comparison logic
- Admiralty rating calculation
- Software catalog lookup

#### M2. Inconsistent Error Messages
**Impact:** Confusing user experience
**Evidence:** Mix of `Error:`, `Failed to`, `[MSV]` prefixes

**Fix Required:** Standardize error message format.

#### M3. 86 Console.log Statements
**Impact:** Noisy output, no log level control
**Evidence:** `grep -c "console.log\|console.error"` = 86

**Fix Required:** Consider structured logging with verbosity levels.

#### M4. Type Safety - 3 Uses of `any`
**Impact:** Minor type safety concern
**Evidence:** `grep -c "any"` = 3

**Fix Required:** Replace with proper types.

#### M5. Large Main File (56KB)
**Impact:** Hard to maintain, navigate
**Location:** `tools/msv.ts` - 1,700+ lines
**Evidence:** Contains CLI, business logic, formatting, and output all in one file

**Fix Required:** Consider splitting into smaller modules.

---

### LOW Priority Issues (Future)

These are improvements for future iterations.

#### L1. Windows-Only Support
**Impact:** Limits community adoption
**Evidence:** Skill description says "Windows 11/Server software"

**Future:** Consider adding macOS/Linux software support.

#### L2. No Caching Configuration
**Impact:** Users can't customize cache behavior
**Evidence:** TTLs hardcoded in source

**Future:** Add configuration file for cache TTLs.

#### L3. No Progress Indicators for Long Operations
**Impact:** Users unsure if CLI is working
**Evidence:** Batch queries can take minutes with no feedback

**Future:** Add progress bars or status updates.

#### L4. No Shell Completion
**Impact:** CLI usability
**Evidence:** No bash/zsh/fish completion scripts

**Future:** Add shell completion for commands and software names.

---

### Recommended Fix Order

**Phase 1: Critical Fixes (Before Any Sharing)**
1. Create `.gitignore` with proper patterns
2. Remove `query-nvd.ts` debug script
3. Fix hardcoded path in `msv.ts:1464`
4. Either create workflow files OR remove references from SKILL.md
5. Clean up all `tmpclaude-*` temp files

**Phase 2: High Priority (Before Public Release)**
1. Add timeouts to all HTTP clients
2. Replace empty catch blocks with error logging
3. Update SKILL.md with AppThreat data source
4. Add version to SKILL.md and create CHANGELOG.md
5. Create `docs/Installation.md` with prerequisites

**Phase 3: Quality Improvements**
1. Add basic test suite
2. Standardize error messages
3. Consider splitting `msv.ts` into modules

---

### Code Metrics Summary

| Metric | Value | Assessment |
|--------|-------|------------|
| TypeScript LOC | 5,900 | Substantial codebase |
| Source files | 15 | Reasonable modularity |
| HTTP clients | 5 | Good separation |
| Catch blocks | 29 | Mostly silent (issue) |
| Console statements | 86 | Too many for CLI tool |
| Test files | 0 | Critical gap |
| Documentation files | 4 | Adequate |

---

## Notes

- AppThreat integration is now complete (✅) - enables offline queries, batch processing
- **Wazuh/osquery integration is the recommended next step** - enables real enterprise workflows
- Each category requires significant research and data source integration
- Router firmware tracking would provide unique value for WFH security programs
- Electron app tracking could leverage existing Chromium KEV data

## References

- [AppThreat/vulnerability-db](https://github.com/AppThreat/vulnerability-db) - Multi-source SQLite vulnerability database
- [CISA KEV Catalog](https://www.cisa.gov/known-exploited-vulnerabilities-catalog) - Known exploited vulnerabilities
- [NVD API 2.0](https://nvd.nist.gov/developers/vulnerabilities) - National Vulnerability Database
- [CVE 5.2 Schema](https://cveproject.github.io/cve-schema/schema/docs/) - Standard vulnerability format
- [Package URL (PURL)](https://github.com/package-url/purl-spec) - Universal package identifier

---

*Last Updated: 2026-01-14*
