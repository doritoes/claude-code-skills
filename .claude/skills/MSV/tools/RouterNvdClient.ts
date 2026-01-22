/**
 * RouterNvdClient.ts - NVD-based router CVE lookup
 *
 * Queries NVD by CPE prefix to find CVEs affecting router firmware.
 * Extracts version ranges to determine MSV (Minimum Safe Version).
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

import { NvdClient, type NvdCve, type NvdCpeMatch } from "./NvdClient";
import { compareVersions } from "./RouterClient";
import type { RouterModel, HardwareVersion, FirmwareBranch } from "./RouterTypes";

// =============================================================================
// Types
// =============================================================================

export interface RouterCveInfo {
  cveId: string;
  description: string;
  cvssScore: number | null;
  severity: string | null;
  published: string;
  affectedVersions: VersionRange[];
  fixedVersion: string | null;
  isKev: boolean;
}

export interface VersionRange {
  startIncluding?: string;
  startExcluding?: string;
  endIncluding?: string;
  endExcluding?: string;
}

export interface MsvCalculation {
  msv: string;
  msvDate: string;
  msvCves: string[];
  kevCves: string[];
  allCves: RouterCveInfo[];
  confidence: "high" | "medium" | "low";
  note?: string;
}

export interface RouterNvdQueryResult {
  model: string;
  cpePrefix: string;
  cveCount: number;
  kevCount: number;
  calculation: MsvCalculation | null;
  error?: string;
}

// =============================================================================
// Client
// =============================================================================

export class RouterNvdClient {
  private nvdClient: NvdClient;
  private verbose: boolean;

  constructor(cacheDir: string, options?: { verbose?: boolean }) {
    this.verbose = options?.verbose ?? false;
    this.nvdClient = new NvdClient(cacheDir, { verbose: this.verbose });
  }

  /**
   * Query NVD for CVEs affecting a router by CPE prefix
   */
  async queryCvesByCpe(
    cpePrefix: string,
    options: { maxResults?: number; minCvss?: number } = {}
  ): Promise<RouterCveInfo[]> {
    const { maxResults = 50, minCvss = 4.0 } = options;
    const results: RouterCveInfo[] = [];

    if (this.verbose) {
      console.log(`Querying NVD for CPE: ${cpePrefix}`);
    }

    try {
      // Search NVD by CPE
      const cveResults = await this.nvdClient.searchByCpe(cpePrefix, {
        maxResults,
        minCvss,
      });

      for (const result of cveResults) {
        // Get full CVE details for version extraction
        const cve = await this.nvdClient.getCve(result.cve);
        if (!cve) continue;

        const versionRanges = this.extractVersionRanges(cve, cpePrefix);
        const fixedVersion = this.determineFixedVersion(versionRanges);
        const isKev = !!cve.cisaExploitAdd;

        results.push({
          cveId: result.cve,
          description: result.description,
          cvssScore: result.cvssScore,
          severity: result.severity,
          published: result.published,
          affectedVersions: versionRanges,
          fixedVersion,
          isKev,
        });
      }

      // Sort by severity (KEV first, then by CVSS)
      results.sort((a, b) => {
        if (a.isKev && !b.isKev) return -1;
        if (!a.isKev && b.isKev) return 1;
        return (b.cvssScore || 0) - (a.cvssScore || 0);
      });

      return results;
    } catch (error) {
      if (this.verbose) {
        console.error(`Error querying NVD for ${cpePrefix}:`, error);
      }
      throw error;
    }
  }

  /**
   * Extract version ranges from CVE configurations
   */
  private extractVersionRanges(cve: NvdCve, cpePrefix: string): VersionRange[] {
    const ranges: VersionRange[] = [];

    if (!cve.configurations) return ranges;

    // Normalize CPE prefix for matching
    const normalizedPrefix = cpePrefix.toLowerCase();

    for (const config of cve.configurations) {
      for (const node of config.nodes) {
        for (const match of node.cpeMatch) {
          if (!match.vulnerable) continue;

          // Check if this CPE match is for our router
          if (!match.criteria.toLowerCase().includes(normalizedPrefix.split(":").slice(3, 5).join(":"))) {
            continue;
          }

          const range: VersionRange = {};

          if (match.versionStartIncluding) {
            range.startIncluding = match.versionStartIncluding;
          }
          if (match.versionStartExcluding) {
            range.startExcluding = match.versionStartExcluding;
          }
          if (match.versionEndIncluding) {
            range.endIncluding = match.versionEndIncluding;
          }
          if (match.versionEndExcluding) {
            range.endExcluding = match.versionEndExcluding;
          }

          // Only add if we have meaningful version data
          if (Object.keys(range).length > 0) {
            ranges.push(range);
          }
        }
      }
    }

    return ranges;
  }

  /**
   * Determine the fixed version from version ranges
   * The fixed version is the minimum version that is NOT affected
   */
  private determineFixedVersion(ranges: VersionRange[]): string | null {
    const fixedVersions: string[] = [];

    for (const range of ranges) {
      if (range.endExcluding) {
        // versionEndExcluding means this version is the fix
        fixedVersions.push(range.endExcluding);
      } else if (range.endIncluding) {
        // versionEndIncluding means we need the NEXT version
        // Can't determine exact next version, but we know > endIncluding is safe
        // We'll return endIncluding with a note
        fixedVersions.push(`>${range.endIncluding}`);
      }
    }

    if (fixedVersions.length === 0) return null;

    // Find the highest fixed version (that's the MSV)
    // Filter out the ">" prefixed ones for sorting
    const cleanVersions = fixedVersions
      .filter((v) => !v.startsWith(">"))
      .sort((a, b) => compareVersions(a, b));

    if (cleanVersions.length > 0) {
      return cleanVersions[cleanVersions.length - 1];
    }

    // If all we have are "> X" versions, return the highest one
    const gtVersions = fixedVersions
      .filter((v) => v.startsWith(">"))
      .map((v) => v.slice(1))
      .sort((a, b) => compareVersions(a, b));

    if (gtVersions.length > 0) {
      return `>${gtVersions[gtVersions.length - 1]}`;
    }

    return null;
  }

  /**
   * Calculate MSV for a router model based on CVE data
   */
  calculateMsv(cves: RouterCveInfo[]): MsvCalculation | null {
    if (cves.length === 0) {
      return null;
    }

    const fixedVersions: Array<{ version: string; cveId: string; isKev: boolean }> = [];
    const kevCves: string[] = [];
    const msvCves: string[] = [];

    for (const cve of cves) {
      if (cve.isKev) {
        kevCves.push(cve.cveId);
      }

      if (cve.fixedVersion && !cve.fixedVersion.startsWith(">")) {
        fixedVersions.push({
          version: cve.fixedVersion,
          cveId: cve.cveId,
          isKev: cve.isKev,
        });
      }
    }

    if (fixedVersions.length === 0) {
      // No specific fixed versions found
      return {
        msv: "unknown",
        msvDate: new Date().toISOString().split("T")[0],
        msvCves: kevCves.length > 0 ? kevCves : cves.slice(0, 3).map((c) => c.cveId),
        kevCves,
        allCves: cves,
        confidence: "low",
        note: "No specific fixed versions found in CVE data",
      };
    }

    // Sort by version to find the highest (MSV)
    fixedVersions.sort((a, b) => compareVersions(a.version, b.version));
    const msv = fixedVersions[fixedVersions.length - 1];

    // Collect all CVEs that require this MSV or higher
    for (const fv of fixedVersions) {
      if (compareVersions(fv.version, msv.version) >= 0) {
        msvCves.push(fv.cveId);
      }
    }

    // Determine confidence based on data quality
    let confidence: "high" | "medium" | "low" = "medium";
    if (kevCves.length > 0 && fixedVersions.length >= 3) {
      confidence = "high";
    } else if (fixedVersions.length === 1) {
      confidence = "low";
    }

    return {
      msv: msv.version,
      msvDate: new Date().toISOString().split("T")[0],
      msvCves: [...new Set(msvCves)],
      kevCves,
      allCves: cves,
      confidence,
    };
  }

  /**
   * Query and calculate MSV for a router model
   */
  async queryRouterMsv(
    model: RouterModel,
    options: { maxResults?: number; minCvss?: number } = {}
  ): Promise<RouterNvdQueryResult> {
    if (!model.cpePrefix) {
      return {
        model: model.id,
        cpePrefix: "",
        cveCount: 0,
        kevCount: 0,
        calculation: null,
        error: "Model has no CPE prefix defined",
      };
    }

    try {
      const cves = await this.queryCvesByCpe(model.cpePrefix, options);
      const calculation = this.calculateMsv(cves);

      return {
        model: model.id,
        cpePrefix: model.cpePrefix,
        cveCount: cves.length,
        kevCount: cves.filter((c) => c.isKev).length,
        calculation,
      };
    } catch (error) {
      return {
        model: model.id,
        cpePrefix: model.cpePrefix,
        cveCount: 0,
        kevCount: 0,
        calculation: null,
        error: (error as Error).message,
      };
    }
  }

  /**
   * Format query result for display
   */
  formatResult(result: RouterNvdQueryResult): string {
    const lines: string[] = [];

    lines.push(`\nRouter: ${result.model}`);
    lines.push(`CPE: ${result.cpePrefix || "N/A"}`);
    lines.push("-".repeat(40));

    if (result.error) {
      lines.push(`Error: ${result.error}`);
      return lines.join("\n");
    }

    lines.push(`CVEs Found: ${result.cveCount}`);
    lines.push(`KEV CVEs: ${result.kevCount}`);

    if (result.calculation) {
      const calc = result.calculation;
      lines.push(`\nMSV Calculation:`);
      lines.push(`  Minimum Safe Version: ${calc.msv}`);
      lines.push(`  Confidence: ${calc.confidence.toUpperCase()}`);
      lines.push(`  Determining CVEs: ${calc.msvCves.join(", ")}`);

      if (calc.kevCves.length > 0) {
        lines.push(`  KEV CVEs: ${calc.kevCves.join(", ")}`);
      }

      if (calc.note) {
        lines.push(`  Note: ${calc.note}`);
      }

      if (calc.allCves.length > 0) {
        lines.push(`\nTop CVEs:`);
        for (const cve of calc.allCves.slice(0, 5)) {
          const kevTag = cve.isKev ? " [KEV]" : "";
          const severity = cve.severity ? ` (${cve.severity})` : "";
          lines.push(`  - ${cve.cveId}${kevTag}${severity}: ${cve.fixedVersion || "N/A"}`);
        }
      }
    } else {
      lines.push(`\nNo MSV calculation available`);
    }

    return lines.join("\n");
  }
}
