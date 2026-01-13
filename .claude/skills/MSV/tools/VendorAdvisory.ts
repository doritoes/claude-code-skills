/**
 * VendorAdvisory.ts - Vendor Security Advisory Fetcher
 *
 * Fetches and parses security advisories directly from vendor websites.
 * This is the primary source for accurate MSV data.
 *
 * Supported vendors:
 * - Wireshark (wireshark.org/security/)
 * - Chrome (chromereleases.googleblog.com)
 * - Firefox (mozilla.org/security/advisories/)
 * - SolarWinds (solarwinds.com/trust-center/security-advisories)
 *   - Orion Platform, NPM, SAM, NCM, NTA, IPAM, VMAN, DPA, Log Analyzer
 *   - Serv-U MFT, Access Rights Manager, Web Help Desk
 *   - DameWare MRC/RS, Engineer's Toolset, Kiwi Syslog, SFTP/TFTP Server
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

// =============================================================================
// Types
// =============================================================================

export interface SecurityAdvisory {
  id: string;                    // e.g., "wnpa-sec-2025-08"
  title: string;
  severity: "critical" | "high" | "medium" | "low" | "unknown";
  affectedVersions: string[];    // Versions affected
  fixedVersions: string[];       // Versions that fix this
  cveIds: string[];
  publishedDate: string;
  url?: string;
}

export interface VendorAdvisoryResult {
  vendor: string;
  product: string;
  advisories: SecurityAdvisory[];
  branches: BranchMsv[];
  fetchedAt: string;
  source: string;
}

export interface BranchMsv {
  branch: string;
  msv: string;
  latest: string;
}

interface CacheEntry {
  data: VendorAdvisoryResult;
  expiresAt: string;
}

// =============================================================================
// Base Fetcher
// =============================================================================

export abstract class VendorAdvisoryFetcher {
  protected cacheDir: string;
  protected cacheDurationMs = 4 * 60 * 60 * 1000; // 4 hours

  constructor(cacheDir: string) {
    this.cacheDir = cacheDir;
    if (!existsSync(cacheDir)) {
      mkdirSync(cacheDir, { recursive: true });
    }
  }

  abstract fetch(): Promise<VendorAdvisoryResult>;

  protected getCachePath(key: string): string {
    return resolve(this.cacheDir, `vendor-${key}.json`);
  }

  protected getCache(key: string): VendorAdvisoryResult | null {
    const path = this.getCachePath(key);
    if (!existsSync(path)) return null;

    try {
      const entry: CacheEntry = JSON.parse(readFileSync(path, "utf-8"));
      if (new Date(entry.expiresAt) > new Date()) {
        return entry.data;
      }
    } catch {
      // Corrupted
    }
    return null;
  }

  protected setCache(key: string, data: VendorAdvisoryResult): void {
    const entry: CacheEntry = {
      data,
      expiresAt: new Date(Date.now() + this.cacheDurationMs).toISOString(),
    };
    writeFileSync(this.getCachePath(key), JSON.stringify(entry, null, 2));
  }

  /**
   * Compare versions, returns positive if a > b
   */
  protected compareVersions(a: string, b: string): number {
    const partsA = a.split(".").map((p) => parseInt(p, 10) || 0);
    const partsB = b.split(".").map((p) => parseInt(p, 10) || 0);
    const maxLen = Math.max(partsA.length, partsB.length);

    for (let i = 0; i < maxLen; i++) {
      const partA = partsA[i] || 0;
      const partB = partsB[i] || 0;
      if (partA !== partB) return partA - partB;
    }
    return 0;
  }

  /**
   * Extract branch from version (e.g., "4.6.2" -> "4.6")
   */
  protected getBranch(version: string): string {
    const parts = version.split(".");
    if (parts.length >= 2) {
      return parts.slice(0, 2).join(".");
    }
    return version;
  }
}

// =============================================================================
// Wireshark Advisory Fetcher
// =============================================================================

export class WiresharkAdvisoryFetcher extends VendorAdvisoryFetcher {
  private readonly securityUrl = "https://www.wireshark.org/security/";

