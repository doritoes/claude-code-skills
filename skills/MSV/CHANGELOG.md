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

### Fixed
- **Router fuzzy-match safety** - `msv router query` could silently return the wrong product's
  MSV/CVE data with a misleadingly high confidence label (found via a real-world test querying
  eBay-resale-popular router models: NETGEAR "CAX30" matched Huawei "AX3" at 84% "exact" confidence
  via a coincidental substring; "RS200" — a 2026 WiFi 7 flagship — matched "R7000" — a 2013 AC1900
  model — at 90% "alias" confidence via a shared "NETGEAR Nighthawk" prefix)
  - `calculateConfidence()`'s substring "contains" bonus now requires the shorter string to be at
    least 4 characters and 40%+ of the longer string's length, so short model numbers can't
    coincidentally match inside unrelated ones
  - The model-number "exact" match channel now requires true whole-string equality instead of
    substring containment
  - Added a model-number-token penalty so shared vendor/family wording (e.g. "NETGEAR Nighthawk")
    can no longer mask an unrelated model number in whole-string similarity scoring
  - Raised the confidence floor for non-equal (fuzzy) matches to 80%; below that, `findModel()`
    returns no match instead of guessing, and the new `rankCandidates()` supplies "did you mean"
    suggestions for the error message
  - `matchMethod` is now `"exact"`/`"alias"` only for true 1.0-confidence equality; every other
    match is `"fuzzy"` and surfaces a loud `matchWarning` banner (text and JSON output) instead of
    a quiet one-line confidence footnote
- Router catalog expansion (+7 models) closing real-world coverage gaps found by the same test:
  NETGEAR RAX40, NETGEAR Orbi RBK12, NETGEAR Nighthawk RS200, NETGEAR CAX30, Linksys EA7500,
  ASUS RT-BE82U, TP-Link Archer BE900
  - Flagged Linksys EA7500 CVE-2023-46012 (CVSS 9.8, unauthenticated RCE via UPnP) as
    `"NO SAFE VERSION EXISTS"` — no vendor patch exists as of this research
- **Router fuzzy-match safety, round 2** - a follow-up real-world test (Newegg router
  best-sellers) found the previous fix incomplete: 5 catalog entries represent an unspecified
  group of devices rather than one real product (e.g. `tplink_archer_devices`, seeded from a
  2015 CVE bulletin that named "Archer" devices generically with no model number). These have no
  model number for `penalizeForModelNumberMismatch()` to anchor against, so shared vendor/family
  wording alone (e.g. "TP-Link Archer") was enough to fuzzy-match them against any Archer model
  not yet in the catalog — e.g. querying "TP-Link Archer AX55" silently returned an 11-year-old
  irrelevant CVE instead of "no match"
  - Added `RouterModel.genericPlaceholder` and flagged the 5 affected entries
    (`asus_routers_generic`, `tplink_archer_devices`, `tplink_multiple_routers`,
    `dlink_multiple_routers`, `zyxel_firewalls`)
  - `rankModels()` now skips the display-name and vendor+model fuzzy-scoring channels entirely
    for flagged entries — they're reachable only via their own literal aliases (e.g.
    "zyxel firewall"), never via partial similarity to an unrelated specific-model query
- Router catalog expansion (+4 models/1 vendor) from the same Newegg test: TP-Link Archer AX55,
  Archer AX55 Pro, Archer BE230, and GL.iNet (new vendor) GL-SFT1200 "Opal"
  - Flagged Archer AX55 v4's CVE-2026-18167 (EasyMesh stack buffer overflow) and
    CVE-2026-18330 (hardcoded RSA-1024 key exposing admin password) — both fixed in
    firmware 1.2.1 Build 20260527
  - Flagged Archer BE230's authenticated command-injection and DoS CVEs from TP-Link's
    2026-01 advisory bulletin (CVE-2026-0630/0631/22220/22225/22228/22229)
- **Real eBay sold-listing data analysis** - parsed 1,920 actual eBay sold router listings
  (manually copied by the user into a .docx after eBay blocked automated/API access), filtered
  to a genuine 3-day window, and cross-checked the top sellers against the catalog
  - Notable finding: Apple AirPort Extreme/Express (discontinued since 2018, no firmware
    updates since 2019) was the single most-resold "router" in the sample — ~11% of all sold
    listings, more than double the next closest vendor. The used-router market skews heavily
    toward abandoned hardware that current retail best-seller lists never surface.
  - Fixed a missing alias: "Linksys MR7500" didn't resolve to the already-cataloged
    `linksys_hydra_pro_6e` (model field "Hydra Pro 6E (MR7500)") because no alias combined the
    vendor prefix with the bare model number — added `"linksys mr7500"`
  - Added a new ISP vendor, **Charter Spectrum** (3 models: SAX1V1K WiFi 6, SBE1V1K WiFi 7,
    RAC2V1K Wave 2 — all OEM'd by Askey), which had zero catalog presence despite being a
    top-5 US ISP
  - Added Verizon Fios CR1000A/CR1000B (WiFi 6E), ASUS RT-AX3000 V2 (flagged as possibly
    stale — no firmware update found since 2023-09-27), ASUS RT-AX88U Pro (AX6000), and
    Ubiquiti's AmpliFi Alien mesh router (new `amplifi` family, distinct from the enterprise
    UniFi line — flags CVE-2023-4807)
