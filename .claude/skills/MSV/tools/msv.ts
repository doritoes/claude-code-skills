#!/usr/bin/env bun
/**
 * msv.ts - Minimum Safe Version CLI
 *
 * Determines the lowest software version free of known-exploited vulnerabilities
 * for Windows 11/Server software using multiple intelligence sources.
 *
 * Usage:
 *   msv query "Google Chrome"           # Single query
 *   msv query "Edge" --format json      # JSON output
 *   msv batch software-list.txt         # Batch from file
 *   msv refresh                          # Force cache refresh
 *   msv list                             # Show supported software
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { homedir } from "node:os";
import { CisaKevClient, type KevEntry } from "./CisaKevClient";
import { VulnCheckClient, type VulnCheckCve } from "./VulnCheckClient";
import { EpssClient, type EpssScore } from "./EpssClient";
import {
  calculateAdmiraltyRating,
  calculateMsvRating,
  getRatingColor,
  getInlineRatingDescription,
  formatRatingWithDescription,
  RESET_COLOR,
  type AdmiraltyRating,
  type EvidenceSource,
  type MsvRatingInput,
} from "./AdmiraltyScoring";
import {
  generateAction,
  formatActionBox,
  type ActionGuidance,
  type ActionInput,
} from "./ActionGuidance";
import {
  calculateRiskScore,
  formatRiskScore,
  riskScoreToJson,
  type RiskScore,
  type RiskScoreInput,
} from "./RiskScoring";
import {
  findMinimumSafeVersion,
  compareVersions,
  sortVersions,
} from "./VersionCompare";
import { NvdClient, type VersionInfo } from "./NvdClient";
import { MsvCache, type MsvCacheEntry, type MsvBranch, type SourceResult } from "./MsvCache";
import { getVendorFetcher, type VendorAdvisoryResult } from "./VendorAdvisory";
import { parseFile, parseInput, parseDirectList, type SoftwareInput } from "./InputParser";
import { ChocolateyClient } from "./ChocolateyClient";
import {
  checkCompliance,
  generateSummary,
  formatComplianceText,
  formatComplianceCSV,
  formatComplianceJSON,
  formatSummaryText,
  getStatusSymbol,
  type ComplianceResult,
  type ComplianceStatus,
} from "./ComplianceChecker";
import {
  discoverSoftware,
  confirmAndAdd,
  type CpeMatch,
  type DiscoveryResult,
} from "./SoftwareDiscovery";
import {
  AppThreatClient,
  getMinimumSafeVersion as getAppThreatMsv,
  type VulnResult as AppThreatVulnResult,
} from "./AppThreatClient";
import { createLogger, type Logger } from "./Logger";

// =============================================================================
// Module Logger
// =============================================================================

/** Module-level logger instance - configure via configureLogger() */
const logger = createLogger({ level: "info" });

/** Configure logger based on CLI options */
function configureLogger(verbose: boolean): void {
  logger.setOptions({ verbose, level: verbose ? "debug" : "info" });
}

// =============================================================================
// Types
// =============================================================================

interface Config {
  paiDir: string;
  skillDir: string;
  dataDir: string;
  envPath: string;
  vulncheckApiKey?: string;
}

type BatchFilter = "kev" | "urgent" | "stale" | "undetermined" | "all";

interface QueryOptions {
  format: "text" | "json" | "markdown" | "csv";
  verbose: boolean;
  forceRefresh: boolean;
  filter?: BatchFilter;
}

interface MSVResult {
  software: string;
  displayName: string;
  platform: string;
  minimumSafeVersion: string | null;   // Lowest safe version (oldest you can safely run)
  recommendedVersion: string | null;    // Highest safe version (latest, best protection)
  latestVersion: string | null;         // Latest available version (from catalog or vendor)
  branches: BranchMsvResult[];
  admiraltyRating: AdmiraltyRating;
  justification: string;
  sources: string[];
  cveCount: number;
  exploitedCves: ExploitedCVE[];
  queriedAt: string;
  fromCache: boolean;
  dataAge?: DataFreshness;
  // v2 fields
  hasKevCves: boolean;                  // True if any CVEs are in CISA KEV
  sourceResults: SourceResult[];        // Per-source query results
  action?: ActionGuidance;              // Generated action guidance
  riskScore?: RiskScore;                // Aggregate risk score (0-100)
  // v3 fields - variant support
  hasVariants?: boolean;                // True if this product has variant tracks
  variantInfo?: VariantInfo;            // Information about variants
}

interface VariantInfo {
  parentProduct: string;                // e.g., "Adobe Acrobat Reader"
  variants: VariantMsv[];               // MSV info for each variant
  trackHelp: string;                    // Help text explaining how to identify track
}

interface VariantMsv {
  id: string;                           // e.g., "acrobat_reader_dc"
  displayName: string;                  // e.g., "Adobe Acrobat Reader DC"
  track: string;                        // e.g., "Continuous (DC)"
  msv: string | null;                   // Minimum safe version
  versionPattern: string;               // e.g., "24.x.x.x (builds >10000)"
}

interface DataFreshness {
  lastUpdated: string;      // When MSV data was last updated
  lastChecked: string;      // When data sources were last queried
  ageHours: number;         // Hours since last check
  isStale: boolean;         // True if > 24 hours old
  isCritical: boolean;      // True if > 7 days old
}

interface BranchMsvResult {
  branch: string;
  msv: string;
  latest: string;
  noSafeVersion?: boolean;  // True if MSV > latest (no safe version available yet)
}

interface ExploitedCVE {
  cve: string;
  description?: string;
  fixedVersion?: string;
  affectedRange?: string;
  inCisaKev: boolean;
  hasPoC: boolean;
  epssScore?: number;
  cvssScore?: number;
  dateAdded?: string;
}

interface SoftwareMapping {
  id: string;
  displayName: string;
  vendor: string;
  product: string;
  cpe23?: string;
  category?: string;
  priority?: "critical" | "high" | "medium" | "low";
  aliases: string[];
  platforms: string[];
  notes?: string;
  lastChecked?: string;
  variants?: string[];  // List of variant IDs for products with multiple tracks
  versionPattern?: string;  // Regex to filter valid versions (e.g., "^7\\." for PowerShell 7)
  excludePatterns?: string[];  // Regex patterns to exclude from CVE descriptions (prevents data contamination)
  osComponent?: boolean;  // True if this is a Windows OS component (updates via Windows Update only)
  eol?: boolean;  // True if this software is End of Life (no longer receiving security patches)
  latestVersion?: string;  // Known latest version for display (manually maintained)
}

interface SoftwareCatalog {
  _metadata: {
    version: string;
    description: string;
    lastUpdated: string;
    lastChecked: string;
    totalEntries: number;
    sources: string[];
  };
  software: SoftwareMapping[];
}

// =============================================================================
// Software Catalog
// =============================================================================

let catalogCache: SoftwareCatalog | null = null;

function loadSoftwareCatalog(config: Config): SoftwareCatalog {
  if (catalogCache) return catalogCache;

  const catalogPath = resolve(config.dataDir, "SoftwareCatalog.json");

  if (!existsSync(catalogPath)) {
    throw new Error(`Software catalog not found at ${catalogPath}`);
  }

  const content = readFileSync(catalogPath, "utf-8");
  catalogCache = JSON.parse(content) as SoftwareCatalog;
  return catalogCache;
}

function getSoftwareCatalogMap(config: Config): Record<string, SoftwareMapping> {
  const catalog = loadSoftwareCatalog(config);
  const map: Record<string, SoftwareMapping> = {};

  for (const sw of catalog.software) {
    map[sw.id] = sw;
  }

  return map;
}

// =============================================================================
// Configuration
// =============================================================================

function getConfig(): Config {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const paiDir = process.env.PAI_DIR || resolve(home, "AI-Projects");
  const skillDir = resolve(paiDir, ".claude/skills/MSV");
  const dataDir = resolve(skillDir, "data");
  const envPath = resolve(paiDir, ".claude/.env");

  // Ensure data directory exists
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  // Load environment variables
  let vulncheckApiKey: string | undefined;
  if (existsSync(envPath)) {
    const envContent = readFileSync(envPath, "utf-8");
    const match = envContent.match(/VULNCHECK_API_KEY=(.+)/);
    if (match) {
      vulncheckApiKey = match[1].trim();
    }
  }

  return { paiDir, skillDir, dataDir, envPath, vulncheckApiKey };
}

// =============================================================================
// Software Resolution
// =============================================================================

function resolveSoftware(input: string, config: Config): SoftwareMapping | null {
  const normalized = input.toLowerCase().trim();
  const catalog = getSoftwareCatalogMap(config);

  // Direct match by ID
  if (catalog[normalized]) {
    return catalog[normalized];
  }

  // Alias match
  for (const [key, mapping] of Object.entries(catalog)) {
    if (mapping.aliases.some((alias) => alias.toLowerCase() === normalized)) {
      return mapping;
    }
  }

  // Fuzzy match (contains)
  for (const [key, mapping] of Object.entries(catalog)) {
    if (
      mapping.displayName.toLowerCase().includes(normalized) ||
      mapping.product.toLowerCase().includes(normalized)
    ) {
      return mapping;
    }
  }

  return null;
}

/**
 * Get variant products for a software entry with variants defined
 */
function getVariants(software: SoftwareMapping, config: Config): SoftwareMapping[] {
  if (!software.variants || software.variants.length === 0) {
    return [];
  }

  const catalog = getSoftwareCatalogMap(config);
  return software.variants
    .map(id => catalog[id])
    .filter(Boolean);
}

/**
 * Detect Adobe product track from version number
 */
function detectAdobeTrack(version: string): { track: string; productSuffix: string } | null {
  if (!version) return null;

  const majorVersion = parseInt(version.split(".")[0], 10);

  // Adobe Reader/Acrobat version patterns:
  // 20.x.x.x = Classic Track 2020
  // 24.x.x.x = Could be DC (continuous) or Classic Track 2024
  // The differentiation is: DC uses build numbers like 24.005.20320
  // Classic uses simpler numbering

  if (majorVersion >= 20 && majorVersion < 24) {
    return { track: "Classic 2020", productSuffix: "_2020" };
  } else if (majorVersion >= 24) {
    // DC versions have longer build numbers in third segment (>10000)
    const parts = version.split(".");
    if (parts.length >= 3) {
      const buildNum = parseInt(parts[2], 10) || 0;
      if (buildNum > 10000) {
        return { track: "Continuous (DC)", productSuffix: "_dc" };
      }
    }
    // Default to 2024 Classic for 24.x versions without DC-style builds
    return { track: "Classic 2024", productSuffix: "_2024" };
  }

  return null;
}

/**
 * Get variant info for Adobe products
 */
function getAdobeVariantInfo(isReader: boolean): VariantInfo {
  const product = isReader ? "Adobe Acrobat Reader" : "Adobe Acrobat";
  const prefix = isReader ? "acrobat_reader" : "acrobat";

  return {
    parentProduct: product,
    variants: [
      {
        id: `${prefix}_dc`,
        displayName: `${product} DC`,
        track: "Continuous (DC)",
        msv: null, // Will be filled by queries
        versionPattern: "24.x.x.xxxxx (5-digit build)",
      },
      {
        id: `${prefix}_2024`,
        displayName: `${product} 2024`,
        track: "Classic 2024",
        msv: null,
        versionPattern: "24.x.x.x (4-digit or less)",
      },
      {
        id: `${prefix}_2020`,
        displayName: `${product} 2020`,
        track: "Classic 2020",
        msv: null,
        versionPattern: "20.x.x.x",
      },
    ],
    trackHelp: `
To identify your Adobe track:
  1. Open ${product} → Help → About
  2. Check the version number format:
     • 24.005.20320 (5-digit build) = DC (Continuous)
     • 24.001.30159 = Classic 2024
     • 20.005.30636 = Classic 2020

DC auto-updates and is recommended for most users.
Classic tracks are for enterprises requiring longer patch cycles.
`.trim(),
  };
}

