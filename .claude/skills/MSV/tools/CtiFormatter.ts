/**
 * CtiFormatter.ts - CTI Report Output Formatters
 *
 * Formats CTI reports in multiple output formats:
 * - text: Terminal-friendly with ANSI colors
 * - markdown: Documentation-ready with tables
 * - json: Machine-readable for integration
 *
 * Reports are designed to fit on 1 printed page (~60 lines).
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

import type {
  CTIReport,
  IntelItem,
  EpssSpike,
  InventoryStatus,
  VulnCheckKevDelta,
  CTIOutputFormat,
} from "./CtiTypes";

// =============================================================================
// ANSI Colors
// =============================================================================

const COLORS = {
  RESET: "\x1b[0m",
  BOLD: "\x1b[1m",
  DIM: "\x1b[2m",
  RED: "\x1b[31m",
  GREEN: "\x1b[32m",
  YELLOW: "\x1b[33m",
  BLUE: "\x1b[34m",
  MAGENTA: "\x1b[35m",
  CYAN: "\x1b[36m",
  WHITE: "\x1b[37m",
  BG_RED: "\x1b[41m",
  BG_YELLOW: "\x1b[43m",
  BG_GREEN: "\x1b[42m",
  BG_WHITE: "\x1b[47m",
} as const;

// =============================================================================
// Main Formatter
// =============================================================================

/**
 * Format CTI report in the specified output format
 */
export function formatCtiReport(report: CTIReport, format: CTIOutputFormat): string {
  switch (format) {
    case "json":
      return formatJson(report);
    case "markdown":
      return formatMarkdown(report);
    case "text":
    default:
      return formatText(report);
  }
}

// =============================================================================
// Text Format (Terminal)
// =============================================================================

