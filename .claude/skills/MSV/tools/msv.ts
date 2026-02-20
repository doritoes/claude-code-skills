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
  type MsvDataSource,
  type MsvRatingInput,
} from "./AdmiraltyScoring";
import {
  generateAction,
  formatActionBox,
  detectVersionSchemeMismatch,
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
import { getVendorFetcher, isLegacyProductVersion, type VendorAdvisoryResult } from "./VendorAdvisory";
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
  queryRouter,
  listVendors,
  listModelsByVendor,
  getCatalogStats,
  formatRouterResult,
  type RouterQuery,
} from "./RouterClient";
import { RouterCatalogUpdater } from "./RouterCatalogUpdater";
import {
  AppThreatClient,
  getMinimumSafeVersion as getAppThreatMsv,
  type VulnResult as AppThreatVulnResult,
} from "./AppThreatClient";
import { createLogger, type Logger } from "./Logger";
import {
  formatText,
  formatJson,
  formatMarkdown,
  formatBatchCSV,
  formatDataAge,
  getFreshnessIndicator,
} from "./format";
import type {
  Config,
  BatchFilter,
  QueryOptions,
  OutputFormat,
  MSVResult,
  DataFreshness,
  BranchMsvResult,
  ExploitedCVE,
  SoftwareMapping,
  SoftwareCatalog,
  VariantInfo,
  VariantMsv,
} from "./types";
import { CtiReportGenerator } from "./CtiReportGenerator";
import { EndOfLifeClient } from "./EndOfLifeClient";
import { formatCtiReport } from "./CtiFormatter";
import type { CTIReportOptions, CTIUserProfile, ReportPeriod, CTIOutputFormat } from "./CtiTypes";

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

  // Load environment variables from .env file
  let vulncheckApiKey: string | undefined;
  if (existsSync(envPath)) {
    const envContent = readFileSync(envPath, "utf-8");

    // Load VULNCHECK_API_KEY
    const vulncheckMatch = envContent.match(/VULNCHECK_API_KEY=(.+)/);
    if (vulncheckMatch) {
      vulncheckApiKey = vulncheckMatch[1].trim();
    }

    // Load NVD_API_KEY into process.env for NvdClient
    const nvdMatch = envContent.match(/NVD_API_KEY=(.+)/);
    if (nvdMatch && !process.env.NVD_API_KEY) {
      process.env.NVD_API_KEY = nvdMatch[1].trim();
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

  // When --force is used, delete the MSV cache entry so we get completely fresh data
  if (options.forceRefresh) {
    const deleted = msvCache.delete(productId);
    if (deleted) {
      logger.debug(`Cleared MSV cache entry for ${productId}`);
    }
  }

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
        dataSources: cached.dataSources.map((s): MsvDataSource => {
          if (s === "Vendor Advisory") return "vendor_advisory";
          if (s === "NVD") return "nvd";
          if (s === "CISA KEV") return "cisa_kev";
          if (s === "VulnCheck") return "vulncheck";
          if (s === "AppThreat") return "appthreat";
          return "none"; // Unknown source mapped to none
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

      // Always regenerate justification to match recalculated MSV
      const admiraltyRating = calculateMsvRating(ratingInput);
      const justification = generateJustification(
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

      // Try to get latest version from multiple sources (in priority order):
      // 1. Chocolatey (Windows package manager — live, 24h cache)
      // 2. endoflife.date (structured EOL/version database — live, 24h cache)
      // 3. Catalog (static, manually maintained — fallback)
      // Live sources take priority over static catalog to avoid stale data.
      let latestVersion: string | null = null;

      // Try Chocolatey first (live source)
      try {
        const chocoClient = new ChocolateyClient(config.dataDir);
        const chocoVersion = await chocoClient.getLatestVersion(software.id);
        if (chocoVersion) {
          latestVersion = chocoVersion;
          logger.debug(`Latest version from Chocolatey: ${chocoVersion}`);
        }
      } catch {
        // Chocolatey lookup failed
      }

      if (!latestVersion) {
        // Try endoflife.date as second live source
        try {
          const eolClient = new EndOfLifeClient(join(config.dataDir, "eol"));
          const eolData = await eolClient.getProduct(software.id);
          if (eolData?.cycles?.length > 0) {
            // Get latest version from most recent cycle
            latestVersion = eolData.cycles[0].latest;
            logger.debug(`Latest version from endoflife.date: ${latestVersion}`);
          }
        } catch {
          // endoflife.date lookup failed, continue without latest version
        }
      }

      // Fall back to static catalog value
      if (!latestVersion) {
        latestVersion = software.latestVersion || null;
      }

      // Latest release is always at least as safe as the highest patched version
      if (latestVersion && recommendedVersion && compareVersions(latestVersion, recommendedVersion) > 0) {
        recommendedVersion = latestVersion;
      }

      // Generate action guidance (now that we have latestVersion)
      const branchesWithNoSafeVersion = branches.filter(b => b.noSafeVersion);
      const actionInput: ActionInput = {
        currentVersion: options.currentVersion || null,
        minimumSafeVersion,
        recommendedVersion,
        admiraltyRating,
        hasKevCves: cached.hasKevCves || false,
        cveCount,
        sources: cached.dataSources,
        vendor: software.vendor,
        branchesWithNoSafeVersion: branchesWithNoSafeVersion.length > 0 ? branchesWithNoSafeVersion : undefined,
        latestVersion,
        // Note: cveFixedVersions not available from cache, so version mismatch detection
        // will be limited for cached results
      };

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

      let action = generateAction(actionInput);

      // Override action if user's version is from a discontinued product line
      if (options.currentVersion && isLegacyProductVersion(software.vendor, software.product, options.currentVersion)) {
        action = {
          action: "UPGRADE_CRITICAL",
          symbol: "\u26D4",
          color: "\x1b[31m",
          headline: "END OF LIFE",
          message: `Version ${options.currentVersion} is from a discontinued product line (e.g., Edge Legacy). Migrate to the current product immediately.`,
          urgency: "critical",
        };
      }

      riskScoreInput.isCompliant = !!(options.currentVersion && action.action === "NO_ACTION");

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
        action,
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
      // When --force is used, clear vendor advisory cache to get fresh data
      if (options.forceRefresh) {
        try {
          const { readdirSync, unlinkSync } = await import("node:fs");
          const { resolve: resolvePath } = await import("node:path");
          const files = readdirSync(config.dataDir);
          for (const file of files) {
            if (file.startsWith("vendor-") && file.endsWith(".json")) {
              try { unlinkSync(resolvePath(config.dataDir, file)); } catch { /* ignore */ }
            }
          }
          logger.debug("Cleared vendor advisory cache for --force refresh");
        } catch {
          // Cache clear failed - continue with potentially cached data
        }
      }
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

        logger.debug(`Found ${vendorData.advisories.length} advisories, ${branches.length} branches`);
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.warn(`Vendor advisory fetch failed: ${errMsg}`);
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
          if (originalCount !== appThreatResults.length) {
            logger.debug(`Filtered ${originalCount - appThreatResults.length} CVEs with invalid version patterns`);
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
          if (originalCount !== appThreatResults.length) {
            logger.debug(`Filtered ${originalCount - appThreatResults.length} CVEs matching exclude patterns`);
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

          logger.debug(`Found ${appThreatResults.length} CVEs from AppThreat, MSV: ${appThreatMsv}`);
        } else {
          sourceResults.push({
            source: "AppThreat",
            queried: true,
            cveCount: 0,
          });
        }
        appThreatClient.close();
      } catch (error) {
        const appThreatErr = error instanceof Error ? error.message : String(error);
        logger.warn(`AppThreat query failed: ${appThreatErr}`);
        sourceResults.push({
          source: "AppThreat",
          queried: true,
          cveCount: 0,
          note: "query failed",
        });
      }
    } else {
      logger.debug("AppThreat database not available (run: vdb --download-image)");
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
    const kevErr = error instanceof Error ? error.message : String(error);
    logger.warn(`CISA KEV query failed: ${kevErr}`);
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
      const vcErr = error instanceof Error ? error.message : String(error);
      logger.warn(`VulnCheck query failed: ${vcErr}`);
      evidence.push({ source: "VulnCheck", hasData: false });
      sourceResults.push({
        source: "VulnCheck",
        queried: true,
        cveCount: 0,
        note: "query failed",
      });
    }
  }

  // 3.5. Query NVD by CPE if: no CVEs found yet, OR CVEs found but no version data, OR version mismatch detected
  const hasVersionData = exploitedCves.some(cve => cve.fixedVersion);

  // Detect version scheme mismatch (CVEs may be for different product with similar name)
  const cveFixedVersionsForMismatchCheck = exploitedCves
    .map(c => c.fixedVersion)
    .filter((v): v is string => v !== null && v !== undefined);
  const versionMismatch = detectVersionSchemeMismatch(software.latestVersion, cveFixedVersionsForMismatchCheck);

  const shouldQueryNvd = (exploitedCves.length === 0 || !hasVersionData || versionMismatch.hasMismatch) && software.cpe23;
  if (shouldQueryNvd) {
    let reason: string;
    if (versionMismatch.hasMismatch) {
      reason = `version mismatch detected - ${versionMismatch.reason}`;
    } else if (exploitedCves.length === 0) {
      reason = "no CVEs from other sources";
    } else {
      reason = `${exploitedCves.length} CVEs found but missing version data`;
    }
    logger.debug(`Querying NVD by CPE (${reason})...`);
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
          if (originalCount !== filteredResults.length) {
            logger.debug(`Filtered ${originalCount - filteredResults.length} NVD CVEs with invalid version patterns`);
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
          if (originalCount !== filteredResults.length) {
            logger.debug(`Filtered ${originalCount - filteredResults.length} NVD CVEs matching exclude patterns`);
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
          note: versionMismatch.hasMismatch ? "queried due to version mismatch in other sources" : undefined,
        });

        logger.debug(`Found ${filteredResults.length} CVEs from NVD (CVSS >= 4.0)`);
      } else {
        evidence.push({ source: "NVD", hasData: false });
        sourceResults.push({
          source: "NVD",
          queried: true,
          cveCount: 0,
          note: versionMismatch.hasMismatch ? "queried due to version mismatch (no relevant CVEs found)" : undefined,
        });
        logger.debug("No CVEs found in NVD for this CPE");
      }
    } catch (error) {
      const nvdCpeErr = error instanceof Error ? error.message : String(error);
      logger.warn(`NVD CPE query failed: ${nvdCpeErr}`);
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
        const nvdErr = error instanceof Error ? error.message : String(error);
        logger.warn(`NVD query failed: ${nvdErr}`);
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
      const epssErr = error instanceof Error ? error.message : String(error);
      logger.warn(`EPSS query failed: ${epssErr}`);
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
    dataSources: sources.map((s): MsvDataSource => {
      if (s === "Vendor Advisory") return "vendor_advisory";
      if (s === "NVD") return "nvd";
      if (s === "CISA KEV") return "cisa_kev";
      if (s === "VulnCheck") return "vulncheck";
      if (s === "AppThreat") return "appthreat";
      return "none";
    }),
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

  // Collect fixed versions from CVEs for version mismatch detection
  const cveFixedVersions = exploitedCves
    .map(c => c.fixedVersion)
    .filter((v): v is string => v !== null && v !== undefined);

  const actionInput: ActionInput = {
    currentVersion: options.currentVersion || null,
    minimumSafeVersion,
    recommendedVersion,
    admiraltyRating,
    hasKevCves,
    cveCount: exploitedCves.length,
    sources,
    vendor: software.vendor,
    branchesWithNoSafeVersion: branchesWithNoSafeVersion.length > 0 ? branchesWithNoSafeVersion : undefined,
    latestVersion: software.latestVersion,
    cveFixedVersions: cveFixedVersions.length > 0 ? cveFixedVersions : undefined,
  };
  let action = generateAction(actionInput);

  // Override action if user's version is from a discontinued product line
  if (options.currentVersion && isLegacyProductVersion(software.vendor, software.product, options.currentVersion)) {
    action = {
      action: "UPGRADE_CRITICAL",
      symbol: "\u26D4",
      color: "\x1b[31m",
      headline: "END OF LIFE",
      message: `Version ${options.currentVersion} is from a discontinued product line (e.g., Edge Legacy). Migrate to the current product immediately.`,
      urgency: "critical",
    };
  }

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
    isCompliant: !!(options.currentVersion && action.action === "NO_ACTION"),
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

  // Try to get latest version from multiple sources (in priority order):
  // 1. Chocolatey (Windows package manager — live, 24h cache)
  // 2. endoflife.date (structured EOL/version database — live, 24h cache)
  // 3. Catalog (static, manually maintained — fallback)
  // Live sources take priority over static catalog to avoid stale data.
  let latestVersion: string | null = null;

  // Try Chocolatey first (live source)
  try {
    const chocoClient = new ChocolateyClient(config.dataDir);
    const chocoVersion = await chocoClient.getLatestVersion(software.id);
    if (chocoVersion) {
      latestVersion = chocoVersion;
      logger.debug(`Latest version from Chocolatey: ${chocoVersion}`);
    }
  } catch {
    // Chocolatey lookup failed
  }

  if (!latestVersion) {
    // Try endoflife.date as second live source
    try {
      const eolClient = new EndOfLifeClient(join(config.dataDir, "eol"));
      const eolData = await eolClient.getProduct(software.id);
      if (eolData?.cycles?.length > 0) {
        // Get latest version from most recent cycle
        latestVersion = eolData.cycles[0].latest;
        logger.debug(`Latest version from endoflife.date: ${latestVersion}`);
      }
    } catch {
      // endoflife.date lookup failed, continue without latest version
    }
  }

  // Fall back to static catalog value
  if (!latestVersion) {
    latestVersion = software.latestVersion || null;
  }

  // Latest release is always at least as safe as the highest patched version
  if (latestVersion && recommendedVersion && compareVersions(latestVersion, recommendedVersion) > 0) {
    recommendedVersion = latestVersion;
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
// CLI Commands
// =============================================================================

async function cmdQuery(
  softwareInput: string,
  options: QueryOptions
): Promise<void> {
  const config = getConfig();
  const result = await queryMSV(softwareInput, options, config);

  // Attach user-supplied version for display
  if (options.currentVersion) {
    result.currentVersion = options.currentVersion;
  }

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
  const errors: string[] = [];

  // Create progress indicator
  const { createProgress } = await import("./Progress");
  const progress = createProgress(softwareList.length, "Querying MSV");

  for (const software of softwareList) {
    try {
      // Update progress with current item
      if ("update" in progress) {
        progress.update(results.length + errors.length, software);
      } else {
        progress.tick(software);
      }

      const result = await queryMSV(software, options, config);
      results.push(result);
    } catch (error) {
      errors.push(`${software}: ${(error as Error).message}`);
      if ("error" in progress) {
        progress.error();
      }
    }
  }

  // Complete progress
  progress.complete();

  // Show error summary if any
  if (errors.length > 0 && options.format === "text") {
    console.log(`\n\x1b[33mWarnings (${errors.length}):\x1b[0m`);
    for (const err of errors.slice(0, 5)) {
      console.log(`  \x1b[2m- ${err}\x1b[0m`);
    }
    if (errors.length > 5) {
      console.log(`  \x1b[2m... and ${errors.length - 5} more\x1b[0m`);
    }
    console.log("");
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

async function cmdRefresh(clearNvd: boolean = false): Promise<void> {
  const config = getConfig();

  // Refresh KEV
  console.log("Refreshing CISA KEV cache...");
  const kevClient = new CisaKevClient(config.dataDir);
  const catalog = await kevClient.fetchCatalog(true);
  const stats = await kevClient.getStats();

  console.log(`KEV catalog refreshed: ${stats.totalCount} vulnerabilities`);
  console.log(`  Last updated: ${stats.lastUpdated}`);
  console.log(`  Ransomware-related: ${stats.ransomwareCount}`);

  // Clear NVD/MSV cache if requested
  if (clearNvd) {
    const msvCachePath = resolve(config.dataDir, "msv-cache.json");
    if (existsSync(msvCachePath)) {
      const { unlinkSync } = await import("node:fs");
      unlinkSync(msvCachePath);
      console.log("\nMSV/NVD cache cleared.");
      console.log("  Next queries will fetch fresh data from NVD.");
      console.log("  Tip: Run 'msv warm' to pre-populate cache for critical software.");
    } else {
      console.log("\nNo MSV/NVD cache to clear.");
    }
  }
}

// =============================================================================
// Parallel Processing Utilities
// =============================================================================

/**
 * Process items in parallel with concurrency limit
 */
async function parallelProcess<T, R>(
  items: T[],
  processor: (item: T, index: number) => Promise<R>,
  concurrency: number = 5,
  onProgress?: (completed: number, total: number) => void
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  let completed = 0;

  async function processNext(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      const item = items[index];
      try {
        results[index] = await processor(item, index);
      } catch (error) {
        // Re-throw to be caught by Promise.all
        throw { index, error };
      }
      completed++;
      if (onProgress) {
        onProgress(completed, items.length);
      }
    }
  }

  // Start concurrent workers
  const workers = Array(Math.min(concurrency, items.length))
    .fill(null)
    .map(() => processNext());

  await Promise.all(workers);
  return results;
}

// =============================================================================
// Check Command - Compliance Checking
// =============================================================================

interface CheckOptions extends QueryOptions {
  autoAdd: boolean;
  inputFormat?: "csv" | "json" | "list";
  parallel?: boolean;  // Enable parallel processing
  concurrency?: number; // Number of concurrent queries
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
  const concurrency = options.concurrency || 5;
  const useParallel = options.parallel !== false && parseResult.items.length > 1;

  // Phase 1: Resolve all software names and categorize
  interface ResolvedItem {
    item: SoftwareInput;
    software: SoftwareMapping | null;
    index: number;
  }
  const resolvedItems: ResolvedItem[] = [];
  const needsDiscovery: ResolvedItem[] = [];

  for (let i = 0; i < parseResult.items.length; i++) {
    const item = parseResult.items[i];
    const software = resolveSoftware(item.software, config);
    const resolved = { item, software, index: i };

    if (software) {
      resolvedItems.push(resolved);
    } else {
      needsDiscovery.push(resolved);
    }
  }

  if (options.verbose) {
    console.log(`\nResolved ${resolvedItems.length} items, ${needsDiscovery.length} need discovery`);
    if (useParallel) {
      console.log(`Using parallel processing (concurrency: ${concurrency})`);
    }
  }

  // Phase 2: Handle unknown software (sequential due to NVD rate limits)
  for (const { item, index } of needsDiscovery) {
    if (options.verbose) {
      console.log(`\nDiscovering: ${item.software}...`);
    }

    const discovery = await discoverSoftware(item.software, catalogPath, options.autoAdd);

    if (discovery.autoAdded) {
      // Reload and resolve
      catalogCache = null;
      const software = resolveSoftware(item.software, config);
      if (software) {
        resolvedItems.push({ item, software, index });
        if (options.verbose) {
          console.log(`  ${discovery.message}`);
        }
        continue;
      }
    }

    if (discovery.needsConfirmation) {
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
    }
  }

  // Phase 3: Query MSV for resolved items (parallel or sequential)
  const processItem = async (resolved: ResolvedItem): Promise<ComplianceResult> => {
    const { item, software } = resolved;

    try {
      const msvResult = await queryMSV(item.software, { ...options, verbose: false }, config);

      const compliance = checkCompliance(
        item.currentVersion,
        msvResult.minimumSafeVersion,
        msvResult.recommendedVersion
      );

      return {
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
      };
    } catch (error) {
      return {
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
      };
    }
  };

  if (resolvedItems.length > 0) {
    if (useParallel) {
      // Parallel processing with progress
      let lastProgress = 0;
      const parallelResults = await parallelProcess(
        resolvedItems,
        processItem,
        concurrency,
        (completed, total) => {
          if (options.verbose) {
            const progress = Math.floor((completed / total) * 100);
            if (progress >= lastProgress + 10) {
              console.log(`  Progress: ${completed}/${total} (${progress}%)`);
              lastProgress = progress;
            }
          }
        }
      );
      results.push(...parallelResults);
    } else {
      // Sequential processing
      for (const resolved of resolvedItems) {
        if (options.verbose) {
          console.log(`\nChecking: ${resolved.item.software}...`);
        }
        const result = await processItem(resolved);
        results.push(result);
      }
    }
  }

  // Sort results by original input order
  results.sort((a, b) => {
    const indexA = parseResult.items.findIndex(i => i.software === a.software);
    const indexB = parseResult.items.findIndex(i => i.software === b.software);
    return indexA - indexB;
  });

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

// =============================================================================
// Discover Command - CPE Auto-Discovery with Smart Inference
// =============================================================================

interface DiscoverOptions {
  confirm?: number;  // Index of match to confirm and add
  verbose?: boolean;
}

/**
 * Infer category based on product name patterns
 */
function inferCategory(vendor: string, product: string, title: string): string {
  const combined = `${vendor} ${product} ${title}`.toLowerCase();

  // Category patterns - most specific first
  const patterns: [RegExp, string][] = [
    // Browsers
    [/\b(chrome|firefox|edge|safari|brave|opera|vivaldi|browser)\b/, "browser"],
    // PDF
    [/\b(acrobat|pdf|reader|foxit|nitro|pdf-xchange)\b/, "pdf"],
    // Remote Access / VPN
    [/\b(vpn|anyconnect|globalprotect|pulse|fortinet|ivanti.*connect|openvpn)\b/, "vpn"],
    [/\b(rdp|remote.*desktop|teamviewer|anydesk|vnc|citrix.*virtual)\b/, "remote_access"],
    [/\b(putty|winscp|ssh|terminal|console)\b/, "remote_access"],
    // Security
    [/\b(antivirus|endpoint|edr|xdr|crowdstrike|defender|symantec|trellix|mcafee|kaspersky|sophos|eset|bitdefender|carbon.*black)\b/, "security"],
    [/\b(firewall|utm|ngfw|palo.*alto|fortinet|check.*point|barracuda|sophos.*fw)\b/, "network_security"],
    // Monitoring
    [/\b(solarwinds|orion|npm|sam|splunk|nagios|zabbix|prometheus|grafana|datadog)\b/, "monitoring"],
    // Development
    [/\b(visual.*studio|vscode|vs.*code|intellij|eclipse|netbeans|pycharm|webstorm)\b/, "development"],
    [/\b(git|github|gitlab|bitbucket|svn|mercurial)\b/, "development"],
    [/\b(docker|kubernetes|k8s|container|podman)\b/, "containerization"],
    [/\b(node\.?js|python|java|ruby|perl|php|golang|rust|dotnet|\.net)\b/, "runtime"],
    // Databases
    [/\b(sql.*server|mysql|mariadb|postgres|oracle|mongodb|redis|elasticsearch)\b/, "database"],
    // Virtualization
    [/\b(vmware|esxi|vcenter|hyper-?v|virtualbox|kvm|proxmox|xen)\b/, "virtualization"],
    // Collaboration
    [/\b(teams|slack|zoom|webex|cisco.*meeting|gotomeeting)\b/, "communication"],
    [/\b(confluence|jira|sharepoint|notion|trello)\b/, "collaboration"],
    // Office
    [/\b(office|word|excel|powerpoint|outlook|microsoft.*365|libreoffice)\b/, "office"],
    // Backup
    [/\b(backup|veeam|acronis|veritas|commvault|arcserve)\b/, "backup"],
    // File Transfer
    [/\b(ftp|sftp|filezilla|moveit|ws_ftp|serv-?u)\b/, "file_transfer"],
    // Compression
    [/\b(7-?zip|winzip|winrar|peazip|bandizip)\b/, "utility"],
    // Media
    [/\b(vlc|media.*player|ffmpeg|handbrake|obs)\b/, "media"],
  ];

  for (const [pattern, category] of patterns) {
    if (pattern.test(combined)) {
      return category;
    }
  }

  return "other";
}

/**
 * Infer priority based on product type and KEV history
 */
function inferPriority(vendor: string, product: string, title: string, category: string): "critical" | "high" | "medium" | "low" {
  const combined = `${vendor} ${product} ${title}`.toLowerCase();

  // Critical: Products commonly in CISA KEV or network-facing
  const criticalPatterns = [
    /\b(vpn|gateway|firewall|exchange|sharepoint|citrix|vmware|fortinet|palo.*alto|pulse|ivanti|moveit|barracuda|f5|big-?ip|confluence|weblogic)\b/,
    /\b(apache|nginx|iis|tomcat|jboss|weblogic)\b.*\b(server)\b/,
    /\b(remote.*code|rce)\b/,
  ];

  for (const pattern of criticalPatterns) {
    if (pattern.test(combined)) {
      return "critical";
    }
  }

  // High: Common enterprise software, security tools
  const highPatterns = [
    /\b(browser|chrome|edge|firefox|acrobat|reader|teams|slack|zoom|office)\b/,
    /\b(edr|xdr|antivirus|endpoint.*protection)\b/,
    /\b(sql.*server|oracle|mysql|postgres)\b/,
    /\b(docker|kubernetes|vmware|virtualbox)\b/,
  ];

  for (const pattern of highPatterns) {
    if (pattern.test(combined)) {
      return "high";
    }
  }

  // Categories that are inherently high priority
  if (["browser", "vpn", "remote_access", "security", "network_security", "virtualization"].includes(category)) {
    return "high";
  }

  // Medium: Developer tools, utilities
  if (["development", "runtime", "database", "containerization"].includes(category)) {
    return "medium";
  }

  return "medium";
}

/**
 * Get associated vendor fetcher name if available (for catalog tagging)
 */
function getVendorFetcherName(vendor: string, product: string): string | null {
  const vendorMap: Record<string, string[]> = {
    "curl": ["curl"],
    "mozilla": ["mozilla", "firefox", "thunderbird"],
    "vmware": ["vmware", "esxi", "vcenter", "workstation", "fusion"],
    "atlassian": ["atlassian", "jira", "confluence", "bamboo", "bitbucket"],
    "citrix": ["citrix", "netscaler", "xenserver", "xenapp", "xendesktop"],
    "adobe": ["adobe", "acrobat", "reader", "creative_cloud", "photoshop", "illustrator"],
    "oracle": ["oracle", "java", "weblogic", "mysql", "virtualbox"],
    "microsoft": ["microsoft", "edge", "office", "teams", "windows", "exchange", "sharepoint"],
    "solarwinds": ["solarwinds", "orion", "serv-u"],
    "apache": ["apache", "tomcat", "httpd", "struts"],
  };

  const combined = `${vendor}:${product}`.toLowerCase();

  for (const [fetcherVendor, patterns] of Object.entries(vendorMap)) {
    for (const pattern of patterns) {
      if (combined.includes(pattern)) {
        return fetcherVendor;
      }
    }
  }

  return null;
}

/**
 * Discover command - search NVD CPE and add software to catalog
 */
async function cmdDiscover(query: string, options: DiscoverOptions, config: Config): Promise<void> {
  const catalogPath = resolve(config.dataDir, "SoftwareCatalog.json");

  // Import discovery functions
  const { searchCPE, confirmAndAdd } = await import("./SoftwareDiscovery");

  console.log(`\nSearching NVD CPE dictionary for: "${query}"...\n`);

  const matches = await searchCPE(query);

  if (matches.length === 0) {
    console.log("No matches found in NVD CPE dictionary.");
    console.log("This software may not have published CVEs, or try a different search term.");
    return;
  }

  // Filter to Windows-compatible
  const windowsMatches = matches.filter(m => m.isWindows);

  // If --confirm is provided, add that match
  if (options.confirm !== undefined) {
    const idx = options.confirm - 1; // Convert to 0-indexed
    if (idx < 0 || idx >= windowsMatches.length) {
      console.error(`Invalid match index. Choose 1-${windowsMatches.length}`);
      return;
    }

    const match = windowsMatches[idx];
    const category = inferCategory(match.vendor, match.product, match.title);
    const priority = inferPriority(match.vendor, match.product, match.title, category);
    const vendorFetcherName = getVendorFetcherName(match.vendor, match.product);

    // Create enhanced entry
    const entry = {
      id: `${match.vendor}_${match.product}`.toLowerCase().replace(/[^a-z0-9_]/g, "_"),
      displayName: match.title || `${capitalize(match.vendor)} ${capitalize(match.product.replace(/_/g, " "))}`,
      vendor: match.vendor,
      product: match.product,
      cpe23: match.cpe23,
      category,
      priority,
      aliases: [
        query.toLowerCase(),
        match.product.replace(/_/g, " "),
        `${match.vendor} ${match.product}`.replace(/_/g, " "),
      ].filter((a, i, arr) => arr.indexOf(a) === i),
      platforms: ["windows"] as string[],
      notes: `Auto-discovered from NVD CPE${vendorFetcherName ? `. Vendor: ${vendorFetcherName}` : ""}`,
      autoDiscovered: true,
      discoveredAt: new Date().toISOString(),
      ...(vendorFetcherName && { vendorFetcherId: vendorFetcherName }),
    };

    // Add to catalog
    const { addToCatalog } = await import("./SoftwareDiscovery");
    addToCatalog(catalogPath, entry);

    console.log("Added to catalog:");
    console.log(`  Name:     ${entry.displayName}`);
    console.log(`  Vendor:   ${entry.vendor}`);
    console.log(`  Product:  ${entry.product}`);
    console.log(`  Category: ${category}`);
    console.log(`  Priority: ${priority}`);
    console.log(`  CPE:      ${entry.cpe23}`);
    if (vendorFetcher) {
      console.log(`  Vendor Fetcher: ${vendorFetcher}`);
    }
    console.log(`\nYou can now query: msv query "${entry.displayName}"`);
    return;
  }

  // Display matches with inferred info
  console.log(`Found ${windowsMatches.length} Windows-compatible match${windowsMatches.length === 1 ? "" : "es"}:\n`);

  for (let i = 0; i < windowsMatches.length; i++) {
    const match = windowsMatches[i];
    const category = inferCategory(match.vendor, match.product, match.title);
    const priority = inferPriority(match.vendor, match.product, match.title, category);
    const vendorFetcherName = getVendorFetcherName(match.vendor, match.product);

    const confColor = match.confidence === "high" ? "\x1b[32m" :
                     match.confidence === "medium" ? "\x1b[33m" : "\x1b[90m";
    const priColor = priority === "critical" ? "\x1b[31m" :
                    priority === "high" ? "\x1b[33m" : "\x1b[90m";
    const RESET = "\x1b[0m";

    console.log(`${i + 1}. ${match.title || `${match.vendor}:${match.product}`}`);
    console.log(`   Vendor:   ${match.vendor}`);
    console.log(`   Product:  ${match.product}`);
    console.log(`   CPE:      ${match.cpe23}`);
    console.log(`   Confidence: ${confColor}${match.confidence}${RESET}`);
    console.log(`   Category: ${category} (inferred)`);
    console.log(`   Priority: ${priColor}${priority}${RESET} (inferred)`);
    if (vendorFetcherName) {
      console.log(`   Vendor Fetcher: ${vendorFetcherName} (available)`);
    }
    console.log("");
  }

  console.log("─".repeat(50));
  console.log(`To add to catalog: msv discover "${query}" --confirm <number>`);
  console.log(`Example: msv discover "${query}" --confirm 1`);
}

function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
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
    shell: false, // Security: avoid shell injection
    windowsHide: true,
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

const MSV_VERSION = "1.3.1";

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
  check <input>        Check compliance for software inventory (parallel by default)
  batch <file>         Query MSV for multiple software from file
  discover <software>  Search NVD CPE and add software to catalog
  warm [priority]      Pre-fetch MSV data to warm cache (critical|high|medium|all)
  scan                 Detect installed software versions via winget/chocolatey
  sbom <file>          Parse SBOM (CycloneDX/SPDX) and check component MSVs
  ghsa <ecosystem> [package]  Query GitHub Advisory Database (npm, pip, maven, etc.)
  router <subcommand>  Query router firmware MSVs (query, vendors, models, stats)
  cti report           Generate Cyber Threat Intelligence report (use 'msv cti help')
  stats                Show catalog statistics
  refresh              Force refresh all caches
  list                 List supported software
  list <category>      List software in a category
  db status            Show AppThreat database status
  db update            Download/update AppThreat database
  help                 Show this help message

SUPPORTED SOFTWARE (180+ products):
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
  --version <ver>, -V  Your installed version (shows compliance status)
  --format <type>      Output format: text (default), json, markdown, csv
  --filter <type>      Filter batch results: kev, urgent, stale, undetermined, all
                       kev = Only CISA KEV CVEs, urgent = KEV + high CVE count,
                       stale = Old data, undetermined = No MSV determined
  --verbose            Show detailed query progress
  --force              Force cache refresh
  --auto-add           Auto-add unknown Windows software to catalog
  --confirm <num>      Select match from discover results to add to catalog
  --concurrency <n>    Number of parallel queries (default: 5)
  --no-parallel        Disable parallel processing (use sequential)
  --csv                Force CSV input parsing
  --json               Force JSON input parsing
  --list               Force direct list parsing

EXAMPLES:
  msv query "Google Chrome"
  msv query edge --version 131.0.2903.86   # Check if your version is safe
  msv query "SolarWinds Serv-U" --format json
  msv query "Adobe Acrobat DC"
  msv batch inventory.txt --filter kev          # Only KEV-affected products
  msv batch inventory.txt --filter urgent       # KEV + high CVE count
  msv batch inventory.txt --filter undetermined # Products needing manual review
  msv check "Chrome 120.0.1, PuTTY 0.80, Wireshark 4.2.0"
  msv check inventory.csv --format markdown
  msv check inventory.csv --concurrency 10      # Faster with more parallelism
  msv discover "WinRAR"                         # Search NVD CPE for WinRAR
  msv discover "WinRAR" --confirm 1             # Add first match to catalog
  msv warm                                       # Pre-fetch critical priority MSVs
  msv warm high                                  # Pre-fetch high+ priority MSVs
  msv scan                                       # Detect installed versions
  msv scan --format json                         # Output as JSON
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
// Cache Warming Command
// =============================================================================

interface WarmOptions {
  priority?: "critical" | "high" | "medium" | "all";
  concurrency?: number;
  verbose?: boolean;
  maxAge?: number;  // Hours before considering stale
}

/**
 * Pre-fetch MSV data for catalog entries to warm the cache
 */
async function cmdWarm(options: WarmOptions): Promise<void> {
  const config = getConfig();
  const catalog = loadSoftwareCatalog(config);
  const msvCache = new MsvCache(config.dataDir);
  const priority = options.priority || "critical";
  const concurrency = options.concurrency || 3;
  const maxAge = options.maxAge || 24;

  // Filter software by priority
  let software = catalog.software;
  if (priority !== "all") {
    const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    const maxPriority = priorityOrder[priority];
    software = software.filter(sw => {
      const swPriority = priorityOrder[sw.priority || "low"];
      return swPriority <= maxPriority;
    });
  }

  // Filter to items that need refresh
  const needsRefresh = software.filter(sw => {
    const productId = `${sw.vendor}:${sw.product}`.toLowerCase();
    return msvCache.needsRefresh(productId, maxAge);
  });

  console.log(`\nCache Warming - MSV Pre-fetch`);
  console.log("═".repeat(50));
  console.log(`Priority: ${priority}`);
  console.log(`Total catalog entries: ${software.length}`);
  console.log(`Entries needing refresh: ${needsRefresh.length}`);
  console.log(`Concurrency: ${concurrency}`);
  console.log(`Max age: ${maxAge} hours`);
  console.log("");

  if (needsRefresh.length === 0) {
    console.log("All entries are up to date. No warming needed.");
    return;
  }

  const startTime = Date.now();
  let completed = 0;
  let errors = 0;

  // Process in parallel
  await parallelProcess(
    needsRefresh,
    async (sw) => {
      try {
        await queryMSV(sw.id, { format: "text", verbose: false, forceRefresh: true }, config);
        completed++;
      } catch {
        errors++;
      }
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const progress = Math.floor(((completed + errors) / needsRefresh.length) * 100);
      process.stdout.write(`\r  Progress: ${completed + errors}/${needsRefresh.length} (${progress}%) - ${elapsed}s elapsed`);
    },
    concurrency
  );

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n\nCache warming complete!`);
  console.log(`  Refreshed: ${completed}`);
  console.log(`  Errors: ${errors}`);
  console.log(`  Time: ${totalTime}s`);
}

// =============================================================================
// Version Scan Command - Detect installed software versions
// =============================================================================

interface ScanOptions {
  chocolatey?: boolean;
  winget?: boolean;
  verbose?: boolean;
  format?: "text" | "json" | "csv";
}

interface DetectedSoftware {
  name: string;
  version: string;
  source: "chocolatey" | "winget";
  catalogId?: string;
  msv?: string;
  status?: "COMPLIANT" | "NON_COMPLIANT" | "UNKNOWN";
}

/**
 * Scan for installed software versions using winget/chocolatey
 */
async function cmdScan(options: ScanOptions): Promise<void> {
  const config = getConfig();
  const detected: DetectedSoftware[] = [];

  const useChocolatey = options.chocolatey !== false;
  const useWinget = options.winget !== false;

  console.log(`\nScanning for installed software...`);
  console.log("═".repeat(50));

  // Try winget first (default on modern Windows)
  if (useWinget) {
    if (options.verbose) {
      console.log("\nScanning with winget...");
    }
    try {
      const { spawn } = await import("node:child_process");
      const wingetList = await new Promise<string>((resolve, reject) => {
        const proc = spawn("winget", ["list", "--disable-interactivity"], {
          shell: false, // Security: avoid shell injection
          timeout: 60000,
          windowsHide: true,
        });
        let output = "";
        proc.stdout.on("data", (data) => output += data.toString());
        proc.stderr.on("data", (data) => {
          if (options.verbose) console.error(data.toString());
        });
        proc.on("close", (code) => {
          if (code === 0) resolve(output);
          else reject(new Error(`winget exited with code ${code}`));
        });
        proc.on("error", reject);
      });

      // Parse winget output (skip header lines)
      const lines = wingetList.split("\n").slice(2);
      for (const line of lines) {
        // winget output format varies, try to extract name and version
        const match = line.match(/^(.+?)\s{2,}(\S+)\s{2,}([\d.]+)/);
        if (match) {
          const [, name, _id, version] = match;
          const trimmedName = name.trim();

          // Try to match to catalog
          const software = resolveSoftware(trimmedName, config);

          detected.push({
            name: trimmedName,
            version: version.trim(),
            source: "winget",
            catalogId: software?.id,
          });
        }
      }
      if (options.verbose) {
        console.log(`  Found ${detected.filter(d => d.source === "winget").length} packages via winget`);
      }
    } catch (error) {
      if (options.verbose) {
        console.log(`  winget not available or failed: ${(error as Error).message}`);
      }
    }
  }

  // Try chocolatey
  if (useChocolatey) {
    if (options.verbose) {
      console.log("\nScanning with chocolatey...");
    }
    try {
      const { spawn } = await import("node:child_process");
      const chocoList = await new Promise<string>((resolve, reject) => {
        const proc = spawn("choco", ["list", "--local-only", "--limit-output"], {
          shell: false, // Security: avoid shell injection
          timeout: 60000,
          windowsHide: true,
        });
        let output = "";
        proc.stdout.on("data", (data) => output += data.toString());
        proc.stderr.on("data", (data) => {
          if (options.verbose) console.error(data.toString());
        });
        proc.on("close", (code) => {
          if (code === 0) resolve(output);
          else reject(new Error(`choco exited with code ${code}`));
        });
        proc.on("error", reject);
      });

      // Parse chocolatey output (package|version format)
      const lines = chocoList.split("\n");
      for (const line of lines) {
        const parts = line.trim().split("|");
        if (parts.length >= 2) {
          const [packageName, version] = parts;

          // Try to match to catalog
          const software = resolveSoftware(packageName, config);

          // Don't add duplicates from winget
          if (!detected.find(d => d.catalogId === software?.id)) {
            detected.push({
              name: packageName,
              version,
              source: "chocolatey",
              catalogId: software?.id,
            });
          }
        }
      }
      if (options.verbose) {
        console.log(`  Found ${detected.filter(d => d.source === "chocolatey").length} packages via chocolatey`);
      }
    } catch (error) {
      if (options.verbose) {
        console.log(`  chocolatey not available or failed: ${(error as Error).message}`);
      }
    }
  }

  // Filter to only software in our catalog
  const catalogMatched = detected.filter(d => d.catalogId);

  console.log(`\nDetected ${detected.length} installed packages`);
  console.log(`Matched to catalog: ${catalogMatched.length}`);

  if (catalogMatched.length === 0) {
    console.log("\nNo installed software matched the MSV catalog.");
    console.log("Try: msv check \"Chrome 120.0.1, Firefox 121.0\"");
    return;
  }

  // Query MSV for matched software
  console.log("\nChecking MSV compliance...\n");

  for (const sw of catalogMatched) {
    try {
      const result = await queryMSV(sw.catalogId!, { format: "text", verbose: false, forceRefresh: false }, config);
      sw.msv = result.minimumSafeVersion || "UNKNOWN";

      if (sw.msv && sw.msv !== "UNKNOWN") {
        const cmp = compareVersions(sw.version, sw.msv);
        sw.status = cmp >= 0 ? "COMPLIANT" : "NON_COMPLIANT";
      } else {
        sw.status = "UNKNOWN";
      }
    } catch {
      sw.status = "UNKNOWN";
    }
  }

  // Output results
  if (options.format === "json") {
    console.log(JSON.stringify(catalogMatched, null, 2));
  } else if (options.format === "csv") {
    console.log("Name,Version,MSV,Status,Source");
    for (const sw of catalogMatched) {
      console.log(`"${sw.name}","${sw.version}","${sw.msv || ""}","${sw.status || ""}","${sw.source}"`);
    }
  } else {
    console.log("| Software | Version | MSV | Status |");
    console.log("|----------|---------|-----|--------|");
    for (const sw of catalogMatched) {
      const statusIcon = sw.status === "COMPLIANT" ? "✓" :
                        sw.status === "NON_COMPLIANT" ? "✗" : "?";
      console.log(`| ${sw.name.substring(0, 25).padEnd(25)} | ${sw.version.padEnd(12)} | ${(sw.msv || "?").padEnd(12)} | ${statusIcon} ${sw.status || "UNKNOWN"} |`);
    }
  }

  // Summary
  const compliant = catalogMatched.filter(s => s.status === "COMPLIANT").length;
  const nonCompliant = catalogMatched.filter(s => s.status === "NON_COMPLIANT").length;
  const unknown = catalogMatched.filter(s => s.status === "UNKNOWN").length;

  console.log(`\nSummary: ${compliant} compliant, ${nonCompliant} non-compliant, ${unknown} unknown`);

  if (nonCompliant > 0) {
    console.log("\nNon-compliant software needs immediate attention!");
    console.log("Run: msv check \"<software> <version>\" for detailed remediation guidance.");
  }
}

// =============================================================================
// SBOM Command - Parse CycloneDX/SPDX and check MSVs
// =============================================================================

import { SbomParser, parseSbomFile, mapToGhsaEcosystem, filterWindowsComponents, filterOpenSourceComponents } from "./SbomParser";
import { GitHubAdvisoryClient, GhsaEcosystem, GhsaVulnerability } from "./GitHubAdvisoryClient";

interface SbomOptions {
  format?: "text" | "json" | "csv";
  verbose?: boolean;
  checkGhsa?: boolean;
}

/**
 * Parse SBOM file and check component MSVs
 */
async function cmdSbom(filePath: string, options: SbomOptions, config: Config): Promise<void> {
  console.log(`\nParsing SBOM: ${filePath}`);
  console.log("═".repeat(50));

  const result = parseSbomFile(filePath);

  if (result.errors.length > 0) {
    console.error("\nParsing errors:");
    for (const error of result.errors) {
      console.error(`  - ${error}`);
    }
    if (result.components.length === 0) {
      throw new Error("Failed to parse SBOM file");
    }
  }

  console.log(`\nFormat: ${result.format.toUpperCase()} (spec ${result.specVersion})`);
  console.log(`Components: ${result.components.length}`);
  if (result.metadata.tool) {
    console.log(`Generated by: ${result.metadata.tool}`);
  }

  // Separate Windows components from open source
  const windowsComponents = filterWindowsComponents(result.components);
  const osComponents = filterOpenSourceComponents(result.components);

  console.log(`\n  Windows/Desktop software: ${windowsComponents.length}`);
  console.log(`  Open source packages: ${osComponents.length}`);

  // Check Windows components against MSV catalog
  if (windowsComponents.length > 0) {
    console.log("\n--- Windows Software MSV Check ---");
    const msvResults: Array<{ name: string; version: string; msv: string | null; status: string }> = [];

    for (const comp of windowsComponents.slice(0, 50)) {
      const software = resolveSoftware(comp.name, config);
      if (software) {
        try {
          const msvResult = await queryMSV(software.id, { format: "text", verbose: false, forceRefresh: false }, config);
          const status = msvResult.minimumSafeVersion
            ? compareVersions(comp.version, msvResult.minimumSafeVersion) >= 0
              ? "COMPLIANT"
              : "NON_COMPLIANT"
            : "UNKNOWN";

          msvResults.push({
            name: comp.name,
            version: comp.version,
            msv: msvResult.minimumSafeVersion,
            status,
          });
        } catch {
          msvResults.push({
            name: comp.name,
            version: comp.version,
            msv: null,
            status: "ERROR",
          });
        }
      }
    }

    if (msvResults.length > 0) {
      console.log("\n| Component | Version | MSV | Status |");
      console.log("|-----------|---------|-----|--------|");
      for (const r of msvResults) {
        const statusIcon = r.status === "COMPLIANT" ? "✓" : r.status === "NON_COMPLIANT" ? "✗" : "?";
        console.log(`| ${r.name.substring(0, 25).padEnd(25)} | ${r.version.padEnd(12)} | ${(r.msv || "UNKNOWN").padEnd(12)} | ${statusIcon} ${r.status} |`);
      }
    }
  }

  // Check open source components against GHSA (if enabled and token available)
  if (options.checkGhsa && osComponents.length > 0) {
    const ghsaClient = new GitHubAdvisoryClient(config.dataDir);

    if (!ghsaClient.hasToken()) {
      console.log("\n--- GitHub Advisory Database ---");
      console.log("GITHUB_TOKEN not set. Set it to check open source component vulnerabilities.");
    } else {
      console.log("\n--- Open Source Vulnerability Check (GHSA) ---");

      const vulnResults: Array<{ name: string; version: string; vulns: number; msv: string | null }> = [];

      for (const comp of osComponents.slice(0, 30)) {
        const ecosystem = mapToGhsaEcosystem(comp.ecosystem);
        if (!ecosystem) continue;

        try {
          const msvResult = await ghsaClient.getMsv(ecosystem as GhsaEcosystem, comp.name);
          vulnResults.push({
            name: comp.name,
            version: comp.version,
            vulns: msvResult.vulnerabilities,
            msv: msvResult.msv,
          });
        } catch {
          // Skip failed queries
        }
      }

      if (vulnResults.length > 0) {
        console.log("\n| Package | Version | Vulns | MSV |");
        console.log("|---------|---------|-------|-----|");
        for (const r of vulnResults.filter(v => v.vulns > 0)) {
          console.log(`| ${r.name.substring(0, 30).padEnd(30)} | ${r.version.padEnd(12)} | ${String(r.vulns).padEnd(5)} | ${r.msv || "N/A"} |`);
        }

        const totalVulns = vulnResults.reduce((sum, r) => sum + r.vulns, 0);
        console.log(`\nTotal vulnerabilities found: ${totalVulns}`);
      }
    }
  }

  // JSON output
  if (options.format === "json") {
    console.log("\n" + JSON.stringify(result, null, 2));
  }
}

// =============================================================================
// GHSA Command - Query GitHub Advisory Database
// =============================================================================

interface GhsaOptions {
  format?: "text" | "json";
  verbose?: boolean;
}

/**
 * Query GitHub Advisory Database for vulnerabilities
 */
async function cmdGhsa(
  ecosystemArg: string,
  packageName: string | undefined,
  options: GhsaOptions,
  config: Config
): Promise<void> {
  const ecosystemMap: Record<string, GhsaEcosystem> = {
    npm: "NPM",
    pip: "PIP",
    pypi: "PIP",
    python: "PIP",
    maven: "MAVEN",
    java: "MAVEN",
    nuget: "NUGET",
    dotnet: "NUGET",
    rubygems: "RUBYGEMS",
    ruby: "RUBYGEMS",
    composer: "COMPOSER",
    php: "COMPOSER",
    go: "GO",
    golang: "GO",
    rust: "RUST",
    cargo: "RUST",
    hex: "HEX",
    erlang: "ERLANG",
    pub: "PUB",
    dart: "PUB",
    swift: "SWIFT",
  };

  const ecosystem = ecosystemMap[ecosystemArg.toLowerCase()];
  if (!ecosystem) {
    throw new Error(`Unknown ecosystem: ${ecosystemArg}\nSupported: ${Object.keys(ecosystemMap).join(", ")}`);
  }

  const client = new GitHubAdvisoryClient(config.dataDir);

  if (!client.hasToken()) {
    throw new Error("GITHUB_TOKEN not set. Required for GitHub Advisory Database queries.");
  }

  console.log(`\nQuerying GitHub Advisory Database`);
  console.log("═".repeat(50));
  console.log(`Ecosystem: ${ecosystem}`);
  if (packageName) {
    console.log(`Package: ${packageName}`);
  }

  const result = await client.queryByEcosystem(ecosystem, packageName);

  console.log(`\nFound ${result.vulnerabilities.length} vulnerabilities`);
  console.log(`Rate limit remaining: ${result.rateLimitRemaining}`);

  if (options.format === "json") {
    console.log("\n" + JSON.stringify(result, null, 2));
    return;
  }

  if (result.vulnerabilities.length === 0) {
    console.log("\nNo vulnerabilities found.");
    return;
  }

  // Group by severity
  const bySeverity: Record<string, GhsaVulnerability[]> = {
    CRITICAL: [],
    HIGH: [],
    MODERATE: [],
    LOW: [],
  };

  for (const vuln of result.vulnerabilities) {
    const sev = vuln.advisory.severity;
    if (bySeverity[sev]) {
      bySeverity[sev].push(vuln);
    }
  }

  console.log("\n--- Vulnerabilities by Severity ---");
  console.log(`  Critical: ${bySeverity.CRITICAL.length}`);
  console.log(`  High: ${bySeverity.HIGH.length}`);
  console.log(`  Moderate: ${bySeverity.MODERATE.length}`);
  console.log(`  Low: ${bySeverity.LOW.length}`);

  // Show top vulnerabilities
  console.log("\n--- Recent Vulnerabilities ---");
  console.log("| GHSA ID | CVE | Package | Patched |");
  console.log("|---------|-----|---------|---------|");

  for (const vuln of result.vulnerabilities.slice(0, 15)) {
    const ghsaId = vuln.advisory.ghsaId.substring(0, 20);
    const cve = vuln.advisory.cveId || "N/A";
    const pkg = vuln.package.name.substring(0, 20);
    const patched = vuln.firstPatchedVersion || "N/A";
    console.log(`| ${ghsaId.padEnd(20)} | ${cve.padEnd(15)} | ${pkg.padEnd(20)} | ${patched} |`);
  }

  if (result.vulnerabilities.length > 15) {
    console.log(`\n... and ${result.vulnerabilities.length - 15} more. Use --format json for full output.`);
  }
}

// =============================================================================
// Router Firmware Commands
// =============================================================================

interface RouterOptions {
  format: "text" | "json";
  verbose: boolean;
  hwVersion?: string;
  firmware?: string;
}

/**
 * Query router firmware MSV information
 */
async function cmdRouter(
  subcommand: string,
  arg: string | undefined,
  options: RouterOptions
): Promise<void> {
  switch (subcommand) {
    case "query":
    case "check": {
      if (!arg) {
        throw new Error(
          "Missing router model. Usage: msv router query <model> [--hw-version v1] [--firmware 1.0.5]"
        );
      }

      const query: RouterQuery = {
        input: arg,
        hwVersion: options.hwVersion,
        firmware: options.firmware,
      };

      const result = await queryRouter(query);

      if (options.format === "json") {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(formatRouterResult(result));
      }
      break;
    }

    case "vendors": {
      const vendors = await listVendors();

      if (options.format === "json") {
        console.log(JSON.stringify(vendors, null, 2));
      } else {
        console.log("\n=== Router Vendors ===\n");
        for (const vendor of vendors) {
          const bugBounty = vendor.bugBounty ? "✓" : "✗";
          const cna = vendor.cnaStatus ? "✓" : "✗";
          console.log(`${vendor.displayName}`);
          console.log(`  Trust Rating: ${vendor.trustRating.toUpperCase()}`);
          console.log(`  Bug Bounty: ${bugBounty}  CNA: ${cna}`);
          if (vendor.securityNotes) {
            console.log(`  Notes: ${vendor.securityNotes.substring(0, 80)}...`);
          }
          console.log();
        }
      }
      break;
    }

    case "models": {
      if (!arg) {
        throw new Error("Missing vendor. Usage: msv router models <vendor>");
      }

      const models = await listModelsByVendor(arg);

      if (models.length === 0) {
        console.log(`No models found for vendor "${arg}"`);
        return;
      }

      if (options.format === "json") {
        console.log(JSON.stringify(models, null, 2));
      } else {
        console.log(`\n=== ${arg.toUpperCase()} Models ===\n`);
        for (const model of models) {
          const hwVersions = Object.keys(model.hardwareVersions).join(", ");
          const firstHw = Object.values(model.hardwareVersions)[0];
          const status = firstHw?.supportStatus || "unknown";
          const kevCount = firstHw?.kevCves?.length || 0;

          console.log(`${model.displayName}`);
          console.log(`  Model: ${model.model} | WiFi: ${model.wifiStandard || "unknown"}`);
          console.log(`  HW Versions: ${hwVersions}`);
          console.log(`  Status: ${status.toUpperCase()}${kevCount > 0 ? ` | KEV CVEs: ${kevCount}` : ""}`);
          console.log();
        }
      }
      break;
    }

    case "stats": {
      const stats = await getCatalogStats();

      if (options.format === "json") {
        console.log(JSON.stringify(stats, null, 2));
      } else {
        console.log("\n=== Router Catalog Statistics ===\n");
        console.log(`Catalog Version: ${stats.version}`);
        console.log(`Last Updated: ${stats.lastUpdated}`);
        console.log(`Vendors: ${stats.vendorCount}`);
        console.log(`Models: ${stats.modelCount}`);
        console.log(`KEV-Affected: ${stats.kevAffectedCount}`);
        console.log(`EOL Models: ${stats.eolCount}`);
      }
      break;
    }

    case "update": {
      // Update router catalog from NVD
      const cacheDir = resolve(
        dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1")),
        "../.cache"
      );
      const updater = new RouterCatalogUpdater(cacheDir, { verbose: options.verbose });

      if (arg) {
        // Query single model
        const output = await updater.queryModel(arg);
        console.log(output);
      } else {
        // Full catalog update
        const dryRun = !options.verbose; // Use verbose as "actually update" flag
        console.log(`Starting router catalog update (dry-run: ${dryRun})...`);
        console.log("Use --verbose to actually apply updates.");

        const summary = await updater.updateCatalog({
          dryRun,
          skipExisting: false,
        });

        if (options.format === "json") {
          console.log(JSON.stringify(summary, null, 2));
        } else {
          console.log(updater.formatSummary(summary));
        }
      }
      break;
    }

    default:
      throw new Error(
        `Unknown router subcommand: ${subcommand}\n` +
          "Available: query, vendors, models, stats, update\n" +
          "Examples:\n" +
          "  msv router query 'NETGEAR R7000'\n" +
          "  msv router query 'TP-Link AX21' --firmware 1.1.2\n" +
          "  msv router vendors\n" +
          "  msv router models netgear\n" +
          "  msv router stats\n" +
          "  msv router update              # Dry-run update\n" +
          "  msv router update --verbose    # Apply updates\n" +
          "  msv router update netgear_r7000  # Query single model"
      );
  }
}

// =============================================================================
// CTI Report Command
// =============================================================================

interface CtiOptions {
  format: CTIOutputFormat;
  verbose: boolean;
  period: ReportPeriod;
  profile?: CTIUserProfile;
  profilePath?: string;
  company?: string;
  industry?: string;
  inventory?: string;
  size?: string;
  region?: string;
  output?: string;
  forceRefresh?: boolean;
}

/**
 * Generate CTI (Cyber Threat Intelligence) report
 */
async function cmdCti(
  subcommand: string,
  options: CtiOptions
): Promise<void> {
  const config = getConfig();
  const generator = new CtiReportGenerator(config.dataDir);

  switch (subcommand) {
    case "report": {
      // Auto-refresh stale data (>24 hours) before generating report
      const kevClient = new CisaKevClient(config.dataDir);
      const kevCachePath = resolve(config.dataDir, "kev-cache.json");

      if (existsSync(kevCachePath)) {
        try {
          const cache = JSON.parse(readFileSync(kevCachePath, "utf-8"));
          const cacheAge = (Date.now() - new Date(cache.lastUpdated).getTime()) / (1000 * 60 * 60);

          if (cacheAge > 24 || options.forceRefresh) {
            console.log(`\x1b[2mKEV data is ${Math.round(cacheAge)} hours old, refreshing...\x1b[0m`);
            await kevClient.fetchCatalog(true);
            console.log(`\x1b[32mKEV data refreshed.\x1b[0m\n`);
          }
        } catch {
          // Cache corrupted, will be refreshed during report generation
        }
      } else {
        // No cache, fetch fresh
        console.log(`\x1b[2mFetching KEV data...\x1b[0m`);
        await kevClient.fetchCatalog(true);
        console.log(`\x1b[32mKEV data fetched.\x1b[0m\n`);
      }

      // Load or create profile
      let profile: CTIUserProfile | undefined;

      if (options.profilePath) {
        profile = generator.loadProfile(options.profilePath) || undefined;
        if (!profile) {
          throw new Error(`Could not load profile from ${options.profilePath}`);
        }
      } else if (options.company || options.industry || options.inventory) {
        profile = generator.createProfileFromOptions({
          company: options.company,
          industry: options.industry,
          inventory: options.inventory,
          size: options.size,
          region: options.region,
        });
      }

      // Generate report
      const reportOptions: CTIReportOptions = {
        period: options.period || "week",
        format: options.format || "text",
        profile,
        forceRefresh: options.forceRefresh,
        verbose: options.verbose,
      };

      const report = await generator.generateReport(reportOptions);

      // Format and output
      const formatted = formatCtiReport(report, options.format || "text");

      if (options.output) {
        writeFileSync(options.output, formatted);
        console.log(`Report saved to ${options.output}`);
      } else {
        console.log(formatted);
      }
      break;
    }

    case "help":
    default:
      console.log(`
CTI Report - Cyber Threat Intelligence Report Generator

USAGE:
  msv cti report [options]          Generate CTI report

OPTIONS:
  --period <day|week|month>         Report period (default: week)
  --format <text|markdown|json>     Output format (default: text)
  --output <file>                   Save report to file

CUSTOMIZATION OPTIONS:
  --profile <file.json>             Load organization profile from file
  --company <name>                  Company name (sets TLP to GREEN/AMBER)
  --industry <sector>               Industry sector for relevant threats
  --inventory <list>                Comma-separated software IDs to track
  --size <number>                   Employee count
  --region <region>                 Geographic region

TLP (Traffic Light Protocol):
  TLP:WHITE   General landscape report, no customization
  TLP:GREEN   Customized for organization, no specific threats
  TLP:AMBER   Customized with specific threats to organization

EXAMPLES:
  # General threat landscape (TLP:WHITE)
  msv cti report

  # Weekly report in markdown
  msv cti report --period week --format markdown

  # Customized report for organization (TLP:GREEN or TLP:AMBER)
  msv cti report --company "ACME Corp" --industry "Financial Services"

  # Track specific software inventory
  msv cti report --company "ACME Corp" --inventory "chrome,edge,putty,winrar"

  # Load full profile from file
  msv cti report --profile company-profile.json

  # Save report to file
  msv cti report --format markdown --output cti-report.md

PROFILE FILE FORMAT (company-profile.json):
  {
    "companyName": "ACME Corp",
    "industry": "Financial Services",
    "employeeCount": 5000,
    "region": "North America",
    "softwareInventory": ["chrome", "edge", "putty", "winrar"],
    "focusAreas": ["endpoint", "network"],
    "complianceFrameworks": ["PCI-DSS", "SOC2"]
  }
`);
  }
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
  let confirmIndex: number | undefined;
  let parallel = true;  // Default to parallel
  let concurrency = 5;  // Default concurrency
  let hwVersion: string | undefined;  // Router hardware version
  let firmware: string | undefined;   // Router firmware version
  // CTI options
  let ctiPeriod: ReportPeriod = "week";
  let ctiProfilePath: string | undefined;
  let ctiCompany: string | undefined;
  let ctiIndustry: string | undefined;
  let ctiInventory: string | undefined;
  let ctiSize: string | undefined;
  let ctiRegion: string | undefined;
  let ctiOutput: string | undefined;
  let clearNvdCache = false;

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
    } else if (arg === "--confirm" && args[i + 1]) {
      confirmIndex = parseInt(args[++i], 10);
    } else if (arg === "--parallel") {
      parallel = true;
    } else if (arg === "--no-parallel" || arg === "--sequential") {
      parallel = false;
    } else if (arg === "--concurrency" && args[i + 1]) {
      concurrency = parseInt(args[++i], 10) || 5;
    } else if (arg === "--csv") {
      inputFormat = "csv";
    } else if (arg === "--json") {
      inputFormat = "json";
    } else if (arg === "--list") {
      inputFormat = "list";
    } else if (arg === "--hw-version" && args[i + 1]) {
      hwVersion = args[++i];
    } else if (arg === "--firmware" && args[i + 1]) {
      firmware = args[++i];
    // CTI options
    } else if (arg === "--period" && args[i + 1]) {
      ctiPeriod = args[++i] as ReportPeriod;
    } else if (arg === "--profile" && args[i + 1]) {
      ctiProfilePath = args[++i];
    } else if (arg === "--company" && args[i + 1]) {
      ctiCompany = args[++i];
    } else if (arg === "--industry" && args[i + 1]) {
      ctiIndustry = args[++i];
    } else if (arg === "--inventory" && args[i + 1]) {
      ctiInventory = args[++i];
    } else if (arg === "--size" && args[i + 1]) {
      ctiSize = args[++i];
    } else if (arg === "--region" && args[i + 1]) {
      ctiRegion = args[++i];
    } else if (arg === "--output" && args[i + 1]) {
      ctiOutput = args[++i];
    } else if ((arg === "--version" || arg === "-V") && args[i + 1]) {
      options.currentVersion = args[++i];
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
          parallel,
          concurrency,
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

      case "discover":
        if (!positionalArgs[1]) {
          throw new Error("Missing software name. Usage: msv discover <software> [--confirm <num>]");
        }
        await cmdDiscover(positionalArgs[1], { confirm: confirmIndex, verbose: options.verbose }, config);
        break;

      case "warm":
        await cmdWarm({
          priority: (positionalArgs[1] as "critical" | "high" | "medium" | "all") || "critical",
          concurrency,
          verbose: options.verbose,
          maxAge: 24,
        });
        break;

      case "scan":
        await cmdScan({
          winget: true,
          chocolatey: true,
          verbose: options.verbose,
          format: options.format as "text" | "json" | "csv",
        });
        break;

      case "sbom":
        if (!positionalArgs[1]) {
          throw new Error("Missing SBOM file path. Usage: msv sbom <file.json>");
        }
        await cmdSbom(positionalArgs[1], {
          format: options.format as "text" | "json" | "csv",
          verbose: options.verbose,
          checkGhsa: true,
        }, config);
        break;

      case "ghsa":
        if (!positionalArgs[1]) {
          throw new Error("Missing ecosystem. Usage: msv ghsa <ecosystem> [package]\nEcosystems: npm, pip, maven, nuget, rubygems, go, rust");
        }
        await cmdGhsa(positionalArgs[1], positionalArgs[2], {
          format: options.format as "text" | "json",
          verbose: options.verbose,
        }, config);
        break;

      case "router":
        await cmdRouter(positionalArgs[1] || "stats", positionalArgs[2], {
          format: options.format as "text" | "json",
          verbose: options.verbose,
          hwVersion,
          firmware,
        });
        break;

      case "cti":
        await cmdCti(positionalArgs[1] || "report", {
          format: options.format as CTIOutputFormat,
          verbose: options.verbose,
          period: ctiPeriod,
          profilePath: ctiProfilePath,
          company: ctiCompany,
          industry: ctiIndustry,
          inventory: ctiInventory,
          size: ctiSize,
          region: ctiRegion,
          output: ctiOutput,
          forceRefresh: options.forceRefresh,
        });
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