/**
 * Get variant info for PowerShell products
 */
function getPowerShellVariantInfo(): VariantInfo {
  return {
    parentProduct: "PowerShell",
    variants: [
      {
        id: "windows_powershell",
        displayName: "Windows PowerShell 5.1",
        track: "Built-in (Windows Update)",
        msv: null, // Will be filled - though note: tied to Windows Update
        versionPattern: "5.1.xxxxx.xxxx (tied to OS build)",
      },
      {
        id: "powershell6",
        displayName: "PowerShell 6 (EOL)",
        track: "END OF LIFE - Upgrade Now!",
        msv: null,
        versionPattern: "6.x.x (unsupported since Sep 2020)",
      },
      {
        id: "powershell7",
        displayName: "PowerShell 7",
        track: "Standalone (LTS: 7.4, Current: 7.5)",
        msv: null,
        versionPattern: "7.x.x",
      },
    ],
    trackHelp: `
To identify your PowerShell version:
  Run: $PSVersionTable.PSVersion

  • 5.1.xxxxx.xxxx = Windows PowerShell (built-in)
    - Updated via Windows Update
    - Cannot be removed from Windows
    - Your version: tied to your Windows build

  • 6.x.x = PowerShell 6 (END OF LIFE)
    - No longer receiving security patches since Sep 2020
    - UPGRADE TO POWERSHELL 7 IMMEDIATELY

  • 7.x.x = PowerShell 7 (standalone)
    - Separate installation from Microsoft
    - LTS: 7.4.x (supported until Nov 2026)
    - Current: 7.5.x (supported until May 2026)
    - Can coexist with Windows PowerShell 5.1

Windows PowerShell 5.1 security patches come through Windows Update.
PowerShell 7 must be updated separately (winget, MSI, or Microsoft Update).
`.trim(),
  };
}

/**
 * Query MSV for all variants of a product
 */
async function queryVariantMsvs(
  variantInfo: VariantInfo,
  options: QueryOptions,
  config: Config
): Promise<VariantInfo> {
  const catalog = getSoftwareCatalogMap(config);
  const msvCache = new MsvCache(config.dataDir);

  for (const variant of variantInfo.variants) {
    const software = catalog[variant.id];
    if (!software) continue;

    // Handle OS components specially - no MSV to track
    if (software.osComponent) {
      variant.msv = "Windows Update";
      continue;
    }

    // Handle EOL products - urgent upgrade needed
    if (software.eol) {
      variant.msv = "⚠ UNSUPPORTED";
      continue;
    }

    const productId = `${software.vendor}:${software.product}`.toLowerCase();

    // Check cache first for quick results (unless force refresh)
    const cached = msvCache.get(productId);
    if (!options.forceRefresh && cached && cached.branches.length > 0 && cached.branches[0].msv !== "unknown") {
      variant.msv = cached.branches[0].msv;
    } else {
      // Query for fresh data
      try {
        const result = await queryMSV(variant.id, { ...options, verbose: false }, config);
        variant.msv = result.minimumSafeVersion;
      } catch {
        variant.msv = null;
      }
    }
  }

  return variantInfo;
}

// =============================================================================
// Data Freshness
// =============================================================================

function calculateDataFreshness(lastUpdated: string, lastChecked?: string): DataFreshness {
  const now = new Date();
  const updated = new Date(lastUpdated);
  const checked = lastChecked ? new Date(lastChecked) : updated;

  const ageMs = now.getTime() - checked.getTime();
  const ageHours = Math.round(ageMs / (1000 * 60 * 60));

  return {
    lastUpdated: updated.toISOString(),
    lastChecked: checked.toISOString(),
    ageHours,
    isStale: ageHours > 24,
    isCritical: ageHours > 168, // 7 days
  };
}

function formatDataAge(freshness: DataFreshness): string {
  if (freshness.ageHours < 1) {
    return "just now";
  } else if (freshness.ageHours < 24) {
    return `${freshness.ageHours}h ago`;
  } else {
    const days = Math.round(freshness.ageHours / 24);
    return `${days}d ago`;
  }
}

function getFreshnessIndicator(freshness: DataFreshness): string {
  if (freshness.isCritical) {
    return "\x1b[31m⚠ STALE DATA\x1b[0m"; // Red warning
  } else if (freshness.isStale) {
    return "\x1b[33m○ Data may be outdated\x1b[0m"; // Yellow
  }
  return "\x1b[32m●\x1b[0m"; // Green dot - fresh
}

// =============================================================================
// Justification Generation
// =============================================================================

/**
 * Generate a meaningful justification for the MSV result
 */
function generateJustification(
  minimumSafeVersion: string | null,
  cveCount: number,
  hasKevCves: boolean,
  dataSources: string[]
): string {
  // No MSV determined
  if (!minimumSafeVersion) {
    if (cveCount === 0) {
      if (dataSources.length === 0) {
        return "No vulnerability data sources available for this product";
      }
      return `No CVEs with CVSS ≥ 4.0 found. Product may be safe or lack CVE coverage in ${dataSources.join(", ")}`;
    }
    return `Found ${cveCount} CVEs but could not determine safe version from available data`;
  }

  // MSV determined
  if (hasKevCves) {
    return `MSV ${minimumSafeVersion} patches actively exploited vulnerabilities (CISA KEV)`;
  }

  if (dataSources.includes("Vendor Advisory")) {
    return `Vendor advisory confirms ${minimumSafeVersion} as minimum safe version`;
  }

  if (dataSources.includes("AppThreat") || dataSources.includes("NVD")) {
    return `MSV ${minimumSafeVersion} determined from ${cveCount} CVEs in vulnerability databases`;
  }

  return `MSV ${minimumSafeVersion} based on ${cveCount} analyzed CVEs`;
}

// =============================================================================
// Query Orchestration
// =============================================================================

