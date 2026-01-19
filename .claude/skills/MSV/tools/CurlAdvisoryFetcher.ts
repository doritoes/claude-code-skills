/**
 * CurlAdvisoryFetcher.ts - curl Security Advisory Fetcher
 *
 * Fetches security advisories from curl's official vulnerability database.
 * API: https://curl.se/docs/vuln.json
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

const CURL_VULN_JSON_URL = "https://curl.se/docs/vuln.json";
const REQUEST_TIMEOUT_MS = 30000;

// =============================================================================
// Types
// =============================================================================

export interface CurlVulnerability {
  cve: string;
  id: string;             // curl advisory ID (e.g., "curl-sa-2025-001")
  title: string;
  severity: "Critical" | "High" | "Medium" | "Low";
  affected_start: string; // First affected version
  affected_end: string;   // Last affected version
  fixed_in: string;       // Version that fixes this
  url: string;            // Advisory URL
  introduced_in: string;  // Git commit that introduced the bug
  fixed_in_commit: string;// Git commit that fixed the bug
  cwes: string[];         // CWE identifiers
  published: string;      // Publication date
}

export interface CurlAdvisoryResult {
  vulnerabilities: CurlVulnerability[];
  msv: string | null;
  latestVersion: string | null;
  lastUpdated: string;
  source: string;
}

interface CacheEntry {
  data: CurlAdvisoryResult;
  expiresAt: string;
}

// Raw JSON format from curl.se (OSV format)
interface CurlVulnJsonEntry {
  id: string;                    // e.g., "CURL-CVE-2025-15224"
  aliases?: string[];            // e.g., ["CVE-2025-15224"]
  summary?: string;              // Short description
  details?: string;              // Full description
  modified?: string;             // ISO date
  published?: string;            // ISO date
  database_specific?: {
    package?: string;
    severity?: string;           // "Low", "Medium", "High", "Critical"
    CWE?: { id: string; desc: string };
    award?: { amount: string; currency: string };
    affects?: string;
  };
  affected?: Array<{
    ranges?: Array<{
      type: string;              // "SEMVER" or "GIT"
      repo?: string;
      events?: Array<{
        introduced?: string;     // First affected version
        fixed?: string;          // Fixed version
      }>;
    }>;
    versions?: string[];         // List of affected versions
  }>;
  credits?: Array<{ name: string; type: string }>;
}

// =============================================================================
// curl Advisory Fetcher
// =============================================================================

export class CurlAdvisoryFetcher {
  private cacheDir: string;
  private cacheDurationMs = 4 * 60 * 60 * 1000; // 4 hours

  constructor(cacheDir: string) {
    this.cacheDir = cacheDir;
    if (!existsSync(cacheDir)) {
      mkdirSync(cacheDir, { recursive: true });
    }
  }

  /**
   * Fetch all curl vulnerabilities
   */
  async fetch(): Promise<CurlAdvisoryResult> {
    const cacheKey = "curl-vulns";
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
    const response = await fetch(CURL_VULN_JSON_URL, {
      headers: {
        "Accept": "application/json",
        "User-Agent": "MSV-Skill/1.0 (PAI Infrastructure)",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`curl advisory fetch error: ${response.status} ${response.statusText}`);
    }

    const rawData = await response.json() as CurlVulnJsonEntry[];
    const vulnerabilities = this.parseVulnerabilities(rawData);

    // Calculate MSV (highest fixed_in version)
    const fixedVersions = vulnerabilities
      .map(v => v.fixed_in)
      .filter(v => v && v !== "n/a")
      .sort((a, b) => this.compareVersions(b, a)); // Descending

    const msv = fixedVersions.length > 0 ? fixedVersions[0] : null;

    // Get latest version (curl releases page would be better, but we can estimate)
    // The highest fixed_in is usually close to or is the latest
    const latestVersion = msv;

    const result: CurlAdvisoryResult = {
      vulnerabilities,
      msv,
      latestVersion,
      lastUpdated: new Date().toISOString(),
      source: CURL_VULN_JSON_URL,
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
   * Parse raw vulnerability data (OSV format)
   */
  private parseVulnerabilities(raw: CurlVulnJsonEntry[]): CurlVulnerability[] {
    const vulns: CurlVulnerability[] = [];

    for (const entry of raw) {
      if (!entry.id) continue;

      // Extract CVE from aliases or id
      const cve = entry.aliases?.find(a => a.startsWith("CVE-")) || "";

      // Extract severity from database_specific
      const severity = this.parseSeverity(entry.database_specific?.severity);

      // Extract CWE
      const cwes: string[] = [];
      if (entry.database_specific?.CWE?.id) {
        cwes.push(entry.database_specific.CWE.id);
      }

      // Extract version info from affected ranges
      let affected_start = "";
      let affected_end = "";
      let fixed_in = "";
      let introduced_in = "";
      let fixed_in_commit = "";

      if (entry.affected && entry.affected.length > 0) {
        for (const affected of entry.affected) {
          if (affected.ranges) {
            for (const range of affected.ranges) {
              if (range.type === "SEMVER" && range.events) {
                for (const event of range.events) {
                  if (event.introduced) affected_start = event.introduced;
                  if (event.fixed) fixed_in = event.fixed;
                }
              }
              if (range.type === "GIT" && range.events) {
                for (const event of range.events) {
                  if (event.introduced) introduced_in = event.introduced;
                  if (event.fixed) fixed_in_commit = event.fixed;
                }
              }
            }
          }
          // Get last affected from versions array
          if (affected.versions && affected.versions.length > 0) {
            affected_end = affected.versions[0]; // First version in list is usually latest affected
          }
        }
      }

      vulns.push({
        cve,
        id: entry.id,
        title: entry.summary || "",
        severity,
        affected_start,
        affected_end,
        fixed_in,
        url: `https://curl.se/docs/${entry.id.replace("CURL-", "").toLowerCase()}.html`,
        introduced_in,
        fixed_in_commit,
        cwes,
        published: entry.published || "",
      });
    }

    // Sort by fixed_in version descending (most recent first)
    vulns.sort((a, b) => this.compareVersions(b.fixed_in, a.fixed_in));

    return vulns;
  }

  /**
   * Parse severity string
   */
  private parseSeverity(severity?: string): CurlVulnerability["severity"] {
    if (!severity) return "Medium";
    const lower = severity.toLowerCase();
    if (lower.includes("critical")) return "Critical";
    if (lower.includes("high")) return "High";
    if (lower.includes("medium") || lower.includes("moderate")) return "Medium";
    if (lower.includes("low")) return "Low";
    return "Medium";
  }

  /**
   * Get vulnerabilities affecting a specific version
   */
  getVulnerabilitiesForVersion(version: string, vulns: CurlVulnerability[]): CurlVulnerability[] {
    return vulns.filter(v => {
      // Version must be >= affected_start and <= affected_end
      if (!v.affected_start || !v.affected_end) return false;

      const versionNum = this.compareVersions(version, v.affected_start);
      const endNum = this.compareVersions(version, v.affected_end);

      return versionNum >= 0 && endNum <= 0;
    });
  }

  /**
   * Check if a version is safe
   */
  isVersionSafe(version: string, vulns: CurlVulnerability[]): boolean {
    const affecting = this.getVulnerabilitiesForVersion(version, vulns);
    return affecting.length === 0;
  }

  /**
   * Compare version strings
   */
  private compareVersions(a: string, b: string): number {
    if (!a || !b) return 0;

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
}

// =============================================================================
// CLI Testing
// =============================================================================

if (import.meta.main) {
  const dataDir = resolve(import.meta.dir, "..", "data");
  const fetcher = new CurlAdvisoryFetcher(dataDir);

  console.log("Fetching curl security advisories...");

  try {
    const result = await fetcher.fetch();
    console.log(`\nFound ${result.vulnerabilities.length} vulnerabilities`);
    console.log(`Minimum Safe Version: ${result.msv || "Not determined"}`);

    if (result.vulnerabilities.length > 0) {
      console.log("\nRecent vulnerabilities:");
      for (const vuln of result.vulnerabilities.slice(0, 10)) {
        console.log(`  ${vuln.cve || vuln.id}: ${vuln.title}`);
        console.log(`    Severity: ${vuln.severity}, Fixed in: ${vuln.fixed_in}`);
      }
    }

    // Test version check
    const testVersion = "8.10.0";
    const affecting = fetcher.getVulnerabilitiesForVersion(testVersion, result.vulnerabilities);
    console.log(`\nVulnerabilities affecting curl ${testVersion}: ${affecting.length}`);
    if (affecting.length > 0) {
      for (const v of affecting.slice(0, 3)) {
        console.log(`  ${v.cve}: ${v.title} (fixed in ${v.fixed_in})`);
      }
    }
  } catch (error) {
    console.error("Error:", error);
  }
}
