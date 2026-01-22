/**
 * RouterClient.ts - Router firmware lookup and MSV checking
 *
 * Provides:
 * - Model lookup with fuzzy matching
 * - Hardware version resolution
 * - Firmware branch selection
 * - MSV compliance checking
 */

import type {
  RouterCatalog,
  RouterModel,
  RouterQuery,
  RouterResult,
  Vendor,
  HardwareVersion,
  FirmwareBranch,
  FirmwareStatus,
  RouterInventoryRow,
  RouterBatchResult,
  CveTimeline,
} from "./RouterTypes";

// Catalog singleton
let catalogInstance: RouterCatalog | null = null;

/**
 * Load the router catalog from disk
 */
export async function loadCatalog(): Promise<RouterCatalog> {
  if (catalogInstance) return catalogInstance;

  const catalogPath = new URL("../data/RouterCatalog.json", import.meta.url);
  const data = await Bun.file(catalogPath).text();
  catalogInstance = JSON.parse(data) as RouterCatalog;
  return catalogInstance;
}

/**
 * Normalize a string for matching (lowercase, remove special chars)
 */
function normalize(str: string): string {
  return str
    .toLowerCase()
    .replace(/[-_\s]+/g, "")
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Calculate simple Levenshtein distance for fuzzy matching
 */
function levenshtein(a: string, b: string): number {
  const matrix: number[][] = [];

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          matrix[i][j - 1] + 1, // insertion
          matrix[i - 1][j] + 1 // deletion
        );
      }
    }
  }

  return matrix[b.length][a.length];
}

/**
 * Calculate match confidence (0-1) based on normalized strings
 */
function calculateConfidence(input: string, target: string): number {
  const normInput = normalize(input);
  const normTarget = normalize(target);

  // Exact match
  if (normInput === normTarget) return 1.0;

  // Contains match
  if (normTarget.includes(normInput) || normInput.includes(normTarget)) {
    const longer = Math.max(normInput.length, normTarget.length);
    const shorter = Math.min(normInput.length, normTarget.length);
    return 0.8 + (0.15 * shorter) / longer;
  }

  // Levenshtein distance
  const distance = levenshtein(normInput, normTarget);
  const maxLen = Math.max(normInput.length, normTarget.length);
  const similarity = 1 - distance / maxLen;

  return Math.max(0, similarity);
}

/**
 * Find the best matching model for a query
 */
export async function findModel(
  query: RouterQuery
): Promise<{ model: RouterModel; confidence: number; method: string } | null> {
  const catalog = await loadCatalog();
  const normInput = normalize(query.input);

  let bestMatch: RouterModel | null = null;
  let bestConfidence = 0;
  let matchMethod = "fuzzy";

  // Check each model
  for (const model of Object.values(catalog.models)) {
    // Vendor filter if specified
    if (query.vendor && normalize(query.vendor) !== normalize(model.vendor)) {
      continue;
    }

    // Check model number (exact)
    const normModel = normalize(model.model);
    if (normInput === normModel || normInput.includes(normModel)) {
      const conf = calculateConfidence(query.input, model.model);
      if (conf > bestConfidence) {
        bestMatch = model;
        bestConfidence = conf;
        matchMethod = "exact";
      }
    }

    // Check display name
    const displayConf = calculateConfidence(query.input, model.displayName);
    if (displayConf > bestConfidence) {
      bestMatch = model;
      bestConfidence = displayConf;
      matchMethod = displayConf > 0.95 ? "exact" : "fuzzy";
    }

    // Check aliases
    for (const alias of model.aliases) {
      const aliasConf = calculateConfidence(query.input, alias);
      if (aliasConf > bestConfidence) {
        bestMatch = model;
        bestConfidence = aliasConf;
        matchMethod = "alias";
      }
    }

    // Check vendor + model combo
    const vendorModel = `${catalog.vendors[model.vendor]?.displayName || model.vendor} ${model.model}`;
    const vmConf = calculateConfidence(query.input, vendorModel);
    if (vmConf > bestConfidence) {
      bestMatch = model;
      bestConfidence = vmConf;
      matchMethod = vmConf > 0.95 ? "exact" : "fuzzy";
    }
  }

  // Require minimum confidence
  if (bestConfidence < 0.5 || !bestMatch) {
    return null;
  }

  return {
    model: bestMatch,
    confidence: bestConfidence,
    method: matchMethod,
  };
}

/**
 * Compare two version strings
 * Returns: -1 if a < b, 0 if a == b, 1 if a > b
 */
