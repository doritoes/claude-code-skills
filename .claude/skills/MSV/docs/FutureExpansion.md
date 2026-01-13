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

## 6. IoT Devices (Future)

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

| Category | Priority | Effort | Impact |
|----------|----------|--------|--------|
| **AppThreat Integration** | **CRITICAL** | Medium | **Transformative** - Offline, speed, ecosystems |
| Home Routers | HIGH | Medium | High - WFH security |
| Electron Apps | HIGH | Medium | High - Enterprise tools |
| Browser Extensions | MEDIUM | High | Medium - Hard to inventory |
| Microsoft Store | LOW | Low | Low - Auto-updates |
| IoT Devices | LOW | High | Low - Scope creep |

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

## Notes

- These are ideas for future development, not current capabilities
- Each category requires significant research and data source integration
- **AppThreat integration is the recommended next step** - it enables all other expansions
- Router firmware tracking would provide unique value for WFH security programs
- Electron app tracking could leverage existing Chromium KEV data

## References

- [AppThreat/vulnerability-db](https://github.com/AppThreat/vulnerability-db) - Multi-source SQLite vulnerability database
- [CISA KEV Catalog](https://www.cisa.gov/known-exploited-vulnerabilities-catalog) - Known exploited vulnerabilities
- [NVD API 2.0](https://nvd.nist.gov/developers/vulnerabilities) - National Vulnerability Database
- [CVE 5.2 Schema](https://cveproject.github.io/cve-schema/schema/docs/) - Standard vulnerability format
- [Package URL (PURL)](https://github.com/package-url/purl-spec) - Universal package identifier

---

*Last Updated: 2026-01-13*
