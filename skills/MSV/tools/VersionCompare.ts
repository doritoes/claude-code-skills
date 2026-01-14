/**
 * VersionCompare.ts - Semantic Version Comparison Utilities
 *
 * Handles various version formats:
 * - Standard semver: 1.2.3
 * - Chrome/Edge style: 122.0.6261.94
 * - Windows build: 10.0.22621.3880
 * - KB-based: KB5034204
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

// =============================================================================
// Types
// =============================================================================

export interface VersionRange {
  start?: string;
  end?: string;
  fixed?: string;
  expression?: string; // e.g., "< 122.0.6261.94"
}

export interface ParsedVersion {
  original: string;
  parts: number[];
  prerelease?: string;
  isKb?: boolean;
  kbNumber?: number;
}

// =============================================================================
// Parsing
// =============================================================================

/**
 * Parse a version string into comparable parts
 */
export function parseVersion(version: string): ParsedVersion {
  const original = version.trim();

  // Handle KB versions (Windows patches)
  const kbMatch = original.match(/^KB(\d+)$/i);
  if (kbMatch) {
    return {
      original,
      parts: [parseInt(kbMatch[1], 10)],
      isKb: true,
      kbNumber: parseInt(kbMatch[1], 10),
    };
  }

  // Handle standard version strings
  // Remove leading 'v' if present
  let cleaned = original.replace(/^v/i, "");

  // Extract prerelease suffix if present (-alpha, -beta, -rc1, etc.)
  let prerelease: string | undefined;
  const prereleaseMatch = cleaned.match(/[-+](.+)$/);
  if (prereleaseMatch) {
    prerelease = prereleaseMatch[1];
    cleaned = cleaned.replace(/[-+].+$/, "");
  }

  // Split by dots and parse each part
  const parts = cleaned.split(".").map((p) => {
    const num = parseInt(p, 10);
    return isNaN(num) ? 0 : num;
  });

  return {
    original,
    parts,
    prerelease,
  };
}

/**
 * Compare two version strings
 * Returns: -1 if a < b, 0 if a == b, 1 if a > b
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const parsedA = parseVersion(a);
  const parsedB = parseVersion(b);

  // Both KB versions - compare KB numbers
  if (parsedA.isKb && parsedB.isKb) {
    if (parsedA.kbNumber! < parsedB.kbNumber!) return -1;
    if (parsedA.kbNumber! > parsedB.kbNumber!) return 1;
    return 0;
  }

  // Mixed KB and regular - KB always "greater" (newer)
  if (parsedA.isKb && !parsedB.isKb) return 1;
  if (!parsedA.isKb && parsedB.isKb) return -1;

  // Compare numeric parts
  const maxLen = Math.max(parsedA.parts.length, parsedB.parts.length);
  for (let i = 0; i < maxLen; i++) {
    const partA = parsedA.parts[i] || 0;
    const partB = parsedB.parts[i] || 0;
    if (partA < partB) return -1;
    if (partA > partB) return 1;
  }

  // Parts are equal, check prerelease
  // No prerelease > with prerelease (1.0.0 > 1.0.0-alpha)
  if (!parsedA.prerelease && parsedB.prerelease) return 1;
  if (parsedA.prerelease && !parsedB.prerelease) return -1;

  // Both have prerelease, compare alphabetically
  if (parsedA.prerelease && parsedB.prerelease) {
    if (parsedA.prerelease < parsedB.prerelease) return -1;
    if (parsedA.prerelease > parsedB.prerelease) return 1;
  }

  return 0;
}

/**
 * Check if version is within a range
 */
export function isVersionInRange(
  version: string,
  range: VersionRange
): boolean {
  if (range.expression) {
    return evaluateExpression(version, range.expression);
  }

  const parsed = parseVersion(version);

  if (range.start) {
    const cmp = compareVersions(version, range.start);
    if (cmp < 0) return false;
  }

  if (range.end) {
    const cmp = compareVersions(version, range.end);
    if (cmp > 0) return false;
  }

  return true;
}

/**
 * Evaluate a version expression like "< 122.0.6261.94"
 */
export function evaluateExpression(
  version: string,
  expression: string
): boolean {
  const match = expression.match(/^([<>=!]+)\s*(.+)$/);
  if (!match) return false;

  const [, operator, target] = match;
  const cmp = compareVersions(version, target);

  switch (operator) {
    case "<":
      return cmp < 0;
    case "<=":
      return cmp <= 0;
    case ">":
      return cmp > 0;
    case ">=":
      return cmp >= 0;
    case "=":
    case "==":
      return cmp === 0;
    case "!=":
      return cmp !== 0;
    default:
      return false;
  }
}

/**
 * Sort versions in ascending order
 */
export function sortVersions(versions: string[]): string[] {
  return [...versions].sort(compareVersions);
}

/**
 * Find the minimum safe version from a list of CVEs with fixed versions
 * Returns the highest fixed version (all CVEs below it are vulnerable)
 */
export function findMinimumSafeVersion(
  fixedVersions: string[]
): string | null {
  if (fixedVersions.length === 0) return null;

  const sorted = sortVersions(fixedVersions);
  return sorted[sorted.length - 1]; // Highest fixed version
}

/**
 * Check if a version is vulnerable (below all fixed versions)
 */
export function isVersionVulnerable(
  version: string,
  fixedVersions: string[]
): boolean {
  const msv = findMinimumSafeVersion(fixedVersions);
  if (!msv) return false;

  return compareVersions(version, msv) < 0;
}

/**
 * Normalize version string for consistent comparison
 */
export function normalizeVersion(version: string): string {
  const parsed = parseVersion(version);
  if (parsed.isKb) {
    return `KB${parsed.kbNumber}`;
  }
  return parsed.parts.join(".");
}
