# CTI Report Feature Requirements

**Version:** 1.0
**Author:** PAI (Personal AI Infrastructure)
**Created:** 2026-02-02

## Overview

The MSV skill's CTI (Cyber Threat Intelligence) Report feature generates operational threat intelligence reports from vulnerability data. Reports are customizable based on organizational context and follow BLUF (Bottom Line Up Front) format.

## Traffic Light Protocol (TLP) Marking

| TLP Level | Condition | Sharing |
|-----------|-----------|---------|
| **TLP:WHITE** | General landscape report, no customization | Unlimited distribution |
| **TLP:GREEN** | Customized to organization, no specific threats identified | Community sharing OK |
| **TLP:AMBER** | Customized with specific threats to organization | Limited to org + clients/partners |

## Data Refresh Strategy

| Period | Granularity | Purpose |
|--------|-------------|---------|
| Last 7 days | Day-by-day | Tactical awareness |
| Last 30 days | Weekly aggregation | Trend identification |

## User Profile (Optional Customization)

```typescript
interface CTIUserProfile {
  companyName?: string;           // e.g., "ACME Corp"
  industry?: string;              // e.g., "Financial Services", "Healthcare"
  employeeCount?: number;         // Affects threat relevance
  region?: string;                // e.g., "North America", "EMEA"
  softwareInventory?: string[];   // Products from MSV catalog
  focusAreas?: string[];          // e.g., "endpoint", "network", "cloud"
  complianceFrameworks?: string[];// e.g., "PCI-DSS", "HIPAA", "SOC2"
}
```

## Report Structure (1-Pager)

### Header
```
╔════════════════════════════════════════════════════════════════╗
║ TLP:GREEN          CYBER THREAT INTELLIGENCE REPORT           ║
║                    Week of 2026-01-27 to 2026-02-02           ║
║                    Prepared for: ACME Corp                    ║
╚════════════════════════════════════════════════════════════════╝
```

### BLUF Section (Bottom Line Up Front)
- 2-3 sentences summarizing the most critical findings
- Action items that require immediate attention
- Overall threat posture assessment (Elevated/Normal/Reduced)

### Section 1: Critical Zero-Days
- New KEV additions this period
- Zero-days affecting user's software inventory (if provided)
- Exploitation status (active in wild, PoC available)

### Section 2: Exploitation Trends
- EPSS score spikes (>10% increase)
- Ransomware campaign associations
- Industry-targeted campaigns

### Section 3: Software Inventory Status (if profile provided)
- MSV compliance status for user's inventory
- New CVEs affecting tracked software
- Remediation priority (based on risk score)

### Section 4: Industry-Relevant Intelligence (if profile provided)
- Sector-specific threats
- Regulatory implications
- Peer organization targeting

### Data Validation Footer
```
─────────────────────────────────────────────────────────────────
Data Sources: CISA KEV, NVD, EPSS, VulnCheck
KEV Catalog:  2026-02-02 08:00:00 UTC (current)
NVD Data:     2026-02-02 06:30:00 UTC (current)
EPSS Scores:  2026-02-02 00:00:00 UTC (current)
Report ID:    CTI-20260202-001
Generated:    2026-02-02 10:15:00 UTC
─────────────────────────────────────────────────────────────────
```

## CLI Usage

```bash
# General landscape report (TLP:WHITE)
msv cti report

# Weekly report with date range
msv cti report --period week --format markdown

# Daily tactical report
msv cti report --period day --format text

# Customized report (TLP:GREEN or TLP:AMBER)
msv cti report --profile company-profile.json

# Inline profile options
msv cti report --company "ACME Corp" --industry "Financial Services"

# Focus on specific software
msv cti report --inventory "Chrome,Edge,PuTTY,WinRAR"

# JSON output for integration
msv cti report --format json --output cti-report.json

# Refresh data before generating
msv cti report --force-refresh
```

## Profile File Format

**company-profile.json:**
```json
{
  "companyName": "ACME Corp",
  "industry": "Financial Services",
  "employeeCount": 5000,
  "region": "North America",
  "softwareInventory": [
    "chrome", "edge", "putty", "winrar", "wireshark",
    "7zip", "adobe_reader_dc", "notepadpp"
  ],
  "focusAreas": ["endpoint", "network"],
  "complianceFrameworks": ["PCI-DSS", "SOC2"]
}
```

## Output Formats

| Format | Use Case |
|--------|----------|
| `text` | Terminal display, quick review |
| `markdown` | Documentation, sharing, Slack/Teams |
| `json` | API integration, SIEM ingestion |
| `pdf` | Executive distribution (future) |

## Intelligence Aggregation Logic

### KEV Delta Detection
```typescript
// Compare current KEV to cached KEV from 7/30 days ago
const newKevEntries = currentKev.filter(
  entry => new Date(entry.dateAdded) >= reportStartDate
);
```

### EPSS Spike Detection
```typescript
// Flag CVEs where EPSS increased significantly
const epssSpikes = currentEpss.filter(entry => {
  const historical = getHistoricalEpss(entry.cve, 7); // 7 days ago
  return entry.epss - historical.epss > 0.10; // 10% increase
});
```

### Industry Relevance Scoring
```typescript
// Map industries to commonly targeted software
const industryTargets = {
  "Financial Services": ["citrix", "fortinet", "paloalto", "f5"],
  "Healthcare": ["citrix", "vmware", "cisco", "philips"],
  "Manufacturing": ["rockwell", "siemens", "schneider", "aveva"],
  "Government": ["microsoft", "adobe", "oracle", "solarwinds"],
};
```

## Implementation Components

### New Files
1. `tools/CtiReportGenerator.ts` - Main report generation logic
2. `tools/CtiTypes.ts` - TypeScript interfaces for CTI
3. `tools/CtiFormatter.ts` - Report formatting (text, markdown, json)
4. `tools/IntelligenceAggregator.ts` - Data collection and analysis
5. `data/IndustryMappings.json` - Industry to software/threat mappings

### Modified Files
1. `tools/msv.ts` - Add `cti` command group
2. `tools/CisaKevClient.ts` - Add historical delta methods
3. `tools/EpssClient.ts` - Add historical comparison methods

## Acceptance Criteria

1. [ ] `msv cti report` generates valid TLP:WHITE general report
2. [ ] `--profile` flag loads and applies user customization
3. [ ] TLP marking automatically escalates to AMBER when specific threats found
4. [ ] BLUF section accurately summarizes critical findings
5. [ ] Data validation footer shows all source timestamps
6. [ ] Day-by-day granularity for 7-day period
7. [ ] Weekly aggregation for 30-day period
8. [ ] All output formats (text, markdown, json) work correctly
9. [ ] Report fits on 1 page when printed (approx 60 lines)
10. [ ] Historical KEV/EPSS comparison works correctly
