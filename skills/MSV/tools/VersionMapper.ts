/**
 * VersionMapper.ts - Vendor-Specific Version Normalization
 *
 * Maps vendor-specific version schemes to standard semver for comparison.
 * Handles non-standard version formats from various software vendors.
 *
 * Supported formats:
 * - Adobe: year-based (2024.x, 20.x for 2020)
 * - Java: update notation (8u401 → 8.0.401)
 * - .NET: preview/rc suffixes
 * - Fortinet: FortiOS versions
 * - Palo Alto: PAN-OS versions
 * - Cisco: ASA/FTD versions
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

import { Logger, type LogLevel } from "./Logger";

// =============================================================================
// Types
// =============================================================================

export interface MappedVersion {
  original: string;
  normalized: string;
  vendor?: string;
  product?: string;
  major: number;
  minor: number;
  patch: number;
  build?: number;
  prerelease?: string;
  metadata?: string;
}

export interface VendorVersionConfig {
  pattern: RegExp;
  normalizer: (match: RegExpMatchArray) => MappedVersion;
}

// =============================================================================
// Version Mappers by Vendor
// =============================================================================

const VENDOR_MAPPERS: Record<string, VendorVersionConfig[]> = {
  /**
   * Adobe versions:
   * - Year-based: 2024.001.20643, 24.001.20643
   * - Classic: 20.005.30636 (2020 track)
   * - Legacy: 11.0.23 (Acrobat XI)
   */
  adobe: [
    {
      // Full year format: 2024.001.20643
      pattern: /^(20\d{2})\.(\d{3})\.(\d+)$/,
      normalizer: (m) => ({
        original: m[0],
        normalized: `${m[1]}.${parseInt(m[2], 10)}.${parseInt(m[3], 10)}`,
        vendor: "adobe",
        major: parseInt(m[1], 10),
        minor: parseInt(m[2], 10),
        patch: parseInt(m[3], 10),
      }),
    },
    {
      // Short year format: 24.001.20643
      pattern: /^(\d{2})\.(\d{3})\.(\d+)$/,
      normalizer: (m) => {
        const year = parseInt(m[1], 10) + 2000;
        return {
          original: m[0],
          normalized: `${year}.${parseInt(m[2], 10)}.${parseInt(m[3], 10)}`,
          vendor: "adobe",
          major: year,
          minor: parseInt(m[2], 10),
          patch: parseInt(m[3], 10),
        };
      },
    },
    {
      // Legacy format: 11.0.23
      pattern: /^(\d+)\.(\d+)\.(\d+)$/,
      normalizer: (m) => ({
        original: m[0],
        normalized: m[0],
        vendor: "adobe",
        major: parseInt(m[1], 10),
        minor: parseInt(m[2], 10),
        patch: parseInt(m[3], 10),
      }),
    },
  ],

  /**
   * Oracle Java versions:
   * - Update notation: 8u401, 1.8.0_401
   * - Modern: 21.0.1+12, 17.0.9
   */
  java: [
    {
      // Update notation: 8u401 → 8.0.401
      pattern: /^(\d+)u(\d+)$/i,
      normalizer: (m) => ({
        original: m[0],
        normalized: `${m[1]}.0.${m[2]}`,
        vendor: "oracle",
        product: "java",
        major: parseInt(m[1], 10),
        minor: 0,
        patch: parseInt(m[2], 10),
      }),
    },
    {
      // Old format: 1.8.0_401 → 8.0.401
      pattern: /^1\.(\d+)\.(\d+)[_](\d+)$/,
      normalizer: (m) => ({
        original: m[0],
        normalized: `${m[1]}.${m[2]}.${m[3]}`,
        vendor: "oracle",
        product: "java",
        major: parseInt(m[1], 10),
        minor: parseInt(m[2], 10),
        patch: parseInt(m[3], 10),
      }),
    },
    {
      // Modern with build: 21.0.1+12
      pattern: /^(\d+)\.(\d+)\.(\d+)\+(\d+)$/,
      normalizer: (m) => ({
        original: m[0],
        normalized: `${m[1]}.${m[2]}.${m[3]}`,
        vendor: "oracle",
        product: "java",
        major: parseInt(m[1], 10),
        minor: parseInt(m[2], 10),
        patch: parseInt(m[3], 10),
        build: parseInt(m[4], 10),
      }),
    },
    {
      // Modern simple: 21.0.1
      pattern: /^(\d+)\.(\d+)\.(\d+)$/,
      normalizer: (m) => ({
        original: m[0],
        normalized: m[0],
        vendor: "oracle",
        product: "java",
        major: parseInt(m[1], 10),
        minor: parseInt(m[2], 10),
        patch: parseInt(m[3], 10),
      }),
    },
  ],

  /**
   * Microsoft .NET versions:
   * - Standard: 8.0.11, 6.0.36
   * - Preview: 9.0.0-preview.7
   * - RC: 9.0.0-rc.2
   */
  dotnet: [
    {
      // Preview/RC: 9.0.0-preview.7
      pattern: /^(\d+)\.(\d+)\.(\d+)-(preview|rc)\.(\d+)$/i,
      normalizer: (m) => ({
        original: m[0],
        normalized: `${m[1]}.${m[2]}.${m[3]}`,
        vendor: "microsoft",
        product: "dotnet",
        major: parseInt(m[1], 10),
        minor: parseInt(m[2], 10),
        patch: parseInt(m[3], 10),
        prerelease: `${m[4]}.${m[5]}`,
      }),
    },
    {
      // Standard: 8.0.11
      pattern: /^(\d+)\.(\d+)\.(\d+)$/,
      normalizer: (m) => ({
        original: m[0],
        normalized: m[0],
        vendor: "microsoft",
        product: "dotnet",
        major: parseInt(m[1], 10),
        minor: parseInt(m[2], 10),
        patch: parseInt(m[3], 10),
      }),
    },
  ],

  /**
   * Fortinet FortiOS versions:
   * - Standard: 7.4.4, 6.4.15
   * - Build: 7.4.4 build2662
   */
  fortinet: [
    {
      // With build number
      pattern: /^(\d+)\.(\d+)\.(\d+)\s*build(\d+)$/i,
      normalizer: (m) => ({
        original: m[0],
        normalized: `${m[1]}.${m[2]}.${m[3]}`,
        vendor: "fortinet",
        product: "fortios",
        major: parseInt(m[1], 10),
        minor: parseInt(m[2], 10),
        patch: parseInt(m[3], 10),
        build: parseInt(m[4], 10),
      }),
    },
    {
      // Standard: 7.4.4
      pattern: /^(\d+)\.(\d+)\.(\d+)$/,
      normalizer: (m) => ({
        original: m[0],
        normalized: m[0],
        vendor: "fortinet",
        product: "fortios",
        major: parseInt(m[1], 10),
        minor: parseInt(m[2], 10),
        patch: parseInt(m[3], 10),
      }),
    },
  ],

  /**
   * Palo Alto PAN-OS versions:
   * - Standard: 11.1.3, 10.2.7-h3
   * - Hotfix: 11.1.3-h1
   */
  paloalto: [
    {
      // Hotfix version: 11.1.3-h1
      pattern: /^(\d+)\.(\d+)\.(\d+)-h(\d+)$/i,
      normalizer: (m) => ({
        original: m[0],
        normalized: `${m[1]}.${m[2]}.${parseInt(m[3], 10) * 100 + parseInt(m[4], 10)}`,
        vendor: "paloaltonetworks",
        product: "pan-os",
        major: parseInt(m[1], 10),
        minor: parseInt(m[2], 10),
        patch: parseInt(m[3], 10),
        build: parseInt(m[4], 10),
        metadata: `h${m[4]}`,
      }),
    },
    {
      // Standard: 11.1.3
      pattern: /^(\d+)\.(\d+)\.(\d+)$/,
      normalizer: (m) => ({
        original: m[0],
        normalized: m[0],
        vendor: "paloaltonetworks",
        product: "pan-os",
        major: parseInt(m[1], 10),
        minor: parseInt(m[2], 10),
        patch: parseInt(m[3], 10),
      }),
    },
  ],

  /**
   * Cisco ASA/FTD versions:
   * - ASA: 9.16.4, 9.18(4)
   * - FTD: 7.2.5, 7.0.6-1
   */
  cisco: [
    {
      // Parentheses format: 9.18(4)
      pattern: /^(\d+)\.(\d+)\((\d+)\)$/,
      normalizer: (m) => ({
        original: m[0],
        normalized: `${m[1]}.${m[2]}.${m[3]}`,
        vendor: "cisco",
        major: parseInt(m[1], 10),
        minor: parseInt(m[2], 10),
        patch: parseInt(m[3], 10),
      }),
    },
    {
      // Interim release: 7.0.6-1
      pattern: /^(\d+)\.(\d+)\.(\d+)-(\d+)$/,
      normalizer: (m) => ({
        original: m[0],
        normalized: `${m[1]}.${m[2]}.${parseInt(m[3], 10) * 10 + parseInt(m[4], 10)}`,
        vendor: "cisco",
        major: parseInt(m[1], 10),
        minor: parseInt(m[2], 10),
        patch: parseInt(m[3], 10),
        build: parseInt(m[4], 10),
      }),
    },
    {
      // Standard: 9.16.4
      pattern: /^(\d+)\.(\d+)\.(\d+)$/,
      normalizer: (m) => ({
        original: m[0],
        normalized: m[0],
        vendor: "cisco",
        major: parseInt(m[1], 10),
        minor: parseInt(m[2], 10),
        patch: parseInt(m[3], 10),
      }),
    },
  ],

  /**
   * SonicWall SonicOS versions:
   * - Standard: 7.0.1, 6.5.4.12
   * - Four-part: 7.0.1.732
   */
  sonicwall: [
    {
      // Four-part: 7.0.1.732
      pattern: /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/,
      normalizer: (m) => ({
        original: m[0],
        normalized: `${m[1]}.${m[2]}.${m[3]}`,
        vendor: "sonicwall",
        product: "sonicos",
        major: parseInt(m[1], 10),
        minor: parseInt(m[2], 10),
        patch: parseInt(m[3], 10),
        build: parseInt(m[4], 10),
      }),
    },
    {
      // Standard: 7.0.1
      pattern: /^(\d+)\.(\d+)\.(\d+)$/,
      normalizer: (m) => ({
        original: m[0],
        normalized: m[0],
        vendor: "sonicwall",
        product: "sonicos",
        major: parseInt(m[1], 10),
        minor: parseInt(m[2], 10),
        patch: parseInt(m[3], 10),
      }),
    },
  ],

  /**
   * Chrome/Edge versions (4-part):
   * - 122.0.6261.94
   */
  chrome: [
    {
      pattern: /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/,
      normalizer: (m) => ({
        original: m[0],
        normalized: m[0],
        vendor: "google",
        product: "chrome",
        major: parseInt(m[1], 10),
        minor: parseInt(m[2], 10),
        patch: parseInt(m[3], 10),
        build: parseInt(m[4], 10),
      }),
    },
  ],

  /**
   * Python versions:
   * - Standard: 3.12.1
   * - Alpha/Beta/RC: 3.13.0a1, 3.13.0b2, 3.13.0rc1
   */
  python: [
    {
      // Prerelease: 3.13.0a1, 3.13.0b2, 3.13.0rc1
      pattern: /^(\d+)\.(\d+)\.(\d+)(a|b|rc)(\d+)$/i,
      normalizer: (m) => ({
        original: m[0],
        normalized: `${m[1]}.${m[2]}.${m[3]}`,
        vendor: "python",
        product: "python",
        major: parseInt(m[1], 10),
        minor: parseInt(m[2], 10),
        patch: parseInt(m[3], 10),
        prerelease: `${m[4]}${m[5]}`,
      }),
    },
    {
      // Standard: 3.12.1
      pattern: /^(\d+)\.(\d+)\.(\d+)$/,
      normalizer: (m) => ({
        original: m[0],
        normalized: m[0],
        vendor: "python",
        product: "python",
        major: parseInt(m[1], 10),
        minor: parseInt(m[2], 10),
        patch: parseInt(m[3], 10),
      }),
    },
  ],
};