async function queryMSV(
  softwareInput: string,
  options: QueryOptions,
  config: Config
): Promise<MSVResult> {
  const software = resolveSoftware(softwareInput, config);

  if (!software) {
    throw new Error(
      `Unknown software: "${softwareInput}". Use 'msv list' to see supported software.`
    );
  }

  // OS COMPONENT HANDLING - Products updated via Windows Update only
  if (software.osComponent) {
    const now = new Date().toISOString();
    return {
      software: softwareInput,
      displayName: software.displayName,
      platform: software.platforms.join(", "),
      minimumSafeVersion: "N/A (OS Component)",
      recommendedVersion: "Keep Windows Updated",
      latestVersion: software.latestVersion || null,
      branches: [],
      admiraltyRating: {
        rating: "A2",
        reliability: "A",
        credibility: 2,
        description: "OS component - security provided via Windows Update",
      },
      justification: `${software.displayName} is a built-in Windows component. Security patches are delivered through Windows Update cumulative updates, not as standalone software versions. Keep your Windows installation current to ensure security.`,
      sources: ["Windows Update"],
      cveCount: 0,
      exploitedCves: [],
      queriedAt: now,
      fromCache: false,
      dataAge: calculateDataFreshness(now, now),
      hasKevCves: false,
      sourceResults: [{
        source: "OS Component",
        queried: true,
        cveCount: 0,
        note: "Patched via Windows Update cumulative updates",
      }],
      action: {
        action: "MONITOR",
        symbol: "✓",
        color: "\x1b[32m",  // Green
        headline: "KEEP WINDOWS UPDATED",
        message: `${software.displayName} security patches come through Windows Update cumulative updates. Ensure your system receives regular updates.`,
        urgency: "info",
      },
    };
  }

  // EOL HANDLING - Products that are End of Life
  if (software.eol) {
    const now = new Date().toISOString();
    return {
      software: softwareInput,
      displayName: software.displayName,
      platform: software.platforms.join(", "),
      minimumSafeVersion: "UNSUPPORTED",
      recommendedVersion: "Upgrade to supported version",
      latestVersion: null,  // No latest version for EOL products
      branches: [],
      admiraltyRating: {
        rating: "A1",
        reliability: "A",
        credibility: 1,
        description: "End of Life - no security patches available",
      },
      justification: `${software.displayName} has reached End of Life and no longer receives security patches. Any vulnerabilities discovered will NOT be patched. Immediate upgrade to a supported version is required.`,
      sources: ["EOL Status"],
      cveCount: 0,
      exploitedCves: [],
      queriedAt: now,
      fromCache: false,
      dataAge: calculateDataFreshness(now, now),
      hasKevCves: false,
      sourceResults: [{
        source: "EOL Check",
        queried: true,
        cveCount: 0,
        note: "Product is End of Life - no security support",
      }],
      action: {
        action: "UPGRADE_CRITICAL",
        symbol: "✗",
        color: "\x1b[31m",  // Red
        headline: "END OF LIFE - UPGRADE IMMEDIATELY",
        message: `${software.displayName} is no longer supported. Upgrade to a current version immediately - no security patches are available.`,
        urgency: "critical",
      },
    };
  }

  // VARIANT HANDLING - Check if this is a product with multiple tracks
  if (software.variants && software.variants.length > 0) {
    // Determine the product type for variant handling
    const isAdobeReader = software.product === "acrobat_reader";
    const isAdobeAcrobat = software.product === "acrobat" && software.vendor === "adobe";
    const isPowerShell = software.product === "powershell" && software.vendor === "microsoft" && software.id === "powershell";

    if (isAdobeReader || isAdobeAcrobat || isPowerShell) {
      logger.debug("Detected product with multiple tracks, gathering variant MSVs...");

      // Get variant info based on product type
      let variantInfo: VariantInfo;
      if (isPowerShell) {
        variantInfo = getPowerShellVariantInfo();
      } else {
        variantInfo = getAdobeVariantInfo(isAdobeReader);
      }
      variantInfo = await queryVariantMsvs(variantInfo, options, config);

      // Return a special result for variant products
      const now = new Date().toISOString();
      return {
        software: softwareInput,
        displayName: software.displayName,
        platform: software.platforms.join(", "),
        minimumSafeVersion: null,  // No single MSV for variant products
        recommendedVersion: null,
        latestVersion: software.latestVersion || null,
        branches: [],
        admiraltyRating: {
          rating: "B2",
          reliability: "B",
          credibility: 2,
          description: "Multiple product tracks - see variants for specific MSVs",
        },
        justification: "This product has multiple release tracks. Query specific variant for accurate MSV.",
        sources: ["Multi-track product"],
        cveCount: 0,
        exploitedCves: [],
        queriedAt: now,
        fromCache: false,
        dataAge: calculateDataFreshness(now, now),
        hasKevCves: false,
        sourceResults: [],
        hasVariants: true,
        variantInfo,
      };
    }
  }

  // Initialize cache
  const msvCache = new MsvCache(config.dataDir);
  const productId = `${software.vendor}:${software.product}`.toLowerCase();

  // Check cache first (unless force refresh)
  if (!options.forceRefresh) {
    const cached = msvCache.get(productId);

    // Validate cache entry is complete (not just time-based)
    // Old cache entries may have empty branches - consider them stale
    const cacheIsComplete = cached && (
      // Has branch data with MSV
      (cached.branches.length > 0 && cached.branches[0].msv !== "unknown") ||
      // Or has v2 fields with explicit "no vulns" justification
      (cached.cveCount === 0 && cached.justification?.includes("No CVEs"))
    );

    if (cached && cacheIsComplete && !msvCache.needsRefresh(productId, 24)) {
      logger.debug("Returning cached MSV result...");

      // Build result from cache
      const branches: BranchMsvResult[] = cached.branches.map(b => ({
        branch: b.branch,
        msv: b.msv,
        latest: b.latestKnown,
      }));

      // Calculate minimum (lowest) and recommended (highest) safe versions
      let minimumSafeVersion: string | null = null;
      let recommendedVersion: string | null = null;

      if (branches.length > 0) {
        const sortedByMsv = [...branches].sort((a, b) => compareVersions(a.msv, b.msv));
        minimumSafeVersion = sortedByMsv[0].msv;  // Lowest safe version
        recommendedVersion = sortedByMsv[sortedByMsv.length - 1].msv;  // Highest safe version
      }

      // Map data source names to internal format
      const hasVendorAdvisory = cached.dataSources.some(s =>
        s === "vendor_advisory" || s === "Vendor Advisory"
      );

      // Use cached cveCount if available, otherwise calculate from advisoriesChecked
      const cveCount = cached.cveCount !== undefined
        ? cached.cveCount
        : cached.branches.reduce((sum, b) => sum + b.advisoriesChecked.length, 0);

      const ratingInput: MsvRatingInput = {
        dataSources: cached.dataSources.map(s => {
          if (s === "Vendor Advisory") return "vendor_advisory";
          if (s === "NVD") return "nvd";
          if (s === "CISA KEV") return "cisa_kev";
          if (s === "VulnCheck") return "vulncheck";
          if (s === "AppThreat") return "appthreat";
          return s as any;
        }),
        hasVendorAdvisory,
        hasCveData: cveCount > 0 || cached.branches.length > 0,
        cveCount,
        msvDetermined: minimumSafeVersion !== null,
      };

      // Calculate data freshness
      const dataAge = calculateDataFreshness(
        cached.lastUpdated,
        cached.branches[0]?.lastChecked
      );

      // Use cached justification or generate meaningful one
      const admiraltyRating = calculateMsvRating(ratingInput);
      const justification = cached.justification || generateJustification(
        minimumSafeVersion,
        cveCount,
        cached.hasKevCves || false,
        cached.dataSources
      );

      // Build source results from cache - if not available, create placeholders
      // that indicate the data came from cache without per-source details
      let sourceResults: SourceResult[];
      if (cached.sourceResults && cached.sourceResults.length > 0) {
        sourceResults = cached.sourceResults;
      } else {
        // Generate source results from dataSources with note about cache
        sourceResults = cached.dataSources.map(s => ({
          source: s,
          queried: true,
          cveCount: 0,  // Unknown per-source count from old cache format
          note: "cached (upgrade cache with --force)",
        }));
      }

      // Generate action guidance
      const branchesWithNoSafeVersion = branches.filter(b => b.noSafeVersion);
      const actionInput: ActionInput = {
        currentVersion: null,
        minimumSafeVersion,
        recommendedVersion,
        admiraltyRating,
        hasKevCves: cached.hasKevCves || false,
        cveCount,
        sources: cached.dataSources,
        vendor: software.vendor,
        branchesWithNoSafeVersion: branchesWithNoSafeVersion.length > 0 ? branchesWithNoSafeVersion : undefined,
      };

      // Try to get latest version from catalog or Chocolatey
      let latestVersion = software.latestVersion || null;
      if (!latestVersion) {
        try {
          const chocoClient = new ChocolateyClient(config.dataDir);
          const chocoVersion = await chocoClient.getLatestVersion(software.id);
          if (chocoVersion) {
            latestVersion = chocoVersion;
            logger.debug(`Latest version from Chocolatey: ${chocoVersion}`);
          }
        } catch {
          // Chocolatey lookup failed, continue without latest version
        }
      }

      // Calculate risk score from cached data
      const riskScoreInput: RiskScoreInput = {
        hasKevCves: cached.hasKevCves || false,
        kevCveCount: cached.hasKevCves ? 1 : 0, // Approximate from cached flag
        maxEpssScore: 0, // Not available in cache v1
        avgEpssScore: 0,
        cveCount,
        maxCvssScore: 0, // Not available in cache v1
        avgCvssScore: 0,
        msvDetermined: minimumSafeVersion !== null,
        hasPoCExploits: false, // Not tracked in cache v1
        dataAge: dataAge?.ageHours || 0,
      };

      return {
        software: softwareInput,
        displayName: software.displayName,
        platform: software.platforms.join(", "),
        minimumSafeVersion,
        recommendedVersion,
        latestVersion,
        branches,
        admiraltyRating,
        justification,
        sources: cached.dataSources,
        cveCount,
        exploitedCves: [],
        queriedAt: new Date().toISOString(),
        fromCache: true,
        dataAge,
        hasKevCves: cached.hasKevCves || false,
        sourceResults,
        action: generateAction(actionInput),
        riskScore: calculateRiskScore(riskScoreInput),
      };
    }
  }

  const evidence: EvidenceSource[] = [];
  const exploitedCves: ExploitedCVE[] = [];
  const sources: string[] = [];
  const sourceResults: SourceResult[] = [];  // Track per-source results
  const branches: BranchMsvResult[] = [];
  let minimumSafeVersion: string | null = null;   // Lowest safe version
  let recommendedVersion: string | null = null;    // Highest safe version
  let hasVendorAdvisory = false;
  let hasKevCves = false;  // Track if any CVEs are in KEV

  // 1. Try vendor advisory first (most reliable source)
  logger.debug("Checking vendor advisory...");
  const vendorFetcher = getVendorFetcher(software.vendor, software.product, config.dataDir);

  if (vendorFetcher) {
    try {
      const vendorData = await vendorFetcher.fetch();

      if (vendorData.branches.length > 0) {
        hasVendorAdvisory = true;
        sources.push("Vendor Advisory");

        // Use vendor advisory branches as primary MSV source
        for (const branch of vendorData.branches) {
          // Detect if MSV > latest (no safe version available yet in this branch)
          const noSafeVersion = compareVersions(branch.msv, branch.latest) > 0;
          branches.push({
            branch: branch.branch,
            msv: branch.msv,
            latest: branch.latest,
            noSafeVersion,
          });
        }

        // Calculate minimum (lowest) and recommended (highest) safe versions
        if (branches.length > 0) {
          const sortedByMsv = [...branches].sort((a, b) => compareVersions(a.msv, b.msv));
          minimumSafeVersion = sortedByMsv[0].msv;  // Lowest safe version (oldest you can run safely)
          recommendedVersion = sortedByMsv[sortedByMsv.length - 1].msv;  // Highest safe version (best protection)
        }

        // Collect CVEs from advisories
        for (const adv of vendorData.advisories) {
          for (const cveId of adv.cveIds) {
            if (!exploitedCves.find(c => c.cve === cveId)) {
              exploitedCves.push({
                cve: cveId,
                description: adv.title,
                fixedVersion: adv.fixedVersions[0],
                inCisaKev: false,
                hasPoC: false,
              });
            }
          }
        }

        // Track source result
        sourceResults.push({
          source: "Vendor Advisory",
          queried: true,
          cveCount: vendorData.advisories.reduce((sum, adv) => sum + adv.cveIds.length, 0),
        });

        if (options.verbose) {
          console.log(`  Found ${vendorData.advisories.length} advisories, ${branches.length} branches`);
        }
      }
    } catch (error) {
      logger.warn("Vendor advisory fetch failed:", error);
      sourceResults.push({
        source: "Vendor Advisory",
        queried: true,
        cveCount: 0,
        note: "fetch failed",
      });
    }
  }

  // 1.5. Query AppThreat SQLite database (offline, fast)
  // Only query if we don't have vendor advisory data and CPE is available
  let appThreatQueried = false;
  if (!hasVendorAdvisory && software.cpe23) {
    const appThreatClient = new AppThreatClient();
    if (appThreatClient.isDatabaseAvailable()) {
      logger.debug("Querying AppThreat database (offline)...");
      try {
        let appThreatResults = await appThreatClient.searchByCpe(software.cpe23, {
          minCvss: 4.0, // Medium severity and above
          excludeMalware: true,
        });

        // Filter results by version pattern if specified (prevents data contamination)
        // e.g., PowerShell 7 uses "^[67]\\." to filter out PowerShell Universal (2024.x)
        if (software.versionPattern && appThreatResults.length > 0) {
          const versionRegex = new RegExp(software.versionPattern);
          const originalCount = appThreatResults.length;
          appThreatResults = appThreatResults.filter(r => {
            if (!r.fixedVersion) return true;  // Keep CVEs without fixed version
            return versionRegex.test(r.fixedVersion);
          });
          if (options.verbose && originalCount !== appThreatResults.length) {
            console.log(`  Filtered ${originalCount - appThreatResults.length} CVEs with invalid version patterns`);
          }
        }

        // Filter results by exclude patterns (prevents cross-product contamination)
        // e.g., Git excludes "gitlab|gitea|github" to filter out GitLab CVEs
        if (software.excludePatterns && software.excludePatterns.length > 0 && appThreatResults.length > 0) {
          const excludeRegexes = software.excludePatterns.map(p => new RegExp(p, "i"));
          const originalCount = appThreatResults.length;
          appThreatResults = appThreatResults.filter(r => {
            // Check description against all exclude patterns
            const desc = r.description || "";
            for (const regex of excludeRegexes) {
              if (regex.test(desc)) {
                return false;  // Exclude this CVE
              }
            }
            return true;
          });
          if (options.verbose && originalCount !== appThreatResults.length) {
            console.log(`  Filtered ${originalCount - appThreatResults.length} CVEs matching exclude patterns`);
          }
        }

        if (appThreatResults.length > 0) {
          appThreatQueried = true;
          sources.push("AppThreat");

          // Calculate MSV from AppThreat results
          const appThreatMsv = getAppThreatMsv(appThreatResults);
          if (appThreatMsv && !minimumSafeVersion) {
            minimumSafeVersion = appThreatMsv;
            recommendedVersion = appThreatMsv;
          }

          // Add CVEs from AppThreat
          for (const result of appThreatResults) {
            if (!exploitedCves.find(c => c.cve === result.cveId)) {
              exploitedCves.push({
                cve: result.cveId,
                description: result.description,
                fixedVersion: result.fixedVersion || undefined,
                inCisaKev: false, // Will be enriched by KEV query
                hasPoC: false,
                cvssScore: result.cvssScore || undefined,
              });
            }
          }

          const maxCvss = Math.max(...appThreatResults.map(r => r.cvssScore || 0));
          evidence.push({
            source: "AppThreat",
            hasData: true,
            cvssScore: maxCvss > 0 ? maxCvss : undefined,
          });

          // Track source result
          sourceResults.push({
            source: "AppThreat",
            queried: true,
            cveCount: appThreatResults.length,
          });

          if (options.verbose) {
            console.log(`  Found ${appThreatResults.length} CVEs from AppThreat, MSV: ${appThreatMsv}`);
          }
        } else {
          sourceResults.push({
            source: "AppThreat",
            queried: true,
            cveCount: 0,
          });
        }
        appThreatClient.close();
      } catch (error) {
        logger.warn("AppThreat query failed:", error);
        sourceResults.push({
          source: "AppThreat",
          queried: true,
          cveCount: 0,
          note: "query failed",
        });
      }
    } else if (options.verbose) {
      console.log("AppThreat database not available (run: vdb --download-image)");
    }
  }

  // 2. Query CISA KEV (always check for active exploitation)
  logger.debug("Querying CISA KEV...");
  const kevClient = new CisaKevClient(config.dataDir);

  try {
    // Try multiple search terms to improve KEV matching
    // KEV uses simple product names like "Orion" not "orion_platform"
    const searchTerms = [
      software.product,
      software.product.replace(/_/g, " "),  // orion_platform -> orion platform
      software.product.split("_")[0],        // orion_platform -> orion
      software.displayName.split(" ").slice(-1)[0], // "SolarWinds Orion Platform" -> "Platform"
      ...software.aliases,
    ];

    let kevEntries: KevEntry[] = [];
    const seenCves = new Set<string>();

    for (const term of searchTerms) {
      if (!term || term.length < 3) continue;
      const entries = await kevClient.findByProduct(term, software.vendor);
      for (const entry of entries) {
        if (!seenCves.has(entry.cveID)) {
          seenCves.add(entry.cveID);
          kevEntries.push(entry);
        }
      }
      if (kevEntries.length > 0) break; // Stop on first match
    }

    if (kevEntries.length > 0) {
      sources.push("CISA KEV");
      evidence.push({
        source: "CISA_KEV",
        hasData: true,
        exploitConfirmed: true,
        inKev: true,
        isRansomware: kevEntries.some(
          (e) => e.knownRansomwareCampaignUse === "Known"
        ),
      });

      for (const entry of kevEntries) {
        const existing = exploitedCves.find(c => c.cve === entry.cveID);
        if (existing) {
          existing.inCisaKev = true;
          existing.hasPoC = true;
          existing.dateAdded = entry.dateAdded;
        } else {
          exploitedCves.push({
            cve: entry.cveID,
            description: entry.shortDescription,
            inCisaKev: true,
            hasPoC: true,
            dateAdded: entry.dateAdded,
          });
        }
      }

      // Track source result
      sourceResults.push({
        source: "CISA KEV",
        queried: true,
        cveCount: kevEntries.length,
      });
    } else {
      evidence.push({ source: "CISA_KEV", hasData: false });
      sourceResults.push({
        source: "CISA KEV",
        queried: true,
        cveCount: 0,
        note: "not in catalog",
      });
    }
  } catch (error) {
    logger.warn("CISA KEV query failed:", error);
    evidence.push({ source: "CISA_KEV", hasData: false });
    sourceResults.push({
      source: "CISA KEV",
      queried: true,
      cveCount: 0,
      note: "query failed",
    });
  }

  // 3. Query VulnCheck by CPE if API key available and we need more CVE data
  if (config.vulncheckApiKey && software.cpe23) {
    logger.debug("Querying VulnCheck by CPE...");
    try {
      const vulnCheckClient = new VulnCheckClient(
        { apiKey: config.vulncheckApiKey },
        config.dataDir
      );

      // Query by CPE to find CVEs
      const cpeResults = await vulnCheckClient.queryCpe(software.cpe23);

      if (cpeResults.length > 0) {
        if (!sources.includes("VulnCheck")) sources.push("VulnCheck");

        for (const result of cpeResults) {
          const existing = exploitedCves.find(c => c.cve === result.cve);
          if (existing) {
            // Update existing CVE with VulnCheck data
            if (result.poc_available) existing.hasPoC = true;
            if (result.cvss_v3) existing.cvssScore = result.cvss_v3;
          } else {
            // Add new CVE from VulnCheck
            exploitedCves.push({
              cve: result.cve,
              description: result.description,
              inCisaKev: result.vulncheck_kev || false,
              hasPoC: result.poc_available || false,
              cvssScore: result.cvss_v3 || result.cvss_v2,
            });
          }
        }

        evidence.push({
          source: "VulnCheck",
          hasData: true,
          hasPoc: cpeResults.some(r => r.poc_available),
        });

        // Track source result
        sourceResults.push({
          source: "VulnCheck",
          queried: true,
          cveCount: cpeResults.length,
        });
      } else {
        evidence.push({ source: "VulnCheck", hasData: false });
        sourceResults.push({
          source: "VulnCheck",
          queried: true,
          cveCount: 0,
        });
      }
    } catch (error) {
      logger.warn("VulnCheck query failed:", error);
      evidence.push({ source: "VulnCheck", hasData: false });
      sourceResults.push({
        source: "VulnCheck",
        queried: true,
        cveCount: 0,
        note: "query failed",
      });
    }
  }

  // 3.5. If no CVEs found yet, query NVD directly by CPE (free API)
  if (exploitedCves.length === 0 && software.cpe23) {
    logger.debug("Querying NVD by CPE (no CVEs from other sources)...");
    try {
      const nvdClient = new NvdClient(config.dataDir);
      const nvdCpeResults = await nvdClient.searchByCpe(software.cpe23, {
        maxResults: 20,
        minCvss: 4.0, // Medium severity and above
      });

      if (nvdCpeResults.length > 0) {
        if (!sources.includes("NVD")) sources.push("NVD");

        // Filter results by version pattern if specified (prevents data contamination)
        let filteredResults = nvdCpeResults;
        if (software.versionPattern) {
          const versionRegex = new RegExp(software.versionPattern);
          const originalCount = filteredResults.length;
          filteredResults = filteredResults.filter(r => {
            if (!r.fixedVersion) return true;  // Keep CVEs without fixed version
            return versionRegex.test(r.fixedVersion);
          });
          if (options.verbose && originalCount !== filteredResults.length) {
            console.log(`  Filtered ${originalCount - filteredResults.length} NVD CVEs with invalid version patterns`);
          }
        }

        // Filter results by exclude patterns (prevents cross-product contamination)
        if (software.excludePatterns && software.excludePatterns.length > 0 && filteredResults.length > 0) {
          const excludeRegexes = software.excludePatterns.map(p => new RegExp(p, "i"));
          const originalCount = filteredResults.length;
          filteredResults = filteredResults.filter(r => {
            const desc = r.description || "";
            for (const regex of excludeRegexes) {
              if (regex.test(desc)) {
                return false;
              }
            }
            return true;
          });
          if (options.verbose && originalCount !== filteredResults.length) {
            console.log(`  Filtered ${originalCount - filteredResults.length} NVD CVEs matching exclude patterns`);
          }
        }

        // Track fixed versions to determine MSV
        const fixedVersions: string[] = [];

        for (const result of filteredResults) {
          exploitedCves.push({
            cve: result.cve,
            description: result.description,
            inCisaKev: false,
            hasPoC: false,
            cvssScore: result.cvssScore || undefined,
            fixedVersion: result.fixedVersion && !result.fixedVersion.startsWith(">")
              ? result.fixedVersion
              : undefined,
          });

          if (result.fixedVersion && !result.fixedVersion.startsWith(">")) {
            fixedVersions.push(result.fixedVersion);
          }
        }

        // Determine MSV from fixed versions
        if (fixedVersions.length > 0 && !minimumSafeVersion) {
          // Sort and get highest fixed version
          fixedVersions.sort((a, b) => {
            const partsA = a.split(".").map(p => parseInt(p, 10) || 0);
            const partsB = b.split(".").map(p => parseInt(p, 10) || 0);
            const maxLen = Math.max(partsA.length, partsB.length);
            for (let i = 0; i < maxLen; i++) {
              const partA = partsA[i] || 0;
              const partB = partsB[i] || 0;
              if (partA !== partB) return partA - partB;
            }
            return 0;
          });
          minimumSafeVersion = fixedVersions[fixedVersions.length - 1];
          recommendedVersion = minimumSafeVersion;
        }

        const maxCvss = Math.max(...filteredResults.map(r => r.cvssScore || 0));
        evidence.push({
          source: "NVD",
          hasData: true,
          cvssScore: maxCvss > 0 ? maxCvss : undefined,
        });

        // Track source result
        sourceResults.push({
          source: "NVD",
          queried: true,
          cveCount: filteredResults.length,
        });

        if (options.verbose) {
          console.log(`Found ${filteredResults.length} CVEs from NVD (CVSS >= 4.0)`);
        }
      } else {
        evidence.push({ source: "NVD", hasData: false });
        sourceResults.push({
          source: "NVD",
          queried: true,
          cveCount: 0,
        });
        logger.debug("No CVEs found in NVD for this CPE");
      }
    } catch (error) {
      logger.warn("NVD CPE query failed:", error);
      evidence.push({ source: "NVD", hasData: false });
      sourceResults.push({
        source: "NVD",
        queried: true,
        cveCount: 0,
        note: "query failed",
      });
    }
  }

  // 4. Query NVD for version info if we have CVEs without fixed versions
  if (exploitedCves.length > 0 && (!hasVendorAdvisory || exploitedCves.some(c => !c.fixedVersion))) {
    const nvdClient = new NvdClient(config.dataDir);
    const cvesToQuery = exploitedCves
      .filter(c => !c.fixedVersion)
      .map(c => c.cve)
      .slice(0, 5); // Limit due to rate limiting

    if (cvesToQuery.length > 0) {
      logger.debug(`Querying NVD for ${cvesToQuery.length} CVEs (rate limited)...`);
      try {
        const { version, details } = await nvdClient.getMinimumSafeVersion(
          cvesToQuery,
          software.vendor,
          software.product
        );

        if (version) {
          if (!sources.includes("NVD")) sources.push("NVD");

          // Only use NVD MSV if no vendor advisory
          if (!hasVendorAdvisory && !minimumSafeVersion) {
            // For NVD data, we only get a single version (highest fixed)
            // Use it as both min and recommended since we don't have branch data
            minimumSafeVersion = version;
            recommendedVersion = version;
          }

          evidence.push({
            source: "NVD",
            hasData: true,
            cvssScore: details[0]?.cvssScore || undefined,
          });

          // Update CVEs with fixed version info
          for (const detail of details) {
            const cve = exploitedCves.find((c) => c.cve === detail.cve);
            if (cve && detail.fixedVersion) {
              cve.fixedVersion = detail.fixedVersion;
              cve.cvssScore = detail.cvssScore || cve.cvssScore;
            }
          }
        }
      } catch (error) {
        logger.warn("NVD query failed:", error);
      }
    }
  }

  // 5. Query EPSS for exploitation probability
  if (exploitedCves.length > 0) {
    logger.debug("Querying EPSS...");
    const epssClient = new EpssClient(config.dataDir);

    try {
      const cveIds = exploitedCves.map((c) => c.cve);
      const epssScores = await epssClient.getScores(cveIds.slice(0, 30));

      if (epssScores.length > 0) {
        sources.push("EPSS");
        const maxEpss = Math.max(...epssScores.map((s) => s.epss));

        evidence.push({
          source: "EPSS",
          hasData: true,
          epssScore: maxEpss,
        });

        for (const score of epssScores) {
          const cve = exploitedCves.find((c) => c.cve === score.cve);
          if (cve) {
            cve.epssScore = score.epss;
          }
        }

        // Track source result
        sourceResults.push({
          source: "EPSS",
          queried: true,
          cveCount: epssScores.length,
          note: `max score: ${(maxEpss * 100).toFixed(1)}%`,
        });
      } else {
        sourceResults.push({
          source: "EPSS",
          queried: true,
          cveCount: 0,
        });
      }
    } catch (error) {
      logger.warn("EPSS query failed:", error);
      sourceResults.push({
        source: "EPSS",
        queried: true,
        cveCount: 0,
        note: "query failed",
      });
    }
  }

  // Track KEV CVEs
  hasKevCves = exploitedCves.some(c => c.inCisaKev);

  // Build source results summary
  // Add sources that weren't queried
  const allPossibleSources = ["Vendor Advisory", "AppThreat", "CISA KEV", "VulnCheck", "NVD", "EPSS"];
  for (const sourceName of allPossibleSources) {
    if (!sourceResults.find(sr => sr.source === sourceName)) {
      let note = "not queried";
      if (sourceName === "VulnCheck" && !config.vulncheckApiKey) {
        note = "no API key configured";
      } else if (sourceName === "Vendor Advisory" && !getVendorFetcher(software.vendor, software.product, config.dataDir)) {
        note = "no fetcher available";
      }
      sourceResults.push({
        source: sourceName,
        queried: false,
        cveCount: 0,
        note,
      });
    }
  }

  // Calculate Admiralty rating using MSV-specific logic
  const ratingInput: MsvRatingInput = {
    dataSources: sources.map(s => {
      if (s === "Vendor Advisory") return "vendor_advisory";
      if (s === "NVD") return "nvd";
      if (s === "CISA KEV") return "cisa_kev";
      if (s === "VulnCheck") return "vulncheck";
      if (s === "AppThreat") return "appthreat";
      return "none";
    }) as any[],
    hasVendorAdvisory,
    hasCveData: exploitedCves.length > 0,
    cveCount: exploitedCves.length,
    msvDetermined: minimumSafeVersion !== null,
  };

  const admiraltyRating = calculateMsvRating(ratingInput);

  // Build meaningful justification (v2)
  const justification = generateJustification(
    minimumSafeVersion,
    exploitedCves.length,
    hasKevCves,
    sources
  );

  // Generate action guidance
  const branchesWithNoSafeVersion = branches.filter(b => b.noSafeVersion);
  const actionInput: ActionInput = {
    currentVersion: null,
    minimumSafeVersion,
    recommendedVersion,
    admiraltyRating,
    hasKevCves,
    cveCount: exploitedCves.length,
    sources,
    vendor: software.vendor,
    branchesWithNoSafeVersion: branchesWithNoSafeVersion.length > 0 ? branchesWithNoSafeVersion : undefined,
  };
  const action = generateAction(actionInput);

  // Calculate aggregate risk score
  const kevCveCount = exploitedCves.filter(c => c.inCisaKev).length;
  const epssScores = exploitedCves.map(c => c.epssScore || 0).filter(s => s > 0);
  const cvssScores = exploitedCves.map(c => c.cvssScore || 0).filter(s => s > 0);

  const riskScoreInput: RiskScoreInput = {
    hasKevCves,
    kevCveCount,
    maxEpssScore: epssScores.length > 0 ? Math.max(...epssScores) : 0,
    avgEpssScore: epssScores.length > 0 ? epssScores.reduce((a, b) => a + b, 0) / epssScores.length : 0,
    cveCount: exploitedCves.length,
    maxCvssScore: cvssScores.length > 0 ? Math.max(...cvssScores) : 0,
    avgCvssScore: cvssScores.length > 0 ? cvssScores.reduce((a, b) => a + b, 0) / cvssScores.length : 0,
    msvDetermined: minimumSafeVersion !== null,
    hasPoCExploits: exploitedCves.some(c => c.hasPoC),
    dataAge: 0, // Fresh query
  };
  const riskScore = calculateRiskScore(riskScoreInput);

  // Update cache with new results (including v2 fields)
  const cacheEntry: MsvCacheEntry = {
    productId,
    displayName: software.displayName,
    vendor: software.vendor,
    branches: branches.length > 0 ? branches.map(b => ({
      branch: b.branch,
      msv: b.msv,
      latestKnown: b.latest,
      lastChecked: new Date().toISOString(),
      advisoriesChecked: exploitedCves.map(c => c.cve),
    })) : [{
      branch: "default",
      msv: minimumSafeVersion || "unknown",
      latestKnown: minimumSafeVersion || "unknown",
      lastChecked: new Date().toISOString(),
      advisoriesChecked: exploitedCves.map(c => c.cve),
    }],
    dataSources: sources,
    confidence: hasVendorAdvisory ? "high" : (exploitedCves.length > 0 ? "medium" : "low"),
    lastUpdated: new Date().toISOString(),
    // v2 fields
    justification,
    cveCount: exploitedCves.length,
    hasKevCves,
    sourceResults: sourceResults.filter(sr => sr.queried),
  };

  msvCache.update(cacheEntry);
  logger.debug("Cache updated.");

  // Fresh data - just queried
  const now = new Date().toISOString();
  const dataAge = calculateDataFreshness(now, now);

  // Try to get latest version from catalog or Chocolatey
  let latestVersion = software.latestVersion || null;
  if (!latestVersion) {
    try {
      const chocoClient = new ChocolateyClient(config.dataDir);
      const chocoVersion = await chocoClient.getLatestVersion(software.id);
      if (chocoVersion) {
        latestVersion = chocoVersion;
        logger.debug(`Latest version from Chocolatey: ${chocoVersion}`);
      }
    } catch {
      // Chocolatey lookup failed, continue without latest version
    }
  }

  return {
    software: softwareInput,
    displayName: software.displayName,
    platform: software.platforms.join(", "),
    minimumSafeVersion,
    recommendedVersion,
    latestVersion,
    branches,
    admiraltyRating,
    justification,
    sources,
    cveCount: exploitedCves.length,
    exploitedCves,
    queriedAt: now,
    fromCache: false,
    dataAge,
    hasKevCves,
    sourceResults,
    action,
    riskScore,
  };
}

