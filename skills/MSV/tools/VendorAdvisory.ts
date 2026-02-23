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

  protected setCache(key: string, data: VendorAdvisoryResult, ttlMs?: number): void {
    const entry: CacheEntry = {
      data,
      expiresAt: new Date(Date.now() + (ttlMs ?? this.cacheDurationMs)).toISOString(),
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
// Chrome Advisory Fetcher (ChromiumDash API)
// =============================================================================

export class ChromeAdvisoryFetcher extends VendorAdvisoryFetcher {
  private static readonly CHROMIUMDASH_API = "https://chromiumdash.appspot.com/fetch_releases";
  private static readonly REQUEST_TIMEOUT_MS = 15000;

  async fetch(): Promise<VendorAdvisoryResult> {
    const cached = this.getCache("chrome");
    if (cached) return cached;

    let branches: BranchMsv[] = [];
    let source = "chromiumdash.appspot.com";

    try {
      // Fetch recent Stable releases for Windows from ChromiumDash
      const url = `${ChromeAdvisoryFetcher.CHROMIUMDASH_API}?channel=Stable&platform=Windows&num=30`;
      const response = await fetch(url, {
        signal: AbortSignal.timeout(ChromeAdvisoryFetcher.REQUEST_TIMEOUT_MS),
        headers: { "Accept": "application/json" },
      });

      if (response.ok) {
        const releases = await response.json() as Array<{
          version: string;
          milestone: number;
          time: number;
        }>;

        // Group by milestone, find the latest version per milestone
        const milestoneMap = new Map<number, string>();
        for (const rel of releases) {
          const existing = milestoneMap.get(rel.milestone);
          if (!existing || this.compareVersions(rel.version, existing) > 0) {
            milestoneMap.set(rel.milestone, rel.version);
          }
        }

        // Convert to branches (latest 3 milestones)
        const milestones = [...milestoneMap.entries()]
          .sort((a, b) => b[0] - a[0])
          .slice(0, 3);

        branches = milestones.map(([milestone, version]) => ({
          branch: String(milestone),
          msv: version,
          latest: version,
        }));
      }
    } catch (err) {
      // Fail honestly — no fallback data. MSV pipeline handles missing vendor data.
      throw new Error(`Chrome advisory fetch failed: ${(err as Error).message}`);
    }

    if (branches.length === 0) {
      throw new Error("Chrome advisory fetch returned no release data from ChromiumDash API");
    }

    const result: VendorAdvisoryResult = {
      vendor: "google",
      product: "chrome",
      advisories: [],  // CVE data comes from AppThreat/NVD/CISA KEV
      branches,
      fetchedAt: new Date().toISOString(),
      source,
    };

    this.setCache("chrome", result);
    return result;
  }
}

// =============================================================================
// SolarWinds Advisory Fetcher
// =============================================================================

export class SolarWindsAdvisoryFetcher extends VendorAdvisoryFetcher {
  private readonly trustCenterUrl = "https://www.solarwinds.com/trust-center/security-advisories";
  private readonly product: string;

  // SolarWinds product name patterns for matching headlines and fixedVersion text
  private static readonly PRODUCT_PATTERNS: Record<string, string[]> = {
    "orion_platform": ["platform", "orion"],
    "serv-u": ["serv-u"],
    "access_rights_manager": ["access rights manager"],
    "web_help_desk": ["web help desk"],
    "network_performance_monitor": ["network performance monitor", "npm"],
    "server_and_application_monitor": ["server and application monitor", "sam"],
    "network_configuration_manager": ["network configuration manager", "ncm"],
    "netflow_traffic_analyzer": ["netflow traffic analyzer", "nta"],
    "ip_address_manager": ["ip address manager", "ipam"],
    "virtualization_manager": ["virtualization manager", "vman"],
    "database_performance_analyzer": ["database performance analyzer", "dpa"],
    "log_analyzer": ["log analyzer"],
    "patch_manager": ["patch manager"],
    "dameware_mini_remote_control": ["dameware mini remote control", "dameware"],
    "dameware_remote_support": ["dameware remote support"],
    "engineers_toolset": ["engineer's toolset", "engineers toolset"],
    "kiwi_syslog_server": ["kiwi syslog", "kiwi"],
    "observability": ["observability"],
  };

  constructor(cacheDir: string, product: string) {
    super(cacheDir);
    this.product = product;
  }

  async fetch(): Promise<VendorAdvisoryResult> {
    const cacheKey = `solarwinds-${this.product}`;
    const cached = this.getCache(cacheKey);
    if (cached) return cached;

    // Fetch the Trust Center page — it embeds __NEXT_DATA__ with structured advisory data
    const response = await fetch(this.trustCenterUrl, {
      headers: { "User-Agent": "MSV-Skill/1.0 (PAI Infrastructure)" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`SolarWinds advisory error: fetch failed (${response.status})`);
    }

    const html = await response.text();

    // Extract __NEXT_DATA__ JSON blob (contains structured advisory data from ContentStack CMS)
    const nextDataMatch = html.match(/__NEXT_DATA__"\s*type="application\/json">(.+?)<\/script>/);
    if (!nextDataMatch) {
      throw new Error("SolarWinds: __NEXT_DATA__ not found in page");
    }

    let pagesData: any[];
    try {
      const nextData = JSON.parse(nextDataMatch[1]);
      pagesData = nextData?.props?.pageProps?.pagesData;
      if (!Array.isArray(pagesData)) {
        throw new Error("pagesData not found");
      }
    } catch (e) {
      throw new Error(`SolarWinds: failed to parse advisory data: ${(e as Error).message}`);
    }

    // Parse all advisories from structured data
    const allAdvisories = this.parseAdvisories(pagesData);

    // Filter for requested product
    const productAdvisories = this.filterByProduct(allAdvisories);

    // Calculate branch MSVs from fixed versions
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

  /** Recursively extract text from ContentStack rich-text doc nodes */
  private extractDocText(node: any): string {
    if (!node) return "";
    if (typeof node === "string") return node;
    if (typeof node.text === "string") return node.text;
    if (Array.isArray(node.children)) {
      return node.children.map((c: any) => this.extractDocText(c)).join("").trim();
    }
    if (Array.isArray(node)) {
      return node.map((c: any) => this.extractDocText(c)).join("").trim();
    }
    return "";
  }

  private parseAdvisories(pagesData: any[]): SecurityAdvisory[] {
    const advisories: SecurityAdvisory[] = [];

    for (const page of pagesData) {
      const headline = page.headline || "";
      const cveText = this.extractDocText(page.advisoryId);
      const fixedText = this.extractDocText(page.fixedVersion);
      const severityStr = page.severity || "";
      const date = page.firstPublished || "";

      // Extract CVE ID from doc text (e.g., "CVE-2025-40552")
      const cveMatch = cveText.match(/CVE-\d{4}-\d+/i);
      if (!cveMatch) continue;
      const cveId = cveMatch[0].toUpperCase();

      // Extract version from fixedVersion text (e.g., "SolarWinds Web Help Desk 2026.1")
      const fixedVersions = this.extractVersionFromFixedText(fixedText);

      // Parse severity from "9.8 Critical" format
      const severity = this.parseSeverity(severityStr);

      advisories.push({
        id: cveId,
        title: headline,
        severity,
        affectedVersions: [],
        fixedVersions,
        cveIds: [cveId],
        publishedDate: date || new Date().toISOString().split("T")[0],
        url: `https://www.solarwinds.com/${page.url || `trust-center/security-advisories/${cveId.toLowerCase()}`}`,
      });
    }

    return advisories;
  }

  private extractVersionFromFixedText(text: string): string[] {
    if (!text) return [];
    // Match patterns like "2026.1", "12.8.8", "15.5.3", "2024.4.1 SR1"
    const versionRegex = /\b(\d{4}\.\d+(?:\.\d+)?(?:\s+(?:SR|HF)\d+)?|\d+\.\d+\.\d+(?:\s+(?:SR|HF)\d+)?)\b/gi;
    const versions = new Set<string>();
    for (const match of text.matchAll(versionRegex)) {
      const v = match[1].trim();
      // Filter: must look like a version (has dots), not a bare year
      if (v.includes(".")) {
        versions.add(v);
      }
    }
    return Array.from(versions);
  }

  private parseSeverity(text: string): SecurityAdvisory["severity"] {
    const lower = text.toLowerCase();
    if (lower.includes("critical")) return "critical";
    if (lower.includes("high")) return "high";
    if (lower.includes("medium") || lower.includes("moderate")) return "medium";
    if (lower.includes("low")) return "low";
    return "unknown";
  }

  private filterByProduct(advisories: SecurityAdvisory[]): SecurityAdvisory[] {
    const patterns = SolarWindsAdvisoryFetcher.PRODUCT_PATTERNS[this.product];
    if (!patterns) {
      // Fallback: match product name directly
      return advisories.filter(adv =>
        adv.title.toLowerCase().includes(this.product.replace(/_/g, " ").toLowerCase())
      );
    }

    // For Orion Platform, also include generic "Platform" advisories
    const orionModules = [
      "orion_platform", "network_performance_monitor", "server_and_application_monitor",
      "network_configuration_manager", "netflow_traffic_analyzer", "ip_address_manager",
      "virtualization_manager", "database_performance_analyzer", "log_analyzer"
    ];
    const isOrionProduct = orionModules.includes(this.product);

    return advisories.filter(adv => {
      const text = adv.title.toLowerCase();

      // Check product patterns
      for (const pattern of patterns) {
        if (text.includes(pattern.toLowerCase())) return true;
      }

      // Orion modules also match generic "Platform" advisories
      if (isOrionProduct && text.includes("platform")) return true;

      return false;
    });
  }

  private calculateBranchMsv(advisories: SecurityAdvisory[]): BranchMsv[] {
    const allVersions = new Set<string>();
    for (const adv of advisories) {
      for (const v of adv.fixedVersions) {
        // Normalize: strip SR/HF suffixes for branch grouping but keep full version
        allVersions.add(v.replace(/\s+(SR|HF)\d+$/i, ""));
      }
    }

    const branchVersions = new Map<string, string[]>();
    for (const version of allVersions) {
      const branch = this.getBranch(version);
      if (!branchVersions.has(branch)) {
        branchVersions.set(branch, []);
      }
      branchVersions.get(branch)!.push(version);
    }

    const results: BranchMsv[] = [];
    for (const [branch, versions] of branchVersions) {
      versions.sort((a, b) => this.compareVersions(a, b));
      const highest = versions[versions.length - 1];
      results.push({ branch, msv: highest, latest: highest });
    }

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
// Adobe fetcher removed — helpx.adobe.com CDN blocks non-browser requests.
// Adobe CVE data comes from NVD/VulnCheck/KEV in the main pipeline.
import { OracleAdvisoryFetcher as OracleFetcherCore } from "./OracleAdvisoryFetcher";

export class MsrcAdvisoryFetcher extends VendorAdvisoryFetcher {
  private readonly productKey: string;

  // Minimum major version for modern product lines (filters legacy products)
  // Edge Chromium starts at v79; anything below is Edge Legacy (EdgeHTML) — different engine entirely
  private static readonly MODERN_VERSION_CUTOFF: Record<string, number> = {
    edge: 79,
  };

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

  /**
   * Check if a version is from a legacy/discontinued product line
   */
  static isLegacyVersion(product: string, version: string): boolean {
    const key = MsrcAdvisoryFetcher.PRODUCT_KEYS[product.toLowerCase()] || product.toLowerCase();
    const cutoff = MsrcAdvisoryFetcher.MODERN_VERSION_CUTOFF[key];
    if (!cutoff) return false;
    const major = parseInt(version.split(".")[0], 10);
    return !isNaN(major) && major < cutoff;
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
      title: vuln.title || "",
      severity: this.mapSeverity(vuln.severity),
      affectedVersions: vuln.affectedProducts || [],
      fixedVersions: vuln.fixedBuild ? [vuln.fixedBuild] : [],
      cveIds: [vuln.cveId],
      publishedDate: (vuln.publishedDate || new Date().toISOString()).split("T")[0],
      url: `https://msrc.microsoft.com/update-guide/vulnerability/${vuln.cveId}`,
    }));

    // Filter out legacy product versions (e.g., Edge Legacy < v79 is a different engine)
    const cutoff = MsrcAdvisoryFetcher.MODERN_VERSION_CUTOFF[this.productKey];
    const filteredAdvisories = cutoff
      ? advisories.filter(adv => {
          if (adv.fixedVersions.length === 0) return true;
          return adv.fixedVersions.some(v => {
            const major = parseInt(v.split(".")[0], 10);
            return isNaN(major) || major >= cutoff;
          });
        })
      : advisories;

    // Calculate MSV from fixed builds
    const branches = this.calculateBranchMsv(filteredAdvisories);

    const result: VendorAdvisoryResult = {
      vendor: "microsoft",
      product: this.productKey,
      advisories: filteredAdvisories,
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

// Adobe wrapper removed — fetcher deleted (CDN blocks non-browser requests).
// Adobe CVE data comes from NVD/VulnCheck/KEV in the main pipeline.

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
      // Adobe: No viable vendor advisory source (CDN blocks non-browser requests). Uses NVD/VulnCheck/KEV.
      if (vendor.toLowerCase() === "adobe") return null;
      // Check for Oracle products
      if (vendor.toLowerCase() === "oracle") {
        return new OracleVendorAdvisoryFetcher(cacheDir, product);
      }
      // Fortinet: No viable vendor advisory source (RSS has no version data). Uses NVD/VulnCheck/KEV.
      if (vendor.toLowerCase() === "fortinet") return null;
      // Check for Palo Alto Networks products
      if (vendor.toLowerCase() === "palo_alto" || vendor.toLowerCase() === "paloaltonetworks" || vendor.toLowerCase() === "palo alto networks") {
        return new PaloAltoVendorAdvisoryFetcher(cacheDir, product);
      }
      // Check for Cisco products
      if (vendor.toLowerCase() === "cisco") {
        return new CiscoVendorAdvisoryFetcher(cacheDir, product);
      }
      // SonicWall: No viable vendor advisory source (PSIRT portal WAF-blocked). Uses NVD/VulnCheck/KEV.
      if (vendor.toLowerCase() === "sonicwall") return null;
      // Juniper: No viable vendor advisory source (feeds dead, Salesforce behind auth). Uses NVD/VulnCheck/KEV.
      if (vendor.toLowerCase() === "juniper" || vendor.toLowerCase() === "juniper_networks" || vendor.toLowerCase() === "juniper networks") return null;
      // Check for Ivanti products (CISA KEV priority target)
      if (vendor.toLowerCase() === "ivanti") {
        return new IvantiVendorAdvisoryFetcher(cacheDir, product);
      }
      // F5: No public machine-readable advisory feed. NVD/VulnCheck/KEV cover F5 CVEs.
      // Future: If F5 publishes CSAF, add fetcher here.
      // Check Point: No viable vendor advisory source (no public API/RSS). Uses NVD/VulnCheck/KEV.
      if (vendor.toLowerCase() === "checkpoint" || vendor.toLowerCase() === "check_point" || vendor.toLowerCase() === "check point") return null;
      // Check for OPNsense (open source firewall, FreeBSD-based)
      if (vendor.toLowerCase() === "opnsense" || vendor.toLowerCase() === "deciso") {
        return new OPNsenseVendorAdvisoryFetcher(cacheDir, product);
      }
      // Check for pfSense (open source firewall, FreeBSD-based)
      if (vendor.toLowerCase() === "pfsense" || vendor.toLowerCase() === "netgate") {
        return new PfSenseVendorAdvisoryFetcher(cacheDir, product);
      }
      return null;
  }
}

// =============================================================================
// Wrapper Fetchers for New Vendors
// =============================================================================

import { PaloAltoAdvisoryFetcher, fetchPaloAltoAdvisories } from "./PaloAltoAdvisoryFetcher";
import { CiscoAdvisoryFetcher, fetchCiscoAdvisories } from "./CiscoAdvisoryFetcher";
import { IvantiAdvisoryFetcher, fetchIvantiAdvisories } from "./IvantiAdvisoryFetcher";
import { OPNsenseAdvisoryFetcher, fetchOPNsenseAdvisories } from "./OPNsenseAdvisoryFetcher";
import { PfSenseAdvisoryFetcher, fetchPfSenseAdvisories } from "./PfSenseAdvisoryFetcher";
// Removed vendor fetchers — no viable vendor advisory sources. CVE data comes from NVD/VulnCheck/KEV:
// - Fortinet: FortiGuard RSS has no version data; individual page scraping too fragile
// - SonicWall: PSIRT portal WAF-blocked (Incapsula); NVD has only 11 CVEs total
// - Juniper: Native feeds dead (migrated to Salesforce behind auth)
// - Check Point: No public API or RSS feed; email-only subscription
// - Adobe: helpx.adobe.com CDN blocks non-browser requests
// - F5: No public machine-readable advisory feed

// Fortinet fetcher removed — FortiGuard RSS has no version data. NVD/VulnCheck/KEV cover Fortinet CVEs.

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

// SonicWall fetcher removed — PSIRT portal WAF-blocked (Incapsula), NVD has only 11 CVEs total.
// Juniper fetcher removed — native advisory feeds dead (Salesforce migration behind auth).

/**
 * Ivanti Vendor Advisory Fetcher (Wrapper)
 * WARNING: Ivanti products are frequent CISA KEV targets - prioritize patching
 */
class IvantiVendorAdvisoryFetcher extends VendorAdvisoryFetcher {
  private product: string;

  constructor(cacheDir: string, product: string = "all") {
    super(cacheDir);
    this.product = product;
  }

  async fetch(): Promise<VendorAdvisoryResult> {
    return fetchIvantiAdvisories(this.cacheDir, this.product === "all" ? undefined : this.product);
  }
}

// F5 fetcher removed — no public machine-readable advisory feed.
// Check Point fetcher removed — no public API or RSS; email-only subscription.
// Both covered by NVD/VulnCheck/KEV in the main pipeline.

/**
 * OPNsense Vendor Advisory Fetcher (Wrapper)
 * Open-source firewall (FreeBSD-based fork of pfSense)
 * Uses endoflife.date API for structured version data
 * Version format: YY.R (24.7, 25.1, 26.1)
 */
class OPNsenseVendorAdvisoryFetcher extends VendorAdvisoryFetcher {
  private product: string;

  constructor(cacheDir: string, product: string = "all") {
    super(cacheDir);
    this.product = product;
  }

  async fetch(): Promise<VendorAdvisoryResult> {
    return fetchOPNsenseAdvisories(this.cacheDir, this.product === "all" ? undefined : this.product);
  }
}

/**
 * pfSense Vendor Advisory Fetcher (Wrapper)
 * Open-source firewall (FreeBSD-based)
 * pfSense Plus (commercial): YY.MM format
 * pfSense CE (community): X.Y.Z format
 */
class PfSenseVendorAdvisoryFetcher extends VendorAdvisoryFetcher {
  private edition: string;

  constructor(cacheDir: string, product: string = "all") {
    super(cacheDir);
    // Map catalog product names to fetcher edition names ("ce", "plus", or "all")
    const p = product.toLowerCase();
    if (p === "pfsense" || p === "pfsense_ce" || p === "ce") {
      this.edition = "ce";
    } else if (p === "pfsense_plus" || p === "plus") {
      this.edition = "plus";
    } else {
      this.edition = "all";
    }
  }

  async fetch(): Promise<VendorAdvisoryResult> {
    return fetchPfSenseAdvisories(this.cacheDir, this.edition === "all" ? undefined : this.edition);
  }
}

/**
 * Check if a version belongs to a legacy/discontinued product line.
 * E.g., Edge Legacy (EdgeHTML, v1-44) vs Edge Chromium (v79+).
 */
export function isLegacyProductVersion(vendor: string, product: string, version: string): boolean {
  if (vendor.toLowerCase() === "microsoft") {
    return MsrcAdvisoryFetcher.isLegacyVersion(product, version);
  }
  return false;
}
