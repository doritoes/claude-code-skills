/**
 * CiscoAdvisoryFetcher.ts - Cisco PSIRT Security Advisory Fetcher
 *
 * Fetches security advisories from Cisco PSIRT openVuln API.
 * API: https://apix.cisco.com/security/advisories/v2
 *
 * Authentication: OAuth2 Client Credentials
 * - Requires CISCO_CLIENT_ID and CISCO_CLIENT_SECRET environment variables
 * - Register at https://apiconsole.cisco.com
 *
 * Products covered:
 * - ASA (Adaptive Security Appliance)
 * - FTD (Firepower Threat Defense)
 * - FMC (Firepower Management Center)
 * - IOS, IOS XE, IOS XR
 * - NX-OS
 * - All Cisco security products
 *
 * Rate limits: 5 calls/sec, 30 calls/min, 5000 calls/day
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

const CISCO_TOKEN_URL = "https://cloudsso.cisco.com/as/token.oauth2";
const CISCO_API_BASE = "https://apix.cisco.com/security/advisories/v2";
const REQUEST_TIMEOUT_MS = 30000;

// =============================================================================
// Types
// =============================================================================

export interface CiscoAdvisory {
  advisoryId: string;        // e.g., "cisco-sa-2025-01-01-xxx"
  advisoryTitle: string;
  cveIds: string[];
  bugIds: string[];
  cvssScore: number | null;
  cvssVector: string | null;
  severity: "critical" | "high" | "medium" | "low" | "informational" | "unknown";
  publishedDate: string;
  lastUpdatedDate: string;
  summary: string;
  affectedProducts: CiscoAffectedProduct[];
  cvrfUrl: string;
  csafUrl: string;
}

export interface CiscoAffectedProduct {
  productName: string;
  affectedVersions: string[];
  fixedVersions: string[];
}

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

interface CiscoApiAdvisory {
  advisoryId: string;
  advisoryTitle: string;
  CVEs?: string[];
  bugIDs?: string[];
  cvssBaseScore?: number;
  cvssVector?: string;
  severity?: string;
  publicationDate?: string;
  lastUpdated?: string;
  summary?: string;
  affectedProducts?: Array<{
    productName: string;
    affectedVersions?: string[];
  }>;
  cvrfUrl?: string;
  csafUrl?: string;
}

interface CacheEntry {
  data: VendorAdvisoryResult;
  expiresAt: string;
}

interface TokenCacheEntry {
  token: string;
  expiresAt: number;
}

// =============================================================================
// Cisco Advisory Fetcher
// =============================================================================

export class CiscoAdvisoryFetcher {
  private cacheDir: string;
  private cacheDurationMs = 4 * 60 * 60 * 1000; // 4 hours
  private clientId: string | null;
  private clientSecret: string | null;
  private tokenCache: TokenCacheEntry | null = null;

  constructor(cacheDir: string, clientId?: string, clientSecret?: string) {
    this.cacheDir = cacheDir;
    this.clientId = clientId || process.env.CISCO_CLIENT_ID || null;
    this.clientSecret = clientSecret || process.env.CISCO_CLIENT_SECRET || null;

    if (!existsSync(cacheDir)) {
      mkdirSync(cacheDir, { recursive: true });
    }
  }

  /**
   * Check if API credentials are configured
   */
  hasCredentials(): boolean {
    return !!(this.clientId && this.clientSecret);
  }

  /**
   * Fetch Cisco advisories for a product
   */
  async fetch(product?: string): Promise<VendorAdvisoryResult> {
    const cacheKey = product ? `cisco-${product.toLowerCase().replace(/\s+/g, "-")}` : "cisco-all";
    const cached = this.getCache(cacheKey);
    if (cached) return cached;

    if (!this.hasCredentials()) {
      // Return empty result with guidance
      return {
        vendor: "Cisco",
        product: product || "All Products",
        advisories: [],
        branches: [],
        fetchedAt: new Date().toISOString(),
        source: `${CISCO_API_BASE} (API credentials not configured - set CISCO_CLIENT_ID and CISCO_CLIENT_SECRET)`,
      };
    }

    const advisories = await this.fetchAdvisories(product);
    const securityAdvisories = this.convertToSecurityAdvisories(advisories);
    const branches = this.calculateBranchMsv(advisories, product);

    const result: VendorAdvisoryResult = {
      vendor: "Cisco",
      product: product || "All Products",
      advisories: securityAdvisories,
      branches,
      fetchedAt: new Date().toISOString(),
      source: CISCO_API_BASE,
    };

    this.setCache(cacheKey, result);
    return result;
  }

  /**
   * Get OAuth2 access token
   */
  private async getAccessToken(): Promise<string> {
    // Check token cache
    if (this.tokenCache && Date.now() < this.tokenCache.expiresAt) {
      return this.tokenCache.token;
    }

    if (!this.clientId || !this.clientSecret) {
      throw new Error("Cisco API credentials not configured");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(CISCO_TOKEN_URL, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          client_id: this.clientId,
          client_secret: this.clientSecret,
          grant_type: "client_credentials",
        }),
      });

      if (!response.ok) {
        throw new Error(`Cisco OAuth failed: ${response.status}`);
      }

      const data = await response.json() as TokenResponse;

      // Cache token with 5-minute buffer before expiry
      this.tokenCache = {
        token: data.access_token,
        expiresAt: Date.now() + (data.expires_in - 300) * 1000,
      };

      return data.access_token;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Fetch advisories from Cisco API
   */
  private async fetchAdvisories(product?: string): Promise<CiscoAdvisory[]> {
    const token = await this.getAccessToken();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      let url: string;
      if (product) {
        url = `${CISCO_API_BASE}/product?product=${encodeURIComponent(product)}&pageSize=50`;
      } else {
        url = `${CISCO_API_BASE}/latest/25`;
      }

      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          "Authorization": `Bearer ${token}`,
          "Accept": "application/json",
          "User-Agent": "MSV-Skill/1.3 (Security Advisory Fetcher)",
        },
      });

      if (!response.ok) {
        if (response.status === 429) {
          throw new Error("Cisco API rate limit exceeded");
        }
        throw new Error(`Cisco API failed: ${response.status}`);
      }

      const data = await response.json() as { advisories?: CiscoApiAdvisory[] } | CiscoApiAdvisory[];

      // API can return array directly or object with advisories property
      const advisories = Array.isArray(data) ? data : (data.advisories || []);
      return advisories.map(a => this.parseAdvisory(a));
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Parse API advisory into internal format
   */
  private parseAdvisory(advisory: CiscoApiAdvisory): CiscoAdvisory {
    const severity = this.parseSeverity(advisory.severity, advisory.cvssBaseScore);

    return {
      advisoryId: advisory.advisoryId,
      advisoryTitle: advisory.advisoryTitle || "",
      cveIds: advisory.CVEs || [],
      bugIds: advisory.bugIDs || [],
      cvssScore: advisory.cvssBaseScore || null,
      cvssVector: advisory.cvssVector || null,
      severity,
      publishedDate: advisory.publicationDate || new Date().toISOString(),
      lastUpdatedDate: advisory.lastUpdated || advisory.publicationDate || new Date().toISOString(),
      summary: advisory.summary || "",
      affectedProducts: (advisory.affectedProducts || []).map(p => ({
        productName: p.productName,
        affectedVersions: p.affectedVersions || [],
        fixedVersions: [],
      })),
      cvrfUrl: advisory.cvrfUrl || "",
      csafUrl: advisory.csafUrl || "",
    };
  }

  /**
   * Parse severity from string or CVSS score
   */
  private parseSeverity(
    severityStr?: string,
    cvssScore?: number
  ): CiscoAdvisory["severity"] {
    if (severityStr) {
      const lower = severityStr.toLowerCase();
      if (lower === "critical") return "critical";
      if (lower === "high") return "high";
      if (lower === "medium") return "medium";
      if (lower === "low") return "low";
      if (lower === "informational") return "informational";
    }

    // Derive from CVSS score
    if (cvssScore !== undefined && cvssScore !== null) {
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
  private convertToSecurityAdvisories(advisories: CiscoAdvisory[]): SecurityAdvisory[] {
    return advisories.map(a => ({
      id: a.advisoryId,
      title: a.advisoryTitle,
      severity: a.severity === "informational" ? "low" : a.severity,
      affectedVersions: a.affectedProducts.flatMap(p => p.affectedVersions),
      fixedVersions: a.affectedProducts.flatMap(p => p.fixedVersions),
      cveIds: a.cveIds,
      publishedDate: a.publishedDate,
      url: a.cvrfUrl || `https://sec.cloudapps.cisco.com/security/center/content/CiscoSecurityAdvisory/${a.advisoryId}`,
    }));
  }

  /**
   * Calculate MSV for each version branch
   */
  private calculateBranchMsv(advisories: CiscoAdvisory[], product?: string): BranchMsv[] {
    const branchMap = new Map<string, { msv: string; latest: string }>();

    // Known latest versions for common Cisco products
    const knownLatest: Record<string, Record<string, string>> = {
      asa: {
        "9.22": "9.22.1",
        "9.21": "9.21.2",
        "9.20": "9.20.3",
        "9.19": "9.19.1",
        "9.18": "9.18.5",
        "9.16": "9.16.4",
      },
      ftd: {
        "7.6": "7.6.0",
        "7.4": "7.4.2",
        "7.2": "7.2.9",
        "7.0": "7.0.6",
      },
      ios_xe: {
        "17.15": "17.15.1",
        "17.12": "17.12.4",
        "17.9": "17.9.5",
        "17.6": "17.6.7",
      },
    };

    // Determine which product's versions to use
    const productKey = this.detectProductKey(product);
    const versions = productKey ? knownLatest[productKey] : {};

    for (const advisory of advisories) {
      for (const prod of advisory.affectedProducts) {
        for (const version of prod.affectedVersions) {
          const branch = this.getBranch(version);
          const current = branchMap.get(branch);

          // MSV would be the next patched version
          const msv = this.incrementPatch(version);

          if (!current || this.compareVersions(msv, current.msv) > 0) {
            branchMap.set(branch, {
              msv,
              latest: versions[branch] || msv,
            });
          }
        }
      }
    }

    // Add known branches if no data from advisories
    if (branchMap.size === 0 && Object.keys(versions).length > 0) {
      for (const [branch, latest] of Object.entries(versions)) {
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
   * Detect product key from product name
   */
  private detectProductKey(product?: string): string | null {
    if (!product) return null;
    const lower = product.toLowerCase();

    if (lower.includes("asa")) return "asa";
    if (lower.includes("ftd") || lower.includes("firepower threat defense")) return "ftd";
    if (lower.includes("ios xe") || lower.includes("ios-xe")) return "ios_xe";
    if (lower.includes("ios xr") || lower.includes("ios-xr")) return "ios_xr";
    if (lower.includes("nx-os") || lower.includes("nexus")) return "nx_os";

    return null;
  }

  /**
   * Get branch from version
   */
  private getBranch(version: string): string {
    const parts = version.split(".");
    if (parts.length >= 2) {
      return parts.slice(0, 2).join(".");
    }
    return version;
  }

  /**
   * Increment patch version
   */
  private incrementPatch(version: string): string {
    const parts = version.split(".").map(p => parseInt(p, 10) || 0);
    if (parts.length >= 3) {
      parts[2]++;
    } else if (parts.length === 2) {
      parts.push(1);
    }
    return parts.join(".");
  }

  /**
   * Compare versions
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
 * Fetch Cisco security advisories
 */
export async function fetchCiscoAdvisories(
  cacheDir: string,
  product?: string,
  clientId?: string,
  clientSecret?: string
): Promise<VendorAdvisoryResult> {
  const fetcher = new CiscoAdvisoryFetcher(cacheDir, clientId, clientSecret);
  return fetcher.fetch(product);
}