// =============================================================================
// VersionMapper Class
// =============================================================================

export class VersionMapper {
  private logger: Logger;

  constructor() {
    this.logger = new Logger({ level: "info", prefix: "VersionMapper" });
  }

  /**
   * Map a version string to normalized form using vendor-specific rules
   */
  map(version: string, vendor?: string): MappedVersion {
    const trimmed = version.trim().replace(/^v/i, "");

    // Try vendor-specific mapping first
    if (vendor && VENDOR_MAPPERS[vendor.toLowerCase()]) {
      const mapped = this.tryVendorMappers(trimmed, vendor.toLowerCase());
      if (mapped) return mapped;
    }

    // Try auto-detection across all vendors
    for (const [vendorKey, mappers] of Object.entries(VENDOR_MAPPERS)) {
      const mapped = this.tryVendorMappers(trimmed, vendorKey);
      if (mapped) return mapped;
    }

    // Fallback: parse as generic semver-like
    return this.genericParse(trimmed);
  }

  /**
   * Try to map using a specific vendor's patterns
   */
  private tryVendorMappers(version: string, vendor: string): MappedVersion | null {
    const mappers = VENDOR_MAPPERS[vendor];
    if (!mappers) return null;

    for (const config of mappers) {
      const match = version.match(config.pattern);
      if (match) {
        const result = config.normalizer(match);
        this.logger.debug(`Mapped ${version} via ${vendor}: ${result.normalized}`);
        return result;
      }
    }

    return null;
  }