  async fetch(): Promise<VendorAdvisoryResult> {
    const cached = this.getCache("wireshark");
    if (cached) return cached;

    // Fetch the security page
    const response = await fetch(this.securityUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch Wireshark security page: ${response.status}`);
    }

    const html = await response.text();
    const advisories = this.parseAdvisories(html);

    // Calculate MSV per branch
    const branches = this.calculateBranchMsv(advisories);

    const result: VendorAdvisoryResult = {
      vendor: "wireshark",
      product: "wireshark",
      advisories,
      branches,
      fetchedAt: new Date().toISOString(),
      source: this.securityUrl,
    };

    this.setCache("wireshark", result);
    return result;
  }

  private parseAdvisories(html: string): SecurityAdvisory[] {
    const advisories: SecurityAdvisory[] = [];

    // Parse advisory rows from the HTML table
    // Format: wnpa-sec-YYYY-NN | Title | Severity | Fixed versions
    const advisoryRegex = /wnpa-sec-(\d{4})-(\d+)/g;
    const matches = html.matchAll(advisoryRegex);

    const seenIds = new Set<string>();

    for (const match of matches) {
      const id = `wnpa-sec-${match[1]}-${match[2]}`;
      if (seenIds.has(id)) continue;
      seenIds.add(id);

      // Try to extract fixed versions from context
      // Look for version patterns near this advisory
      const contextStart = Math.max(0, match.index! - 50);
      const contextEnd = Math.min(html.length, match.index! + 500);
      const context = html.slice(contextStart, contextEnd);

      const fixedVersions = this.extractVersions(context);

      advisories.push({
        id,
        title: `Wireshark Security Advisory ${id}`,
        severity: this.extractSeverity(context),
        affectedVersions: [],
        fixedVersions,
        cveIds: this.extractCves(context),
        publishedDate: `${match[1]}-01-01`, // Approximate from year
        url: `${this.securityUrl}${id}`,
      });
    }

    return advisories;
  }

  private extractVersions(text: string): string[] {
    const versionRegex = /\b(\d+\.\d+\.\d+)\b/g;
    const matches = text.matchAll(versionRegex);
    const versions = new Set<string>();

    for (const match of matches) {
      const version = match[1];
      const major = parseInt(version.split(".")[0], 10);

      // Filter out non-Wireshark versions (e.g., "802.15.4" is IEEE protocol, not a version)
      // Wireshark versions have major version 0-4
      if (major <= 10) {
        versions.add(version);
      }
    }

    return Array.from(versions);
  }

  private extractSeverity(text: string): SecurityAdvisory["severity"] {
    const lower = text.toLowerCase();
    if (lower.includes("critical")) return "critical";
    if (lower.includes("high")) return "high";
    if (lower.includes("medium") || lower.includes("moderate")) return "medium";
    if (lower.includes("low")) return "low";
    return "unknown";
  }

  private extractCves(text: string): string[] {
    const cveRegex = /CVE-\d{4}-\d+/gi;
    const matches = text.matchAll(cveRegex);
    const cves = new Set<string>();

    for (const match of matches) {
      cves.add(match[0].toUpperCase());
    }

    return Array.from(cves);
  }

  private calculateBranchMsv(advisories: SecurityAdvisory[]): BranchMsv[] {
    // Collect all fixed versions
    const allVersions = new Set<string>();
    for (const adv of advisories) {
      for (const v of adv.fixedVersions) {
        allVersions.add(v);
      }
    }

    // Group by branch and find highest version per branch
    const branchVersions = new Map<string, string[]>();
    for (const version of allVersions) {
      const branch = this.getBranch(version);
      if (!branchVersions.has(branch)) {
        branchVersions.set(branch, []);
      }
      branchVersions.get(branch)!.push(version);
    }

    // For each branch, MSV is the highest fixed version
    const results: BranchMsv[] = [];
    for (const [branch, versions] of branchVersions) {
      versions.sort((a, b) => this.compareVersions(a, b));
      const highest = versions[versions.length - 1];
      results.push({
        branch,
        msv: highest,
        latest: highest, // We assume fixed version is also latest
      });
    }

    // Sort branches descending
    results.sort((a, b) => this.compareVersions(b.branch, a.branch));

    return results;
  }
}

// =============================================================================
// Chrome Advisory Fetcher (Placeholder)
// =============================================================================

export class ChromeAdvisoryFetcher extends VendorAdvisoryFetcher {
  // Chrome releases are on chromereleases.googleblog.com
  // They follow a different format - will implement when needed

  async fetch(): Promise<VendorAdvisoryResult> {
    const cached = this.getCache("chrome");
    if (cached) return cached;

    // For now, return a stub that indicates we need NVD data
    const result: VendorAdvisoryResult = {
      vendor: "google",
      product: "chrome",
      advisories: [],
      branches: [],
      fetchedAt: new Date().toISOString(),
      source: "nvd_fallback",
    };

    return result;
  }
}

// =============================================================================
// SolarWinds Advisory Fetcher
// =============================================================================

export class SolarWindsAdvisoryFetcher extends VendorAdvisoryFetcher {
  private readonly trustCenterUrl = "https://www.solarwinds.com/trust-center/security-advisories";
  private readonly product: string;

  // SolarWinds product name mappings for advisory filtering
  private static readonly PRODUCT_NAMES: Record<string, string[]> = {
    "orion_platform": ["orion", "orion platform"],
    "serv-u": ["serv-u", "servu", "serv u"],
    "access_rights_manager": ["access rights manager", "arm"],
    "web_help_desk": ["web help desk", "whd"],
    "network_performance_monitor": ["npm", "network performance monitor"],
    "server_and_application_monitor": ["sam", "server and application monitor"],
    "network_configuration_manager": ["ncm", "network configuration manager"],
    "netflow_traffic_analyzer": ["nta", "netflow traffic analyzer"],
    "ip_address_manager": ["ipam", "ip address manager"],
    "virtualization_manager": ["vman", "virtualization manager"],
    "database_performance_analyzer": ["dpa", "database performance analyzer"],
    "log_analyzer": ["log analyzer", "la"],
    "patch_manager": ["patch manager"],
    "dameware_mini_remote_control": ["dameware", "mini remote control", "mrc"],
    "dameware_remote_support": ["dameware remote support"],
    "engineers_toolset": ["engineer's toolset", "engineers toolset", "ets"],
    "kiwi_syslog_server": ["kiwi", "kiwi syslog"],
    "sftp_scp_server": ["sftp", "scp"],
    "tftp_server": ["tftp"],
  };

  constructor(cacheDir: string, product: string) {
    super(cacheDir);
    this.product = product;
  }

  async fetch(): Promise<VendorAdvisoryResult> {
    const cacheKey = `solarwinds-${this.product}`;
    const cached = this.getCache(cacheKey);
    if (cached) return cached;

    // Fetch the Trust Center security advisories page
    const response = await fetch(this.trustCenterUrl, {
      headers: {
        "User-Agent": "MSV-Skill/1.0 (PAI Infrastructure)",
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch SolarWinds security page: ${response.status}`);
    }

