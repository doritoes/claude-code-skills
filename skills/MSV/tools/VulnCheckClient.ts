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
  cve: string | string[];
  date_added: string;
  due_date?: string;
  dueDate?: string;
  vendor: string;
  vendorProject?: string;
  product: string;
  description: string;
  vulnerabilityName?: string;
  shortDescription?: string;
  required_action?: string;
  knownRansomwareCampaignUse?: string;
  cisa_date_added?: string;
  vulncheck_xdb?: { xdb_id: string; url?: string; exploit_type?: string }[];
  vulncheck_reported_exploitation?: { url?: string; date_added?: string }[];
}

export interface VulnCheckKevCatalog {
  entries: VulnCheckKevEntry[];
  count: number;
  lastUpdated: string;
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
   * Product-level CVE discovery requires the paid /v3/search/cpe endpoint.
   * The free nist-nvd2 index only supports cve= filtering, not vendor/product/cpe.
   * Per-CVE enrichment (getCve, checkKev, getExploits) still works on free tier.
   */
  async queryCpe(_cpe: string): Promise<VulnCheckCve[]> {
    return [];
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
   * The free nist-nvd2 index only supports: cve, alias, iava, threat_actor,
   * mitre_id, misp_id, ransomware, botnet, and date-range filters.
   * vendor/product/cpe filtering requires the paid /v3/search/cpe endpoint.
   */
  async searchByProduct(
    _vendor: string,
    _product: string
  ): Promise<VulnCheckCve[]> {
    return [];
  }

  /**
   * Fetch recent VulnCheck KEV entries via index endpoint with date filtering.
   * Uses date range to avoid paginating the full 4,600+ entry catalog.
   * Caches for 4 hours.
   */
  async fetchKevCatalog(forceRefresh?: boolean): Promise<VulnCheckKevCatalog> {
    const cachePath = resolve(this.cacheDir, "vulncheck-kev-catalog.json");
    const CATALOG_CACHE_MS = 4 * 60 * 60 * 1000; // 4 hours

    // Check cache
    if (!forceRefresh && existsSync(cachePath)) {
      try {
        const cached: CacheFile<{ entries: VulnCheckKevEntry[]; totalDocuments: number }> = JSON.parse(
          readFileSync(cachePath, "utf-8")
        );
        if (new Date(cached.expiresAt) > new Date()) {
          return {
            entries: cached.data.entries,
            count: cached.data.totalDocuments,
            lastUpdated: cached.lastUpdated,
          };
        }
      } catch {
        // Cache corrupted, re-fetch
      }
    }

    // Fetch recent entries (last 45 days) via index endpoint with date filter
    // This covers weekly/monthly report periods with margin
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 45);
    const startDateStr = startDate.toISOString().split("T")[0];

    const allEntries: VulnCheckKevEntry[] = [];
    let totalDocuments = 0;
    let cursor: string | undefined = undefined;
    const PAGE_LIMIT = 300;

    // Paginate through results (max 6 pages per cursor session)
    for (let page = 0; page < 6; page++) {
      const params = new URLSearchParams({
        limit: String(PAGE_LIMIT),
        sort: "date_added",
        order: "desc",
        lastModStartDate: startDateStr,
      });
      if (cursor) {
        params.set("cursor", cursor);
      } else if (page === 0) {
        params.set("start_cursor", "true");
      }

      const url = `${BASE_URL}/index/vulncheck-kev?${params.toString()}`;
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(30000),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        throw new Error(
          `VulnCheck KEV index error: ${response.status} ${response.statusText}${errorText ? ` - ${errorText}` : ""}`
        );
      }

      const result = await response.json() as {
        _meta: { total_documents: number; next_cursor?: string; total_pages: number; page: number };
        data: VulnCheckKevEntry[];
      };

      if (page === 0) {
        totalDocuments = result._meta.total_documents;
      }

      if (result.data && result.data.length > 0) {
        allEntries.push(...result.data);
      }

      // Check if more pages
      if (!result._meta.next_cursor || result.data.length < PAGE_LIMIT) {
        break;
      }
      cursor = result._meta.next_cursor;
    }

    // Cache the result
    const cacheData: CacheFile<{ entries: VulnCheckKevEntry[]; totalDocuments: number }> = {
      version: 1,
      lastUpdated: new Date().toISOString(),
      expiresAt: new Date(Date.now() + CATALOG_CACHE_MS).toISOString(),
      source: `${BASE_URL}/index/vulncheck-kev`,
      data: { entries: allEntries, totalDocuments },
    };
    writeFileSync(cachePath, JSON.stringify(cacheData));

    return {
      entries: allEntries,
      count: totalDocuments,
      lastUpdated: cacheData.lastUpdated,
    };
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