// =============================================================================
// Output Formatters
// =============================================================================

function formatText(result: MSVResult): string {
  const lines: string[] = [];
  const DIM = "\x1b[2m";
  const BOLD = "\x1b[1m";
  const CYAN = "\x1b[36m";
  const YELLOW = "\x1b[33m";
  const GREEN = "\x1b[32m";
  const MAGENTA = "\x1b[35m";

  // Header
  lines.push(`${BOLD}Software: ${result.displayName}${RESET_COLOR} (${result.platform})`);
  lines.push("");

  // VARIANT PRODUCTS - Special handling for products with multiple tracks
  if (result.hasVariants && result.variantInfo) {
    lines.push(`${MAGENTA}━━━ MULTIPLE PRODUCT TRACKS ━━━${RESET_COLOR}`);
    lines.push(`${DIM}This product has multiple release tracks with different MSVs.${RESET_COLOR}`);
    lines.push("");

    lines.push(`${BOLD}MSV by Track:${RESET_COLOR}`);
    for (const variant of result.variantInfo.variants) {
      const msvDisplay = variant.msv
        ? `${CYAN}${variant.msv}${RESET_COLOR}`
        : `${YELLOW}Unknown${RESET_COLOR}`;
      lines.push(`  ${variant.track.padEnd(18)} MSV: ${msvDisplay}`);
      lines.push(`  ${DIM}${variant.versionPattern}${RESET_COLOR}`);
      lines.push("");
    }

    // How to identify your track
    lines.push(`${BOLD}How to Identify Your Track:${RESET_COLOR}`);
    for (const line of result.variantInfo.trackHelp.split("\n")) {
      lines.push(`  ${line}`);
    }
    lines.push("");

    // Suggest specific query
    lines.push(`${BOLD}For Accurate MSV:${RESET_COLOR}`);
    lines.push(`  Query the specific variant you have installed:`);
    for (const variant of result.variantInfo.variants) {
      lines.push(`    ${DIM}msv query "${variant.displayName}"${RESET_COLOR}`);
    }
    lines.push("");

    // Data freshness footer
    if (result.dataAge) {
      const age = formatDataAge(result.dataAge);
      const indicator = getFreshnessIndicator(result.dataAge);
      lines.push(`${indicator} Data checked ${age}${result.fromCache ? " (cached)" : ""}`);
    }

    return lines.join("\n");
  }

  // MSV Section - ALWAYS show, even if undetermined
  if (result.minimumSafeVersion) {
    if (result.minimumSafeVersion === result.recommendedVersion || !result.recommendedVersion) {
      lines.push(`${BOLD}Minimum Safe Version:${RESET_COLOR} ${CYAN}${result.minimumSafeVersion}${RESET_COLOR}`);
    } else {
      lines.push(`${BOLD}Minimum Safe Version:${RESET_COLOR} ${CYAN}${result.minimumSafeVersion}${RESET_COLOR} ${DIM}(oldest safe)${RESET_COLOR}`);
      lines.push(`${BOLD}Recommended Version:${RESET_COLOR}  ${CYAN}${result.recommendedVersion}${RESET_COLOR} ${DIM}(latest safe)${RESET_COLOR}`);
    }
  } else {
    // CRITICAL FIX: Always show MSV field, explain why undetermined
    lines.push(`${BOLD}Minimum Safe Version:${RESET_COLOR} ${YELLOW}UNDETERMINED${RESET_COLOR}`);
    if (result.cveCount === 0) {
      lines.push(`${DIM}  Reason: No CVEs with CVSS ≥ 4.0 found in vulnerability databases${RESET_COLOR}`);
    } else {
      lines.push(`${DIM}  Reason: Found ${result.cveCount} CVEs but could not determine safe version${RESET_COLOR}`);
    }
  }
  // Show latest available version (from catalog)
  if (result.latestVersion) {
    lines.push(`${BOLD}Latest Version:${RESET_COLOR}       ${GREEN}${result.latestVersion}${RESET_COLOR} ${DIM}(current release)${RESET_COLOR}`);
  }
  lines.push("");

  // Confidence Rating - with inline description
  const ratingDisplay = formatRatingWithDescription(result.admiraltyRating);
  lines.push(`${BOLD}Confidence:${RESET_COLOR} ${ratingDisplay}`);
  lines.push(`${DIM}Reason: ${result.justification}${RESET_COLOR}`);
  lines.push("");

  // Source Results - show what each source found
  lines.push(`${BOLD}Sources Queried:${RESET_COLOR}`);
  if (result.sourceResults && result.sourceResults.length > 0) {
    for (const sr of result.sourceResults) {
      const status = sr.queried
        ? (sr.cveCount > 0 ? `${sr.cveCount} CVEs found` : "0 CVEs found")
        : (sr.note || "not queried");
      lines.push(`  ${sr.source.padEnd(12)} ${status}`);
    }
  } else {
    // Fallback to simple source list
    lines.push(`  ${result.sources.join(", ") || "None"}`);
  }
  lines.push("");

  // Branch information if available
  if (result.branches.length > 0) {
    lines.push(`${BOLD}Version Branches:${RESET_COLOR}`);
    for (const branch of result.branches) {
      if (branch.noSafeVersion) {
        // Critical warning: MSV > latest means no safe version exists in this branch
        lines.push(`  ${RED}${branch.branch}.x: NO SAFE VERSION - MSV ${branch.msv} > latest ${branch.latest}${RESET_COLOR}`);
        lines.push(`    ${DIM}${RED}⚠ Do not use this branch until ${branch.msv} is released${RESET_COLOR}`);
      } else {
        lines.push(`  ${branch.branch}.x: MSV ${branch.msv} (latest: ${branch.latest})`);
      }
    }
    lines.push("");
  }

  // CVE Details (if any)
  if (result.exploitedCves.length > 0) {
    const kevCount = result.exploitedCves.filter(c => c.inCisaKev).length;
    const header = kevCount > 0
      ? `${BOLD}CVEs Analyzed (${result.cveCount}, ${kevCount} actively exploited):${RESET_COLOR}`
      : `${BOLD}CVEs Analyzed (${result.cveCount}):${RESET_COLOR}`;
    lines.push(header);

    for (const cve of result.exploitedCves.slice(0, 10)) {
      const markers = [];
      if (cve.inCisaKev) markers.push("\x1b[31mKEV\x1b[0m");
      if (cve.hasPoC) markers.push("PoC");
      if (cve.epssScore) markers.push(`EPSS:${(cve.epssScore * 100).toFixed(1)}%`);
      if (cve.fixedVersion) markers.push(`Fixed:${cve.fixedVersion}`);
      const markerStr = markers.length > 0 ? ` [${markers.join(", ")}]` : "";
      lines.push(`  ${cve.cve}${markerStr}`);
    }
    if (result.exploitedCves.length > 10) {
      lines.push(`  ${DIM}... and ${result.exploitedCves.length - 10} more${RESET_COLOR}`);
    }
    lines.push("");
  }

  // Risk Score
  if (result.riskScore) {
    lines.push(formatRiskScore(result.riskScore));
    lines.push("");
  }

  // ACTION BOX - the most important part
  if (result.action) {
    lines.push(formatActionBox(result.action));
  }

  // Data freshness footer
  if (result.dataAge) {
    const age = formatDataAge(result.dataAge);
    const indicator = getFreshnessIndicator(result.dataAge);

    if (result.dataAge.isCritical) {
      lines.push(`${indicator} - Data last checked ${age}`);
      lines.push(`${DIM}  Run with --force to refresh vulnerability data${RESET_COLOR}`);
    } else if (result.dataAge.isStale) {
      lines.push(`${indicator} - Last checked ${age}`);
    } else {
      lines.push(`${indicator} Data checked ${age}${result.fromCache ? " (cached)" : ""}`);
    }
  }

  return lines.join("\n");
}

