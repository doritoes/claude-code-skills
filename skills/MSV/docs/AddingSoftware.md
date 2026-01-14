# Adding Software to MSV Skill

This guide explains how to add new software products to the Minimum Safe Version (MSV) skill.

## Overview

There are two levels of integration:

| Level | Confidence | Rating | Effort |
|-------|------------|--------|--------|
| **Basic** | Medium | B2-C4 | 5 min |
| **Full** | High | A1-A2 | 1-2 hours |

- **Basic**: Add to SoftwareCatalog.json - uses NVD/KEV for version data
- **Full**: Add vendor advisory fetcher - parses vendor security pages directly

---

## Level 1: Basic Integration (SoftwareCatalog.json)

### Step 1: Research the Software

Find the following information:

1. **Vendor name** (as used in CVE/NVD data)
2. **Product name** (as used in CVE/NVD data)
3. **CPE 2.3 string** (optional but helpful)

**How to find CPE/vendor/product names:**

```bash
# Search NVD for the software
# https://nvd.nist.gov/products/cpe/search

# Or check existing CVEs for the product
# https://nvd.nist.gov/vuln/search?query=wireshark
```

Example CPE: `cpe:2.3:a:wireshark:wireshark:*:*:*:*:*:*:*:*`
- Vendor: `wireshark`
- Product: `wireshark`

### Step 2: Add Entry to Catalog

Edit `.claude/skills/MSV/data/SoftwareCatalog.json`:

```json
{
  "id": "acme_widget",
  "displayName": "ACME Widget Pro",
  "vendor": "acme",
  "product": "widget_pro",
  "cpe23": "cpe:2.3:a:acme:widget_pro:*:*:*:*:*:*:*:*",
  "category": "utility",
  "priority": "medium",
  "aliases": ["widget", "acme widget", "widget pro"],
  "platforms": ["windows"],
  "notes": "Enterprise widget management tool"
}
```

### Field Reference

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Unique identifier (lowercase, underscores) |
| `displayName` | Yes | Human-readable name |
| `vendor` | Yes | Vendor name as used in NVD/CVE data |
| `product` | Yes | Product name as used in NVD/CVE data |
| `cpe23` | No | CPE 2.3 string for precise matching |
| `category` | No | Category for grouping (browser, compression, etc.) |
| `priority` | No | Patch priority: critical, high, medium, low |
| `aliases` | Yes | Alternative names users might search for |
| `platforms` | Yes | Target platforms: windows, server, linux, macos |
| `notes` | No | Additional context |

### Step 3: Test the Entry

```bash
cd .claude/skills/MSV/tools

# Verify it's in the catalog
bun run msv.ts list | grep -i "widget"

# Test a query
bun run msv.ts query "ACME Widget" --verbose
```

### Expected Results (Basic Integration)

- **Rating**: B2-C4 (depending on data availability)
- **Sources**: CISA KEV, NVD, EPSS
- **MSV**: Derived from NVD version configurations

---

## Level 2: Full Integration (Vendor Advisory Fetcher)

For higher confidence ratings (A1-A2), add a vendor advisory fetcher that parses security advisories directly from the vendor's website.

### Step 1: Research Vendor Security Page

Find where the vendor publishes security advisories:

| Vendor | Security Page |
|--------|---------------|
| Wireshark | https://www.wireshark.org/security/ |
| Chrome | https://chromereleases.googleblog.com |
| Firefox | https://www.mozilla.org/security/advisories/ |
| Microsoft | https://msrc.microsoft.com/update-guide |

### Step 2: Create Fetcher Class

Edit `.claude/skills/MSV/tools/VendorAdvisory.ts`:

```typescript
// =============================================================================
// ACME Widget Advisory Fetcher
// =============================================================================

export class AcmeWidgetAdvisoryFetcher extends VendorAdvisoryFetcher {
  private readonly securityUrl = "https://www.acme.com/security/";

  async fetch(): Promise<VendorAdvisoryResult> {
    // Check cache first
    const cached = this.getCache("acme_widget");
    if (cached) return cached;

    // Fetch the security page
    const response = await fetch(this.securityUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch ACME security page: ${response.status}`);
    }

    const html = await response.text();
    const advisories = this.parseAdvisories(html);
    const branches = this.calculateBranchMsv(advisories);

    const result: VendorAdvisoryResult = {
      vendor: "acme",
      product: "widget_pro",
      advisories,
      branches,
      fetchedAt: new Date().toISOString(),
      source: this.securityUrl,
    };

    this.setCache("acme_widget", result);
    return result;
  }

  private parseAdvisories(html: string): SecurityAdvisory[] {
    const advisories: SecurityAdvisory[] = [];

    // TODO: Implement parsing logic specific to vendor's page format
    // Look for:
    // - Advisory IDs (e.g., "ACME-SA-2025-001")
    // - CVE IDs (e.g., "CVE-2025-12345")
    // - Fixed versions (e.g., "Fixed in 2.5.1")
    // - Severity levels (Critical, High, Medium, Low)

    return advisories;
  }

  private calculateBranchMsv(advisories: SecurityAdvisory[]): BranchMsv[] {
    // Group fixed versions by branch and find highest per branch
    // See WiresharkAdvisoryFetcher for reference implementation
    return [];
  }
}
```

### Step 3: Register in Factory

Update the `getVendorFetcher()` function in `VendorAdvisory.ts`:

```typescript
export function getVendorFetcher(
  vendor: string,
  product: string,
  cacheDir: string
): VendorAdvisoryFetcher | null {
  const key = `${vendor}:${product}`.toLowerCase();

  switch (key) {
    case "wireshark:wireshark":
      return new WiresharkAdvisoryFetcher(cacheDir);
    case "google:chrome":
      return new ChromeAdvisoryFetcher(cacheDir);
    case "acme:widget_pro":                          // Add this
      return new AcmeWidgetAdvisoryFetcher(cacheDir);
    default:
      return null;
  }
}
```

### Step 4: Test Full Integration

```bash
# Clear cache and test
rm -f .claude/skills/MSV/data/vendor-acme_widget.json
rm -f .claude/skills/MSV/data/msv-cache.json

