/**
 * types.ts - Shared Type Definitions for MSV Skill
 *
 * Central location for all TypeScript interfaces and types used across
 * the MSV (Minimum Safe Version) CLI tool.
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

import type { AdmiraltyRating } from "./AdmiraltyScoring";
import type { ActionGuidance } from "./ActionGuidance";
import type { RiskScore } from "./RiskScoring";
import type { SourceResult } from "./MsvCache";

// =============================================================================
// Configuration Types
// =============================================================================

/**
 * MSV tool configuration
 */
export interface Config {
  paiDir: string;
  skillDir: string;
  dataDir: string;
  envPath: string;
  vulncheckApiKey?: string;
}

/**
 * Filter options for batch operations
 */
export type BatchFilter = "kev" | "urgent" | "stale" | "undetermined" | "all";

/**
 * Output format options
 */
export type OutputFormat = "text" | "json" | "markdown" | "csv";

/**
 * Query options for MSV lookups
 */
export interface QueryOptions {
  format: OutputFormat;
  verbose: boolean;
  forceRefresh: boolean;
  filter?: BatchFilter;
}

// =============================================================================
// MSV Result Types
// =============================================================================

/**
 * Main MSV query result
 */
export interface MSVResult {
  software: string;
  displayName: string;
  platform: string;
  /** Lowest safe version (oldest you can safely run) */
  minimumSafeVersion: string | null;
  /** Highest safe version (latest, best protection) */
  recommendedVersion: string | null;
  /** Latest available version (from catalog or vendor) */
  latestVersion: string | null;
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
  /** True if any CVEs are in CISA KEV */
  hasKevCves: boolean;
  /** Per-source query results */
  sourceResults: SourceResult[];
  /** Generated action guidance */
  action?: ActionGuidance;
  /** Aggregate risk score (0-100) */
  riskScore?: RiskScore;
  // v3 fields - variant support
  /** True if this product has variant tracks */
  hasVariants?: boolean;
  /** Information about variants */
  variantInfo?: VariantInfo;
}

/**
 * Information about product variants (e.g., Adobe Reader DC vs 2020 vs 2024)
 */
export interface VariantInfo {
  /** e.g., "Adobe Acrobat Reader" */
  parentProduct: string;
  /** MSV info for each variant */
  variants: VariantMsv[];
  /** Help text explaining how to identify track */
  trackHelp: string;
}

/**
 * MSV info for a specific product variant
 */
export interface VariantMsv {
  /** e.g., "acrobat_reader_dc" */
  id: string;
  /** e.g., "Adobe Acrobat Reader DC" */
  displayName: string;
  /** e.g., "Continuous (DC)" */
  track: string;
  /** Minimum safe version */
  msv: string | null;
  /** e.g., "24.x.x.x (builds >10000)" */
  versionPattern: string;
}

/**
 * Data freshness information
 */
export interface DataFreshness {
  /** When MSV data was last updated */
  lastUpdated: string;
  /** When data sources were last queried */
  lastChecked: string;
  /** Hours since last check */
  ageHours: number;
  /** True if > 24 hours old */
  isStale: boolean;
  /** True if > 7 days old */
  isCritical: boolean;
}

/**
 * MSV result for a specific version branch
 */
export interface BranchMsvResult {
  branch: string;
  msv: string;
  latest: string;
  /** True if MSV > latest (no safe version available yet) */
  noSafeVersion?: boolean;
}

/**
 * Information about an exploited CVE
 */
export interface ExploitedCVE {
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

// =============================================================================
// Software Catalog Types
// =============================================================================

/**
 * Software mapping entry from the catalog
 */
export interface SoftwareMapping {
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
  /** List of variant IDs for products with multiple tracks */
  variants?: string[];
  /** Regex to filter valid versions (e.g., "^7\\." for PowerShell 7) */
  versionPattern?: string;
  /** Regex patterns to exclude from CVE descriptions (prevents data contamination) */
  excludePatterns?: string[];
  /** True if this is a Windows OS component (updates via Windows Update only) */
  osComponent?: boolean;
  /** True if this software is End of Life (no longer receiving security patches) */
  eol?: boolean;
  /** Known latest version for display (manually maintained) */
  latestVersion?: string;
}

/**
 * Software catalog with metadata
 */
export interface SoftwareCatalog {
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
// ANSI Color Constants
// =============================================================================

export const COLORS = {
  RESET: "\x1b[0m",
  DIM: "\x1b[2m",
  BOLD: "\x1b[1m",
  RED: "\x1b[31m",
  GREEN: "\x1b[32m",
  YELLOW: "\x1b[33m",
  BLUE: "\x1b[34m",
  MAGENTA: "\x1b[35m",
  CYAN: "\x1b[36m",
  WHITE: "\x1b[37m",
} as const;
