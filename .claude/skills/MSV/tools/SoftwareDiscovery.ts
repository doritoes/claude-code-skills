/**
 * SoftwareDiscovery.ts - Auto-discover and add unknown software to catalog
 *
 * When a user queries software not in the catalog:
 * 1. Search NVD CPE dictionary for matches
 * 2. Check if it's Windows-compatible software
 * 3. If yes, auto-add to catalog and continue
 * 4. If unclear, return candidates for user confirmation
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// =============================================================================
// Types
// =============================================================================

export interface CpeMatch {
  cpe23: string;
  vendor: string;
  product: string;
  title: string;
  isWindows: boolean;
  confidence: "high" | "medium" | "low";
}

export interface DiscoveryResult {
  found: boolean;
  matches: CpeMatch[];
  autoAdded: boolean;
  needsConfirmation: boolean;
  message: string;
}

export interface SoftwareEntry {
  id: string;
  displayName: string;
  vendor: string;
  product: string;
  cpe23?: string;
  category?: string;
  priority?: string;
  aliases: string[];
  platforms: string[];
  notes?: string;
  autoDiscovered?: boolean;
  discoveredAt?: string;
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
  software: SoftwareEntry[];
}

// =============================================================================
// Windows Platform Detection
// =============================================================================

const WINDOWS_INDICATORS = [
  "windows",
  "win32",
  "win64",
  "microsoft",
  ".exe",
  "portable",
  "installer",
  "setup",
];

const NON_WINDOWS_INDICATORS = [
  "linux",
  "ubuntu",
  "debian",
  "centos",
  "redhat",
  "macos",
  "darwin",
  "ios",
  "android",
  "unix",
  "bsd",
  "solaris",
];

const CROSS_PLATFORM_SOFTWARE = [
  "chrome",
  "firefox",
  "edge",
  "brave",
  "opera",
  "vivaldi",
  "7-zip",
  "7zip",
  "vlc",
  "gimp",
  "inkscape",
  "libreoffice",
  "openoffice",
  "audacity",
  "filezilla",
  "putty",
  "winscp",
  "wireshark",
  "notepad++",
  "vscode",
  "visual studio code",
  "git",
  "nodejs",
  "node.js",
  "python",
  "java",
  "virtualbox",
  "docker",
  "slack",
  "zoom",
  "teams",
  "discord",
  "telegram",
  "signal",
];

function isWindowsSoftware(cpe: string, title: string): boolean {
  const lower = `${cpe} ${title}`.toLowerCase();

  // Check for explicit non-Windows indicators
  for (const indicator of NON_WINDOWS_INDICATORS) {
    if (lower.includes(indicator) && !lower.includes("windows")) {
      return false;
    }
  }

  // Check for Windows indicators
  for (const indicator of WINDOWS_INDICATORS) {
    if (lower.includes(indicator)) {
      return true;
    }
  }

  // Check if it's known cross-platform software (runs on Windows)
  for (const software of CROSS_PLATFORM_SOFTWARE) {
    if (lower.includes(software)) {
      return true;
    }
  }

  // Default: assume desktop software runs on Windows unless proven otherwise
  // This is because most CVEs don't specify platform in CPE
  return true;
}

// =============================================================================
// NVD CPE Search
// =============================================================================

/**
 * Search NVD CPE dictionary for matching software
 * Uses the NVD CPE Match API
 */
export async function searchCPE(query: string): Promise<CpeMatch[]> {
  const matches: CpeMatch[] = [];

  // Normalize query
  const normalizedQuery = query.toLowerCase().trim();

  // NVD CPE API endpoint
  const url = new URL("https://services.nvd.nist.gov/rest/json/cpes/2.0");
  url.searchParams.set("keywordSearch", normalizedQuery);
  url.searchParams.set("resultsPerPage", "20");

  try {
    const response = await fetch(url.toString(), {
      headers: {
        "User-Agent": "MSV-Skill/1.0 (PAI Infrastructure)",
      },
    });

    if (!response.ok) {
      console.warn(`NVD CPE search failed: ${response.status}`);
      return matches;
    }

    const data = await response.json() as {
      products?: Array<{
        cpe: {
          cpeName: string;
          titles?: Array<{ title: string; lang: string }>;
        };
      }>;
    };

    if (!data.products) return matches;

    for (const product of data.products) {
      const cpe23 = product.cpe.cpeName;
      const title = product.cpe.titles?.find(t => t.lang === "en")?.title || "";

      // Parse CPE string: cpe:2.3:a:vendor:product:version:...
      const parts = cpe23.split(":");
      if (parts.length < 5) continue;

      const vendor = parts[3];
      const productName = parts[4];

      // Check if Windows software
      const isWindows = isWindowsSoftware(cpe23, title);

      // Calculate confidence
      let confidence: "high" | "medium" | "low" = "low";
      const queryWords = normalizedQuery.split(/\s+/);
      const matchedWords = queryWords.filter(w =>
        vendor.includes(w) || productName.includes(w) || title.toLowerCase().includes(w)
      );

      if (matchedWords.length === queryWords.length) {
        confidence = "high";
      } else if (matchedWords.length > 0) {
        confidence = "medium";
      }

      matches.push({
        cpe23,
        vendor,
        product: productName,
        title: title || `${vendor} ${productName}`,
        isWindows,
        confidence,
      });
    }

    // Sort by confidence and Windows compatibility
    matches.sort((a, b) => {
      const confOrder = { high: 0, medium: 1, low: 2 };
      if (a.isWindows !== b.isWindows) return a.isWindows ? -1 : 1;
      return confOrder[a.confidence] - confOrder[b.confidence];
    });

    return matches.slice(0, 10); // Return top 10
  } catch (error) {
    console.warn(`CPE search error: ${(error as Error).message}`);
    return matches;
  }
}

