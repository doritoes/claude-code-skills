/**
 * VMwareAdvisoryFetcher.ts - VMware Security Advisory Fetcher
 *
 * Fetches security advisories from VMware/Broadcom's official API.
 * API: https://support.broadcom.com/web/ecx/security-advisory/-/securityadvisory/getSecurityAdvisoryList
 *
 * No API key required. Returns comprehensive CVE data with fixed versions.
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

// =============================================================================
// Constants
// =============================================================================

const VMWARE_ADVISORY_API = "https://support.broadcom.com/web/ecx/security-advisory/-/securityadvisory/getSecurityAdvisoryList";
const REQUEST_TIMEOUT_MS = 30000;

// =============================================================================
// Types
// =============================================================================

export interface VMwareVulnerability {
  advisoryId: string;       // e.g., "VMSA-2025-0004"
  title: string;
  severity: "critical" | "important" | "moderate" | "low";
  cveIds: string[];
  affectedProducts: string[];
  fixedVersions: string[];
  publishedDate: string;
  url: string;
  cvssScore?: number;
}

export interface VMwareAdvisoryResult {
  vulnerabilities: VMwareVulnerability[];
  msv: Record<string, string>;  // product -> minimum safe version
  lastUpdated: string;
  source: string;
}

interface CacheEntry {
  data: VMwareAdvisoryResult;
  expiresAt: string;
}

// Raw API response types
interface VMwareApiResponse {
  totalRecords?: number;
  advisoryList?: VMwareApiAdvisory[];
}

interface VMwareApiAdvisory {
  advisoryId?: string;
  advisoryTitle?: string;
  severity?: string;
  cveIds?: string;           // Comma-separated CVE list
  affectedProducts?: string; // Comma-separated product list
  fixedVersions?: string;
  publishedDate?: string;
  modifiedDate?: string;
  cvssScore?: number;
  segment?: string;
}

// =============================================================================
// VMware Product Segments
// =============================================================================

const VMWARE_SEGMENTS: Record<string, string> = {
  "esxi": "VC",
  "vcenter": "VC",
  "cloud_foundation": "VC",
  "workstation": "WS",
  "fusion": "FU",
  "nsx": "NS",
  "horizon": "HZ",
  "aria": "AR",
  "tanzu": "TZ",
  "vrealize": "VR",
  "vsphere": "VC",
};

// =============================================================================
// VMware Advisory Fetcher
// =============================================================================

export class VMwareAdvisoryFetcher {
  private cacheDir: string;
  private cacheDurationMs = 4 * 60 * 60 * 1000; // 4 hours
  private segment: string;
  private product: string;

  constructor(cacheDir: string, product: string = "esxi") {
    this.cacheDir = cacheDir;
    this.product = product.toLowerCase();
    this.segment = VMWARE_SEGMENTS[this.product] || "VC";
    if (!existsSync(cacheDir)) {
      mkdirSync(cacheDir, { recursive: true });
    }
  }

  /**
   * Fetch all VMware vulnerabilities for a product segment
   */
  async fetch(): Promise<VMwareAdvisoryResult> {
    const cacheKey = `vmware-${this.product}`;
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

    // Fetch fresh data via POST
    const response = await fetch(VMWARE_ADVISORY_API, {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "User-Agent": "MSV-Skill/1.0 (PAI Infrastructure)",
      },
      body: JSON.stringify({
        pageNumber: 0,
        pageSize: 100,
        searchVal: "",
        segment: this.segment,
        sortInfo: { column: "publishedDate", order: "desc" },
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`VMware advisory fetch error: ${response.status} ${response.statusText}`);
    }

    const rawData = await response.json() as VMwareApiResponse;
    const vulnerabilities = this.parseVulnerabilities(rawData);

    // Calculate MSV per product
    const msv = this.calculateMsv(vulnerabilities);

    const result: VMwareAdvisoryResult = {
      vulnerabilities,
      msv,
      lastUpdated: new Date().toISOString(),
      source: VMWARE_ADVISORY_API,
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
  private parseVulnerabilities(raw: VMwareApiResponse): VMwareVulnerability[] {
    const vulns: VMwareVulnerability[] = [];

    if (!raw.advisoryList) return vulns;

    for (const adv of raw.advisoryList) {
      if (!adv.advisoryId) continue;

      // Parse CVE list
      const cveIds = adv.cveIds
        ? adv.cveIds.split(",").map(c => c.trim().toUpperCase()).filter(c => c.startsWith("CVE-"))
        : [];

      // Parse affected products
      const affectedProducts = adv.affectedProducts
        ? adv.affectedProducts.split(",").map(p => p.trim())
        : [];

      // Parse fixed versions
      const fixedVersions = adv.fixedVersions
        ? adv.fixedVersions.split(",").map(v => v.trim())
        : [];

      vulns.push({
        advisoryId: adv.advisoryId,
        title: adv.advisoryTitle || "",
        severity: this.parseSeverity(adv.severity),
        cveIds,
        affectedProducts,
        fixedVersions,
        publishedDate: adv.publishedDate || "",
        url: `https://support.broadcom.com/web/ecx/support-content-notification/-/external/content/SecurityAdvisories/0/${adv.advisoryId}`,
        cvssScore: adv.cvssScore,
      });
    }

    // Sort by published date descending
    vulns.sort((a, b) => {
      const dateA = new Date(a.publishedDate).getTime() || 0;
      const dateB = new Date(b.publishedDate).getTime() || 0;
      return dateB - dateA;
    });

    return vulns;
  }

  /**
   * Parse severity string
   */
  private parseSeverity(severity?: string): VMwareVulnerability["severity"] {
    if (!severity) return "moderate";
    const lower = severity.toLowerCase();
    if (lower.includes("critical")) return "critical";
    if (lower.includes("important") || lower.includes("high")) return "important";
    if (lower.includes("moderate") || lower.includes("medium")) return "moderate";
    if (lower.includes("low")) return "low";
    return "moderate";
  }

  /**
   * Calculate minimum safe version per product
   */
  private calculateMsv(vulns: VMwareVulnerability[]): Record<string, string> {
    const productVersions = new Map<string, string[]>();

    for (const vuln of vulns) {
      for (const product of vuln.affectedProducts) {
        const productKey = this.normalizeProductName(product);
        for (const version of vuln.fixedVersions) {
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
   * Get vulnerabilities affecting a specific version
   */
  getVulnerabilitiesForVersion(version: string): VMwareVulnerability[] {
    // This would need version range logic
    return [];
  }
}

// =============================================================================
// CLI Testing
// =============================================================================

if (import.meta.main) {
  const dataDir = resolve(import.meta.dir, "..", "data");
  const fetcher = new VMwareAdvisoryFetcher(dataDir, "esxi");

  console.log("Fetching VMware security advisories...");

  try {
    const result = await fetcher.fetch();
    console.log(`\nFound ${result.vulnerabilities.length} advisories`);
    console.log(`Source: ${result.source}`);

    if (Object.keys(result.msv).length > 0) {
      console.log("\nMinimum Safe Versions:");
      for (const [product, version] of Object.entries(result.msv)) {
        console.log(`  ${product}: ${version}`);
      }
    }

    if (result.vulnerabilities.length > 0) {
      console.log("\nRecent advisories:");
      for (const vuln of result.vulnerabilities.slice(0, 5)) {
        console.log(`  ${vuln.advisoryId}: ${vuln.title}`);
        console.log(`    Severity: ${vuln.severity}, CVEs: ${vuln.cveIds.join(", ") || "N/A"}`);
      }
    }
  } catch (error) {
    console.error("Error:", error);
  }
}