  /**
   * Generic parse for versions that don't match any vendor pattern
   */
  private genericParse(version: string): MappedVersion {
    // Extract prerelease if present
    let prerelease: string | undefined;
    let cleanVersion = version;

    const prereleaseMatch = version.match(/[-+](.+)$/);
    if (prereleaseMatch) {
      prerelease = prereleaseMatch[1];
      cleanVersion = version.replace(/[-+].+$/, "");
    }

    // Parse numeric parts
    const parts = cleanVersion.split(".").map((p) => parseInt(p, 10) || 0);

    return {
      original: version,
      normalized: cleanVersion,
      major: parts[0] || 0,
      minor: parts[1] || 0,
      patch: parts[2] || 0,
      build: parts[3],
      prerelease,
    };
  }

  /**
   * Compare two versions after normalization
   * Returns: -1 if a < b, 0 if a == b, 1 if a > b
   */
  compare(versionA: string, versionB: string, vendor?: string): -1 | 0 | 1 {
    const a = this.map(versionA, vendor);
    const b = this.map(versionB, vendor);

    // Compare major.minor.patch
    if (a.major !== b.major) return a.major < b.major ? -1 : 1;
    if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
    if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;

    // Compare build if present (hotfix/build = newer than base)
    const buildA = a.build ?? 0;
    const buildB = b.build ?? 0;
    if (buildA !== buildB) return buildA < buildB ? -1 : 1;

    // Compare prerelease (no prerelease > with prerelease)
    if (!a.prerelease && b.prerelease) return 1;
    if (a.prerelease && !b.prerelease) return -1;
    if (a.prerelease && b.prerelease) {
      if (a.prerelease < b.prerelease) return -1;
      if (a.prerelease > b.prerelease) return 1;
    }

    return 0;
  }