bun run msv.ts query "ACME Widget" --verbose
```

### Expected Results (Full Integration)

- **Rating**: A2 (Vendor advisory confirms MSV)
- **Sources**: Vendor Advisory, CISA KEV (if applicable)
- **Branches**: Per-branch MSV for multi-version software

---

## Parsing Tips

### Common Advisory Page Formats

**Table-based (like Wireshark):**
```typescript
// Look for table rows with advisory info
const rowRegex = /<tr>.*?<td>(ADVISORY-\d+)<\/td>.*?<td>([\d.]+)<\/td>/g;
```

**Blog-style (like Chrome):**
```typescript
// Look for release announcements with CVE lists
const releaseRegex = /Stable Channel Update.*?(\d+\.\d+\.\d+\.\d+)/g;
```

**JSON API (ideal):**
```typescript
// Some vendors provide JSON feeds
const response = await fetch("https://vendor.com/api/security.json");
const data = await response.json();
```

### Version Extraction

```typescript
private extractVersions(text: string): string[] {
  const versionRegex = /\b(\d+\.\d+\.\d+)\b/g;
  const matches = text.matchAll(versionRegex);
  const versions = new Set<string>();

  for (const match of matches) {
    const version = match[1];
    const major = parseInt(version.split(".")[0], 10);

    // Filter out non-product versions (protocol numbers, etc.)
    if (major <= 100) {  // Adjust based on product versioning
      versions.add(version);
    }
  }

  return Array.from(versions);
}
```

### CVE Extraction

```typescript
private extractCves(text: string): string[] {
  const cveRegex = /CVE-\d{4}-\d+/gi;
  const matches = text.matchAll(cveRegex);
  return [...new Set([...matches].map(m => m[0].toUpperCase()))];
}
```

---

## Categories

Use consistent category names:

| Category | Examples |
|----------|----------|
| `browser` | Chrome, Firefox, Edge |
| `compression` | 7-Zip, WinRAR, WinZip |
| `development` | VS Code, Git, Node.js |
| `media` | VLC, Audacity, GIMP |
| `network` | Wireshark, PuTTY, WinSCP |
| `office` | LibreOffice, Notepad++ |
| `pdf` | Adobe Reader, Foxit |
| `remote_access` | TeamViewer, AnyDesk |
| `runtime` | Java, .NET, Python |
| `security` | KeePass, Bitwarden |
| `utility` | CCleaner, HWiNFO |
| `virtualization` | VirtualBox, VMware |

---

## Checklist

### Basic Integration
- [ ] Research vendor/product names in NVD
- [ ] Find CPE 2.3 string (if available)
- [ ] Add entry to SoftwareCatalog.json
- [ ] Add useful aliases
- [ ] Test with `msv query`

### Full Integration (Optional)
- [ ] Find vendor security advisory page
- [ ] Analyze page structure for parsing
- [ ] Create fetcher class
- [ ] Implement parseAdvisories()
- [ ] Implement calculateBranchMsv()
- [ ] Register in getVendorFetcher()
- [ ] Test with `--verbose` flag
- [ ] Verify A2 rating achieved

---

## Troubleshooting

### "Unknown software" Error
- Check that the `id` or `aliases` match your query
- Verify entry is valid JSON (no trailing commas)

### No MSV Returned (null)
- The software may not have KEV entries
- NVD may not have version configuration data
- Consider adding vendor advisory fetcher

### Low Confidence Rating (D5/F6)
- No vulnerability data found in KEV/NVD
- Add vendor advisory fetcher for better coverage
- Some software genuinely has no CVEs (rare)

### Wrong Versions Extracted
- Check version regex isn't matching unrelated numbers
- Filter by major version range appropriate for product
- Verify vendor page format hasn't changed