function formatJson(result: MSVResult): string {
  return JSON.stringify(result, null, 2);
}

function formatMarkdown(result: MSVResult): string {
  // Format data age for markdown
  let dataStatus = "Fresh";
  if (result.dataAge) {
    const age = formatDataAge(result.dataAge);
    if (result.dataAge.isCritical) {
      dataStatus = `⚠️ STALE (${age})`;
    } else if (result.dataAge.isStale) {
      dataStatus = `⚡ ${age}`;
    } else {
      dataStatus = `✓ ${age}`;
    }
  }

  const lines = [
    `## ${result.displayName}`,
    "",
    `| Property | Value |`,
    `|----------|-------|`,
    `| Platform | ${result.platform} |`,
    `| **Minimum Safe Version** | **${result.minimumSafeVersion || "Unknown"}** |`,
    `| **Recommended Version** | **${result.recommendedVersion || result.minimumSafeVersion || "Unknown"}** |`,
    `| **Latest Version** | ${result.latestVersion || "N/A"} |`,
    `| Admiralty Rating | **${result.admiraltyRating.rating}** |`,
    `| Risk Score | **${result.riskScore?.score || 0}/100 ${result.riskScore?.level || "INFO"}** |`,
    `| CVE Count | ${result.cveCount} |`,
    `| Sources | ${result.sources.join(", ")} |`,
    `| Data Freshness | ${dataStatus} |`,
    "",
    `**Justification:** ${result.justification}`,
    "",
    result.riskScore ? `**Risk Recommendation:** ${result.riskScore.recommendation}` : "",
  ].filter(Boolean);

  // Show branch information
  if (result.branches.length > 0) {
    lines.push("");
    lines.push("### Version Branches");
    lines.push("");
    lines.push("| Branch | MSV | Latest |");
    lines.push("|--------|-----|--------|");
    for (const branch of result.branches) {
      lines.push(`| ${branch.branch}.x | ${branch.msv} | ${branch.latest} |`);
    }
  }

  if (result.exploitedCves.length > 0) {
    lines.push("");
    lines.push("### CVEs Analyzed");
    lines.push("");
    lines.push("| CVE | KEV | PoC | EPSS | Fixed |");
    lines.push("|-----|-----|-----|------|-------|");
    for (const cve of result.exploitedCves.slice(0, 20)) {
      const epss = cve.epssScore
        ? `${(cve.epssScore * 100).toFixed(1)}%`
        : "-";
      const fixed = cve.fixedVersion || "-";
      lines.push(
        `| ${cve.cve} | ${cve.inCisaKev ? "Yes" : "No"} | ${cve.hasPoC ? "Yes" : "No"} | ${epss} | ${fixed} |`
      );
    }
  }

  return lines.join("\n");
}

