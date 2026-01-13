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
      return null;
  }
}
