# MSV Vendor Advisory Fetcher Improvement Plan

**Generated:** 2026-02-03
**Status:** Active

## Current State Assessment

### Fetcher Status (12 total)

| Vendor | Status | Root Cause | Priority |
|--------|--------|------------|----------|
| **Palo Alto** | ✅ PASS | Has fallback branch data + API works | - |
| **SonicWall** | ✅ PASS | API returns branch data | - |
| **Fortinet** | ❌ PARTIAL | RSS lacks version data, needs page scraping | CRITICAL |
| **Cisco** | ❌ FAIL | No branch calculation implemented | HIGH |
| **Curl** | ❌ FAIL | Returns non-standard interface | MEDIUM |
| **Mozilla** | ❌ FAIL | Class doesn't export fetch() method | MEDIUM |
| **Microsoft MSRC** | ❌ FAIL | Class doesn't export fetch() method | HIGH |
| **VMware** | ❌ FAIL | Returns null/undefined | MEDIUM |
| **Atlassian** | ❌ FAIL | API returns 400 Bad Request | MEDIUM |
| **Citrix** | ❌ FAIL | Returns null/undefined | MEDIUM |
| **Adobe** | ❌ FAIL | 30s timeout (slow API) | LOW |
| **Oracle** | ❌ FAIL | Returns null/undefined | LOW |

### Issue Categories

1. **Data Availability Issues** (hardest to fix)
   - Fortinet: RSS summaries don't include version ranges
   - Need to scrape individual advisory pages

2. **API/Interface Issues** (medium difficulty)
   - Mozilla, MSRC: Don't export proper class interface
   - Need wrapper classes in VendorAdvisory.ts

3. **API Broken/Changed** (requires investigation)
   - Atlassian: 400 Bad Request
   - VMware, Citrix, Oracle: Returning null

4. **Performance Issues**
   - Adobe: 30s timeout

---

## Priority Fixes

### CRITICAL: Fortinet Fetcher Enhancement

**Problem:** RSS feed descriptions don't contain version ranges
**Solution Options:**
1. **Add fallback branch data** (like Palo Alto) - Quick fix
2. **Scrape individual advisory pages** - Complete but slow
3. **Use Fortinet's CVSS API** if available

**Quick Fix Implementation:**
```typescript
// Add to FortinetAdvisoryFetcher.calculateBranchMsv()
if (branchMap.size === 0) {
  // Fallback to known FortiOS versions
  const knownLatest: Record<string, string> = {
    "7.6": "7.6.4",
    "7.4": "7.4.8",
    "7.2": "7.2.10",
    "7.0": "7.0.17",
    "6.4": "6.4.16",
  };
  for (const [branch, latest] of Object.entries(knownLatest)) {
    branchMap.set(branch, { msv: latest, latest });
  }
}
```

### HIGH: Microsoft MSRC Integration

**Problem:** Wrapper class in VendorAdvisory.ts doesn't properly integrate
**Solution:** Fix MsrcVendorAdvisoryFetcher wrapper class

### HIGH: Cisco Branch Calculation

**Problem:** Fetcher exists but doesn't calculate branches
**Solution:** Add calculateBranchMsv() similar to Palo Alto

---

## Improvement Phases

### Phase 1: Quick Wins (1-2 hours)
- [x] Add fallback branch data to Fortinet (like Palo Alto)
- [ ] Add fallback branch data to Cisco
- [ ] Fix Mozilla wrapper class
- [ ] Fix MSRC wrapper class

### Phase 2: API Fixes (2-4 hours)
- [ ] Debug Atlassian 400 error
- [ ] Debug VMware null response
- [ ] Debug Citrix null response
- [ ] Increase Adobe timeout or implement async

### Phase 3: Data Quality (4-8 hours)
- [ ] Implement Fortinet advisory page scraping for real version data
- [ ] Implement Cisco IOS-XE version parsing
- [ ] Add more granular branch tracking

### Phase 4: Coverage Expansion (ongoing)
- [ ] Juniper Networks
- [ ] F5 BIG-IP
- [ ] Check Point
- [ ] Ivanti/Pulse Secure
- [ ] Trend Micro
- [ ] McAfee/Trellix
- [ ] CrowdStrike
- [ ] Zscaler

---

## Success Metrics

| Metric | Current | Target |
|--------|---------|--------|
| Passing fetchers | 2/12 (17%) | 10/12 (83%) |
| Fetchers with version data | 0/12 (0%) | 6/12 (50%) |
| Network security vendors covered | 4 | 8 |
| Average response time | ~15s | <5s |

---

## Vendor Advisory Data Sources

