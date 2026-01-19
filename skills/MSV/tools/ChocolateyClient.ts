/**
 * ChocolateyClient - Fetches latest software versions from Chocolatey
 *
 * Chocolatey is a package manager for Windows that has version info for
 * most popular software. We use their public API to get latest versions.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";

// Mapping from MSV catalog software IDs to Chocolatey package IDs
const CHOCO_PACKAGE_MAP: Record<string, string> = {
  // Browsers
  "chrome": "googlechrome",
  "edge": "microsoft-edge",
  "firefox": "firefox",
  "brave": "brave",
  "opera": "opera",

  // Compression
  "7zip": "7zip",
  "winrar": "winrar",
  "peazip": "peazip",

  // PDF
  "foxit": "foxitreader",

  // Remote Access
  "putty": "putty",
  "winscp": "winscp",
  "teamviewer": "teamviewer",
  "anydesk": "anydesk",
  "mobaxterm": "mobaxterm",

  // Utilities
  "notepad": "notepadplusplus",
  "vscode": "vscode",
  "git": "git",
  "nodejs": "nodejs",
  "python": "python",

  // Media
  "vlc": "vlc",
  "irfanview": "irfanview",
  "obs": "obs-studio",
  "handbrake": "handbrake",
  "audacity": "audacity",

  // Security
  "keepass": "keepass",
  "bitwarden": "bitwarden",
  "malwarebytes": "malwarebytes",

  // Development
  "docker": "docker-desktop",
  "terraform": "terraform",
  "postman": "postman",

  // Databases
  "postgresql": "postgresql",
  "mysql": "mysql",
  "mongodb": "mongodb",
  "redis": "redis-64",

  // Other
  "zoom": "zoom",
  "slack": "slack",
  "discord": "discord",
  "steam": "steam",
  "wireshark": "wireshark",
  "virtualbox": "virtualbox",
  "filezilla": "filezilla",
  "curl": "curl",
  "wget": "wget",
  "ccleaner": "ccleaner",
  "veracrypt": "veracrypt",
  "treesizefree": "treesizefree",
  "windirstat": "windirstat",
};

interface ChocolateyPackageInfo {
  packageId: string;
  version: string;
  title: string;
  lastUpdated: string;
}

interface CacheEntry {
  version: string;
  fetchedAt: string;
}

export class ChocolateyClient {
  private cacheDir: string;
  private cachePath: string;
  private cache: Record<string, CacheEntry>;
  private cacheMaxAgeHours: number = 24; // Cache for 24 hours

  constructor(cacheDir?: string) {
    this.cacheDir = cacheDir || resolve(dirname(import.meta.url.replace("file:///", "")), "../data");
    this.cachePath = resolve(this.cacheDir, "chocolatey_cache.json");
    this.cache = this.loadCache();
  }

  private loadCache(): Record<string, CacheEntry> {
    try {
      if (existsSync(this.cachePath)) {
        return JSON.parse(readFileSync(this.cachePath, "utf-8"));
      }
    } catch {
      // Cache corrupted, start fresh
    }
    return {};
  }

  private saveCache(): void {
    try {
      mkdirSync(dirname(this.cachePath), { recursive: true });
      writeFileSync(this.cachePath, JSON.stringify(this.cache, null, 2));
    } catch {
      // Ignore cache save errors
    }
  }

  private isCacheValid(entry: CacheEntry): boolean {
    const ageMs = Date.now() - new Date(entry.fetchedAt).getTime();
    const maxAgeMs = this.cacheMaxAgeHours * 60 * 60 * 1000;
    return ageMs < maxAgeMs;
  }

  /**
   * Get the Chocolatey package ID for a software
   */
  getPackageId(softwareId: string): string | null {
    return CHOCO_PACKAGE_MAP[softwareId.toLowerCase()] || null;
  }

  /**
   * Fetch latest version for a software from Chocolatey
   */
  async getLatestVersion(softwareId: string): Promise<string | null> {
    const packageId = this.getPackageId(softwareId);
    if (!packageId) {
      return null;
    }

    // Check cache first
    const cacheKey = packageId.toLowerCase();
    if (this.cache[cacheKey] && this.isCacheValid(this.cache[cacheKey])) {
      return this.cache[cacheKey].version;
    }

    try {
      // Chocolatey v2 API - FindPackagesById returns latest version first when sorted desc
      // Note: $ must be URL-encoded as %24 in the query string
      const url = `https://community.chocolatey.org/api/v2/FindPackagesById()?id=%27${packageId}%27&%24orderby=Version%20desc&%24top=1`;

      const response = await fetch(url, {
        headers: {
          "User-Agent": "MSV-Tool/1.0",
        },
        signal: AbortSignal.timeout(10000), // 10 second timeout
      });

      if (!response.ok) {
        return null;
      }

      const text = await response.text();

      // Parse the OData XML response for version
      // The response is XML/Atom format, extract version from <d:Version>
      const versionMatch = text.match(/<d:Version>([^<]+)<\/d:Version>/);
      if (versionMatch) {
        const version = versionMatch[1];

        // Cache the result
        this.cache[cacheKey] = {
          version,
          fetchedAt: new Date().toISOString(),
        };
        this.saveCache();

        return version;
      }
    } catch (error) {
      // Network error, timeout, etc.
    }

    return null;
  }

  /**
   * Batch fetch latest versions for multiple software
   */
  async getLatestVersions(softwareIds: string[]): Promise<Record<string, string | null>> {
    const results: Record<string, string | null> = {};

    // Process in parallel with concurrency limit
    const CONCURRENCY = 5;
    for (let i = 0; i < softwareIds.length; i += CONCURRENCY) {
      const batch = softwareIds.slice(i, i + CONCURRENCY);
      const promises = batch.map(async (id) => {
        results[id] = await this.getLatestVersion(id);
      });
      await Promise.all(promises);
    }

    return results;
  }

  /**
   * Clear the cache
   */
  clearCache(): void {
    this.cache = {};
    this.saveCache();
  }

  /**
   * Get cache stats
   */
  getCacheStats(): { total: number; valid: number; expired: number } {
    let valid = 0;
    let expired = 0;

    for (const entry of Object.values(this.cache)) {
      if (this.isCacheValid(entry)) {
        valid++;
      } else {
        expired++;
      }
    }

    return { total: Object.keys(this.cache).length, valid, expired };
  }
}

// Export the package map for use in catalog updates
export { CHOCO_PACKAGE_MAP };
