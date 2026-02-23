/**
 * PaloAltoAdvisoryFetcher.ts - Palo Alto Networks Security Advisory Fetcher
 *
 * Fetches security advisories from Palo Alto Networks Security Advisory API (Beta).
 * URL: https://security.paloaltonetworks.com/api
 *
 * No authentication required for the public API.
 *
 * Products covered:
 * - PAN-OS (firewall operating system)
 * - GlobalProtect
 * - Cortex XDR
 * - Prisma Access
 * - Prisma SD-WAN
 * - Expedition
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

const PALO_ALTO_API_BASE = "https://security.paloaltonetworks.com/api/v1";
const PALO_ALTO_ADVISORY_BASE = "https://security.paloaltonetworks.com/";
const REQUEST_TIMEOUT_MS = 30000;

// =============================================================================
// Types
// =============================================================================

export interface PaloAltoAdvisory {
  advisoryId: string;        // e.g., "PAN-SA-2025-0001"
  title: string;
  cveId: string | null;
  cvssScore: number | null;
  cvssVector: string | null;
  severity: "critical" | "high" | "medium" | "low" | "informational" | "unknown";
  publishedDate: string;
  lastUpdatedDate: string;
  url: string;
  summary: string;
  affectedProducts: PaloAltoAffectedProduct[];
  fixedVersions: string[];
}

export interface PaloAltoAffectedProduct {
  product: string;
  affectedVersions: string[];
  fixedVersions: string[];
}

interface ApiAdvisory {
  id: string;
  title: string;
  cve?: string;
  cvss_score?: number;
  cvss_vector?: string;
  severity?: string;
  published_date?: string;
  last_updated?: string;
  summary?: string;
  affected_products?: Array<{
    product: string;
    affected_versions?: string[];
    fixed_versions?: string[];
  }>;
}

interface CacheEntry {
  data: VendorAdvisoryResult;
  expiresAt: string;
}

// =============================================================================
// Palo Alto Advisory Fetcher
// =============================================================================

export class PaloAltoAdvisoryFetcher {
  private cacheDir: string;
  private cacheDurationMs = 4 * 60 * 60 * 1000; // 4 hours

  constructor(cacheDir: string) {
    this.cacheDir = cacheDir;
    if (!existsSync(cacheDir)) {
      mkdirSync(cacheDir, { recursive: true });
    }
  }

  /**
   * Fetch all Palo Alto advisories
   */
  async fetch(product?: string): Promise<VendorAdvisoryResult> {
    const cacheKey = product ? `paloalto-${product.toLowerCase().replace(/\s+/g, "-")}` : "paloalto-all";
    const cached = this.getCache(cacheKey);
    if (cached) return cached;

    const advisories = await this.fetchAdvisories(product);
    const securityAdvisories = this.convertToSecurityAdvisories(advisories);
    const branches = this.calculateBranchMsv(advisories, product);

    const result: VendorAdvisoryResult = {
      vendor: "Palo Alto Networks",
      product: product || "All Products",
      advisories: securityAdvisories,
      branches,
      fetchedAt: new Date().toISOString(),
      source: PALO_ALTO_API_BASE,
    };

    this.setCache(cacheKey, result);
    return result;
  }

  /**
   * Fetch advisories from API
   */
  private async fetchAdvisories(product?: string): Promise<PaloAltoAdvisory[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      // Try the API first
      let url = `${PALO_ALTO_API_BASE}/advisories`;
      if (product) {
        url += `?product=${encodeURIComponent(product)}`;
      }

      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          "User-Agent": "MSV-Skill/1.3 (Security Advisory Fetcher)",
          "Accept": "application/json",
        },
      });

      if (response.ok) {
        const data = await response.json() as { advisories?: ApiAdvisory[] };
        return (data.advisories || []).map(a => this.parseApiAdvisory(a));
      }

      // Fall back to scraping the main page if API fails
      return this.fetchFromWebPage(product);
    } catch (error) {
      // Fall back to web scraping
      return this.fetchFromWebPage(product);
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Parse API response advisory
   */
  private parseApiAdvisory(advisory: ApiAdvisory): PaloAltoAdvisory {
    const severity = this.parseSeverity(advisory.severity || "", advisory.cvss_score);

    return {
      advisoryId: advisory.id || "",
      title: advisory.title || "",
      cveId: advisory.cve || null,
      cvssScore: advisory.cvss_score || null,
      cvssVector: advisory.cvss_vector || null,
      severity,
      publishedDate: advisory.published_date || new Date().toISOString(),
      lastUpdatedDate: advisory.last_updated || advisory.published_date || new Date().toISOString(),
      url: `${PALO_ALTO_ADVISORY_BASE}${advisory.id}`,
      summary: advisory.summary || "",
      affectedProducts: (advisory.affected_products || []).map(p => ({
        product: p.product,
        affectedVersions: p.affected_versions || [],
        fixedVersions: p.fixed_versions || [],
      })),
      fixedVersions: (advisory.affected_products || []).flatMap(p => p.fixed_versions || []),
    };
  }

  /**
   * Fallback: Fetch from web page (scraping)
   */
  private async fetchFromWebPage(product?: string): Promise<PaloAltoAdvisory[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(PALO_ALTO_ADVISORY_BASE, {
        signal: controller.signal,
        headers: {
          "User-Agent": "MSV-Skill/1.3 (Security Advisory Fetcher)",
          "Accept": "text/html",
        },
      });

      if (!response.ok) {
        throw new Error(`Palo Alto web fetch failed: ${response.status}`);
      }

      const html = await response.text();
      return this.parseWebPage(html, product);
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Parse advisories from web page HTML
   */
  private parseWebPage(html: string, product?: string): PaloAltoAdvisory[] {
    const advisories: PaloAltoAdvisory[] = [];

    // Look for advisory links (PAN-SA-YYYY-NNNN or CVE-YYYY-NNNNN)
    const advisoryPattern = /(PAN-SA-\d{4}-\d{4}|CVE-\d{4}-\d+)/g;
    const matches = html.match(advisoryPattern) || [];
    const uniqueIds = [...new Set(matches)];

    // Parse table rows for more data
    const rowPattern = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let rowMatch;

    while ((rowMatch = rowPattern.exec(html)) !== null) {
      const row = rowMatch[1];

      // Extract advisory ID
      const idMatch = row.match(/PAN-SA-\d{4}-\d{4}/);
      if (!idMatch) continue;

      const advisoryId = idMatch[0];

      // Extract title
      const titleMatch = row.match(/<a[^>]*>([^<]+)<\/a>/);
      const title = titleMatch ? titleMatch[1].trim() : "";

      // Extract CVE
      const cveMatch = row.match(/CVE-\d{4}-\d+/);
      const cveId = cveMatch ? cveMatch[0] : null;

      // Extract CVSS
      const cvssMatch = row.match(/(\d+\.\d+)/);
      const cvssScore = cvssMatch ? parseFloat(cvssMatch[1]) : null;

      // Extract date
      const dateMatch = row.match(/\d{4}-\d{2}-\d{2}/);
      const publishedDate = dateMatch ? dateMatch[0] : new Date().toISOString().split("T")[0];

      // Determine severity
      const severity = this.parseSeverity("", cvssScore);

      // Detect product from title
      const detectedProducts = this.detectProducts(title);

      // Filter by product if specified
      if (product) {
        const productLower = product.toLowerCase();
        const matchesProduct = detectedProducts.some(p =>
          p.product.toLowerCase().includes(productLower)
        );
        if (!matchesProduct) continue;
      }

      advisories.push({
        advisoryId,
        title,
        cveId,
        cvssScore,
        cvssVector: null,
        severity,
        publishedDate,
        lastUpdatedDate: publishedDate,
        url: `${PALO_ALTO_ADVISORY_BASE}${advisoryId}`,
        summary: title,
        affectedProducts: detectedProducts,
        fixedVersions: [],
      });
    }

    return advisories;
  }

  /**
   * Detect products mentioned in advisory title
   */
  private detectProducts(title: string): PaloAltoAffectedProduct[] {
    const products: PaloAltoAffectedProduct[] = [];
    const titleLower = title.toLowerCase();

    const productPatterns = [
      { name: "PAN-OS", keywords: ["pan-os", "panos"] },
      { name: "GlobalProtect", keywords: ["globalprotect", "global protect"] },
      { name: "Cortex XDR", keywords: ["cortex xdr", "xdr agent"] },
      { name: "Prisma Access", keywords: ["prisma access"] },
      { name: "Prisma SD-WAN", keywords: ["prisma sd-wan", "sd-wan"] },
      { name: "Expedition", keywords: ["expedition"] },
      { name: "Cortex XSOAR", keywords: ["xsoar", "demisto"] },
      { name: "Prisma Cloud", keywords: ["prisma cloud"] },
    ];

    for (const pattern of productPatterns) {
      if (pattern.keywords.some(k => titleLower.includes(k))) {
        products.push({
          product: pattern.name,
          affectedVersions: [],
          fixedVersions: [],
        });
      }
    }

    // Default to PAN-OS if no specific product detected
    if (products.length === 0) {
      products.push({
        product: "PAN-OS",
        affectedVersions: [],
        fixedVersions: [],
      });
    }

    return products;
  }

  /**
   * Parse severity from string or CVSS score
   */
  private parseSeverity(
    severityStr: string,
    cvssScore: number | null
  ): PaloAltoAdvisory["severity"] {
    const lower = severityStr.toLowerCase();

    if (lower.includes("critical")) return "critical";
    if (lower.includes("high")) return "high";
    if (lower.includes("medium") || lower.includes("moderate")) return "medium";
    if (lower.includes("low")) return "low";
    if (lower.includes("informational") || lower.includes("info")) return "informational";

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
  private convertToSecurityAdvisories(advisories: PaloAltoAdvisory[]): SecurityAdvisory[] {
    return advisories.map(a => ({
      id: a.advisoryId,
      title: a.title,
      severity: a.severity === "informational" ? "low" : a.severity,
      affectedVersions: a.affectedProducts.flatMap(p => p.affectedVersions),
      fixedVersions: a.fixedVersions,
      cveIds: a.cveId ? [a.cveId] : [],
      publishedDate: a.publishedDate,
      url: a.url,
    }));
  }

  /**
   * Calculate MSV for each version branch
   */
  private calculateBranchMsv(advisories: PaloAltoAdvisory[], product?: string): BranchMsv[] {
    const branchMap = new Map<string, { msv: string; latest: string }>();

    // Known latest PAN-OS versions per branch (updated 2026-02-03)
    // Source: endoflife.date/panos, docs.paloaltonetworks.com
    const knownLatest: Record<string, string> = {
      "12.1": "12.1.4",
      "11.2": "11.2.10",
      "11.1": "11.1.13",
      "11.0": "11.0.6",
      "10.2": "10.2.18",
      "10.1": "10.1.14",
    };

    for (const advisory of advisories) {
      for (const prod of advisory.affectedProducts) {
        if (product && !prod.product.toLowerCase().includes(product.toLowerCase())) {
          continue;
        }

        // Check fixed versions
        for (const version of prod.fixedVersions) {
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
    }

    // Add known branches if no data
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
 * Fetch Palo Alto Networks security advisories
 */
export async function fetchPaloAltoAdvisories(
  cacheDir: string,
  product?: string
): Promise<VendorAdvisoryResult> {
  const fetcher = new PaloAltoAdvisoryFetcher(cacheDir);
  return fetcher.fetch(product);
}
