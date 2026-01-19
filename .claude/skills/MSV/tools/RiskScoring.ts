/**
 * RiskScoring.ts - Aggregate Risk Score Calculator
 *
 * Provides a single metric (0-100) to prioritize remediation efforts.
 * Combines KEV status, EPSS probability, CVE count/severity, and data quality.
 *
 * Score Breakdown:
 * - KEV Component: 40 pts max (active exploitation is highest priority)
 * - EPSS Component: 30 pts max (exploitation probability)
 * - CVE Component: 20 pts max (count + severity)
 * - UNDETERMINED Penalty: +10 pts (uncertainty increases risk)
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

// =============================================================================
// Types
// =============================================================================

export interface RiskScoreInput {
  hasKevCves: boolean;           // Any CVEs in CISA KEV
  kevCveCount: number;           // Number of KEV CVEs
  maxEpssScore: number;          // Highest EPSS score (0-1)
  avgEpssScore: number;          // Average EPSS score (0-1)
  cveCount: number;              // Total CVE count
  maxCvssScore: number;          // Highest CVSS score (0-10)
  avgCvssScore: number;          // Average CVSS score (0-10)
  msvDetermined: boolean;        // Whether MSV could be determined
  hasPoCExploits: boolean;       // Any public PoC exploits
  dataAge: number;               // Hours since last data refresh
}

export interface RiskScore {
  score: number;                 // 0-100 aggregate score
  level: RiskLevel;              // Human-readable level
  breakdown: RiskBreakdown;      // Component scores
  recommendation: string;        // Action recommendation
}

export interface RiskBreakdown {
  kevComponent: number;          // 0-40
  epssComponent: number;         // 0-30
  cveComponent: number;          // 0-20
  uncertaintyPenalty: number;    // 0-10
}

export type RiskLevel = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO";

// =============================================================================
// Constants
// =============================================================================

const WEIGHTS = {
  KEV_MAX: 40,          // Maximum points from KEV status
  EPSS_MAX: 30,         // Maximum points from EPSS scores
  CVE_MAX: 20,          // Maximum points from CVE count/severity
  UNCERTAINTY_MAX: 10,  // Maximum uncertainty penalty
} as const;

const LEVEL_THRESHOLDS = {
  CRITICAL: 80,
  HIGH: 60,
  MEDIUM: 40,
  LOW: 20,
} as const;

// =============================================================================
// Risk Score Calculation
// =============================================================================

/**
 * Calculate aggregate risk score from vulnerability data
 */
export function calculateRiskScore(input: RiskScoreInput): RiskScore {
  const breakdown = calculateBreakdown(input);
  const score = Math.min(100, Math.round(
    breakdown.kevComponent +
    breakdown.epssComponent +
    breakdown.cveComponent +
    breakdown.uncertaintyPenalty
  ));

  const level = scoreToLevel(score);
  const recommendation = generateRecommendation(score, level, input);

  return {
    score,
    level,
    breakdown,
    recommendation,
  };
}

/**
 * Calculate individual component scores
 */
function calculateBreakdown(input: RiskScoreInput): RiskBreakdown {
  // KEV Component: 40 pts max
  // - Base 30 pts if any KEV CVE exists
  // - +2 pts per additional KEV CVE (up to 10 more)
  let kevComponent = 0;
  if (input.hasKevCves) {
    kevComponent = 30 + Math.min(10, (input.kevCveCount - 1) * 2);
  }

  // EPSS Component: 30 pts max
  // - Based on max EPSS score (weighted 70%)
  // - Plus average EPSS score (weighted 30%)
  // - PoC availability adds 5 pts
  let epssComponent = 0;
  if (input.maxEpssScore > 0) {
    epssComponent = Math.round(
      (input.maxEpssScore * 0.7 + input.avgEpssScore * 0.3) * 25
    );
    if (input.hasPoCExploits) {
      epssComponent = Math.min(WEIGHTS.EPSS_MAX, epssComponent + 5);
    }
  }

  // CVE Component: 20 pts max
  // - Count contribution: log scale (0-10 pts)
  //   1 CVE = 2 pts, 5 CVEs = 5 pts, 20 CVEs = 8 pts, 50+ CVEs = 10 pts
  // - Severity contribution: based on max CVSS (0-10 pts)
  let cveComponent = 0;
  if (input.cveCount > 0) {
    // Log scale for count (caps at ~10 pts for 50+ CVEs)
    const countScore = Math.min(10, Math.round(Math.log2(input.cveCount + 1) * 2.5));

    // Max CVSS contribution (0-10 scale maps directly)
    const severityScore = Math.round(input.maxCvssScore);

    cveComponent = Math.min(WEIGHTS.CVE_MAX, countScore + severityScore);
  }

  // Uncertainty Penalty: 10 pts max
  // - +7 pts if MSV could not be determined (unknown risk)
  // - +3 pts if data is stale (>7 days)
  let uncertaintyPenalty = 0;
  if (!input.msvDetermined && input.cveCount > 0) {
    // MSV undetermined despite having CVEs = significant uncertainty
    uncertaintyPenalty += 7;
  }
  if (input.dataAge > 168) { // 7 days
    uncertaintyPenalty += 3;
  }

  return {
    kevComponent: Math.min(WEIGHTS.KEV_MAX, kevComponent),
    epssComponent: Math.min(WEIGHTS.EPSS_MAX, epssComponent),
    cveComponent: Math.min(WEIGHTS.CVE_MAX, cveComponent),
    uncertaintyPenalty: Math.min(WEIGHTS.UNCERTAINTY_MAX, uncertaintyPenalty),
  };
}