/**
 * Format batch results as CSV for Excel/spreadsheet import
 * Columns: Software, Display Name, Platform, MSV, Recommended, Latest,
 *          CVE Count, Has KEV, Risk Score, Risk Level, Confidence, Action, Data Age
 */
function formatBatchCSV(results: MSVResult[]): string {
  const headers = [
    "Software",
    "Display Name",
    "Platform",
    "Minimum Safe Version",
    "Recommended Version",
    "Latest Version",
    "CVE Count",
    "Has KEV",
    "Risk Score",
    "Risk Level",
    "Confidence Rating",
    "Action",
    "Action Message",
    "Data Age (hours)",
  ];

  const rows = results.map(result => {
    // Escape CSV values (wrap in quotes if contains comma, quote, or newline)
    const escape = (val: string | null | undefined): string => {
      if (val === null || val === undefined) return "";
      const str = String(val);
      if (str.includes(",") || str.includes('"') || str.includes("\n")) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };

    return [
      escape(result.software),
      escape(result.displayName),
      escape(result.platform),
      escape(result.minimumSafeVersion),
      escape(result.recommendedVersion),
      escape(result.latestVersion),
      result.cveCount.toString(),
      result.hasKevCves ? "Yes" : "No",
      result.riskScore?.score?.toString() || "0",
      escape(result.riskScore?.level || "INFO"),
      escape(result.admiraltyRating?.rating),
      escape(result.action?.action),
      escape(result.action?.message),
      result.dataAge?.ageHours?.toString() || "0",
    ].join(",");
  });

  return [headers.join(","), ...rows].join("\n");
}

// =============================================================================
// CLI Commands
// =============================================================================

async function cmdQuery(
  softwareInput: string,
  options: QueryOptions
): Promise<void> {
  const config = getConfig();
  const result = await queryMSV(softwareInput, options, config);

  switch (options.format) {
    case "json":
      console.log(formatJson(result));
      break;
    case "markdown":
      console.log(formatMarkdown(result));
      break;
    default:
      console.log(formatText(result));
  }
}

async function cmdBatch(
  filePath: string,
  options: QueryOptions
): Promise<void> {
  if (!existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const content = readFileSync(filePath, "utf-8");
  const softwareList = content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));

  const config = getConfig();
  const results: MSVResult[] = [];

  for (const software of softwareList) {
    try {
      const result = await queryMSV(software, options, config);
      results.push(result);
    } catch (error) {
      console.error(`Error querying ${software}:`, (error as Error).message);
    }
  }

  // Apply filter if specified
  let filteredResults = results;
  const filter = options.filter || "all";

  if (filter !== "all") {
    filteredResults = results.filter((r) => {
      switch (filter) {
        case "kev":
          // Only products with CISA KEV CVEs
          return r.hasKevCves || r.exploitedCves?.some(c => c.inCisaKev);
        case "urgent":
          // KEV CVEs OR high CVE count (>20) OR undetermined with CVEs
          const hasKev = r.hasKevCves || r.exploitedCves?.some(c => c.inCisaKev);
          const highCveCount = r.cveCount > 20;
          const undeterminedWithCves = !r.minimumSafeVersion && r.cveCount > 0;
          return hasKev || highCveCount || undeterminedWithCves;
        case "stale":
          // Products with stale data (>7 days)
          return r.dataAge?.isStale || r.dataAge?.isCritical;
        case "undetermined":
          // Products where MSV could not be determined
          return !r.minimumSafeVersion || r.minimumSafeVersion === "UNDETERMINED";
        default:
          return true;
      }
    });

    // Show filter summary
    const CYAN = "\x1b[36m";
    const RESET = "\x1b[0m";
    const DIM = "\x1b[2m";
    console.log(`${CYAN}Filter: ${filter}${RESET} ${DIM}(${filteredResults.length}/${results.length} products)${RESET}\n`);
  }

  if (options.format === "json") {
    console.log(JSON.stringify(filteredResults, null, 2));
  } else if (options.format === "csv") {
    // CSV format - ideal for Excel/spreadsheet import
    console.log(formatBatchCSV(filteredResults));
  } else if (options.format === "markdown") {
    console.log("# MSV Batch Results\n");
    if (filter !== "all") {
      console.log(`> **Filter:** ${filter} (${filteredResults.length}/${results.length} products)\n`);
    }
    for (const result of filteredResults) {
      console.log(formatMarkdown(result));
      console.log("\n---\n");
    }
  } else {
    for (const result of filteredResults) {
      console.log(formatText(result));
      console.log("\n" + "=".repeat(60) + "\n");
    }
  }
}

async function cmdRefresh(): Promise<void> {
  const config = getConfig();
  console.log("Refreshing CISA KEV cache...");

  const kevClient = new CisaKevClient(config.dataDir);
  const catalog = await kevClient.fetchCatalog(true);
  const stats = await kevClient.getStats();

  console.log(`KEV catalog refreshed: ${stats.totalCount} vulnerabilities`);
  console.log(`  Last updated: ${stats.lastUpdated}`);
  console.log(`  Ransomware-related: ${stats.ransomwareCount}`);
}

// =============================================================================
// Check Command - Compliance Checking
// =============================================================================

interface CheckOptions extends QueryOptions {
  autoAdd: boolean;
  inputFormat?: "csv" | "json" | "list";
}

