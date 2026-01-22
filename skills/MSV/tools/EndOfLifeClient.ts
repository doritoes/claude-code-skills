/**
 * EndOfLifeClient.ts - End-of-Life Date Fetcher
 *
 * Fetches end-of-life information from endoflife.date API.
 * Provides EOL dates, support status, and version cycle information.
 *
 * API Documentation: https://endoflife.date/docs/api
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Logger, LogLevel } from "./Logger";

// =============================================================================
// Types
// =============================================================================

/**
 * A version cycle from endoflife.date
 */
export interface EolCycle {
  cycle: string;           // Version cycle (e.g., "3.12", "8", "2024")
  releaseDate: string;     // Release date (YYYY-MM-DD)
  eol: string | boolean;   // EOL date or false if still supported
  latest: string;          // Latest version in this cycle
  latestReleaseDate: string; // Date of latest release
  lts?: boolean;           // Is this an LTS release?
  support?: string | boolean; // Active support end date
  extendedSupport?: string | boolean; // Extended support end date
  discontinued?: string | boolean; // Discontinued date
}

/**
 * Product information from endoflife.date
 */
export interface EolProduct {
  product: string;         // Product name (as used in API)
  cycles: EolCycle[];      // Version cycles
  fetchedAt: string;       // When this data was fetched
}

/**
 * EOL status for a specific version
 */
export interface EolStatus {
  product: string;
  version: string;
  cycle: string | null;
  isEol: boolean;
  eolDate: string | null;
  latestInCycle: string | null;
  isLts: boolean;
  supportEnds: string | null;
}

/**
 * Mapping from MSV catalog product names to endoflife.date product names
 */
export const PRODUCT_MAPPING: Record<string, string> = {
  // Browsers
  chrome: "chrome",
  edge_chromium: "microsoft-edge",
  firefox: "firefox",
  firefox_esr: "firefox",

  // Runtimes - Java
  jre: "oracle-jdk",
  jdk: "oracle-jdk",
  java: "oracle-jdk",
  "oracle-jdk": "oracle-jdk",
  "azul-zulu": "azul-zulu",
  "eclipse-temurin": "eclipse-temurin",
  "microsoft-openjdk": "microsoft-build-of-openjdk",
  "graalvm": "graalvm",

  // Runtimes - Other
  python: "python",
  python3: "python",
  nodejs: "nodejs",
  node: "nodejs",
  dotnet: "dotnet",
  dotnet_runtime: "dotnet",
  "365_apps": "microsoft-365",

  // Server software
  tomcat: "tomcat",
  http_server: "apache",
  nginx: "nginx",
  iis: "iis",
  internet_information_services: "iis",

  // Databases
  mysql: "mysql",
  postgresql: "postgresql",
  mongodb: "mongodb",
  redis: "redis",
  elasticsearch: "elasticsearch",
  sql_server: "mssqlserver",
  mssqlserver: "mssqlserver",
  oracle_database: "oracle-database",
  mariadb: "mariadb",
  neo4j: "neo4j",

  // Operating systems
  windows_10: "windows",
  windows_11: "windows",
  windows_server: "windows-server",

  // Container/virtualization
  docker_desktop: "docker-engine",
  docker: "docker-engine",
  kubernetes: "kubernetes",
  virtualbox: "virtualbox",

  // VMware products
  esxi: "esxi",
  vcenter: "vcenter",
  vcenter_server: "vcenter",
  vsphere: "vmware-vsphere",

  // Development tools
  git: "git",
  vscode: "visual-studio-code",
  visual_studio: "visual-studio",
  powershell: "powershell",
  powershell7: "powershell",

  // Libraries
  openssl: "openssl",
  curl: "curl",
  log4j: "log4j",

  // Enterprise software - Microsoft
  exchange_server: "exchange",
  sharepoint_server: "sharepoint",
  sharepoint: "sharepoint",

  // Enterprise software - Atlassian
  confluence: "confluence",
  jira: "jira-software",
  bitbucket: "bitbucket",
  bamboo: "bamboo",

  // Enterprise software - Other
  gitlab: "gitlab",
  jenkins: "jenkins",
  artifactory: "artifactory",
  nexus: "nexus",
  sonarqube: "sonarqube",
  keycloak: "keycloak",
  vault: "hashicorp-vault",

  // Security tools
  clamav: "clamav",

  // Networking
  haproxy: "haproxy",
  traefik: "traefik",
  consul: "consul",

  // Backup
  backup_and_replication: "veeam-backup-and-replication",

  // PHP/Ruby/Go
  php: "php",
  ruby: "ruby",
  go: "go",
  golang: "go",

  // Archive tools
  "7-zip": "7-zip",
};