/**
 * Convert numeric score to risk level
 */
function scoreToLevel(score: number): RiskLevel {
  if (score >= LEVEL_THRESHOLDS.CRITICAL) return "CRITICAL";
  if (score >= LEVEL_THRESHOLDS.HIGH) return "HIGH";
  if (score >= LEVEL_THRESHOLDS.MEDIUM) return "MEDIUM";
  if (score >= LEVEL_THRESHOLDS.LOW) return "LOW";
  return "INFO";
}

/**
 * Generate action recommendation based on score and components
 */
function generateRecommendation(
  score: number,
  level: RiskLevel,
  input: RiskScoreInput
): string {
  if (input.hasKevCves) {
    return "IMMEDIATE: Actively exploited vulnerabilities require emergency patching within 24-48 hours.";
  }

  switch (level) {
    case "CRITICAL":
      return "URGENT: High exploitation probability. Patch within 7 days or implement compensating controls.";
    case "HIGH":
      return "PRIORITY: Significant risk. Include in next patch cycle and monitor for active exploitation.";
    case "MEDIUM":
      return "SCHEDULED: Moderate risk. Plan remediation within standard patch cycle (30 days).";
    case "LOW":
      return "ROUTINE: Lower priority. Address during regular maintenance windows.";
    case "INFO":
      return "MONITOR: Minimal current risk. Continue monitoring for new vulnerability disclosures.";
  }
}

// =============================================================================
// Formatting
// =============================================================================

/**
 * Get ANSI color for risk level
 */
export function getRiskLevelColor(level: RiskLevel): string {
  const colors: Record<RiskLevel, string> = {
    CRITICAL: "\x1b[31m", // Red
    HIGH: "\x1b[33m",     // Yellow
    MEDIUM: "\x1b[35m",   // Magenta
    LOW: "\x1b[36m",      // Cyan
    INFO: "\x1b[32m",     // Green
  };
  return colors[level];
}

/**
 * Format risk score for terminal display
 */
export function formatRiskScore(riskScore: RiskScore): string {
  const color = getRiskLevelColor(riskScore.level);
  const RESET = "\x1b[0m";
  const BOLD = "\x1b[1m";
  const DIM = "\x1b[2m";

  const { breakdown } = riskScore;

  // Build score bar visualization
  const barWidth = 20;
  const filledWidth = Math.round((riskScore.score / 100) * barWidth);
  const scoreBar = `[${"█".repeat(filledWidth)}${"░".repeat(barWidth - filledWidth)}]`;

  const lines = [
    `${BOLD}Risk Score:${RESET} ${color}${riskScore.score}/100 ${riskScore.level}${RESET} ${scoreBar}`,
    `${DIM}Breakdown: KEV:${breakdown.kevComponent} EPSS:${breakdown.epssComponent} CVE:${breakdown.cveComponent} Unc:${breakdown.uncertaintyPenalty}${RESET}`,
    `${color}${riskScore.recommendation}${RESET}`,
  ];

  return lines.join("\n");
}

/**
 * Format risk score as JSON-friendly object
 */
export function riskScoreToJson(riskScore: RiskScore): object {
  return {
    score: riskScore.score,
    level: riskScore.level,
    breakdown: riskScore.breakdown,
    recommendation: riskScore.recommendation,
  };
}
