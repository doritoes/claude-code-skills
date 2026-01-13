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

## 5. IoT Devices (Future)

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
- Router firmware tracking would provide unique value for WFH security programs
- Electron app tracking could leverage existing Chromium KEV data

---

*Last Updated: 2026-01-13*
