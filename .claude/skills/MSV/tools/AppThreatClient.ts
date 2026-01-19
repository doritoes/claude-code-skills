/**
 * AppThreatClient.ts - AppThreat vulnerability-db SQLite Client
 *
 * Provides offline vulnerability queries using AppThreat's pre-built SQLite database.
 * Database: ghcr.io/appthreat/vdbxz-app (apps-only, ~700MB compressed)
 *
 * Features:
 * - Offline queries (no API rate limits)
 * - Multi-source data (NVD + OSV + GitHub advisories)
 * - CVE 5.2 schema compliance
 * - VERS format for version ranges
 *
 * Admiralty Rating: B2 (Usually Reliable, Probably True - Multiple aggregated sources)
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

import { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";

// =============================================================================
// Types
// =============================================================================

export interface AppThreatConfig {
  /** Path to data.vdb6 (main database) */
  databasePath: string;
  /** Path to data.index.vdb6 (index database) */
  indexPath: string;
  /** Maximum age in days before considering stale */
  maxAgeDays: number;
}

export interface VulnResult {
  cveId: string;
  description: string;
  fixedVersion: string | null;
  affectedVersions: string;
  severity: string | null;
  cvssScore: number | null;
  sources: string[];
  purlPrefix: string | null;
}

export interface AppThreatMetadata {
  createdUtc: string;
  cveDataCount: number;
  cveIndexCount: number;
  sources: string[];
  appOnly: boolean;
  startYear: number;
}

interface CVE52Container {
  cna?: {
    descriptions?: Array<{ lang: string; value: string }>;
    metrics?: Array<{
      cvssV3_1?: { baseScore: number; baseSeverity: string };
      cvssV3_0?: { baseScore: number; baseSeverity: string };
    }>;
    affected?: Array<{
      versions?: Array<{
        version: string;
        status: string;
        lessThan?: string;
        lessThanOrEqual?: string;
      }>;
    }>;
  };
}

interface CVE52Record {
  dataType: string;
  dataVersion: string;
  cveMetadata: {
    cveId: string;
    state?: string;
  };
  containers: CVE52Container;
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_VDB_DIR = join(homedir(), "AppData", "Local", "vdb", "vdb");
const DATA_FILE = "data.vdb6";
const INDEX_FILE = "data.index.vdb6";
const META_FILE = "vdb.meta";

// =============================================================================
// VERS Parser
// =============================================================================

/**
 * Parse VERS format to extract fix version
 * Examples:
 *   vers:putty/>=0.68|<0.81 -> fix: 0.81
 *   vers:putty/<0.75 -> fix: 0.75
 *   vers:generic/>=1.0|<=2.0 -> fix: > 2.0
 */
function parseVersForFixVersion(vers: string): string | null {
  if (!vers) return null;

  // Remove vers: prefix and type
  const match = vers.match(/vers:[^/]+\/(.+)/);
  if (!match) return null;

  const constraints = match[1];

  // Look for <X.Y.Z pattern (fix version is X.Y.Z)
  const lessThanMatch = constraints.match(/<(\d+(?:\.\d+)*)/);
  if (lessThanMatch) {
    return lessThanMatch[1];
  }

  // Look for <=X.Y.Z pattern (fix version is > X.Y.Z)
  const lessThanEqMatch = constraints.match(/<=(\d+(?:\.\d+)*)/);
  if (lessThanEqMatch) {
    return `> ${lessThanEqMatch[1]}`;
  }

  return null;
}

/**
 * Parse VERS format to extract affected version range as human-readable string
 */
function parseVersForAffectedRange(vers: string): string {
  if (!vers) return "unknown";

  const match = vers.match(/vers:[^/]+\/(.+)/);
  if (!match) return vers;

  return match[1]
    .replace(/\|/g, " AND ")
    .replace(/</g, "< ")
    .replace(/>/g, "> ")
    .replace(/!=/g, "!= ");
}

// =============================================================================
// Client
// =============================================================================

export class AppThreatClient {
  private config: AppThreatConfig;
  private indexDb: Database | null = null;
  private dataDb: Database | null = null;

  constructor(config?: Partial<AppThreatConfig>) {
    const vdbDir = DEFAULT_VDB_DIR;

    this.config = {
      databasePath: config?.databasePath || join(vdbDir, DATA_FILE),
      indexPath: config?.indexPath || join(vdbDir, INDEX_FILE),
      maxAgeDays: config?.maxAgeDays || 2, // 48 hours default
    };
  }

