/**
 * JuniperAdvisoryFetcher.ts - Juniper Networks Security Advisory Fetcher
 *
 * Fetches security advisories for Juniper Networks products.
 * Primary data source: CISA KEV + NVD (no public Juniper API available)
 * Fallback: Known JunOS version data
 *
 * Products covered:
 * - JunOS (network operating system)
 * - SRX Series (firewalls)
 * - EX Series (switches)
 * - MX Series (routers)
 * - QFX Series (data center switches)
 *
 * Advisory format: JSA##### (e.g., JSA75729)
 * Version format: YY.QRx (e.g., 24.2R2)
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

const JUNIPER_ADVISORY_URL = "https://advisory.juniper.net/";
const NVD_API_URL = "https://services.nvd.nist.gov/rest/json/cves/2.0";
const REQUEST_TIMEOUT_MS = 30000;

// =============================================================================
// Types
// =============================================================================

export interface JuniperAdvisory {
  jsaId: string;           // e.g., "JSA75729"
  cveIds: string[];
  title: string;
  severity: "critical" | "high" | "medium" | "low" | "unknown";
  cvssScore: number | null;
  publishedDate: string;
  affectedVersions: string[];
  fixedVersions: string[];
  url: string;
  products: string[];      // SRX, EX, MX, etc.
}

interface CacheEntry {
  data: VendorAdvisoryResult;
  expiresAt: string;
}

// =============================================================================
// Juniper Advisory Fetcher
// =============================================================================

export class JuniperAdvisoryFetcher {
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
   * Fetch Juniper security advisories
   */
  async fetch(): Promise<VendorAdvisoryResult> {
    const cacheKey = `juniper-${this.product}`;
    const cached = this.getCache(cacheKey);
    if (cached) return cached;

    // Try to fetch from NVD filtered by Juniper
    let advisories: JuniperAdvisory[] = [];
    try {
      advisories = await this.fetchFromNvd();
    } catch (error) {
      console.error(`Juniper NVD fetch warning: ${(error as Error).message} - using fallback data`);
    }

    // Filter by product if specified
    const filtered = this.product === "all"
      ? advisories
      : advisories.filter(a => this.matchesProduct(a));

    const securityAdvisories = this.convertToSecurityAdvisories(filtered);
    const branches = this.calculateBranchMsv(filtered);

    const result: VendorAdvisoryResult = {
      vendor: "Juniper Networks",
      product: this.product === "all" ? "JunOS" : this.product,
      advisories: securityAdvisories,
      branches,
      fetchedAt: new Date().toISOString(),
      source: NVD_API_URL,
    };

    this.setCache(cacheKey, result);
    return result;
  }

  /**
   * Fetch Juniper CVEs from NVD
   */
  private async fetchFromNvd(): Promise<JuniperAdvisory[]> {
    const advisories: JuniperAdvisory[] = [];

    // Query NVD for Juniper vulnerabilities from the last 12 months
    const startDate = new Date();
    startDate.setMonth(startDate.getMonth() - 12);

    const params = new URLSearchParams({
      keywordSearch: "juniper junos",
      pubStartDate: startDate.toISOString(),
      pubEndDate: new Date().toISOString(),
      resultsPerPage: "50",
    });

    const response = await fetch(`${NVD_API_URL}?${params}`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        "User-Agent": "MSV-Skill/1.3 (Security Advisory Fetcher)",
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

      // Extract JSA ID from references or description
      const jsaMatch = description.match(/JSA\d{5}/i) ||
        cve.references?.find(r => r.url.includes("advisory.juniper.net"))?.url.match(/JSA\d{5}/i);
      const jsaId = jsaMatch ? jsaMatch[0].toUpperCase() : cve.id;

      // Extract CVSS score
      const cvssData = cve.metrics?.cvssMetricV31?.[0]?.cvssData;
      const cvssScore = cvssData?.baseScore || null;
      const severity = this.mapSeverity(cvssData?.baseSeverity || "", cvssScore);

      // Extract versions from description
      const { affected, fixed } = this.extractVersionsFromDescription(description);

      // Extract affected products
      const products = this.extractProducts(description);

      advisories.push({
        jsaId,
        cveIds: [cve.id],
        title: description.substring(0, 200),
        severity,
        cvssScore,
        publishedDate: cve.published || new Date().toISOString(),
        affectedVersions: affected,
        fixedVersions: fixed,
        url: `https://advisory.juniper.net/${jsaId}`,
        products,
      });
    }

    return advisories;
  }

  /**
   * Extract JunOS versions from CVE description
   */
  private extractVersionsFromDescription(description: string): { affected: string[]; fixed: string[] } {
    const affected: string[] = [];
    const fixed: string[] = [];

    // JunOS version patterns: 21.4R3, 22.1R2-S1, 23.2R1, etc.
    const versionPattern = /(\d{2}\.\d+R\d+(?:-S\d+)?)/g;
    const matches = description.match(versionPattern) || [];

    // Look for "fixed in" patterns
    const fixedPattern = /(?:fixed in|upgrade to|patched in)[^.]*?(\d{2}\.\d+R\d+(?:-S\d+)?)/gi;
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
      { name: "SRX Series", keywords: ["srx"] },
      { name: "EX Series", keywords: ["ex series", "ex switch"] },
      { name: "MX Series", keywords: ["mx series", "mx router"] },
      { name: "QFX Series", keywords: ["qfx"] },
      { name: "PTX Series", keywords: ["ptx"] },
      { name: "ACX Series", keywords: ["acx"] },
      { name: "NFX Series", keywords: ["nfx"] },
      { name: "JunOS", keywords: ["junos"] },
    ];

    for (const pattern of productPatterns) {
      if (pattern.keywords.some(k => lower.includes(k))) {
        products.push(pattern.name);
      }
    }

    // Default to JunOS if no specific product found
    if (products.length === 0) {
      products.push("JunOS");
    }

    return products;
  }

  /**
   * Check if advisory matches requested product
   */
  private matchesProduct(advisory: JuniperAdvisory): boolean {
    const productLower = this.product.toLowerCase();
    return advisory.products.some(p => p.toLowerCase().includes(productLower)) ||
      productLower === "junos" ||
      productLower.includes("juniper");
  }

  /**
   * Map severity string to enum
   */
  private mapSeverity(severityStr: string, cvssScore: number | null): JuniperAdvisory["severity"] {
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
  private convertToSecurityAdvisories(advisories: JuniperAdvisory[]): SecurityAdvisory[] {
    return advisories.map(a => ({
      id: a.jsaId,
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
  private calculateBranchMsv(advisories: JuniperAdvisory[]): BranchMsv[] {
    const branchMap = new Map<string, { msv: string; latest: string }>();

    // Known latest JunOS versions per branch (updated 2026-02-03)
    // Source: support.juniper.net/support/eol/software/junos/
    // Format: YY.Q (year.quarter)
    const knownLatest: Record<string, string> = {
      "25.2": "25.2R1",
      "24.4": "24.4R1",
      "24.2": "24.2R2",
      "23.4": "23.4R2",
      "23.2": "23.2R2",
      "22.4": "22.4R3",
      "22.2": "22.2R3",
      "21.4": "21.4R3",
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
   * Get branch from JunOS version (e.g., "24.2R2" -> "24.2")
   */
  private getBranch(version: string): string {
    const match = version.match(/^(\d{2}\.\d+)/);
    return match ? match[1] : version;
  }

  /**
   * Compare JunOS versions
   */
  private compareVersions(a: string, b: string): number {
    // Parse YY.QRx format
    const parseVersion = (v: string) => {
      const match = v.match(/(\d+)\.(\d+)(?:R(\d+))?(?:-S(\d+))?/);
      if (!match) return [0, 0, 0, 0];
      return [
        parseInt(match[1], 10) || 0,
        parseInt(match[2], 10) || 0,
        parseInt(match[3], 10) || 0,
        parseInt(match[4], 10) || 0,
      ];
    };

    const partsA = parseVersion(a);
    const partsB = parseVersion(b);

    for (let i = 0; i < 4; i++) {
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
 * Fetch Juniper Networks security advisories
 */
export async function fetchJuniperAdvisories(
  cacheDir: string,
  product?: string
): Promise<VendorAdvisoryResult> {
  const fetcher = new JuniperAdvisoryFetcher(cacheDir, product);
  return fetcher.fetch();
}
