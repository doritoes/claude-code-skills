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
      const result = await this.request<{ data: VulnCheckCve[] }>(
        `/cve/${encodeURIComponent(cveId)}`,
        cacheKey
      );
      return result.data?.[0] || null;
    } catch (error) {
      if ((error as Error).message.includes("404")) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Query CVEs by CPE (Common Platform Enumeration)
   */
  async queryCpe(cpe: string): Promise<VulnCheckCve[]> {
    const cacheKey = `vulncheck-cpe-${cpe.replace(/[^a-zA-Z0-9-]/g, "_")}`;
    const result = await this.request<{ data: VulnCheckCve[] }>(
      `/cpe?cpe=${encodeURIComponent(cpe)}`,
      cacheKey
    );
    return result.data || [];
  }

  /**
   * Check VulnCheck's KEV index for a CVE
   */
  async checkKev(cveId: string): Promise<VulnCheckKevEntry | null> {
    try {
      const cacheKey = `vulncheck-kev-${cveId.replace(/[^a-zA-Z0-9-]/g, "_")}`;
      const result = await this.request<{ data: VulnCheckKevEntry[] }>(
        `/kev?cve=${encodeURIComponent(cveId)}`,
        cacheKey
      );
      return result.data?.[0] || null;
    } catch (error) {
      if ((error as Error).message.includes("404")) {
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
    const result = await this.request<{ data: VulnCheckCve[] }>(
      `/index/nist-nvd2?vendor=${encodeURIComponent(vendor)}&product=${encodeURIComponent(product)}`,
      cacheKey
    );
    return result.data || [];
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
