/**
 * ComplianceChecker.ts - Compare installed versions against MSV
 *
 * Determines compliance status and recommends actions:
 * - COMPLIANT: Current version >= MSV
 * - NON_COMPLIANT: Current version < MSV, needs upgrade
 * - UNKNOWN: No current version provided
 * - OUTDATED: Current version < recommended (even if >= MSV)
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

import { compareVersions } from "./VersionCompare";
import type { AdmiraltyRating } from "./AdmiraltyScoring";

// =============================================================================
// Types
// =============================================================================

export type ComplianceStatus =
  | "COMPLIANT"       // At or above MSV
  | "NON_COMPLIANT"   // Below MSV - security risk
  | "OUTDATED"        // Above MSV but below recommended
  | "UNKNOWN"         // No current version provided
  | "NOT_FOUND"       // Software not in catalog
  | "ERROR";          // Query failed

export type ActionRequired =
  | "none"
  | "upgrade_recommended"
  | "upgrade_required"
  | "critical_upgrade"
  | "investigate";

export interface DataFreshness {
  lastUpdated: string;
  lastChecked: string;
  ageHours: number;
  isStale: boolean;
  isCritical: boolean;
}

export interface ComplianceResult {
  software: string;
  displayName: string;
  currentVersion: string | null;
  minimumSafeVersion: string | null;
  recommendedVersion: string | null;
  status: ComplianceStatus;
  action: ActionRequired;
  actionMessage: string;
  admiraltyRating: AdmiraltyRating | null;
  sources: string[];
  branches?: BranchCompliance[];
  dataAge?: DataFreshness;
  error?: string;
}

export interface BranchCompliance {
  branch: string;
  msv: string;
  currentInBranch: boolean;
  compliant: boolean;
}

export interface ComplianceSummary {
  total: number;
  compliant: number;
  nonCompliant: number;
  outdated: number;
  unknown: number;
  notFound: number;
  errors: number;
  criticalActions: number;
  staleDataCount: number;
  criticalStaleCount: number;
}

// =============================================================================
// Compliance Checking
// =============================================================================

/**
 * Check if a version is compliant with MSV
 */
export function checkCompliance(
  currentVersion: string | null | undefined,
  minimumSafeVersion: string | null,
  recommendedVersion: string | null
): { status: ComplianceStatus; action: ActionRequired; message: string } {
  // No current version provided
  if (!currentVersion) {
    return {
      status: "UNKNOWN",
      action: "investigate",
      message: "No current version provided - cannot determine compliance",
    };
  }

  // No MSV available
  if (!minimumSafeVersion) {
    return {
      status: "UNKNOWN",
      action: "investigate",
      message: "MSV not determined - insufficient vulnerability data",
    };
  }

  const vsMsv = compareVersions(currentVersion, minimumSafeVersion);
  const vsRec = recommendedVersion
    ? compareVersions(currentVersion, recommendedVersion)
    : 0;

  // Below MSV - non-compliant
  if (vsMsv < 0) {
    // Check how far below
    const msvParts = minimumSafeVersion.split(".").map(p => parseInt(p) || 0);
    const curParts = currentVersion.split(".").map(p => parseInt(p) || 0);

    // Major version behind = critical
    if (msvParts[0] > curParts[0]) {
      return {
        status: "NON_COMPLIANT",
        action: "critical_upgrade",
        message: `CRITICAL: Upgrade from ${currentVersion} to at least ${minimumSafeVersion} (major version behind)`,
      };
    }

    return {
      status: "NON_COMPLIANT",
      action: "upgrade_required",
      message: `Upgrade required: ${currentVersion} → ${minimumSafeVersion} (minimum safe)`,
    };
  }

  // At or above MSV
  if (vsMsv >= 0) {
    // Check if below recommended
    if (recommendedVersion && vsRec < 0) {
      return {
        status: "OUTDATED",
        action: "upgrade_recommended",
        message: `Safe but outdated: ${currentVersion} → ${recommendedVersion} recommended`,
      };
    }

    return {
      status: "COMPLIANT",
      action: "none",
      message: `Compliant: ${currentVersion} meets or exceeds MSV ${minimumSafeVersion}`,
    };
  }

  // Shouldn't reach here
  return {
    status: "UNKNOWN",
    action: "investigate",
    message: "Unable to determine compliance status",
  };
}

