/**
 * ActionGuidance.ts - Generate actionable security recommendations
 *
 * Provides clear, actionable guidance for security teams based on MSV results.
 * Each result gets an explicit ACTION with reasoning.
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

import type { AdmiraltyRating } from "./AdmiraltyScoring";

// =============================================================================
// Types
// =============================================================================

export type ActionType =
  | "UPGRADE_CRITICAL"    // Active exploitation, must upgrade immediately
  | "UPGRADE_REQUIRED"    // Known vulnerabilities, upgrade soon
  | "UPGRADE_RECOMMENDED" // Outdated but not critical
  | "NO_ACTION"           // Compliant or no known issues
  | "INVESTIGATE"         // Insufficient data, manual review needed
  | "MONITOR";            // No vulns found, but keep watching

export interface ActionGuidance {
  action: ActionType;
  symbol: string;         // Terminal symbol (✓, ⚠, ✗, ?)
  color: string;          // ANSI color code
  headline: string;       // Short action (e.g., "UPGRADE REQUIRED")
  message: string;        // Detailed guidance
  urgency: "critical" | "high" | "medium" | "low" | "info";
  guidance?: UndeterminedGuidance;  // Additional guidance for INVESTIGATE actions
}

export interface UndeterminedGuidance {
  vendorSecurityPage?: string;   // URL to vendor's security page
  steps: string[];               // Actionable next steps
}

export interface ActionInput {
  currentVersion: string | null;
  minimumSafeVersion: string | null;
  recommendedVersion: string | null;
  admiraltyRating: AdmiraltyRating | null;
  hasKevCves: boolean;
  cveCount: number;
  sources: string[];
  vendor?: string;  // Vendor name for security page lookup
  branchesWithNoSafeVersion?: Array<{branch: string; msv: string; latest: string}>;
}

// =============================================================================
// Color Constants
// =============================================================================

const COLORS = {
  RED: "\x1b[31m",
  YELLOW: "\x1b[33m",
  GREEN: "\x1b[32m",
  CYAN: "\x1b[36m",
  MAGENTA: "\x1b[35m",
  RESET: "\x1b[0m",
  BOLD: "\x1b[1m",
  DIM: "\x1b[2m",
};

// =============================================================================
// Vendor Security Pages
// =============================================================================

/**
 * Mapping of vendor names to their security advisory pages
 */
const VENDOR_SECURITY_PAGES: Record<string, string> = {
  // Major software vendors
  adobe: "https://helpx.adobe.com/security/security-bulletin.html",
  microsoft: "https://msrc.microsoft.com/update-guide/",
  google: "https://chromereleases.googleblog.com/",
  mozilla: "https://www.mozilla.org/en-US/security/advisories/",
  apple: "https://support.apple.com/en-us/HT201222",
  oracle: "https://www.oracle.com/security-alerts/",

  // Open source / Apache
  apache: "https://www.apache.org/security/",
  openssl: "https://www.openssl.org/news/secadv/",
  nodejs: "https://nodejs.org/en/blog/vulnerability",
  python: "https://www.python.org/news/security/",

  // Enterprise vendors
  solarwinds: "https://www.solarwinds.com/trust-center/security-advisories",
  citrix: "https://support.citrix.com/securitybulletins",
  vmware: "https://www.vmware.com/security/advisories.html",
  cisco: "https://tools.cisco.com/security/center/publicationListing.x",
  fortinet: "https://www.fortiguard.com/psirt",
  paloaltonetworks: "https://security.paloaltonetworks.com/",

  // Security tools
  crowdstrike: "https://falcon.crowdstrike.com/documentation/security-advisories",
  splunk: "https://advisory.splunk.com/",

  // Remote access
  teamviewer: "https://www.teamviewer.com/en-us/resources/trust-center/security-bulletins/",
  putty: "https://www.chiark.greenend.org.uk/~sgtatham/putty/changes.html",

  // Network tools
  wireshark: "https://www.wireshark.org/security/",
  nmap: "https://nmap.org/changelog.html",

  // Compression
  "7-zip": "https://www.7-zip.org/history.txt",
  rarlab: "https://www.rarlab.com/rarnew.htm",

  // Databases
  postgresql: "https://www.postgresql.org/support/security/",
  mongodb: "https://www.mongodb.com/alerts",
  redis: "https://redis.io/docs/management/security/",

  // Text editors
  notepadplusplus: "https://notepad-plus-plus.org/news/",
  "notepad-plus-plus": "https://notepad-plus-plus.org/news/",
  sublime: "https://www.sublimetext.com/blog/",
  vim: "https://github.com/vim/vim/security/advisories",
  vscode: "https://github.com/microsoft/vscode/security/advisories",

  // Default fallback
  default: "https://nvd.nist.gov/",
};

