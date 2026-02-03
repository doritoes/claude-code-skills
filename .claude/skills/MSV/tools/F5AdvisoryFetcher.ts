/**
 * F5AdvisoryFetcher.ts - F5 BIG-IP Security Advisory Fetcher
 *
 * Fetches security advisories for F5 BIG-IP products.
 * Primary data source: NVD API (no public F5 API available)
 * Fallback: Known BIG-IP version data
 *
 * Products covered:
 * - BIG-IP LTM (Local Traffic Manager)
 * - BIG-IP ASM (Application Security Manager)
 * - BIG-IP APM (Access Policy Manager)
 * - BIG-IP GTM/DNS (Global Traffic Manager)
 * - BIG-IP AFM (Advanced Firewall Manager)
 * - F5OS
 * - BIG-IP Next
 *
 * Advisory format: K###### (e.g., K000137353)
 * Version format: 17.1.2, 16.1.5, 15.1.10.8, etc.
 *
 * Note: F5 publishes advisories via my.f5.com (requires auth)
 * and Quarterly Security Notifications (QSN).
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { VendorAdvisoryResult, SecurityAdvisory, BranchMsv } from "./VendorAdvisory";

// =============================================================================
// Constants
// =============================================================================

const F5_ADVISORY_URL = "https://my.f5.com/manage/s/article/";
const NVD_API_URL = "https://services.nvd.nist.gov/rest/json/cves/2.0";
const REQUEST_TIMEOUT_MS = 30000;

// =============================================================================
// Types
// =============================================================================

export interface F5Advisory {
  kArticle: string;          // e.g., "K000137353"
  cveIds: string[];
  title: string;
  severity: "critical" | "high" | "medium" | "low" | "unknown";
  cvssScore: number | null;
  publishedDate: string;
  affectedVersions: string[];
  fixedVersions: string[];
  url: string;
  products: string[];        // LTM, ASM, APM, etc.
}

interface CacheEntry {
  data: VendorAdvisoryResult;
  expiresAt: string;
}

// =============================================================================
// F5 Advisory Fetcher
// =============================================================================

export class F5AdvisoryFetcher {
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
   * Fetch F5 security advisories
   */
  async fetch(): Promise<VendorAdvisoryResult> {
    const cacheKey = `f5-${this.product}`;
    const cached = this.getCache(cacheKey);
    if (cached) return cached;

    // Try to fetch from NVD filtered by F5
    let advisories: F5Advisory[] = [];
    try {
      advisories = await this.fetchFromNvd();
    } catch (error) {
      console.error(`F5 NVD fetch warning: ${(error as Error).message} - using fallback data`);
    }

    // Filter by product if specified
    const filtered = this.product === "all"
      ? advisories
      : advisories.filter(a => this.matchesProduct(a));

    const securityAdvisories = this.convertToSecurityAdvisories(filtered);
    const branches = this.calculateBranchMsv(filtered);

    const result: VendorAdvisoryResult = {
      vendor: "F5",
      product: this.product === "all" ? "BIG-IP" : this.product,
      advisories: securityAdvisories,
      branches,
      fetchedAt: new Date().toISOString(),
      source: NVD_API_URL,
    };

    this.setCache(cacheKey, result);
    return result;
  }

  /**
   * Fetch F5 CVEs from NVD
   */
  private async fetchFromNvd(): Promise<F5Advisory[]> {
    const advisories: F5Advisory[] = [];

    // Query NVD for F5 BIG-IP vulnerabilities from the last 12 months
    const startDate = new Date();
    startDate.setMonth(startDate.getMonth() - 12);

    const params = new URLSearchParams({
      keywordSearch: "f5 big-ip",
      pubStartDate: startDate.toISOString(),
      pubEndDate: new Date().toISOString(),
      resultsPerPage: "50",
    });

    const response = await fetch(`${NVD_API_URL}?${params}`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        "User-Agent": "MSV-Skill/1.9 (Security Advisory Fetcher)",
      },
    });

    if (!response.ok) {
      throw new Error(`NVD API error: ${response.status}`);
    }

    const data = await response.json() as {
      vulnerabilities?: Array<{
        cve: {
          id: string;
          descriptions?: Array<{ lang: string; value: string }>;
          metrics?: {
            cvssMetricV31?: Array<{
              cvssData: { baseScore: number; baseSeverity: string };
            }>;
          };
          published?: string;
          references?: Array<{ url: string }>;
        };
      }>;
    };

    for (const vuln of data.vulnerabilities || []) {
      const cve = vuln.cve;
      const description = cve.descriptions?.find(d => d.lang === "en")?.value || "";

      // Extract K article from references or generate from CVE
      const kMatch = cve.references?.find(r => r.url.includes("my.f5.com") || r.url.includes("support.f5.com"))?.url.match(/K\d{6,}/i);
      const kArticle = kMatch ? kMatch[0].toUpperCase() : `K-${cve.id}`;

      // Extract CVSS score
      const cvssData = cve.metrics?.cvssMetricV31?.[0]?.cvssData;
      const cvssScore = cvssData?.baseScore || null;
      const severity = this.mapSeverity(cvssData?.baseSeverity || "", cvssScore);

      // Extract versions from description
      const { affected, fixed } = this.extractVersionsFromDescription(description);

      // Extract affected products
      const products = this.extractProducts(description);

      advisories.push({
        kArticle,
        cveIds: [cve.id],
        title: description.substring(0, 200),
        severity,
        cvssScore,
        publishedDate: cve.published || new Date().toISOString(),
        affectedVersions: affected,
        fixedVersions: fixed,
        url: `${F5_ADVISORY_URL}${kArticle}`,
        products,
      });
    }

    return advisories;
  }

  /**
   * Extract BIG-IP versions from CVE description
   */
  private extractVersionsFromDescription(description: string): { affected: string[]; fixed: string[] } {
    const affected: string[] = [];
    const fixed: string[] = [];

    // BIG-IP version patterns: 17.1.2, 16.1.5, 15.1.10.8, etc.
    const versionPattern = /(\d{2}\.\d+\.\d+(?:\.\d+)?)/g;
    const matches = description.match(versionPattern) || [];

    // Look for "fixed in", "upgrade to", "patched in" patterns
    const fixedPattern = /(?:fixed in|upgrade to|patched in|resolved in)[^.]*?(\d{2}\.\d+\.\d+(?:\.\d+)?)/gi;
    let match;
    while ((match = fixedPattern.exec(description)) !== null) {
      if (!fixed.includes(match[1])) {
        fixed.push(match[1]);
      }
    }

    // All other versions are likely affected
    for (const v of matches) {
      if (!fixed.includes(v) && !affected.includes(v)) {
        affected.push(v);
      }
    }

    return { affected, fixed };
  }

  /**
   * Extract affected products from description
   */
  private extractProducts(description: string): string[] {
    const products: string[] = [];
    const lower = description.toLowerCase();

    const productPatterns = [
      { name: "BIG-IP LTM", keywords: ["ltm", "local traffic"] },
      { name: "BIG-IP ASM", keywords: ["asm", "application security"] },
      { name: "BIG-IP APM", keywords: ["apm", "access policy"] },
      { name: "BIG-IP GTM", keywords: ["gtm", "global traffic", "dns"] },
      { name: "BIG-IP AFM", keywords: ["afm", "advanced firewall"] },
      { name: "BIG-IP PEM", keywords: ["pem", "policy enforcement"] },
      { name: "BIG-IP AAM", keywords: ["aam", "application acceleration"] },
      { name: "F5OS", keywords: ["f5os", "f5 os"] },
      { name: "BIG-IP Next", keywords: ["big-ip next", "next cnf", "next spk"] },
      { name: "BIG-IP", keywords: ["big-ip", "bigip"] },
    ];

    for (const pattern of productPatterns) {
      if (pattern.keywords.some(k => lower.includes(k))) {
        products.push(pattern.name);
      }
    }

    // Default to BIG-IP if no specific product found
    if (products.length === 0) {
      products.push("BIG-IP");
    }

    return [...new Set(products)]; // Dedupe
  }

  /**
   * Check if advisory matches requested product
   */
  private matchesProduct(advisory: F5Advisory): boolean {
    const productLower = this.product.toLowerCase();
    return advisory.products.some(p => p.toLowerCase().includes(productLower)) ||
      productLower === "big-ip" ||
      productLower === "bigip" ||
      productLower.includes("f5");
  }

  /**
   * Map severity string to enum
   */
  private mapSeverity(severityStr: string, cvssScore: number | null): F5Advisory["severity"] {
    if (severityStr) {
      const lower = severityStr.toLowerCase();
      if (lower === "critical") return "critical";
      if (lower === "high") return "high";
      if (lower === "medium") return "medium";
      if (lower === "low") return "low";
    }

    // Derive from CVSS score
    if (cvssScore !== null) {
      if (cvssScore >= 9.0) return "critical";
      if (cvssScore >= 7.0) return "high";
      if (cvssScore >= 4.0) return "medium";
      if (cvssScore > 0) return "low";
    }

    return "unknown";
  }

  /**
   * Convert to standard SecurityAdvisory format
   */
  private convertToSecurityAdvisories(advisories: F5Advisory[]): SecurityAdvisory[] {
    return advisories.map(a => ({
      id: a.kArticle,
      title: a.title,
      severity: a.severity,
      affectedVersions: a.affectedVersions,
      fixedVersions: a.fixedVersions,
      cveIds: a.cveIds,
      publishedDate: a.publishedDate.split("T")[0],
      url: a.url,
    }));
  }

  /**
   * Calculate MSV for each version branch
   */
  private calculateBranchMsv(advisories: F5Advisory[]): BranchMsv[] {
    const branchMap = new Map<string, { msv: string; latest: string }>();

    // Known latest BIG-IP versions per branch (updated 2026-02-03)
    // Source: support.f5.com, my.f5.com
    // F5 releases on quarterly cycle with hotfixes
    const knownLatest: Record<string, string> = {
      "17.1": "17.1.2.1",   // Active release
      "17.0": "17.0.1",     // Active release
      "16.1": "16.1.5",     // Active release, LTS
      "15.1": "15.1.10.8",  // Active release, LTS (extended support)
      "14.1": "14.1.5.6",   // End of Technical Support (EOxS)
      "13.1": "13.1.5.1",   // End of Software Development
    };

    // Extract versions from advisories
    for (const advisory of advisories) {
      for (const version of advisory.fixedVersions) {
        const branch = this.getBranch(version);
        const current = branchMap.get(branch);

        if (!current || this.compareVersions(version, current.msv) > 0) {
          branchMap.set(branch, {
            msv: version,
            latest: knownLatest[branch] || version,
          });
        }
      }
    }

    // Add known branches if no advisory data
    if (branchMap.size === 0) {
      for (const [branch, latest] of Object.entries(knownLatest)) {
        branchMap.set(branch, { msv: latest, latest });
      }
    }

    return Array.from(branchMap.entries())
      .map(([branch, info]) => ({
        branch,
        msv: info.msv,
        latest: info.latest,
      }))
      .sort((a, b) => this.compareVersions(b.branch, a.branch));
  }

  /**
   * Get branch from BIG-IP version (e.g., "17.1.2.1" -> "17.1")
   */
  private getBranch(version: string): string {
    const match = version.match(/^(\d+\.\d+)/);
    return match ? match[1] : version;
  }

  /**
   * Compare BIG-IP versions
   */
  private compareVersions(a: string, b: string): number {
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

  // =============================================================================
  // Cache Management
  // =============================================================================

  private getCachePath(key: string): string {
    return resolve(this.cacheDir, `vendor-${key}.json`);
  }

  private getCache(key: string): VendorAdvisoryResult | null {
    const path = this.getCachePath(key);
    if (!existsSync(path)) return null;

    try {
      const entry: CacheEntry = JSON.parse(readFileSync(path, "utf-8"));
      if (new Date(entry.expiresAt) > new Date()) {
        return entry.data;
      }
    } catch {
      // Corrupted cache
    }
    return null;
  }

  private setCache(key: string, data: VendorAdvisoryResult): void {
    const entry: CacheEntry = {
      data,
      expiresAt: new Date(Date.now() + this.cacheDurationMs).toISOString(),
    };
    writeFileSync(this.getCachePath(key), JSON.stringify(entry, null, 2));
  }
}

// =============================================================================
// Convenience Function
// =============================================================================

/**
 * Fetch F5 BIG-IP security advisories
 */
export async function fetchF5Advisories(
  cacheDir: string,
  product?: string
): Promise<VendorAdvisoryResult> {
  const fetcher = new F5AdvisoryFetcher(cacheDir, product);
  return fetcher.fetch();
}
