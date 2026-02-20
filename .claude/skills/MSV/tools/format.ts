/**
 * format.ts - Output Formatters for MSV Results
 *
 * Handles formatting MSV results in various output formats:
 * - text: Human-readable colored terminal output
 * - json: Machine-readable JSON
 * - markdown: Documentation-friendly tables
 * - csv: Spreadsheet-compatible batch output
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

import type { MSVResult, DataFreshness } from "./types";
import { COLORS } from "./types";
import { formatRiskScore } from "./RiskScoring";
import { formatActionBox } from "./ActionGuidance";
import { formatRatingWithDescription, RESET_COLOR } from "./AdmiraltyScoring";
import { compareVersions } from "./VersionCompare";
import { checkCompliance } from "./ComplianceChecker";

const { DIM, BOLD, CYAN, YELLOW, GREEN, MAGENTA, RED } = COLORS;

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Format data age as human-readable string
 */
export function formatDataAge(freshness: DataFreshness): string {
  if (freshness.ageHours < 1) {
    return "just now";
  } else if (freshness.ageHours < 24) {
    return `${freshness.ageHours}h ago`;
  } else {
    const days = Math.round(freshness.ageHours / 24);
    return `${days}d ago`;
  }
}

/**
 * Get freshness indicator with appropriate color
 */
export function getFreshnessIndicator(freshness: DataFreshness): string {
  if (freshness.isCritical) {
    return `${RED}⚠ STALE DATA${RESET_COLOR}`; // Red warning
  } else if (freshness.isStale) {
    return `${YELLOW}○ Data may be outdated${RESET_COLOR}`; // Yellow
  }
  return `${GREEN}●${RESET_COLOR}`; // Green dot - fresh
}

// =============================================================================
// Output Formatters
// =============================================================================

/**
 * Format MSV result as human-readable text with colors
 */
export function formatText(result: MSVResult): string {
  const lines: string[] = [];

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
      const indicator = getFreshnessIndicator(result.dataAge);
      if (result.fromCache) {
        const age = formatDataAge(result.dataAge);
        lines.push(`${indicator} Data from cache${result.dataAge.ageHours >= 1 ? ` (checked ${age})` : ""}`);
      } else {
        lines.push(`${indicator} Data checked just now`);
      }
    }

    return lines.join("\n");
  }

  // MSV Section - ALWAYS show, even if undetermined
  if (result.minimumSafeVersion) {
    if (result.minimumSafeVersion === result.recommendedVersion || !result.recommendedVersion) {
      lines.push(`${BOLD}Minimum Safe Version:${RESET_COLOR} ${CYAN}${result.minimumSafeVersion}${RESET_COLOR}`);
    } else {
      lines.push(`${BOLD}Minimum Safe Version:${RESET_COLOR} ${CYAN}${result.minimumSafeVersion}${RESET_COLOR} ${DIM}(oldest safe)${RESET_COLOR}`);
      lines.push(`${BOLD}Recommended Version:${RESET_COLOR}  ${CYAN}${result.recommendedVersion}${RESET_COLOR} ${DIM}(newest verified safe)${RESET_COLOR}`);
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
    const recVersion = result.recommendedVersion || result.minimumSafeVersion;
    const latestAhead = recVersion ? compareVersions(result.latestVersion, recVersion) > 0 : false;
    const latestNote = latestAhead
      ? "(current release - not yet in vulnerability databases)"
      : "(current release)";
    lines.push(`${BOLD}Latest Version:${RESET_COLOR}       ${GREEN}${result.latestVersion}${RESET_COLOR} ${DIM}${latestNote}${RESET_COLOR}`);
  }

  // Your Version compliance check (when --version is supplied)
  if (result.currentVersion) {
    const compliance = checkCompliance(
      result.currentVersion,
      result.minimumSafeVersion,
      result.recommendedVersion
    );
    const statusColors: Record<string, string> = {
      COMPLIANT: GREEN,
      NON_COMPLIANT: RED,
      OUTDATED: YELLOW,
      UNKNOWN: YELLOW,
    };
    const statusColor = statusColors[compliance.status] || YELLOW;
    lines.push(`${BOLD}Your Version:${RESET_COLOR}         ${statusColor}${result.currentVersion} (${compliance.status})${RESET_COLOR}`);
    lines.push(`${DIM}  ${compliance.message}${RESET_COLOR}`);

    // Detect version newer than latest known stable release (Fix 5)
    if (result.latestVersion && compareVersions(result.currentVersion, result.latestVersion) > 0) {
      lines.push(`${DIM}  Note: Your version (${result.currentVersion}) is newer than the latest version in our database (${result.latestVersion}).${RESET_COLOR}`);
      lines.push(`${DIM}  This may mean our version data is outdated, or you are on a Dev/Beta/Canary channel.${RESET_COLOR}`);
      lines.push(`${DIM}  Run with --force to refresh version data from live sources.${RESET_COLOR}`);
    }
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

  // Branch information if available (filter out "default" placeholder branch)
  // Only show real version branches (e.g., "5", "6", "7" for 5.x, 6.x, 7.x trains)
  const realBranches = result.branches.filter(b => b.branch !== "default");
  if (realBranches.length > 0) {
    lines.push(`${BOLD}Version Branches:${RESET_COLOR}`);
    for (const branch of realBranches) {
      if (branch.noSafeVersion) {
        // Critical warning: MSV > latest means no safe version exists in this branch
        lines.push(`  ${RED}${branch.branch}.x: NO SAFE VERSION - MSV ${branch.msv} > latest ${branch.latest}${RESET_COLOR}`);
        lines.push(`    ${DIM}${RED}⚠ Do not use this branch until ${branch.msv} is released${RESET_COLOR}`);
      } else {
        lines.push(`  ${branch.branch}.x: MSV ${branch.msv} (latest: ${branch.latest})`);
      }
    }
    lines.push(`${DIM}  Only branches with vulnerability data in our sources are shown.${RESET_COLOR}`);
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
      if (cve.inCisaKev) markers.push(`${RED}KEV${RESET_COLOR}`);
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
    } else if (result.fromCache) {
      lines.push(`${indicator} Data from cache${result.dataAge.ageHours >= 1 ? ` (checked ${age})` : ""}`);
    } else {
      lines.push(`${indicator} Data checked just now`);
    }
  }

  return lines.join("\n");
}

/**
 * Format MSV result as JSON
 */
export function formatJson(result: MSVResult): string {
  return JSON.stringify(result, null, 2);
}

/**
 * Format MSV result as Markdown table
 */
export function formatMarkdown(result: MSVResult): string {
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
    ...(result.currentVersion ? [
      `| **Your Version** | **${result.currentVersion}** (${checkCompliance(result.currentVersion, result.minimumSafeVersion, result.recommendedVersion).status}) |`,
    ] : []),
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

  // Show branch information (filter out "default" placeholder branch)
  const mdBranches = result.branches.filter(b => b.branch !== "default");
  if (mdBranches.length > 0) {
    lines.push("");
    lines.push("### Version Branches");
    lines.push("");
    lines.push("| Branch | MSV | Latest |");
    lines.push("|--------|-----|--------|");
    for (const branch of mdBranches) {
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
export function formatBatchCSV(results: MSVResult[]): string {
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