/**
 * Check compliance against specific branch
 */
export function checkBranchCompliance(
  currentVersion: string,
  branches: Array<{ branch: string; msv: string; latest: string }>
): BranchCompliance[] {
  const results: BranchCompliance[] = [];

  // Determine which branch the current version belongs to
  const curParts = currentVersion.split(".");
  const curBranch = curParts.length >= 2 ? `${curParts[0]}.${curParts[1]}` : curParts[0];

  for (const branch of branches) {
    const inBranch = currentVersion.startsWith(branch.branch);
    const compliant = inBranch
      ? compareVersions(currentVersion, branch.msv) >= 0
      : false;

    results.push({
      branch: branch.branch,
      msv: branch.msv,
      currentInBranch: inBranch,
      compliant,
    });
  }

  return results;
}

// =============================================================================
// Summary Generation
// =============================================================================

/**
 * Generate summary statistics from compliance results
 */
export function generateSummary(results: ComplianceResult[]): ComplianceSummary {
  const summary: ComplianceSummary = {
    total: results.length,
    compliant: 0,
    nonCompliant: 0,
    outdated: 0,
    unknown: 0,
    notFound: 0,
    errors: 0,
    criticalActions: 0,
    staleDataCount: 0,
    criticalStaleCount: 0,
  };

  for (const result of results) {
    switch (result.status) {
      case "COMPLIANT":
        summary.compliant++;
        break;
      case "NON_COMPLIANT":
        summary.nonCompliant++;
        if (result.action === "critical_upgrade") {
          summary.criticalActions++;
        }
        break;
      case "OUTDATED":
        summary.outdated++;
        break;
      case "UNKNOWN":
        summary.unknown++;
        break;
      case "NOT_FOUND":
        summary.notFound++;
        break;
      case "ERROR":
        summary.errors++;
        break;
    }

    // Track stale data
    if (result.dataAge?.isStale) {
      summary.staleDataCount++;
      if (result.dataAge.isCritical) {
        summary.criticalStaleCount++;
      }
    }
  }

  return summary;
}

// =============================================================================
// Output Formatting
// =============================================================================

/**
 * Get status emoji/symbol for terminal output
 */
export function getStatusSymbol(status: ComplianceStatus): string {
  switch (status) {
    case "COMPLIANT":
      return "\x1b[32m✓\x1b[0m"; // Green checkmark
    case "NON_COMPLIANT":
      return "\x1b[31m✗\x1b[0m"; // Red X
    case "OUTDATED":
      return "\x1b[33m!\x1b[0m"; // Yellow warning
    case "UNKNOWN":
      return "\x1b[36m?\x1b[0m"; // Cyan question
    case "NOT_FOUND":
      return "\x1b[90m-\x1b[0m"; // Gray dash
    case "ERROR":
      return "\x1b[31mE\x1b[0m"; // Red E
    default:
      return " ";
  }
}

/**
 * Get action priority color
 */
export function getActionColor(action: ActionRequired): string {
  switch (action) {
    case "critical_upgrade":
      return "\x1b[31m"; // Red
    case "upgrade_required":
      return "\x1b[33m"; // Yellow
    case "upgrade_recommended":
      return "\x1b[36m"; // Cyan
    case "investigate":
      return "\x1b[90m"; // Gray
    default:
      return "\x1b[32m"; // Green
  }
}

export const RESET = "\x1b[0m";

/**
 * Format data age as human-readable string
 */