async function cmdCheck(
  input: string,
  options: CheckOptions
): Promise<void> {
  const config = getConfig();
  const catalogPath = resolve(config.dataDir, "SoftwareCatalog.json");

  // Parse input (file or direct list)
  let parseResult;
  if (existsSync(input)) {
    parseResult = parseFile(input);
    if (options.verbose) {
      console.log(`Loaded ${parseResult.items.length} items from ${input} (${parseResult.format} format)`);
    }
  } else {
    parseResult = parseInput(input, options.inputFormat);
    if (options.verbose) {
      console.log(`Parsed ${parseResult.items.length} items from input`);
    }
  }

  if (parseResult.errors.length > 0) {
    for (const error of parseResult.errors) {
      console.warn(`Warning: ${error}`);
    }
  }

  if (parseResult.items.length === 0) {
    throw new Error("No software items found in input");
  }

  const results: ComplianceResult[] = [];
  const unknownSoftware: Array<{ input: SoftwareInput; discovery: DiscoveryResult }> = [];

  // Process each software item
  for (const item of parseResult.items) {
    if (options.verbose) {
      console.log(`\nChecking: ${item.software}${item.currentVersion ? ` (${item.currentVersion})` : ""}...`);
    }

    // Try to resolve software
    let software = resolveSoftware(item.software, config);

    // If not found, try auto-discovery
    if (!software) {
      if (options.verbose) {
        console.log(`  Software not in catalog, searching NVD...`);
      }

      const discovery = await discoverSoftware(item.software, catalogPath, options.autoAdd);

      if (discovery.autoAdded) {
        // Reload and resolve
        catalogCache = null; // Clear cache
        software = resolveSoftware(item.software, config);
        if (options.verbose) {
          console.log(`  ${discovery.message}`);
        }
      } else if (discovery.needsConfirmation) {
        unknownSoftware.push({ input: item, discovery });
        results.push({
          software: item.software,
          displayName: item.software,
          currentVersion: item.currentVersion || null,
          minimumSafeVersion: null,
          recommendedVersion: null,
          latestVersion: null,
          status: "NOT_FOUND",
          action: "investigate",
          actionMessage: discovery.message,
          admiraltyRating: null,
          sources: [],
          error: `Not in catalog. ${discovery.matches.length} potential matches found.`,
        });
        continue;
      } else {
        results.push({
          software: item.software,
          displayName: item.software,
          currentVersion: item.currentVersion || null,
          minimumSafeVersion: null,
          recommendedVersion: null,
          latestVersion: null,
          status: "NOT_FOUND",
          action: "investigate",
          actionMessage: discovery.message,
          admiraltyRating: null,
          sources: [],
          error: "Software not found in catalog or NVD",
        });
        continue;
      }
    }

    // Query MSV
    try {
      const msvResult = await queryMSV(item.software, { ...options, verbose: false }, config);

      // Check compliance
      const compliance = checkCompliance(
        item.currentVersion,
        msvResult.minimumSafeVersion,
        msvResult.recommendedVersion
      );

      results.push({
        software: item.software,
        displayName: msvResult.displayName,
        currentVersion: item.currentVersion || null,
        minimumSafeVersion: msvResult.minimumSafeVersion,
        recommendedVersion: msvResult.recommendedVersion,
        latestVersion: msvResult.latestVersion,
        status: compliance.status,
        action: compliance.action,
        actionMessage: compliance.message,
        admiraltyRating: msvResult.admiraltyRating,
        sources: msvResult.sources,
        branches: msvResult.branches.map(b => ({
          branch: b.branch,
          msv: b.msv,
          currentInBranch: item.currentVersion?.startsWith(b.branch) || false,
          compliant: item.currentVersion
            ? compareVersions(item.currentVersion, b.msv) >= 0
            : false,
        })),
        dataAge: msvResult.dataAge,
      });
    } catch (error) {
      results.push({
        software: item.software,
        displayName: software?.displayName || item.software,
        currentVersion: item.currentVersion || null,
        minimumSafeVersion: null,
        recommendedVersion: null,
        latestVersion: null,
        status: "ERROR",
        action: "investigate",
        actionMessage: "Query failed",
        admiraltyRating: null,
        sources: [],
        error: (error as Error).message,
      });
    }
  }

  // Generate summary
  const summary = generateSummary(results);

  // Output results
  switch (options.format) {
    case "json":
      console.log(formatComplianceJSON(results, summary));
      break;
    case "csv":
      console.log(formatComplianceCSV(results));
      break;
    case "markdown":
      console.log(formatCheckMarkdown(results, summary));
      break;
    default:
      // Text output
      console.log("\n" + "═".repeat(60));
      console.log("MSV COMPLIANCE CHECK");
      console.log("═".repeat(60) + "\n");

      for (const result of results) {
        console.log(formatComplianceText(result));
        console.log("");
      }

      console.log(formatSummaryText(summary));
  }

  // Show unknown software that needs confirmation
  if (unknownSoftware.length > 0 && options.format === "text") {
    console.log("\n" + "─".repeat(60));
    console.log("UNKNOWN SOFTWARE - NEEDS CONFIRMATION");
    console.log("─".repeat(60) + "\n");

    for (const { input, discovery } of unknownSoftware) {
      console.log(`\n${input.software}:`);
      if (discovery.matches.length > 0) {
        console.log("  Potential matches:");
        for (let i = 0; i < Math.min(5, discovery.matches.length); i++) {
          const match = discovery.matches[i];
          console.log(`    ${i + 1}. ${match.vendor}:${match.product} - ${match.title}`);
          console.log(`       CPE: ${match.cpe23}`);
          console.log(`       Windows: ${match.isWindows ? "Yes" : "Unknown"}, Confidence: ${match.confidence}`);
        }
        console.log("\n  To add, use: msv add-software \"" + input.software + "\" --cpe <cpe23>");
      } else {
        console.log("  No matches found in NVD. This software may not have published CVEs.");
      }
    }
  }
}

