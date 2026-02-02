/**
 * CtiReportGenerator.ts - CTI Report Generation Engine
 *
 * Generates operational cyber threat intelligence reports with:
 * - TLP marking (WHITE/GREEN/AMBER based on content)
 * - BLUF (Bottom Line Up Front) executive summary
 * - Critical zero-days and exploitation trends
 * - Optional organization customization
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { IntelligenceAggregator } from "./IntelligenceAggregator";
import type {
  CTIReport,
  CTIUserProfile,
  CTIReportOptions,
  TLPMarking,
  TLPLevel,
  BLUFSection,
  ThreatPosture,
  ReportFooter,
  IntelItem,
  ReportPeriod,
} from "./CtiTypes";

// =============================================================================
// Constants
// =============================================================================

const REPORT_VERSION = "1.0.0";

// =============================================================================
// CTI Report Generator
// =============================================================================

export class CtiReportGenerator {
  private dataDir: string;
  private aggregator: IntelligenceAggregator;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.aggregator = new IntelligenceAggregator(dataDir);
  }

  /**
   * Generate a complete CTI report
   */
  async generateReport(options: CTIReportOptions): Promise<CTIReport> {
    const { period, profile, forceRefresh } = options;

    // Calculate period parameters
    const periodDays = this.getPeriodDays(period);
    const periodStart = new Date();
    periodStart.setDate(periodStart.getDate() - periodDays);

    // Gather intelligence data
    const [kevDelta, criticalZeroDays, ransomwareCampaigns, epssSpikes, dataValidation] =
      await Promise.all([
        this.aggregator.getKevDelta(periodDays),
        this.aggregator.getCriticalZeroDays(periodDays),
        this.aggregator.getRansomwareCampaigns(periodDays),
        this.aggregator.detectEpssSpikes(0.1, 7),
        this.aggregator.getDataValidation(),
      ]);

    // Get profile-specific data if provided
    let inventoryStatus;
    let industryIntel;

    if (profile) {
      if (profile.softwareInventory && profile.softwareInventory.length > 0) {
        inventoryStatus = await this.aggregator.getInventoryStatus(
          profile.softwareInventory,
          profile
        );
      }

      if (profile.industry) {
        industryIntel = await this.aggregator.getIndustryIntel(profile.industry, periodDays);
      }
    }

    // Determine TLP marking
    const tlp = this.determineTlpMarking(profile, criticalZeroDays, inventoryStatus, industryIntel);

    // Generate BLUF
    const bluf = this.generateBluf(
      kevDelta,
      criticalZeroDays,
      ransomwareCampaigns,
      epssSpikes,
      inventoryStatus,
      profile
    );

    // Generate footer
    const footer = this.generateFooter(dataValidation);

    // Determine if report has specific threats
    const hasSpecificThreats =
      profile &&
      ((inventoryStatus && inventoryStatus.some((s) => !s.compliant)) ||
        (industryIntel && industryIntel.length > 0));

    // Assemble report
    const report: CTIReport = {
      tlp,
      title: this.generateTitle(period, profile),
      periodStart: periodStart.toISOString().split("T")[0],
      periodEnd: new Date().toISOString().split("T")[0],
      preparedFor: profile?.companyName,

      bluf,

      criticalZeroDays,
      kevDelta,
      epssSpikes,
      ransomwareCampaigns,

      inventoryStatus,
      industryIntel,

      footer,

      isCustomized: !!profile,
      hasSpecificThreats: !!hasSpecificThreats,
      profile,
    };

    return report;
  }

  /**
   * Load user profile from file
   */
  loadProfile(profilePath: string): CTIUserProfile | null {
    if (!existsSync(profilePath)) {
      return null;
    }

    try {
      return JSON.parse(readFileSync(profilePath, "utf-8"));
    } catch {
      return null;
    }
  }

  /**
   * Create profile from CLI options
   */
  createProfileFromOptions(options: {
    company?: string;
    industry?: string;
    inventory?: string;
    size?: string;
    region?: string;
  }): CTIUserProfile | undefined {
    if (!options.company && !options.industry && !options.inventory) {
      return undefined;
    }

    return {
      companyName: options.company,
      industry: options.industry,
      softwareInventory: options.inventory?.split(",").map((s) => s.trim()),
      employeeCount: options.size ? parseInt(options.size, 10) : undefined,
      region: options.region,
    };
  }

  // ===========================================================================
  // TLP Marking
  // ===========================================================================

  private determineTlpMarking(
    profile?: CTIUserProfile,
    criticalZeroDays?: IntelItem[],
    inventoryStatus?: { compliant: boolean }[],
    industryIntel?: IntelItem[]
  ): TLPMarking {
    // No profile = general landscape = TLP:WHITE
    if (!profile) {
      return {
        level: "TLP:WHITE",
        reason: "General threat landscape report, not customized to organization",
      };
    }

    // Check for specific threats to company
    const hasInventoryThreats = inventoryStatus?.some((s) => !s.compliant);
    const hasCriticalIndustryThreats =
      industryIntel && industryIntel.some((i) => i.priority === "CRITICAL");

    // Specific threats = TLP:AMBER
    if (hasInventoryThreats || hasCriticalIndustryThreats) {
      const reasons: string[] = [];
      if (hasInventoryThreats) {
        reasons.push("vulnerabilities affecting organization's software inventory");
      }
      if (hasCriticalIndustryThreats) {
        reasons.push("critical threats targeting organization's industry");
      }
      return {
        level: "TLP:AMBER",
        reason: `Contains specific threat information: ${reasons.join(", ")}`,
      };
    }

    // Customized but no specific threats = TLP:GREEN
    return {
      level: "TLP:GREEN",
      reason: "Customized for organization, no specific threats identified",
    };
  }

  // ===========================================================================
  // BLUF Generation
  // ===========================================================================

  private generateBluf(
    kevDelta: { newEntries: IntelItem[]; totalCurrent: number },
    criticalZeroDays: IntelItem[],
    ransomwareCampaigns: IntelItem[],
    epssSpikes: { cve: string; changePercent: number }[],
    inventoryStatus?: { compliant: boolean; software: string }[],
    profile?: CTIUserProfile
  ): BLUFSection {
    const actionItems: string[] = [];
    const summaryParts: string[] = [];

    // KEV additions summary
    if (kevDelta.newEntries.length > 0) {
      summaryParts.push(
        `${kevDelta.newEntries.length} new vulnerabilities added to CISA KEV catalog`
      );
    }

    // Critical zero-days
    if (criticalZeroDays.length > 0) {
      const critical = criticalZeroDays.filter((z) => z.priority === "CRITICAL");
      if (critical.length > 0) {
        summaryParts.push(`${critical.length} critical zero-days with active exploitation`);
        // Format action items with product context
        for (const item of critical.slice(0, 3)) {
          const products = item.affectedProducts.length > 0
            ? item.affectedProducts.slice(0, 2).join(", ")
            : "affected systems";
          const shortDesc = item.title.length > 60
            ? item.title.slice(0, 60) + "..."
            : item.title;

          // Determine if this is a zero-day (no patch) vs patchable
          const remediation = item.remediation?.toLowerCase() || "";
          const isZeroDay = remediation.includes("mitigat") ||
                           remediation.includes("discontinue") ||
                           remediation.includes("no patch") ||
                           remediation.includes("workaround");

          if (isZeroDay) {
            // Zero-day: recommend mitigation, include guidance
            const shortRemediation = item.remediation && item.remediation.length > 80
              ? item.remediation.slice(0, 80) + "..."
              : item.remediation || "Apply vendor mitigations or disable service";
            actionItems.push(
              `IMMEDIATE: ZERO-DAY - ${products} - ${item.id}: ${shortRemediation}`
            );
          } else {
            // Patchable: recommend patching
            actionItems.push(
              `IMMEDIATE: Patch ${products} - ${item.id} (${shortDesc})`
            );
          }
        }
      }
    }

    // Ransomware associations
    if (ransomwareCampaigns.length > 0) {
      summaryParts.push(`${ransomwareCampaigns.length} vulnerabilities linked to ransomware campaigns`);
      // List top ransomware-linked items with product context
      for (const item of ransomwareCampaigns.slice(0, 2)) {
        const products = item.affectedProducts.length > 0
          ? item.affectedProducts.slice(0, 2).join(", ")
          : "affected systems";

        // Check if zero-day
        const remediation = item.remediation?.toLowerCase() || "";
        const isZeroDay = remediation.includes("mitigat") ||
                         remediation.includes("discontinue") ||
                         remediation.includes("no patch");

        if (isZeroDay) {
          actionItems.push(
            `PRIORITY: RANSOMWARE ZERO-DAY - ${products} - ${item.id}: Apply mitigations or isolate`
          );
        } else {
          actionItems.push(
            `PRIORITY: Patch ${products} - ${item.id} (ransomware-linked)`
          );
        }
      }
    }

    // EPSS spikes
    if (epssSpikes.length > 0) {
      const significantSpikes = epssSpikes.filter((s) => s.changePercent > 20);
      if (significantSpikes.length > 0) {
        summaryParts.push(
          `${significantSpikes.length} CVEs with significant exploitation probability increases`
        );
      }
    }

    // Inventory-specific findings
    if (inventoryStatus && profile?.companyName) {
      const nonCompliant = inventoryStatus.filter((s) => !s.compliant);
      if (nonCompliant.length > 0) {
        summaryParts.push(
          `${nonCompliant.length} software products in ${profile.companyName}'s inventory have known vulnerabilities`
        );
        actionItems.push(
          `URGENT: Update ${nonCompliant.map((s) => s.software).slice(0, 3).join(", ")}`
        );
      }
    }

    // Determine threat posture
    const posture = this.calculateThreatPosture(
      kevDelta.newEntries.length,
      criticalZeroDays.length,
      ransomwareCampaigns.length,
      epssSpikes.length
    );

    // Build summary
    const summary =
      summaryParts.length > 0
        ? summaryParts.join(". ") + "."
        : "No significant new threat activity observed in this reporting period.";

    // Add default action if none
    if (actionItems.length === 0) {
      actionItems.push("ROUTINE: Continue regular vulnerability management processes");
    }

    return {
      summary,
      actionItems,
      threatPosture: posture.level,
      postureReason: posture.reason,
    };
  }

  private calculateThreatPosture(
    kevCount: number,
    criticalCount: number,
    ransomwareCount: number,
    spikeCount: number
  ): { level: ThreatPosture; reason: string } {
    // Calculate threat score
    const score = kevCount * 2 + criticalCount * 5 + ransomwareCount * 10 + spikeCount;

    if (score >= 30 || ransomwareCount >= 2 || criticalCount >= 3) {
      return {
        level: "ELEVATED",
        reason: "Significant threat activity detected, heightened vigilance recommended",
      };
    }

    if (score >= 10 || kevCount >= 5) {
      return {
        level: "NORMAL",
        reason: "Typical threat activity levels, maintain standard security posture",
      };
    }

    return {
      level: "REDUCED",
      reason: "Below-average threat activity, favorable conditions for planned maintenance",
    };
  }

  // ===========================================================================
  // Report Metadata
  // ===========================================================================

  private generateTitle(period: ReportPeriod, profile?: CTIUserProfile): string {
    const periodLabel =
      period === "day" ? "Daily" : period === "week" ? "Weekly" : "Monthly";
    return `${periodLabel} Cyber Threat Intelligence Report`;
  }

  private generateFooter(
    dataValidation: { source: string; timestamp: string; isCurrent: boolean }[]
  ): ReportFooter {
    return {
      dataValidation,
      reportId: this.generateReportId(),
      generatedAt: new Date().toISOString(),
      version: REPORT_VERSION,
    };
  }

  private generateReportId(): string {
    const date = new Date().toISOString().split("T")[0].replace(/-/g, "");
    const seq = String(Math.floor(Math.random() * 999) + 1).padStart(3, "0");
    return `CTI-${date}-${seq}`;
  }

  private getPeriodDays(period: ReportPeriod): number {
    switch (period) {
      case "day":
        return 1;
      case "week":
        return 7;
      case "month":
        return 30;
      default:
        return 7;
    }
  }
}