  /**
   * Check if the database exists and is accessible
   */
  isDatabaseAvailable(): boolean {
    return (
      existsSync(this.config.indexPath) && existsSync(this.config.databasePath)
    );
  }

  /**
   * Check if the database needs update (older than maxAgeDays)
   */
  needsUpdate(): boolean {
    if (!this.isDatabaseAvailable()) return true;

    const metaPath = join(DEFAULT_VDB_DIR, META_FILE);
    if (!existsSync(metaPath)) return true;

    try {
      const stats = statSync(this.config.databasePath);
      const ageMs = Date.now() - stats.mtimeMs;
      const ageDays = ageMs / (1000 * 60 * 60 * 24);
      return ageDays > this.config.maxAgeDays;
    } catch {
      // Database stat failed - assume needs update
      return true;
    }
  }

  /**
   * Get database age in hours
   */
  getDatabaseAgeHours(): number | null {
    if (!this.isDatabaseAvailable()) return null;

    try {
      const stats = statSync(this.config.databasePath);
      const ageMs = Date.now() - stats.mtimeMs;
      return ageMs / (1000 * 60 * 60);
    } catch {
      return null;
    }
  }

  /**
   * Auto-update database if older than threshold (default 48 hours)
   * Returns true if update was performed, false otherwise
   */
  async ensureFreshDatabase(maxAgeHours: number = 48, verbose: boolean = false): Promise<boolean> {
    // Check if database exists
    if (!this.isDatabaseAvailable()) {
      if (verbose) console.log("AppThreat database not found, downloading...");
      return this.downloadDatabase(verbose);
    }

    // Check age
    const ageHours = this.getDatabaseAgeHours();
    if (ageHours === null || ageHours > maxAgeHours) {
      if (verbose) {
        const ageStr = ageHours ? `${Math.round(ageHours)} hours old` : "age unknown";
        console.log(`AppThreat database ${ageStr}, updating...`);
      }
      return this.downloadDatabase(verbose);
    }

    return false; // No update needed
  }

  /**
   * Download/update the database using vdb CLI or oras directly
   */
  private async downloadDatabase(verbose: boolean = false): Promise<boolean> {
    const { spawn, execSync } = await import("node:child_process");
    const { mkdirSync } = await import("node:fs");

    // First, try using vdb CLI
    const vdbResult = await this.tryVdbCli(verbose);
    if (vdbResult) return true;

    // If vdb fails, try oras directly (more likely to be available)
    const orasResult = await this.tryOrasDownload(verbose);
    if (orasResult) return true;

    // Both methods failed - provide clear installation guidance
    if (verbose) {
      console.error("\n" + "=".repeat(60));
      console.error("AppThreat Database Installation Required");
      console.error("=".repeat(60));
      console.error("\nOption 1: Install vdb CLI (recommended)");
      console.error("  pip install appthreat-vulnerability-db[oras]");
      console.error("  vdb --download-image");
      console.error("\nOption 2: Install oras CLI and download manually");
      console.error("  winget install oras");
      console.error("  # or: choco install oras");
      console.error("  oras pull ghcr.io/appthreat/vdbxz-app:latest");
      console.error("\nOption 3: Use pipx (isolated environment)");
      console.error("  pipx install appthreat-vulnerability-db[oras]");
      console.error("  vdb --download-image");
      console.error("\nThe database will be stored in:");
      console.error(`  ${DEFAULT_VDB_DIR}`);
      console.error("=".repeat(60) + "\n");
    }

    return false;
  }

  /**
   * Try to download using vdb CLI or Python module
   */
  private async tryVdbCli(verbose: boolean): Promise<boolean> {
    const { spawn } = await import("node:child_process");

    // First try the vdb command directly
    const vdbResult = await new Promise<boolean>((resolve) => {
      const vdbProcess = spawn("vdb", ["--download-image"], {
        stdio: verbose ? "inherit" : "pipe",
        shell: true,
      });

      vdbProcess.on("close", (code) => {
        resolve(code === 0);
      });

      vdbProcess.on("error", () => {
        resolve(false);
      });
    });

    if (vdbResult) {
      if (verbose) console.log("AppThreat database updated successfully via vdb");
      return true;
    }

    // Fallback: try running vdb via Python module (works when vdb not in PATH)
    if (verbose) console.log("Trying vdb via Python module...");

    const pythonCmd = `python -c "import sys; sys.argv = ['vdb', '--download-image']; from vdb.cli import main; main()"`;

    return new Promise((resolve) => {
      const pythonProcess = spawn(pythonCmd, [], {
        stdio: verbose ? "inherit" : "pipe",
        shell: true,
      });

      pythonProcess.on("close", (code) => {
        if (code === 0) {
          if (verbose) console.log("AppThreat database updated successfully via Python");
          resolve(true);
        } else {
          resolve(false);
        }
      });

      pythonProcess.on("error", () => {
        resolve(false);
      });
    });
  }