/**
 * Get vendor security page URL
 */
function getVendorSecurityPage(vendor?: string): string {
  if (!vendor) return VENDOR_SECURITY_PAGES.default;
  const normalized = vendor.toLowerCase().replace(/[^a-z0-9]/g, "");
  return VENDOR_SECURITY_PAGES[normalized] || VENDOR_SECURITY_PAGES.default;
}

// =============================================================================
// Action Generation
// =============================================================================

/**
 * Generate action guidance based on MSV result
 */
export function generateAction(input: ActionInput): ActionGuidance {
  const {
    currentVersion,
    minimumSafeVersion,
    recommendedVersion,
    admiraltyRating,
    hasKevCves,
    cveCount,
    sources,
    vendor,
    branchesWithNoSafeVersion,
  } = input;

  // Case 0: Branches with no safe version available (MSV > latest)
  if (branchesWithNoSafeVersion && branchesWithNoSafeVersion.length > 0) {
    const affectedBranches = branchesWithNoSafeVersion
      .map(b => `${b.branch}.x (needs ${b.msv}, latest is ${b.latest})`)
      .join(", ");

    // Check if ALL branches are affected
    const vendorUrl = getVendorSecurityPage(vendor);
    return {
      action: "UPGRADE_CRITICAL",
      symbol: "⛔",
      color: COLORS.RED,
      headline: "NO SAFE VERSION AVAILABLE",
      message: `Affected branches: ${affectedBranches}. Wait for patch or use an unaffected branch.`,
      urgency: "critical",
      guidance: {
        vendorSecurityPage: vendorUrl,
        steps: [
          "Do NOT upgrade to affected branch versions",
          "Stay on a safe version from an unaffected branch if possible",
          "Monitor vendor security advisories for patch release",
          "Consider compensating controls (WAF rules, network isolation)",
          "Evaluate if affected functionality can be disabled",
        ],
      },
    };
  }

  // Case 1: Active exploitation detected (KEV CVEs)
  if (hasKevCves && minimumSafeVersion) {
    if (currentVersion && compareVersions(currentVersion, minimumSafeVersion) < 0) {
      return {
        action: "UPGRADE_CRITICAL",
        symbol: "✗",
        color: COLORS.RED,
        headline: "UPGRADE IMMEDIATELY",
        message: `Version ${currentVersion} is actively exploited. Upgrade to ${minimumSafeVersion} or later NOW.`,
        urgency: "critical",
      };
    }
  }

  // Case 2: Known vulnerabilities, current version below MSV
  if (minimumSafeVersion && currentVersion) {
    const comparison = compareVersions(currentVersion, minimumSafeVersion);

    if (comparison < 0) {
      // Current < MSV = Non-compliant
      const cveInfo = cveCount > 0 ? ` (${cveCount} CVEs patched)` : "";
      return {
        action: "UPGRADE_REQUIRED",
        symbol: "⚠",
        color: COLORS.YELLOW,
        headline: "UPGRADE REQUIRED",
        message: `Current ${currentVersion} → MSV ${minimumSafeVersion}${cveInfo}. Known vulnerabilities affect your version.`,
        urgency: "high",
      };
    }

    // Current >= MSV but < Recommended
    if (recommendedVersion && compareVersions(currentVersion, recommendedVersion) < 0) {
      return {
        action: "UPGRADE_RECOMMENDED",
        symbol: "!",
        color: COLORS.CYAN,
        headline: "UPGRADE RECOMMENDED",
        message: `Current ${currentVersion} meets MSV but ${recommendedVersion} provides better protection.`,
        urgency: "medium",
      };
    }

    // Current >= MSV (and >= Recommended if exists)
    return {
      action: "NO_ACTION",
      symbol: "✓",
      color: COLORS.GREEN,
      headline: "COMPLIANT",
      message: `Version ${currentVersion} meets or exceeds the minimum safe version.`,
      urgency: "info",
    };
  }

  // Case 3: MSV determined but no current version provided
  if (minimumSafeVersion && !currentVersion) {
    return {
      action: "INVESTIGATE",
      symbol: "?",
      color: COLORS.MAGENTA,
      headline: "VERSION CHECK NEEDED",
      message: `MSV is ${minimumSafeVersion}. Verify your installed version meets this requirement.`,
      urgency: "medium",
    };
  }

  // Case 4: No MSV determined (F6 rating or similar)
  if (!minimumSafeVersion) {
    // Check if we have any CVE data at all
    if (cveCount === 0 && sources.length > 0) {
      return {
        action: "MONITOR",
        symbol: "✓",
        color: COLORS.GREEN,
        headline: "NO KNOWN VULNERABILITIES",
        message: "No exploited vulnerabilities found. Use latest vendor-supported version and monitor advisories.",
        urgency: "info",
      };
    }

    // No data at all
    if (sources.length === 0 || (admiraltyRating?.rating === "F6")) {
      const vendorUrl = getVendorSecurityPage(vendor);
      return {
        action: "INVESTIGATE",
        symbol: "?",
        color: COLORS.MAGENTA,
        headline: "INSUFFICIENT DATA",
        message: "Could not determine MSV. Check vendor security advisories directly.",
        urgency: "low",
        guidance: {
          vendorSecurityPage: vendorUrl,
          steps: [
            "Check vendor security advisories for recent patches",
            "Search NVD for CVEs affecting this product",
            "Consider adding product to MSV catalog with CPE",
            "Use latest vendor-supported version until MSV is determined",
          ],
        },
      };
    }

    // Has CVE data but couldn't determine MSV
    const vendorUrl = getVendorSecurityPage(vendor);
    const isDefaultUrl = vendorUrl === VENDOR_SECURITY_PAGES.default;
    return {
      action: "INVESTIGATE",
      symbol: "?",
      color: COLORS.YELLOW,
      headline: "VERSION DATA INCOMPLETE",
      message: `Found ${cveCount} CVEs but version ranges unavailable in data sources.`,
      urgency: "medium",
      guidance: {
        vendorSecurityPage: vendorUrl,
        steps: isDefaultUrl ? [
          `Search NVD: https://nvd.nist.gov/vuln/search?query=${encodeURIComponent(vendor || "product")}`,
          "Click CVE IDs above to view affected version ranges",
          "Check vendor website for security advisories or changelog",
          "Upgrade to latest version as precaution until MSV is determined",
        ] : [
          `Check vendor advisories: ${vendorUrl}`,
          "Click CVE IDs above to view affected version ranges on NVD",
          "Look for 'Fixed in version' or 'Patched in' in advisories",
          "Upgrade to latest version as precaution until MSV is determined",
        ],
      },
    };
  }

  // Default fallback
  return {
    action: "MONITOR",
    symbol: "○",
    color: COLORS.CYAN,
    headline: "MONITOR",
    message: "Continue monitoring for new vulnerabilities.",
    urgency: "low",
  };
}