function formatText(report: CTIReport): string {
  const { RESET, BOLD, DIM, RED, GREEN, YELLOW, CYAN, MAGENTA, BG_RED, BG_YELLOW, BG_GREEN, BG_WHITE } = COLORS;
  const lines: string[] = [];

  // ─────────────────────────────────────────────────────────────────
  // Header Box with TLP
  // ─────────────────────────────────────────────────────────────────
  const tlpColor = getTlpColor(report.tlp.level);
  const headerWidth = 66;

  const innerWidth = headerWidth - 2; // visible chars between ║ borders

  // Build each line with explicit visible-width padding, then wrap with ANSI
  const title = "CYBER THREAT INTELLIGENCE REPORT";
  const tlpLabel = ` ${report.tlp.level}`;
  const titleGap = innerWidth - tlpLabel.length - title.length - 1; // -1 for trailing space
  const dateText = `Week of ${report.periodStart} to ${report.periodEnd}`;
  const dateGap = innerWidth - dateText.length - 1; // -1 for trailing space

  lines.push(`${tlpColor}${"═".repeat(headerWidth)}${RESET}`);
  lines.push(
    `${tlpColor}║${RESET}${BOLD}${tlpLabel}${RESET}` +
      `${" ".repeat(Math.max(1, titleGap))}` +
      `${BOLD}${title}${RESET} ${tlpColor}║${RESET}`
  );
  lines.push(
    `${tlpColor}║${RESET}` +
      `${" ".repeat(Math.max(1, dateGap))}` +
      `${dateText} ${tlpColor}║${RESET}`
  );
  if (report.preparedFor) {
    const prepText = `Prepared for: ${report.preparedFor}`;
    const prepGap = innerWidth - prepText.length - 1;
    lines.push(
      `${tlpColor}║${RESET}` +
        `${" ".repeat(Math.max(1, prepGap))}` +
        `${prepText} ${tlpColor}║${RESET}`
    );
  }
  lines.push(`${tlpColor}${"═".repeat(headerWidth)}${RESET}`);
  lines.push("");

  // ─────────────────────────────────────────────────────────────────
  // BLUF Section
  // ─────────────────────────────────────────────────────────────────
  const postureColor =
    report.bluf.threatPosture === "ELEVATED"
      ? RED
      : report.bluf.threatPosture === "NORMAL"
        ? YELLOW
        : GREEN;

  lines.push(`${BOLD}${CYAN}▌ BOTTOM LINE UP FRONT${RESET}`);
  lines.push(`${DIM}${"─".repeat(50)}${RESET}`);
  lines.push("");

  // Threat Posture
  lines.push(
    `${BOLD}Threat Posture:${RESET} ${postureColor}${BOLD}${report.bluf.threatPosture}${RESET}`
  );
  lines.push(`${DIM}${report.bluf.postureReason}${RESET}`);
  lines.push("");

  // Summary
  lines.push(`${BOLD}Summary:${RESET}`);
  wrapText(report.bluf.summary, 64).forEach((line) => lines.push(`  ${line}`));
  lines.push("");

  // Action Items
  if (report.bluf.actionItems.length > 0) {
    lines.push(`${BOLD}Action Items:${RESET}`);
    for (const item of report.bluf.actionItems) {
      const actionColor = item.startsWith("IMMEDIATE")
        ? RED
        : item.startsWith("URGENT")
          ? RED
          : item.startsWith("PRIORITY")
            ? YELLOW
            : GREEN;
      lines.push(`  ${actionColor}●${RESET} ${item}`);
    }
    lines.push("");
  }

  // ─────────────────────────────────────────────────────────────────
  // Section 1: Active Exploitation — Priority Threats
  // Split into true zero-days vs newly-tracked KEV entries
  // ─────────────────────────────────────────────────────────────────
  lines.push(`${BOLD}${CYAN}▌ ACTIVE EXPLOITATION — Priority Threats${RESET}`);
  lines.push(`${DIM}${"─".repeat(50)}${RESET}`);

  if (report.criticalZeroDays.length === 0) {
    lines.push(`${GREEN}No priority threats identified in this period.${RESET}`);
  } else {
    const zeroDays = report.criticalZeroDays.filter((item) => item.isZeroDay);
    const otherThreats = report.criticalZeroDays.filter((item) => !item.isZeroDay);

    // True zero-days first (no patch, recent CVE)
    if (zeroDays.length > 0) {
      lines.push(`${RED}${BOLD}  ZERO-DAY (no patch available)${RESET}`);
      for (const zd of zeroDays) {
        const tags: string[] = [];
        if (zd.source === "VULNCHECK") tags.push(`${YELLOW}VULNCHECK EARLY-WARNING${RESET}`);
        if (zd.ransomwareAssociated) tags.push(`${RED}RANSOMWARE${RESET}`);
        if (zd.epssScore && zd.epssScore > 0.5) {
          tags.push(`${YELLOW}EPSS:${(zd.epssScore * 100).toFixed(1)}%${RESET}`);
        }
        const tagStr = tags.length > 0 ? ` [${tags.join(", ")}]` : "";
        lines.push(
          `${RED}●${RESET} ${BOLD}${zd.id}${RESET} - ${zd.title}${tagStr}`
        );
      }
      lines.push("");
    }

    // Other active exploitation (patched but actively exploited, newly added to KEV)
    if (otherThreats.length > 0) {
      lines.push(`${YELLOW}${BOLD}  ACTIVELY EXPLOITED (patch available)${RESET}`);
      for (const item of otherThreats) {
        const priorityColor = item.priority === "CRITICAL" ? RED : YELLOW;
        const tags: string[] = [];
        if (item.ransomwareAssociated) tags.push(`${RED}RANSOMWARE${RESET}`);
        if (item.epssScore && item.epssScore > 0.5) {
          tags.push(`${YELLOW}EPSS:${(item.epssScore * 100).toFixed(1)}%${RESET}`);
        }
        // Show CVE age for context
        if (item.cveYear) {
          const currentYear = new Date().getFullYear();
          const age = currentYear - item.cveYear;
          if (age > 2) {
            tags.push(`${DIM}CVE:${item.cveYear}${RESET}`);
          }
        }
        const tagStr = tags.length > 0 ? ` [${tags.join(", ")}]` : "";
        lines.push(
          `${priorityColor}●${RESET} ${BOLD}${item.id}${RESET} - ${item.title}${tagStr}`
        );
      }
    }
  }
  lines.push("");

  // ─────────────────────────────────────────────────────────────────
  // Section 2: Exploitation Trends
  // ─────────────────────────────────────────────────────────────────
  lines.push(`${BOLD}${CYAN}▌ EXPLOITATION TRENDS${RESET}`);
  lines.push(`${DIM}${"─".repeat(50)}${RESET}`);

  // KEV Delta — show what was actually added
  lines.push(
    `${BOLD}KEV Catalog:${RESET} ${report.kevDelta.totalCurrent} total ` +
      `(${YELLOW}+${report.kevDelta.newEntries.length}${RESET} this period)`
  );
  if (report.kevDelta.newEntries.length > 0) {
    for (const entry of report.kevDelta.newEntries) {
      const vendor = entry.affectedProducts[0] || "Unknown";
      const ransomTag = entry.ransomwareAssociated ? ` ${RED}[RANSOMWARE]${RESET}` : "";
      lines.push(
        `  ${YELLOW}NEW${RESET}  ${BOLD}${entry.id}${RESET} ${vendor}${ransomTag}`
      );
      lines.push(
        `       ${DIM}${truncateText(entry.title, 56)}${RESET}`
      );
    }
  }
  lines.push("");

  // EPSS Spikes — with product context
  if (report.epssSpikes.length > 0) {
    lines.push(`${BOLD}EPSS Spikes:${RESET}`);
    for (const spike of report.epssSpikes.slice(0, 5)) {
      const scoreColor = spike.currentScore > 0.5 ? RED : YELLOW;
      lines.push(
        `  ${BOLD}${spike.cve}${RESET}  ${(spike.previousScore * 100).toFixed(1)}% → ` +
          `${scoreColor}${(spike.currentScore * 100).toFixed(1)}%${RESET} ` +
          `(+${spike.changePercent.toFixed(1)}%)`
      );
      if (spike.vendorProject || spike.product) {
        const context = [spike.vendorProject, spike.product].filter(Boolean).join(" — ");
        lines.push(`       ${DIM}${context}${RESET}`);
      }
      if (spike.shortDescription) {
        lines.push(`       ${DIM}${truncateText(spike.shortDescription, 56)}${RESET}`);
      }
    }
  }

  // Ransomware campaigns
  if (report.ransomwareCampaigns.length > 0) {
    lines.push("");
    lines.push(
      `${BOLD}Ransomware-Linked:${RESET} ${RED}${report.ransomwareCampaigns.length}${RESET} CVEs`
    );
  }
  lines.push("");

  // ─────────────────────────────────────────────────────────────────
  // Section 2b: VulnCheck Early Warning (entries not yet in CISA KEV)
  // ─────────────────────────────────────────────────────────────────
  if (report.vulnCheckKevDelta) {
    const vc = report.vulnCheckKevDelta;
    lines.push(`${BOLD}${MAGENTA}▌ VULNCHECK EARLY WARNING${RESET}`);
    lines.push(`${DIM}${"─".repeat(50)}${RESET}`);
    lines.push(
      `${DIM}VulnCheck KEV tracks ${BOLD}${vc.totalVulnCheckKev}${RESET}${DIM} exploited vulns ` +
        `(${BOLD}${vc.totalVulnCheckOnly}${RESET}${DIM} not yet in CISA's ${vc.totalCisaKev})${RESET}`
    );
    lines.push("");

    if (vc.vulncheckOnlyEntries.length === 0) {
      lines.push(`${GREEN}No new VulnCheck-only entries this period.${RESET}`);
    } else {
      lines.push(
        `${MAGENTA}${BOLD}${vc.vulncheckOnlyEntries.length}${RESET} new this period ` +
          `${DIM}(not in CISA KEV):${RESET}`
      );
      for (const entry of vc.vulncheckOnlyEntries.slice(0, 10)) {
        const vendor = entry.affectedProducts[0] || "Unknown";
        const ransomTag = entry.ransomwareAssociated ? ` ${RED}[RANSOMWARE]${RESET}` : "";
        const exploitTag = entry.exploitationStatus === "POC_AVAILABLE"
          ? ` ${YELLOW}[PoC]${RESET}`
          : "";
        lines.push(
          `  ${MAGENTA}VC${RESET}   ${BOLD}${entry.id}${RESET} ${vendor}${ransomTag}${exploitTag}`
        );
        lines.push(
          `       ${DIM}${truncateText(entry.title, 56)}${RESET}`
        );
      }
      if (vc.vulncheckOnlyEntries.length > 10) {
        lines.push(`${DIM}  ... and ${vc.vulncheckOnlyEntries.length - 10} more${RESET}`);
      }
    }
    lines.push("");
  }

  // ─────────────────────────────────────────────────────────────────
  // Section 3: Software Inventory (if customized)
  // ─────────────────────────────────────────────────────────────────
  if (report.inventoryStatus && report.inventoryStatus.length > 0) {
    lines.push(`${BOLD}${CYAN}▌ SOFTWARE INVENTORY STATUS${RESET}`);
    lines.push(`${DIM}${"─".repeat(50)}${RESET}`);

    const compliant = report.inventoryStatus.filter((s) => s.compliant);
    const nonCompliant = report.inventoryStatus.filter((s) => !s.compliant);

    if (nonCompliant.length > 0) {
      lines.push(`${RED}${BOLD}${nonCompliant.length} products require attention:${RESET}`);
      for (const item of nonCompliant.slice(0, 5)) {
        lines.push(
          `  ${RED}●${RESET} ${item.displayName} - Risk: ${item.riskLevel}`
        );
      }
    }

    if (compliant.length > 0) {
      lines.push(`${GREEN}${compliant.length} products compliant${RESET}`);
    }
    lines.push("");
  }

  // ─────────────────────────────────────────────────────────────────
  // Section 4: Industry Intelligence (if customized)
  // ─────────────────────────────────────────────────────────────────
  if (report.industryIntel && report.industryIntel.length > 0) {
    lines.push(`${BOLD}${CYAN}▌ INDUSTRY-RELEVANT THREATS${RESET}`);
    lines.push(`${DIM}${"─".repeat(50)}${RESET}`);

    for (const intel of report.industryIntel.slice(0, 3)) {
      lines.push(
        `${MAGENTA}●${RESET} ${BOLD}${intel.id}${RESET} - ${intel.affectedProducts.join(", ")}`
      );
    }
    if (report.industryIntel.length > 3) {
      lines.push(`${DIM}  ... and ${report.industryIntel.length - 3} more${RESET}`);
    }
    lines.push("");
  }

  // ─────────────────────────────────────────────────────────────────
  // Footer: Data Validation
  // ─────────────────────────────────────────────────────────────────
  lines.push(`${DIM}${"─".repeat(headerWidth)}${RESET}`);
  lines.push(`${DIM}Data Sources:${RESET}`);
  for (const validation of report.footer.dataValidation) {
    const status = validation.isCurrent ? `${GREEN}●${RESET}` : `${YELLOW}○${RESET}`;
    lines.push(
      `  ${status} ${validation.source.padEnd(12)} ${validation.timestamp}`
    );
  }
  lines.push(`${DIM}Report ID: ${report.footer.reportId}${RESET}`);
  lines.push(`${DIM}Generated: ${report.footer.generatedAt}${RESET}`);
  lines.push(`${DIM}${"─".repeat(headerWidth)}${RESET}`);

  return lines.join("\n");
}

