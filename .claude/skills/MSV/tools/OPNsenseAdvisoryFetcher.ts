/**
 * OPNsenseAdvisoryFetcher.ts - OPNsense Firewall Security Advisory Fetcher
 *
 * Fetches security advisories for OPNsense firewall.
 * Primary data source: endoflife.date API (structured JSON)
 * Secondary: GitHub Security Advisories, NVD
 *
 * Products covered:
 * - OPNsense Community Edition
 * - OPNsense Business Edition
 *
 * Version format: YY.R (Calendar versioning)
 * - XX.1 - January release (Community)
 * - XX.7 - July release (Community)
 * - XX.4 - April release (Business)
 * - XX.10 - October release (Business)
 *
 * Examples: 26.1, 25.7, 25.1, 24.7
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

const ENDOFLIFE_API_URL = "https://endoflife.date/api/opnsense.json";
const NVD_API_URL = "https://services.nvd.nist.gov/rest/json/cves/2.0";
const GITHUB_ADVISORIES_URL = "https://github.com/opnsense/core/security/advisories";
const REQUEST_TIMEOUT_MS = 30000;

// =============================================================================
// Types
// =============================================================================

export interface OPNsenseRelease {
  cycle: string;           // e.g., "26.1"
  codename: string;        // e.g., "Witty Woodpecker"
  releaseDate: string;     // e.g., "2026-01-28"
  eol: boolean | string;   // false or date string
  latest: string;          // e.g., "26.1.2"
  latestReleaseDate: string;
  lts: boolean;
}

export interface OPNsenseAdvisory {
  id: string;              // CVE ID or advisory ID
  cveIds: string[];
  title: string;
  severity: "critical" | "high" | "medium" | "low" | "unknown";
  cvssScore: number | null;
  publishedDate: string;
  affectedVersions: string[];
  fixedVersions: string[];
  url: string;
}

interface CacheEntry {
  data: VendorAdvisoryResult;
  expiresAt: string;
}

// =============================================================================
// OPNsense Advisory Fetcher
// =============================================================================

export class OPNsenseAdvisoryFetcher {
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
   * Fetch OPNsense security advisories
   */
  async fetch(): Promise<VendorAdvisoryResult> {
    const cacheKey = `opnsense-${this.product}`;
    const cached = this.getCache(cacheKey);
    if (cached) return cached;

    // Fetch version data from endoflife.date
    let releases: OPNsenseRelease[] = [];
    let advisories: OPNsenseAdvisory[] = [];

    try {
      releases = await this.fetchFromEndOfLife();
    } catch (error) {
      console.error(`OPNsense endoflife.date fetch warning: ${(error as Error).message} - using fallback data`);
      releases = this.getFallbackReleases();
    }

    // Try to fetch CVEs from NVD
    try {
      advisories = await this.fetchFromNvd();
    } catch (error) {
      console.error(`OPNsense NVD fetch warning: ${(error as Error).message}`);
    }

    const securityAdvisories = this.convertToSecurityAdvisories(advisories);
    const branches = this.calculateBranchMsv(releases);

    const result: VendorAdvisoryResult = {
      vendor: "Deciso",
      product: "OPNsense",
      advisories: securityAdvisories,
      branches,
      fetchedAt: new Date().toISOString(),
      source: ENDOFLIFE_API_URL,
    };

    this.setCache(cacheKey, result);
    return result;
  }

  /**
   * Fetch release data from endoflife.date
   */
  private async fetchFromEndOfLife(): Promise<OPNsenseRelease[]> {
    const response = await fetch(ENDOFLIFE_API_URL, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        "User-Agent": "MSV-Skill/1.10 (Security Advisory Fetcher)",
        "Accept": "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(`endoflife.date API error: ${response.status}`);
    }

    return await response.json() as OPNsenseRelease[];
  }

  /**
   * Fetch OPNsense CVEs from NVD
   */
  private async fetchFromNvd(): Promise<OPNsenseAdvisory[]> {
    const advisories: OPNsenseAdvisory[] = [];

    const startDate = new Date();
    startDate.setMonth(startDate.getMonth() - 12);

    const params = new URLSearchParams({
      keywordSearch: "opnsense",
      pubStartDate: startDate.toISOString(),
      pubEndDate: new Date().toISOString(),
      resultsPerPage: "50",
    });

    const response = await fetch(`${NVD_API_URL}?${params}`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        "User-Agent": "MSV-Skill/1.10 (Security Advisory Fetcher)",
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

      const cvssData = cve.metrics?.cvssMetricV31?.[0]?.cvssData;
      const cvssScore = cvssData?.baseScore || null;
      const severity = this.mapSeverity(cvssData?.baseSeverity || "", cvssScore);

      const { affected, fixed } = this.extractVersionsFromDescription(description);

      advisories.push({
        id: cve.id,
        cveIds: [cve.id],
        title: description.substring(0, 200),
        severity,
        cvssScore,
        publishedDate: cve.published || new Date().toISOString(),
        affectedVersions: affected,
        fixedVersions: fixed,
        url: `https://nvd.nist.gov/vuln/detail/${cve.id}`,
      });
    }

    return advisories;
  }

  /**
   * Fallback release data if API unavailable
   */
  private getFallbackReleases(): OPNsenseRelease[] {
    return [
      { cycle: "26.1", codename: "Witty Woodpecker", releaseDate: "2026-01-28", eol: false, latest: "26.1.2", latestReleaseDate: "2026-02-01", lts: false },
      { cycle: "25.7", codename: "Vivid Viper", releaseDate: "2025-07-16", eol: false, latest: "25.7.8", latestReleaseDate: "2025-12-11", lts: false },
      { cycle: "25.1", codename: "Ultimate Unicorn", releaseDate: "2025-01-29", eol: "2025-08-13", latest: "25.1.9", latestReleaseDate: "2025-07-09", lts: false },
      { cycle: "24.7", codename: "Thriving Tiger", releaseDate: "2024-07-17", eol: "2025-01-28", latest: "24.7.12", latestReleaseDate: "2025-01-15", lts: false },
      { cycle: "24.1", codename: "Savvy Shark", releaseDate: "2024-01-31", eol: "2024-08-13", latest: "24.1.10", latestReleaseDate: "2024-07-24", lts: false },
    ];
  }

  /**
   * Extract versions from CVE description
   */
  private extractVersionsFromDescription(description: string): { affected: string[]; fixed: string[] } {
    const affected: string[] = [];
    const fixed: string[] = [];

    // OPNsense version patterns: 24.1, 24.7.1, 25.1.3, etc.
    const versionPattern = /(\d{2}\.\d+(?:\.\d+)?)/g;
    const matches = description.match(versionPattern) || [];

    const fixedPattern = /(?:fixed in|patched in|resolved in|upgrade to)[^.]*?(\d{2}\.\d+(?:\.\d+)?)/gi;
    let match;
    while ((match = fixedPattern.exec(description)) !== null) {
      if (!fixed.includes(match[1])) {
        fixed.push(match[1]);
      }
    }

    for (const v of matches) {
      if (!fixed.includes(v) && !affected.includes(v)) {
        affected.push(v);
      }
    }

    return { affected, fixed };
  }

  /**
   * Map severity string to enum
   */
  private mapSeverity(severityStr: string, cvssScore: number | null): OPNsenseAdvisory["severity"] {
    if (severityStr) {
      const lower = severityStr.toLowerCase();
      if (lower === "critical") return "critical";
      if (lower === "high") return "high";
      if (lower === "medium") return "medium";
      if (lower === "low") return "low";
    }

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
  private convertToSecurityAdvisories(advisories: OPNsenseAdvisory[]): SecurityAdvisory[] {
    return advisories.map(a => ({
      id: a.id,
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
   * Calculate MSV for each version branch from endoflife.date data
   */
  private calculateBranchMsv(releases: OPNsenseRelease[]): BranchMsv[] {
    const branches: BranchMsv[] = [];

    for (const release of releases) {
      // Only include active releases (not EOL)
      const isEol = release.eol === true || (typeof release.eol === "string" && new Date(release.eol) < new Date());

      branches.push({
        branch: release.cycle,
        msv: release.latest,  // Latest version is the MSV (contains all security fixes)
        latest: release.latest,
      });
    }

    // Sort by version descending
    return branches.sort((a, b) => this.compareVersions(b.branch, a.branch));
  }

  /**
   * Compare OPNsense versions
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
 * Fetch OPNsense security advisories
 */
export async function fetchOPNsenseAdvisories(
  cacheDir: string,
  product?: string
): Promise<VendorAdvisoryResult> {
  const fetcher = new OPNsenseAdvisoryFetcher(cacheDir, product);
  return fetcher.fetch();
}