/**
 * Format action guidance for terminal output
 */
export function formatActionBox(guidance: ActionGuidance): string {
  const { symbol, color, headline, message, urgency } = guidance;
  const RESET = COLORS.RESET;
  const BOLD = COLORS.BOLD;
  const DIM = COLORS.DIM;

  // Calculate box width based on content
  const contentWidth = Math.max(headline.length + 4, message.length) + 2;
  const boxWidth = Math.min(Math.max(contentWidth, 50), 70);

  const topBorder = "┌" + "─".repeat(boxWidth) + "┐";
  const bottomBorder = "└" + "─".repeat(boxWidth) + "┘";

  // Pad headline and message to box width
  const headlinePadded = ` ${symbol} ${headline}`.padEnd(boxWidth);
  const messagePadded = ` ${message}`.padEnd(boxWidth);

  // Wrap long messages
  const wrappedMessage = wrapText(message, boxWidth - 2);
  const messageLines = wrappedMessage.map(line => `│${color} ${line.padEnd(boxWidth - 1)}${RESET}│`);

  const lines = [
    `${color}${topBorder}${RESET}`,
    `│${color}${BOLD} ${symbol} ${headline}${RESET}${" ".repeat(boxWidth - headline.length - 3)}│`,
    ...messageLines,
  ];

  // Add guidance section for INVESTIGATE actions
  if (guidance.guidance) {
    const { vendorSecurityPage, steps } = guidance.guidance;

    // Add separator line
    lines.push(`│${" ".repeat(boxWidth)}│`);

    // Add vendor link
    if (vendorSecurityPage) {
      const linkLine = `Vendor: ${vendorSecurityPage}`;
      const wrappedLink = wrapText(linkLine, boxWidth - 4);
      for (const line of wrappedLink) {
        lines.push(`│${DIM}  ${line.padEnd(boxWidth - 2)}${RESET}│`);
      }
    }

    // Add next steps
    if (steps && steps.length > 0) {
      lines.push(`│${" ".repeat(boxWidth)}│`);
      lines.push(`│${BOLD}  Next Steps:${RESET}${" ".repeat(boxWidth - 13)}│`);
      for (let i = 0; i < steps.length; i++) {
        const stepLine = `${i + 1}. ${steps[i]}`;
        const wrappedStep = wrapText(stepLine, boxWidth - 5);
        for (const line of wrappedStep) {
          lines.push(`│${DIM}   ${line.padEnd(boxWidth - 3)}${RESET}│`);
        }
      }
    }
  }

  lines.push(`${color}${bottomBorder}${RESET}`);

  return lines.join("\n");
}

