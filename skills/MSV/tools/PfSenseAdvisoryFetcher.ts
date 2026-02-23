/**
 * PfSenseAdvisoryFetcher.ts - pfSense Firewall Security Advisory Fetcher
 *
 * Fetches security advisories directly from Netgate's official advisory archive.
 * Source: https://docs.netgate.com/advisories/index.html
 * Advisory files: PGP-signed .asc text files at docs.netgate.com/downloads/
 *
 * This is a genuine vendor data source — Netgate publishes structured BSD-style
 * security advisories with exact version data in Affects/Corrected sections.
 *
 * Products covered:
 * - pfSense Plus (commercial) - YY.MM format
 * - pfSense CE (community) - X.Y.Z format
 *
 * Advisory format: pfSense-SA-YY_XX.component
 * Examples: pfSense-SA-25_01.webgui, pfSense-SA-25_09.sshguard
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

const ADVISORIES_INDEX_URL = "https://docs.netgate.com/advisories/index.html";
const ADVISORY_DOWNLOAD_BASE = "https://docs.netgate.com/downloads/";
const REQUEST_TIMEOUT_MS = 15000;
const FETCH_DELAY_MS = 250; // polite delay between .asc fetches
const MAX_ADVISORY_AGE_YEARS = 2; // only fetch advisories from last N years

// =============================================================================
// Types
// =============================================================================

export interface PfSenseAdvisory {
  id: string;              // e.g., "pfSense-SA-25_01.webgui"
  cveIds: string[];
  title: string;
  severity: "critical" | "high" | "medium" | "low" | "unknown";
  cvssScore: number | null;
  publishedDate: string;
  affectedVersions: string[];
  fixedVersions: string[];   // e.g., ["pfSense Plus 25.11", "pfSense CE 2.9.0"]
  url: string;
  component?: string;      // webgui, sshguard, openssl, etc.
}

interface CacheEntry {
  data: VendorAdvisoryResult;
  expiresAt: string;
}

// =============================================================================
// pfSense Advisory Fetcher
// =============================================================================

export class PfSenseAdvisoryFetcher {
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
   * Fetch pfSense security advisories from Netgate's official advisory archive
   */
  async fetch(): Promise<VendorAdvisoryResult> {
    const cacheKey = `pfsense-${this.product}`;
    const cached = this.getCache(cacheKey);
    if (cached) return cached;

    let advisories: PfSenseAdvisory[] = [];
    try {
      advisories = await this.fetchAdvisories();
    } catch (error) {
      console.error(`pfSense advisory fetch warning: ${(error as Error).message}`);
    }

    const securityAdvisories = this.convertToSecurityAdvisories(advisories);
    const branches = this.calculateBranchMsv(advisories);

    const result: VendorAdvisoryResult = {
      vendor: "Netgate",
      product: this.product === "ce" ? "pfSense CE" : (this.product === "plus" ? "pfSense Plus" : "pfSense"),
      advisories: securityAdvisories,
      branches,
      fetchedAt: new Date().toISOString(),
      source: ADVISORIES_INDEX_URL,
    };

    this.setCache(cacheKey, result);
    return result;
  }

  /**
   * Fetch advisories from Netgate's official advisory archive
   * 1. Fetch index page to discover advisory URLs
   * 2. Filter to recent advisories (last N years)
   * 3. Fetch each .asc file and parse structured fields
   */
  private async fetchAdvisories(): Promise<PfSenseAdvisory[]> {
    // Step 1: Fetch the index page
    const indexResponse = await fetch(ADVISORIES_INDEX_URL, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { "User-Agent": "MSV-Skill/1.10 (Security Advisory Fetcher)" },
    });

    if (!indexResponse.ok) {
      throw new Error(`Failed to fetch advisory index: ${indexResponse.status}`);
    }

    const indexHtml = await indexResponse.text();
    const advisoryIds = this.extractAdvisoryIds(indexHtml);

    // Step 2: Filter to recent advisories
    const currentYear = new Date().getFullYear() % 100; // 26 for 2026
    const minYear = currentYear - MAX_ADVISORY_AGE_YEARS;
    const recentIds = advisoryIds.filter(id => {
      const yearMatch = id.match(/pfSense-SA-(\d{2})_/);
      return yearMatch && parseInt(yearMatch[1], 10) >= minYear;
    });

    // Step 3: Fetch each .asc file
    const advisories: PfSenseAdvisory[] = [];
    for (const id of recentIds) {
      try {
        const advisory = await this.fetchSingleAdvisory(id);
        if (advisory) advisories.push(advisory);
        await new Promise(r => setTimeout(r, FETCH_DELAY_MS));
      } catch (error) {
        console.error(`Warning: Failed to fetch ${id}: ${(error as Error).message}`);
      }
    }

    return advisories;
  }

  /**
   * Extract advisory IDs from the index HTML
   * Links follow pattern: /downloads/pfSense-SA-25_09.sshguard.asc
   */
  private extractAdvisoryIds(html: string): string[] {
    const ids: string[] = [];
    const pattern = /pfSense-SA-\d{2}_\d+\.\w+/g;
    let match;
    while ((match = pattern.exec(html)) !== null) {
      const id = match[0];
      if (!ids.includes(id)) ids.push(id);
    }
    return ids;
  }

  /**
   * Fetch and parse a single .asc advisory file.
   * Individual advisories are cached permanently (they never change once published).
   */
  private async fetchSingleAdvisory(id: string): Promise<PfSenseAdvisory | null> {
    // Check per-advisory permanent cache
    const advCacheKey = `pfsense-adv-${id}`;
    const advCachePath = this.getCachePath(advCacheKey);
    if (existsSync(advCachePath)) {
      try {
        return JSON.parse(readFileSync(advCachePath, "utf-8"));
      } catch { /* re-fetch on corrupt cache */ }
    }

    const url = `${ADVISORY_DOWNLOAD_BASE}${id}.asc`;
    const response = await fetch(url, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { "User-Agent": "MSV-Skill/1.10 (Security Advisory Fetcher)" },
    });

    if (!response.ok) return null;

    const text = await response.text();
    const advisory = this.parseAscAdvisory(id, text, url);

    // Cache individual advisory permanently (they don't change)
    if (advisory) {
      writeFileSync(advCachePath, JSON.stringify(advisory));
    }

    return advisory;
  }

  /**
   * Parse a .asc advisory text file
   *
   * BSD-style format with structured sections:
   *   Topic:      "Anti-brute force protection bypass..."
   *   Affects:    pfSense Plus software versions < 25.11
   *               pfSense CE software versions <= 2.8.1
   *   Corrected:  2025-11-10 20:22:38 UTC (pfSense Plus RELENG_25_11, 25.11)
   *               2025-11-10 20:22:38 UTC (pfSense CE master, 2.9.0)
   */
  private parseAscAdvisory(id: string, text: string, url: string): PfSenseAdvisory | null {
    // Extract topic/title
    const topicMatch = text.match(/Topic:\s+(.+)/);
    const title = topicMatch ? topicMatch[1].trim() : id;

    // Extract CVE IDs
    const cveIds: string[] = [];
    const cvePattern = /CVE-\d{4}-\d{4,}/g;
    let cveMatch;
    while ((cveMatch = cvePattern.exec(text)) !== null) {
      if (!cveIds.includes(cveMatch[0])) cveIds.push(cveMatch[0]);
    }

    // Extract component from advisory ID (e.g., "webgui" from "pfSense-SA-25_01.webgui")
    const componentMatch = id.match(/\.(\w+)$/);
    const component = componentMatch ? componentMatch[1] : undefined;

    // Extract affected versions from Affects: section
    const affectedVersions = this.parseAffectsSection(text);

    // Extract fixed versions from Corrected: section
    const fixedVersions = this.parseCorrectedSection(text);

    // Extract date from Corrected section (earliest date)
    const dateMatch = text.match(/Corrected:\s+(\d{4}-\d{2}-\d{2})/);
    const publishedDate = dateMatch ? dateMatch[1] : "";

    // Determine severity from Impact section
    const severity = this.assessSeverity(text);

    return {
      id,
      cveIds,
      title,
      severity,
      cvssScore: null, // .asc files don't include CVSS scores
      publishedDate,
      affectedVersions,
      fixedVersions,
      url,
      component,
    };
  }

  /**
   * Parse the Affects: section
   * Format: "pfSense Plus software versions < 25.11"
   *         "pfSense CE software versions <= 2.8.1"
   */
  private parseAffectsSection(text: string): string[] {
    const affected: string[] = [];
    // Match from "Affects:" to the next section header
    const affectsMatch = text.match(/Affects:\s+([\s\S]*?)(?=\n[A-Z][a-z]+:|\n\n[A-Z])/);
    if (!affectsMatch) return affected;

    const section = affectsMatch[1];
    const lines = section.split("\n");
    for (const line of lines) {
      const versionMatch = line.match(/pfSense\s+(Plus|CE)\s+.*?([<>=]+)\s+([\d.]+)/i);
      if (versionMatch) {
        const edition = versionMatch[1]; // Plus or CE
        const operator = versionMatch[2]; // < or <=
        const version = versionMatch[3]; // 25.11 or 2.8.1
        affected.push(`pfSense ${edition} ${operator} ${version}`);
      }
    }
    return affected;
  }

  /**
   * Parse the Corrected: section to extract fix versions
   * Format: "2025-11-10 20:22:38 UTC (pfSense Plus RELENG_25_11, 25.11)"
   *
   * Returns deduplicated list like ["pfSense Plus 25.11", "pfSense CE 2.9.0"]
   * Includes all entries (RELENG, master, devel) — the version number at the end
   * is what matters for MSV calculation.
   */
  private parseCorrectedSection(text: string): string[] {
    const fixed: string[] = [];
    const correctedMatch = text.match(/Corrected:\s+([\s\S]*?)(?=\n\n|\n[A-Z][a-z]+:)/);
    if (!correctedMatch) return fixed;

    const section = correctedMatch[1];
    const lines = section.split("\n");
    for (const line of lines) {
      // Match: (pfSense Plus RELENG_25_11, 25.11) or (pfSense CE master, 2.9.0)
      const versionMatch = line.match(/\(pfSense\s+(Plus|CE).*?,\s*([\d.]+)\)/i);
      if (versionMatch) {
        const edition = versionMatch[1]; // Plus or CE
        const version = versionMatch[2]; // 25.11 or 2.9.0
        const key = `pfSense ${edition} ${version}`;
        if (!fixed.includes(key)) {
          fixed.push(key);
        }
      }
    }

    return fixed;
  }

  /**
   * Assess severity from the advisory Impact section text.
   * pfSense .asc files don't include CVSS scores, so we keyword-match.
   */
  private assessSeverity(text: string): PfSenseAdvisory["severity"] {
    const impactMatch = text.match(/Impact:\s+([\s\S]*?)(?=\n\n|\n[A-Z][a-z]+:)/);
    if (!impactMatch) return "unknown";

    const impact = impactMatch[1].toLowerCase();

    if (impact.includes("remote code execution") || impact.includes("rce") ||
        impact.includes("arbitrary code") || impact.includes("full control")) {
      return "critical";
    }
    if (impact.includes("arbitrary") || impact.includes("authentication bypass") ||
        impact.includes("privilege escalation") || impact.includes("command injection")) {
      return "high";
    }
    if (impact.includes("xss") || impact.includes("cross-site") ||
        impact.includes("denial of service") || impact.includes("dos") ||
        impact.includes("information disclosure") || impact.includes("session")) {
      return "medium";
    }
    if (impact.includes("minor") || impact.includes("limited")) {
      return "low";
    }
    return "medium"; // default for published security advisories
  }

  /**
   * Convert to standard SecurityAdvisory format
   */
  private convertToSecurityAdvisories(advisories: PfSenseAdvisory[]): SecurityAdvisory[] {
    return advisories.map(a => ({
      id: a.id,
      title: a.title,
      severity: a.severity,
      affectedVersions: a.affectedVersions,
      fixedVersions: a.fixedVersions,
      cveIds: a.cveIds,
      publishedDate: a.publishedDate,
      url: a.url,
    }));
  }

  /**
   * Calculate MSV for each edition (Plus vs CE)
   *
   * For each advisory, find the lowest fix version per edition from the Corrected section.
   * Across all advisories, MSV = the highest fix version per edition (most recent fix needed).
   */
  private calculateBranchMsv(advisories: PfSenseAdvisory[]): BranchMsv[] {
    // Track highest required fix version per edition
    const editionMsv = new Map<string, string>(); // "plus" -> "25.11", "ce" -> "2.9.0"

    for (const advisory of advisories) {
      // Group fix versions by edition, find lowest per edition (= first release with fix)
      const editionVersions = new Map<string, string[]>();

      for (const fixed of advisory.fixedVersions) {
        const match = fixed.match(/pfSense\s+(Plus|CE)\s+([\d.]+)/i);
        if (!match) continue;

        const edition = match[1].toLowerCase();
        const version = match[2];

        // Filter by product if specified
        if (this.product !== "all" && this.product !== edition) continue;

        if (!editionVersions.has(edition)) editionVersions.set(edition, []);
        editionVersions.get(edition)!.push(version);
      }

      // For each edition, the fix version = lowest version in this advisory
      for (const [edition, versions] of editionVersions) {
        versions.sort((a, b) => this.compareVersions(a, b));
        const fixVersion = versions[0]; // lowest = first release with fix

        const current = editionMsv.get(edition);
        if (!current || this.compareVersions(fixVersion, current) > 0) {
          editionMsv.set(edition, fixVersion);
        }
      }
    }

    return Array.from(editionMsv.entries())
      .map(([edition, msv]) => ({
        branch: edition === "plus" ? "Plus" : "CE",
        msv,
        latest: msv, // MSV = latest from advisory data
      }))
      .sort((a, b) => (a.branch === "Plus" ? -1 : 1));
  }

  /**
   * Compare pfSense versions (works for both Plus YY.MM and CE X.Y.Z)
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
 * Fetch pfSense security advisories from Netgate's official advisory archive
 */
export async function fetchPfSenseAdvisories(
  cacheDir: string,
  product?: string
): Promise<VendorAdvisoryResult> {
  const fetcher = new PfSenseAdvisoryFetcher(cacheDir, product);
  return fetcher.fetch();
}
