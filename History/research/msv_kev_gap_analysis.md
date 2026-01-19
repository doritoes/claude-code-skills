# MSV Catalog Gap Analysis - CISA KEV Cross-Reference

**Date:** 2026-01-19
**Analysis:** THE ALGORITHM (THOROUGH effort)

## Summary

| Metric | Value |
|--------|-------|
| MSV Catalog Products | 138 |
| CISA KEV Total Entries | 1,488 |
| KEV Unique Vendor:Product | 628 |
| KEV Products Covered by MSV | 24 |
| KEV Products Missing (Windows Business) | 55+ |

## Coverage Status

### Already Covered in MSV (24 products)
| CVEs | Vendor | Product |
|------|--------|---------|
| 160 | Microsoft | Windows |
| 34 | Microsoft | Internet Explorer |
| 33 | Adobe | Flash Player |
| 26 | Microsoft | Office |
| 15 | Adobe | ColdFusion |
| 11 | Adobe | Acrobat and Reader |
| 8 | Adobe | Reader and Acrobat |
| 7 | Oracle | Java SE |
| 6 | Mozilla | Firefox and Thunderbird |
| 5 | Apache | Tomcat |
| 5 | Mozilla | Firefox |
| 4 | RARLAB | WinRAR |
| 4 | Apache | HTTP Server |
| 4 | Oracle | Java Runtime Environment |
| 4 | Nagios | Nagios XI |
| 3 | SolarWinds | Serv-U |
| 3 | Microsoft | Silverlight |
| 2 | Grafana Labs | Grafana |
| 2 | SolarWinds | Web Help Desk |
| 2 | Adobe | Commerce and Magento |
| 2 | Microsoft | Edge |

---

## MISSING - Priority Additions for Windows Business Environments

### CRITICAL PRIORITY - Microsoft Components

| CVEs | Product | Notes |
|------|---------|-------|
| 16 | Exchange Server | Enterprise email. Multiple actively exploited CVEs. ProxyLogon, ProxyShell. |
| 7 | SharePoint / SharePoint Server | Enterprise collaboration. RCE vulnerabilities. |
| 4 | Word | Document-based malware delivery. Separate tracking from Office suite. |
| 3 | .NET Framework | Runtime framework. Deserialization RCE. |
| 3 | Excel | Spreadsheet macro attacks. Separate from Office suite. |
| 3 | Active Directory | Identity infrastructure. Privilege escalation. |
| 2 | PowerPoint | Presentation-based attacks. |
| 2 | Defender | Built-in AV bypass and privilege escalation. |
| 2 | MSHTML | HTML rendering engine. Trident attacks. |

**Recommendation:** Add Exchange Server immediately. Consider splitting Office components.

### CRITICAL PRIORITY - Enterprise Infrastructure

| CVEs | Vendor | Product | Notes |
|------|--------|---------|-------|
| 11 | Oracle | WebLogic Server | Java application server. RCE vulnerabilities. |
| 10 | SAP | NetWeaver | ERP platform. Business-critical data exposure. |
| 9 | VMware | vCenter Server | Virtualization management. Full infrastructure access. |
| 4 | Veeam | Backup & Replication | Backup infrastructure. Primary ransomware target. |
| 3 | VMware | ESXi | Hypervisor. Direct VM compromise. |
| 5 | Atlassian | Confluence Data Center/Server | Enterprise wiki. Documentation systems. |
| 2 | Atlassian | Jira Server and Data Center | Issue tracking. DevOps pipeline access. |
| 2 | ServiceNow | Now Platform | IT service management. Ticketing systems. |
| 2 | JetBrains | TeamCity | CI/CD server. Build pipeline supply chain. |

**Recommendation:** Add Veeam and Atlassian products - common in enterprise Windows environments.

### HIGH PRIORITY - Remote Access & VPN

| CVEs | Vendor | Product | Notes |
|------|--------|---------|-------|
| 7 | Ivanti | Pulse Connect Secure | VPN appliance. Heavily targeted by APTs. |
| 4 | Ivanti | Endpoint Manager (EPM) | Device management. Mass deployment vectors. |
| 4 | Ivanti | Connect Secure | VPN successor to Pulse. Same attack patterns. |
| 2 | ConnectWise | ScreenConnect | Remote support. Actively exploited in 2024. |
| 2 | Cisco | AnyConnect Secure Mobility Client | VPN client. Endpoint-side attacks. |

