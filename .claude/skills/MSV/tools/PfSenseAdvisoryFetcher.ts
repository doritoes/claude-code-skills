/**
 * PfSenseAdvisoryFetcher.ts - pfSense Firewall Security Advisory Fetcher
 *
 * Fetches security advisories for pfSense firewall.
 * Primary data source: NVD API (no public pfSense API available)
 * Fallback: Known pfSense version data
 *
 * Products covered:
 * - pfSense Plus (commercial) - YY.MM format
 * - pfSense CE (community) - X.Y.Z format
 *
 * Advisory format: pfSense-SA-YY_XX.component
 * Examples: pfSense-SA-25_01.webgui, pfSense-SA-25_09.sshguard
 *
 * Note: pfSense is the original, OPNsense is a fork.
 * Both are FreeBSD-based firewalls popular for home/SMB use.
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

const PFSENSE_ADVISORIES_URL = "https://docs.netgate.com/advisories/index.html";
const NVD_API_URL = "https://services.nvd.nist.gov/rest/json/cves/2.0";
const REQUEST_TIMEOUT_MS = 30000;

// =============================================================================
// Types
// =============================================================================

export interface PfSenseAdvisory {
  id: string;              // e.g., "pfSense-SA-25_01.webgui" or CVE
  cveIds: string[];
  title: string;
  severity: "critical" | "high" | "medium" | "low" | "unknown";
  cvssScore: number | null;
  publishedDate: string;
  affectedVersions: string[];
  fixedVersions: string[];
  url: string;
  component?: string;      // webgui, sshguard, openssl, etc.
}

interface CacheEntry {
  data: VendorAdvisoryResult;
  expiresAt: string;
}

// =============================================================================
// pfSense Advisory Fetcher
// =============================================================================

export class PfSenseAdvisoryFetcher {
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
   * Fetch pfSense security advisories
   */
  async fetch(): Promise<VendorAdvisoryResult> {
    const cacheKey = `pfsense-${this.product}`;
    const cached = this.getCache(cacheKey);
    if (cached) return cached;

    // Try to fetch CVEs from NVD
    let advisories: PfSenseAdvisory[] = [];
    try {
      advisories = await this.fetchFromNvd();
    } catch (error) {
      console.error(`pfSense NVD fetch warning: ${(error as Error).message} - using fallback data`);
    }

    const securityAdvisories = this.convertToSecurityAdvisories(advisories);
    const branches = this.calculateBranchMsv(advisories);

    const result: VendorAdvisoryResult = {
      vendor: "Netgate",
      product: this.product === "ce" ? "pfSense CE" : (this.product === "plus" ? "pfSense Plus" : "pfSense"),
      advisories: securityAdvisories,
      branches,
      fetchedAt: new Date().toISOString(),
      source: NVD_API_URL,
    };

    this.setCache(cacheKey, result);
    return result;
  }

  /**
   * Fetch pfSense CVEs from NVD
   */
  private async fetchFromNvd(): Promise<PfSenseAdvisory[]> {
    const advisories: PfSenseAdvisory[] = [];

    const startDate = new Date();
    startDate.setMonth(startDate.getMonth() - 12);

    const params = new URLSearchParams({
      keywordSearch: "pfsense",
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

      // Extract pfSense-SA ID from references or description
      const saMatch = description.match(/pfSense-SA-\d{2}_\d+\.\w+/i) ||
        cve.references?.find(r => r.url.includes("netgate.com"))?.url.match(/pfSense-SA-\d{2}_\d+\.\w+/i);
      const saId = saMatch ? saMatch[0] : null;

      const cvssData = cve.metrics?.cvssMetricV31?.[0]?.cvssData;
      const cvssScore = cvssData?.baseScore || null;
      const severity = this.mapSeverity(cvssData?.baseSeverity || "", cvssScore);

      const { affected, fixed } = this.extractVersionsFromDescription(description);
      const component = this.extractComponent(description, saId);

      advisories.push({
        id: saId || cve.id,
        cveIds: [cve.id],
        title: description.substring(0, 200),
        severity,
        cvssScore,
        publishedDate: cve.published || new Date().toISOString(),
        affectedVersions: affected,
        fixedVersions: fixed,
        url: `https://nvd.nist.gov/vuln/detail/${cve.id}`,
        component,
      });
    }

    return advisories;
  }

  /**
   * Extract versions from CVE description
   */
  private extractVersionsFromDescription(description: string): { affected: string[]; fixed: string[] } {
    const affected: string[] = [];
    const fixed: string[] = [];

    // pfSense Plus format: YY.MM (25.11, 24.03)
    // pfSense CE format: X.Y.Z (2.8.1, 2.7.2)
    const versionPattern = /(\d{2}\.\d{1,2}(?:\.\d+)?|\d+\.\d+\.\d+)/g;
    const matches = description.match(versionPattern) || [];

    const fixedPattern = /(?:fixed in|patched in|resolved in|upgrade to)[^.]*?(\d{2}\.\d{1,2}(?:\.\d+)?|\d+\.\d+\.\d+)/gi;
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
   * Extract affected component from advisory
   */
  private extractComponent(description: string, saId: string | null): string | undefined {
    // Try to get from SA ID
    if (saId) {
      const componentMatch = saId.match(/\.(\w+)$/);
      if (componentMatch) return componentMatch[1];
    }

    // Try to extract from description
    const lower = description.toLowerCase();
    const components = [
      "webgui", "sshguard", "openssl", "openvpn", "ipsec", "dns",
      "dhcp", "firewall", "captiveportal", "snort", "suricata",
    ];

    for (const comp of components) {
      if (lower.includes(comp)) return comp;
    }

    return undefined;
  }

  /**
   * Map severity string to enum
   */
  private mapSeverity(severityStr: string, cvssScore: number | null): PfSenseAdvisory["severity"] {
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
  private convertToSecurityAdvisories(advisories: PfSenseAdvisory[]): SecurityAdvisory[] {
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
   * Calculate MSV for each version branch
   */
  private calculateBranchMsv(advisories: PfSenseAdvisory[]): BranchMsv[] {
    const branchMap = new Map<string, { msv: string; latest: string }>();

    // Known latest pfSense versions (updated 2026-02-03)
    // pfSense Plus (commercial) - YY.MM format
    // pfSense CE (community) - X.Y.Z format
    const knownLatest: Record<string, string> = {
      // pfSense Plus (commercial)
      "plus-25": "25.11",    // Latest Plus release
      "plus-24": "24.11",    // Previous Plus release
      "plus-23": "23.09.1",  // Legacy Plus
      // pfSense CE (community)
      "ce-2.8": "2.8.1",     // Latest CE release
      "ce-2.7": "2.7.2",     // Previous CE release
      "ce-2.6": "2.6.0",     // Legacy CE
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
      .sort((a, b) => {
        // Sort Plus before CE, then by version descending
        const aIsPlus = a.branch.startsWith("plus-");
        const bIsPlus = b.branch.startsWith("plus-");
        if (aIsPlus !== bIsPlus) return aIsPlus ? -1 : 1;
        return this.compareVersions(b.msv, a.msv);
      });
  }

  /**
   * Get branch from version
   */
  private getBranch(version: string): string {
    // Plus format: YY.MM
    if (version.match(/^\d{2}\.\d{1,2}$/)) {
      const year = version.split(".")[0];
      return `plus-${year}`;
    }
    // CE format: X.Y.Z
    const parts = version.split(".");
    if (parts.length >= 2) {
      return `ce-${parts[0]}.${parts[1]}`;
    }
    return version;
  }

  /**
   * Compare pfSense versions
   */
  private compareVersions(a: string, b: string): number {
    const partsA = a.replace(/[^\d.]/g, "").split(".").map(p => parseInt(p, 10) || 0);
    const partsB = b.replace(/[^\d.]/g, "").split(".").map(p => parseInt(p, 10) || 0);
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
 * Fetch pfSense security advisories
 */
export async function fetchPfSenseAdvisories(
  cacheDir: string,
  product?: string
): Promise<VendorAdvisoryResult> {
  const fetcher = new PfSenseAdvisoryFetcher(cacheDir, product);
  return fetcher.fetch();
}
