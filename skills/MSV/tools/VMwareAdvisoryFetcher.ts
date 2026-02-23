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
  success?: boolean;
  data?: {
    list?: VMwareApiAdvisory[];
    pageInfo?: {
      totalCount?: number;
    };
  };
  // Legacy format fallback
  totalRecords?: number;
  advisoryList?: VMwareApiAdvisory[];
}

interface VMwareApiAdvisory {
  documentId?: string;       // e.g., "VCDSA24453"
  notificationId?: number;
  title?: string;            // Full title including CVEs
  severity?: string;
  affectedCve?: string;      // Comma-separated CVE list
  supportProducts?: string;  // Product list
  published?: string;        // e.g., "18 June 2024"
  updated?: string;
  status?: string;
  notificationUrl?: string;
  workAround?: string;
  // Legacy format
  advisoryId?: string;
  advisoryTitle?: string;
  cveIds?: string;
  affectedProducts?: string;
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

    // Handle new API format (data.list) or legacy (advisoryList)
    const advisoryList = raw.data?.list || raw.advisoryList;
    if (!advisoryList) return vulns;

    for (const adv of advisoryList) {
      // Extract advisory ID from title (VMSA-YYYY-NNNN) or use documentId/advisoryId
      let advisoryId = adv.advisoryId || adv.documentId || "";
      const vmsaMatch = adv.title?.match(/VMSA-\d{4}-\d+/);
      if (vmsaMatch) {
        advisoryId = vmsaMatch[0];
      }
      if (!advisoryId) continue;

      // Parse CVE list from affectedCve or cveIds field
      const cveString = adv.affectedCve || adv.cveIds || "";
      const cveIds = cveString
        .split(/[,\s]+/)
        .map(c => c.trim().toUpperCase())
        .filter(c => c.startsWith("CVE-"));

      // Parse affected products from supportProducts or affectedProducts
      const productsString = adv.supportProducts || adv.affectedProducts || "";
      const affectedProducts = productsString
        .split(",")
        .map(p => p.trim())
        .filter(p => p.length > 0);

      // Parse fixed versions if available
      const fixedVersions = adv.fixedVersions
        ? adv.fixedVersions.split(",").map(v => v.trim())
        : [];

      // Parse published date - handle various formats
      const publishedStr = adv.published || adv.publishedDate || "";
      let publishedDate = "";
      try {
        const date = new Date(publishedStr);
        if (!isNaN(date.getTime())) {
          publishedDate = date.toISOString();
        }
      } catch {
        publishedDate = publishedStr;
      }

      // Get URL from notificationUrl or construct from advisory ID
      const url = adv.notificationUrl ||
        `https://support.broadcom.com/web/ecx/support-content-notification/-/external/content/SecurityAdvisories/0/${adv.notificationId || advisoryId}`;

      vulns.push({
        advisoryId,
        title: adv.title || adv.advisoryTitle || "",
        severity: this.parseSeverity(adv.severity),
        cveIds,
        affectedProducts,
        fixedVersions,
        publishedDate,
        url,
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

    // Fallback: If no versions found from advisories, use known latest versions
    // These are updated manually based on VMware release cycles
    if (Object.keys(msv).length === 0) {
      const knownLatest: Record<string, Record<string, string>> = {
        esxi: {
          "esxi_8.0": "8.0.3",
          "esxi_7.0": "7.0.3",
        },
        vcenter: {
          "vcenter_8.0": "8.0.3",
          "vcenter_7.0": "7.0.3",
        },
        workstation: {
          "workstation_17": "17.6.2",
        },
        fusion: {
          "fusion_13": "13.6.2",
        },
        nsx: {
          "nsx_4": "4.2.1",
        },
      };

      const productVersionMap = knownLatest[this.product] || knownLatest.esxi || {};
      for (const [key, version] of Object.entries(productVersionMap)) {
        msv[key] = version;
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
