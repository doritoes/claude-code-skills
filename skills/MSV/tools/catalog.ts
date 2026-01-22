/**
 * catalog.ts - Software Catalog Management
 *
 * Handles loading, caching, and resolving software from the catalog.
 * Includes support for product variants (Adobe tracks, PowerShell versions).
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Config, VariantInfo, SoftwareMapping, SoftwareCatalog } from "./types";

// =============================================================================
// Catalog Cache
// =============================================================================

let catalogCache: SoftwareCatalog | null = null;
let catalogMapCache: Record<string, SoftwareMapping> | null = null;

/**
 * Clear the catalog cache (useful for testing or after catalog updates)
 */
export function clearCatalogCache(): void {
  catalogCache = null;
  catalogMapCache = null;
}

/**
 * Load the software catalog from disk
 */
export function loadSoftwareCatalog(config: Config): SoftwareCatalog {
  if (catalogCache) return catalogCache;

  const catalogPath = resolve(config.dataDir, "SoftwareCatalog.json");

  if (!existsSync(catalogPath)) {
    throw new Error(`Software catalog not found at ${catalogPath}`);
  }

  const content = readFileSync(catalogPath, "utf-8");
  catalogCache = JSON.parse(content) as SoftwareCatalog;
  return catalogCache;
}

/**
 * Get the software catalog as a map keyed by software ID
 */
export function getSoftwareCatalogMap(config: Config): Record<string, SoftwareMapping> {
  if (catalogMapCache) return catalogMapCache;

  const catalog = loadSoftwareCatalog(config);
  const map: Record<string, SoftwareMapping> = {};

  for (const sw of catalog.software) {
    map[sw.id] = sw;
  }

  catalogMapCache = map;
  return map;
}

// =============================================================================
// Configuration
// =============================================================================

/**
 * Get MSV tool configuration from environment
 */
export function getConfig(): Config {
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
    const vulnCheckMatch = envContent.match(/VULNCHECK_API_KEY=(.+)/);
    if (vulnCheckMatch) {
      vulncheckApiKey = vulnCheckMatch[1].trim();
    }
  }

  return { paiDir, skillDir, dataDir, envPath, vulncheckApiKey };
}

// =============================================================================
// Software Resolution
// =============================================================================

/**
 * Resolve a software name/alias to its catalog entry
 */
export function resolveSoftware(input: string, config: Config): SoftwareMapping | null {
  const normalized = input.toLowerCase().trim();
  const catalog = getSoftwareCatalogMap(config);

  // Direct match by ID
  if (catalog[normalized]) {
    return catalog[normalized];
  }

  // Alias match
  for (const [_key, mapping] of Object.entries(catalog)) {
    if (mapping.aliases.some((alias) => alias.toLowerCase() === normalized)) {
      return mapping;
    }
  }

  // Fuzzy match (contains)
  for (const [_key, mapping] of Object.entries(catalog)) {
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
export function getVariants(software: SoftwareMapping, config: Config): SoftwareMapping[] {
  if (!software.variants || software.variants.length === 0) {
    return [];
  }

  const catalog = getSoftwareCatalogMap(config);
  return software.variants
    .map(id => catalog[id])
    .filter(Boolean);
}

// =============================================================================
// Adobe Track Detection
// =============================================================================

/**
 * Detect Adobe product track from version number
 */
export function detectAdobeTrack(version: string): { track: string; productSuffix: string } | null {
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
export function getAdobeVariantInfo(isReader: boolean): VariantInfo {
  const product = isReader ? "Adobe Acrobat Reader" : "Adobe Acrobat";
  const prefix = isReader ? "acrobat_reader" : "acrobat";

  return {
    parentProduct: product,
    variants: [
      {
        id: `${prefix}_dc`,
        displayName: `${product} DC`,
        track: "Continuous (DC)",
        msv: null,
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

// =============================================================================
// PowerShell Variant Info
// =============================================================================

/**
 * Get variant info for PowerShell products
 */
export function getPowerShellVariantInfo(): VariantInfo {
  return {
    parentProduct: "PowerShell",
    variants: [
      {
        id: "windows_powershell",
        displayName: "Windows PowerShell 5.1",
        track: "Built-in (Windows Update)",
        msv: null,
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
