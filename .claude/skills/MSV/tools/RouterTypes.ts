/**
 * RouterTypes.ts - Type definitions for router firmware tracking
 *
 * Supports the hierarchical structure:
 * Vendor → Family → Model → Hardware Version → Firmware Branch
 */

// =============================================================================
// Enums
// =============================================================================

/** Router support status */
export type SupportStatus =
  | "supported" // Active firmware updates
  | "security-only" // Only critical security patches
  | "eol" // End of life, no updates
  | "never-supported" // OEM/white-label, no vendor support
  | "unknown"; // Cannot determine status

/** Vendor trust rating based on security practices */
export type TrustRating =
  | "high" // Bug bounty + fast response + CNA
  | "medium-high" // Bug bounty OR CNA + regular patches
  | "medium" // Publishes advisories, patches issues
  | "low" // Slow/no response, minimal transparency
  | "unknown"; // Insufficient information

/** Router category */
export type RouterCategory =
  | "wifi-router" // Standard wireless router
  | "mesh" // Mesh WiFi system
  | "range-extender" // WiFi range extender
  | "access-point" // Standalone access point
  | "modem-router" // Combined modem + router (gateway)
  | "travel-router" // Portable travel router
  | "gaming-router" // Gaming-focused router
  | "business-router" // Small business router
  | "isp-gateway"; // ISP-branded gateway (Xfinity, Verizon, AT&T)

/** Target market */
export type TargetMarket =
  | "consumer" // Home users
  | "prosumer" // Advanced home users
  | "soho" // Small office/home office
  | "smb" // Small-medium business
  | "enterprise"; // Enterprise (usually out of scope)

/** WiFi standard */
export type WifiStandard =
  | "b" // 802.11b
  | "g" // 802.11g
  | "n150" // 802.11n 150Mbps
  | "n300" // 802.11n 300Mbps
  | "n450" // 802.11n 450Mbps
  | "n600" // 802.11n 600Mbps
  | "ac1200" // 802.11ac AC1200
  | "ac1750" // 802.11ac AC1750
  | "ac1900" // 802.11ac AC1900
  | "ac2600" // 802.11ac AC2600
  | "ac1600" // 802.11ac AC1600
  | "ac3000" // 802.11ac AC3000
  | "ac5300" // 802.11ac AC5300
  | "ax1500" // 802.11ax AX1500 (WiFi 6)
  | "ax1800" // 802.11ax AX1800 (WiFi 6)
  | "ax3000" // 802.11ax AX3000
  | "ax4200" // 802.11ax AX4200 (WiFi 6E)
  | "ax5400" // 802.11ax AX5400
  | "ax5700" // 802.11ax AX5700 (WiFi 6)
  | "ax6000" // 802.11ax AX6000
  | "ax11000" // 802.11ax AX11000 (WiFi 6 tri-band)
  | "be5800" // 802.11be BE5800 (WiFi 7)
  | "be9300" // 802.11be BE9300 (WiFi 7)
  | "be19000" // 802.11be BE19000 (WiFi 7)
  | "be24000" // 802.11be BE24000 (WiFi 7)
  | "unknown";

/** ISP provider for branded gateways */
export type IspProvider =
  | "xfinity" // Comcast Xfinity
  | "verizon" // Verizon Fios
  | "att" // AT&T
  | "spectrum" // Charter Spectrum
  | "cox" // Cox Communications
  | "centurylink" // CenturyLink/Lumen
  | "frontier" // Frontier
  | "other";

// =============================================================================
// Firmware Types
// =============================================================================

/** Firmware branch information */
export interface FirmwareBranch {
  /** Branch identifier (e.g., "1.0.11.x", "3.x") */
  branchName: string;

  /** Minimum Safe Version for this branch */
  msv: string;

  /** Date MSV was determined */
  msvDate?: string;

  /** CVEs that determined the MSV */
  msvCves?: string[];

  /** Latest available firmware version */
  latest: string;

  /** Release date of latest firmware */
  latestDate?: string;

  /** Download URL for firmware */
  downloadUrl?: string;

  /** Whether this branch is end-of-life */
  eol: boolean;

  /** Note about EOL (e.g., "Upgrade to 1.0.11.x branch") */
  eolNote?: string;

