# Changelog

All notable changes to the MSV (Minimum Safe Version) skill are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.4.0] - 2026-02-02

### Added
- **CTI Report Generator** - Cyber Threat Intelligence reports from vulnerability data
  - `msv cti report` - Generate operational threat intelligence reports
  - `msv cti report --company "ACME" --industry "Financial"` - Customized reports
  - `msv cti report --period day|week` - Daily tactical or weekly strategic reports
  - `msv cti report --inventory "chrome,edge,putty"` - Track specific software
  - `msv cti help` - Show all CTI options
  - TLP marking: WHITE (general), GREEN (customized), AMBER (specific threats)
  - BLUF (Bottom Line Up Front) executive summary format
  - Data validation footer with source timestamps
- New CTI components:
  - `CtiReportGenerator.ts` - Main report generation logic
  - `CtiFormatter.ts` - Report formatting (text, markdown, json)
  - `CtiTypes.ts` - TypeScript interfaces for CTI
  - `IntelligenceAggregator.ts` - Data collection and analysis
- `docs/CTI-REPORT-REQUIREMENTS.md` - Feature specification

### Changed
- Version bumped to 1.4.0

## [Unreleased]

### Added
- **`msv warm` command** - Cache warming for proactive MSV pre-fetching
  - Pre-fetch MSV data for catalog entries before they're needed
  - Filter by priority: `msv warm critical`, `msv warm high`, `msv warm all`
  - Parallel processing with configurable concurrency
  - Shows progress with elapsed time and completion percentage
- **`msv scan` command** - Installed software version detection and compliance
  - Auto-detect installed software via winget and chocolatey
  - Match installed packages to MSV catalog
  - Check compliance against known MSVs
  - Output: table of software, versions, MSV, and compliance status
- **Parallel batch processing** - Query multiple products simultaneously
  - `--parallel` flag (default: enabled) for concurrent API queries
  - `--no-parallel` or `--sequential` for sequential processing
  - `--concurrency N` to control parallel worker count (default: 5)
  - Progress indicators show completion percentage during batch operations
- **`msv discover` command** - Interactive CPE auto-discovery with smart inference
  - Search NVD CPE dictionary for any software
  - Auto-infer category from 25+ patterns (browser, vpn, security, monitoring, etc.)
  - Auto-infer priority based on KEV history and product type
  - Auto-detect vendor fetcher availability (curl, mozilla, vmware, etc.)
  - `--confirm <num>` option to add selected match to catalog
- **Software catalog expansion (164 → 182 entries, +11%):**
  - Security/EDR: Carbon Black, Trellix, Symantec Endpoint Protection
  - VPN: GlobalProtect, Cisco AnyConnect, FortiClient, Ivanti Connect Secure
  - Development: Visual Studio, IntelliJ IDEA
  - Communication: Webex
  - Backup: Acronis Cyber Protect, Veritas NetBackup
  - Management: Ivanti EPMM, ManageEngine Desktop Central, PaperCut MF
  - File Transfer: Progress MOVEit
  - Remote Access: BeyondTrust
  - Network Security: Barracuda ESG, Sophos Firewall, F5 BIG-IP
- Progress indicators for batch operations with ETA and elapsed time
- Shell completion scripts for bash, zsh, and PowerShell
- Standardized error handling with `MsvError` class and error codes
- `Progress.ts` utility for progress bars and spinners
- **Test coverage expansion (84 → 203 tests, +142%):**
  - `VersionCompare.test.ts` - Edge cases: prerelease ordering, build metadata, invalid inputs
  - `DataContamination.test.ts` - Version pattern and exclude pattern filtering
  - `VendorFetchers.test.ts` - Unit tests for all 8 vendor advisory fetchers
  - `ErrorHandling.test.ts` - MsvError class, error codes, formatting, recovery logic
- **5 new vendor advisory fetchers:**
  - `VMwareAdvisoryFetcher.ts` - Broadcom/VMware JSON API (ESXi, vCenter, Workstation)
  - `AtlassianAdvisoryFetcher.ts` - Atlassian CVE API (Jira, Confluence, Bamboo, Bitbucket)
  - `CitrixAdvisoryFetcher.ts` - Citrix security bulletins (NetScaler, XenServer)
  - `AdobeAdvisoryFetcher.ts` - Adobe PSIRT bulletins (Acrobat, Reader, Creative Cloud)
  - `OracleAdvisoryFetcher.ts` - Oracle CPU advisories (Java, WebLogic, MySQL, VirtualBox)
