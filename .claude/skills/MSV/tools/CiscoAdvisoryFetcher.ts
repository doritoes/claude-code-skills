/**
 * CiscoAdvisoryFetcher.ts - Cisco PSIRT Security Advisory Fetcher
 *
 * Fetches security advisories from Cisco's free CSAF (Common Security
 * Advisory Framework) feed. No authentication required.
 *
 * Source: https://www.cisco.com/.well-known/csaf/
 * - changes.csv: Index of all advisories with last-modified timestamps
 * - {year}/cisco-sa-{id}.json: Individual CSAF advisory files
 *
 * Products covered:
 * - ASA (Adaptive Security Appliance)
 * - FTD (Firepower Threat Defense)
 * - FMC (Firepower Management Center)
 * - IOS, IOS XE, IOS XR
 * - NX-OS
 * - All Cisco security products
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

const CISCO_CSAF_BASE = "https://www.cisco.com/.well-known/csaf";
const CISCO_CSAF_CHANGES = `${CISCO_CSAF_BASE}/changes.csv`;
const REQUEST_TIMEOUT_MS = 30000;

// Product family keywords for filtering CSAF advisories by filename/title
const PRODUCT_KEYWORDS: Record<string, string[]> = {
  asa: ["asa", "adaptive-security"],
  ftd: ["ftd", "firepower-threat-defense", "threat-defense"],
  fmc: ["fmc", "firepower-management", "management-center"],
  ios: ["ios-"],
  ios_xe: ["ios-xe", "iosxe"],
  ios_xr: ["ios-xr", "iosxr"],
  nx_os: ["nx-os", "nxos", "nexus"],
};

// =============================================================================
// Types
// =============================================================================

export interface CiscoAdvisory {
  advisoryId: string;
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

interface CacheEntry {
  data: VendorAdvisoryResult;
  expiresAt: string;
}

// CSAF document types
interface CsafDocument {
  document?: {
    title?: string;
    tracking?: {
      id?: string;
      current_release_date?: string;
      initial_release_date?: string;
    };
    aggregate_severity?: { text?: string };
  };
  vulnerabilities?: CsafVulnerability[];
  product_tree?: {
    branches?: CsafBranch[];
    relationships?: CsafRelationship[];
  };
}

interface CsafVulnerability {
  cve?: string;
  title?: string;
  scores?: Array<{
    cvss_v3?: { baseScore?: number; baseSeverity?: string; vectorString?: string };
  }>;
  product_status?: {
    known_affected?: string[];
    fixed?: string[];
    known_not_affected?: string[];
  };
  remediations?: Array<{
    category?: string;
    product_ids?: string[];
    details?: string;
    url?: string;
  }>;
}

interface CsafBranch {
  name?: string;
  category?: string;
  product?: { product_id?: string; name?: string };
  branches?: CsafBranch[];
}

interface CsafRelationship {
  category?: string;
  full_product_name?: { name?: string; product_id?: string };
  relates_to_product_reference?: string;
  product_reference?: string;
}

// =============================================================================
// Cisco Advisory Fetcher
// =============================================================================

export class CiscoAdvisoryFetcher {
  private cacheDir: string;
  private cacheDurationMs = 4 * 60 * 60 * 1000; // 4 hours

  constructor(cacheDir: string, _clientId?: string, _clientSecret?: string) {
    this.cacheDir = cacheDir;
    if (!existsSync(cacheDir)) {
      mkdirSync(cacheDir, { recursive: true });
    }
  }

  /**
   * Fetch Cisco advisories for a product using the free CSAF feed
   */
  async fetch(product?: string): Promise<VendorAdvisoryResult> {
    const cacheKey = product ? `cisco-${product.toLowerCase().replace(/\s+/g, "-")}` : "cisco-all";
    const cached = this.getCache(cacheKey);
    if (cached) return cached;

    let advisories: CiscoAdvisory[] = [];
    let source = CISCO_CSAF_BASE;

    try {
      // Step 1: Fetch changes.csv to find recent advisories
      const recentFiles = await this.fetchRecentAdvisoryFiles(product);

      // Step 2: Fetch individual CSAF advisory files (max 10 to avoid rate limits)
      const filesToFetch = recentFiles.slice(0, 10);
      for (const file of filesToFetch) {
        try {
          const advisory = await this.fetchCsafAdvisory(file.path);
          if (advisory) {
            advisories.push(...advisory);
          }
          // Throttle requests
          if (filesToFetch.indexOf(file) < filesToFetch.length - 1) {
            await new Promise(r => setTimeout(r, 200));
          }
        } catch (err) {
          console.error(`Cisco CSAF fetch warning: ${(err as Error).message} for ${file.path}`);
        }
      }
    } catch (err) {
      console.error(`Cisco CSAF feed error: ${(err as Error).message} - using fallback data`);
      source = `${CISCO_CSAF_BASE} (fallback)`;
    }

    const securityAdvisories = this.convertToSecurityAdvisories(advisories);
    const branches = this.calculateBranchMsv(advisories, product);

    const result: VendorAdvisoryResult = {
      vendor: "Cisco",
      product: product || "All Products",
      advisories: securityAdvisories,
      branches,
      fetchedAt: new Date().toISOString(),
      source,
    };

    this.setCache(cacheKey, result);
    return result;
  }

  /**
   * Fetch changes.csv and find recent advisory files matching the product
   */
  private async fetchRecentAdvisoryFiles(product?: string): Promise<Array<{ path: string; modified: string }>> {
    const response = await fetch(CISCO_CSAF_CHANGES, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        "User-Agent": "MSV-Skill/2.0 (Security Advisory Fetcher)",
        "Accept": "text/csv",
      },
    });

    if (!response.ok) {
      throw new Error(`CSAF changes.csv error: ${response.status}`);
    }

    const csv = await response.text();
    const lines = csv.trim().split("\n");

    // Parse CSV: path,modified_date
    const entries: Array<{ path: string; modified: string }> = [];
    for (const line of lines) {
      const [path, modified] = line.split(",");
      if (!path || !modified) continue;
      entries.push({ path: path.trim(), modified: modified.trim() });
    }

    // Filter by product keywords if specified
    const productKey = this.detectProductKey(product);
    const keywords = productKey ? PRODUCT_KEYWORDS[productKey] : null;

    let filtered = entries;
    if (keywords) {
      filtered = entries.filter(e => {
        const lower = e.path.toLowerCase();
        return keywords.some(kw => lower.includes(kw));
      });
    }

    // Sort by modified date descending (most recent first)
    // entries are already sorted in changes.csv, but explicit sort ensures it
    filtered.sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime());

    // Filter to last 2 years
    const cutoff = new Date();
    cutoff.setFullYear(cutoff.getFullYear() - 2);
    filtered = filtered.filter(e => new Date(e.modified) >= cutoff);

    return filtered;
  }

  /**
   * Fetch and parse a single CSAF advisory JSON file
   */
  private async fetchCsafAdvisory(path: string): Promise<CiscoAdvisory[] | null> {
    const url = `${CISCO_CSAF_BASE}/${path}`;

    const response = await fetch(url, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        "User-Agent": "MSV-Skill/2.0 (Security Advisory Fetcher)",
        "Accept": "application/json",
      },
    });

    if (!response.ok) {
      return null;
    }

    const csaf = await response.json() as CsafDocument;
    return this.parseCsafDocument(csaf, url);
  }

  /**
   * Parse a CSAF document into CiscoAdvisory objects
   */
  private parseCsafDocument(csaf: CsafDocument, csafUrl: string): CiscoAdvisory[] {
    const doc = csaf.document || {};
    const tracking = doc.tracking || {};
    const advisoryId = tracking.id || "";
    const title = doc.title || "";

    // Build product ID -> name map from product tree
    const idMap = new Map<string, string>();
    this.walkBranches(csaf.product_tree?.branches || [], idMap);
    for (const rel of csaf.product_tree?.relationships || []) {
      const fpn = rel.full_product_name;
      if (fpn?.product_id && fpn?.name) {
        idMap.set(fpn.product_id, fpn.name);
      }
    }

    // Parse vulnerabilities
    const advisories: CiscoAdvisory[] = [];

    for (const vuln of csaf.vulnerabilities || []) {
      const cve = vuln.cve || "";
      const cvss = vuln.scores?.[0]?.cvss_v3;
      const severity = this.parseSeverity(cvss?.baseSeverity, cvss?.baseScore || undefined);

      // Extract affected and fixed product versions
      const affected = this.extractVersionsFromProductIds(
        vuln.product_status?.known_affected || [], idMap
      );
      const fixed = this.extractVersionsFromProductIds(
        vuln.remediations?.[0]?.product_ids || vuln.product_status?.fixed || [], idMap
      );

      advisories.push({
        advisoryId,
        advisoryTitle: vuln.title || title,
        cveIds: cve ? [cve] : [],
        bugIds: [],
        cvssScore: cvss?.baseScore || null,
        cvssVector: cvss?.vectorString || null,
        severity,
        publishedDate: tracking.initial_release_date || new Date().toISOString(),
        lastUpdatedDate: tracking.current_release_date || new Date().toISOString(),
        summary: vuln.title || title,
        affectedProducts: this.buildAffectedProducts(affected, fixed),
        cvrfUrl: "",
        csafUrl,
      });
    }

    return advisories;
  }

  /**
   * Walk product tree branches to build ID -> name map
   */
  private walkBranches(branches: CsafBranch[], idMap: Map<string, string>): void {
    for (const b of branches) {
      if (b.product?.product_id && b.name) {
        idMap.set(b.product.product_id, b.name);
      }
      if (b.branches) {
        this.walkBranches(b.branches, idMap);
      }
    }
  }

  /**
   * Extract version numbers from CSAF product IDs
   * Product names contain versions like "ASA Software 9.18.4" or "IOS XE 17.12.4"
   */
  private extractVersionsFromProductIds(
    productIds: string[],
    idMap: Map<string, string>
  ): Map<string, string[]> {
    const productVersions = new Map<string, string[]>();

    for (const pid of productIds) {
      // Handle composite IDs (e.g., "CSAFPID-232585:277437")
      const basePid = pid.includes(":") ? pid.split(":")[0] : pid;
      const name = idMap.get(pid) || idMap.get(basePid) || "";

      // Extract version from product name
      // Pattern: "Product Name X.Y.Z" or "Product Name X.Y"
      const versionMatch = name.match(/(\d+\.\d+(?:\.\d+)*)\s*(?:when|$)/i)
        || name.match(/\b(\d+\.\d+(?:\.\d+)*)\b/);

      if (versionMatch) {
        const version = versionMatch[1];
        // Determine product family from name
        const family = this.detectFamilyFromName(name);
        if (family) {
          if (!productVersions.has(family)) {
            productVersions.set(family, []);
          }
          const versions = productVersions.get(family)!;
          if (!versions.includes(version)) {
            versions.push(version);
          }
        }
      }
    }

    return productVersions;
  }

  /**
   * Detect product family from CSAF product name
   */
  private detectFamilyFromName(name: string): string | null {
    const lower = name.toLowerCase();
    if (lower.includes("adaptive security") || lower.includes("asa software")) return "asa";
    if (lower.includes("threat defense") || lower.includes("ftd software")) return "ftd";
    if (lower.includes("ios xe")) return "ios_xe";
    if (lower.includes("ios xr")) return "ios_xr";
    if (lower.includes("ios software") || (lower.includes("ios") && !lower.includes("ios x"))) return "ios";
    if (lower.includes("nx-os") || lower.includes("nexus")) return "nx_os";
    if (lower.includes("firepower management") || lower.includes("fmc")) return "fmc";
    return null;
  }

  /**
   * Build CiscoAffectedProduct from version maps
   */
  private buildAffectedProducts(
    affected: Map<string, string[]>,
    fixed: Map<string, string[]>
  ): CiscoAffectedProduct[] {
    const families = new Set([...affected.keys(), ...fixed.keys()]);
    const products: CiscoAffectedProduct[] = [];

    for (const family of families) {
      products.push({
        productName: family,
        affectedVersions: affected.get(family) || [],
        fixedVersions: fixed.get(family) || [],
      });
    }

    return products;
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
      publishedDate: a.publishedDate.split("T")[0],
      url: a.csafUrl || `https://sec.cloudapps.cisco.com/security/center/content/CiscoSecurityAdvisory/${a.advisoryId}`,
    }));
  }

  /**
   * Calculate MSV for each version branch
   */
  private calculateBranchMsv(advisories: CiscoAdvisory[], product?: string): BranchMsv[] {
    const branchMap = new Map<string, { msv: string; latest: string }>();

    // Known latest versions for common Cisco products (updated 2026-02-19)
    const knownLatest: Record<string, Record<string, string>> = {
      asa: {
        "9.24": "9.24.1",
        "9.23": "9.23.1",
        "9.22": "9.22.2",
        "9.20": "9.20.4",
        "9.19": "9.19.1",
        "9.18": "9.18.4",
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

    const productKey = this.detectProductKey(product);
    const versions = productKey ? (knownLatest[productKey] || {}) : {};

    // Extract MSV from CSAF advisory data
    for (const advisory of advisories) {
      for (const prod of advisory.affectedProducts) {
        // Use fixed versions to determine MSV
        for (const version of prod.fixedVersions) {
          const branch = this.getBranch(version);
          const current = branchMap.get(branch);
          if (!current || this.compareVersions(version, current.msv) > 0) {
            branchMap.set(branch, {
              msv: version,
              latest: versions[branch] || version,
            });
          }
        }

        // For affected versions without a fixed version, increment patch
        if (prod.fixedVersions.length === 0) {
          for (const version of prod.affectedVersions) {
            const branch = this.getBranch(version);
            const current = branchMap.get(branch);
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
    if (lower.includes("ftd") || lower.includes("firepower_threat_defense") || lower.includes("firepower threat defense")) return "ftd";
    if (lower.includes("ios_xe") || lower.includes("ios xe") || lower.includes("ios-xe")) return "ios_xe";
    if (lower.includes("ios_xr") || lower.includes("ios xr") || lower.includes("ios-xr")) return "ios_xr";
    if (lower.includes("nx-os") || lower.includes("nx_os") || lower.includes("nexus")) return "nx_os";

    return null;
  }

  private getBranch(version: string): string {
    const parts = version.split(".");
    if (parts.length >= 2) {
      return parts.slice(0, 2).join(".");
    }
    return version;
  }

  private incrementPatch(version: string): string {
    const parts = version.split(".").map(p => parseInt(p, 10) || 0);
    if (parts.length >= 3) {
      parts[2]++;
    } else if (parts.length === 2) {
      parts.push(1);
    }
    return parts.join(".");
  }

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