**Recommendation:** Add Ivanti products - critical VPN/remote access infrastructure.

### HIGH PRIORITY - File Transfer (MFT)

| CVEs | Vendor | Product | Notes |
|------|--------|---------|-------|
| 3 | CrushFTP | CrushFTP | MFT server. Actively exploited 2024. |
| 2 | Fortra | GoAnywhere MFT | MFT platform. Cl0p ransomware mass exploitation. |
| 2 | Cleo | Multiple Products | MFT solutions. 2024 supply chain campaigns. |

**Recommendation:** Add MFT products - primary ransomware exfiltration vectors.

### HIGH PRIORITY - Security Tools

| CVEs | Vendor | Product | Notes |
|------|--------|---------|-------|
| 6 | Zoho | ManageEngine | IT management suite. Multiple products affected. |
| 4 | Trend Micro | Apex One | Endpoint security. Privilege escalation to disable. |
| 3 | Veritas | Backup Exec Agent | Backup agent. ALPHV/BlackCat target. |
| 2 | Fortra | Cobalt Strike | Red team tool. Weaponized in real attacks. |

**Recommendation:** Add Zoho ManageEngine and Veritas Backup Exec.

### MEDIUM PRIORITY - Web Frameworks

| CVEs | Vendor | Product | Notes |
|------|--------|---------|-------|
| 7 | Apache | Struts | Java web framework. Equifax breach vector. |
| 2 | Apache | Log4j2 | Logging library. Log4Shell (CVE-2021-44228). |
| 2 | Apache | ActiveMQ | Message broker. Deserialization RCE. |
| 2 | Apache | Solr | Search platform. SSRF and RCE. |
| 2 | Telerik | UI for ASP.NET AJAX | .NET web controls. Deserialization. |
| 4 | Drupal | Core | CMS framework. |
| 3 | DotNetNuke | DNN | .NET CMS platform. |

**Recommendation:** Add Apache Struts and Log4j2 - foundational libraries.

### MEDIUM PRIORITY - Monitoring & BI

| CVEs | Vendor | Product | Notes |
|------|--------|---------|-------|
| 3 | Qlik | Sense | Business intelligence. Windows deployments common. |
| 2 | Paessler | PRTG Network Monitor | Network monitoring. Windows-based. |
| 2 | Progress | WhatsUp Gold | Network monitoring. |
| 2 | Zabbix | Frontend | Already have agent, add web frontend. |
| 2 | Elastic | Elasticsearch | Search and analytics. Often on Windows. |
| 2 | TIBCO | JasperReports | Reporting server. |
| 2 | Hitachi | Pentaho BA Server | Business analytics. |

---

## Top 15 Priority Additions

Based on CVE count and business impact for Windows environments:

| Rank | Vendor | Product | KEV CVEs | Rationale |
|------|--------|---------|----------|-----------|
| 1 | Microsoft | Exchange Server | 16 | Critical email infrastructure, APT target |
| 2 | Oracle | WebLogic Server | 11 | Enterprise Java apps, common in finance |
| 3 | SAP | NetWeaver | 10 | ERP backbone, business-critical |
| 4 | VMware | vCenter Server | 9 | Virtualization control plane |
| 5 | Apache | Struts | 7 | Web framework, Equifax-level risk |
| 6 | Microsoft | SharePoint | 7 | Collaboration, document access |
| 7 | Ivanti | Pulse/Connect Secure | 7 | VPN infrastructure |
| 8 | Zoho | ManageEngine | 6 | IT management suite |
| 9 | Atlassian | Confluence | 5 | Enterprise documentation |
| 10 | Microsoft | Word | 4 | Document attack vector |
| 11 | Veeam | Backup & Replication | 4 | Ransomware backup deletion |
| 12 | Trend Micro | Apex One | 4 | Security tool irony |
| 13 | Ivanti | Endpoint Manager | 4 | Device management |
| 14 | CrushFTP | CrushFTP | 3 | MFT active exploitation |
| 15 | VMware | ESXi | 3 | Hypervisor compromise |

---

## Recommended Catalog Entries (JSON format)

