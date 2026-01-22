# MSV Roadmap

**Last Updated:** 2026-01-21
**Current Version:** 1.3.1

This roadmap outlines planned improvements and future directions for the MSV (Minimum Safe Version) skill.

---

## Current State Summary

| Metric | Value |
|--------|-------|
| Software Catalog Entries | 189 |
| Test Coverage | 203 tests |
| Vendor Advisory Fetchers | 13 |
| Data Sources | 6 (AppThreat, CISA KEV, VulnCheck, NVD, EPSS, Vendor) |
| Supported Ecosystems | Windows desktop, GHSA (npm/pip/maven/nuget/go/rust) |

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
| **Home Router Firmware** | HIGH | High | Planned |
| **Electron App Tracking** | HIGH | Medium | Planned |
| **Microsoft Store Apps** | LOW | Low | Idea |

### Home Router Firmware
Track minimum safe firmware for consumer/SOHO routers:

**Target Vendors:**
- NETGEAR (multiple KEV entries)
- TP-Link (high market share)
- ASUS (ROG/gaming routers)
- Linksys (Velop mesh)
- Ubiquiti (UniFi/AmpliFi)

**Input Format:**
```csv
make,model,firmware_version
NETGEAR,R7000,1.0.11.126
TP-Link,Archer AX6000,1.3.2
```

**Data Sources:**
- CISA KEV (has router entries)
- Vendor security advisories
- routersecurity.org

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