- 11 new software catalog entries for new vendors
- `yaml` package added as dependency for MozillaAdvisoryFetcher
- **4 new enterprise firewall vendor fetchers:**
  - `FortinetAdvisoryFetcher.ts` - FortiGuard PSIRT RSS feed (FortiOS, FortiGate, FortiClient)
  - `PaloAltoAdvisoryFetcher.ts` - Palo Alto Security API (PAN-OS, GlobalProtect, Cortex)
  - `CiscoAdvisoryFetcher.ts` - Cisco PSIRT openVuln API (ASA, FTD, IOS XE)
  - `SonicWallAdvisoryFetcher.ts` - SonicWall PSIRT portal (SonicOS, SMA)
- **GitHub Advisory Database integration:**
  - `GitHubAdvisoryClient.ts` - GraphQL API client for GHSA
  - `msv ghsa <ecosystem> [package]` - Query npm, pip, maven, nuget, go, rust vulnerabilities
  - MSV calculation for open source packages
  - Requires GITHUB_TOKEN for authentication
- **SBOM integration (CycloneDX/SPDX):**
  - `SbomParser.ts` - Parse CycloneDX v1.4-1.6 and SPDX v2.2-2.3 JSON
  - `msv sbom <file>` - Check MSV compliance for SBOM components
  - Automatic format detection
  - Separates Windows software from open source packages
  - Cross-references with GHSA for open source components
- **Software catalog expansion (182 → 189 entries, +4%):**
  - Firewall: FortiOS, PAN-OS, Cisco ASA, Cisco FTD, SonicOS
  - VPN: SonicWall SMA
- **Data Quality Improvements:**
  - `VersionMapper.ts` - Vendor-specific version normalization
    - Adobe year-based versions (2024.001.20643, 24.001.x)
    - Java update notation (8u401 → 8.0.401, 1.8.0_401 → 8.0.401)
    - .NET preview/rc suffixes (9.0.0-preview.7)
    - Fortinet build numbers (7.4.4 build2662)
    - Palo Alto hotfix versions (11.1.3-h1)
    - Cisco parentheses format (9.18(4) → 9.18.4)
    - SonicWall 4-part versions (7.0.1.732)
  - Extended `EndOfLifeClient` PRODUCT_MAPPING with 50+ new products
    - Java variants (Azul Zulu, Eclipse Temurin, Microsoft OpenJDK)
    - Databases (SQL Server, Oracle Database, MariaDB, Neo4j)
    - Enterprise tools (Exchange, SharePoint, Vault, Keycloak)
    - DevOps (Jenkins, Artifactory, Nexus, SonarQube)
  - Added `excludePatterns` to 15 critical products:
    - WinRAR (exclude unrar, libunrar)
    - Adobe Acrobat Reader (exclude Pro, Foxit, Nitro)
    - TeamViewer (exclude Host, Meeting, Pilot)
    - Citrix Workspace (exclude NetScaler, XenApp)
    - Apache Tomcat (exclude TomEE, Jetty, WildFly)
    - FortiOS (exclude FortiClient, FortiManager)
    - PAN-OS (exclude GlobalProtect, Panorama, Cortex)
    - Cisco ASA (exclude FTD, AnyConnect, ISE)
    - Cisco FTD (exclude ASA, FMC, AMP)
    - SonicOS (exclude SMA, NetExtender)
    - SonicWall SMA (exclude SonicOS)
  - Added `versionPattern` to firewall products for format validation
  - Added `eolProductId` field to critical entries (Chrome, Edge, Firefox, Python, OpenSSL, Tomcat)

### Changed
- Version bumped to 1.3.1
- Improved error messages with consistent format and helpful hints
- Enhanced SETUP.md with dedicated API Keys section
- Updated VendorAdvisory.ts factory to route to new vendor fetchers
- **Code quality refactoring:**
  - Extracted `types.ts` - shared type definitions (226 lines)
  - Extracted `format.ts` - output formatters (347 lines)
  - Extracted `catalog.ts` - software catalog management (286 lines)
  - Added `parallelProcess()` utility for concurrent batch operations
  - Migrated verbose console statements to Logger
  - msv.ts reduced from 2809 to 2391 lines (-15%)