  /**
   * Get all supported vendors
   */
  getSupportedVendors(): string[] {
    return Object.keys(VENDOR_MAPPERS);
  }

  /**
   * Check if a vendor has version mapping support
   */
  isVendorSupported(vendor: string): boolean {
    return vendor.toLowerCase() in VENDOR_MAPPERS;
  }
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Create a singleton instance
 */
let instance: VersionMapper | null = null;

export function getVersionMapper(): VersionMapper {
  if (!instance) {
    instance = new VersionMapper();
  }
  return instance;
}

/**
 * Quick normalize a version string
 */
export function normalizeVersion(version: string, vendor?: string): string {
  return getVersionMapper().map(version, vendor).normalized;
}

/**
 * Quick compare two versions
 */
export function compareVersionsNormalized(
  a: string,
  b: string,
  vendor?: string
): -1 | 0 | 1 {
  return getVersionMapper().compare(a, b, vendor);
}

/**
 * Parse Java update notation to semver
 * @example "8u401" → "8.0.401"
 */
export function parseJavaVersion(version: string): string {
  return getVersionMapper().map(version, "java").normalized;
}

/**
 * Parse Adobe year-based version to comparable format
 * @example "24.001.20643" → "2024.1.20643"
 */
export function parseAdobeVersion(version: string): string {
  return getVersionMapper().map(version, "adobe").normalized;
}

/**
 * Parse Cisco version to semver
 * @example "9.18(4)" → "9.18.4"
 */
export function parseCiscoVersion(version: string): string {
  return getVersionMapper().map(version, "cisco").normalized;
}
