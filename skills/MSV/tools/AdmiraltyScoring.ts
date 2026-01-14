/**
 * AdmiraltyScoring.ts - Admiralty Code (NATO System) Rating Calculator
 *
 * Source Reliability:
 *   A - Completely Reliable (Vendor Official / CISA)
 *   B - Usually Reliable (VulnCheck, commercial threat intel)
 *   C - Fairly Reliable (NVD, academic)
 *   D - Not Usually Reliable (Community reports)
 *   E - Unreliable (Unverified)
 *   F - Cannot Be Judged (New/unknown source)
 *
 * Information Credibility:
 *   1 - Confirmed (Multiple independent sources, vendor confirmed)
 *   2 - Probably True (Single authoritative source, vendor advisory)
 *   3 - Possibly True (Plausible, limited corroboration)
 *   4 - Doubtfully True (Inconsistent with known facts)
 *   5 - Improbable (Contradicts known facts)
 *   6 - Cannot Be Judged (No basis for evaluation)
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

// =============================================================================
// Types
// =============================================================================

export type SourceReliability = "A" | "B" | "C" | "D" | "E" | "F";
export type InfoCredibility = 1 | 2 | 3 | 4 | 5 | 6;

export interface AdmiraltyRating {
  rating: string; // e.g., "A1", "B2"
  reliability: SourceReliability;
  credibility: InfoCredibility;
  description: string;
}

export type EvidenceSourceType =
  | "CISA_KEV"
  | "VULNCHECK"
  | "EPSS"
  | "MSRC"
  | "NVD"
  | "COMMUNITY";

export interface EvidenceSource {
  source: EvidenceSourceType;
  hasData: boolean;
  exploitConfirmed?: boolean;
  pocAvailable?: boolean;
  epssScore?: number;
  cvssScore?: number;
  inKev?: boolean;
  isRansomware?: boolean;
}

// =============================================================================
// Constants
// =============================================================================

const RELIABILITY_LABELS: Record<SourceReliability, string> = {
  A: "Completely Reliable",
  B: "Usually Reliable",
  C: "Fairly Reliable",
  D: "Not Usually Reliable",
  E: "Unreliable",
  F: "Cannot Be Judged",
};

const CREDIBILITY_LABELS: Record<InfoCredibility, string> = {
  1: "Confirmed",
  2: "Probably True",
  3: "Possibly True",
  4: "Doubtfully True",
  5: "Improbable",
  6: "Cannot Be Judged",
};

// =============================================================================
// Scoring Algorithm
// =============================================================================

/**
 * Calculate Admiralty Code rating from evidence sources
 *
 * Priority order:
 * 1. CISA KEV (Active Exploitation) -> A1
 * 2. MSRC (Exploitation Detected) -> A2
 * 3. VulnCheck (PoC Verified) -> B2
 * 4. High EPSS (> 0.5) -> B3
 * 5. Critical CVSS (>= 9.0) -> C3
 * 6. High CVSS (>= 7.0) -> C4
 * 7. Default -> D5
 */
export function calculateAdmiraltyRating(
  evidence: EvidenceSource[]
): AdmiraltyRating {
  // Find evidence by source type
  const cisaKev = evidence.find((e) => e.source === "CISA_KEV" && e.hasData);
  const msrc = evidence.find((e) => e.source === "MSRC" && e.hasData);
  const vulncheck = evidence.find((e) => e.source === "VULNCHECK" && e.hasData);
  const epss = evidence.find((e) => e.source === "EPSS" && e.hasData);
  const nvd = evidence.find((e) => e.source === "NVD" && e.hasData);

  let reliability: SourceReliability = "F";
  let credibility: InfoCredibility = 6;
  let description = "No reliable evidence of exploitation";

  // A1: CISA KEV confirmed active exploitation
  if (cisaKev?.exploitConfirmed || cisaKev?.inKev) {
    reliability = "A";
    credibility = 1;
    description = "CISA KEV confirms active exploitation";

    // Escalate if ransomware
    if (cisaKev.isRansomware) {
      description += " (known ransomware campaign)";
    }
  }
  // A2: MSRC says "Exploitation Detected"
  else if (msrc?.exploitConfirmed) {
    reliability = "A";
    credibility = 2;
    description = "Microsoft confirms exploitation detected";
  }
  // B2: VulnCheck with PoC verified
  else if (vulncheck?.pocAvailable) {
    reliability = "B";
    credibility = 2;
    description = "VulnCheck verified PoC available";

    // Check if also in VulnCheck KEV
    if (vulncheck.inKev) {
      description += " (in VulnCheck KEV)";
    }
  }
  // B3: High EPSS score (> 0.5 = likely exploited)
  else if (epss?.epssScore && epss.epssScore > 0.5) {
    reliability = "B";
    credibility = 3;
    description = `High EPSS score (${(epss.epssScore * 100).toFixed(1)}% exploitation probability)`;
  }
  // C3: Critical CVSS (>= 9.0)
  else if (nvd?.cvssScore && nvd.cvssScore >= 9.0) {
    reliability = "C";
    credibility = 3;
    description = `Critical CVSS score (${nvd.cvssScore})`;
  }
  // C4: High CVSS (>= 7.0)
  else if (nvd?.cvssScore && nvd.cvssScore >= 7.0) {
    reliability = "C";
    credibility = 4;
    description = `High CVSS score (${nvd.cvssScore})`;
  }
  // B4: Moderate EPSS (> 0.1)
  else if (epss?.epssScore && epss.epssScore > 0.1) {
    reliability = "B";
    credibility = 4;
    description = `Elevated EPSS score (${(epss.epssScore * 100).toFixed(1)}%)`;
  }
  // D5: Low confidence - some data but not concerning
  else if (evidence.some((e) => e.hasData)) {
    reliability = "D";
    credibility = 5;
    description = "Limited evidence of exploitation risk";
  }

  return {
    rating: `${reliability}${credibility}`,
    reliability,
    credibility,
    description,
  };
}

