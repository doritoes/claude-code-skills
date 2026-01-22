/**
 * SonicWallAdvisoryFetcher.ts - SonicWall Security Advisory Fetcher
 *
 * Fetches security advisories from SonicWall PSIRT portal.
 * URL: https://psirt.global.sonicwall.com/
 *
 * No authentication required for the public portal.
 *
 * Products covered:
 * - SonicOS (firewall operating system)
 * - SMA 100/1000 (Secure Mobile Access)
 * - NSv (virtual firewall)
 * - Global VPN Client
 * - SonicWave (wireless)
 * - Capture Client
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

const SONICWALL_PSIRT_URL = "https://psirt.global.sonicwall.com/";
const SONICWALL_API_URL = "https://psirt.global.sonicwall.com/api/v1/advisories";
const REQUEST_TIMEOUT_MS = 30000;

// =============================================================================
// Types
// =============================================================================

export interface SonicWallAdvisory {
  snwlId: string;            // e.g., "SNWLID-2025-0019"
  title: string;
  cveIds: string[];
  cvssScore: number | null;
  cvssVector: string | null;
  severity: "critical" | "high" | "medium" | "low" | "unknown";
  publishedDate: string;
  lastUpdatedDate: string;
  url: string;
  summary: string;
  affectedProducts: SonicWallAffectedProduct[];
  fixedVersions: string[];
}

export interface SonicWallAffectedProduct {
  product: string;
  affectedVersions: string[];
  fixedVersions: string[];
}

interface CacheEntry {
  data: VendorAdvisoryResult;
  expiresAt: string;
}

// =============================================================================
// SonicWall Advisory Fetcher
// =============================================================================

export class SonicWallAdvisoryFetcher {
  private cacheDir: string;
  private cacheDurationMs = 4 * 60 * 60 * 1000; // 4 hours

  constructor(cacheDir: string) {
    this.cacheDir = cacheDir;
    if (!existsSync(cacheDir)) {
      mkdirSync(cacheDir, { recursive: true });
    }
  }

  /**
   * Fetch all SonicWall advisories
   */
  async fetch(product?: string): Promise<VendorAdvisoryResult> {
    const cacheKey = product ? `sonicwall-${product.toLowerCase().replace(/\s+/g, "-")}` : "sonicwall-all";
    const cached = this.getCache(cacheKey);
    if (cached) return cached;

    const advisories = await this.fetchAdvisories();
    const filtered = product
      ? advisories.filter(a =>
          a.affectedProducts.some(p =>
            p.product.toLowerCase().includes(product.toLowerCase())
          )
        )
      : advisories;

    const securityAdvisories = this.convertToSecurityAdvisories(filtered);
    const branches = this.calculateBranchMsv(filtered, product);

    const result: VendorAdvisoryResult = {
      vendor: "SonicWall",
      product: product || "All Products",
      advisories: securityAdvisories,
      branches,
      fetchedAt: new Date().toISOString(),
      source: SONICWALL_PSIRT_URL,
    };

    this.setCache(cacheKey, result);
    return result;
  }

  /**
   * Fetch advisories from PSIRT portal
   */
  private async fetchAdvisories(): Promise<SonicWallAdvisory[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      // Try API endpoint first
      try {
        const apiResponse = await fetch(SONICWALL_API_URL, {
          signal: controller.signal,
          headers: {
            "User-Agent": "MSV-Skill/1.3 (Security Advisory Fetcher)",
            "Accept": "application/json",
          },
        });

        if (apiResponse.ok) {
          const data = await apiResponse.json() as { advisories?: unknown[] };
          if (data.advisories && Array.isArray(data.advisories)) {
            return data.advisories.map(a => this.parseApiAdvisory(a));
          }
        }
      } catch {
        // API failed, fall back to web scraping
      }

      // Fall back to scraping PSIRT portal
      const response = await fetch(SONICWALL_PSIRT_URL, {
        signal: controller.signal,
        headers: {
          "User-Agent": "MSV-Skill/1.3 (Security Advisory Fetcher)",
          "Accept": "text/html",
        },
      });

      if (!response.ok) {
        throw new Error(`SonicWall fetch failed: ${response.status}`);
      }

      const html = await response.text();
      return this.parsePortalPage(html);
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Parse API response advisory
   */
  private parseApiAdvisory(advisory: unknown): SonicWallAdvisory {
    const a = advisory as Record<string, unknown>;

    const cveIds: string[] = [];
    if (typeof a.cve === "string") {
      cveIds.push(a.cve);
    } else if (Array.isArray(a.cves)) {
      cveIds.push(...(a.cves as string[]));
    }

    const cvssScore = typeof a.cvss_score === "number" ? a.cvss_score :
                      typeof a.cvss === "number" ? a.cvss : null;

    const severity = this.parseSeverity(
      typeof a.severity === "string" ? a.severity : "",
      cvssScore
    );

    const affectedProducts = this.parseAffectedProducts(
      typeof a.affected_products === "string" ? a.affected_products :
      typeof a.products === "string" ? a.products : ""
    );

    return {
      snwlId: typeof a.id === "string" ? a.id : typeof a.snwlid === "string" ? a.snwlid : "",
      title: typeof a.title === "string" ? a.title : "",
      cveIds,
      cvssScore,
      cvssVector: typeof a.cvss_vector === "string" ? a.cvss_vector : null,
      severity,
      publishedDate: typeof a.published_date === "string" ? a.published_date :
                     typeof a.published === "string" ? a.published : new Date().toISOString(),
      lastUpdatedDate: typeof a.updated_date === "string" ? a.updated_date :
                       typeof a.updated === "string" ? a.updated : new Date().toISOString(),
      url: `${SONICWALL_PSIRT_URL}vuln-detail/${typeof a.id === "string" ? a.id : ""}`,
      summary: typeof a.summary === "string" ? a.summary : typeof a.description === "string" ? a.description : "",
      affectedProducts,
      fixedVersions: affectedProducts.flatMap(p => p.fixedVersions),
    };
  }

  /**
   * Parse portal HTML page for advisories
   */
  private parsePortalPage(html: string): SonicWallAdvisory[] {
    const advisories: SonicWallAdvisory[] = [];

    // Look for advisory links with SNWLID pattern
    const advisoryPattern = /SNWLID-\d{4}-\d{4}/g;
    const matches = html.match(advisoryPattern) || [];
    const uniqueIds = [...new Set(matches)];

    // Parse table rows for more details
    const rowPattern = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let rowMatch;

    while ((rowMatch = rowPattern.exec(html)) !== null) {
      const row = rowMatch[1];

      // Extract SNWLID
      const idMatch = row.match(/SNWLID-\d{4}-\d{4}/);
      if (!idMatch) continue;

      const snwlId = idMatch[0];

      // Extract title/description
      const titleMatch = row.match(/<a[^>]*>([^<]+)<\/a>/);
      const title = titleMatch ? titleMatch[1].trim() : "";

      // Extract CVE
      const cveMatches = row.match(/CVE-\d{4}-\d+/g) || [];

      // Extract CVSS score
      const cvssMatch = row.match(/(\d+\.\d+)/);
      const cvssScore = cvssMatch ? parseFloat(cvssMatch[1]) : null;

      // Extract date
      const dateMatch = row.match(/\d{4}-\d{2}-\d{2}/);
      const publishedDate = dateMatch ? dateMatch[0] : new Date().toISOString().split("T")[0];

      // Determine severity
      const severity = this.parseSeverity("", cvssScore);

      // Detect products from title
      const affectedProducts = this.detectProducts(title);

      advisories.push({
        snwlId,
        title,
        cveIds: cveMatches,
        cvssScore,
        cvssVector: null,
        severity,
        publishedDate,
        lastUpdatedDate: publishedDate,
        url: `${SONICWALL_PSIRT_URL}vuln-detail/${snwlId}`,
        summary: title,
        affectedProducts,
        fixedVersions: [],
      });
    }

    return advisories;
  }

  /**
   * Parse affected products from description text
   */
  private parseAffectedProducts(text: string): SonicWallAffectedProduct[] {
    const products: SonicWallAffectedProduct[] = [];
    const textLower = text.toLowerCase();

    const productPatterns = [
      { name: "SonicOS", keywords: ["sonicos", "sonic os"] },
      { name: "SMA 100", keywords: ["sma 100", "sma100", "sma-100"] },
      { name: "SMA 1000", keywords: ["sma 1000", "sma1000", "sma-1000"] },
      { name: "SonicWave", keywords: ["sonicwave", "sonic wave"] },
      { name: "NSv", keywords: ["nsv", "ns-v"] },
      { name: "Global VPN Client", keywords: ["global vpn", "gvc"] },
      { name: "Capture Client", keywords: ["capture client"] },
      { name: "Email Security", keywords: ["email security", "es "] },
    ];

    for (const pattern of productPatterns) {
      if (pattern.keywords.some(k => textLower.includes(k))) {
        // Extract version numbers near product mentions
        const versionPattern = new RegExp(`${pattern.keywords[0]}[^\\d]*(\\d+\\.\\d+(?:\\.\\d+)?)`, "i");
        const versionMatch = text.match(versionPattern);

        products.push({
          product: pattern.name,
          affectedVersions: versionMatch ? [versionMatch[1]] : [],
          fixedVersions: [],
        });
      }
    }

    // Default to SonicOS if no product detected
    if (products.length === 0) {
      products.push({
        product: "SonicOS",
        affectedVersions: [],
        fixedVersions: [],
      });
    }

    return products;
  }

  /**
   * Detect products from advisory title
   */
  private detectProducts(title: string): SonicWallAffectedProduct[] {
    return this.parseAffectedProducts(title);
  }

  /**
   * Parse severity from string or CVSS score
   */
  private parseSeverity(
    severityStr: string,
    cvssScore: number | null
  ): SonicWallAdvisory["severity"] {
    const lower = severityStr.toLowerCase();

    if (lower.includes("critical")) return "critical";
    if (lower.includes("high")) return "high";
    if (lower.includes("medium") || lower.includes("moderate")) return "medium";
    if (lower.includes("low")) return "low";

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
  private convertToSecurityAdvisories(advisories: SonicWallAdvisory[]): SecurityAdvisory[] {
    return advisories.map(a => ({
      id: a.snwlId,
      title: a.title,
      severity: a.severity,
      affectedVersions: a.affectedProducts.flatMap(p => p.affectedVersions),
      fixedVersions: a.fixedVersions,
      cveIds: a.cveIds,
      publishedDate: a.publishedDate,
      url: a.url,
    }));
  }

  /**
   * Calculate MSV for each version branch
   */
  private calculateBranchMsv(advisories: SonicWallAdvisory[], product?: string): BranchMsv[] {
    const branchMap = new Map<string, { msv: string; latest: string }>();

    // Known latest SonicOS versions per branch
    const knownLatest: Record<string, string> = {
      "7.1": "7.1.3",
      "7.0": "7.0.1",
      "6.5": "6.5.4.15",
    };

    for (const advisory of advisories) {
      for (const prod of advisory.affectedProducts) {
        if (product && !prod.product.toLowerCase().includes(product.toLowerCase())) {
          continue;
        }

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
 * Fetch SonicWall security advisories
 */
export async function fetchSonicWallAdvisories(
  cacheDir: string,
  product?: string
): Promise<VendorAdvisoryResult> {
  const fetcher = new SonicWallAdvisoryFetcher(cacheDir);
  return fetcher.fetch(product);
}
