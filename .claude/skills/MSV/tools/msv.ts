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
import { parseFile, parseInput, parseDirectList, type SoftwareInput } from "./InputParser";
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
  format: "text" | "json" | "markdown" | "csv";
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
  dataAge?: DataFreshness;
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

      // Calculate data freshness
      const dataAge = calculateDataFreshness(
        cached.lastUpdated,
        cached.branches[0]?.lastChecked
      );

      return {
        software: softwareInput,
        displayName: software.displayName,
        platform: software.platforms.join(", "),
        minimumSafeVersion,
        recommendedVersion,
        branches,
        admiraltyRating: calculateMsvRating(ratingInput),
        justification: `Cached result`,
        sources: cached.dataSources,
        cveCount: ratingInput.cveCount,
        exploitedCves: [],
        queriedAt: new Date().toISOString(),
        fromCache: true,
        dataAge,
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
    } else {
      evidence.push({ source: "CISA_KEV", hasData: false });
    }
  } catch (error) {
    if (options.verbose) console.warn("CISA KEV query failed:", error);
    evidence.push({ source: "CISA_KEV", hasData: false });
  }

  // 3. Query VulnCheck by CPE if API key available and we need more CVE data
  if (config.vulncheckApiKey && software.cpe23) {
    if (options.verbose) console.log("Querying VulnCheck by CPE...");
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
      } else {
        evidence.push({ source: "VulnCheck", hasData: false });
      }
    } catch (error) {
      if (options.verbose) console.warn("VulnCheck query failed:", error);
      evidence.push({ source: "VulnCheck", hasData: false });
    }
  }

  // 3.5. If no CVEs found yet, query NVD directly by CPE (free API)
  if (exploitedCves.length === 0 && software.cpe23) {
    if (options.verbose) console.log("Querying NVD by CPE (no CVEs from other sources)...");
    try {
      const nvdClient = new NvdClient(config.dataDir);
      const nvdCpeResults = await nvdClient.searchByCpe(software.cpe23, {
        maxResults: 20,
        minCvss: 4.0, // Medium severity and above
      });

      if (nvdCpeResults.length > 0) {
        if (!sources.includes("NVD")) sources.push("NVD");

        // Track fixed versions to determine MSV
        const fixedVersions: string[] = [];

        for (const result of nvdCpeResults) {
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

        const maxCvss = Math.max(...nvdCpeResults.map(r => r.cvssScore || 0));
        evidence.push({
          source: "NVD",
          hasData: true,
          cvssScore: maxCvss > 0 ? maxCvss : undefined,
        });

        if (options.verbose) {
          console.log(`Found ${nvdCpeResults.length} CVEs from NVD (CVSS >= 4.0)`);
        }
      } else {
        evidence.push({ source: "NVD", hasData: false });
        if (options.verbose) console.log("No CVEs found in NVD for this CPE");
      }
    } catch (error) {
      if (options.verbose) console.warn("NVD CPE query failed:", error);
      evidence.push({ source: "NVD", hasData: false });
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

  // 5. Query EPSS for exploitation probability
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

  // Fresh data - just queried
  const now = new Date().toISOString();
  const dataAge = calculateDataFreshness(now, now);

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
    queriedAt: now,
    fromCache: false,
    dataAge,
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

  // Show data freshness
  if (result.dataAge) {
    const age = formatDataAge(result.dataAge);
    const indicator = getFreshnessIndicator(result.dataAge);

    if (result.dataAge.isCritical) {
      lines.push("");
      lines.push(`${indicator} - Data last checked ${age}`);
      lines.push(`  Run with --force to refresh vulnerability data`);
    } else if (result.dataAge.isStale) {
      lines.push("");
      lines.push(`${indicator} - Last checked ${age}`);
    } else if (result.fromCache) {
      lines.push("");
      lines.push(`${indicator} Data checked ${age}${result.fromCache ? " (cached)" : ""}`);
    }
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
    `| Admiralty Rating | **${result.admiraltyRating.rating}** |`,
    `| CVE Count | ${result.cveCount} |`,
    `| Sources | ${result.sources.join(", ")} |`,
    `| Data Freshness | ${dataStatus} |`,
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

const MSV_VERSION = "1.1.0";

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
  help                 Show this help message

SUPPORTED SOFTWARE (133+ products):
  Browsers           Chrome, Edge, Firefox, Brave, Opera
  PDF                Adobe Acrobat DC/2024/2020, Reader DC/2020, Foxit
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

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--format" && args[i + 1]) {
      options.format = args[++i] as "text" | "json" | "markdown" | "csv";
    } else if (arg === "--verbose" || arg === "-v") {
      options.verbose = true;
    } else if (arg === "--force" || arg === "-f") {
      options.forceRefresh = true;
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