export function compareVersions(a: string, b: string): number {
  // Handle underscore-separated versions (ASUS style: 3.0.0.4.386_51948)
  const normalize = (v: string) => v.replace(/_/g, ".");

  const partsA = normalize(a).split(".").map((x) => parseInt(x, 10) || 0);
  const partsB = normalize(b).split(".").map((x) => parseInt(x, 10) || 0);

  const maxLen = Math.max(partsA.length, partsB.length);

  for (let i = 0; i < maxLen; i++) {
    const numA = partsA[i] || 0;
    const numB = partsB[i] || 0;

    if (numA < numB) return -1;
    if (numA > numB) return 1;
  }

  return 0;
}

/**
 * Determine firmware compliance status
 */
function getFirmwareStatus(
  userFirmware: string,
  branch: FirmwareBranch,
  hwVersion: HardwareVersion
): FirmwareStatus {
  // EOL branch
  if (branch.eol) {
    return "eol";
  }

  // Unknown MSV
  if (branch.msv === "unknown") {
    return "unknown";
  }

  // Compare versions
  const comparison = compareVersions(userFirmware, branch.msv);

  if (comparison >= 0) {
    return "compliant";
  }

  // Below MSV - check if KEV CVEs present
  if (hwVersion.kevCves && hwVersion.kevCves.length > 0) {
    return "critical";
  }

  return "outdated";
}

/**
 * Calculate risk score (0-100) based on various factors
 */
function calculateRiskScore(
  firmwareStatus: FirmwareStatus,
  hwVersion: HardwareVersion,
  vendor: Vendor
): number {
  let score = 0;

  // Base score from firmware status
  switch (firmwareStatus) {
    case "compliant":
      score = 10;
      break;
    case "outdated":
      score = 40;
      break;
    case "critical":
      score = 80;
      break;
    case "eol":
      score = 90;
      break;
    case "unknown":
      score = 50;
      break;
  }

  // Adjust for KEV CVEs
  const kevCount = hwVersion.kevCves?.length || 0;
  score += Math.min(kevCount * 5, 20);

  // Adjust for vendor trust rating
  switch (vendor.trustRating) {
    case "high":
      score -= 5;
      break;
    case "medium-high":
      score -= 2;
      break;
    case "medium":
      break;
    case "low":
      score += 10;
      break;
  }

  // Adjust for support status
  if (hwVersion.supportStatus === "eol") {
    score += 15;
  } else if (hwVersion.supportStatus === "security-only") {
    score += 5;
  }

  return Math.max(0, Math.min(100, score));
}

/**
 * Query router information and get MSV/compliance data
 */
export async function queryRouter(query: RouterQuery): Promise<RouterResult> {
  const catalog = await loadCatalog();

  // Find model
  const match = await findModel(query);
  if (!match) {
    return {
      success: false,
      error: `No matching router found for "${query.input}". Try a more specific query like "NETGEAR R7000" or "TP-Link Archer AX21".`,
    };
  }

  const { model, confidence, method } = match;
  const vendor = catalog.vendors[model.vendor];

  // Resolve hardware version
  const hwVersionKey = query.hwVersion || model.defaultHwVersion || Object.keys(model.hardwareVersions)[0];
  const hwVersion = model.hardwareVersions[hwVersionKey];

  if (!hwVersion) {
    return {
      success: false,
      error: `Hardware version "${hwVersionKey}" not found for ${model.displayName}. Available versions: ${Object.keys(model.hardwareVersions).join(", ")}`,
    };
  }

  // Select firmware branch
  const branchKeys = Object.keys(hwVersion.firmwareBranches);
  const firmwareBranchKey = branchKeys[0]; // Default to first (usually main) branch
  const firmwareBranch = hwVersion.firmwareBranches[firmwareBranchKey];

  // Determine firmware status if user provided version
  let firmwareStatus: FirmwareStatus | undefined;
  let riskScore: number | undefined;

  if (query.firmware) {
    firmwareStatus = getFirmwareStatus(query.firmware, firmwareBranch, hwVersion);
    riskScore = calculateRiskScore(firmwareStatus, hwVersion, vendor);
  } else {
    // Calculate risk without user firmware
    riskScore = calculateRiskScore("unknown", hwVersion, vendor);
  }

  return {
    success: true,
    model,
    vendor,
    hwVersion,
    hwVersionKey,
    firmwareBranch,
    firmwareBranchKey,
    userFirmware: query.firmware,
    firmwareStatus,
    riskScore,
    matchConfidence: confidence,
    matchMethod: method as "exact" | "alias" | "fuzzy" | "cpe",
  };
}

/**
 * Process a batch of router inventory rows
 */
export async function batchQuery(
  rows: RouterInventoryRow[]
): Promise<RouterBatchResult[]> {
  const results: RouterBatchResult[] = [];

  for (const row of rows) {
    const query: RouterQuery = {
      input: `${row.brand} ${row.model}`.trim(),
      vendor: row.brand,
      hwVersion: row.hwVersion,
      firmware: row.firmware,
    };

    const result = await queryRouter(query);
    results.push({ input: row, result });
  }

  return results;
}

