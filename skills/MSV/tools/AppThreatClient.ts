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
import { existsSync, statSync, mkdirSync, renameSync, rmSync, readFileSync } from "node:fs";
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
      return this.downloadDatabase(verbose);
    }

    return false; // No update needed
  }

  /**
   * Download/update the database atomically.
   *
   * Strategy: pull + extract into an isolated STAGING directory, validate the
   * result, then atomically rename the files over the live database. An
   * interrupted or killed download/extract can therefore never corrupt the live
   * DB — the worst case is a discarded staging directory and the previous
   * (valid) DB staying in place.
   *
   * This replaces a prior in-place design where `vdb --download-image` wrote
   * data.vdb6 directly and a 3-minute timeout killed it mid-extraction, leaving
   * a truncated ("database disk image is malformed") live file.
   */
  private async downloadDatabase(verbose: boolean = false): Promise<boolean> {
    const staging = join(DEFAULT_VDB_DIR, `.staging-${process.pid}-${Date.now()}`);

    try {
      try {
        mkdirSync(staging, { recursive: true });
      } catch {
        if (verbose) console.error("Could not create staging directory for AppThreat download.");
        return false;
      }

      // Pull into staging only (never the live dir).
      //  - vdb honors the VDB_HOME env var, so it downloads + extracts into staging.
      //  - oras pulls the compressed layers, which we then extract ourselves.
      let pulled = await this.tryVdbCli(staging, verbose);
      if (!pulled) pulled = await this.tryOrasDownload(staging, verbose);

      if (!pulled) {
        this.printInstallInstructions(verbose);
        return false;
      }

      // Validate the staged DB before it goes anywhere near the live files.
      if (!this.validateDatabaseDir(staging, verbose)) {
        if (verbose) {
          console.error(
            "Downloaded AppThreat database failed validation — discarding, keeping existing DB.",
          );
        }
        return false;
      }

      // Atomic swap into place (same filesystem → rename is atomic).
      this.swapIntoPlace(staging, verbose);
      if (verbose) console.log("AppThreat database updated and validated.");
      return true;
    } finally {
      try {
        rmSync(staging, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
  }

  /** Print manual install/download guidance when all automated paths fail. */
  private printInstallInstructions(verbose: boolean): void {
    if (!verbose) return;
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

  /**
   * Validate a staged database directory before swapping it into place.
   * Catches truncated/corrupt extracts (SQLite throws while scanning) and
   * incomplete extracts (row counts short of vdb.meta's expected totals).
   */
  private validateDatabaseDir(dir: string, verbose: boolean): boolean {
    const dataPath = join(dir, DATA_FILE);
    const indexPath = join(dir, INDEX_FILE);

    if (!existsSync(dataPath) || !existsSync(indexPath)) {
      if (verbose) console.error("Staged database is missing data/index file.");
      return false;
    }

    // Expected row counts from the staged meta (completeness check). Optional.
    let expectedData = 0;
    let expectedIndex = 0;
    try {
      const meta = JSON.parse(readFileSync(join(dir, META_FILE), "utf8"));
      expectedData = Number(meta.cve_data_count) || 0;
      expectedIndex = Number(meta.cve_index_count) || 0;
    } catch {
      /* meta is optional — fall back to a non-empty check */
    }

    let dataDb: Database | null = null;
    let indexDb: Database | null = null;
    try {
      dataDb = new Database(dataPath, { readonly: true });
      indexDb = new Database(indexPath, { readonly: true });

      // count(*) scans the whole table b-tree — a truncated file throws here.
      const dataCount = (dataDb.query("SELECT count(*) AS n FROM cve_data").get() as { n: number }).n;
      const indexCount = (indexDb.query("SELECT count(*) AS n FROM cve_index").get() as { n: number }).n;

      if (dataCount <= 0 || indexCount <= 0) {
        if (verbose) console.error(`Staged database is empty (data=${dataCount}, index=${indexCount}).`);
        return false;
      }
      if (expectedData && dataCount < expectedData) {
        if (verbose) console.error(`Staged cve_data incomplete: ${dataCount}/${expectedData}.`);
        return false;
      }
      if (expectedIndex && indexCount < expectedIndex) {
        if (verbose) console.error(`Staged cve_index incomplete: ${indexCount}/${expectedIndex}.`);
        return false;
      }
      return true;
    } catch (err) {
      if (verbose) {
        console.error(
          `Staged database failed to open/query: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return false;
    } finally {
      try { dataDb?.close(); } catch { /* ignore */ }
      try { indexDb?.close(); } catch { /* ignore */ }
    }
  }

  /**
   * Atomically move validated staged files over the live database.
   * Each rename is atomic on the same filesystem; on Windows a rename over an
   * open/existing target can fail, so we remove-then-rename as a fallback.
   */
  private swapIntoPlace(stagingDir: string, verbose: boolean): void {
    this.close(); // release any open handles on the live files first
    for (const f of [INDEX_FILE, DATA_FILE, META_FILE]) {
      const src = join(stagingDir, f);
      if (!existsSync(src)) continue;
      const dst = join(DEFAULT_VDB_DIR, f);
      try {
        renameSync(src, dst);
      } catch {
        try {
          rmSync(dst, { force: true });
          renameSync(src, dst);
        } catch (e) {
          if (verbose) {
            console.error(`Failed to swap ${f}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }
    }
  }

  /**
   * Try to download using vdb CLI or Python module
   */
  /** Forcefully kill a spawned process (Windows ignores SIGTERM for Python) */
  private forceKillProcess(proc: { pid?: number; kill: (signal?: string) => void }): void {
    try {
      if (proc.pid && process.platform === "win32") {
        const { spawnSync } = require("node:child_process");
        spawnSync("taskkill", ["/pid", String(proc.pid), "/f", "/t"], { stdio: "ignore", windowsHide: true });
      } else {
        proc.kill("SIGKILL");
      }
    } catch { /* already dead */ }
  }

  private async tryVdbCli(targetDir: string, verbose: boolean): Promise<boolean> {
    const { spawn } = await import("node:child_process");

    // Generous timeout: a normal pull downloads ~310MB and extracts ~5.4GB, which
    // easily exceeds 3 minutes. A kill is now SAFE — vdb writes into the staging
    // dir (via VDB_HOME), never the live DB — so we can afford to wait.
    const DB_DOWNLOAD_TIMEOUT_MS = 600_000; // 10 min

    // Point vdb at the staging dir so it never touches the live database.
    const env = { ...process.env, VDB_HOME: targetDir };

    // First try the vdb command directly
    const vdbResult = await new Promise<boolean>((resolve) => {
      const vdbProcess = spawn("vdb", ["--download-image"], {
        stdio: verbose ? "inherit" : "pipe",
        shell: false, // Security: avoid shell injection
        windowsHide: true,
        env,
      });

      const timer = setTimeout(() => {
        if (verbose) console.log("vdb CLI timed out, killing (staging discarded)...");
        this.forceKillProcess(vdbProcess);
        resolve(false);
      }, DB_DOWNLOAD_TIMEOUT_MS);

      vdbProcess.on("close", (code) => {
        clearTimeout(timer);
        resolve(code === 0);
      });

      vdbProcess.on("error", () => {
        clearTimeout(timer);
        resolve(false);
      });
    });

    if (vdbResult) {
      if (verbose) console.log("AppThreat database downloaded via vdb (staged)");
      return true;
    }

    // Fallback: try running vdb via Python module (works when vdb not in PATH)
    if (verbose) console.log("Trying vdb via Python module...");

    // Security: Use array args instead of shell string to avoid injection
    const pythonArgs = [
      "-c",
      "import sys; sys.argv = ['vdb', '--download-image']; from vdb.cli import main; main()"
    ];

    return new Promise((resolve) => {
      const pythonProcess = spawn("python", pythonArgs, {
        stdio: "pipe", // Always pipe — Python tracebacks (e.g. blocked DLLs) must not bleed into stdout
        shell: false, // Security: avoid shell injection
        windowsHide: true,
        env,
      });

      const timer = setTimeout(() => {
        if (verbose) console.log("Python vdb module timed out, killing (staging discarded)...");
        this.forceKillProcess(pythonProcess);
        resolve(false);
      }, DB_DOWNLOAD_TIMEOUT_MS);

      pythonProcess.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) {
          if (verbose) console.log("AppThreat database downloaded via Python (staged)");
          resolve(true);
        } else {
          resolve(false);
        }
      });

      pythonProcess.on("error", () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
  }

  /**
   * Try to download using oras CLI directly.
   * oras pulls the COMPRESSED layers (data.vdb6.tar.xz, data.index.vdb6.tar.xz)
   * into the target dir; we then extract them ourselves into usable .vdb6 files.
   * (Previously this pulled the layers but never extracted them, so oras alone
   * could not produce a working database.)
   */
  private async tryOrasDownload(targetDir: string, verbose: boolean): Promise<boolean> {
    const { spawn } = await import("node:child_process");

    const ORAS_TIMEOUT_MS = 600_000; // 10 min — large download + we own the extract

    const pulled = await new Promise<boolean>((resolve) => {
      if (verbose) console.log("Attempting download via oras CLI...");

      const orasProcess = spawn(
        "oras",
        ["pull", "ghcr.io/appthreat/vdbxz-app:latest", "--output", targetDir],
        {
          stdio: verbose ? "inherit" : "pipe",
          shell: false, // Security: avoid shell injection
          windowsHide: true,
        }
      );

      const timer = setTimeout(() => {
        if (verbose) console.log("oras download timed out, killing (staging discarded)...");
        this.forceKillProcess(orasProcess);
        resolve(false);
      }, ORAS_TIMEOUT_MS);

      orasProcess.on("close", (code) => {
        clearTimeout(timer);
        resolve(code === 0);
      });

      orasProcess.on("error", () => {
        clearTimeout(timer);
        resolve(false);
      });
    });

    if (!pulled) return false;

    // Extract the compressed layers into usable .vdb6 files (inside staging).
    const layers = [
      join(targetDir, `${DATA_FILE}.tar.xz`),
      join(targetDir, `${INDEX_FILE}.tar.xz`),
    ];
    for (const layer of layers) {
      if (!existsSync(layer)) {
        if (verbose) console.error(`Expected layer missing after oras pull: ${layer}`);
        return false;
      }
      if (!(await this.extractTarXz(layer, targetDir, verbose))) {
        if (verbose) console.error(`Failed to extract layer: ${layer}`);
        return false;
      }
    }
    if (verbose) console.log("AppThreat layers extracted via oras + tar (staged)");
    return true;
  }

  /** Extract a .tar.xz archive into destDir using the system tar. */
  private async extractTarXz(archive: string, destDir: string, verbose: boolean): Promise<boolean> {
    const { spawn } = await import("node:child_process");
    const EXTRACT_TIMEOUT_MS = 600_000; // 10 min

    return new Promise((resolve) => {
      const proc = spawn("tar", ["-xf", archive, "-C", destDir], {
        stdio: verbose ? "inherit" : "pipe",
        shell: false, // Security: avoid shell injection
        windowsHide: true,
      });

      const timer = setTimeout(() => {
        if (verbose) console.log("tar extraction timed out, killing (staging discarded)...");
        this.forceKillProcess(proc);
        resolve(false);
      }, EXTRACT_TIMEOUT_MS);

      proc.on("close", (code) => {
        clearTimeout(timer);
        resolve(code === 0);
      });

      proc.on("error", () => {
        clearTimeout(timer);
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
    // Strip CPE 2.3 backslash escapes (e.g., notepad\+\+ → notepad++)
    const cpeParts = cpe.split(":");
    const vendor = (cpeParts[3] || "").replace(/\\(.)/g, "$1");
    const product = (cpeParts[4] || "").replace(/\\(.)/g, "$1");

    // Query index by name (product) with vendor-qualified filtering
    // Optionally exclude MAL-* entries (malware, not CVEs for the product itself)
    const malwareFilter = excludeMalware ? "AND cve_id NOT LIKE 'MAL-%'" : "";

    // Strategy: vendor-qualified first (precise), then broad name, then vendor fallback
    // This prevents short product names (e.g., "git") from being swamped by noise
    // (gitlab, github, digital, etc.) when the LIMIT cuts off real results.
    let indexResults: { cve_id: string; vers: string; purl_prefix: string }[] = [];

    // 1. Vendor-qualified: name matches product AND purl_prefix contains vendor
    if (vendor && vendor !== product) {
      indexResults = this.indexDb!.query<
        { cve_id: string; vers: string; purl_prefix: string },
        [string, string, number]
      >(`
        SELECT DISTINCT cve_id, vers, purl_prefix
        FROM cve_index
        WHERE name LIKE ?
        AND purl_prefix LIKE ?
        ${malwareFilter}
        LIMIT ?
      `).all(`%${product}%`, `%${vendor}%`, limit);
    }

    // 2. Broad name search (original behavior) — only if vendor-qualified found nothing
    if (indexResults.length === 0) {
      indexResults = this.indexDb!.query<
        { cve_id: string; vers: string; purl_prefix: string },
        [string, number]
      >(`
        SELECT DISTINCT cve_id, vers, purl_prefix
        FROM cve_index
        WHERE name LIKE ?
        ${malwareFilter}
        LIMIT ?
      `).all(`%${product}%`, limit);
    }

    // 3. Vendor fallback via purl_prefix (e.g., "notepad" for "notepad++")
    if (indexResults.length === 0 && vendor) {
      indexResults = this.indexDb!.query<
        { cve_id: string; vers: string; purl_prefix: string },
        [string, number]
      >(`
        SELECT DISTINCT cve_id, vers, purl_prefix
        FROM cve_index
        WHERE purl_prefix LIKE ?
        ${malwareFilter}
        LIMIT ?
      `).all(`%${vendor}%`, limit);
    }

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
