/**
 * NvdClient.ts - NIST National Vulnerability Database API Client
 *
 * API Base: https://services.nvd.nist.gov/rest/json/cves/2.0
 * No authentication required (rate limited to 5 requests/30 seconds without API key).
 * Admiralty Rating: C3 (Fairly Reliable, Possibly True - Government DB)
 *
 * NVD provides CVE details including affected version ranges via CPE configurations.
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

// =============================================================================
// Types
// =============================================================================

export interface NvdCve {
  id: string;
  sourceIdentifier: string;
  published: string;
  lastModified: string;
  vulnStatus: string;
  descriptions: Array<{ lang: string; value: string }>;
  metrics?: {
    cvssMetricV31?: Array<{
      source: string;
      type: string;
      cvssData: {
        baseScore: number;
        baseSeverity: string;
        vectorString: string;
      };
    }>;
    cvssMetricV30?: Array<{
      source: string;
      type: string;
      cvssData: {
        baseScore: number;
        baseSeverity: string;
      };
    }>;
  };
  configurations?: NvdConfiguration[];
  cisaExploitAdd?: string;
  cisaActionDue?: string;
  cisaRequiredAction?: string;
  cisaVulnerabilityName?: string;
}

export interface NvdConfiguration {
  nodes: NvdNode[];
}

export interface NvdNode {
  operator: string;
  negate: boolean;
  cpeMatch: NvdCpeMatch[];
}

export interface NvdCpeMatch {
  vulnerable: boolean;
  criteria: string;
  versionStartIncluding?: string;
  versionStartExcluding?: string;
  versionEndIncluding?: string;
  versionEndExcluding?: string;
  matchCriteriaId: string;
}

export interface NvdApiResponse {
  resultsPerPage: number;
  startIndex: number;
  totalResults: number;
  vulnerabilities: Array<{ cve: NvdCve }>;
}

export interface VersionInfo {
  cve: string;
  vendor: string;
  product: string;
  fixedVersion: string | null;
  affectedRange: string;
  cvssScore: number | null;
  severity: string | null;
}

interface CacheFile<T> {
  version: number;
  lastUpdated: string;
  expiresAt: string;
  source: string;
  data: T;
}

// =============================================================================
// Constants
// =============================================================================

const NVD_BASE_URL = "https://services.nvd.nist.gov/rest/json/cves/2.0";
const CACHE_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours
const REQUEST_DELAY_MS = 6000; // 6 seconds between requests (rate limit)
const REQUEST_TIMEOUT_MS = 30000; // 30 seconds

// =============================================================================
// Client
// =============================================================================

export class NvdClient {
  private cacheDir: string;
  private lastRequestTime = 0;

  constructor(cacheDir: string) {
    this.cacheDir = cacheDir;

    if (!existsSync(cacheDir)) {
      mkdirSync(cacheDir, { recursive: true });
    }
  }

  /**
   * Rate limit requests to avoid NVD throttling
   */
  private async rateLimit(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRequestTime;
    if (elapsed < REQUEST_DELAY_MS) {
      await new Promise((resolve) =>
        setTimeout(resolve, REQUEST_DELAY_MS - elapsed)
      );
    }
    this.lastRequestTime = Date.now();
  }

  /**
   * Get CVE details by CVE ID
   */
  async getCve(cveId: string): Promise<NvdCve | null> {
    const cacheKey = `nvd-cve-${cveId.replace(/[^a-zA-Z0-9-]/g, "_")}`;
    const cachePath = resolve(this.cacheDir, `${cacheKey}.json`);

    // Check cache
    if (existsSync(cachePath)) {
      try {
        const cached: CacheFile<NvdCve> = JSON.parse(
          readFileSync(cachePath, "utf-8")
        );
        if (new Date(cached.expiresAt) > new Date()) {
          return cached.data;
        }
      } catch {
        // Cache corrupted
      }
    }

    await this.rateLimit();

    const url = `${NVD_BASE_URL}?cveId=${encodeURIComponent(cveId)}`;
    const response = await fetch(url, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      if (response.status === 403) {
        throw new Error("NVD rate limit exceeded. Try again later.");
      }
      throw new Error(`NVD API error: ${response.status} ${response.statusText}`);
    }

    const result: NvdApiResponse = await response.json();

    if (!result.vulnerabilities || result.vulnerabilities.length === 0) {
      return null;
    }

    const cve = result.vulnerabilities[0].cve;

    // Cache the result
    const cacheData: CacheFile<NvdCve> = {
      version: 1,
      lastUpdated: new Date().toISOString(),
      expiresAt: new Date(Date.now() + CACHE_DURATION_MS).toISOString(),
      source: url,
      data: cve,
    };

    writeFileSync(cachePath, JSON.stringify(cacheData, null, 2));

    return cve;
  }

  /**
   * Extract version information from CVE configurations
   */
  extractVersionInfo(cve: NvdCve, targetVendor?: string, targetProduct?: string): VersionInfo[] {
    const results: VersionInfo[] = [];

    if (!cve.configurations) return results;

    // Get CVSS score
    let cvssScore: number | null = null;
    let severity: string | null = null;
    if (cve.metrics?.cvssMetricV31?.[0]) {
      cvssScore = cve.metrics.cvssMetricV31[0].cvssData.baseScore;
      severity = cve.metrics.cvssMetricV31[0].cvssData.baseSeverity;
    } else if (cve.metrics?.cvssMetricV30?.[0]) {
      cvssScore = cve.metrics.cvssMetricV30[0].cvssData.baseScore;
      severity = cve.metrics.cvssMetricV30[0].cvssData.baseSeverity;
    }

    for (const config of cve.configurations) {
      for (const node of config.nodes) {
        for (const match of node.cpeMatch) {
          if (!match.vulnerable) continue;

          // Parse CPE to get vendor/product
          // Format: cpe:2.3:a:vendor:product:version:...
          const cpeParts = match.criteria.split(":");
          if (cpeParts.length < 5) continue;

          const vendor = cpeParts[3];
          const product = cpeParts[4];

          // Filter by target vendor/product if specified
          if (targetVendor && !vendor.toLowerCase().includes(targetVendor.toLowerCase())) {
            continue;
          }
          if (targetProduct && !product.toLowerCase().includes(targetProduct.toLowerCase())) {
            continue;
          }

          // Determine fixed version and affected range
          let fixedVersion: string | null = null;
          let affectedRange = "";

          if (match.versionEndExcluding) {
            fixedVersion = match.versionEndExcluding;
            if (match.versionStartIncluding) {
              affectedRange = `>= ${match.versionStartIncluding}, < ${match.versionEndExcluding}`;
            } else {
              affectedRange = `< ${match.versionEndExcluding}`;
            }
          } else if (match.versionEndIncluding) {
            // Fixed version is the next version after versionEndIncluding
            // We can't determine exact fixed version, but we know <= this is vulnerable
            affectedRange = `<= ${match.versionEndIncluding}`;
            fixedVersion = `> ${match.versionEndIncluding}`;
          } else {
            // Specific version affected
            const version = cpeParts[5];
            if (version && version !== "*") {
              affectedRange = `= ${version}`;
            } else {
              affectedRange = "all versions";
            }
          }

          results.push({
            cve: cve.id,
            vendor,
            product,
            fixedVersion,
            affectedRange,
            cvssScore,
            severity,
          });
        }
      }
    }

    return results;
  }

  /**
   * Get the minimum safe version for a product from multiple CVEs
   */
  async getMinimumSafeVersion(
    cveIds: string[],
    vendor: string,
    product: string
  ): Promise<{ version: string | null; details: VersionInfo[] }> {
    const allVersionInfo: VersionInfo[] = [];
    const fixedVersions: string[] = [];

    for (const cveId of cveIds) {
      try {
        const cve = await this.getCve(cveId);
        if (!cve) continue;

        const versionInfo = this.extractVersionInfo(cve, vendor, product);
        allVersionInfo.push(...versionInfo);

        for (const info of versionInfo) {
          if (info.fixedVersion && !info.fixedVersion.startsWith(">")) {
            fixedVersions.push(info.fixedVersion);
          }
        }
      } catch (error) {
        // Skip CVEs that fail to fetch
        console.warn(`Failed to fetch ${cveId}: ${(error as Error).message}`);
      }
    }

    // Find the highest fixed version (minimum safe version)
    let minimumSafeVersion: string | null = null;
    if (fixedVersions.length > 0) {
      // Sort versions and get the highest
      fixedVersions.sort((a, b) => {
        const partsA = a.split(".").map((p) => parseInt(p, 10) || 0);
        const partsB = b.split(".").map((p) => parseInt(p, 10) || 0);
        const maxLen = Math.max(partsA.length, partsB.length);
        for (let i = 0; i < maxLen; i++) {
          const partA = partsA[i] || 0;
          const partB = partsB[i] || 0;
          if (partA !== partB) return partA - partB;
        }
        return 0;
      });
      minimumSafeVersion = fixedVersions[fixedVersions.length - 1];
    }

    return { version: minimumSafeVersion, details: allVersionInfo };
  }

  /**
   * Search for CVEs by CPE name
   * NVD API supports cpeName parameter for CPE-based searches
   */
  async searchByCpe(
    cpe23: string,
    options: { maxResults?: number; minCvss?: number } = {}
  ): Promise<Array<{
    cve: string;
    description: string;
    cvssScore: number | null;
    severity: string | null;
    fixedVersion: string | null;
    affectedRange: string;
    published: string;
  }>> {
    const { maxResults = 20, minCvss = 4.0 } = options;
    const results: Array<{
      cve: string;
      description: string;
      cvssScore: number | null;
      severity: string | null;
      fixedVersion: string | null;
      affectedRange: string;
      published: string;
    }> = [];

    // Create cache key from CPE
    const cacheKey = `nvd-cpe-${cpe23.replace(/[^a-zA-Z0-9-]/g, "_")}`;
    const cachePath = resolve(this.cacheDir, `${cacheKey}.json`);

    // Check cache
    if (existsSync(cachePath)) {
      try {
        const cached: CacheFile<NvdApiResponse> = JSON.parse(
          readFileSync(cachePath, "utf-8")
        );
        if (new Date(cached.expiresAt) > new Date()) {
          // Process cached results
          return this.processCpeSearchResults(cached.data, minCvss, maxResults);
        }
      } catch {
        // Cache corrupted, fetch fresh
      }
    }

    await this.rateLimit();

    // Extract vendor and product from CPE for keyword search
    // CPE format: cpe:2.3:a:vendor:product:version:...
    const cpeParts = cpe23.split(":");
    const vendor = cpeParts[3] || "";
    const product = cpeParts[4] || "";

    // Use keywordSearch with vendor+product for better compatibility
    // cpeName requires exact CPE match (no wildcards), which often fails
    const searchKeyword = `${vendor} ${product}`.trim();
    const url = `${NVD_BASE_URL}?keywordSearch=${encodeURIComponent(searchKeyword)}&resultsPerPage=${maxResults}`;

    const response = await fetch(url, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      if (response.status === 403) {
        throw new Error("NVD rate limit exceeded. Try again later.");
      }
      throw new Error(`NVD API error: ${response.status} ${response.statusText}`);
    }

    const result: NvdApiResponse = await response.json();

    // Cache the result
    const cacheData: CacheFile<NvdApiResponse> = {
      version: 1,
      lastUpdated: new Date().toISOString(),
      expiresAt: new Date(Date.now() + CACHE_DURATION_MS).toISOString(),
      source: url,
      data: result,
    };

    writeFileSync(cachePath, JSON.stringify(cacheData, null, 2));

    return this.processCpeSearchResults(result, minCvss, maxResults);
  }

  /**
   * Process NVD API response into structured CVE results
   */
  private processCpeSearchResults(
    result: NvdApiResponse,
    minCvss: number,
    maxResults: number
  ): Array<{
    cve: string;
    description: string;
    cvssScore: number | null;
    severity: string | null;
    fixedVersion: string | null;
    affectedRange: string;
    published: string;
  }> {
    const results: Array<{
      cve: string;
      description: string;
      cvssScore: number | null;
      severity: string | null;
      fixedVersion: string | null;
      affectedRange: string;
      published: string;
    }> = [];

    if (!result.vulnerabilities) return results;

    for (const vuln of result.vulnerabilities) {
      const cve = vuln.cve;

      // Get CVSS score
      let cvssScore: number | null = null;
      let severity: string | null = null;
      if (cve.metrics?.cvssMetricV31?.[0]) {
        cvssScore = cve.metrics.cvssMetricV31[0].cvssData.baseScore;
        severity = cve.metrics.cvssMetricV31[0].cvssData.baseSeverity;
      } else if (cve.metrics?.cvssMetricV30?.[0]) {
        cvssScore = cve.metrics.cvssMetricV30[0].cvssData.baseScore;
        severity = cve.metrics.cvssMetricV30[0].cvssData.baseSeverity;
      }

      // Filter by minimum CVSS (medium and above = 4.0+)
      if (cvssScore !== null && cvssScore < minCvss) {
        continue;
      }

      // Get description
      const description = cve.descriptions?.find(d => d.lang === "en")?.value || "No description available";

      // Extract version info from configurations
      let fixedVersion: string | null = null;
      let affectedRange = "unknown";

      if (cve.configurations) {
        for (const config of cve.configurations) {
          for (const node of config.nodes) {
            for (const match of node.cpeMatch) {
              if (!match.vulnerable) continue;

              if (match.versionEndExcluding) {
                fixedVersion = match.versionEndExcluding;
                if (match.versionStartIncluding) {
                  affectedRange = `>= ${match.versionStartIncluding}, < ${match.versionEndExcluding}`;
                } else {
                  affectedRange = `< ${match.versionEndExcluding}`;
                }
              } else if (match.versionEndIncluding) {
                affectedRange = `<= ${match.versionEndIncluding}`;
                fixedVersion = `> ${match.versionEndIncluding}`;
              }
            }
          }
        }
      }

      results.push({
        cve: cve.id,
        description,
        cvssScore,
        severity,
        fixedVersion,
        affectedRange,
        published: cve.published,
      });

      if (results.length >= maxResults) break;
    }

    // Sort by CVSS score descending (most critical first)
    results.sort((a, b) => (b.cvssScore || 0) - (a.cvssScore || 0));

    return results;
  }

  /**
   * Get Admiralty rating for NVD source
   */
  getAdmiraltyRating(): { reliability: "C"; credibility: 3 } {
    return { reliability: "C", credibility: 3 };
  }
}