/**
 * List all vendors in the catalog
 */
export async function listVendors(): Promise<Vendor[]> {
  const catalog = await loadCatalog();
  return Object.values(catalog.vendors);
}

/**
 * List all models for a vendor
 */
export async function listModelsByVendor(vendorId: string): Promise<RouterModel[]> {
  const catalog = await loadCatalog();
  return Object.values(catalog.models).filter(
    (m) => normalize(m.vendor) === normalize(vendorId)
  );
}

/**
 * Get catalog statistics
 */
export async function getCatalogStats(): Promise<{
  version: string;
  lastUpdated: string;
  vendorCount: number;
  modelCount: number;
  kevAffectedCount: number;
  eolCount: number;
}> {
  const catalog = await loadCatalog();

  let kevAffectedCount = 0;
  let eolCount = 0;

  for (const model of Object.values(catalog.models)) {
    for (const hwVersion of Object.values(model.hardwareVersions)) {
      if (hwVersion.kevCves && hwVersion.kevCves.length > 0) {
        kevAffectedCount++;
      }
      if (hwVersion.supportStatus === "eol") {
        eolCount++;
      }
    }
  }

  return {
    version: catalog.version,
    lastUpdated: catalog.lastUpdated,
    vendorCount: Object.keys(catalog.vendors).length,
    modelCount: Object.keys(catalog.models).length,
    kevAffectedCount,
    eolCount,
  };
}

/**
 * Format router result for CLI output
 */