/**
 * Format action as a single line (for compact output)
 */
export function formatActionLine(guidance: ActionGuidance): string {
  const { symbol, color, headline, message } = guidance;
  return `${color}${symbol} ${headline}${COLORS.RESET}: ${message}`;
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Compare two version strings
 * Returns: negative if a < b, 0 if equal, positive if a > b
 */
function compareVersions(a: string, b: string): number {
  const partsA = a.split(".").map((p) => parseInt(p, 10) || 0);
  const partsB = b.split(".").map((p) => parseInt(p, 10) || 0);
  const maxLen = Math.max(partsA.length, partsB.length);

  for (let i = 0; i < maxLen; i++) {
    const partA = partsA[i] || 0;
    const partB = partsB[i] || 0;
    if (partA !== partB) return partA - partB;
  }
  return 0;
}

/**
 * Wrap text to specified width
 */
function wrapText(text: string, width: number): string[] {
  if (text.length <= width) return [text];

  const words = text.split(" ");
  const lines: string[] = [];
  let currentLine = "";

  for (const word of words) {
    if (currentLine.length + word.length + 1 <= width) {
      currentLine += (currentLine ? " " : "") + word;
    } else {
      if (currentLine) lines.push(currentLine);
      currentLine = word;
    }
  }
  if (currentLine) lines.push(currentLine);

  return lines;
}

/**
 * Get urgency rank for sorting
 */
export function getUrgencyRank(urgency: ActionGuidance["urgency"]): number {
  const ranks = { critical: 5, high: 4, medium: 3, low: 2, info: 1 };
  return ranks[urgency] || 0;
}