## [1.3.0] - 2026-01-21

### Added
- `MsrcClient.ts` - Microsoft Security Response Center API client (A2 rating)
- `Logger.ts` - Structured logging utility with levels and colors
- MSRC advisory fetcher for Edge, Office, and Microsoft products
- Integration tests for CISA KEV and EPSS clients

### Fixed
- Data contamination: Added "liferay" to Git exclude patterns
- Flaky cache timing test now uses fresh cache directory
- All 84 tests now pass (was 80 pass, 2 skip, 1 fail)

### Changed
- Consolidated permission settings from 254 to 130 entries

## [1.2.0] - 2026-01-19

### Added
- `RiskScoring.ts` - Aggregate risk score calculation (0-100)
- `ActionGuidance.ts` - Contextual remediation guidance
- `ChocolateyClient.ts` - Package version lookup
- `CurlAdvisoryFetcher.ts` - curl security advisory fetcher
- `MozillaAdvisoryFetcher.ts` - Firefox/Thunderbird advisory fetcher
- Risk score display with visual bar in output
- AUDIT-REPORT-2026-01-19.md documenting data quality audit

### Fixed
- Data contamination for Git (GitLab, Gitea, GitHub CVEs filtered)
- Data contamination for OpenSSL (pyOpenSSL CVEs filtered)
- Data contamination for Python (VSCode Extension CVEs filtered)
- Data contamination for Docker Desktop (Remote Desktop CVEs filtered)
- Version pattern regex filtering now properly validates versions

### Changed
- Software catalog expanded to 153 entries
- Improved CPE matching accuracy
- Enhanced exclude patterns for false positive reduction

## [1.1.0] - 2026-01-14

### Added
- `VendorAdvisory.ts` - Vendor-specific security advisory fetching
- Wireshark security advisory fetcher
- SolarWinds security advisory fetcher
- Apache Tomcat security advisory fetcher
- Multi-branch MSV support (e.g., Tomcat 9.x, 10.x, 11.x)
- Compliance checking with CSV input support
- `--filter` option for batch results (kev, urgent, stale, undetermined)

### Changed
- Improved Admiralty rating calculation with vendor advisory bonus
- Enhanced output formatting with action boxes

## [1.0.0] - 2026-01-13

### Added
- Initial release of MSV skill
- `msv.ts` - Main CLI tool
- `CisaKevClient.ts` - CISA KEV catalog client (A1 rating)
- `EpssClient.ts` - FIRST.org EPSS client (B3 rating)
- `NvdClient.ts` - NVD API client (A2 rating)
- `VulnCheckClient.ts` - VulnCheck API client (B2 rating)
- `AppThreatClient.ts` - Offline vulnerability database client
- `VersionCompare.ts` - Semantic version comparison utilities
- `AdmiraltyScoring.ts` - Admiralty code rating system
- `MsvCache.ts` - Result caching with freshness tracking
- `InputParser.ts` - Multi-format input parsing (CSV, TXT, direct)
- `ComplianceChecker.ts` - Version compliance validation
- `SoftwareDiscovery.ts` - CPE-based software discovery
- `SoftwareCatalog.json` - 120+ Windows software entries
- Comprehensive test suite with 80+ tests
- SKILL.md documentation
- SETUP.md installation guide

### Security
- No API keys stored in code
- All API keys loaded from environment variables
- Cache files excluded from git

---

## Version History Summary

| Version | Date | Highlights |
|---------|------|------------|
| 1.4.0 | 2026-02-02 | **CTI Report Generator** - Threat intelligence reports |
| 1.3.0 | 2026-01-21 | MSRC client, Logger, test fixes |
| 1.2.0 | 2026-01-19 | Risk scoring, vendor fetchers, data quality |
| 1.1.0 | 2026-01-14 | Vendor advisories, multi-branch support |
| 1.0.0 | 2026-01-13 | Initial release |

## Admiralty Rating Scale

MSV uses the NATO Admiralty Code for source reliability:

| Rating | Meaning |
|--------|---------|
| A1 | Completely Reliable, Confirmed |
| A2 | Completely Reliable, Probably True |
| B2 | Usually Reliable, Probably True |
| B3 | Usually Reliable, Possibly True |
| C3 | Fairly Reliable, Possibly True |
| F6 | Cannot Judge, Truth Cannot Be Judged |
