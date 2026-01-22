/**
 * AdobeAdvisoryFetcher.ts - Adobe Security Advisory Fetcher
 *
 * Fetches security advisories from Adobe's PSIRT security bulletins.
 * Source: https://helpx.adobe.com/security/security-bulletin.html
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

const ADOBE_SECURITY_BASE = "https://helpx.adobe.com/security";
const ADOBE_SECURITY_BULLETINS = "https://helpx.adobe.com/security/security-bulletin.html";
const ADOBE_ACROBAT_BULLETINS = "https://helpx.adobe.com/security/products/acrobat.html";
const REQUEST_TIMEOUT_MS = 30000;

// =============================================================================
// Types
// =============================================================================

export interface AdobeVulnerability {
  bulletinId: string;         // e.g., "APSB25-01"
  title: string;
  severity: "critical" | "important" | "moderate" | "low";
  cveIds: string[];
  affectedProducts: string[];
  affectedVersions: string[];
  fixedVersions: string[];
  publishedDate: string;
  url: string;
}

export interface AdobeAdvisoryResult {
  vulnerabilities: AdobeVulnerability[];
  msvByProduct: Record<string, string>;
  lastUpdated: string;
  source: string;
}

interface CacheEntry {
  data: AdobeAdvisoryResult;
  expiresAt: string;
}

// =============================================================================
// Adobe Product Mappings
// =============================================================================

const ADOBE_PRODUCTS: Record<string, string[]> = {
  "acrobat_reader": ["Acrobat Reader", "Reader DC", "Acrobat Reader DC", "Adobe Reader"],
  "acrobat": ["Acrobat", "Acrobat DC", "Acrobat Pro", "Adobe Acrobat"],
  "photoshop": ["Photoshop"],
  "illustrator": ["Illustrator"],
  "indesign": ["InDesign"],
  "premiere_pro": ["Premiere Pro"],
  "after_effects": ["After Effects"],
  "animate": ["Animate"],
  "bridge": ["Bridge"],
  "lightroom": ["Lightroom"],
  "creative_cloud": ["Creative Cloud"],
  "commerce": ["Commerce", "Magento"],
  "experience_manager": ["Experience Manager", "AEM"],
  "coldfusion": ["ColdFusion"],
  "flash_player": ["Flash Player"],
  "shockwave": ["Shockwave"],
};

// =============================================================================
// Adobe Advisory Fetcher
// =============================================================================

export class AdobeAdvisoryFetcher {
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
   * Fetch Adobe security bulletins
   */
  async fetch(): Promise<AdobeAdvisoryResult> {
    const cacheKey = `adobe-${this.product}`;
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

    // Determine which page to fetch based on product
    const sourceUrl = this.product.includes("acrobat") || this.product.includes("reader")
      ? ADOBE_ACROBAT_BULLETINS
      : ADOBE_SECURITY_BULLETINS;

    // Fetch the security bulletin page
    const response = await fetch(sourceUrl, {
      headers: {
        "Accept": "text/html",
        "User-Agent": "MSV-Skill/1.0 (PAI Infrastructure)",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`Adobe advisory fetch error: ${response.status} ${response.statusText}`);
    }

    const html = await response.text();
    const vulnerabilities = this.parseSecurityBulletins(html, sourceUrl);

    // Filter by product if specified
    const filteredVulns = this.product === "all"
      ? vulnerabilities
      : this.filterByProduct(vulnerabilities);

    // Calculate MSV per product
    const msvByProduct = this.calculateMsv(filteredVulns);

    const result: AdobeAdvisoryResult = {
      vulnerabilities: filteredVulns,
      msvByProduct,
      lastUpdated: new Date().toISOString(),
      source: sourceUrl,
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
  private parseSecurityBulletins(html: string, sourceUrl: string): AdobeVulnerability[] {
    const vulns: AdobeVulnerability[] = [];

    // Extract APSB bulletin IDs
    const apsbPattern = /APSB\d{2}-\d+/g;
    const apsbMatches = [...new Set(html.match(apsbPattern) || [])];

    for (const bulletinId of apsbMatches) {
      // Find context around this bulletin ID
      const idx = html.indexOf(bulletinId);
      if (idx === -1) continue;

      const contextStart = Math.max(0, idx - 300);
      const contextEnd = Math.min(html.length, idx + 1500);
      const context = html.slice(contextStart, contextEnd);

      // Extract CVEs
      const cvePattern = /CVE-\d{4}-\d+/gi;
      const cveMatches = context.match(cvePattern) || [];
      const cveIds = [...new Set(cveMatches.map(c => c.toUpperCase()))];

      // Extract title
      const title = this.extractTitle(context, bulletinId);

      // Extract severity
      const severity = this.extractSeverity(context);

      // Extract affected products
      const affectedProducts = this.extractProducts(context);

      // Extract versions
      const { affected, fixed } = this.extractVersions(context);

      // Extract date
      const publishedDate = this.extractDate(context);

      vulns.push({
        bulletinId,
        title,
        severity,
        cveIds,
        affectedProducts,
        affectedVersions: affected,
        fixedVersions: fixed,
        publishedDate,
        url: `${ADOBE_SECURITY_BASE}/products/${this.getProductPath(affectedProducts)}/${bulletinId.toLowerCase()}.html`,
      });
    }

    // Sort by bulletin ID descending (higher numbers = more recent)
    vulns.sort((a, b) => {
      const yearA = parseInt(a.bulletinId.match(/APSB(\d{2})/)?.[1] || "0", 10);
      const yearB = parseInt(b.bulletinId.match(/APSB(\d{2})/)?.[1] || "0", 10);
      if (yearA !== yearB) return yearB - yearA;

      const numA = parseInt(a.bulletinId.match(/-(\d+)$/)?.[1] || "0", 10);
      const numB = parseInt(b.bulletinId.match(/-(\d+)$/)?.[1] || "0", 10);
      return numB - numA;
    });

    return vulns;
  }

  /**
   * Get product path for URL
   */
  private getProductPath(products: string[]): string {
    if (products.some(p => p.toLowerCase().includes("acrobat"))) return "acrobat";
    if (products.some(p => p.toLowerCase().includes("reader"))) return "acrobat";
    if (products.some(p => p.toLowerCase().includes("photoshop"))) return "photoshop";
    if (products.some(p => p.toLowerCase().includes("illustrator"))) return "illustrator";
    if (products.some(p => p.toLowerCase().includes("commerce"))) return "magento";
    if (products.some(p => p.toLowerCase().includes("coldfusion"))) return "coldfusion";
    return "acrobat";
  }

  /**
   * Extract title from context
   */
  private extractTitle(context: string, bulletinId: string): string {
    // Look for common title patterns
    const titlePatterns = [
      /Security (?:Bulletin|Update|Advisory)[^<]*?for\s+([^<]+)/i,
      />([^<]*?(?:Security Update|Security Bulletin)[^<]*)</i,
      /Adobe\s+([^<]+?)\s+(?:Security|Critical)/i,
    ];

    for (const pattern of titlePatterns) {
      const match = context.match(pattern);
      if (match) {
        return match[1]?.trim() || `Adobe Security Bulletin ${bulletinId}`;
      }
    }

    return `Adobe Security Bulletin ${bulletinId}`;
  }

  /**
   * Extract severity from context
   */
  private extractSeverity(context: string): AdobeVulnerability["severity"] {
    const lower = context.toLowerCase();

    // Adobe uses Priority ratings: 1 (Critical), 2 (Important), 3 (Moderate)
    const priorityMatch = context.match(/priority[:\s]*(\d)/i);
    if (priorityMatch) {
      const priority = parseInt(priorityMatch[1], 10);
      if (priority === 1) return "critical";
      if (priority === 2) return "important";
      if (priority === 3) return "moderate";
    }

    if (lower.includes("critical")) return "critical";
    if (lower.includes("important") || lower.includes("high")) return "important";
    if (lower.includes("moderate") || lower.includes("medium")) return "moderate";
    if (lower.includes("low")) return "low";

    return "important"; // Default for Adobe
  }

  /**
   * Extract affected products from context
   */
  private extractProducts(context: string): string[] {
    const products: string[] = [];

    // Check for known Adobe product names
    const productPatterns = [
      /Adobe\s+(Acrobat(?:\s+(?:Reader|Pro|DC|2020|2024))?)/gi,
      /Adobe\s+(Reader(?:\s+(?:DC|2020|2024))?)/gi,
      /Adobe\s+(Photoshop(?:\s+\d{4})?)/gi,
      /Adobe\s+(Illustrator(?:\s+\d{4})?)/gi,
      /Adobe\s+(InDesign(?:\s+\d{4})?)/gi,
      /Adobe\s+(Premiere\s+Pro(?:\s+\d{4})?)/gi,
      /Adobe\s+(After\s+Effects(?:\s+\d{4})?)/gi,
      /Adobe\s+(Animate(?:\s+\d{4})?)/gi,
      /Adobe\s+(Bridge(?:\s+\d{4})?)/gi,
      /Adobe\s+(Lightroom(?:\s+\w+)?)/gi,
      /Adobe\s+(Creative\s+Cloud)/gi,
      /Adobe\s+(Commerce)/gi,
      /Adobe\s+(Experience\s+Manager)/gi,
      /Adobe\s+(ColdFusion)/gi,
      /Adobe\s+(Flash\s+Player)/gi,
    ];

    for (const pattern of productPatterns) {
      const matches = context.matchAll(pattern);
      for (const match of matches) {
        const product = `Adobe ${match[1]}`.trim();
        if (!products.includes(product)) {
          products.push(product);
        }
      }
    }

    return products;
  }

  /**
   * Extract version numbers from context
   */
  private extractVersions(context: string): { affected: string[]; fixed: string[] } {
    const affected: string[] = [];
    const fixed: string[] = [];

    // Adobe version patterns:
    // - Continuous track: 24.001.20604, 24.005.20320
    // - Classic track: 2020.001.30008, 2024.001.20604
    // - Year-based: 2024, 2025
    const versionPattern = /\b(\d{2,4}\.\d{3}\.\d{5}|\d{4}(?:\.\d+)*)\b/g;

    const matches = context.matchAll(versionPattern);
    for (const match of matches) {
      const version = match[1];
      // Check if this is in a "fixed" context
      const beforeText = context.slice(Math.max(0, match.index! - 50), match.index);
      const afterText = context.slice(match.index!, match.index! + 100);

      if (/(?:fixed|update|solution|patched|resolved)/i.test(beforeText + afterText)) {
        if (!fixed.includes(version)) fixed.push(version);
      } else if (/(?:affected|vulnerable|prior|before)/i.test(beforeText + afterText)) {
        if (!affected.includes(version)) affected.push(version);
      } else {
        // Default to affected
        if (!affected.includes(version)) affected.push(version);
      }
    }

    // Sort versions
    affected.sort((a, b) => this.compareVersions(a, b));
    fixed.sort((a, b) => this.compareVersions(a, b));

    return { affected, fixed };
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

    // Extract year from bulletin ID (APSB25-XX means 2025)
    const yearMatch = context.match(/APSB(\d{2})/);
    if (yearMatch) {
      const year = 2000 + parseInt(yearMatch[1], 10);
      return `${year}-01-01`;
    }

    return new Date().toISOString().split("T")[0];
  }

  /**
   * Filter vulnerabilities by product
   */
  private filterByProduct(vulns: AdobeVulnerability[]): AdobeVulnerability[] {
    const productNames = ADOBE_PRODUCTS[this.product] || [this.product];

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
  private calculateMsv(vulns: AdobeVulnerability[]): Record<string, string> {
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

    return msv;
  }

  /**
   * Normalize product name
   */
  private normalizeProductName(name: string): string {
    return name
      .toLowerCase()
      .replace(/adobe\s*/i, "")
      .replace(/\s*\d{4}$/i, "") // Remove year suffix
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
  const fetcher = new AdobeAdvisoryFetcher(dataDir, product);

  console.log(`Fetching Adobe security bulletins for: ${product}...`);

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
        console.log(`    Severity: ${vuln.severity}, Products: ${vuln.affectedProducts.join(", ") || "N/A"}`);
      }
    }
  } catch (error) {
    console.error("Error:", error);
  }
}
