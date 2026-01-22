/**
 * VendorAdvisory.ts - Vendor Security Advisory Fetcher
 *
 * Fetches and parses security advisories directly from vendor websites.
 * This is the primary source for accurate MSV data.
 *
 * Supported vendors:
 * - curl (curl.se/docs/vuln.json) - A2 rating, JSON API
 * - Microsoft MSRC (api.msrc.microsoft.com) - A2 rating, JSON API
 *   - Edge, Office, Teams, .NET, Visual Studio, Exchange, SharePoint
 * - Wireshark (wireshark.org/security/)
 * - Chrome (chromereleases.googleblog.com) - stub, falls back to NVD
 * - Firefox/Mozilla (mozilla.org/security/advisories/)
 * - Apache Tomcat (tomcat.apache.org/security-*)
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
// Constants
// =============================================================================

const REQUEST_TIMEOUT_MS = 30000; // 30 seconds

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
    const response = await fetch(this.securityUrl, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Wireshark advisory error: fetch failed (${response.status})`);
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
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`SolarWinds advisory error: fetch failed (${response.status})`);
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
// Apache Tomcat Advisory Fetcher
// =============================================================================

export class TomcatAdvisoryFetcher extends VendorAdvisoryFetcher {
  // Active Tomcat branches - 9.0, 10.1, and 11.0
  private readonly branches = ["9", "10", "11"];
  private readonly securityBaseUrl = "https://tomcat.apache.org/security";

  async fetch(): Promise<VendorAdvisoryResult> {
    const cached = this.getCache("tomcat");
    if (cached) return cached;

    const allAdvisories: SecurityAdvisory[] = [];
    const branchMsvs: BranchMsv[] = [];

    // Fetch security pages for each active branch
    for (const branch of this.branches) {
      try {
        const url = `${this.securityBaseUrl}-${branch}.html`;
        const response = await fetch(url, {
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });

        if (!response.ok) {
          continue;
        }

        const html = await response.text();
        const { advisories, msv, latest } = this.parseBranchPage(html, branch);

        allAdvisories.push(...advisories);

        if (msv) {
          branchMsvs.push({
            branch: `${branch}.x`,
            msv,
            latest: latest || msv,
          });
        }
      } catch {
        // Branch page may not exist or network error
      }
    }

    // Sort branches descending
    branchMsvs.sort((a, b) => this.compareVersions(b.branch, a.branch));

    const result: VendorAdvisoryResult = {
      vendor: "apache",
      product: "tomcat",
      advisories: allAdvisories,
      branches: branchMsvs,
      fetchedAt: new Date().toISOString(),
      source: this.securityBaseUrl,
    };

    this.setCache("tomcat", result);
    return result;
  }

  private parseBranchPage(html: string, branch: string): {
    advisories: SecurityAdvisory[];
    msv: string | null;
    latest: string | null;
  } {
    const advisories: SecurityAdvisory[] = [];
    const fixedVersions = new Set<string>();

    // Extract CVEs from the page
    // Tomcat security pages have CVE IDs with associated fixed versions
    const cvePattern = /CVE-\d{4}-\d+/gi;
    const cveMatches = [...new Set(html.match(cvePattern) || [])];

    for (const cve of cveMatches) {
      const cveIndex = html.indexOf(cve);
      if (cveIndex === -1) continue;

      // Extract context around the CVE
      const contextStart = Math.max(0, cveIndex - 200);
      const contextEnd = Math.min(html.length, cveIndex + 800);
      const context = html.slice(contextStart, contextEnd);

      // Look for "Fixed in" pattern - Tomcat uses this consistently
      const fixedMatch = context.match(/Fixed in Apache Tomcat (\d+\.\d+\.\d+)/i);
      const fixedVersion = fixedMatch ? fixedMatch[1] : null;

      if (fixedVersion && fixedVersion.startsWith(branch)) {
        fixedVersions.add(fixedVersion);
      }

      // Extract severity if present
      const severity = this.extractSeverity(context);

      advisories.push({
        id: cve.toUpperCase(),
        title: `Apache Tomcat Security Advisory ${cve}`,
        severity,
        affectedVersions: [],
        fixedVersions: fixedVersion ? [fixedVersion] : [],
        cveIds: [cve.toUpperCase()],
        publishedDate: this.extractDate(context) || new Date().toISOString().split("T")[0],
        url: `https://nvd.nist.gov/vuln/detail/${cve}`,
      });
    }

    // Calculate MSV for this branch - highest fixed version
    let msv: string | null = null;
    let latest: string | null = null;

    if (fixedVersions.size > 0) {
      const versions = Array.from(fixedVersions).sort((a, b) =>
        this.compareVersions(a, b)
      );
      msv = versions[versions.length - 1]; // Highest fixed version
      latest = msv;
    }

    // Try to find the latest version mentioned on the page
    const latestMatch = html.match(
      new RegExp(`(${branch}\\.\\d+\\.\\d+)`, "g")
    );
    if (latestMatch && latestMatch.length > 0) {
      const allVersions = [...new Set(latestMatch)].sort((a, b) =>
        this.compareVersions(a, b)
      );
      latest = allVersions[allVersions.length - 1];
    }

    return { advisories, msv, latest };
  }

  private extractSeverity(text: string): SecurityAdvisory["severity"] {
    const lower = text.toLowerCase();
    // Tomcat uses "Important", "Moderate", "Low" severity ratings
    if (lower.includes("important") || lower.includes("critical")) return "high";
    if (lower.includes("moderate") || lower.includes("medium")) return "medium";
    if (lower.includes("low")) return "low";
    return "unknown";
  }

  private extractDate(text: string): string | null {
    // Look for date patterns like "1 January 2024" or "January 1, 2024"
    const datePatterns = [
      /(\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4})/i,
      /((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4})/i,
      /(\d{4}-\d{2}-\d{2})/,
    ];

    for (const pattern of datePatterns) {
      const match = text.match(pattern);
      if (match) {
        try {
          const date = new Date(match[1]);
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
}

// =============================================================================
// curl Advisory Fetcher (Wrapper)
// =============================================================================

import { CurlAdvisoryFetcher as CurlFetcherCore, type CurlVulnerability } from "./CurlAdvisoryFetcher";
import { MozillaAdvisoryFetcher as MozillaFetcherCore, type MozillaAdvisory } from "./MozillaAdvisoryFetcher";

export class CurlVendorAdvisoryFetcher extends VendorAdvisoryFetcher {
  private coreFetcher: CurlFetcherCore;

  constructor(cacheDir: string) {
    super(cacheDir);
    this.coreFetcher = new CurlFetcherCore(cacheDir);
  }

  async fetch(): Promise<VendorAdvisoryResult> {
    const cached = this.getCache("curl");
    if (cached) return cached;

    const curlResult = await this.coreFetcher.fetch();

    // Convert CurlVulnerability[] to SecurityAdvisory[]
    const advisories: SecurityAdvisory[] = curlResult.vulnerabilities.map(vuln => ({
      id: vuln.id,
      title: vuln.title,
      severity: this.mapSeverity(vuln.severity),
      affectedVersions: vuln.affected_start && vuln.affected_end
        ? [`${vuln.affected_start} - ${vuln.affected_end}`]
        : [],
      fixedVersions: vuln.fixed_in ? [vuln.fixed_in] : [],
      cveIds: vuln.cve ? [vuln.cve] : [],
      publishedDate: vuln.published?.split("T")[0] || new Date().toISOString().split("T")[0],
      url: vuln.url,
    }));

    // Calculate MSV per branch
    const branches = this.calculateBranchMsv(advisories);

    const result: VendorAdvisoryResult = {
      vendor: "curl",
      product: "curl",
      advisories,
      branches,
      fetchedAt: new Date().toISOString(),
      source: "https://curl.se/docs/vuln.json",
    };

    this.setCache("curl", result);
    return result;
  }

  private mapSeverity(severity: CurlVulnerability["severity"]): SecurityAdvisory["severity"] {
    switch (severity) {
      case "Critical": return "critical";
      case "High": return "high";
      case "Medium": return "medium";
      case "Low": return "low";
      default: return "unknown";
    }
  }

  private calculateBranchMsv(advisories: SecurityAdvisory[]): BranchMsv[] {
    // Collect all fixed versions
    const allVersions = new Set<string>();
    for (const adv of advisories) {
      for (const v of adv.fixedVersions) {
        if (v && v !== "n/a") {
          allVersions.add(v);
        }
      }
    }

    // Group by major.minor branch and find highest version per branch
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
// Mozilla Advisory Fetcher (Wrapper)
// =============================================================================

export class MozillaVendorAdvisoryFetcher extends VendorAdvisoryFetcher {
  private coreFetcher: MozillaFetcherCore;
  private product: string;

  // Supported Mozilla products
  private static readonly PRODUCT_KEYS: Record<string, string> = {
    "firefox": "firefox",
    "firefox_esr": "firefox_esr",
    "thunderbird": "thunderbird",
    "thunderbird_esr": "thunderbird_esr",
  };

  constructor(cacheDir: string, product: string = "firefox") {
    super(cacheDir);
    this.product = MozillaVendorAdvisoryFetcher.PRODUCT_KEYS[product.toLowerCase()] || product;
    this.coreFetcher = new MozillaFetcherCore(cacheDir);
  }

  async fetch(): Promise<VendorAdvisoryResult> {
    const cacheKey = `mozilla-vendor-${this.product}`;
    const cached = this.getCache(cacheKey);
    if (cached) return cached;

    const mozillaResult = await this.coreFetcher.fetchProductAdvisories(this.product);

    // Convert MozillaAdvisory[] to SecurityAdvisory[]
    const advisories: SecurityAdvisory[] = [];
    for (const adv of mozillaResult.advisories) {
      // Create an advisory entry for each CVE in the MFSA
      for (const vuln of adv.vulnerabilities) {
        advisories.push({
          id: vuln.cve || adv.mfsa,
          title: vuln.title || adv.title,
          severity: this.mapImpact(vuln.impact),
          affectedVersions: [],
          fixedVersions: Array.from(adv.fixedVersions?.values() || []),
          cveIds: vuln.cve ? [vuln.cve] : [],
          publishedDate: adv.announced?.split("T")[0] || new Date().toISOString().split("T")[0],
          url: `https://www.mozilla.org/security/advisories/${adv.mfsa}/`,
        });
      }

      // If no vulnerabilities, create an entry for the MFSA itself
      if (adv.vulnerabilities.length === 0) {
        advisories.push({
          id: adv.mfsa,
          title: adv.title,
          severity: this.mapImpact(adv.impact),
          affectedVersions: [],
          fixedVersions: Array.from(adv.fixedVersions?.values() || []),
          cveIds: [],
          publishedDate: adv.announced?.split("T")[0] || new Date().toISOString().split("T")[0],
          url: `https://www.mozilla.org/security/advisories/${adv.mfsa}/`,
        });
      }
    }

    // Calculate MSV per branch
    const branches = this.calculateBranchMsv(advisories);

    const result: VendorAdvisoryResult = {
      vendor: "mozilla",
      product: this.product,
      advisories,
      branches,
      fetchedAt: new Date().toISOString(),
      source: "https://github.com/mozilla/foundation-security-advisories",
    };

    this.setCache(cacheKey, result);
    return result;
  }

  private mapImpact(impact: string): SecurityAdvisory["severity"] {
    switch (impact?.toLowerCase()) {
      case "critical": return "critical";
      case "high": return "high";
      case "moderate": return "medium";
      case "low": return "low";
      default: return "unknown";
    }
  }

  private calculateBranchMsv(advisories: SecurityAdvisory[]): BranchMsv[] {
    // Collect all fixed versions
    const allVersions = new Set<string>();
    for (const adv of advisories) {
      for (const v of adv.fixedVersions) {
        if (v) allVersions.add(v);
      }
    }

    // For Firefox, versions are typically single numbers (134, 128.6, etc.)
    // Group by major version
    const branchVersions = new Map<string, string[]>();
    for (const version of allVersions) {
      const parts = version.split(".");
      const branch = parts[0]; // Major version only
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
    results.sort((a, b) => parseInt(b.branch, 10) - parseInt(a.branch, 10));

    return results;
  }
}

// =============================================================================
// Microsoft MSRC Advisory Fetcher
// =============================================================================

import { MsrcClient, type MsrcVulnResult } from "./MsrcClient";
import { VMwareAdvisoryFetcher as VMwareFetcherCore } from "./VMwareAdvisoryFetcher";
import { AtlassianAdvisoryFetcher as AtlassianFetcherCore } from "./AtlassianAdvisoryFetcher";
import { CitrixAdvisoryFetcher as CitrixFetcherCore } from "./CitrixAdvisoryFetcher";
import { AdobeAdvisoryFetcher as AdobeFetcherCore } from "./AdobeAdvisoryFetcher";
import { OracleAdvisoryFetcher as OracleFetcherCore } from "./OracleAdvisoryFetcher";

export class MsrcAdvisoryFetcher extends VendorAdvisoryFetcher {
  private readonly productKey: string;

  // Microsoft product key mappings
  private static readonly PRODUCT_KEYS: Record<string, string> = {
    "edge_chromium": "edge",
    "edge": "edge",
    "office": "office",
    "office_365": "office",
    "microsoft_365": "office",
    "teams": "teams",
    "dotnet": "dotnet",
    "dotnet_framework": "dotnet",
    "visual_studio": "visual_studio",
    "visual_studio_code": "visual_studio_code",
    "exchange": "exchange",
    "sharepoint": "sharepoint",
  };

  constructor(cacheDir: string, product: string) {
    super(cacheDir);
    this.productKey = MsrcAdvisoryFetcher.PRODUCT_KEYS[product.toLowerCase()] || product;
  }

  async fetch(): Promise<VendorAdvisoryResult> {
    const cacheKey = `msrc-${this.productKey}`;
    const cached = this.getCache(cacheKey);
    if (cached) return cached;

    const client = new MsrcClient(this.cacheDir);
    const vulns = await client.searchByProduct(this.productKey, {
      maxMonths: 12,
      minCvss: 4.0,
    });

    // Convert MSRC results to SecurityAdvisory format
    const advisories: SecurityAdvisory[] = vulns.map(vuln => ({
      id: vuln.cveId,
      title: vuln.title,
      severity: this.mapSeverity(vuln.severity),
      affectedVersions: vuln.affectedProducts,
      fixedVersions: vuln.fixedBuild ? [vuln.fixedBuild] : [],
      cveIds: [vuln.cveId],
      publishedDate: vuln.publishedDate.split("T")[0],
      url: `https://msrc.microsoft.com/update-guide/vulnerability/${vuln.cveId}`,
    }));

    // Calculate MSV from fixed builds
    const branches = this.calculateBranchMsv(advisories);

    const result: VendorAdvisoryResult = {
      vendor: "microsoft",
      product: this.productKey,
      advisories,
      branches,
      fetchedAt: new Date().toISOString(),
      source: "https://api.msrc.microsoft.com/cvrf/v3.0",
    };

    this.setCache(cacheKey, result);
    return result;
  }

  private mapSeverity(severity: string | null): SecurityAdvisory["severity"] {
    if (!severity) return "unknown";
    const lower = severity.toLowerCase();
    if (lower.includes("critical")) return "critical";
    if (lower.includes("important") || lower.includes("high")) return "high";
    if (lower.includes("moderate") || lower.includes("medium")) return "medium";
    if (lower.includes("low")) return "low";
    return "unknown";
  }

  private calculateBranchMsv(advisories: SecurityAdvisory[]): BranchMsv[] {
    // Microsoft uses build numbers, not semantic versions
    // Group by major build prefix and find highest fix
    const buildMap = new Map<string, string[]>();

    for (const adv of advisories) {
      for (const build of adv.fixedVersions) {
        // Extract major.minor as "branch" for builds like "10.0.19041.1234"
        const parts = build.split(".");
        if (parts.length >= 2) {
          const branch = `${parts[0]}.${parts[1]}`;
          if (!buildMap.has(branch)) {
            buildMap.set(branch, []);
          }
          buildMap.get(branch)!.push(build);
        }
      }
    }

    const results: BranchMsv[] = [];
    for (const [branch, builds] of buildMap) {
      builds.sort((a, b) => this.compareVersions(a, b));
      const highest = builds[builds.length - 1];
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
// VMware Advisory Fetcher (Wrapper)
// =============================================================================

export class VMwareVendorAdvisoryFetcher extends VendorAdvisoryFetcher {
  private coreFetcher: VMwareFetcherCore;
  private product: string;

  constructor(cacheDir: string, product: string = "esxi") {
    super(cacheDir);
    this.product = product;
    this.coreFetcher = new VMwareFetcherCore(cacheDir, product);
  }

  async fetch(): Promise<VendorAdvisoryResult> {
    const cacheKey = `vmware-vendor-${this.product}`;
    const cached = this.getCache(cacheKey);
    if (cached) return cached;

    const vmwareResult = await this.coreFetcher.fetch();

    // Convert to SecurityAdvisory format
    const advisories: SecurityAdvisory[] = vmwareResult.vulnerabilities.map(vuln => ({
      id: vuln.advisoryId,
      title: vuln.title,
      severity: this.mapSeverity(vuln.severity),
      affectedVersions: vuln.affectedProducts,
      fixedVersions: vuln.fixedVersions,
      cveIds: vuln.cveIds,
      publishedDate: vuln.publishedDate.split("T")[0],
      url: vuln.url,
    }));

    // Convert MSV map to branches
    const branches: BranchMsv[] = Object.entries(vmwareResult.msv).map(([product, version]) => ({
      branch: product,
      msv: version,
      latest: version,
    }));

    const result: VendorAdvisoryResult = {
      vendor: "vmware",
      product: this.product,
      advisories,
      branches,
      fetchedAt: new Date().toISOString(),
      source: vmwareResult.source,
    };

    this.setCache(cacheKey, result);
    return result;
  }

  private mapSeverity(severity: string): SecurityAdvisory["severity"] {
    switch (severity) {
      case "critical": return "critical";
      case "important": return "high";
      case "moderate": return "medium";
      case "low": return "low";
      default: return "medium";
    }
  }
}

// =============================================================================
// Atlassian Advisory Fetcher (Wrapper)
// =============================================================================

export class AtlassianVendorAdvisoryFetcher extends VendorAdvisoryFetcher {
  private coreFetcher: AtlassianFetcherCore;
  private product: string;

  constructor(cacheDir: string, product: string = "all") {
    super(cacheDir);
    this.product = product;
    this.coreFetcher = new AtlassianFetcherCore(cacheDir, product);
  }

  async fetch(): Promise<VendorAdvisoryResult> {
    const cacheKey = `atlassian-vendor-${this.product}`;
    const cached = this.getCache(cacheKey);
    if (cached) return cached;

    const atlassianResult = await this.coreFetcher.fetch();

    // Convert to SecurityAdvisory format
    const advisories: SecurityAdvisory[] = atlassianResult.vulnerabilities.map(vuln => ({
      id: vuln.cveId,
      title: vuln.summary,
      severity: vuln.severity,
      affectedVersions: vuln.affectedProducts.flatMap(p => p.affectedVersions),
      fixedVersions: vuln.affectedProducts.flatMap(p => p.fixedVersions),
      cveIds: [vuln.cveId],
      publishedDate: vuln.publishDate.split("T")[0],
      url: vuln.advisoryUrl,
    }));

    // Convert MSV map to branches
    const branches: BranchMsv[] = Object.entries(atlassianResult.msvByProduct).map(([product, version]) => ({
      branch: product,
      msv: version,
      latest: version,
    }));

    const result: VendorAdvisoryResult = {
      vendor: "atlassian",
      product: this.product,
      advisories,
      branches,
      fetchedAt: new Date().toISOString(),
      source: atlassianResult.source,
    };

    this.setCache(cacheKey, result);
    return result;
  }
}

// =============================================================================
// Citrix Advisory Fetcher (Wrapper)
// =============================================================================

export class CitrixVendorAdvisoryFetcher extends VendorAdvisoryFetcher {
  private coreFetcher: CitrixFetcherCore;
  private product: string;

  constructor(cacheDir: string, product: string = "all") {
    super(cacheDir);
    this.product = product;
    this.coreFetcher = new CitrixFetcherCore(cacheDir, product);
  }

  async fetch(): Promise<VendorAdvisoryResult> {
    const cacheKey = `citrix-vendor-${this.product}`;
    const cached = this.getCache(cacheKey);
    if (cached) return cached;

    const citrixResult = await this.coreFetcher.fetch();

    // Convert to SecurityAdvisory format
    const advisories: SecurityAdvisory[] = citrixResult.vulnerabilities.map(vuln => ({
      id: vuln.bulletinId,
      title: vuln.title,
      severity: vuln.severity,
      affectedVersions: vuln.affectedProducts,
      fixedVersions: vuln.fixedVersions,
      cveIds: vuln.cveIds,
      publishedDate: vuln.publishedDate.split("T")[0],
      url: vuln.url,
    }));

    // Convert MSV map to branches
    const branches: BranchMsv[] = Object.entries(citrixResult.msvByProduct).map(([product, version]) => ({
      branch: product,
      msv: version,
      latest: version,
    }));

    const result: VendorAdvisoryResult = {
      vendor: "citrix",
      product: this.product,
      advisories,
      branches,
      fetchedAt: new Date().toISOString(),
      source: citrixResult.source,
    };

    this.setCache(cacheKey, result);
    return result;
  }
}

// =============================================================================
// Adobe Advisory Fetcher (Wrapper)
// =============================================================================

export class AdobeVendorAdvisoryFetcher extends VendorAdvisoryFetcher {
  private coreFetcher: AdobeFetcherCore;
  private product: string;

  constructor(cacheDir: string, product: string = "all") {
    super(cacheDir);
    this.product = product;
    this.coreFetcher = new AdobeFetcherCore(cacheDir, product);
  }

  async fetch(): Promise<VendorAdvisoryResult> {
    const cacheKey = `adobe-vendor-${this.product}`;
    const cached = this.getCache(cacheKey);
    if (cached) return cached;

    const adobeResult = await this.coreFetcher.fetch();

    // Convert to SecurityAdvisory format
    const advisories: SecurityAdvisory[] = adobeResult.vulnerabilities.map(vuln => ({
      id: vuln.bulletinId,
      title: vuln.title,
      severity: this.mapSeverity(vuln.severity),
      affectedVersions: vuln.affectedVersions,
      fixedVersions: vuln.fixedVersions,
      cveIds: vuln.cveIds,
      publishedDate: vuln.publishedDate.split("T")[0],
      url: vuln.url,
    }));

    // Convert MSV map to branches
    const branches: BranchMsv[] = Object.entries(adobeResult.msvByProduct).map(([product, version]) => ({
      branch: product,
      msv: version,
      latest: version,
    }));

    const result: VendorAdvisoryResult = {
      vendor: "adobe",
      product: this.product,
      advisories,
      branches,
      fetchedAt: new Date().toISOString(),
      source: adobeResult.source,
    };

    this.setCache(cacheKey, result);
    return result;
  }

  private mapSeverity(severity: string): SecurityAdvisory["severity"] {
    switch (severity) {
      case "critical": return "critical";
      case "important": return "high";
      case "moderate": return "medium";
      case "low": return "low";
      default: return "medium";
    }
  }
}

// =============================================================================
// Oracle Advisory Fetcher (Wrapper)
// =============================================================================

export class OracleVendorAdvisoryFetcher extends VendorAdvisoryFetcher {
  private coreFetcher: OracleFetcherCore;
  private product: string;

  constructor(cacheDir: string, product: string = "all") {
    super(cacheDir);
    this.product = product;
    this.coreFetcher = new OracleFetcherCore(cacheDir, product);
  }

  async fetch(): Promise<VendorAdvisoryResult> {
    const cacheKey = `oracle-vendor-${this.product}`;
    const cached = this.getCache(cacheKey);
    if (cached) return cached;

    const oracleResult = await this.coreFetcher.fetch();

    // Convert to SecurityAdvisory format
    const advisories: SecurityAdvisory[] = oracleResult.vulnerabilities.map(vuln => ({
      id: vuln.cveId,
      title: `${vuln.product} - ${vuln.component || vuln.cveId}`,
      severity: vuln.severity,
      affectedVersions: vuln.affectedVersions,
      fixedVersions: vuln.fixedVersions,
      cveIds: [vuln.cveId],
      publishedDate: vuln.cpuDate,
      url: vuln.url,
    }));

    // Convert MSV map to branches
    const branches: BranchMsv[] = Object.entries(oracleResult.msvByProduct).map(([product, version]) => ({
      branch: product,
      msv: version,
      latest: version,
    }));

    const result: VendorAdvisoryResult = {
      vendor: "oracle",
      product: this.product,
      advisories,
      branches,
      fetchedAt: new Date().toISOString(),
      source: oracleResult.source,
    };

    this.setCache(cacheKey, result);
    return result;
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
    case "apache:tomcat":
      return new TomcatAdvisoryFetcher(cacheDir);
    case "curl:curl":
    case "haxx:curl":
      return new CurlVendorAdvisoryFetcher(cacheDir);
    case "mozilla:firefox":
    case "mozilla:firefox_esr":
    case "mozilla:thunderbird":
    case "mozilla:thunderbird_esr":
      return new MozillaVendorAdvisoryFetcher(cacheDir, product);
    default:
      // Check for SolarWinds products
      if (vendor.toLowerCase() === "solarwinds") {
        return new SolarWindsAdvisoryFetcher(cacheDir, product);
      }
      // Check for Microsoft products
      if (vendor.toLowerCase() === "microsoft") {
        return new MsrcAdvisoryFetcher(cacheDir, product);
      }
      // Check for Mozilla products (alternative vendor name)
      if (vendor.toLowerCase() === "mozilla") {
        return new MozillaVendorAdvisoryFetcher(cacheDir, product);
      }
      // Check for VMware/Broadcom products
      if (vendor.toLowerCase() === "vmware" || vendor.toLowerCase() === "broadcom") {
        return new VMwareVendorAdvisoryFetcher(cacheDir, product);
      }
      // Check for Atlassian products
      if (vendor.toLowerCase() === "atlassian") {
        return new AtlassianVendorAdvisoryFetcher(cacheDir, product);
      }
      // Check for Citrix/Cloud Software Group products
      if (vendor.toLowerCase() === "citrix" || vendor.toLowerCase() === "cloud_software_group") {
        return new CitrixVendorAdvisoryFetcher(cacheDir, product);
      }
      // Check for Adobe products
      if (vendor.toLowerCase() === "adobe") {
        return new AdobeVendorAdvisoryFetcher(cacheDir, product);
      }
      // Check for Oracle products
      if (vendor.toLowerCase() === "oracle") {
        return new OracleVendorAdvisoryFetcher(cacheDir, product);
      }
      // Check for Fortinet products
      if (vendor.toLowerCase() === "fortinet") {
        return new FortinetVendorAdvisoryFetcher(cacheDir, product);
      }
      // Check for Palo Alto Networks products
      if (vendor.toLowerCase() === "palo_alto" || vendor.toLowerCase() === "paloaltonetworks" || vendor.toLowerCase() === "palo alto networks") {
        return new PaloAltoVendorAdvisoryFetcher(cacheDir, product);
      }
      // Check for Cisco products
      if (vendor.toLowerCase() === "cisco") {
        return new CiscoVendorAdvisoryFetcher(cacheDir, product);
      }
      // Check for SonicWall products
      if (vendor.toLowerCase() === "sonicwall") {
        return new SonicWallVendorAdvisoryFetcher(cacheDir, product);
      }
      return null;
  }
}

// =============================================================================
// Wrapper Fetchers for New Vendors
// =============================================================================

import { FortinetAdvisoryFetcher, fetchFortinetAdvisories } from "./FortinetAdvisoryFetcher";
import { PaloAltoAdvisoryFetcher, fetchPaloAltoAdvisories } from "./PaloAltoAdvisoryFetcher";
import { CiscoAdvisoryFetcher, fetchCiscoAdvisories } from "./CiscoAdvisoryFetcher";
import { SonicWallAdvisoryFetcher, fetchSonicWallAdvisories } from "./SonicWallAdvisoryFetcher";

/**
 * Fortinet Vendor Advisory Fetcher (Wrapper)
 */