function formatAge(freshness: DataFreshness): string {
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
 * Format a single compliance result as text
 */
export function formatComplianceText(result: ComplianceResult): string {
  const symbol = getStatusSymbol(result.status);
  const color = getActionColor(result.action);

  const lines = [
    `${symbol} ${result.displayName}`,
  ];

  if (result.currentVersion) {
    lines.push(`   Current: ${result.currentVersion}`);
  }

  if (result.minimumSafeVersion) {
    lines.push(`   MSV: ${result.minimumSafeVersion}`);
  }

  if (result.recommendedVersion && result.recommendedVersion !== result.minimumSafeVersion) {
    lines.push(`   Recommended: ${result.recommendedVersion}`);
  }

  lines.push(`   ${color}${result.actionMessage}${RESET}`);

  // Show data freshness warning if stale
  if (result.dataAge) {
    if (result.dataAge.isCritical) {
      lines.push(`   \x1b[31m⚠ Data is ${formatAge(result.dataAge)} old - refresh recommended\x1b[0m`);
    } else if (result.dataAge.isStale) {
      lines.push(`   \x1b[33m○ Data checked ${formatAge(result.dataAge)}\x1b[0m`);
    }
  }

  if (result.error) {
    lines.push(`   Error: ${result.error}`);
  }

  return lines.join("\n");
}

/**
 * Format compliance results as CSV
 */
export function formatComplianceCSV(results: ComplianceResult[]): string {
  const headers = [
    "Software",
    "Current Version",
    "MSV",
    "Recommended",
    "Status",
    "Action",
    "Message",
  ];

  const rows = results.map(r => [
    r.displayName,
    r.currentVersion || "",
    r.minimumSafeVersion || "",
    r.recommendedVersion || "",
    r.status,
    r.action,
    `"${r.actionMessage.replace(/"/g, '""')}"`,
  ]);

  return [headers.join(","), ...rows.map(r => r.join(","))].join("\n");
}

/**
 * Format compliance results as JSON
 */
export function formatComplianceJSON(
  results: ComplianceResult[],
  summary: ComplianceSummary
): string {
  return JSON.stringify(
    {
      summary,
      results,
      generatedAt: new Date().toISOString(),
    },
    null,
    2
  );
}

/**
 * Format compliance summary as text
 */
export function formatSummaryText(summary: ComplianceSummary): string {
  const lines = [
    "",
    "═".repeat(50),
    "COMPLIANCE SUMMARY",
    "═".repeat(50),
    "",
    `Total Software:    ${summary.total}`,
    `\x1b[32m✓ Compliant:       ${summary.compliant}\x1b[0m`,
    `\x1b[31m✗ Non-Compliant:   ${summary.nonCompliant}\x1b[0m`,
    `\x1b[33m! Outdated:        ${summary.outdated}\x1b[0m`,
    `\x1b[36m? Unknown:         ${summary.unknown}\x1b[0m`,
    `\x1b[90m- Not Found:       ${summary.notFound}\x1b[0m`,
  ];

  if (summary.errors > 0) {
    lines.push(`\x1b[31mE Errors:          ${summary.errors}\x1b[0m`);
  }

  if (summary.criticalActions > 0) {
    lines.push("");
    lines.push(`\x1b[31m⚠ CRITICAL: ${summary.criticalActions} software require immediate upgrade\x1b[0m`);
  }

  // Data freshness warnings
  if (summary.criticalStaleCount > 0) {
    lines.push("");
    lines.push(`\x1b[31m⚠ STALE DATA: ${summary.criticalStaleCount} entries have data > 7 days old\x1b[0m`);
    lines.push(`  Run 'msv check <input> --force' to refresh`);
  } else if (summary.staleDataCount > 0) {
    lines.push("");
    lines.push(`\x1b[33m○ ${summary.staleDataCount} entries have data > 24 hours old\x1b[0m`);
  }

  const complianceRate = summary.total > 0
    ? ((summary.compliant / summary.total) * 100).toFixed(1)
    : "0.0";

  lines.push("");
  lines.push(`Compliance Rate: ${complianceRate}%`);
  lines.push("═".repeat(50));

  return lines.join("\n");
}
