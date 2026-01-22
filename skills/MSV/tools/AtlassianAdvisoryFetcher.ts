/**
 * AtlassianAdvisoryFetcher.ts - Atlassian Security Advisory Fetcher
 *
 * Fetches security advisories from Atlassian's Security Vulnerability API.
 * API: https://api.atlassian.com/vuln-transparency/v1/cves
 *
 * No API key required. Returns CVE data for Jira, Confluence, Bamboo, etc.
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

// =============================================================================
// Constants
// =============================================================================

const ATLASSIAN_CVE_API = "https://api.atlassian.com/vuln-transparency/v1/cves";
const REQUEST_TIMEOUT_MS = 30000;

// =============================================================================
// Types
// =============================================================================

export interface AtlassianVulnerability {
  cveId: string;
  summary: string;
  details: string;
  severity: "critical" | "high" | "medium" | "low";
  cvssVector?: string;
  cvssScore?: number;
  publishDate: string;
  affectedProducts: AtlassianAffectedProduct[];
  advisoryUrl: string;
  trackingUrl?: string;
}

export interface AtlassianAffectedProduct {
  productName: string;
  affectedVersions: string[];
  fixedVersions: string[];
}

export interface AtlassianAdvisoryResult {
  vulnerabilities: AtlassianVulnerability[];
  msvByProduct: Record<string, string>;  // product -> minimum safe version
  lastUpdated: string;
  source: string;
}

interface CacheEntry {
  data: AtlassianAdvisoryResult;
  expiresAt: string;
}

// Raw API response types
interface AtlassianApiResponse {
  data?: AtlassianApiCve[];
  meta?: {
    total?: number;
    page?: number;
    pageSize?: number;
  };
}

interface AtlassianApiCve {
  cve_id?: string;
  cve_summary?: string;
  cve_details?: string;
  cve_vector?: string;
  cve_publish_date?: string;
  cve_severity?: string;
  advisory_url?: string;
  atl_tracking_url?: string;
  affected_products?: AtlassianApiProduct[];
}

interface AtlassianApiProduct {
  product_name?: string;
  affected_versions?: string[];
  fixed_versions?: string[];
}

// =============================================================================
// Atlassian Product Mappings
// =============================================================================

const ATLASSIAN_PRODUCTS: Record<string, string[]> = {
  "jira": ["Jira Software", "Jira Core", "Jira"],
  "jira_service_management": ["Jira Service Management", "Jira Service Desk"],
  "confluence": ["Confluence", "Confluence Server", "Confluence Data Center"],
  "bamboo": ["Bamboo"],
  "bitbucket": ["Bitbucket", "Bitbucket Server", "Bitbucket Data Center"],
  "crowd": ["Crowd"],
  "fisheye": ["Fisheye"],
  "crucible": ["Crucible"],
  "sourcetree": ["Sourcetree"],
};

// =============================================================================
// Atlassian Advisory Fetcher
// =============================================================================

export class AtlassianAdvisoryFetcher {
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
   * Fetch all Atlassian vulnerabilities
   */
  async fetch(): Promise<AtlassianAdvisoryResult> {
    const cacheKey = `atlassian-${this.product}`;
    const cachePath = resolve(this.cacheDir, `${cacheKey}.json`);

    // Check cache
    if (existsSync(cachePath)) {
      try {
        const entry: CacheEntry = JSON.parse(readFileSync(cachePath, "utf-8"));
        if (new Date(entry.expiresAt) > new Date()) {
          return entry.data;
        }
      } catch {
        // Corrupted cache
      }
    }

    // Fetch fresh data
    const allVulns: AtlassianVulnerability[] = [];
    let page = 1;
    const pageSize = 100;
    let hasMore = true;

    while (hasMore) {
      const url = `${ATLASSIAN_CVE_API}?page=${page}&pageSize=${pageSize}`;
      const response = await fetch(url, {
        headers: {
          "Accept": "application/json",
          "User-Agent": "MSV-Skill/1.0 (PAI Infrastructure)",
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        throw new Error(`Atlassian advisory fetch error: ${response.status} ${response.statusText}`);
      }

      const rawData = await response.json() as AtlassianApiResponse;
      const vulns = this.parseVulnerabilities(rawData);
      allVulns.push(...vulns);

      // Check if there are more pages
      const total = rawData.meta?.total || 0;
      hasMore = page * pageSize < total;
      page++;

      // Safety limit
      if (page > 20) break;
    }

    // Filter by product if specified
    const filteredVulns = this.product === "all"
      ? allVulns
      : this.filterByProduct(allVulns);

    // Calculate MSV per product
    const msvByProduct = this.calculateMsv(filteredVulns);

    const result: AtlassianAdvisoryResult = {
      vulnerabilities: filteredVulns,
      msvByProduct,
      lastUpdated: new Date().toISOString(),
      source: ATLASSIAN_CVE_API,
    };

    // Cache result
    const entry: CacheEntry = {
      data: result,
      expiresAt: new Date(Date.now() + this.cacheDurationMs).toISOString(),
    };
    writeFileSync(cachePath, JSON.stringify(entry, null, 2));

    return result;
  }

  /**
   * Parse raw API response
   */
  private parseVulnerabilities(raw: AtlassianApiResponse): AtlassianVulnerability[] {
    const vulns: AtlassianVulnerability[] = [];

    if (!raw.data) return vulns;

    for (const cve of raw.data) {
      if (!cve.cve_id) continue;

      // Parse affected products
      const affectedProducts: AtlassianAffectedProduct[] = [];
      if (cve.affected_products) {
        for (const prod of cve.affected_products) {
          affectedProducts.push({
            productName: prod.product_name || "",
            affectedVersions: prod.affected_versions || [],
            fixedVersions: prod.fixed_versions || [],
          });
        }
      }

      // Extract CVSS score from vector if present
      let cvssScore: number | undefined;
      if (cve.cve_vector) {
        const scoreMatch = cve.cve_vector.match(/CVSS:[\d.]+\/.*?(\d+\.\d+)/);
        if (scoreMatch) {
          cvssScore = parseFloat(scoreMatch[1]);
        }
      }

      vulns.push({
        cveId: cve.cve_id.toUpperCase(),
        summary: cve.cve_summary || "",
        details: cve.cve_details || "",
        severity: this.parseSeverity(cve.cve_severity),
        cvssVector: cve.cve_vector,
        cvssScore,
        publishDate: cve.cve_publish_date || "",
        affectedProducts,
        advisoryUrl: cve.advisory_url || "",
        trackingUrl: cve.atl_tracking_url,
      });
    }

    // Sort by publish date descending
    vulns.sort((a, b) => {
      const dateA = new Date(a.publishDate).getTime() || 0;
      const dateB = new Date(b.publishDate).getTime() || 0;
      return dateB - dateA;
    });

    return vulns;
  }

  /**
   * Parse severity string
   */
  private parseSeverity(severity?: string): AtlassianVulnerability["severity"] {
    if (!severity) return "medium";
    const lower = severity.toLowerCase();
    if (lower.includes("critical")) return "critical";
    if (lower.includes("high")) return "high";
    if (lower.includes("medium") || lower.includes("moderate")) return "medium";
    if (lower.includes("low")) return "low";
    return "medium";
  }

  /**
   * Filter vulnerabilities by product
   */
  private filterByProduct(vulns: AtlassianVulnerability[]): AtlassianVulnerability[] {
    const productNames = ATLASSIAN_PRODUCTS[this.product] || [this.product];

    return vulns.filter(vuln => {
      return vuln.affectedProducts.some(prod => {
        const prodLower = prod.productName.toLowerCase();
        return productNames.some(name => prodLower.includes(name.toLowerCase()));
      });
    });
  }

  /**
   * Calculate minimum safe version per product
   */
  private calculateMsv(vulns: AtlassianVulnerability[]): Record<string, string> {
    const productVersions = new Map<string, string[]>();

    for (const vuln of vulns) {
      for (const product of vuln.affectedProducts) {
        const productKey = this.normalizeProductName(product.productName);
        for (const version of product.fixedVersions) {
          if (!productVersions.has(productKey)) {
            productVersions.set(productKey, []);
          }
          productVersions.get(productKey)!.push(version);
        }
      }
    }

    const msv: Record<string, string> = {};
    for (const [product, versions] of productVersions) {
      // Sort versions and get highest
      versions.sort((a, b) => this.compareVersions(a, b));
      if (versions.length > 0) {
        msv[product] = versions[versions.length - 1];
      }
    }

    return msv;
  }

  /**
   * Normalize product name
   */
  private normalizeProductName(name: string): string {
    return name
      .toLowerCase()
      .replace(/\s+(server|data center|cloud)$/i, "")
      .replace(/[^a-z0-9]/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_|_$/g, "");
  }

  /**
   * Compare version strings
   */
  private compareVersions(a: string, b: string): number {
    if (!a || !b) return 0;

    // Extract numeric parts
    const partsA = a.match(/\d+/g)?.map(Number) || [];
    const partsB = b.match(/\d+/g)?.map(Number) || [];
    const maxLen = Math.max(partsA.length, partsB.length);

    for (let i = 0; i < maxLen; i++) {
      const partA = partsA[i] || 0;
      const partB = partsB[i] || 0;
      if (partA !== partB) return partA - partB;
    }
    return 0;
  }

  /**
   * Get fixed version for a specific product
   */
  getMsvForProduct(productName: string, vulns: AtlassianVulnerability[]): string | null {
    const versions: string[] = [];

    for (const vuln of vulns) {
      for (const product of vuln.affectedProducts) {
        if (product.productName.toLowerCase().includes(productName.toLowerCase())) {
          versions.push(...product.fixedVersions);
        }
      }
    }

    if (versions.length === 0) return null;

    versions.sort((a, b) => this.compareVersions(a, b));
    return versions[versions.length - 1];
  }
}

// =============================================================================
// CLI Testing
// =============================================================================

if (import.meta.main) {
  const dataDir = resolve(import.meta.dir, "..", "data");
  const product = process.argv[2] || "all";
  const fetcher = new AtlassianAdvisoryFetcher(dataDir, product);

  console.log(`Fetching Atlassian security advisories for: ${product}...`);

  try {
    const result = await fetcher.fetch();
    console.log(`\nFound ${result.vulnerabilities.length} vulnerabilities`);
    console.log(`Source: ${result.source}`);

    if (Object.keys(result.msvByProduct).length > 0) {
      console.log("\nMinimum Safe Versions:");
      for (const [prod, version] of Object.entries(result.msvByProduct)) {
        console.log(`  ${prod}: ${version}`);
      }
    }

    if (result.vulnerabilities.length > 0) {
      console.log("\nRecent vulnerabilities:");
      for (const vuln of result.vulnerabilities.slice(0, 5)) {
        console.log(`  ${vuln.cveId}: ${vuln.summary.slice(0, 60)}...`);
        console.log(`    Severity: ${vuln.severity}, Products: ${vuln.affectedProducts.map(p => p.productName).join(", ")}`);
      }
    }
  } catch (error) {
    console.error("Error:", error);
  }
}
