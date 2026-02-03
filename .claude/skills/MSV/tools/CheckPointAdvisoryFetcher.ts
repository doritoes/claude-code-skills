/**
 * CheckPointAdvisoryFetcher.ts - Check Point Security Advisory Fetcher
 *
 * Fetches security advisories for Check Point products.
 * Primary data source: NVD API (no public Check Point API available)
 * Fallback: Known Gaia OS version data
 *
 * Products covered:
 * - Gaia OS (firewall operating system)
 * - Security Gateway
 * - Security Management Server
 * - CloudGuard
 * - Quantum Security Gateway
 * - Endpoint Security
 *
 * Advisory format: sk###### (e.g., sk182336)
 * Version format: R82, R81.20, R81.10, R81, R80.40, R80.30, etc.
 *
 * Note: Check Point publishes advisories via support.checkpoint.com (sk articles)
 * and IPS protections via advisories.checkpoint.com (CPAI articles).
 *
 * IMPORTANT: Seth is a Check Point expert (CCSE/CCME certified) - this
 * is a priority vendor for the MSV skill.
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

const CHECKPOINT_SK_URL = "https://support.checkpoint.com/results/sk/";
const NVD_API_URL = "https://services.nvd.nist.gov/rest/json/cves/2.0";
const REQUEST_TIMEOUT_MS = 30000;

// =============================================================================
// Types
// =============================================================================

export interface CheckPointAdvisory {
  skId: string;              // e.g., "sk182336"
  cveIds: string[];
  title: string;
  severity: "critical" | "high" | "medium" | "low" | "unknown";
  cvssScore: number | null;
  publishedDate: string;
  affectedVersions: string[];
  fixedVersions: string[];
  url: string;
  products: string[];        // Gateway, Management, CloudGuard, etc.
}

interface CacheEntry {
  data: VendorAdvisoryResult;
  expiresAt: string;
}

// =============================================================================
// Check Point Advisory Fetcher
// =============================================================================

export class CheckPointAdvisoryFetcher {
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
   * Fetch Check Point security advisories
   */
  async fetch(): Promise<VendorAdvisoryResult> {
    const cacheKey = `checkpoint-${this.product}`;
    const cached = this.getCache(cacheKey);
    if (cached) return cached;

    // Try to fetch from NVD filtered by Check Point
    let advisories: CheckPointAdvisory[] = [];
    try {
      advisories = await this.fetchFromNvd();
    } catch (error) {
      console.error(`Check Point NVD fetch warning: ${(error as Error).message} - using fallback data`);
    }

    // Filter by product if specified
    const filtered = this.product === "all"
      ? advisories
      : advisories.filter(a => this.matchesProduct(a));

    const securityAdvisories = this.convertToSecurityAdvisories(filtered);
    const branches = this.calculateBranchMsv(filtered);

    const result: VendorAdvisoryResult = {
      vendor: "Check Point",
      product: this.product === "all" ? "Gaia OS" : this.product,
      advisories: securityAdvisories,
      branches,
      fetchedAt: new Date().toISOString(),
      source: NVD_API_URL,
    };

    this.setCache(cacheKey, result);
    return result;
  }

  /**
   * Fetch Check Point CVEs from NVD
   */
  private async fetchFromNvd(): Promise<CheckPointAdvisory[]> {
    const advisories: CheckPointAdvisory[] = [];

    // Query NVD for Check Point vulnerabilities from the last 12 months
    const startDate = new Date();
    startDate.setMonth(startDate.getMonth() - 12);

    const params = new URLSearchParams({
      keywordSearch: "check point gaia",
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

      // Extract SK article from references or description
      const skMatch = description.match(/sk\d{6}/i) ||
        cve.references?.find(r => r.url.includes("support.checkpoint.com"))?.url.match(/sk\d{6}/i);
      const skId = skMatch ? skMatch[0].toLowerCase() : `sk-${cve.id.replace("CVE-", "")}`;

      // Extract CVSS score
      const cvssData = cve.metrics?.cvssMetricV31?.[0]?.cvssData;
      const cvssScore = cvssData?.baseScore || null;
      const severity = this.mapSeverity(cvssData?.baseSeverity || "", cvssScore);

      // Extract versions from description
      const { affected, fixed } = this.extractVersionsFromDescription(description);

      // Extract affected products
      const products = this.extractProducts(description);

      advisories.push({
        skId,
        cveIds: [cve.id],
        title: description.substring(0, 200),
        severity,
        cvssScore,
        publishedDate: cve.published || new Date().toISOString(),
        affectedVersions: affected,
        fixedVersions: fixed,
        url: `${CHECKPOINT_SK_URL}${skId}`,
        products,
      });
    }

    return advisories;
  }

  /**
   * Extract Gaia versions from CVE description
   */
  private extractVersionsFromDescription(description: string): { affected: string[]; fixed: string[] } {
    const affected: string[] = [];
    const fixed: string[] = [];

    // Gaia version patterns: R82, R81.20, R81.10, R81, R80.40, R80.30, R77.30
    const versionPattern = /R(\d{2}(?:\.\d{1,2})?)/gi;
    const matches = description.match(versionPattern) || [];

    // Look for "fixed in", "hotfix", "take" patterns
    const fixedPattern = /(?:fixed in|hotfix|take \d+|jumbo hotfix)[^.]*?(R\d{2}(?:\.\d{1,2})?)/gi;
    let match;
    while ((match = fixedPattern.exec(description)) !== null) {
      const version = match[1].toUpperCase();
      if (!fixed.includes(version)) {
        fixed.push(version);
      }
    }

    // All other versions are likely affected
    for (const v of matches) {
      const version = v.toUpperCase();
      if (!fixed.includes(version) && !affected.includes(version)) {
        affected.push(version);
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
      { name: "Security Gateway", keywords: ["security gateway", "firewall gateway", "gateway"] },
      { name: "Security Management", keywords: ["management server", "smartconsole", "security management"] },
      { name: "CloudGuard", keywords: ["cloudguard", "cloud guard"] },
      { name: "Quantum", keywords: ["quantum"] },
      { name: "Endpoint Security", keywords: ["endpoint", "harmony endpoint"] },
      { name: "Mobile Access", keywords: ["mobile access", "vpn", "remote access"] },
      { name: "Maestro", keywords: ["maestro", "hyperscale"] },
      { name: "VSX", keywords: ["vsx", "virtual system"] },
      { name: "Gaia OS", keywords: ["gaia", "check point"] },
    ];

    for (const pattern of productPatterns) {
      if (pattern.keywords.some(k => lower.includes(k))) {
        products.push(pattern.name);
      }
    }

    // Default to Gaia OS if no specific product found
    if (products.length === 0) {
      products.push("Gaia OS");
    }

    return [...new Set(products)]; // Dedupe
  }

  /**
   * Check if advisory matches requested product
   */
  private matchesProduct(advisory: CheckPointAdvisory): boolean {
    const productLower = this.product.toLowerCase();
    return advisory.products.some(p => p.toLowerCase().includes(productLower)) ||
      productLower === "gaia" ||
      productLower === "gateway" ||
      productLower.includes("checkpoint") ||
      productLower.includes("check point");
  }

  /**
   * Map severity string to enum
   */
  private mapSeverity(severityStr: string, cvssScore: number | null): CheckPointAdvisory["severity"] {
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
  private convertToSecurityAdvisories(advisories: CheckPointAdvisory[]): SecurityAdvisory[] {
    return advisories.map(a => ({
      id: a.skId,
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
  private calculateBranchMsv(advisories: CheckPointAdvisory[]): BranchMsv[] {
    const branchMap = new Map<string, { msv: string; latest: string }>();

    // Known latest Gaia OS versions per branch (updated 2026-02-03)
    // Source: support.checkpoint.com, Check Point release notes
    // Format: R[Major].[Minor] with Jumbo Hotfix Accumulator (JHA) Takes
    //
    // Note: Check Point uses "Take" numbers for Jumbo Hotfix Accumulators
    // e.g., "R81.20 Jumbo Hotfix Accumulator Take 65"
    // The MSV should be the branch + minimum Take number with all security fixes
    const knownLatest: Record<string, string> = {
      "R82":    "R82",          // Newest release (2025)
      "R81.20": "R81.20",       // Titan Release - Active
      "R81.10": "R81.10",       // Active - Extended support
      "R81":    "R81",          // Active - Extended support
      "R80.40": "R80.40",       // End of Support approaching
      "R80.30": "R80.30",       // End of Support
      "R80.20": "R80.20",       // End of Support
      "R77.30": "R77.30",       // Legacy - End of Life
    };

    // Extract versions from advisories
    for (const advisory of advisories) {
      for (const version of advisory.fixedVersions) {
        const branch = this.normalizeBranch(version);
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
   * Normalize branch name (e.g., "R81.20" stays "R81.20", "R81" stays "R81")
   */
  private normalizeBranch(version: string): string {
    const match = version.match(/^(R\d{2}(?:\.\d{1,2})?)/i);
    return match ? match[1].toUpperCase() : version.toUpperCase();
  }

  /**
   * Compare Gaia versions
   */
  private compareVersions(a: string, b: string): number {
    // Parse R## or R##.## format
    const parseVersion = (v: string) => {
      const match = v.match(/R(\d+)(?:\.(\d+))?/i);
      if (!match) return [0, 0];
      return [
        parseInt(match[1], 10) || 0,
        parseInt(match[2], 10) || 0,
      ];
    };

    const partsA = parseVersion(a);
    const partsB = parseVersion(b);

    for (let i = 0; i < 2; i++) {
      if (partsA[i] !== partsB[i]) return partsA[i] - partsB[i];
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
 * Fetch Check Point security advisories
 */
export async function fetchCheckPointAdvisories(
  cacheDir: string,
  product?: string
): Promise<VendorAdvisoryResult> {
  const fetcher = new CheckPointAdvisoryFetcher(cacheDir, product);
  return fetcher.fetch();
}