function formatCheckMarkdown(results: ComplianceResult[], summary: ReturnType<typeof generateSummary>): string {
  const lines = [
    "# MSV Compliance Check Report",
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    "## Summary",
    "",
    "| Metric | Count |",
    "|--------|-------|",
    `| Total | ${summary.total} |`,
    `| Compliant | ${summary.compliant} |`,
    `| Non-Compliant | ${summary.nonCompliant} |`,
    `| Outdated | ${summary.outdated} |`,
    `| Unknown | ${summary.unknown} |`,
    `| Not Found | ${summary.notFound} |`,
    "",
    `**Compliance Rate: ${((summary.compliant / summary.total) * 100).toFixed(1)}%**`,
    "",
    "## Results",
    "",
    "| Software | Current | MSV | Recommended | Status | Action |",
    "|----------|---------|-----|-------------|--------|--------|",
  ];

  for (const r of results) {
    const status = r.status === "COMPLIANT" ? "✓" :
                   r.status === "NON_COMPLIANT" ? "✗" :
                   r.status === "OUTDATED" ? "!" : "?";
    lines.push(
      `| ${r.displayName} | ${r.currentVersion || "-"} | ${r.minimumSafeVersion || "-"} | ${r.recommendedVersion || "-"} | ${status} ${r.status} | ${r.action} |`
    );
  }

  // Add non-compliant details
  const nonCompliant = results.filter(r => r.status === "NON_COMPLIANT");
  if (nonCompliant.length > 0) {
    lines.push("");
    lines.push("## Action Required");
    lines.push("");
    for (const r of nonCompliant) {
      lines.push(`### ${r.displayName}`);
      lines.push("");
      lines.push(`- **Current Version:** ${r.currentVersion || "Unknown"}`);
      lines.push(`- **Minimum Safe Version:** ${r.minimumSafeVersion}`);
      lines.push(`- **Recommended Version:** ${r.recommendedVersion}`);
      lines.push(`- **Action:** ${r.actionMessage}`);
      if (r.admiraltyRating) {
        lines.push(`- **Confidence:** ${r.admiraltyRating.rating} - ${r.admiraltyRating.description}`);
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

function cmdList(config: Config, category?: string): void {
  const catalog = loadSoftwareCatalog(config);
  let software = catalog.software;

  // Filter by category if specified
  if (category) {
    software = software.filter((s) => s.category === category);
  }

  // Group by category
  const categories = new Map<string, SoftwareMapping[]>();
  for (const sw of software) {
    const cat = sw.category || "other";
    if (!categories.has(cat)) {
      categories.set(cat, []);
    }
    categories.get(cat)!.push(sw);
  }

  console.log(`Software Catalog (${software.length} entries)\n`);
  console.log(`Last Updated: ${catalog._metadata.lastUpdated}`);
  console.log(`Sources: ${catalog._metadata.sources.join(", ")}\n`);

  for (const [cat, items] of categories) {
    console.log(`\n## ${cat.toUpperCase()} (${items.length})`);
    console.log("| Software | Priority | Vendor |");
    console.log("|----------|----------|--------|");

    // Sort by priority (critical first)
    const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    items.sort((a, b) => (priorityOrder[a.priority || "low"] || 3) - (priorityOrder[b.priority || "low"] || 3));

    for (const sw of items) {
      const priority = sw.priority || "low";
      console.log(`| ${sw.displayName} | ${priority} | ${sw.vendor} |`);
    }
  }

  console.log("\n\nUse any software name or alias with 'msv query <name>'");
  console.log("Filter by category: 'msv list --category browser'");
}

function cmdStats(config: Config): void {
  const catalog = loadSoftwareCatalog(config);

  // Count by category
  const categories = new Map<string, number>();
  const priorities = { critical: 0, high: 0, medium: 0, low: 0 };
  const vendors = new Set<string>();

  for (const sw of catalog.software) {
    const cat = sw.category || "other";
    categories.set(cat, (categories.get(cat) || 0) + 1);
    priorities[sw.priority || "low"]++;
    vendors.add(sw.vendor);
  }

  console.log(`
MSV Software Catalog Statistics
${"=".repeat(40)}

Total Products:     ${catalog.software.length}
Unique Vendors:     ${vendors.size}
Last Updated:       ${catalog._metadata.lastUpdated.split("T")[0]}

Priority Breakdown:
  Critical:         ${priorities.critical}
  High:             ${priorities.high}
  Medium:           ${priorities.medium}
  Low:              ${priorities.low}

Categories:
${Array.from(categories.entries())
  .sort((a, b) => b[1] - a[1])
  .map(([cat, count]) => `  ${cat.padEnd(20)} ${count}`)
  .join("\n")}

Top Vendors:
${Array.from(vendors)
  .map(v => ({
    vendor: v,
    count: catalog.software.filter(s => s.vendor === v).length
  }))
  .sort((a, b) => b.count - a.count)
  .slice(0, 10)
  .map(v => `  ${v.vendor.padEnd(20)} ${v.count}`)
  .join("\n")}

Data Sources:
  ${catalog._metadata.sources.join("\n  ")}
`);
}

// =============================================================================
// Database Management
// =============================================================================

async function cmdDb(subcommand: string | undefined, options: QueryOptions): Promise<void> {
  const client = new AppThreatClient();

  switch (subcommand) {
    case "status":
      cmdDbStatus(client);
      break;

    case "update":
      await cmdDbUpdate();
      break;

    case "query":
      console.log("Usage: msv query <software> to search the database");
      break;

    default:
      console.log(`
AppThreat Database Management
${"=".repeat(40)}

COMMANDS:
  msv db status        Show database status and metadata
  msv db update        Download or update the database

The AppThreat database provides offline vulnerability queries with:
- Multi-source data (NVD + OSV + GitHub advisories)
- Fast millisecond queries (no API rate limits)
- VERS format for version ranges
`);
  }
}

function cmdDbStatus(client: AppThreatClient): void {
  const available = client.isDatabaseAvailable();

  console.log(`
AppThreat Database Status
${"=".repeat(40)}
`);

  if (!available) {
    console.log(`Status:        ${"\x1b[33m"}NOT INSTALLED${RESET_COLOR}
Location:      C:\\Users\\<user>\\AppData\\Local\\vdb\\vdb\\

To install, run:
  pip install appthreat-vulnerability-db[oras]
  vdb --download-image
`);
    return;
  }

  const size = client.getDatabaseSize();
  const ageHours = client.getDatabaseAgeHours();
  const needsUpdate = ageHours === null || ageHours > 48;
  const metadata = client.getMetadata();

  const statusColor = needsUpdate ? "\x1b[33m" : "\x1b[32m";
  const statusText = needsUpdate ? "NEEDS UPDATE" : "UP TO DATE";
  const ageText = ageHours !== null ? `${Math.round(ageHours)} hours ago` : "Unknown";

  console.log(`Status:        ${statusColor}${statusText}${RESET_COLOR}
Database Size: ${size.totalMB} MB (data: ${Math.round(size.dataSize / (1024 * 1024))} MB, index: ${Math.round(size.indexSize / (1024 * 1024))} MB)
Last Modified: ${metadata?.createdUtc?.split("T")[0] || "Unknown"} (${ageText})
Auto-Update:   48 hours (updates automatically when querying)
Location:      ${join(homedir(), "AppData", "Local", "vdb", "vdb")}

Data Sources:
  - NVD (National Vulnerability Database)
  - OSV (Open Source Vulnerability)
  - GitHub Security Advisories

Admiralty Rating: B2 (Usually Reliable, Probably True)
`);

  // Quick test query
  console.log("Testing database...");
  client.searchByCpe("cpe:2.3:a:*:putty:*", { limit: 1 }).then((results) => {
    if (results.length > 0) {
      console.log(`Database test: ${"\x1b[32m"}PASS${RESET_COLOR} (found ${results[0].cveId})`);
    } else {
      console.log(`Database test: ${"\x1b[33m"}WARNING${RESET_COLOR} (no results for test query)`);
    }
  });
}

async function cmdDbUpdate(): Promise<void> {
  console.log("Updating AppThreat vulnerability database...");
  console.log("This downloads ~700MB compressed from ghcr.io/appthreat/vdbxz-app\n");

  // Execute vdb --download-image using child process
  const { spawn } = await import("node:child_process");

  const vdbProcess = spawn("vdb", ["--download-image"], {
    stdio: "inherit",
    shell: true,
  });

  return new Promise((resolve, reject) => {
    vdbProcess.on("close", (code) => {
      if (code === 0) {
        console.log("\nDatabase updated successfully!");
        console.log("Run 'msv db status' to verify.");
        resolve();
      } else {
        console.error(`\nDatabase update failed with code ${code}`);
        console.error("Make sure vdb is installed: pip install appthreat-vulnerability-db[oras]");
        reject(new Error(`vdb exited with code ${code}`));
      }
    });

    vdbProcess.on("error", (err) => {
      console.error("\nFailed to run vdb:", err.message);
      console.error("Make sure vdb is installed: pip install appthreat-vulnerability-db[oras]");
      reject(err);
    });
  });
}

const MSV_VERSION = "1.2.0";

function showHelp(): void {
  console.log(`
MSV - Minimum Safe Version Calculator v${MSV_VERSION}

Determines the lowest software version free of medium, high, and critical
vulnerabilities for Windows 11/Server software. Prioritizes actively exploited
vulnerabilities (CISA KEV) but also considers all significant CVEs.

USAGE:
  msv <command> [options]

COMMANDS:
  query <software>     Query MSV for a specific software
  check <input>        Check compliance for software inventory
  batch <file>         Query MSV for multiple software from file
  stats                Show catalog statistics
  refresh              Force refresh all caches
  list                 List supported software
  list <category>      List software in a category
  db status            Show AppThreat database status
  db update            Download/update AppThreat database
  help                 Show this help message

SUPPORTED SOFTWARE (135+ products):
  Browsers           Chrome, Edge, Firefox, Brave, Opera
  PDF                Adobe Acrobat DC/2024/2020, Reader DC/2020/2024, Foxit
  Remote Access      PuTTY suite (8 tools), WinSCP, TeamViewer, AnyDesk
  Monitoring         SolarWinds Orion (NPM, SAM, NCM, NTA, IPAM, VMAN, DPA)
                     Serv-U, Web Help Desk, DameWare, Engineer's Toolset
  Analytics          Tableau Desktop, Server, Prep, Bridge
  Enterprise         Citrix, VMware, Splunk, CrowdStrike, Microsoft 365
  Development        VS Code, Git, Node.js, Python, Docker, Terraform
  Databases          PostgreSQL, MySQL, MariaDB, MongoDB, Redis
  Web Servers        Apache, nginx, Tomcat, IIS
  Security           KeePass, Bitwarden, 1Password, Malwarebytes
  Adobe Enterprise   ColdFusion (15 KEV), Commerce/Magento, Experience Manager

ADOBE ACROBAT READER TRACKS:
  Adobe has multiple release tracks with DIFFERENT MSVs:

  Continuous (DC)    Auto-updates, versions like 24.005.20320
                     Query: msv query "Reader DC" or "Acrobat Reader DC"

  Classic 2024       Quarterly updates, versions like 24.001.30159
                     Query: msv query "Reader 2024" or "Acrobat Reader 2024"

  Classic 2020       EOL 2025, versions like 20.005.30636
                     Query: msv query "Reader 2020" or "Acrobat Reader 2020"

  To identify: Help → About in Reader/Acrobat shows version number.
  If you query generic "Adobe Acrobat Reader", MSV shows all tracks.

POWERSHELL VERSIONS:
  Windows has multiple PowerShell products:

  Windows PowerShell 5.1   Built-in, updated via Windows Update
                           Versions like 5.1.26100.7462 (tied to OS build)
                           Query: msv query "Windows PowerShell"

  PowerShell 6 (EOL)       END OF LIFE since September 2020
                           NO SECURITY PATCHES - Upgrade to 7 immediately!
                           Query: msv query "PowerShell 6"

  PowerShell 7             Standalone cross-platform installation
                           LTS: 7.4.x (EOL Nov 2026), Current: 7.5.x (EOL May 2026)
                           Query: msv query "PowerShell 7" or "pwsh"
                           Update via: winget, MSI, or Microsoft Update

  To identify: Run $PSVersionTable.PSVersion in PowerShell
  If you query generic "PowerShell", MSV shows all variants.

CHECK COMMAND:
  The 'check' command accepts input in multiple formats:

  Direct list:
    msv check "Chrome 120.0.1, Edge 121.0.2, Wireshark 4.2.0"

  CSV file (software,version):
    msv check inventory.csv

  JSON file:
    msv check inventory.json

  Input formats auto-detected, or specify with --csv, --json, --list

OPTIONS:
  --format <type>      Output format: text (default), json, markdown, csv
  --filter <type>      Filter batch results: kev, urgent, stale, undetermined, all
                       kev = Only CISA KEV CVEs, urgent = KEV + high CVE count,
                       stale = Old data, undetermined = No MSV determined
  --verbose            Show detailed query progress
  --force              Force cache refresh
  --auto-add           Auto-add unknown Windows software to catalog
  --csv                Force CSV input parsing
  --json               Force JSON input parsing
  --list               Force direct list parsing

EXAMPLES:
  msv query "Google Chrome"
  msv query "SolarWinds Serv-U" --format json
  msv query "Adobe Acrobat DC"
  msv batch inventory.txt --filter kev          # Only KEV-affected products
  msv batch inventory.txt --filter urgent       # KEV + high CVE count
  msv batch inventory.txt --filter undetermined # Products needing manual review
  msv check "Chrome 120.0.1, PuTTY 0.80, Wireshark 4.2.0"
  msv check inventory.csv --format markdown
  msv stats
  msv list monitoring
  msv list remote_access

COMPLIANCE STATUS:
  COMPLIANT      - Current version >= Minimum Safe Version
  NON_COMPLIANT  - Current version < MSV (upgrade required)
  OUTDATED       - Current version >= MSV but < Recommended
  UNKNOWN        - No current version provided or MSV not determined
  NOT_FOUND      - Software not in catalog (use --auto-add to discover)

ADMIRALTY RATINGS:
  A1 - Completely Reliable, Confirmed (CISA KEV active exploitation)
  A2 - Completely Reliable, Probably True (Vendor advisory)
  B2 - Usually Reliable, Probably True (VulnCheck PoC verified)
  B3 - Usually Reliable, Possibly True (High EPSS score)
  C4 - Fairly Reliable, Doubtful (CVE data but no MSV determined)
  F6 - Cannot be judged (No vulnerability data found)

DATA SOURCES:
  CISA KEV         Known Exploited Vulnerabilities (A1 rating)
  Vendor Advisory  Direct from vendor security pages (A2 rating)
  VulnCheck        PoC and exploit intelligence (B2 rating)
  EPSS             Exploitation probability scores (B3 rating)
  NVD              National Vulnerability Database (version data)

ENVIRONMENT:
  VULNCHECK_API_KEY    VulnCheck API token (in .claude/.env)
`);
}

// =============================================================================
// Main Entry Point
// =============================================================================

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "help" || args[0] === "--help") {
    showHelp();
    return;
  }

  // Parse options
  const options: QueryOptions & { autoAdd?: boolean; inputFormat?: "csv" | "json" | "list" } = {
    format: "text",
    verbose: false,
    forceRefresh: false,
  };

  const positionalArgs: string[] = [];
  let category: string | undefined;
  let autoAdd = false;
  let inputFormat: "csv" | "json" | "list" | undefined;
  let filter: BatchFilter | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--format" && args[i + 1]) {
      options.format = args[++i] as "text" | "json" | "markdown" | "csv";
    } else if (arg === "--verbose" || arg === "-v") {
      options.verbose = true;
    } else if (arg === "--force" || arg === "-f") {
      options.forceRefresh = true;
    } else if (arg === "--filter" && args[i + 1]) {
      filter = args[++i] as BatchFilter;
      options.filter = filter;
    } else if (arg === "--category" && args[i + 1]) {
      category = args[++i];
    } else if (arg === "--auto-add") {
      autoAdd = true;
    } else if (arg === "--csv") {
      inputFormat = "csv";
    } else if (arg === "--json") {
      inputFormat = "json";
    } else if (arg === "--list") {
      inputFormat = "list";
    } else if (!arg.startsWith("-")) {
      positionalArgs.push(arg);
    }
  }

  const command = positionalArgs[0];
  const config = getConfig();

  // Configure logger based on verbose mode
  configureLogger(options.verbose);

  // Auto-update AppThreat database if older than 48 hours
  // Skip for commands that don't need the database
  const skipAutoUpdate = ["help", "--help", "stats", "list", "db"].includes(command);
  if (!skipAutoUpdate) {
    const appThreatClient = new AppThreatClient();
    const ageHours = appThreatClient.getDatabaseAgeHours();

    if (ageHours === null) {
      // Database not installed - attempt auto-download
      console.log("\x1b[33mAppThreat database not found. Attempting download...\x1b[0m");
      const downloaded = await appThreatClient.ensureFreshDatabase(0, true);
      if (downloaded) {
        console.log("\x1b[32mDatabase installed successfully!\x1b[0m\n");
      } else {
        console.log("\n\x1b[33mMSV will continue without offline vulnerability data.\x1b[0m");
        console.log("\x1b[2mOnline sources (CISA KEV, NVD) will still be queried.\x1b[0m\n");
      }
    } else if (ageHours > 48) {
      // Database is stale - auto-update
      console.log(`\x1b[2mAppThreat database is ${Math.round(ageHours)} hours old, updating...\x1b[0m`);
      // Always show verbose output on failure so users see installation instructions
      const updated = await appThreatClient.ensureFreshDatabase(48, true);
      if (updated) {
        console.log("\x1b[32mDatabase updated successfully.\x1b[0m\n");
      } else {
        console.log("\x1b[33mDatabase update failed, continuing with cached data.\x1b[0m");
        console.log("\x1b[2mSee installation instructions above.\x1b[0m\n");
      }
    }
  }

  try {
    switch (command) {
      case "query":
        if (!positionalArgs[1]) {
          throw new Error("Missing software name. Usage: msv query <software>");
        }
        await cmdQuery(positionalArgs[1], options);
        break;

      case "check":
        if (!positionalArgs[1]) {
          throw new Error("Missing input. Usage: msv check <file|list>");
        }
        await cmdCheck(positionalArgs[1], {
          ...options,
          autoAdd,
          inputFormat,
        });
        break;

      case "batch":
        if (!positionalArgs[1]) {
          throw new Error("Missing file path. Usage: msv batch <file>");
        }
        await cmdBatch(positionalArgs[1], options);
        break;

      case "refresh":
        await cmdRefresh();
        break;

      case "stats":
        cmdStats(config);
        break;

      case "list":
        cmdList(config, category || positionalArgs[1]);
        break;

      case "db":
        await cmdDb(positionalArgs[1], options);
        break;

      default:
        // Assume it's a direct software query
        await cmdQuery(command, options);
    }
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exit(1);
  }
}

main();