- **Amazon best-seller cross-check** - checked the top 16 Amazon wireless-router best-sellers
  against the catalog; 8 were already covered by the prior three rounds (good validation of
  the earlier real-world testing), 8 were gaps
  - Two more missing-alias bugs of the same shape as MR7500: "Amazon eero 6" didn't resolve to
    the already-cataloged `eero_6` (missing "amazon eero 6" alias), and "TP-Link Deco 7 Pro"
    didn't resolve to the newly-added `tplink_deco_be63` (missing "tp-link deco 7 pro" alias —
    "Deco 7 Pro" is the Amazon 3-pack bundle name for the Deco BE63)
  - Added TP-Link Deco BE63 (WiFi 7 tri-band mesh, sold as "Deco 7 Pro"), Deco S4 (AC1900
    mesh), Archer BE400/BE6500 (flags CVE-2025-14631, an unauthenticated DoS via a single
    malformed 802.11 frame), Archer A6 (flags CVE-2026-9030/9031), Archer A54 (flags two
    unauthenticated stack-overflow RCE CVEs, 2022-25072 and 2023-44448)
  - Added GL.iNet GL-MT3000 "Beryl AX" (WiFi 6 travel router, current OpenWrt-based firmware
    unlike the older Opal/GL-SFT1200 which is stuck on a legacy 18.06 base)
  - Added NETGEAR R6700AX (WiFi 6 AX1800; flags CVE-2021-45602 with a confirmed fixed version,
    plus two newer 2026 CVEs referenced in NETGEAR's advisories without a confirmed fix version
    yet)
  - Several new entries have `msv: "unknown"` where research found real CVEs but no
    confirmed fixed-firmware version — documented honestly in each `eolNote` with a pointer to
    verify via `msv router update` rather than guessing a version number
- **Walmart best-seller cross-check (largest round yet: 20 models + 1 alias fix)** - checked
  21 Walmart wireless-router candidates against the catalog. All 21 were gaps, and several were
  a strong validation of the fuzzy-match safety fix from earlier rounds: "NETGEAR RS70"
  fuzzy-matched RS700S at 93%, "NETGEAR RS300" matched RS200 at 92%, "Google Nest WiFi Router"
  matched Nest WiFi Pro at 86%, and "TP-Link Archer BE3200" matched BE3600 at 94% — all
  different real products with different CVE profiles, all correctly shown with the loud
  approximate-match warning instead of silently returned as confident data
  - One more missing-alias case: "Starlink Standard Kit AX" didn't resolve to the
    already-cataloged `starlink_router_gen3` (displayName "Starlink Standard Kit Router Gen 3")
    — added "starlink standard kit ax" alias
  - Added 8 TP-Link Archer models (C54, AX1500, AX4400, AX1300, BE3200, BE6100, AX3000 Pro,
    AX73), 5 TP-Link Deco mesh models (W4500, W7200, WB10800/"Deco 7", W8100, WM9000 outdoor),
    3 NETGEAR Nighthawk models (RS70, RAX5, RS300), 2 NETGEAR Orbi mesh models (RBE262/263
    "260 series", RBE363 "360 series"/BE5000), 1 new Google Nest model (2019 Nest WiFi Router,
    distinct from both the original 2016 Google WiFi and the newer Nest WiFi Pro), and a new
    ASUS sub-brand family "tuf" for the TUF Gaming BE9400
  - Confirmed CVEs with fixed versions: Archer AX1500 (CVE-2025-9961, CWMP RCE, fixed 1.3.11),
    Archer AX1300 (CVE-2026-9151, VPN command injection, fixed 1.4.1), Archer AX73
    (CVE-2026-22226, VPN command injection CVSS 8.5, fixed 1.3.1 Build 20260430), NETGEAR RAX5
    (CVE-2026-9210/9211, fixed 1.0.2.26), NETGEAR RS300 (CVE-2026-11814, same advisory as
    R6700AX), NETGEAR Orbi 260/360 series (CVE-2026-0405 auth bypass + CVE-2026-62655 DoS,
    shared RBE260/360/370 firmware train, fixed 12.1.3.12)
  - Several entries again use msv: "unknown" with an honest eolNote where research found a
    real CVE advisory but couldn't confirm the affected/fixed model list included this exact
    SKU (e.g. CVE-2024-21833 was found for "Archer and Deco series" broadly, not confirmed
    against Deco W7200 specifically)