/**
 * Get human-readable label for a rating
 */
export function getRatingLabel(rating: AdmiraltyRating): string {
  return `${RELIABILITY_LABELS[rating.reliability]}, ${CREDIBILITY_LABELS[rating.credibility]}`;
}

/**
 * Check if rating indicates high priority for patching
 */
export function isHighPriority(rating: AdmiraltyRating): boolean {
  // A1, A2, B1, B2 are high priority
  return (
    (rating.reliability === "A" && rating.credibility <= 2) ||
    (rating.reliability === "B" && rating.credibility <= 2)
  );
}

/**
 * Check if rating indicates active exploitation
 */
export function isActivelyExploited(rating: AdmiraltyRating): boolean {
  return rating.reliability === "A" && rating.credibility === 1;
}

/**
 * Compare two ratings (for sorting)
 * Lower is more severe (A1 < B2 < C3, etc.)
 */
export function compareRatings(a: AdmiraltyRating, b: AdmiraltyRating): number {
  const reliabilityOrder = "ABCDEF";
  const aReliability = reliabilityOrder.indexOf(a.reliability);
  const bReliability = reliabilityOrder.indexOf(b.reliability);

  if (aReliability !== bReliability) {
    return aReliability - bReliability;
  }

  return a.credibility - b.credibility;
}

/**
 * Get color code for terminal output based on rating
 */
export function getRatingColor(rating: AdmiraltyRating): string {
  if (rating.reliability === "A" && rating.credibility <= 2) {
    return "\x1b[31m"; // Red - Critical
  }
  if (rating.reliability === "B" && rating.credibility <= 3) {
    return "\x1b[33m"; // Yellow - Warning
  }
  if (rating.reliability <= "C" && rating.credibility <= 4) {
    return "\x1b[36m"; // Cyan - Info
  }
  return "\x1b[32m"; // Green - Low concern
}

export const RESET_COLOR = "\x1b[0m";

// =============================================================================
// MSV-Specific Rating
// =============================================================================

export type MsvDataSource = "vendor_advisory" | "nvd" | "cisa_kev" | "vulncheck" | "appthreat" | "none";

export interface MsvRatingInput {
  dataSources: MsvDataSource[];
  hasVendorAdvisory: boolean;
  hasCveData: boolean;
  cveCount: number;
  msvDetermined: boolean;
}

/**
 * Calculate Admiralty rating for MSV determination
 *
 * Rating logic for MSV:
 * - A1: Vendor advisory confirms MSV, corroborated by NVD/KEV
 * - A2: Vendor advisory alone confirms MSV
 * - B2: NVD data with clear version ranges
 * - C3: Partial data, MSV estimated
 * - F6: No data found (cannot determine MSV)
 */
export function calculateMsvRating(input: MsvRatingInput): AdmiraltyRating {
  let reliability: SourceReliability;
  let credibility: InfoCredibility;
  let description: string;

  // No data at all = Cannot be judged
  if (!input.hasCveData && input.cveCount === 0 && !input.hasVendorAdvisory && !input.msvDetermined) {
    return {
      rating: "F6",
      reliability: "F",
      credibility: 6,
      description: "No vulnerability data found - MSV cannot be determined",
    };
  }

  // Vendor advisory is most reliable
  if (input.hasVendorAdvisory && input.msvDetermined) {
    if (input.dataSources.includes("nvd") || input.dataSources.includes("cisa_kev")) {
      // Corroborated
      reliability = "A";
      credibility = 1;
      description = "Vendor advisory confirmed, corroborated by external sources";
    } else {
      // Vendor only
      reliability = "A";
      credibility = 2;
      description = "Vendor advisory confirms MSV";
    }
  }
  // AppThreat data (aggregated sources: NVD + OSV + GitHub)
  else if (input.dataSources.includes("appthreat") && input.msvDetermined) {
    reliability = "B";
    credibility = 2;
    description = "MSV determined from AppThreat multi-source database";
  }
  // NVD data with version info
  else if (input.dataSources.includes("nvd") && input.msvDetermined) {
    reliability = "B";
    credibility = 2;
    description = "MSV determined from NVD version data";
  }
  // KEV data (exploitation confirmed but may not have version)
  else if (input.dataSources.includes("cisa_kev")) {
    if (input.msvDetermined) {
      reliability = "B";
      credibility = 3;
      description = "MSV estimated from KEV and version data";
    } else {
      reliability = "C";
      credibility = 4;
      description = "Active exploitation confirmed but MSV unclear";
    }
  }
  // Some CVE data but incomplete
  else if (input.hasCveData) {
    reliability = "C";
    credibility = 4;
    description = "Partial CVE data - MSV may be incomplete";
  }
  // Fallback
  else {
    reliability = "D";
    credibility = 5;
    description = "Limited data - MSV confidence low";
  }

  return {
    rating: `${reliability}${credibility}`,
    reliability,
    credibility,
    description,
  };
}
