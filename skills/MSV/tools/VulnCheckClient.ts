/**
 * VulnCheckClient.ts - VulnCheck API Client
 *
 * API Base: https://api.vulncheck.com/v3
 * Authentication: Bearer token (VULNCHECK_API_KEY env var)
 * Admiralty Rating: B2 (Usually Reliable, Probably True)
 *
 * VulnCheck provides exploit intelligence including PoC availability,
 * their own KEV tracking, and CPE-based vulnerability queries.
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

// =============================================================================
// Types
// =============================================================================

export interface VulnCheckConfig {
  apiKey: string;
  timeout?: number;
}

export interface VulnCheckCve {
  cve: string;
  description?: string;
  published?: string;
  modified?: string;
  vulncheck_kev?: boolean;
  vulncheck_xdb?: boolean;
  poc_available?: boolean;
  affected_cpe?: string[];
  cvss_v3?: number;
  cvss_v2?: number;
}

/**
 * Raw VulnCheck API response format (differs from our internal format)
 */
interface VulnCheckApiCve {
  id: string;  // API returns "id" not "cve"
  descriptions?: Array<{ lang: string; value: string }>;
  published?: string;
  lastModified?: string;
  vulnStatus?: string;
  metrics?: {
    cvssMetricV31?: Array<{
      cvssData: {
        baseScore: number;
        baseSeverity: string;
      };
    }>;
    cvssMetricV2?: Array<{
      cvssData: {
        baseScore: number;
      };
    }>;
  };
  vulncheck_kev?: boolean;
  vulncheck_xdb?: boolean;
  poc_available?: boolean;
  configurations?: Array<{
    nodes?: Array<{
      cpeMatch?: Array<{
        criteria: string;
        vulnerable: boolean;
        versionEndExcluding?: string;
        versionEndIncluding?: string;
        versionStartIncluding?: string;
      }>;
    }>;
  }>;
}

export interface VulnCheckKevEntry {
  cve: string;
  date_added: string;
  due_date?: string;
  vendor: string;
  product: string;
  description: string;
}

export interface ExploitData {
  cve: string;
  name: string;
  source: string;
  url?: string;
  date_published?: string;
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

const BASE_URL = "https://api.vulncheck.com/v3";
const CACHE_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours

// =============================================================================
// Response Mapper
// =============================================================================

/**
 * Normalize VulnCheck API response to internal format
 * VulnCheck API uses NVD-style fields that differ from our interface
 */
function mapApiCveToInternal(apiCve: VulnCheckApiCve): VulnCheckCve {
  // Extract description (prefer English)
  let description: string | undefined;
  if (apiCve.descriptions && apiCve.descriptions.length > 0) {
    const englishDesc = apiCve.descriptions.find(d => d.lang === "en");
    description = englishDesc?.value || apiCve.descriptions[0].value;
  }

  // Extract CVSS v3 score
  let cvss_v3: number | undefined;
  if (apiCve.metrics?.cvssMetricV31?.[0]) {
    cvss_v3 = apiCve.metrics.cvssMetricV31[0].cvssData.baseScore;
  }

  // Extract CVSS v2 score (fallback)
  let cvss_v2: number | undefined;
  if (apiCve.metrics?.cvssMetricV2?.[0]) {
    cvss_v2 = apiCve.metrics.cvssMetricV2[0].cvssData.baseScore;
  }

  // Extract affected CPEs from configurations
  const affected_cpe: string[] = [];
  if (apiCve.configurations) {
    for (const config of apiCve.configurations) {
      if (config.nodes) {
        for (const node of config.nodes) {
          if (node.cpeMatch) {
            for (const match of node.cpeMatch) {
              if (match.vulnerable && match.criteria) {
                affected_cpe.push(match.criteria);
              }
            }
          }
        }
      }
    }
  }

  return {
    cve: apiCve.id,  // Map "id" to "cve"
    description,
    published: apiCve.published,
    modified: apiCve.lastModified,
    vulncheck_kev: apiCve.vulncheck_kev,
    vulncheck_xdb: apiCve.vulncheck_xdb,
    poc_available: apiCve.poc_available,
    affected_cpe: affected_cpe.length > 0 ? affected_cpe : undefined,
    cvss_v3,
    cvss_v2,
  };
}

// =============================================================================
// Client
// =============================================================================

export class VulnCheckClient {
  private config: VulnCheckConfig;
  private cacheDir: string;

  constructor(config: VulnCheckConfig, cacheDir: string) {
    this.config = config;
    this.cacheDir = cacheDir;

    if (!existsSync(cacheDir)) {
      mkdirSync(cacheDir, { recursive: true });
    }
  }