// =============================================================================
// Catalog Management
// =============================================================================

export function loadCatalog(catalogPath: string): SoftwareCatalog {
  if (!existsSync(catalogPath)) {
    throw new Error(`Catalog not found: ${catalogPath}`);
  }
  return JSON.parse(readFileSync(catalogPath, "utf-8"));
}

export function saveCatalog(catalogPath: string, catalog: SoftwareCatalog): void {
  catalog._metadata.lastUpdated = new Date().toISOString();
  catalog._metadata.totalEntries = catalog.software.length;
  writeFileSync(catalogPath, JSON.stringify(catalog, null, 2));
}

export function addToCatalog(
  catalogPath: string,
  entry: SoftwareEntry
): void {
  const catalog = loadCatalog(catalogPath);

  // Check if already exists
  const existing = catalog.software.find(
    s => s.id === entry.id ||
         (s.vendor === entry.vendor && s.product === entry.product)
  );

  if (existing) {
    // Update aliases if new ones provided
    const newAliases = entry.aliases.filter(a => !existing.aliases.includes(a));
    existing.aliases.push(...newAliases);
  } else {
    catalog.software.push(entry);
  }

  saveCatalog(catalogPath, catalog);
}

// =============================================================================
// Discovery Workflow
// =============================================================================

/**
 * Attempt to discover and optionally add unknown software
 */
export async function discoverSoftware(
  query: string,
  catalogPath: string,
  autoAdd: boolean = false
): Promise<DiscoveryResult> {
  // Search NVD CPE
  const matches = await searchCPE(query);

  if (matches.length === 0) {
    return {
      found: false,
      matches: [],
      autoAdded: false,
      needsConfirmation: false,
      message: `No CPE entries found for "${query}". This software may not have published CVEs.`,
    };
  }

  // Filter to Windows-compatible software
  const windowsMatches = matches.filter(m => m.isWindows);

  if (windowsMatches.length === 0) {
    return {
      found: true,
      matches,
      autoAdded: false,
      needsConfirmation: true,
      message: `Found ${matches.length} matches but none appear to be Windows software. Please confirm if this runs on Windows 11/Server.`,
    };
  }

  // Check for high-confidence match
  const highConfidence = windowsMatches.find(m => m.confidence === "high");

  if (highConfidence && autoAdd) {
    // Auto-add to catalog
    const entry = cpeMatchToEntry(highConfidence, query);
    addToCatalog(catalogPath, entry);

    return {
      found: true,
      matches: windowsMatches,
      autoAdded: true,
      needsConfirmation: false,
      message: `Auto-added "${entry.displayName}" (${entry.vendor}:${entry.product}) to catalog.`,
    };
  }

  // Multiple matches or low confidence - need user confirmation
  return {
    found: true,
    matches: windowsMatches,
    autoAdded: false,
    needsConfirmation: true,
    message: `Found ${windowsMatches.length} potential matches. Please confirm the correct software.`,
  };
}

/**
 * Convert a CPE match to a catalog entry
 */
function cpeMatchToEntry(match: CpeMatch, originalQuery: string): SoftwareEntry {
  // Generate display name from title or vendor/product
  let displayName = match.title;
  if (!displayName || displayName === `${match.vendor} ${match.product}`) {
    // Capitalize vendor and product
    displayName = `${capitalize(match.vendor)} ${capitalize(match.product.replace(/_/g, " "))}`;
  }

  // Generate ID
  const id = `${match.vendor}_${match.product}`.toLowerCase().replace(/[^a-z0-9_]/g, "_");

  // Generate aliases
  const aliases = [
    originalQuery.toLowerCase(),
    match.product.replace(/_/g, " "),
    match.product.replace(/_/g, ""),
    `${match.vendor} ${match.product}`.replace(/_/g, " "),
  ].filter((a, i, arr) => arr.indexOf(a) === i); // Dedupe

  return {
    id,
    displayName,
    vendor: match.vendor,
    product: match.product,
    cpe23: match.cpe23,
    category: "other",
    priority: "medium",
    aliases,
    platforms: ["windows"],
    notes: `Auto-discovered from NVD CPE`,
    autoDiscovered: true,
    discoveredAt: new Date().toISOString(),
  };
}

function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Add a confirmed match to the catalog
 */
export function confirmAndAdd(
  match: CpeMatch,
  originalQuery: string,
  catalogPath: string
): SoftwareEntry {
  const entry = cpeMatchToEntry(match, originalQuery);
  addToCatalog(catalogPath, entry);
  return entry;
}
