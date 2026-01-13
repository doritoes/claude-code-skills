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
import { resolve, dirname } from "node:path";
import { CisaKevClient, type KevEntry } from "./CisaKevClient";
import { VulnCheckClient, type VulnCheckCve } from "./VulnCheckClient";
import { EpssClient, type EpssScore } from "./EpssClient";
import {
  calculateAdmiraltyRating,
  calculateMsvRating,
  getRatingColor,
  RESET_COLOR,
  type AdmiraltyRating,
  type EvidenceSource,
  type MsvRatingInput,
} from "./AdmiraltyScoring";
import {
  findMinimumSafeVersion,
  compareVersions,
  sortVersions,
} from "./VersionCompare";
import { NvdClient, type VersionInfo } from "./NvdClient";
import { MsvCache, type MsvCacheEntry, type MsvBranch } from "./MsvCache";
import { getVendorFetcher, type VendorAdvisoryResult } from "./VendorAdvisory";

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

interface QueryOptions {
  format: "text" | "json" | "markdown";
  verbose: boolean;
  forceRefresh: boolean;
}

interface MSVResult {
  software: string;
  displayName: string;
  platform: string;
  minimumSafeVersion: string | null;   // Lowest safe version (oldest you can safely run)
  recommendedVersion: string | null;    // Highest safe version (latest, best protection)
  branches: BranchMsvResult[];
  admiraltyRating: AdmiraltyRating;
  justification: string;
  sources: string[];
  cveCount: number;
  exploitedCves: ExploitedCVE[];
  queriedAt: string;
  fromCache: boolean;
}

interface BranchMsvResult {
  branch: string;
  msv: string;
  latest: string;
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

  // Initialize cache
  const msvCache = new MsvCache(config.dataDir);
  const productId = `${software.vendor}:${software.product}`.toLowerCase();

  // Check cache first (unless force refresh)
  if (!options.forceRefresh) {
    const cached = msvCache.get(productId);
    if (cached && !msvCache.needsRefresh(productId, 24)) {
      if (options.verbose) console.log("Returning cached MSV result...");

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

      const ratingInput: MsvRatingInput = {
        dataSources: cached.dataSources.map(s => {
          if (s === "Vendor Advisory") return "vendor_advisory";
          if (s === "NVD") return "nvd";
          if (s === "CISA KEV") return "cisa_kev";
          if (s === "VulnCheck") return "vulncheck";
          return s as any;
        }),
        hasVendorAdvisory,
        hasCveData: cached.branches.length > 0,
        cveCount: cached.branches.reduce((sum, b) => sum + b.advisoriesChecked.length, 0),
        msvDetermined: minimumSafeVersion !== null,
      };

      return {
        software: softwareInput,
        displayName: software.displayName,
        platform: software.platforms.join(", "),
        minimumSafeVersion,
        recommendedVersion,
        branches,
        admiraltyRating: calculateMsvRating(ratingInput),
        justification: `Cached result from ${cached.lastUpdated}`,
        sources: cached.dataSources,
        cveCount: ratingInput.cveCount,
        exploitedCves: [],
        queriedAt: new Date().toISOString(),
        fromCache: true,
      };
    }
  }

  const evidence: EvidenceSource[] = [];
  const exploitedCves: ExploitedCVE[] = [];
  const sources: string[] = [];
  const branches: BranchMsvResult[] = [];
  let minimumSafeVersion: string | null = null;   // Lowest safe version
  let recommendedVersion: string | null = null;    // Highest safe version
  let hasVendorAdvisory = false;

  // 1. Try vendor advisory first (most reliable source)
  if (options.verbose) console.log("Checking vendor advisory...");
  const vendorFetcher = getVendorFetcher(software.vendor, software.product, config.dataDir);