class FortinetVendorAdvisoryFetcher extends VendorAdvisoryFetcher {
  private product: string;

  constructor(cacheDir: string, product: string = "all") {
    super(cacheDir);
    this.product = product;
  }

  async fetch(): Promise<VendorAdvisoryResult> {
    return fetchFortinetAdvisories(this.cacheDir, this.product === "all" ? undefined : this.product);
  }
}

/**
 * Palo Alto Networks Vendor Advisory Fetcher (Wrapper)
 */
class PaloAltoVendorAdvisoryFetcher extends VendorAdvisoryFetcher {
  private product: string;

  constructor(cacheDir: string, product: string = "all") {
    super(cacheDir);
    this.product = product;
  }

  async fetch(): Promise<VendorAdvisoryResult> {
    return fetchPaloAltoAdvisories(this.cacheDir, this.product === "all" ? undefined : this.product);
  }
}

/**
 * Cisco Vendor Advisory Fetcher (Wrapper)
 */
class CiscoVendorAdvisoryFetcher extends VendorAdvisoryFetcher {
  private product: string;

  constructor(cacheDir: string, product: string = "all") {
    super(cacheDir);
    this.product = product;
  }

  async fetch(): Promise<VendorAdvisoryResult> {
    return fetchCiscoAdvisories(this.cacheDir, this.product === "all" ? undefined : this.product);
  }
}

/**
 * SonicWall Vendor Advisory Fetcher (Wrapper)
 */
class SonicWallVendorAdvisoryFetcher extends VendorAdvisoryFetcher {
  private product: string;

  constructor(cacheDir: string, product: string = "all") {
    super(cacheDir);
    this.product = product;
  }

  async fetch(): Promise<VendorAdvisoryResult> {
    return fetchSonicWallAdvisories(this.cacheDir, this.product === "all" ? undefined : this.product);
  }
}
