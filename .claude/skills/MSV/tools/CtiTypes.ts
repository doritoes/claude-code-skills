/**
 * CtiTypes.ts - Cyber Threat Intelligence Report Type Definitions
 *
 * Defines interfaces for CTI report generation, user profiles,
 * and intelligence aggregation.
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

// =============================================================================
// Traffic Light Protocol (TLP)
// =============================================================================

/**
 * TLP marking levels per FIRST TLP 2.0 specification
 * @see https://www.first.org/tlp/
 */
export type TLPLevel = "TLP:WHITE" | "TLP:GREEN" | "TLP:AMBER" | "TLP:RED";

/**
 * TLP marking with justification
 */
export interface TLPMarking {
  level: TLPLevel;
  reason: string;
}

// =============================================================================
// User Profile (Optional Customization)
// =============================================================================

/**
 * Organization profile for customized CTI reports
 */
export interface CTIUserProfile {
  /** Company/organization name */
  companyName?: string;
  /** Industry sector (e.g., "Financial Services", "Healthcare") */
  industry?: string;
  /** Employee count - affects threat relevance */
  employeeCount?: number;
  /** Geographic region (e.g., "North America", "EMEA") */
  region?: string;
  /** Software IDs from MSV catalog */
  softwareInventory?: string[];
  /** Focus areas (e.g., "endpoint", "network", "cloud") */
  focusAreas?: string[];
  /** Compliance frameworks (e.g., "PCI-DSS", "HIPAA") */
  complianceFrameworks?: string[];
}

// =============================================================================
// Intelligence Items
// =============================================================================

/**
 * Threat posture assessment
 */
export type ThreatPosture = "ELEVATED" | "NORMAL" | "REDUCED";

/**
 * Priority level for intelligence items
 */
export type IntelPriority = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO";

/**
 * Individual intelligence item (e.g., a new KEV entry, EPSS spike)
 */
export interface IntelItem {
  /** Unique identifier (e.g., CVE-2024-1234) */
  id: string;
  /** Brief title */
  title: string;
  /** Detailed description */
  description: string;
  /** Priority/severity */
  priority: IntelPriority;
  /** Date added/discovered */
  dateAdded: string;
  /** Affected products (from MSV catalog) */
  affectedProducts: string[];
  /** Source of intelligence */
  source: "KEV" | "NVD" | "EPSS" | "VULNCHECK" | "VENDOR";
  /** Exploitation status */
  exploitationStatus?: "ACTIVE" | "POC_AVAILABLE" | "THEORETICAL" | "UNKNOWN";
  /** Ransomware association */
  ransomwareAssociated?: boolean;
  /** Industry relevance (if profile provided) */
  industryRelevance?: string[];
  /** EPSS score (0-1) */
  epssScore?: number;
  /** EPSS change from previous period */
  epssChange?: number;
  /** CVSS score (0-10) */
  cvssScore?: number;
  /** Remediation guidance */
  remediation?: string;
}

/**
 * KEV catalog delta (new entries since last period)
 */
export interface KevDelta {
  newEntries: IntelItem[];
  totalCurrent: number;
  totalPrevious: number;
  periodStart: string;
  periodEnd: string;
}

/**
 * EPSS spike detection
 */
export interface EpssSpike {
  cve: string;
  currentScore: number;
  previousScore: number;
  changePercent: number;
  daysSinceSpike: number;
}

/**
 * Software inventory compliance status
 */
export interface InventoryStatus {
  software: string;
  displayName: string;
  currentVersion?: string;
  msv: string | null;
  compliant: boolean;
  newCvesThisPeriod: number;
  riskScore: number;
  riskLevel: string;
}

// =============================================================================
// Report Structure
// =============================================================================

/**
 * BLUF (Bottom Line Up Front) section
 */
export interface BLUFSection {
  /** 2-3 sentence executive summary */
  summary: string;
  /** Critical action items */
  actionItems: string[];
  /** Overall threat posture */
  threatPosture: ThreatPosture;
  /** Posture justification */
  postureReason: string;
}

/**
 * Data source validation timestamps
 */
export interface DataValidation {
  /** Source name */
  source: string;
  /** Timestamp of data */
  timestamp: string;
  /** Whether data is current (< 24h) */
  isCurrent: boolean;
}

/**
 * Report metadata footer
 */
export interface ReportFooter {
  /** Data source validations */
  dataValidation: DataValidation[];
  /** Unique report identifier */
  reportId: string;
  /** Report generation timestamp */
  generatedAt: string;
  /** Report version */
  version: string;
}

/**
 * Complete CTI Report structure
 */
export interface CTIReport {
  // Header
  tlp: TLPMarking;
  title: string;
  periodStart: string;
  periodEnd: string;
  preparedFor?: string;

  // BLUF Section
  bluf: BLUFSection;

  // Section 1: Critical Zero-Days
  criticalZeroDays: IntelItem[];

  // Section 2: Exploitation Trends
  kevDelta: KevDelta;
  epssSpikes: EpssSpike[];
  ransomwareCampaigns: IntelItem[];

  // Section 3: Software Inventory (if profile provided)
  inventoryStatus?: InventoryStatus[];

  // Section 4: Industry Intelligence (if profile provided)
  industryIntel?: IntelItem[];

  // Footer
  footer: ReportFooter;

  // Metadata
  isCustomized: boolean;
  hasSpecificThreats: boolean;
  profile?: CTIUserProfile;
}

// =============================================================================
// Report Generation Options
// =============================================================================

/**
 * Report period options
 */
export type ReportPeriod = "day" | "week" | "month";

/**
 * Report output format
 */
export type CTIOutputFormat = "text" | "markdown" | "json";

/**
 * Report generation options
 */
export interface CTIReportOptions {
  /** Report period (day, week, month) */
  period: ReportPeriod;
  /** Output format */
  format: CTIOutputFormat;
  /** User profile (optional) */
  profile?: CTIUserProfile;
  /** Force refresh data sources */
  forceRefresh?: boolean;
  /** Output file path (optional) */
  outputPath?: string;
  /** Verbose logging */
  verbose?: boolean;
}

// =============================================================================
// Industry Mappings
// =============================================================================

/**
 * Industry to commonly-targeted software mapping
 */
export interface IndustryMapping {
  industry: string;
  commonSoftware: string[];
  commonThreats: string[];
  regulatoryFrameworks: string[];
}

/**
 * Industry mappings catalog
 */
export interface IndustryMappingsCatalog {
  _metadata: {
    version: string;
    lastUpdated: string;
  };
  industries: IndustryMapping[];
}
