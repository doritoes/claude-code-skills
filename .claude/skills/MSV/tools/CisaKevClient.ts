/**
 * CisaKevClient.ts - CISA Known Exploited Vulnerabilities Catalog Client
 *
 * Data Source: https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json
 * No authentication required.
 * Admiralty Rating: A1 (Completely Reliable, Confirmed Active Exploitation)
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";

// =============================================================================
// Types
// =============================================================================

export interface KevEntry {
  cveID: string;
  vendorProject: string;
  product: string;
  vulnerabilityName: string;
  dateAdded: string;
  shortDescription: string;
  requiredAction: string;
  dueDate: string;
  knownRansomwareCampaignUse: "Known" | "Unknown";
  notes: string;
}

export interface KevCatalog {
  title: string;
  catalogVersion: string;
  dateReleased: string;
  count: number;
  vulnerabilities: KevEntry[];
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

const KEV_URL = "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json";
const CACHE_DURATION_MS = 4 * 60 * 60 * 1000; // 4 hours
const REQUEST_TIMEOUT_MS = 30000; // 30 seconds

// =============================================================================
// Client
// =============================================================================

export class CisaKevClient {
  private cacheDir: string;
  private cachePath: string;

  constructor(cacheDir: string) {
    this.cacheDir = cacheDir;
    this.cachePath = resolve(cacheDir, "kev-cache.json");

    if (!existsSync(cacheDir)) {
      mkdirSync(cacheDir, { recursive: true });
    }
  }

  /**
   * Fetch the full KEV catalog, using cache if available and fresh
   */
  async fetchCatalog(forceRefresh = false): Promise<KevCatalog> {
    // Check cache first
    if (!forceRefresh && existsSync(this.cachePath)) {
      try {
        const cached: CacheFile<KevCatalog> = JSON.parse(
          readFileSync(this.cachePath, "utf-8")
        );
        if (new Date(cached.expiresAt) > new Date()) {
          return cached.data;
        }
      } catch {
        // Cache corrupted, refetch
      }
    }

    // Fetch fresh data
    const response = await fetch(KEV_URL, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`CISA KEV error: fetch failed (${response.status} ${response.statusText})`);
    }

    const catalog: KevCatalog = await response.json();

    // Cache the result
    const cacheData: CacheFile<KevCatalog> = {
      version: 1,
      lastUpdated: new Date().toISOString(),
      expiresAt: new Date(Date.now() + CACHE_DURATION_MS).toISOString(),
      source: KEV_URL,
      data: catalog,
    };

    writeFileSync(this.cachePath, JSON.stringify(cacheData, null, 2));

    return catalog;
  }

  /**
   * Find KEV entries matching a product name
   */
  async findByProduct(
    productName: string,
    vendorProject?: string
  ): Promise<KevEntry[]> {
    const catalog = await this.fetchCatalog();
    const searchTerm = productName.toLowerCase();
    const vendorTerm = vendorProject?.toLowerCase();

    return catalog.vulnerabilities.filter((entry) => {
      const productMatch =
        entry.product.toLowerCase().includes(searchTerm) ||
        entry.vulnerabilityName.toLowerCase().includes(searchTerm);

      if (vendorTerm) {
        return productMatch && entry.vendorProject.toLowerCase().includes(vendorTerm);
      }

      return productMatch;
    });
  }

  /**
   * Find KEV entry by CVE ID
   */
  async findByCve(cveId: string): Promise<KevEntry | null> {
    const catalog = await this.fetchCatalog();
    return catalog.vulnerabilities.find(
      (entry) => entry.cveID.toUpperCase() === cveId.toUpperCase()
    ) || null;
  }

  /**
   * Check if a CVE is in the KEV catalog
   */
  async isInKev(cveId: string): Promise<boolean> {
    const entry = await this.findByCve(cveId);
    return entry !== null;
  }

  /**
   * Get catalog statistics
   */
  async getStats(): Promise<{
    totalCount: number;
    lastUpdated: string;
    ransomwareCount: number;
  }> {
    const catalog = await this.fetchCatalog();
    const ransomwareCount = catalog.vulnerabilities.filter(
      (v) => v.knownRansomwareCampaignUse === "Known"
    ).length;

    return {
      totalCount: catalog.count,
      lastUpdated: catalog.dateReleased,
      ransomwareCount,
    };
  }

  /**
   * Get Admiralty rating for CISA KEV source
   */
  getAdmiraltyRating(): { reliability: "A"; credibility: 1 } {
    return { reliability: "A", credibility: 1 };
  }
}