  /** Firmware version release history */
  versionHistory?: FirmwareRelease[];
}

/** Alternative firmware support status */
export type AltFirmwareStatus =
  | "supported" // Actively supported with current builds
  | "experimental" // Works but not fully tested
  | "partial" // Limited functionality
  | "unsupported" // Not compatible
  | "unknown"; // Not tested

/** Alternative firmware information */
export interface AltFirmwareInfo {
  /** DD-WRT support status */
  ddwrt?: {
    status: AltFirmwareStatus;
    url?: string;
    notes?: string;
  };

  /** OpenWrt support status */
  openwrt?: {
    status: AltFirmwareStatus;
    url?: string;
    minVersion?: string; // Minimum OpenWrt version
    notes?: string;
  };

  /** Tomato support status */
  tomato?: {
    status: AltFirmwareStatus;
    variant?: string; // e.g., "FreshTomato", "AdvancedTomato"
    url?: string;
    notes?: string;
  };
}

/** CVE timeline information */
export interface CveTimeline {
  /** CVE ID */
  cveId: string;

  /** Date CVE was disclosed (published in NVD) */
  disclosedDate: string;

  /** Date CVE was added to CISA KEV (if applicable) */
  kevAddedDate?: string;

  /** Date vendor released patch */
  patchedDate?: string;

  /** Days between disclosure and patch (null if not patched) */
  daysToPatch?: number;

  /** Days since disclosure (calculated at query time) */
  daysSinceDisclosure?: number;

  /** Whether this CVE is actively exploited */
  activelyExploited: boolean;
}

/** Firmware version release entry for version history tracking */
export interface FirmwareRelease {
  /** Firmware version string */
  version: string;

  /** Release date (ISO 8601) */
  releaseDate: string;

  /** Type of release */
  releaseType: "initial" | "security" | "feature" | "hotfix" | "beta";

  /** CVEs fixed in this release */
  fixedCves?: string[];

  /** Brief changelog notes */
  changelog?: string;

  /** Whether this version is the MSV */
  isMsv?: boolean;
}

/** ISP gateway specific information */
export interface IspGatewayInfo {
  /** ISP provider name */
  provider: IspProvider;

  /** ISP-assigned model name (e.g., "XB7", "BGW320") */
  ispModelName: string;

  /** Actual OEM manufacturer */
  oemVendor: string;

  /** OEM model number */
  oemModel: string;

  /** Whether firmware is auto-updated by ISP */
  autoUpdated: boolean;

  /** Whether user can manage firmware */
  userManaged: boolean;

  /** Whether bridge mode is available */
  bridgeModeAvailable: boolean;

  /** Notes about ISP control */
  ispNotes?: string;
}

// =============================================================================
// Hardware Version Types
// =============================================================================

/** Hardware version information */
export interface HardwareVersion {
  /** Chipset used (e.g., "Broadcom BCM4709") */
  chipset?: string;

  /** Support status for this hardware version */
  supportStatus: SupportStatus;

  /** End of life date (ISO 8601) */
  eolDate?: string;

  /** URL to vendor support page */
  supportUrl?: string;

  /** Firmware branches available for this hardware version */
  firmwareBranches: Record<string, FirmwareBranch>;

  /** CVE IDs from CISA KEV affecting this hardware */
  kevCves?: string[];

  /** Alternative firmware support (DD-WRT, OpenWrt, Tomato) */
  altFirmware?: AltFirmwareInfo;

  /** Additional notes */
  note?: string;
}

// =============================================================================
// Model Types
// =============================================================================

/** Router model entry */
export interface RouterModel {
  /** Unique identifier (e.g., "netgear_r7000") */
  id: string;

  /** Vendor ID (e.g., "netgear") */
  vendor: string;

  /** Product family (e.g., "nighthawk") */
  family?: string;

  /** Model number (e.g., "R7000") */
  model: string;

  /** Display name (e.g., "NETGEAR R7000 Nighthawk") */
  displayName: string;

  /** Alternative names for matching */
  aliases: string[];

  /** Router category */
  category: RouterCategory;

  /** Target market */
  targetMarket?: TargetMarket;

  /** Release year */
  releaseYear?: number;