- **Lowe's cross-check found a new bug class: normalization collision** - checked 7 real
  router models against the catalog (Lowe's "wireless router" search results, after excluding
  non-router items the search mislabeled — a thermostat gateway, a USB WiFi adapter, a Faraday
  cage router cover, and several obscure mobile-hotspot dongles)
  - **Bug:** `normalize()` stripped `+` along with other punctuation, so "eero 6+" and "eero 6"
    both collapsed to the identical string `"eero6"`. This made a query for one return the
    other as a false **exact** match (1.0 confidence) — worse than the earlier fuzzy-match bugs,
    because exact/alias matches bypass the confidence floor entirely and print no warning at
    all. eero 6+ (model R010001, AX3000, 160MHz) and eero 6 (model N010001, AX1800, 80MHz-only)
    are genuinely different products. Fixed by spelling `+` out as `"plus"` before stripping
    punctuation, so "eero 6+" and "eero 6 plus" now normalize identically to each other and
    distinctly from "eero 6" — and a query for the (until now uncataloged) eero 6+ correctly
    fell through to the fuzzy-match warning path instead of a silent wrong match. Checked the
    catalog for other `+`-containing names (Belkin's "N+"/"AC+" marketing suffixes) — none at
    risk of the same collision.
  - Added the real eero 6+, plus 3 more eero models not yet cataloged: eero Outdoor 7
    (WiFi 7, IP66 weatherproof, PoE+), eero PoE 6 (WiFi 6 ceiling/wall access point — new
    `access-point` category use for this vendor), eero Pro 7 (tri-band WiFi 7 flagship)
  - Added 2 Starlink models: Mini (integrates the router into the dish itself, distinct
    hardware from the separately-cataloged Gen 2/Gen 3) and Standard 4X/"Router 3" (tri-band;
    documented the current naming ambiguity around Starlink's Standard/Standard 4/Standard 4X
    lineup honestly rather than assuming equivalence to the existing Gen 3 entry)
  - Added GL.iNet GL-BE3600 ("Slate 7", WiFi 7 travel router, current OpenWrt 23.05 base) and
    noted in its own entry that marketplaces sometimes resell it under unrelated storefront
    brand names (observed: "CYIKE" on Lowe's) — a reminder to verify the actual manufacturer
    from the product description, not the storefront-displayed brand
  - One candidate ("Adrinfly BE7200") was excluded rather than cataloged: no verifiable
    manufacturer found in research, and MSV can't provide meaningful security guidance for a
    router with no traceable vendor security page or firmware lineage
- **Best Buy cross-check found a third bug class: parenthetical model-number collision** -
  checked Best Buy's wireless-router best-sellers (after excluding a DOCSIS modem with no WiFi
  radio at all — ARRIS SURFboard SB8200 — that the search mislabeled as a "wireless router")
  - **Bug:** `extractModelNumberToken()` (added in the fuzzy-match safety fix) scanned a
    catalog entry's `model` field from the end for the last digit-containing token. For entries
    formatted like `"Orbi 370 (RBE973)"` — a friendly number plus a parenthetical FCC-style
    code — it grabbed `"(RBE973)"` instead of the actual discriminator `"370"`, so a plain
    `"NETGEAR Orbi 370"` query scored only 36% against its own already-cataloged entry and was
    rejected as no-match. Fixed by stripping parenthetical content before tokenizing (36% → 91%
    → 100% after also adding a "netgear orbi 370" alias). All 421 tests still pass.
  - Also fixed a missing-alias case on `tplink_deco_wb10800`: "TP-Link Deco 7 BE3600" (Best
    Buy's exact listing title) didn't resolve because no alias combined both the "Deco 7"
    nickname and "BE3600" model number in one phrase.
  - Enriched an *existing* catalog entry (`tplink_archer_axe75`, seeded before this session with
    `msv: "unknown"` and no CVEs tracked) with two CVEs found while researching a different
    model: CVE-2025-15568 (authenticated RCE via the web module) and CVE-2026-0630 (OS command
    injection, shared advisory with Archer BE230)
  - Added 8 new models: ARRIS SURFboard G34 (DOCSIS 3.1 + WiFi 6 combo), TP-Link Archer BE3500,
    NETGEAR RS100 (same CVE-2026-11814 advisory as RS300/R6700AX), TP-Link Deco XE75 Pro
    (distinct from the already-cataloged plain Deco XE75), TP-Link Archer AXE7800 (distinct
    from the smaller, already-cataloged Archer AXE75), ASUS RT-BE3600, TP-Link Archer BE5000,
    and eero 7 (dual-band, distinct from the tri-band eero Pro 7)

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
