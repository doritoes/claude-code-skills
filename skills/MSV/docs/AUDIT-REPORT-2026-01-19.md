# MSV Software Catalog Audit Report

**Date:** 2026-01-19
**Audit Type:** THOROUGH (THE ALGORITHM)
**Catalog Version:** 135 entries

## Executive Summary

The MSV tool's software catalog contains significant **data contamination issues** where CVEs from similarly-named but different products are being incorrectly attributed. This causes wildly incorrect MSV determinations for several critical products.

**Key Findings:**
- 6 products have severe data contamination (wrong MSV by orders of magnitude)
- 8+ products have moderate contamination affecting accuracy
- 15+ vendors have official security advisory APIs/pages that could improve accuracy
- 2 products should be marked as EOL (in addition to existing: flash, silverlight)

---

## Critical Data Contamination Issues

### Severity: CRITICAL (Wrong Product Entirely)

| Product | Expected Version | Got MSV | Contamination Source |
|---------|------------------|---------|---------------------|
| **Git** | 2.x (current: 2.47.x) | 17.10.5 | GitLab CVEs |
| **OpenSSL** | 3.x (current: 3.4.x) | 17.5.0 | pyOpenSSL (Python package) |
| **Python** | 3.x (current: 3.13.x) | 2024.18.2 | VSCode Python Extension |
| **Docker Desktop** | 4.x (current: 4.35.x) | 2024.3.5740 | Windows Remote Desktop |

### Severity: HIGH (Contaminated but Plausible)

| Product | Expected Version | Got MSV | Contamination Source |
|---------|------------------|---------|---------------------|
| **Zoom** | 5.x-6.x | 5.17.10 (plausible) | WordPress plugins ("zoom" keyword) |
| **curl** | 8.x | 8.10.0 (plausible) | Various curl wrappers |
| **OpenSSH** | 9.x | 9.6 (plausible) | Some portable SSH libs |
| **Redis** | 7.x | 7.4.2 (correct) | redis-py, redis-rb |

### Root Cause Analysis

The contamination occurs because:
1. **Generic product names** in AppThreat/NVD match multiple products
2. **No vendor filtering** - "git" matches git, gitlab, github, gitea, etc.
3. **No version pattern validation** - A Git MSV of 17.x should be rejected since Git is 2.x
4. **Library contamination** - pyOpenSSL != OpenSSL, but both have "openssl" in name

---

## Recommended Fixes

### 1. Add Version Pattern Filtering (Like PowerShell)

Products that MUST have `versionPattern` regex added:

```json
{
  "id": "git",
  "versionPattern": "^2\\.",
  "notes": "Git versions are 2.x - filter out GitLab (17.x)"
},
{
  "id": "openssl",
  "versionPattern": "^[013]\\.",
  "notes": "OpenSSL versions are 0.x, 1.x, 3.x - filter out pyOpenSSL"
},
{
  "id": "python",
  "versionPattern": "^3\\.",
  "notes": "Python 3.x only - filter out extensions/packages"
},
{
  "id": "docker",
  "versionPattern": "^4\\.",
  "notes": "Docker Desktop versions are 4.x"
}
```

### 2. Products Needing EOL Flag

| Product | EOL Date | Recommendation |
|---------|----------|----------------|
| Adobe Flash Player | 2020-12-31 | Already noted, add `eol: true` |
| Microsoft Silverlight | 2021-10-12 | Already noted, add `eol: true` |
| Node.js odd versions | Rolling | Document LTS policy |

### 3. Products Needing OS Component Flag

| Product | Reason |
|---------|--------|
| Microsoft IIS | Windows Server component |
| curl (Windows built-in) | Consider dual entry |

---

## Vendor Advisory API Opportunities

### Tier 1: APIs Available (High Priority)

| Vendor | API/Data Source | Format | Notes |
|--------|-----------------|--------|-------|
| **Microsoft MSRC** | `api.msrc.microsoft.com/cvrf/v3.0/` | CVRF/JSON | Free, no API key |
| **curl** | `curl.se/docs/vuln.json` | JSON | Complete CVE data |
| **Mozilla Firefox** | `github.com/mozilla/foundation-security-advisories` | YAML/Markdown | GitHub repo, parseable |
| **GitHub** | `api.github.com/advisories` | JSON | Global security advisories |

### Tier 2: Structured Pages (Medium Priority)

| Vendor | Security Page | Notes |
|--------|---------------|-------|
| **Adobe** | helpx.adobe.com/security.html | HTML scraping, APSB IDs |
| **Oracle** | oracle.com/security-alerts/ | Quarterly CPU, HTML |
| **Citrix** | support.citrix.com/securitybulletins | HTML, CTX IDs |
| **VMware** | vmware.com/security/advisories | VMSA IDs, HTML |
| **Grafana** | grafana.com/security/ | HTML, CVE list |