  private async request<T>(endpoint: string, cacheKey?: string): Promise<T> {
    // Check cache if cacheKey provided
    if (cacheKey) {
      const cachePath = resolve(this.cacheDir, `${cacheKey}.json`);
      if (existsSync(cachePath)) {
        try {
          const cached: CacheFile<T> = JSON.parse(
            readFileSync(cachePath, "utf-8")
          );
          if (new Date(cached.expiresAt) > new Date()) {
            return cached.data;
          }
        } catch {
          // Cache corrupted
        }
      }
    }

    const url = `${BASE_URL}${endpoint}`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        Accept: "application/json",
      },
      signal: this.config.timeout
        ? AbortSignal.timeout(this.config.timeout)
        : undefined,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(
        `VulnCheck API error: ${response.status} ${response.statusText}${errorText ? ` - ${errorText}` : ""}`
      );
    }

    const data: T = await response.json();

    // Cache the result
    if (cacheKey) {
      const cachePath = resolve(this.cacheDir, `${cacheKey}.json`);
      const cacheData: CacheFile<T> = {
        version: 1,
        lastUpdated: new Date().toISOString(),
        expiresAt: new Date(Date.now() + CACHE_DURATION_MS).toISOString(),
        source: url,
        data,
      };
      writeFileSync(cachePath, JSON.stringify(cacheData, null, 2));
    }

    return data;
  }

  /**
   * Query CVE details by CVE ID
   */
  async getCve(cveId: string): Promise<VulnCheckCve | null> {
    try {
      const cacheKey = `vulncheck-cve-${cveId.replace(/[^a-zA-Z0-9-]/g, "_")}`;
      const result = await this.request<{ data: VulnCheckApiCve[] }>(
        `/cve/${encodeURIComponent(cveId)}`,
        cacheKey
      );
      const rawCve = result.data?.[0];
      return rawCve ? mapApiCveToInternal(rawCve) : null;
    } catch (error) {
      if ((error as Error).message.includes("404")) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Query CVEs by CPE (Common Platform Enumeration)
   * Uses free /index/nist-nvd2 endpoint instead of paid /cpe endpoint
   */
  async queryCpe(cpe: string): Promise<VulnCheckCve[]> {
    const cacheKey = `vulncheck-cpe-${cpe.replace(/[^a-zA-Z0-9-]/g, "_")}`;
    try {
      // Use free index endpoint with CPE filter
      const result = await this.request<{ data: VulnCheckApiCve[] }>(
        `/index/nist-nvd2?cpe=${encodeURIComponent(cpe)}`,
        cacheKey
      );
      // Map all API CVEs to internal format
      return (result.data || []).map(mapApiCveToInternal);
    } catch (error) {
      // If index endpoint fails, return empty (don't break the flow)
      if ((error as Error).message.includes("subscription")) {
        return [];
      }
      throw error;
    }
  }

  /**
   * Check VulnCheck's KEV index for a CVE
   * Uses free /index/vulncheck-kev endpoint instead of paid /kev endpoint
   */
  async checkKev(cveId: string): Promise<VulnCheckKevEntry | null> {
    try {
      const cacheKey = `vulncheck-kev-${cveId.replace(/[^a-zA-Z0-9-]/g, "_")}`;
      // Use free index endpoint with CVE filter
      const result = await this.request<{ data: VulnCheckKevEntry[] }>(
        `/index/vulncheck-kev?cve=${encodeURIComponent(cveId)}`,
        cacheKey
      );
      return result.data?.[0] || null;
    } catch (error) {
      if ((error as Error).message.includes("404") ||
          (error as Error).message.includes("subscription")) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Get exploit/PoC data for a CVE from VulnCheck's exploit database
   */
  async getExploits(cveId: string): Promise<ExploitData[]> {
    try {
      const cacheKey = `vulncheck-exploit-${cveId.replace(/[^a-zA-Z0-9-]/g, "_")}`;
      const result = await this.request<{ data: ExploitData[] }>(
        `/exploit?cve=${encodeURIComponent(cveId)}`,
        cacheKey
      );
      return result.data || [];
    } catch (error) {
      if ((error as Error).message.includes("404")) {
        return [];
      }
      throw error;
    }
  }

  /**
   * Search for vulnerabilities by product/vendor
   */
  async searchByProduct(
    vendor: string,
    product: string
  ): Promise<VulnCheckCve[]> {
    const cacheKey = `vulncheck-product-${vendor}-${product}`.replace(
      /[^a-zA-Z0-9-]/g,
      "_"
    );
    const result = await this.request<{ data: VulnCheckApiCve[] }>(
      `/index/nist-nvd2?vendor=${encodeURIComponent(vendor)}&product=${encodeURIComponent(product)}`,
      cacheKey
    );
    // Map all API CVEs to internal format
    return (result.data || []).map(mapApiCveToInternal);
  }

  /**
   * Get Admiralty rating based on exploit data
   */
  getAdmiraltyRating(hasPoC: boolean): {
    reliability: "B" | "C";
    credibility: 2 | 3;
  } {
    return hasPoC
      ? { reliability: "B", credibility: 2 }
      : { reliability: "C", credibility: 3 };
  }
}