### High-Quality Sources (structured data)
- **Palo Alto**: security.paloaltonetworks.com (JSON API) ✅
- **SonicWall**: psirt.sonicwall.com (JSON API) ✅
- **Cisco**: sec.cloudapps.cisco.com/security (JSON API)
- **Fortinet**: fortiguard.com (RSS + per-advisory pages)
- **Microsoft MSRC**: msrc.microsoft.com (JSON API)

### Medium-Quality Sources (semi-structured)
- **VMware**: vmware.com/security/advisories (HTML)
- **Atlassian**: confluence.atlassian.com/security (HTML)
- **Citrix**: support.citrix.com/securitybulletins (HTML)

### Low-Quality Sources (need scraping)
- **Adobe**: helpx.adobe.com/security (HTML)
- **Oracle**: oracle.com/security-alerts (HTML, quarterly)

---

## Recommended New Vendors

### Network Security (high priority for Seth's firewall focus)
1. **Juniper Networks** - JunOS advisories
2. **F5 Networks** - BIG-IP, NGINX
3. **Check Point** - sk advisories
4. **Ivanti** - Connect Secure, Policy Secure

### Endpoint Security
1. **CrowdStrike** - Falcon platform
2. **Trend Micro** - Deep Security, Apex One
3. **McAfee/Trellix** - ENS, ePO

### Cloud Security
1. **Zscaler** - ZIA, ZPA
2. **Cloudflare** - WAF, Access

---

---

## Future Tasks (Backlog)

### Task 1: Evaluate Fallback Version Accuracy
**Priority:** HIGH
**Trigger:** `use the algorithm to evaluate fallback fetchers`

Fetchers using fallback/hardcoded version data need validation:
- Fortinet: Hardcoded FortiOS 7.6.4, 7.4.8, 7.2.10, 7.0.17, 6.4.16
- Cisco ASA: Hardcoded 9.22.1, 9.21.2, 9.20.3, etc.
- Palo Alto: Hardcoded 11.2.6, 11.1.6, 11.0.7, etc.

**Analysis needed:**
1. Compare hardcoded versions against actual vendor release pages
2. Determine staleness of fallback data
3. Consider lowering Admiralty confidence rating when using fallbacks
4. Implement automatic version freshness checking

**Impact on Admiralty Rating:**
- Currently: Fallback data gets same confidence as API data
- Proposed: Reduce confidence by 1 level when using fallbacks
  - B2 → C3 (Reliable → Probably True)
  - Mark as "inferred from known branches"

### Task 2: Improve Test Coverage
**Priority:** MEDIUM
**Trigger:** `improve MSV test coverage`

Current gaps:
1. Unit tests for individual fetcher parsing functions
2. Integration tests for VendorAdvisory.ts wrapper classes
3. Mock API responses for offline testing
4. Cache invalidation testing
5. Branch calculation edge cases
6. Version comparison edge cases

**Proposed test structure:**
```
tools/tests/
  ├── test-all-fetchers.ts      # ✅ Integration (exists)
  ├── unit/
  │   ├── fortinet.test.ts      # Parsing tests
  │   ├── paloalto.test.ts
  │   ├── cisco.test.ts
  │   └── version-compare.test.ts
  ├── mocks/
  │   ├── fortinet-rss.xml
  │   ├── paloalto-api.json
  │   └── cisco-cvrf.xml
  └── fixtures/
      └── sample-advisories.json
```

### Task 3: Add New Vendor Fetchers
**Priority:** MEDIUM
**Trigger:** `add more vendor fetchers to MSV`

Network security vendors (aligned with Seth's firewall expertise):
1. **Juniper Networks** - JunOS Security Advisories
2. **F5 Networks** - BIG-IP, NGINX
3. **Check Point** - sk articles, CloudGuard
4. **Ivanti** - Connect Secure, Policy Secure (critical KEV targets)

---

## Implementation Notes

### Wrapper Pattern
All fetchers should be wrapped in VendorAdvisory.ts for consistent interface:

```typescript
class VendorXAdvisoryFetcher extends VendorAdvisoryFetcher {
  async fetch(): Promise<VendorAdvisoryResult> {
    return fetchVendorXAdvisories(this.cacheDir, this.product);
  }
}
```

### Branch Fallback Pattern
When API/RSS doesn't provide version data, use known-good fallback:

```typescript
if (branchMap.size === 0) {
  const knownLatest = { "10.0": "10.0.5", "9.0": "9.0.12" };
  for (const [branch, latest] of Object.entries(knownLatest)) {
    branchMap.set(branch, { msv: latest, latest });
  }
}
```

### Testing
Run test suite after each change:
```bash
cd .claude/skills/MSV/tools/tests
bun test-all-fetchers.ts
```