  if (vendorFetcher) {
    try {
      const vendorData = await vendorFetcher.fetch();

      if (vendorData.branches.length > 0) {
        hasVendorAdvisory = true;
        sources.push("Vendor Advisory");

        // Use vendor advisory branches as primary MSV source
        for (const branch of vendorData.branches) {
          branches.push({
            branch: branch.branch,
            msv: branch.msv,
            latest: branch.latest,
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

        if (options.verbose) {
          console.log(`  Found ${vendorData.advisories.length} advisories, ${branches.length} branches`);
        }
      }
    } catch (error) {
      if (options.verbose) console.warn("Vendor advisory fetch failed:", error);
    }
  }

  // 2. Query CISA KEV (always check for active exploitation)
  if (options.verbose) console.log("Querying CISA KEV...");
  const kevClient = new CisaKevClient(config.dataDir);

  try {
    const kevEntries = await kevClient.findByProduct(
      software.product,
      software.vendor
    );

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
    } else {
      evidence.push({ source: "CISA_KEV", hasData: false });
    }
  } catch (error) {
    if (options.verbose) console.warn("CISA KEV query failed:", error);
    evidence.push({ source: "CISA_KEV", hasData: false });
  }

  // 3. Query NVD for version info if no vendor advisory or need more data
  if (!hasVendorAdvisory || exploitedCves.some(c => c.inCisaKev && !c.fixedVersion)) {
    const nvdClient = new NvdClient(config.dataDir);
    const cvesToQuery = exploitedCves
      .filter(c => !c.fixedVersion)
      .map(c => c.cve)
      .slice(0, 5); // Limit due to rate limiting

    if (cvesToQuery.length > 0) {
      if (options.verbose) console.log(`Querying NVD for ${cvesToQuery.length} CVEs (rate limited)...`);
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
        if (options.verbose) console.warn("NVD query failed:", error);
      }
    }
  }

  // 4. Query EPSS for exploitation probability
  if (exploitedCves.length > 0) {
    if (options.verbose) console.log("Querying EPSS...");
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
      }
    } catch (error) {
      if (options.verbose) console.warn("EPSS query failed:", error);
    }
  }

  // Calculate Admiralty rating using MSV-specific logic
  const ratingInput: MsvRatingInput = {
    dataSources: sources.map(s => {
      if (s === "Vendor Advisory") return "vendor_advisory";
      if (s === "NVD") return "nvd";
      if (s === "CISA KEV") return "cisa_kev";
      if (s === "VulnCheck") return "vulncheck";
      return "none";
    }) as any[],
    hasVendorAdvisory,
    hasCveData: exploitedCves.length > 0,
    cveCount: exploitedCves.length,
    msvDetermined: minimumSafeVersion !== null,
  };

  const admiraltyRating = calculateMsvRating(ratingInput);

  // Build justification
  let justification = admiraltyRating.description;
  if (exploitedCves.length > 0) {
    const kevCount = exploitedCves.filter((c) => c.inCisaKev).length;
    justification += `. Found ${exploitedCves.length} CVEs`;
    if (kevCount > 0) {
      justification += ` (${kevCount} actively exploited)`;
    }
  }

  // Update cache with new results
  if (minimumSafeVersion || branches.length > 0) {
    const cacheEntry: MsvCacheEntry = {
      productId,
      displayName: software.displayName,
      vendor: software.vendor,
      branches: branches.map(b => ({
        branch: b.branch,
        msv: b.msv,
        latestKnown: b.latest,
        lastChecked: new Date().toISOString(),
        advisoriesChecked: exploitedCves.map(c => c.cve),
      })),
      dataSources: sources,
      confidence: hasVendorAdvisory ? "high" : (exploitedCves.length > 0 ? "medium" : "low"),
      lastUpdated: new Date().toISOString(),
    };

    msvCache.update(cacheEntry);
    if (options.verbose) console.log("Cache updated.");
  }

  return {
    software: softwareInput,
    displayName: software.displayName,
    platform: software.platforms.join(", "),
    minimumSafeVersion,
    recommendedVersion,
    branches,
    admiraltyRating,
    justification,
    sources,
    cveCount: exploitedCves.length,
    exploitedCves,
    queriedAt: new Date().toISOString(),
    fromCache: false,
  };
}

// =============================================================================
// Output Formatters
// =============================================================================