```json
[
  {
    "id": "exchange_server",
    "displayName": "Microsoft Exchange Server",
    "vendor": "microsoft",
    "product": "exchange_server",
    "cpe23": "cpe:2.3:a:microsoft:exchange_server:*:*:*:*:*:*:*:*",
    "category": "email",
    "priority": "critical",
    "aliases": ["exchange", "ms exchange", "exchange server"],
    "platforms": ["server"],
    "notes": "CRITICAL: 16 CVEs in CISA KEV. ProxyLogon, ProxyShell, ProxyNotShell. Enterprise email server."
  },
  {
    "id": "weblogic",
    "displayName": "Oracle WebLogic Server",
    "vendor": "oracle",
    "product": "weblogic_server",
    "cpe23": "cpe:2.3:a:oracle:weblogic_server:*:*:*:*:*:*:*:*",
    "category": "webserver",
    "priority": "critical",
    "aliases": ["weblogic", "oracle weblogic"],
    "platforms": ["windows", "server"],
    "notes": "CRITICAL: 11 CVEs in CISA KEV. Java application server. Deserialization RCE."
  },
  {
    "id": "sap_netweaver",
    "displayName": "SAP NetWeaver",
    "vendor": "sap",
    "product": "netweaver",
    "cpe23": "cpe:2.3:a:sap:netweaver:*:*:*:*:*:*:*:*",
    "category": "erp",
    "priority": "critical",
    "aliases": ["netweaver", "sap nw"],
    "platforms": ["windows", "server"],
    "notes": "CRITICAL: 10 CVEs in CISA KEV. ERP platform. Business-critical systems."
  },
  {
    "id": "vcenter",
    "displayName": "VMware vCenter Server",
    "vendor": "vmware",
    "product": "vcenter_server",
    "cpe23": "cpe:2.3:a:vmware:vcenter_server:*:*:*:*:*:*:*:*",
    "category": "virtualization",
    "priority": "critical",
    "aliases": ["vcenter", "vmware vcenter"],
    "platforms": ["windows", "server"],
    "notes": "CRITICAL: 9 CVEs in CISA KEV. Virtualization management. Full infrastructure access."
  },
  {
    "id": "veeam_backup",
    "displayName": "Veeam Backup & Replication",
    "vendor": "veeam",
    "product": "backup_and_replication",
    "cpe23": "cpe:2.3:a:veeam:backup_and_replication:*:*:*:*:*:*:*:*",
    "category": "backup",
    "priority": "critical",
    "aliases": ["veeam", "veeam backup", "vbr"],
    "platforms": ["windows", "server"],
    "notes": "CRITICAL: 4 CVEs in CISA KEV. Ransomware deletes backups first."
  },
  {
    "id": "confluence",
    "displayName": "Atlassian Confluence",
    "vendor": "atlassian",
    "product": "confluence",
    "cpe23": "cpe:2.3:a:atlassian:confluence:*:*:*:*:*:*:*:*",
    "category": "collaboration",
    "priority": "critical",
    "aliases": ["confluence", "atlassian confluence"],
    "platforms": ["windows", "server"],
    "notes": "CRITICAL: 5 CVEs in CISA KEV. Enterprise wiki. Data Center and Server editions."
  },
  {
    "id": "jira",
    "displayName": "Atlassian Jira",
    "vendor": "atlassian",
    "product": "jira",
    "cpe23": "cpe:2.3:a:atlassian:jira:*:*:*:*:*:*:*:*",
    "category": "project_management",
    "priority": "high",
    "aliases": ["jira", "atlassian jira", "jira server"],
    "platforms": ["windows", "server"],
    "notes": "2 CVEs in CISA KEV. Issue tracking. DevOps workflow access."
  },
  {
    "id": "ivanti_connect_secure",
    "displayName": "Ivanti Connect Secure",
    "vendor": "ivanti",
    "product": "connect_secure",
    "cpe23": "cpe:2.3:a:ivanti:connect_secure:*:*:*:*:*:*:*:*",
    "category": "vpn",
    "priority": "critical",
    "aliases": ["ivanti vpn", "pulse secure", "pulse connect secure"],
    "platforms": ["windows", "server"],
    "notes": "CRITICAL: 7+ CVEs in CISA KEV. VPN infrastructure. APT target."
  },
  {
    "id": "ivanti_epm",
    "displayName": "Ivanti Endpoint Manager",
    "vendor": "ivanti",
    "product": "endpoint_manager",
    "cpe23": "cpe:2.3:a:ivanti:endpoint_manager:*:*:*:*:*:*:*:*",
    "category": "management",
    "priority": "critical",
    "aliases": ["ivanti epm", "landesk", "ivanti endpoint"],
    "platforms": ["windows", "server"],
    "notes": "CRITICAL: 4 CVEs in CISA KEV. Device management. Mass deployment vector."
  },
  {
    "id": "connectwise_screenconnect",
    "displayName": "ConnectWise ScreenConnect",
    "vendor": "connectwise",
    "product": "screenconnect",
    "cpe23": "cpe:2.3:a:connectwise:screenconnect:*:*:*:*:*:*:*:*",
    "category": "remote_access",
    "priority": "critical",
    "aliases": ["screenconnect", "connectwise control"],
    "platforms": ["windows", "server"],
    "notes": "CRITICAL: 2 CVEs in CISA KEV. Remote support. Actively exploited 2024."
  },
  {
    "id": "crushftp",
    "displayName": "CrushFTP",
    "vendor": "crushftp",
    "product": "crushftp",
    "cpe23": "cpe:2.3:a:crushftp:crushftp:*:*:*:*:*:*:*:*",
    "category": "file_transfer",
    "priority": "critical",
    "aliases": ["crush ftp"],
    "platforms": ["windows", "server"],
    "notes": "CRITICAL: 3 CVEs in CISA KEV. MFT server. Actively exploited."
  },
  {
    "id": "goanywhere_mft",
    "displayName": "Fortra GoAnywhere MFT",
    "vendor": "fortra",
    "product": "goanywhere_mft",
    "cpe23": "cpe:2.3:a:fortra:goanywhere_mft:*:*:*:*:*:*:*:*",
    "category": "file_transfer",
    "priority": "critical",
    "aliases": ["goanywhere", "fortra goanywhere"],
    "platforms": ["windows", "server"],
    "notes": "CRITICAL: 2 CVEs in CISA KEV. MFT. Cl0p ransomware mass exploitation."
  },
  {
    "id": "manageengine",
    "displayName": "Zoho ManageEngine",
    "vendor": "zoho",
    "product": "manageengine",
    "cpe23": "cpe:2.3:a:zoho:manageengine:*:*:*:*:*:*:*:*",
    "category": "management",
    "priority": "critical",
    "aliases": ["manageengine", "zoho manageengine"],
    "platforms": ["windows", "server"],
    "notes": "CRITICAL: 6 CVEs in CISA KEV. IT management suite. Multiple products."
  },
  {
    "id": "apache_struts",
    "displayName": "Apache Struts",
    "vendor": "apache",
    "product": "struts",
    "cpe23": "cpe:2.3:a:apache:struts:*:*:*:*:*:*:*:*",
    "category": "framework",
    "priority": "critical",
    "aliases": ["struts", "apache struts"],
    "platforms": ["windows", "server"],
    "notes": "CRITICAL: 7 CVEs in CISA KEV. Java web framework. Equifax breach vector."
  },
  {
    "id": "log4j",
    "displayName": "Apache Log4j",
    "vendor": "apache",
    "product": "log4j",
    "cpe23": "cpe:2.3:a:apache:log4j:*:*:*:*:*:*:*:*",
    "category": "library",
    "priority": "critical",
    "aliases": ["log4j", "log4j2", "apache log4j"],
    "platforms": ["windows", "server"],
    "notes": "CRITICAL: Log4Shell (CVE-2021-44228). Embedded in many Java apps."
  }
]
```

---

## Analysis Notes

### False Negative Analysis
Some KEV products marked as "missing" are actually covered:
- **Google Chromium V8/Mojo/Skia/Blink** - Covered under "chrome" entry
- **Microsoft Win32k/DXGKRNL/GDI** - Windows kernel components, covered under "Windows"
- **Apple Multiple Products** - Out of scope (macOS/iOS only)

### Scope Exclusions (not Windows business software)
- Network appliances (Cisco IOS, Juniper, Fortinet, Palo Alto)
- IoT/embedded devices (cameras, routers)
- Mobile platforms (Android, iOS)
- Linux-only software

### Next Steps
1. Add top 15 entries to SoftwareCatalog.json
2. Create CPE mappings for each new entry
3. Test with `msv query` for each new product
4. Verify vendor advisory fetchers exist or create them