  /** WiFi standard */
  wifiStandard?: WifiStandard;

  /** CPE prefix for NVD lookup */
  cpePrefix?: string;

  /** Hardware versions (keyed by version like "v1", "v2") */
  hardwareVersions: Record<string, HardwareVersion>;

  /** Default hardware version if not specified */
  defaultHwVersion?: string;

  /** ISP gateway specific information (for ISP-branded devices) */
  ispGateway?: IspGatewayInfo;
}

// =============================================================================
// Vendor Types
// =============================================================================

/** Product family within a vendor */
export interface ProductFamily {
  /** Display name (e.g., "Nighthawk") */
  displayName: string;

  /** Category of products in this family */
  category: RouterCategory;

  /** Target market */
  targetMarket?: TargetMarket;

  /** Model IDs in this family */
  models: string[];

  /** Description */
  description?: string;
}

/** Vendor information */
export interface Vendor {
  /** Unique identifier (e.g., "netgear") */
  id: string;

  /** Display name (e.g., "NETGEAR") */
  displayName: string;

  /** Security advisory URL */
  securityUrl?: string;

  /** Whether vendor has bug bounty program */
  bugBounty: boolean;

  /** Bug bounty program URL */
  bugBountyUrl?: string;

  /** Whether vendor is a CVE Numbering Authority */
  cnaStatus: boolean;

  /** Year became CNA (if applicable) */
  cnaYear?: number;

  /** Trust rating */
  trustRating: TrustRating;

  /** Product families */
  families: Record<string, ProductFamily>;

  /** Country of origin (for context) */
  country?: string;

  /** Notes about vendor security practices */
  securityNotes?: string;
}

// =============================================================================
// Catalog Types
// =============================================================================

/** Complete router catalog */
export interface RouterCatalog {
  /** Schema version */
  version: string;

  /** Last update timestamp (ISO 8601) */
  lastUpdated: string;

  /** Vendor information */
  vendors: Record<string, Vendor>;

  /** Router models */
  models: Record<string, RouterModel>;
}

// =============================================================================
// Query/Result Types
// =============================================================================

/** Router query input */
export interface RouterQuery {
  /** Raw user input (e.g., "NETGEAR R7000") */
  input: string;

  /** Explicit vendor (optional) */
  vendor?: string;

  /** Hardware version (optional, e.g., "v1", "v2") */
  hwVersion?: string;

  /** Firmware version to check (optional) */
  firmware?: string;
}

/** Firmware compliance status */
export type FirmwareStatus =
  | "compliant" // At or above MSV
  | "outdated" // Below MSV but above EOL
  | "critical" // Below MSV with KEV CVEs
  | "eol" // On EOL firmware branch
  | "unknown"; // Cannot determine

/** Router query result */
export interface RouterResult {
  /** Whether query was successful */
  success: boolean;

  /** Error message if unsuccessful */
  error?: string;

  /** Matched model */
  model?: RouterModel;

  /** Matched vendor */
  vendor?: Vendor;

  /** Matched hardware version */
  hwVersion?: HardwareVersion;

  /** Hardware version key (e.g., "v1") */
  hwVersionKey?: string;

  /** Selected firmware branch */
  firmwareBranch?: FirmwareBranch;

  /** Firmware branch key */
  firmwareBranchKey?: string;

  /** User's firmware version (if provided) */
  userFirmware?: string;

  /** Firmware compliance status */
  firmwareStatus?: FirmwareStatus;

  /** Risk score (0-100) */
  riskScore?: number;

  /** Match confidence (0-1) */
  matchConfidence?: number;

  /** How the match was made */
  matchMethod?: "exact" | "alias" | "fuzzy" | "cpe";

  /** CVE timeline information for KEV CVEs */
  cveTimeline?: CveTimeline[];
}

/** Batch check input row */
export interface RouterInventoryRow {
  brand: string;
  model: string;
  hwVersion?: string;
  firmware?: string;
}

/** Batch check result */
export interface RouterBatchResult {
  input: RouterInventoryRow;
  result: RouterResult;
}

// =============================================================================
// Validation Types
// =============================================================================

/** Validation error */
export interface ValidationError {
  path: string;
  message: string;
}

/** Validation result */
export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}