  /**
   * Try to download using oras CLI directly
   */
  private async tryOrasDownload(verbose: boolean): Promise<boolean> {
    const { spawn } = await import("node:child_process");
    const { mkdirSync, existsSync, renameSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");

    // Ensure target directory exists
    if (!existsSync(DEFAULT_VDB_DIR)) {
      try {
        mkdirSync(DEFAULT_VDB_DIR, { recursive: true });
      } catch {
        return false;
      }
    }

    return new Promise((resolve) => {
      if (verbose) console.log("Attempting download via oras CLI...");

      // oras pull downloads to current directory, so we need to cd first
      const orasProcess = spawn(
        "oras",
        ["pull", "ghcr.io/appthreat/vdbxz-app:latest", "--output", DEFAULT_VDB_DIR],
        {
          stdio: verbose ? "inherit" : "pipe",
          shell: true,
        }
      );

      orasProcess.on("close", (code) => {
        if (code === 0) {
          if (verbose) console.log("AppThreat database downloaded successfully via oras");
          resolve(true);
        } else {
          resolve(false);
        }
      });

      orasProcess.on("error", () => {
        resolve(false);
      });
    });
  }

  /**
   * Get database metadata
   */
  getMetadata(): AppThreatMetadata | null {
    const metaPath = join(DEFAULT_VDB_DIR, META_FILE);
    if (!existsSync(metaPath)) return null;

    try {
      const content = Bun.file(metaPath).text();
      // Parse the metadata file (it's a simple key-value format)
      // For now, return basic info from file stats
      const stats = statSync(this.config.databasePath);
      return {
        createdUtc: stats.mtime.toISOString(),
        cveDataCount: 0, // Would need to parse meta file
        cveIndexCount: 0,
        sources: ["AquaSource", "OSVSource", "GitHubSource"],
        appOnly: true,
        startYear: 2018,
      };
    } catch {
      // Metadata read failed - return null (database may not exist)
      return null;
    }
  }

  /**
   * Get database file sizes
   */
  getDatabaseSize(): { dataSize: number; indexSize: number; totalMB: number } {
    try {
      const dataStats = statSync(this.config.databasePath);
      const indexStats = statSync(this.config.indexPath);
      const totalBytes = dataStats.size + indexStats.size;
      return {
        dataSize: dataStats.size,
        indexSize: indexStats.size,
        totalMB: Math.round(totalBytes / (1024 * 1024)),
      };
    } catch {
      // Stat failed - return zeros (database may not exist)
      return { dataSize: 0, indexSize: 0, totalMB: 0 };
    }
  }

  /**
   * Open database connections
   */
  private openDatabases(): void {
    if (!this.isDatabaseAvailable()) {
      throw new Error(
        `AppThreat database not found. Run: vdb --download-image`
      );
    }

    if (!this.indexDb) {
      this.indexDb = new Database(this.config.indexPath, { readonly: true });
    }
    if (!this.dataDb) {
      this.dataDb = new Database(this.config.databasePath, { readonly: true });
    }
  }

  /**
   * Close database connections
   */
  close(): void {
    if (this.indexDb) {
      this.indexDb.close();
      this.indexDb = null;
    }
    if (this.dataDb) {
      this.dataDb.close();
      this.dataDb = null;
    }
  }

  /**
   * Search vulnerabilities by CPE
   */
  async searchByCpe(
    cpe: string,
    options: { minCvss?: number; limit?: number; excludeMalware?: boolean } = {}
  ): Promise<VulnResult[]> {
    const { minCvss = 0, limit = 50, excludeMalware = true } = options;

    this.openDatabases();

    // Extract vendor and product from CPE
    // cpe:2.3:a:vendor:product:version:...
    const cpeParts = cpe.split(":");
    const vendor = cpeParts[3] || "";
    const product = cpeParts[4] || "";

    // Query index by name (product)
    // Optionally exclude MAL-* entries (malware, not CVEs for the product itself)
    const malwareFilter = excludeMalware ? "AND cve_id NOT LIKE 'MAL-%'" : "";
    const indexResults = this.indexDb!.query<
      { cve_id: string; vers: string; purl_prefix: string },
      [string, number]
    >(`
      SELECT DISTINCT cve_id, vers, purl_prefix
      FROM cve_index
      WHERE name LIKE ?
      ${malwareFilter}
      LIMIT ?
    `).all(`%${product}%`, limit);

    if (indexResults.length === 0) {
      return [];
    }

    // Get full CVE data for each result using json_extract (JSONB format)
    const results: VulnResult[] = [];

    for (const indexRow of indexResults) {
      // Use json_extract to read JSONB data directly
      const dataRow = this.dataDb!.query<
        {
          description: string | null;
          cvss_score: number | null;
          severity: string | null;
        },
        [string]
      >(`
        SELECT
          json_extract(source_data, '$.containers.cna.descriptions[0].value') as description,
          COALESCE(
            json_extract(source_data, '$.containers.cna.metrics[0].cvssV3_1.baseScore'),
            json_extract(source_data, '$.containers.cna.metrics[0].cvssV3_0.baseScore')
          ) as cvss_score,
          COALESCE(
            json_extract(source_data, '$.containers.cna.metrics[0].cvssV3_1.baseSeverity'),
            json_extract(source_data, '$.containers.cna.metrics[0].cvssV3_0.baseSeverity')
          ) as severity
        FROM cve_data
        WHERE cve_id = ?
        LIMIT 1
      `).get(indexRow.cve_id);

      if (!dataRow) continue;

      const description = dataRow.description || "No description available";
      const cvssScore = dataRow.cvss_score;
      const severity = dataRow.severity;

      // Filter by minimum CVSS
      if (minCvss > 0 && (cvssScore === null || cvssScore < minCvss)) {
        continue;
      }

      // Parse fix version from VERS
      const fixedVersion = parseVersForFixVersion(indexRow.vers);
      const affectedVersions = parseVersForAffectedRange(indexRow.vers);

      results.push({
        cveId: indexRow.cve_id,
        description,
        fixedVersion,
        affectedVersions,
        severity,
        cvssScore,
        sources: ["AppThreat"],
        purlPrefix: indexRow.purl_prefix,
      });
    }

    // Sort by CVSS score descending
    results.sort((a, b) => (b.cvssScore || 0) - (a.cvssScore || 0));

    return results;
  }

  /**
   * Search vulnerabilities by product name (keyword search)
   */
  async searchByKeyword(
    keyword: string,
    options: { minCvss?: number; limit?: number } = {}
  ): Promise<VulnResult[]> {
    // Use same logic as CPE search but with keyword
    return this.searchByCpe(`cpe:2.3:a:*:${keyword}:*`, options);
  }

  /**
   * Search vulnerabilities by PURL (Package URL)
   */
  async searchByPurl(
    purl: string,
    options: { minCvss?: number; limit?: number } = {}
  ): Promise<VulnResult[]> {
    const { minCvss = 0, limit = 50 } = options;

    this.openDatabases();

    // Query index by purl_prefix
    const indexResults = this.indexDb!.query<
      { cve_id: string; vers: string; purl_prefix: string },
      [string, number]
    >(`
      SELECT DISTINCT cve_id, vers, purl_prefix
      FROM cve_index
      WHERE purl_prefix LIKE ?
      LIMIT ?
    `).all(`%${purl}%`, limit);

    if (indexResults.length === 0) {
      return [];
    }

    // Get full CVE data using json_extract
    const results: VulnResult[] = [];

    for (const indexRow of indexResults) {
      const dataRow = this.dataDb!.query<
        {
          description: string | null;
          cvss_score: number | null;
          severity: string | null;
        },
        [string]
      >(`
        SELECT
          json_extract(source_data, '$.containers.cna.descriptions[0].value') as description,
          COALESCE(
            json_extract(source_data, '$.containers.cna.metrics[0].cvssV3_1.baseScore'),
            json_extract(source_data, '$.containers.cna.metrics[0].cvssV3_0.baseScore')
          ) as cvss_score,
          COALESCE(
            json_extract(source_data, '$.containers.cna.metrics[0].cvssV3_1.baseSeverity'),
            json_extract(source_data, '$.containers.cna.metrics[0].cvssV3_0.baseSeverity')
          ) as severity
        FROM cve_data
        WHERE cve_id = ?
        LIMIT 1
      `).get(indexRow.cve_id);

      if (!dataRow) continue;

      const description = dataRow.description || "No description available";
      const cvssScore = dataRow.cvss_score;
      const severity = dataRow.severity;

      if (minCvss > 0 && (cvssScore === null || cvssScore < minCvss)) {
        continue;
      }

      const fixedVersion = parseVersForFixVersion(indexRow.vers);
      const affectedVersions = parseVersForAffectedRange(indexRow.vers);

      results.push({
        cveId: indexRow.cve_id,
        description,
        fixedVersion,
        affectedVersions,
        severity,
        cvssScore,
        sources: ["AppThreat"],
        purlPrefix: indexRow.purl_prefix,
      });
    }

    results.sort((a, b) => (b.cvssScore || 0) - (a.cvssScore || 0));

    return results;
  }

  /**
   * Get a specific CVE by ID
   */
  async getCve(cveId: string): Promise<VulnResult | null> {
    this.openDatabases();

    const indexRow = this.indexDb!.query<
      { cve_id: string; vers: string; purl_prefix: string },
      [string]
    >(`
      SELECT cve_id, vers, purl_prefix
      FROM cve_index
      WHERE cve_id = ?
      LIMIT 1
    `).get(cveId);

    if (!indexRow) return null;

    const dataRow = this.dataDb!.query<
      {
        description: string | null;
        cvss_score: number | null;
        severity: string | null;
      },
      [string]
    >(`
      SELECT
        json_extract(source_data, '$.containers.cna.descriptions[0].value') as description,
        COALESCE(
          json_extract(source_data, '$.containers.cna.metrics[0].cvssV3_1.baseScore'),
          json_extract(source_data, '$.containers.cna.metrics[0].cvssV3_0.baseScore')
        ) as cvss_score,
        COALESCE(
          json_extract(source_data, '$.containers.cna.metrics[0].cvssV3_1.baseSeverity'),
          json_extract(source_data, '$.containers.cna.metrics[0].cvssV3_0.baseSeverity')
        ) as severity
      FROM cve_data
      WHERE cve_id = ?
      LIMIT 1
    `).get(cveId);

    if (!dataRow) return null;

    return {
      cveId: indexRow.cve_id,
      description: dataRow.description || "No description available",
      fixedVersion: parseVersForFixVersion(indexRow.vers),
      affectedVersions: parseVersForAffectedRange(indexRow.vers),
      severity: dataRow.severity,
      cvssScore: dataRow.cvss_score,
      sources: ["AppThreat"],
      purlPrefix: indexRow.purl_prefix,
    };
  }

  /**
   * Get Admiralty rating for AppThreat source
   */
  getAdmiraltyRating(): { reliability: "B"; credibility: 2 } {
    // B2: Usually Reliable, Probably True
    // - Multiple aggregated sources (NVD, OSV, GitHub)
    // - Pre-processed and validated data
    // - Regular updates (6-hour refresh cycle)
    return { reliability: "B", credibility: 2 };
  }
}

/**
 * Check if a string looks like a valid software version
 * Rejects git commit hashes, plain numbers, and other non-version strings
 */
function isValidVersion(version: string): boolean {
  // Must contain at least one dot (e.g., "5.13", "6.3.3")
  if (!version.includes(".")) return false;

  // Reject if it looks like a git commit hash (40 hex chars or prefix)
  if (/^[0-9a-f]{7,40}$/i.test(version)) return false;

  // Reject if it contains hash-like segments (e.g., "49d876f2c5fc")
  if (/[a-f]{4,}/i.test(version)) return false;

  // Must start with a digit
  if (!/^\d/.test(version)) return false;

  // Reject versions that are too long (likely garbage data)
  if (version.length > 20) return false;

  return true;
}

export function getMinimumSafeVersion(results: VulnResult[]): string | null {
  const fixedVersions: string[] = [];

  for (const result of results) {
    if (result.fixedVersion &&
        !result.fixedVersion.startsWith(">") &&
        isValidVersion(result.fixedVersion)) {
      fixedVersions.push(result.fixedVersion);
    }
  }

  if (fixedVersions.length === 0) return null;

  // Sort versions and return the highest (minimum safe version)
  fixedVersions.sort((a, b) => {
    const partsA = a.split(".").map((p) => parseInt(p, 10) || 0);
    const partsB = b.split(".").map((p) => parseInt(p, 10) || 0);
    const maxLen = Math.max(partsA.length, partsB.length);
    for (let i = 0; i < maxLen; i++) {
      const partA = partsA[i] || 0;
      const partB = partsB[i] || 0;
      if (partA !== partB) return partA - partB;
    }
    return 0;
  });

  return fixedVersions[fixedVersions.length - 1];
}
