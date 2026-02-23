/**
 * CitrixAdvisoryFetcher.ts - Citrix Security Advisory Fetcher
 *
 * Fetches security advisories from Citrix support portal via HTML scraping.
 * Source: https://support.citrix.com/s/topic/0TO4z0000001GYdGAM/security-bulletin
 *
 * No API key required. Parses CVE data from security bulletin pages.
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

// =============================================================================
// Constants
// =============================================================================

const CITRIX_SECURITY_BASE = "https://support.citrix.com";
const CITRIX_SECURITY_LIST = "https://support.citrix.com/s/topic/0TO4z0000001GYdGAM/security-bulletin";
const REQUEST_TIMEOUT_MS = 30000;

// =============================================================================
// Types
// =============================================================================

export interface CitrixVulnerability {
  bulletinId: string;         // e.g., "CTX693420"
  title: string;
  severity: "critical" | "high" | "medium" | "low";
  cveIds: string[];
  affectedProducts: string[];
  fixedVersions: string[];
  publishedDate: string;
  url: string;
  cvssScore?: number;
}

export interface CitrixAdvisoryResult {
  vulnerabilities: CitrixVulnerability[];
  msvByProduct: Record<string, string>;
  lastUpdated: string;
  source: string;
}

interface CacheEntry {
  data: CitrixAdvisoryResult;
  expiresAt: string;
}

// =============================================================================
// Citrix Product Mappings
// =============================================================================

const CITRIX_PRODUCTS: Record<string, string[]> = {
  "netscaler": ["NetScaler", "Citrix ADC", "NetScaler ADC"],
  "netscaler_gateway": ["NetScaler Gateway", "Citrix Gateway"],
  "xenserver": ["XenServer", "Citrix Hypervisor"],
  "xenapp": ["XenApp"],
  "xendesktop": ["XenDesktop", "Virtual Apps and Desktops"],
  "citrix_workspace": ["Workspace App", "Citrix Receiver"],
  "sharefile": ["ShareFile"],
  "storefront": ["StoreFront"],
  "provisioning": ["Provisioning Services", "PVS"],
  "sd_wan": ["SD-WAN", "Citrix SD-WAN"],
};

// =============================================================================
// Citrix Advisory Fetcher
// =============================================================================

export class CitrixAdvisoryFetcher {
  private cacheDir: string;
  private cacheDurationMs = 4 * 60 * 60 * 1000; // 4 hours
  private product: string;

  constructor(cacheDir: string, product: string = "all") {
    this.cacheDir = cacheDir;
    this.product = product.toLowerCase();
    if (!existsSync(cacheDir)) {
      mkdirSync(cacheDir, { recursive: true });
    }
  }

  /**
   * Fetch Citrix security bulletins
   */
  async fetch(): Promise<CitrixAdvisoryResult> {
    const cacheKey = `citrix-${this.product}`;
    const cachePath = resolve(this.cacheDir, `${cacheKey}.json`);

    // Check cache
    if (existsSync(cachePath)) {
      try {
        const entry: CacheEntry = JSON.parse(readFileSync(cachePath, "utf-8"));
        if (new Date(entry.expiresAt) > new Date()) {
          return entry.data;
        }
      } catch {
        // Corrupted cache
      }
    }

    // Fetch the security bulletin listing page
    const response = await fetch(CITRIX_SECURITY_LIST, {
      headers: {
        "Accept": "text/html",
        "User-Agent": "MSV-Skill/1.0 (PAI Infrastructure)",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`Citrix advisory fetch error: ${response.status} ${response.statusText}`);
    }

    const html = await response.text();
    const vulnerabilities = this.parseSecurityBulletins(html);

    // Filter by product if specified
    const filteredVulns = this.product === "all"
      ? vulnerabilities
      : this.filterByProduct(vulnerabilities);

    // Calculate MSV per product
    const msvByProduct = this.calculateMsv(filteredVulns);

    const result: CitrixAdvisoryResult = {
      vulnerabilities: filteredVulns,
      msvByProduct,
      lastUpdated: new Date().toISOString(),
      source: CITRIX_SECURITY_LIST,
    };

    // Cache result
    const entry: CacheEntry = {
      data: result,
      expiresAt: new Date(Date.now() + this.cacheDurationMs).toISOString(),
    };
    writeFileSync(cachePath, JSON.stringify(entry, null, 2));

    return result;
  }

  /**
   * Parse security bulletins from HTML
   */
  private parseSecurityBulletins(html: string): CitrixVulnerability[] {
    const vulns: CitrixVulnerability[] = [];

    // Extract CTX bulletin IDs and their context
    const ctxPattern = /CTX\d{6}/g;
    const ctxMatches = [...new Set(html.match(ctxPattern) || [])];

    for (const bulletinId of ctxMatches) {
      // Find context around this bulletin ID
      const idx = html.indexOf(bulletinId);
      if (idx === -1) continue;

      const contextStart = Math.max(0, idx - 500);
      const contextEnd = Math.min(html.length, idx + 1500);
      const context = html.slice(contextStart, contextEnd);

      // Extract CVEs
      const cvePattern = /CVE-\d{4}-\d+/gi;
      const cveMatches = context.match(cvePattern) || [];
      const cveIds = [...new Set(cveMatches.map(c => c.toUpperCase()))];

      // Extract title (look for text near the bulletin ID)
      const title = this.extractTitle(context, bulletinId);

      // Extract severity
      const severity = this.extractSeverity(context);

      // Extract affected products
      const affectedProducts = this.extractProducts(context);

      // Extract fixed versions
      const fixedVersions = this.extractVersions(context);

      // Extract date
      const publishedDate = this.extractDate(context);

      // Extract CVSS score
      const cvssScore = this.extractCvssScore(context);

      vulns.push({
        bulletinId,
        title,
        severity,
        cveIds,
        affectedProducts,
        fixedVersions,
        publishedDate,
        url: `${CITRIX_SECURITY_BASE}/external/article/${bulletinId}`,
        cvssScore,
      });
    }

    // Sort by published date descending
    vulns.sort((a, b) => {
      const dateA = new Date(a.publishedDate).getTime() || 0;
      const dateB = new Date(b.publishedDate).getTime() || 0;
      return dateB - dateA;
    });

    return vulns;
  }

  /**
   * Extract title from context
   */
  private extractTitle(context: string, bulletinId: string): string {
    // Look for common title patterns
    const titlePatterns = [
      /Security (?:Bulletin|Advisory)[^<]*?for[^<]*?([^<]+)/i,
      /NetScaler[^<]*?Security[^<]*?Bulletin[^<]*?for[^<]*?CVE/i,
      />([^<]*?Security[^<]*?(?:Bulletin|Update|Advisory)[^<]*)</i,
    ];

    for (const pattern of titlePatterns) {
      const match = context.match(pattern);
      if (match) {
        return match[1]?.trim() || `Citrix Security Bulletin ${bulletinId}`;
      }
    }

    return `Citrix Security Bulletin ${bulletinId}`;
  }

  /**
   * Extract severity from context
   */
  private extractSeverity(context: string): CitrixVulnerability["severity"] {
    const lower = context.toLowerCase();

    // Check for CVSS score first
    const cvssMatch = context.match(/cvss[^0-9]*(\d+\.?\d*)/i);
    if (cvssMatch) {
      const score = parseFloat(cvssMatch[1]);
      if (score >= 9.0) return "critical";
      if (score >= 7.0) return "high";
      if (score >= 4.0) return "medium";
      return "low";
    }

    // Fall back to text-based severity
    if (lower.includes("critical")) return "critical";
    if (lower.includes("high")) return "high";
    if (lower.includes("medium") || lower.includes("moderate")) return "medium";
    if (lower.includes("low")) return "low";

    return "medium";
  }

  /**
   * Extract affected products from context
   */
  private extractProducts(context: string): string[] {
    const products: string[] = [];

    // Check for known Citrix product names
    const productPatterns = [
      /NetScaler\s*(?:ADC|Gateway)?/gi,
      /Citrix\s*(?:ADC|Gateway|Hypervisor|Workspace|Virtual\s*Apps)/gi,
      /XenServer/gi,
      /XenApp/gi,
      /XenDesktop/gi,
      /StoreFront/gi,
      /ShareFile/gi,
      /SD-WAN/gi,
      /Provisioning\s*Services?/gi,
    ];

    for (const pattern of productPatterns) {
      const matches = context.match(pattern);
      if (matches) {
        for (const match of matches) {
          const normalized = match.trim();
          if (!products.includes(normalized)) {
            products.push(normalized);
          }
        }
      }
    }

    return products;
  }

  /**
   * Extract version numbers from context
   */
  private extractVersions(context: string): string[] {
    const versions: string[] = [];

    // Common Citrix version patterns
    const versionPatterns = [
      /\b(\d+\.\d+(?:\.\d+)?(?:\.\d+)?)\b/g,
      /version\s*(\d+\.\d+(?:\.\d+)?)/gi,
      /build\s*(\d+\.\d+(?:\.\d+)?)/gi,
    ];

    for (const pattern of versionPatterns) {
      const matches = context.matchAll(pattern);
      for (const match of matches) {
        const version = match[1];
        // Filter out common false positives
        if (this.isValidVersion(version) && !versions.includes(version)) {
          versions.push(version);
        }
      }
    }

    // Sort versions
    versions.sort((a, b) => this.compareVersions(a, b));

    return versions;
  }

  /**
   * Check if a version string is valid
   */
  private isValidVersion(version: string): boolean {
    // Filter out years, CVE numbers, etc.
    const parts = version.split(".");
    if (parts.length < 2) return false;

    const major = parseInt(parts[0], 10);
    // Citrix versions are typically 10-15.x or 1000+ build numbers
    if (major >= 2020 && major <= 2030) return false; // Likely a year
    if (major > 1000 && parts.length === 1) return false; // Likely a standalone number

    return true;
  }

  /**
   * Extract date from context
   */
  private extractDate(context: string): string {
    const datePatterns = [
      /(\d{4}-\d{2}-\d{2})/,
      /(\d{1,2}\/\d{1,2}\/\d{4})/,
      /((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4})/i,
      /(\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4})/i,
    ];

    for (const pattern of datePatterns) {
      const match = context.match(pattern);
      if (match) {
        try {
          const date = new Date(match[1]);
          if (!isNaN(date.getTime())) {
            return date.toISOString().split("T")[0];
          }
        } catch {
          // Continue to next pattern
        }
      }
    }

    return new Date().toISOString().split("T")[0];
  }

  /**
   * Extract CVSS score from context
   */
  private extractCvssScore(context: string): number | undefined {
    const cvssMatch = context.match(/cvss[^0-9]*(\d+\.?\d*)/i);
    if (cvssMatch) {
      return parseFloat(cvssMatch[1]);
    }
    return undefined;
  }

  /**
   * Filter vulnerabilities by product
   */
  private filterByProduct(vulns: CitrixVulnerability[]): CitrixVulnerability[] {
    const productNames = CITRIX_PRODUCTS[this.product] || [this.product];

    return vulns.filter(vuln => {
      return vuln.affectedProducts.some(prod => {
        const prodLower = prod.toLowerCase();
        return productNames.some(name => prodLower.includes(name.toLowerCase()));
      });
    });
  }

  /**
   * Calculate minimum safe version per product
   */
  private calculateMsv(vulns: CitrixVulnerability[]): Record<string, string> {
    const productVersions = new Map<string, string[]>();

    for (const vuln of vulns) {
      for (const product of vuln.affectedProducts) {
        const productKey = this.normalizeProductName(product);
        for (const version of vuln.fixedVersions) {
          if (!productVersions.has(productKey)) {
            productVersions.set(productKey, []);
          }
          productVersions.get(productKey)!.push(version);
        }
      }
    }

    const msv: Record<string, string> = {};
    for (const [product, versions] of productVersions) {
      versions.sort((a, b) => this.compareVersions(a, b));
      if (versions.length > 0) {
        msv[product] = versions[versions.length - 1];
      }
    }

    // Fallback: If no versions found from scraping, use known latest versions
    // These are updated manually based on Citrix release cycles
    if (Object.keys(msv).length === 0) {
      const knownLatest: Record<string, Record<string, string>> = {
        netscaler: {
          "netscaler_adc_14": "14.1-29.72",
          "netscaler_adc_13": "13.1-55.36",
        },
        adc: {
          "netscaler_adc_14": "14.1-29.72",
          "netscaler_adc_13": "13.1-55.36",
        },
        netscaler_gateway: {
          "gateway_14": "14.1-29.72",
          "gateway_13": "13.1-55.36",
        },
        xenserver: {
          "xenserver_8": "8.2.3",
        },
        citrix_workspace: {
          "workspace_app_2409": "24.9.0",
        },
        all: {
          "netscaler_adc_14": "14.1-29.72",
          "netscaler_adc_13": "13.1-55.36",
          "gateway_14": "14.1-29.72",
          "xenserver_8": "8.2.3",
        },
      };

      const productVersionMap = knownLatest[this.product] || knownLatest.all || {};
      for (const [key, version] of Object.entries(productVersionMap)) {
        msv[key] = version;
      }
    }

    return msv;
  }

  /**
   * Normalize product name
   */
  private normalizeProductName(name: string): string {
    return name
      .toLowerCase()
      .replace(/citrix\s*/i, "")
      .replace(/[^a-z0-9]/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_|_$/g, "");
  }

  /**
   * Compare version strings
   */
  private compareVersions(a: string, b: string): number {
    if (!a || !b) return 0;

    const partsA = a.split(".").map(p => parseInt(p, 10) || 0);
    const partsB = b.split(".").map(p => parseInt(p, 10) || 0);
    const maxLen = Math.max(partsA.length, partsB.length);

    for (let i = 0; i < maxLen; i++) {
      const partA = partsA[i] || 0;
      const partB = partsB[i] || 0;
      if (partA !== partB) return partA - partB;
    }
    return 0;
  }
}

// =============================================================================
// CLI Testing
// =============================================================================

if (import.meta.main) {
  const dataDir = resolve(import.meta.dir, "..", "data");
  const product = process.argv[2] || "all";
  const fetcher = new CitrixAdvisoryFetcher(dataDir, product);

  console.log(`Fetching Citrix security bulletins for: ${product}...`);

  try {
    const result = await fetcher.fetch();
    console.log(`\nFound ${result.vulnerabilities.length} security bulletins`);
    console.log(`Source: ${result.source}`);

    if (Object.keys(result.msvByProduct).length > 0) {
      console.log("\nMinimum Safe Versions:");
      for (const [prod, version] of Object.entries(result.msvByProduct)) {
        console.log(`  ${prod}: ${version}`);
      }
    }

    if (result.vulnerabilities.length > 0) {
      console.log("\nRecent bulletins:");
      for (const vuln of result.vulnerabilities.slice(0, 5)) {
        console.log(`  ${vuln.bulletinId}: ${vuln.title.slice(0, 60)}...`);
        console.log(`    Severity: ${vuln.severity}, CVEs: ${vuln.cveIds.join(", ") || "N/A"}`);
      }
    }
  } catch (error) {
    console.error("Error:", error);
  }
}