// =============================================================================
// Markdown Format
// =============================================================================

function formatMarkdown(report: CTIReport): string {
  const lines: string[] = [];

  // Header
  lines.push(`# ${report.title}`);
  lines.push("");
  lines.push(`**TLP:** ${report.tlp.level}`);
  lines.push(`**Period:** ${report.periodStart} to ${report.periodEnd}`);
  if (report.preparedFor) {
    lines.push(`**Prepared For:** ${report.preparedFor}`);
  }
  lines.push("");

  // BLUF
  lines.push("## Bottom Line Up Front");
  lines.push("");
  const postureEmoji =
    report.bluf.threatPosture === "ELEVATED"
      ? "🔴"
      : report.bluf.threatPosture === "NORMAL"
        ? "🟡"
        : "🟢";
  lines.push(`**Threat Posture:** ${postureEmoji} ${report.bluf.threatPosture}`);
  lines.push(`> ${report.bluf.postureReason}`);
  lines.push("");
  lines.push("**Summary:**");
  lines.push(report.bluf.summary);
  lines.push("");

  if (report.bluf.actionItems.length > 0) {
    lines.push("**Action Items:**");
    for (const item of report.bluf.actionItems) {
      lines.push(`- ${item}`);
    }
    lines.push("");
  }

  // Active Exploitation — Priority Threats
  lines.push("## Active Exploitation — Priority Threats");
  lines.push("");
  if (report.criticalZeroDays.length === 0) {
    lines.push("_No priority threats identified in this period._");
  } else {
    const zeroDays = report.criticalZeroDays.filter((item) => item.isZeroDay);
    const otherThreats = report.criticalZeroDays.filter((item) => !item.isZeroDay);

    if (zeroDays.length > 0) {
      lines.push("### Zero-Day (no patch available)");
      lines.push("");
      lines.push("| CVE | Title | Priority | Ransomware | EPSS |");
      lines.push("|-----|-------|----------|------------|------|");
      for (const zd of zeroDays) {
        const epss = zd.epssScore ? `${(zd.epssScore * 100).toFixed(1)}%` : "-";
        const ransomware = zd.ransomwareAssociated ? "Yes" : "No";
        lines.push(
          `| ${zd.id} | ${zd.title.slice(0, 40)} | ${zd.priority} | ${ransomware} | ${epss} |`
        );
      }
      lines.push("");
    }

    if (otherThreats.length > 0) {
      lines.push("### Actively Exploited (patch available)");
      lines.push("");
      lines.push("| CVE | Title | Priority | CVE Year | Ransomware | EPSS |");
      lines.push("|-----|-------|----------|----------|------------|------|");
      for (const item of otherThreats.slice(0, 10)) {
        const epss = item.epssScore ? `${(item.epssScore * 100).toFixed(1)}%` : "-";
        const ransomware = item.ransomwareAssociated ? "Yes" : "No";
        const year = item.cveYear ? String(item.cveYear) : "-";
        lines.push(
          `| ${item.id} | ${item.title.slice(0, 40)} | ${item.priority} | ${year} | ${ransomware} | ${epss} |`
        );
      }
    }
  }
  lines.push("");

  // Exploitation Trends
  lines.push("## Exploitation Trends");
  lines.push("");
  lines.push(`**KEV Catalog:** ${report.kevDelta.totalCurrent} total (+${report.kevDelta.newEntries.length} this period)`);

  if (report.kevDelta.newEntries.length > 0) {
    lines.push("");
    lines.push("**New KEV Additions:**");
    lines.push("");
    lines.push("| CVE | Product | Description | Ransomware |");
    lines.push("|-----|---------|-------------|------------|");
    for (const entry of report.kevDelta.newEntries.slice(0, 8)) {
      const product = entry.affectedProducts[0] || "-";
      const desc = entry.title.length > 50 ? entry.title.slice(0, 47) + "..." : entry.title;
      const ransomware = entry.ransomwareAssociated ? "Yes" : "No";
      lines.push(`| ${entry.id} | ${product} | ${desc} | ${ransomware} |`);
    }
    if (report.kevDelta.newEntries.length > 8) {
      lines.push("");
      lines.push(`_... and ${report.kevDelta.newEntries.length - 8} more_`);
    }
  }

  if (report.epssSpikes.length > 0) {
    lines.push("");
    lines.push("**EPSS Score Spikes:**");
    lines.push("");
    lines.push("| CVE | Vendor / Product | Previous | Current | Change |");
    lines.push("|-----|-----------------|----------|---------|--------|");
    for (const spike of report.epssSpikes.slice(0, 5)) {
      const context = [spike.vendorProject, spike.product].filter(Boolean).join(" / ") || "-";
      lines.push(
        `| ${spike.cve} | ${context} | ${(spike.previousScore * 100).toFixed(1)}% | ${(spike.currentScore * 100).toFixed(1)}% | +${spike.changePercent.toFixed(1)}% |`
      );
    }
  }

  if (report.ransomwareCampaigns.length > 0) {
    lines.push("");
    lines.push(`**Ransomware-Linked CVEs:** ${report.ransomwareCampaigns.length}`);
  }
  lines.push("");

  // VulnCheck Early Warning
  if (report.vulnCheckKevDelta) {
    const vc = report.vulnCheckKevDelta;
    lines.push("## VulnCheck Early Warning");
    lines.push("");
    lines.push(`VulnCheck KEV tracks **${vc.totalVulnCheckKev}** exploited vulnerabilities (**${vc.totalVulnCheckOnly}** not yet in CISA's ${vc.totalCisaKev}).`);
    lines.push("");

    if (vc.vulncheckOnlyEntries.length > 0) {
      lines.push(`**${vc.vulncheckOnlyEntries.length} new this period** (not in CISA KEV):`);
      lines.push("");
      lines.push("| CVE | Product | Description | Ransomware | Exploit |");
      lines.push("|-----|---------|-------------|------------|---------|");
      for (const entry of vc.vulncheckOnlyEntries.slice(0, 15)) {
        const product = entry.affectedProducts[0] || "-";
        const desc = entry.title.length > 45 ? entry.title.slice(0, 42) + "..." : entry.title;
        const ransomware = entry.ransomwareAssociated ? "Yes" : "No";
        const exploit = entry.exploitationStatus === "POC_AVAILABLE" ? "PoC" : "Active";
        lines.push(`| ${entry.id} | ${product} | ${desc} | ${ransomware} | ${exploit} |`);
      }
      if (vc.vulncheckOnlyEntries.length > 15) {
        lines.push("");
        lines.push(`_... and ${vc.vulncheckOnlyEntries.length - 15} more_`);
      }
    } else {
      lines.push("_No new VulnCheck-only entries this period._");
    }
    lines.push("");
  }

  // Software Inventory (if provided)
  if (report.inventoryStatus && report.inventoryStatus.length > 0) {
    lines.push("## Software Inventory Status");
    lines.push("");
    lines.push("| Software | Status | Risk Level | New CVEs |");
    lines.push("|----------|--------|------------|----------|");
    for (const item of report.inventoryStatus) {
      const status = item.compliant ? "✅ Compliant" : "⚠️ Vulnerable";
      lines.push(
        `| ${item.displayName} | ${status} | ${item.riskLevel} | ${item.newCvesThisPeriod} |`
      );
    }
    lines.push("");
  }

  // Industry Intelligence (if provided)
  if (report.industryIntel && report.industryIntel.length > 0) {
    lines.push("## Industry-Relevant Threats");
    lines.push("");
    lines.push("| CVE | Affected Products | Priority |");
    lines.push("|-----|-------------------|----------|");
    for (const intel of report.industryIntel) {
      lines.push(
        `| ${intel.id} | ${intel.affectedProducts.join(", ")} | ${intel.priority} |`
      );
    }
    lines.push("");
  }

  // Footer
  lines.push("---");
  lines.push("");
  lines.push("### Data Validation");
  lines.push("");
  lines.push("| Source | Timestamp | Status |");
  lines.push("|--------|-----------|--------|");
  for (const v of report.footer.dataValidation) {
    const status = v.isCurrent ? "✅ Current" : "⚠️ Stale";
    lines.push(`| ${v.source} | ${v.timestamp} | ${status} |`);
  }
  lines.push("");
  lines.push(`**Report ID:** ${report.footer.reportId}`);
  lines.push(`**Generated:** ${report.footer.generatedAt}`);
  lines.push(`**Version:** ${report.footer.version}`);

  return lines.join("\n");
}

// =============================================================================
// JSON Format
// =============================================================================

function formatJson(report: CTIReport): string {
  return JSON.stringify(report, null, 2);
}

// =============================================================================
// Helpers
// =============================================================================

function getTlpColor(level: string): string {
  switch (level) {
    case "TLP:WHITE":
      return COLORS.BG_WHITE + COLORS.BOLD;
    case "TLP:GREEN":
      return COLORS.BG_GREEN + COLORS.BOLD;
    case "TLP:AMBER":
      return COLORS.BG_YELLOW + COLORS.BOLD;
    case "TLP:RED":
      return COLORS.BG_RED + COLORS.BOLD;
    default:
      return COLORS.RESET;
  }
}

function truncateText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + "...";
}

function wrapText(text: string, maxWidth: number): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let currentLine = "";

  for (const word of words) {
    if ((currentLine + " " + word).trim().length > maxWidth) {
      if (currentLine) lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = (currentLine + " " + word).trim();
    }
  }

  if (currentLine) lines.push(currentLine);
  return lines;
}