export function formatRouterResult(result: RouterResult): string {
  if (!result.success) {
    return `Error: ${result.error}`;
  }

  const lines: string[] = [];
  const { model, vendor, hwVersion, firmwareBranch, firmwareStatus, riskScore, matchConfidence } = result;

  // Header
  lines.push(`\n${model!.displayName}`);
  lines.push("=".repeat(model!.displayName.length));

  // Match info
  if (matchConfidence && matchConfidence < 1) {
    lines.push(`Match confidence: ${Math.round(matchConfidence * 100)}% (${result.matchMethod})`);
  }

  // Vendor info
  lines.push(`\nVendor: ${vendor!.displayName}`);
  lines.push(`Trust Rating: ${vendor!.trustRating.toUpperCase()}`);
  if (vendor!.bugBounty) {
    lines.push(`Bug Bounty: Yes (${vendor!.bugBountyUrl})`);
  }
  if (vendor!.cnaStatus) {
    lines.push(`CNA Status: Yes (since ${vendor!.cnaYear})`);
  }

  // Hardware info
  lines.push(`\nHardware Version: ${result.hwVersionKey}`);
  lines.push(`Support Status: ${hwVersion!.supportStatus.toUpperCase()}`);
  if (hwVersion!.eolDate) {
    lines.push(`EOL Date: ${hwVersion!.eolDate}`);
  }

  // ISP Gateway info (with auto-update highlight)
  if (model!.ispGateway) {
    const gw = model!.ispGateway;
    lines.push(`\nISP Gateway: ${gw.provider.toUpperCase()} ${gw.ispModelName}`);
    if (gw.oemVendor && gw.oemModel) {
      lines.push(`OEM Hardware: ${gw.oemVendor} ${gw.oemModel}`);
    }
    if (gw.autoUpdated) {
      lines.push(`✓ AUTO-UPDATED: Firmware is automatically updated by ${gw.provider.toUpperCase()}`);
      lines.push(`  This significantly reduces your security risk!`);
    } else if (gw.userManaged) {
      lines.push(`User Managed: You are responsible for firmware updates`);
    }
    if (gw.bridgeModeAvailable) {
      lines.push(`Bridge Mode: Available (can use your own router)`);
    } else {
      lines.push(`Bridge Mode: Not available`);
    }
    if (gw.ispNotes) {
      lines.push(`Note: ${gw.ispNotes}`);
    }
  }

  // Firmware info
  lines.push(`\nFirmware Branch: ${firmwareBranch!.branchName}`);
  lines.push(`Minimum Safe Version (MSV): ${firmwareBranch!.msv}`);
  lines.push(`Latest Version: ${firmwareBranch!.latest}`);
  if (firmwareBranch!.latestDate) {
    lines.push(`Latest Date: ${firmwareBranch!.latestDate}`);
  }

  // User firmware status
  if (result.userFirmware) {
    lines.push(`\nYour Firmware: ${result.userFirmware}`);
    lines.push(`Status: ${firmwareStatus!.toUpperCase()}`);

    if (firmwareStatus === "critical") {
      lines.push(`⚠️  CRITICAL: Your firmware is vulnerable to known exploited vulnerabilities!`);
    } else if (firmwareStatus === "outdated") {
      lines.push(`⚠️  OUTDATED: Update to at least ${firmwareBranch!.msv}`);
    } else if (firmwareStatus === "eol") {
      lines.push(`⚠️  EOL: This firmware branch is end-of-life. Consider replacing the device.`);
    } else if (firmwareStatus === "compliant") {
      lines.push(`✓ Firmware meets minimum safe version requirements`);
    }
  }

  // Risk score
  if (riskScore !== undefined) {
    const riskLevel =
      riskScore >= 80 ? "CRITICAL" :
      riskScore >= 60 ? "HIGH" :
      riskScore >= 40 ? "MEDIUM" :
      riskScore >= 20 ? "LOW" : "MINIMAL";
    lines.push(`\nRisk Score: ${riskScore}/100 (${riskLevel})`);
  }

  // KEV CVEs with timeline
  if (hwVersion!.kevCves && hwVersion!.kevCves.length > 0) {
    lines.push(`\nKEV CVEs (${hwVersion!.kevCves.length}):`);
    for (const cve of hwVersion!.kevCves) {
      // Check for timeline info
      const timeline = result.cveTimeline?.find((t) => t.cveId === cve);
      if (timeline) {
        const daysSince = timeline.daysSinceDisclosure || calculateDaysSince(timeline.disclosedDate);
        const patchInfo = timeline.daysToPatch ? ` | Patched in ${timeline.daysToPatch}d` : "";
        lines.push(`  - ${cve} (${daysSince}d since disclosure${patchInfo})`);
      } else {
        lines.push(`  - ${cve}`);
      }
    }
  }

  // Alternative firmware options
  if (hwVersion!.altFirmware) {
    const alt = hwVersion!.altFirmware;
    const altOptions: string[] = [];

    if (alt.ddwrt?.status === "supported") {
      altOptions.push("DD-WRT");
    }
    if (alt.openwrt?.status === "supported") {
      altOptions.push(`OpenWrt${alt.openwrt.minVersion ? ` (${alt.openwrt.minVersion}+)` : ""}`);
    }
    if (alt.tomato?.status === "supported") {
      altOptions.push(alt.tomato.variant || "Tomato");
    }

    if (altOptions.length > 0) {
      lines.push(`\nAlternative Firmware: ${altOptions.join(", ")}`);
    }
  }

  // Download URL
  if (firmwareBranch!.downloadUrl) {
    lines.push(`\nDownload: ${firmwareBranch!.downloadUrl}`);
  }

  // Replacement recommendations for high-risk devices
  const shouldReplace =
    hwVersion!.supportStatus === "never-supported" ||
    hwVersion!.supportStatus === "eol" ||
    (riskScore !== undefined && riskScore >= 70) ||
    firmwareBranch!.msv === "NO SAFE VERSION EXISTS";

  if (shouldReplace) {
    lines.push(`\n${"=".repeat(50)}`);
    lines.push(`REPLACEMENT RECOMMENDED`);
    lines.push(`${"=".repeat(50)}`);
    lines.push(`\nWhen choosing a replacement, look for:`);
    lines.push(`\n✓ SECURITY FEATURES:`);
    lines.push(`  • Bug bounty program (ASUS, NETGEAR, Google, Ubiquiti)`);
    lines.push(`  • CVE Numbering Authority status (faster patches)`);
    lines.push(`  • Regular security advisories published`);
    lines.push(`\n✓ AUTO-UPDATE OPTIONS:`);
    lines.push(`  • ISP gateways (Xfinity, Verizon, AT&T) auto-update firmware`);
    lines.push(`  • Google Nest WiFi, Amazon eero have automatic updates`);
    lines.push(`  • ASUS, NETGEAR newer models support auto-update`);
    lines.push(`\n✓ HIGH TRUST VENDORS:`);
    lines.push(`  • ASUS, NETGEAR, Ubiquiti (bug bounty + CNA)`);
    lines.push(`  • Google, Amazon (strong security teams)`);
    lines.push(`  • MikroTik (fast patch cycles, CNA since 2022)`);

    if (hwVersion!.altFirmware?.openwrt?.status === "supported" ||
        hwVersion!.altFirmware?.ddwrt?.status === "supported") {
      lines.push(`\n✓ ALTERNATIVE: Flash DD-WRT/OpenWrt for continued use`);
      lines.push(`  (See Alternative Firmware section above)`);
    }
  }

  return lines.join("\n");
}

/**
 * Calculate days since a date string
 */
function calculateDaysSince(dateStr: string): number {
  const date = new Date(dateStr);
  const now = new Date();
  const diffTime = Math.abs(now.getTime() - date.getTime());
  return Math.floor(diffTime / (1000 * 60 * 60 * 24));
}