function formatText(result: MSVResult): string {
  const color = getRatingColor(result.admiraltyRating);
  const lines = [
    `Software: ${result.displayName} (${result.platform})`,
    `Admiralty Rating: ${color}${result.admiraltyRating.rating}${RESET_COLOR}`,
    `Justification: ${result.justification}`,
    `Sources: ${result.sources.join(", ") || "None"}`,
  ];

  // Insert version info after software name
  if (result.minimumSafeVersion && result.recommendedVersion) {
    if (result.minimumSafeVersion === result.recommendedVersion) {
      // Single version (no branch data)
      lines.splice(1, 0, `Minimum Safe Version: ${result.minimumSafeVersion}`);
    } else {
      // Multiple branches - show both min and recommended
      lines.splice(1, 0, `Minimum Safe Version: ${result.minimumSafeVersion} (oldest safe)`);
      lines.splice(2, 0, `Recommended Version: ${result.recommendedVersion} (latest safe)`);
    }
  } else if (result.minimumSafeVersion) {
    lines.splice(1, 0, `Minimum Safe Version: ${result.minimumSafeVersion}`);
  }

  // Show branch information if available
  if (result.branches.length > 0) {
    lines.push("");
    lines.push("Version Branches:");
    for (const branch of result.branches) {
      lines.push(`  ${branch.branch}.x: MSV ${branch.msv} (latest: ${branch.latest})`);
    }
  }

  if (result.fromCache) {
    lines.push("");
    lines.push(`[Cached result - use --force to refresh]`);
  }

  if (result.exploitedCves.length > 0) {
    lines.push("");
    lines.push(`CVEs Analyzed (${result.cveCount}):`);
    for (const cve of result.exploitedCves.slice(0, 10)) {
      const markers = [];
      if (cve.inCisaKev) markers.push("KEV");
      if (cve.hasPoC) markers.push("PoC");
      if (cve.epssScore) markers.push(`EPSS:${(cve.epssScore * 100).toFixed(1)}%`);
      if (cve.fixedVersion) markers.push(`Fixed:${cve.fixedVersion}`);
      lines.push(`  - ${cve.cve} [${markers.join(", ")}]`);
    }
    if (result.exploitedCves.length > 10) {
      lines.push(`  ... and ${result.exploitedCves.length - 10} more`);
    }
  }

  return lines.join("\n");
}

function formatJson(result: MSVResult): string {
  return JSON.stringify(result, null, 2);
}

function formatMarkdown(result: MSVResult): string {
  const lines = [
    `## ${result.displayName}`,
    "",
    `| Property | Value |`,
    `|----------|-------|`,
    `| Platform | ${result.platform} |`,
    `| **Minimum Safe Version** | **${result.minimumSafeVersion || "Unknown"}** |`,
    `| **Recommended Version** | **${result.recommendedVersion || result.minimumSafeVersion || "Unknown"}** |`,
    `| Admiralty Rating | **${result.admiraltyRating.rating}** |`,
    `| CVE Count | ${result.cveCount} |`,
    `| Sources | ${result.sources.join(", ")} |`,
    "",
    `**Justification:** ${result.justification}`,
  ];

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

  if (options.format === "json") {
    console.log(JSON.stringify(results, null, 2));
  } else if (options.format === "markdown") {
    console.log("# MSV Batch Results\n");
    for (const result of results) {
      console.log(formatMarkdown(result));
      console.log("\n---\n");
    }
  } else {
    for (const result of results) {
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

function showHelp(): void {
  console.log(`
MSV - Minimum Safe Version Calculator

Determines the lowest software version free of known-exploited vulnerabilities
for Windows 11/Server software.

USAGE:
  msv <command> [options]

COMMANDS:
  query <software>     Query MSV for a specific software
  batch <file>         Query MSV for multiple software from file
  refresh              Force refresh all caches
  list                 List supported software
  help                 Show this help message

OPTIONS:
  --format <type>      Output format: text (default), json, markdown
  --verbose            Show detailed query progress
  --force              Force cache refresh

EXAMPLES:
  msv query "Google Chrome"
  msv query "Microsoft Edge" --format json
  msv batch software-list.txt --format markdown
  msv refresh
  msv list

ADMIRALTY RATINGS:
  A1 - Completely Reliable, Confirmed (CISA KEV active exploitation)
  A2 - Completely Reliable, Probably True (Vendor advisory)
  B2 - Usually Reliable, Probably True (VulnCheck PoC verified)
  B3 - Usually Reliable, Possibly True (High EPSS score)
  C3 - Fairly Reliable, Possibly True (Critical CVSS)

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
  const options: QueryOptions = {
    format: "text",
    verbose: false,
    forceRefresh: false,
  };

  const positionalArgs: string[] = [];
  let category: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--format" && args[i + 1]) {
      options.format = args[++i] as "text" | "json" | "markdown";
    } else if (arg === "--verbose" || arg === "-v") {
      options.verbose = true;
    } else if (arg === "--force" || arg === "-f") {
      options.forceRefresh = true;
    } else if (arg === "--category" && args[i + 1]) {
      category = args[++i];
    } else if (!arg.startsWith("-")) {
      positionalArgs.push(arg);
    }
  }

  const command = positionalArgs[0];
  const config = getConfig();

  try {
    switch (command) {
      case "query":
        if (!positionalArgs[1]) {
          throw new Error("Missing software name. Usage: msv query <software>");
        }
        await cmdQuery(positionalArgs[1], options);
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

      case "list":
        cmdList(config, category);
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