### Tier 3: Release Notes Only

| Vendor | Security Info | Notes |
|--------|---------------|-------|
| **PuTTY** | chiark.greenend.org.uk/~sgtatham/putty/changes.html | Release notes |
| **Node.js** | nodejs.org/en/blog/vulnerability | Blog posts |
| **Python** | python.org/news/security/ | News page |
| **OpenSSL** | openssl.org/news/secadv/ | Text advisories |
| **Redis** | redis.io/security/ | Security page |

---

## Existing Vendor Fetcher Status

| Fetcher | Status | Coverage |
|---------|--------|----------|
| `WiresharkAdvisoryFetcher` | **Working** | Full implementation |
| `ChromeAdvisoryFetcher` | **Stub** | Returns empty, needs NVD |
| `SolarWindsAdvisoryFetcher` | **Working** | 18+ products covered |

---

## Implementation Priorities

### Phase 1: Critical Fixes (Immediate)

1. Add `versionPattern` to Git, OpenSSL, Python, Docker Desktop
2. Update msv.ts to filter CVE results by version pattern
3. Add `eol: true` to Flash, Silverlight entries

### Phase 2: New Vendor Fetchers (High Value)

1. **MicrosoftMsrcFetcher** - Free API, covers Office 365, Edge, Teams, etc.
2. **CurlAdvisoryFetcher** - JSON API available
3. **MozillaAdvisoryFetcher** - GitHub YAML source

### Phase 3: Expanded Coverage

1. AdobePsirtFetcher - Scrape APSB bulletins
2. OracleCpuFetcher - Parse quarterly CPU
3. CitrixAdvisoryFetcher - Parse CTX bulletins

---

## Products with No CVE Data (Needs Review)

These products returned no vulnerability data, which may indicate:
- Incorrect CPE mapping
- Vendor doesn't publish CVEs
- Product is very secure

| Product | Category | Priority |
|---------|----------|----------|
| Brave Browser | browser | high |
| PeaZip | compression | low |
| Sublime Text | editor | low |
| Everything Search | utility | low |
| Greenshot | utility | low |

---

## Appendix: Test Results

### Chrome (67 KEV CVEs noted)
- MSV: 131.0.6778.204
- Sources: 56 CVEs from cache
- Issue: Chrome fetcher is stub, relies on cache

### 7-Zip (1 KEV CVE)
- MSV: 25.00 ✓ (Correct)
- Sources: 12 CVEs from AppThreat, 1 from KEV

### OpenSSH
- MSV: 9.6 (Plausible, some contamination)
- Issue: CVE-2022-31124 shows "Fixed:0.0.6" - wrong product

### OpenSSL
- MSV: 17.5.0 ✗ (WRONG - pyOpenSSL contamination)
- CVE-2018-1000807 is pyOpenSSL, not OpenSSL

### Python
- MSV: 2024.18.2 ✗ (WRONG - VSCode extension)
- CVE-2024-49050 is VSCode Python extension

### Git
- MSV: 17.10.5 ✗ (WRONG - GitLab contamination)
- CVE-2024-0402, CVE-2024-8312, etc. are GitLab

### Docker Desktop
- MSV: 2024.3.5740 ✗ (WRONG - Remote Desktop)
- CVE-2024-7572, CVE-2024-38131 are Windows Remote Desktop

### Java/JRE
- MSV: UNDETERMINED ✓ (Correct behavior)
- 8 KEV CVEs from 2010-2013 era, needs version-specific query

### Zoom
- MSV: 5.17.10 (Plausible but contaminated)
- WordPress plugin CVEs mixed in

### Redis
- MSV: 7.4.2 ✓ (Correct)
- Minor contamination from redis-py

---

## Conclusion

The MSV tool provides value but has critical data quality issues that must be addressed. The contamination pattern is consistent: generic product names pull in CVEs from similarly-named packages, libraries, and enterprise products.

**Immediate Actions:**
1. Add version pattern filtering for Git, OpenSSL, Python, Docker
2. Implement Microsoft MSRC fetcher (free API, high value)
3. Implement curl advisory fetcher (JSON API available)

**Sources:**
- [Adobe PSIRT](https://helpx.adobe.com/security.html)
- [Mozilla Security Advisories](https://www.mozilla.org/en-US/security/advisories/)
- [Mozilla GitHub Advisories](https://github.com/mozilla/foundation-security-advisories)
- [Microsoft MSRC API](https://msrc.microsoft.com/update-guide/)
- [curl Security Advisories](https://curl.se/docs/security.html)
- [Oracle Critical Patch Updates](https://www.oracle.com/security-alerts/)