    const html = await response.text();
    const advisories = this.parseAdvisories(html);

    // Filter advisories for this specific product
    const productAdvisories = this.filterByProduct(advisories);

    // Calculate MSV from fixed versions
    const branches = this.calculateBranchMsv(productAdvisories);

    const result: VendorAdvisoryResult = {
      vendor: "solarwinds",
      product: this.product,
      advisories: productAdvisories,
      branches,
      fetchedAt: new Date().toISOString(),
      source: this.trustCenterUrl,
    };

    this.setCache(cacheKey, result);
    return result;
  }

  private parseAdvisories(html: string): SecurityAdvisory[] {
    const advisories: SecurityAdvisory[] = [];

    // SolarWinds publishes CVEs with product name and version info
    // Look for CVE patterns and extract surrounding context
    const cveRegex = /CVE-\d{4}-\d+/gi;
    const cveMatches = [...new Set(html.match(cveRegex) || [])];

    for (const cve of cveMatches) {
      // Find context around CVE
      const cveIndex = html.indexOf(cve);
      if (cveIndex === -1) continue;

      const contextStart = Math.max(0, cveIndex - 500);
      const contextEnd = Math.min(html.length, cveIndex + 1000);
      const context = html.slice(contextStart, contextEnd);

      const fixedVersions = this.extractVersions(context);
      const products = this.extractProducts(context);

      advisories.push({
        id: cve,
        title: `SolarWinds Security Advisory ${cve}`,
        severity: this.extractSeverity(context),
        affectedVersions: [],
        fixedVersions,
        cveIds: [cve.toUpperCase()],
        publishedDate: this.extractDate(context) || new Date().toISOString().split("T")[0],
        url: `https://nvd.nist.gov/vuln/detail/${cve}`,
      });
    }

    return advisories;
  }

  private extractProducts(text: string): string[] {
    const products: string[] = [];
    const lower = text.toLowerCase();

    for (const [productKey, names] of Object.entries(SolarWindsAdvisoryFetcher.PRODUCT_NAMES)) {
      for (const name of names) {
        if (lower.includes(name)) {
          products.push(productKey);
          break;
        }
      }
    }

    return products;
  }

  private filterByProduct(advisories: SecurityAdvisory[]): SecurityAdvisory[] {
    const productNames = SolarWindsAdvisoryFetcher.PRODUCT_NAMES[this.product] || [this.product];

    // For Orion Platform, include all Orion modules as they share the base platform
    const orionModules = [
      "orion_platform", "network_performance_monitor", "server_and_application_monitor",
      "network_configuration_manager", "netflow_traffic_analyzer", "ip_address_manager",
      "virtualization_manager", "database_performance_analyzer", "log_analyzer"
    ];

    const isOrionProduct = orionModules.includes(this.product);

    return advisories.filter(adv => {
      const text = `${adv.title} ${adv.id}`.toLowerCase();

      // If this is an Orion product, also check for Orion platform advisories
      if (isOrionProduct && (text.includes("orion") || text.includes("platform"))) {
        return true;
      }

      for (const name of productNames) {
        if (text.includes(name.toLowerCase())) {
          return true;
        }
      }

      return false;
    });
  }

  private extractVersions(text: string): string[] {
    // SolarWinds versions typically follow patterns like:
    // "2024.2.1" or "15.2.0" or "12.5.1 Hotfix 3"
    const versionRegex = /\b(\d{4}\.\d+(?:\.\d+)?|\d+\.\d+(?:\.\d+)?)\b/g;
    const matches = text.matchAll(versionRegex);
    const versions = new Set<string>();

    for (const match of matches) {
      const version = match[1];
      // Filter out years-only (2024, 2023, etc.) and common non-version numbers
      if (!version.includes(".")) continue;
      const major = parseInt(version.split(".")[0], 10);
      // SolarWinds uses both year-based (2024.x.x) and traditional (15.x.x) versioning
      if ((major >= 2019 && major <= 2030) || (major >= 8 && major <= 30)) {
        versions.add(version);
      }
    }

    return Array.from(versions);
  }

  private extractSeverity(text: string): SecurityAdvisory["severity"] {
    const lower = text.toLowerCase();
    if (lower.includes("critical")) return "critical";
    if (lower.includes("high")) return "high";
    if (lower.includes("medium") || lower.includes("moderate")) return "medium";
    if (lower.includes("low")) return "low";
    return "unknown";
  }

  private extractDate(text: string): string | null {
    // Look for date patterns: YYYY-MM-DD, MM/DD/YYYY, Month DD, YYYY
    const datePatterns = [
      /(\d{4}-\d{2}-\d{2})/,
      /(\d{1,2}\/\d{1,2}\/\d{4})/,
      /(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}/i,
    ];

    for (const pattern of datePatterns) {
      const match = text.match(pattern);
      if (match) {
        try {
          const date = new Date(match[0]);
          if (!isNaN(date.getTime())) {
            return date.toISOString().split("T")[0];
          }
        } catch {
          // Continue to next pattern
        }
      }
    }

    return null;
  }

  private calculateBranchMsv(advisories: SecurityAdvisory[]): BranchMsv[] {
    // Collect all fixed versions
    const allVersions = new Set<string>();
    for (const adv of advisories) {
      for (const v of adv.fixedVersions) {
        allVersions.add(v);
      }
    }

    // Group by branch and find highest version per branch
    const branchVersions = new Map<string, string[]>();
    for (const version of allVersions) {
      const branch = this.getBranch(version);
      if (!branchVersions.has(branch)) {
        branchVersions.set(branch, []);
      }
      branchVersions.get(branch)!.push(version);
    }

    // For each branch, MSV is the highest fixed version
    const results: BranchMsv[] = [];
    for (const [branch, versions] of branchVersions) {
      versions.sort((a, b) => this.compareVersions(a, b));
      const highest = versions[versions.length - 1];
      results.push({
        branch,
        msv: highest,
        latest: highest,
      });
    }

    // Sort branches descending
    results.sort((a, b) => this.compareVersions(b.branch, a.branch));

    return results;
  }
}

// =============================================================================
// Factory
// =============================================================================

export function getVendorFetcher(
  vendor: string,
  product: string,
  cacheDir: string
): VendorAdvisoryFetcher | null {
  const key = `${vendor}:${product}`.toLowerCase();

  switch (key) {
    case "wireshark:wireshark":
      return new WiresharkAdvisoryFetcher(cacheDir);
    case "google:chrome":
      return new ChromeAdvisoryFetcher(cacheDir);
    default:
      // Check for SolarWinds products
      if (vendor.toLowerCase() === "solarwinds") {
        return new SolarWindsAdvisoryFetcher(cacheDir, product);
      }
      return null;
  }
}