// =============================================================================
// EndOfLifeClient
// =============================================================================

export class EndOfLifeClient {
  private baseUrl = "https://endoflife.date/api";
  private cacheDir: string;
  private cacheTtlMs: number;
  private logger: Logger;

  constructor(cacheDir?: string, cacheTtlHours = 24) {
    this.cacheDir = cacheDir || join(process.cwd(), ".msv-cache", "eol");
    this.cacheTtlMs = cacheTtlHours * 60 * 60 * 1000;
    this.logger = new Logger("EndOfLifeClient", LogLevel.INFO);

    if (!existsSync(this.cacheDir)) {
      mkdirSync(this.cacheDir, { recursive: true });
    }
  }

  /**
   * Get EOL data for a product
   */
  async getProduct(productName: string): Promise<EolProduct | null> {
    // Map MSV catalog name to endoflife.date name
    const eolProductName = PRODUCT_MAPPING[productName.toLowerCase()] || productName.toLowerCase();

    // Check cache first
    const cached = this.getCached(eolProductName);
    if (cached) {
      this.logger.debug(`Cache hit for ${eolProductName}`);
      return cached;
    }

    // Fetch from API
    try {
      const url = `${this.baseUrl}/${eolProductName}.json`;
      this.logger.debug(`Fetching ${url}`);

      const response = await fetch(url, {
        headers: {
          Accept: "application/json",
          "User-Agent": "MSV-Client/1.3.1",
        },
      });

      if (!response.ok) {
        if (response.status === 404) {
          this.logger.warn(`Product not found on endoflife.date: ${eolProductName}`);
          return null;
        }
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const cycles = (await response.json()) as EolCycle[];

      const product: EolProduct = {
        product: eolProductName,
        cycles,
        fetchedAt: new Date().toISOString(),
      };

      // Cache the result
      this.setCached(eolProductName, product);

      return product;
    } catch (error) {
      this.logger.error(`Failed to fetch EOL data for ${eolProductName}: ${error}`);
      return null;
    }
  }

  /**
   * Get EOL status for a specific version
   */
  async getVersionStatus(productName: string, version: string): Promise<EolStatus> {
    const product = await this.getProduct(productName);

    const result: EolStatus = {
      product: productName,
      version,
      cycle: null,
      isEol: false,
      eolDate: null,
      latestInCycle: null,
      isLts: false,
      supportEnds: null,
    };

    if (!product || !product.cycles.length) {
      return result;
    }

    // Find matching cycle
    const cycle = this.findCycle(product.cycles, version);
    if (!cycle) {
      return result;
    }

    result.cycle = cycle.cycle;
    result.latestInCycle = cycle.latest;
    result.isLts = cycle.lts || false;

    // Determine EOL status
    if (typeof cycle.eol === "boolean") {
      result.isEol = cycle.eol;
    } else if (typeof cycle.eol === "string") {
      result.eolDate = cycle.eol;
      result.isEol = new Date(cycle.eol) < new Date();
    }

    // Support end date
    if (typeof cycle.support === "string") {
      result.supportEnds = cycle.support;
    }

    return result;
  }

  /**
   * Get all available products from endoflife.date
   */
  async listProducts(): Promise<string[]> {
    try {
      const response = await fetch(`${this.baseUrl}/all.json`, {
        headers: {
          Accept: "application/json",
          "User-Agent": "MSV-Client/1.3.1",
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      return (await response.json()) as string[];
    } catch (error) {
      this.logger.error(`Failed to list products: ${error}`);
      return [];
    }
  }

  /**
   * Check if a product is tracked by endoflife.date
   */
  async isTracked(productName: string): Promise<boolean> {
    const eolProductName = PRODUCT_MAPPING[productName.toLowerCase()] || productName.toLowerCase();
    const products = await this.listProducts();
    return products.includes(eolProductName);
  }

  /**
   * Get the current LTS version for a product
   */
  async getCurrentLts(productName: string): Promise<string | null> {
    const product = await this.getProduct(productName);
    if (!product) return null;

    const today = new Date();

    // Find active LTS cycles (not EOL and marked as LTS)
    const activeLts = product.cycles.filter(cycle => {
      if (!cycle.lts) return false;

      if (typeof cycle.eol === "boolean") {
        return !cycle.eol;
      } else if (typeof cycle.eol === "string") {
        return new Date(cycle.eol) > today;
      }
      return true;
    });

    if (activeLts.length === 0) return null;

    // Return the latest LTS
    return activeLts[0].latest;
  }

  /**
   * Get cycles approaching EOL (within N days)
   */
  async getUpcomingEol(productName: string, daysAhead = 90): Promise<EolCycle[]> {
    const product = await this.getProduct(productName);
    if (!product) return [];

    const today = new Date();
    const futureDate = new Date(today.getTime() + daysAhead * 24 * 60 * 60 * 1000);

    return product.cycles.filter(cycle => {
      if (typeof cycle.eol !== "string") return false;
      const eolDate = new Date(cycle.eol);
      return eolDate > today && eolDate <= futureDate;
    });
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * Find the cycle that matches a version
   */
  private findCycle(cycles: EolCycle[], version: string): EolCycle | null {
    // Normalize version (remove leading 'v', etc.)
    const normalizedVersion = version.replace(/^v/i, "");

    // Extract major.minor from version
    const versionParts = normalizedVersion.split(".");
    const majorMinor = versionParts.slice(0, 2).join(".");
    const majorOnly = versionParts[0];

    // Try exact cycle match first
    for (const cycle of cycles) {
      if (cycle.cycle === normalizedVersion) return cycle;
      if (cycle.cycle === majorMinor) return cycle;
      if (cycle.cycle === majorOnly) return cycle;
    }

    // Try prefix match (version starts with cycle)
    for (const cycle of cycles) {
      if (normalizedVersion.startsWith(cycle.cycle + ".")) return cycle;
      if (normalizedVersion.startsWith(cycle.cycle)) return cycle;
    }

    // Try if version is within cycle range
    for (const cycle of cycles) {
      if (this.versionInCycle(normalizedVersion, cycle.cycle)) {
        return cycle;
      }
    }

    return null;
  }

  /**
   * Check if version belongs to a cycle
   */
  private versionInCycle(version: string, cycle: string): boolean {
    const versionParts = version.split(".").map(p => parseInt(p, 10) || 0);
    const cycleParts = cycle.split(".").map(p => parseInt(p, 10) || 0);

    // Compare major version
    if (versionParts[0] !== cycleParts[0]) return false;

    // If cycle has minor version, compare it
    if (cycleParts.length > 1 && versionParts[1] !== cycleParts[1]) return false;

    return true;
  }

  /**
   * Get cached product data
   */
  private getCached(productName: string): EolProduct | null {
    const cachePath = join(this.cacheDir, `${productName}.json`);

    if (!existsSync(cachePath)) return null;

    try {
      const data = JSON.parse(readFileSync(cachePath, "utf-8")) as EolProduct;

      // Check if cache is fresh
      const fetchedAt = new Date(data.fetchedAt).getTime();
      if (Date.now() - fetchedAt > this.cacheTtlMs) {
        return null; // Stale cache
      }

      return data;
    } catch {
      return null;
    }
  }

  /**
   * Cache product data
   */
  private setCached(productName: string, data: EolProduct): void {
    const cachePath = join(this.cacheDir, `${productName}.json`);
    writeFileSync(cachePath, JSON.stringify(data, null, 2));
  }
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Format EOL date for display
 */
export function formatEolDate(date: string | boolean | null | undefined): string {
  if (date === null || date === undefined) return "Unknown";
  if (typeof date === "boolean") return date ? "EOL" : "Active";

  const eolDate = new Date(date);
  const today = new Date();

  if (eolDate < today) {
    return `EOL (${date})`;
  }

  // Calculate days until EOL
  const daysUntil = Math.ceil((eolDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));

  if (daysUntil <= 30) {
    return `EOL in ${daysUntil} days (${date})`;
  } else if (daysUntil <= 90) {
    return `EOL soon (${date})`;
  }

  return `Active until ${date}`;
}

/**
 * Get EOL warning level
 */
export function getEolWarningLevel(eolDate: string | boolean | null): "critical" | "warning" | "info" | "none" {
  if (eolDate === null) return "none";
  if (typeof eolDate === "boolean") return eolDate ? "critical" : "none";

  const date = new Date(eolDate);
  const today = new Date();

  if (date < today) return "critical";

  const daysUntil = Math.ceil((date.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));

  if (daysUntil <= 30) return "critical";
  if (daysUntil <= 90) return "warning";
  if (daysUntil <= 180) return "info";

  return "none";
}

/**
 * Check if a version is the latest in its cycle
 */
export function isLatestInCycle(version: string, latestVersion: string): boolean {
  if (!latestVersion) return false;
  return version === latestVersion;
}
