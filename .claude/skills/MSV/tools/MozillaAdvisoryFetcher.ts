/**
 * MozillaAdvisoryFetcher.ts - Mozilla Foundation Security Advisory Fetcher
 *
 * Fetches security advisories from Mozilla's GitHub repository.
 * Source: https://github.com/mozilla/foundation-security-advisories
 *
 * Advisories are stored as YAML files in announce/{year}/mfsa{year}-{nn}.yml
 * No API key required. Uses GitHub API for directory listing + raw content.
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";

// =============================================================================
// Constants
// =============================================================================

const GITHUB_API_BASE = "https://api.github.com/repos/mozilla/foundation-security-advisories";
const GITHUB_RAW_BASE = "https://raw.githubusercontent.com/mozilla/foundation-security-advisories/master";
const REQUEST_TIMEOUT_MS = 30000;

// =============================================================================
// Types
// =============================================================================

export interface MozillaVulnerability {
  cve: string;
  title: string;
  impact: "critical" | "high" | "moderate" | "low";
  reporter?: string;
  description?: string;
  bugs?: string[];
}

export interface MozillaAdvisory {
  mfsa: string;              // e.g., "mfsa2024-63"
  announced: string;         // ISO date
  impact: "critical" | "high" | "moderate" | "low";
  title: string;
  products: string[];        // ["Firefox 133", "Firefox ESR 128.5"]
  fixedVersions: Map<string, string>;  // product -> version
  vulnerabilities: MozillaVulnerability[];
}

export interface MozillaProductResult {
  product: string;           // "firefox" | "firefox_esr" | "thunderbird"
  advisories: MozillaAdvisory[];
  msv: string | null;
  latestVersion: string | null;
  lastUpdated: string;
  source: string;
}

interface CacheEntry {
  data: MozillaProductResult;
  expiresAt: string;
}

// Raw YAML structure from Mozilla advisories
interface MozillaYamlAdvisory {
  announced?: string;
  impact?: string;
  fixed_in?: string[];
  title?: string;
  advisories?: Record<string, {
    title?: string;
    impact?: string;
    reporter?: string;
    description?: string;
    bugs?: Array<{ url?: string; desc?: string }>;
  }>;
}

// GitHub API response for directory listing
interface GitHubContentItem {
  name: string;
  type: string;
  download_url?: string;
}

// =============================================================================
// Product Patterns
// =============================================================================

const PRODUCT_PATTERNS: Record<string, RegExp> = {
  firefox: /Firefox\s+(\d+(?:\.\d+)*)/i,
  firefox_esr: /Firefox\s+ESR\s+(\d+(?:\.\d+)*)/i,
  thunderbird: /Thunderbird\s+(\d+(?:\.\d+)*)/i,
  thunderbird_esr: /Thunderbird\s+ESR\s+(\d+(?:\.\d+)*)/i,
};

// =============================================================================
// Mozilla Advisory Fetcher
// =============================================================================

export class MozillaAdvisoryFetcher {
  private cacheDir: string;
  private cacheDurationMs = 4 * 60 * 60 * 1000; // 4 hours

  constructor(cacheDir: string) {
    this.cacheDir = cacheDir;
    if (!existsSync(cacheDir)) {
      mkdirSync(cacheDir, { recursive: true });
    }
  }

  /**
   * Fetch advisories for a Mozilla product
   */
  async fetchProductAdvisories(product: string): Promise<MozillaProductResult> {
    const cacheKey = `mozilla-${product}`;
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

    // Fetch recent advisories (current year and previous year)
    const currentYear = new Date().getFullYear();
    const years = [currentYear, currentYear - 1];

    const allAdvisories: MozillaAdvisory[] = [];

    for (const year of years) {
      try {
        const yearAdvisories = await this.fetchYearAdvisories(year);
        allAdvisories.push(...yearAdvisories);
      } catch (error) {
        console.warn(`Failed to fetch Mozilla advisories for ${year}:`, error);
      }
    }

    // Filter advisories that affect the requested product
    const productPattern = PRODUCT_PATTERNS[product];
    const relevantAdvisories = productPattern
      ? allAdvisories.filter(a => a.products.some(p => productPattern.test(p)))
      : allAdvisories;

    // Calculate MSV (highest fixed version for the product)
    let msv: string | null = null;
    let latestVersion: string | null = null;

    if (productPattern) {
      const versions: string[] = [];
      for (const advisory of relevantAdvisories) {
        for (const productStr of advisory.products) {
          const match = productStr.match(productPattern);
          if (match && match[1]) {
            versions.push(match[1]);
          }
        }
      }

      if (versions.length > 0) {
        versions.sort((a, b) => this.compareVersions(b, a)); // Descending
        msv = versions[0];
        latestVersion = versions[0]; // In Mozilla's case, MSV usually equals latest
      }
    }

    const result: MozillaProductResult = {
      product,
      advisories: relevantAdvisories,
      msv,
      latestVersion,
      lastUpdated: new Date().toISOString(),
      source: `${GITHUB_API_BASE}/contents/announce`,
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
   * Fetch all advisories for a given year
   */
  private async fetchYearAdvisories(year: number): Promise<MozillaAdvisory[]> {
    const advisories: MozillaAdvisory[] = [];

    // Get list of YAML files for the year
    const listUrl = `${GITHUB_API_BASE}/contents/announce/${year}`;

    const response = await fetch(listUrl, {
      headers: {
        "Accept": "application/vnd.github.v3+json",
        "User-Agent": "MSV-Skill/1.0 (PAI Infrastructure)",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      if (response.status === 404) {
        return []; // Year directory doesn't exist yet
      }
      throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
    }

    const files = await response.json() as GitHubContentItem[];
    const yamlFiles = files.filter(f => f.type === "file" && f.name.endsWith(".yml"));

    // Fetch each YAML file (limit to most recent 20 to avoid rate limits)
    const recentFiles = yamlFiles.slice(-20);

    for (const file of recentFiles) {
      try {
        const advisory = await this.fetchAdvisory(year, file.name);
        if (advisory) {
          advisories.push(advisory);
        }
      } catch (error) {
        // Continue with other files
        console.warn(`Failed to fetch ${file.name}:`, error);
      }
    }

    return advisories;
  }

  /**
   * Fetch and parse a single advisory YAML file
   */
  private async fetchAdvisory(year: number, filename: string): Promise<MozillaAdvisory | null> {
    const url = `${GITHUB_RAW_BASE}/announce/${year}/${filename}`;

    const response = await fetch(url, {
      headers: {
        "Accept": "text/plain",
        "User-Agent": "MSV-Skill/1.0 (PAI Infrastructure)",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch ${filename}: ${response.status}`);
    }

    const yamlContent = await response.text();
    const parsed = parseYaml(yamlContent) as MozillaYamlAdvisory;

    if (!parsed) {
      return null;
    }

    // Extract MFSA ID from filename (mfsa2024-63.yml -> mfsa2024-63)
    const mfsa = filename.replace(".yml", "");

    // Parse products from fixed_in
    const products = parsed.fixed_in || [];

    // Build fixed versions map
    const fixedVersions = new Map<string, string>();
    for (const productStr of products) {
      for (const [product, pattern] of Object.entries(PRODUCT_PATTERNS)) {
        const match = productStr.match(pattern);
        if (match && match[1]) {
          fixedVersions.set(product, match[1]);
        }
      }
    }

    // Parse vulnerabilities
    const vulnerabilities: MozillaVulnerability[] = [];
    if (parsed.advisories) {
      for (const [cve, data] of Object.entries(parsed.advisories)) {
        vulnerabilities.push({
          cve,
          title: data.title || "",
          impact: this.parseImpact(data.impact),
          reporter: data.reporter,
          description: data.description,
          bugs: data.bugs?.map(b => b.url).filter((u): u is string => !!u),
        });
      }
    }

    return {
      mfsa,
      announced: parsed.announced || "",
      impact: this.parseImpact(parsed.impact),
      title: parsed.title || "",
      products,
      fixedVersions,
      vulnerabilities,
    };
  }

  /**
   * Parse impact/severity string
   */
  private parseImpact(impact?: string): MozillaAdvisory["impact"] {
    if (!impact) return "moderate";
    const lower = impact.toLowerCase();
    if (lower.includes("critical")) return "critical";
    if (lower.includes("high")) return "high";
    if (lower.includes("moderate")) return "moderate";
    if (lower.includes("low")) return "low";
    return "moderate";
  }

  /**
   * Get all CVEs for a specific Firefox version
   */
  getVulnerabilitiesForVersion(
    version: string,
    product: string,
    advisories: MozillaAdvisory[]
  ): MozillaVulnerability[] {
    const pattern = PRODUCT_PATTERNS[product];
    if (!pattern) return [];

    const vulns: MozillaVulnerability[] = [];

    for (const advisory of advisories) {
      // Check if this version is affected
      let fixedVersion: string | null = null;
      for (const productStr of advisory.products) {
        const match = productStr.match(pattern);
        if (match && match[1]) {
          fixedVersion = match[1];
          break;
        }
      }

      if (fixedVersion && this.compareVersions(version, fixedVersion) < 0) {
        // Version is older than fixed version, so affected
        vulns.push(...advisory.vulnerabilities);
      }
    }

    return vulns;
  }

  /**
   * Check if a version is safe
   */
  isVersionSafe(version: string, product: string, advisories: MozillaAdvisory[]): boolean {
    const affecting = this.getVulnerabilitiesForVersion(version, product, advisories);
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
  const fetcher = new MozillaAdvisoryFetcher(dataDir);

  const product = process.argv[2] || "firefox";
  console.log(`Fetching Mozilla advisories for: ${product}`);

  try {
    const result = await fetcher.fetchProductAdvisories(product);
    console.log(`\nFound ${result.advisories.length} advisories`);
    console.log(`Minimum Safe Version: ${result.msv || "Not determined"}`);

    if (result.advisories.length > 0) {
      console.log("\nRecent advisories:");
      for (const adv of result.advisories.slice(0, 5)) {
        console.log(`  ${adv.mfsa}: ${adv.title} [${adv.impact}]`);
        console.log(`    Products: ${adv.products.join(", ")}`);
        console.log(`    CVEs: ${adv.vulnerabilities.length}`);
      }
    }

    // Test version check
    const testVersion = "132.0";
    const affecting = fetcher.getVulnerabilitiesForVersion(testVersion, product, result.advisories);
    console.log(`\nVulnerabilities affecting ${product} ${testVersion}: ${affecting.length}`);
    if (affecting.length > 0) {
      for (const v of affecting.slice(0, 3)) {
        console.log(`  ${v.cve}: ${v.title} [${v.impact}]`);
      }
    }
  } catch (error) {
    console.error("Error:", error);
  }
}
