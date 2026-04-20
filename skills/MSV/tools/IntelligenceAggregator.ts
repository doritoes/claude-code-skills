/**
 * IntelligenceAggregator.ts - CTI Data Collection and Analysis
 *
 * Aggregates threat intelligence from multiple sources:
 * - CISA KEV catalog (new additions, ransomware associations)
 * - EPSS scores (spikes, trending vulnerabilities)
 * - NVD (new CVEs, severity analysis)
 * - Software catalog (inventory correlation)
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { CisaKevClient, type KevEntry, type KevCatalog } from "./CisaKevClient";
import { EpssClient } from "./EpssClient";
import { VulnCheckClient, type VulnCheckKevEntry, type VulnCheckKevCatalog } from "./VulnCheckClient";
import type {
  IntelItem,
  KevDelta,
  VulnCheckKevDelta,
  EpssSpike,
  IntelPriority,
  CTIUserProfile,
  IndustryMapping,
  IndustryMappingsCatalog,
  InventoryStatus,
} from "./CtiTypes";
import type { SoftwareCatalog, SoftwareMapping } from "./types";

// =============================================================================
// Types
// =============================================================================

interface HistoricalKevCache {
  snapshots: {
    date: string;
    count: number;
    cveIds: string[];
  }[];
  lastUpdated: string;
}

interface HistoricalEpssCache {
  snapshots: {
    date: string;
    scores: { cve: string; epss: number }[];
  }[];
  lastUpdated: string;
}

// =============================================================================
// Constants
// =============================================================================

const HISTORICAL_CACHE_DAYS = 30;

// =============================================================================
// Intelligence Aggregator
// =============================================================================

export class IntelligenceAggregator {
  private dataDir: string;
  private kevClient: CisaKevClient;
  private epssClient: EpssClient;
  private vulnCheckClient: VulnCheckClient | null = null;
  private softwareCatalog: SoftwareCatalog | null = null;
  private industryMappings: IndustryMappingsCatalog | null = null;

  constructor(dataDir: string, vulnCheckApiKey?: string) {
    this.dataDir = dataDir;
    this.kevClient = new CisaKevClient(dataDir);
    this.epssClient = new EpssClient(dataDir);

    if (vulnCheckApiKey) {
      const cacheDir = resolve(dataDir, "cache");
      this.vulnCheckClient = new VulnCheckClient(
        { apiKey: vulnCheckApiKey, timeout: 60000 },
        cacheDir
      );
    }

    // Ensure data directory exists
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }
  }

  // ===========================================================================
  // KEV Delta Detection
  // ===========================================================================

  /**
   * Get new KEV entries since a given date
   */
  async getKevDelta(periodDays: number): Promise<KevDelta> {
    const catalog = await this.kevClient.fetchCatalog();
    const periodStart = new Date();
    periodStart.setDate(periodStart.getDate() - periodDays);
    const periodStartStr = periodStart.toISOString().split("T")[0];

    // Get historical snapshot count
    const historicalCache = this.loadHistoricalKevCache();
    const previousSnapshot = this.findSnapshotForDate(historicalCache, periodDays);

    // Find new entries by dateAdded
    const newEntries: IntelItem[] = catalog.vulnerabilities
      .filter((entry) => entry.dateAdded >= periodStartStr)
      .map((entry) => this.kevEntryToIntelItem(entry));

    // Sort by date (newest first)
    newEntries.sort((a, b) => b.dateAdded.localeCompare(a.dateAdded));

    // Save current snapshot for future comparisons
    this.saveKevSnapshot(catalog);

    return {
      newEntries,
      totalCurrent: catalog.count,
      totalPrevious: previousSnapshot?.count ?? catalog.count - newEntries.length,
      periodStart: periodStartStr,
      periodEnd: new Date().toISOString().split("T")[0],
    };
  }

  /**
   * Get KEV entries by day for the last N days
   */
  async getKevByDay(days: number): Promise<Map<string, IntelItem[]>> {
    const catalog = await this.kevClient.fetchCatalog();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    const startStr = startDate.toISOString().split("T")[0];

    const byDay = new Map<string, IntelItem[]>();

    // Initialize all days
    for (let i = 0; i < days; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().split("T")[0];
      byDay.set(dateStr, []);
    }

    // Populate with entries
    for (const entry of catalog.vulnerabilities) {
      if (entry.dateAdded >= startStr) {
        const existing = byDay.get(entry.dateAdded) || [];
        existing.push(this.kevEntryToIntelItem(entry));
        byDay.set(entry.dateAdded, existing);
      }
    }

    return byDay;
  }

  /**
   * Get weekly KEV summary for the last N weeks
   */
  async getKevByWeek(weeks: number): Promise<{ weekStart: string; count: number; entries: IntelItem[] }[]> {
    const catalog = await this.kevClient.fetchCatalog();
    const result: { weekStart: string; count: number; entries: IntelItem[] }[] = [];

    for (let w = 0; w < weeks; w++) {
      const weekEnd = new Date();
      weekEnd.setDate(weekEnd.getDate() - w * 7);
      const weekStart = new Date(weekEnd);
      weekStart.setDate(weekStart.getDate() - 7);

      const weekStartStr = weekStart.toISOString().split("T")[0];
      const weekEndStr = weekEnd.toISOString().split("T")[0];

      const entries = catalog.vulnerabilities
        .filter((e) => e.dateAdded >= weekStartStr && e.dateAdded < weekEndStr)
        .map((e) => this.kevEntryToIntelItem(e));

      result.push({
        weekStart: weekStartStr,
        count: entries.length,
        entries,
      });
    }

    return result;
  }

  /**
   * Get ransomware-associated KEV entries
   */
  async getRansomwareCampaigns(periodDays: number): Promise<IntelItem[]> {
    const catalog = await this.kevClient.fetchCatalog();
    const periodStart = new Date();
    periodStart.setDate(periodStart.getDate() - periodDays);
    const periodStartStr = periodStart.toISOString().split("T")[0];

    return catalog.vulnerabilities
      .filter(
        (entry) =>
          entry.knownRansomwareCampaignUse === "Known" && entry.dateAdded >= periodStartStr
      )
      .map((entry) => ({
        ...this.kevEntryToIntelItem(entry),
        ransomwareAssociated: true,
      }));
  }

  // ===========================================================================
  // EPSS Spike Detection
  // ===========================================================================

  /**
   * Detect EPSS score spikes (significant increases)
   */
  async detectEpssSpikes(
    thresholdChange: number = 0.1,
    periodDays: number = 7
  ): Promise<EpssSpike[]> {
    const currentKev = await this.kevClient.fetchCatalog();
    const spikes: EpssSpike[] = [];

    // Get EPSS scores for KEV CVEs (most relevant) - limit to 30 for EPSS batch limit
    const kevSlice = currentKev.vulnerabilities.slice(0, 30);
    const kevCves = kevSlice.map((v) => v.cveID);

    // Build lookup for KEV metadata by CVE ID
    const kevMap = new Map(kevSlice.map((v) => [v.cveID, v]));

    // Get current EPSS scores (within 30 CVE limit)
    const currentScores = await this.epssClient.getScores(kevCves);

    // Load historical EPSS cache
    const historicalCache = this.loadHistoricalEpssCache();
    const previousSnapshot = this.findEpssSnapshotForDate(historicalCache, periodDays);

    if (previousSnapshot) {
      const previousMap = new Map(previousSnapshot.scores.map((s) => [s.cve, s.epss]));

      for (const score of currentScores) {
        const previous = previousMap.get(score.cve);
        if (previous !== undefined) {
          const change = score.epss - previous;
          if (change >= thresholdChange) {
            const kevEntry = kevMap.get(score.cve);
            spikes.push({
              cve: score.cve,
              currentScore: score.epss,
              previousScore: previous,
              changePercent: change * 100,
              daysSinceSpike: periodDays,
              vendorProject: kevEntry?.vendorProject,
              product: kevEntry?.product,
              shortDescription: kevEntry?.shortDescription,
            });
          }
        }
      }
    }

    // Save current snapshot
    this.saveEpssSnapshot(currentScores);

    // Sort by change magnitude
    spikes.sort((a, b) => b.changePercent - a.changePercent);

    return spikes;
  }

  /**
   * Get top EPSS scores (highest exploitation probability)
   */
  async getTopEpssScores(limit: number = 20): Promise<{ cve: string; epss: number; percentile: number }[]> {
    const kev = await this.kevClient.fetchCatalog();
    // Limit to 30 CVEs for EPSS batch limit
    const cves = kev.vulnerabilities.slice(0, 30).map((v) => v.cveID);
    const scores = await this.epssClient.getScores(cves);

    return scores
      .sort((a, b) => b.epss - a.epss)
      .slice(0, limit)
      .map((s) => ({
        cve: s.cve,
        epss: s.epss,
        percentile: s.percentile || 0,
      }));
  }

  // ===========================================================================
  // Software Inventory Correlation
  // ===========================================================================

  /**
   * Get inventory status for user's software list
   */
  async getInventoryStatus(
    softwareIds: string[],
    profile?: CTIUserProfile
  ): Promise<InventoryStatus[]> {
    const catalog = this.loadSoftwareCatalog();
    if (!catalog) {
      return [];
    }

    const kev = await this.kevClient.fetchCatalog();
    const periodStart = new Date();
    periodStart.setDate(periodStart.getDate() - 7);
    const periodStartStr = periodStart.toISOString().split("T")[0];

    const results: InventoryStatus[] = [];

    for (const id of softwareIds) {
      const software = catalog.software.find(
        (s) => s.id === id || s.aliases.includes(id.toLowerCase())
      );

      if (software) {
        // Find KEV entries affecting this software
        const affectingKev = kev.vulnerabilities.filter(
          (v) =>
            v.product.toLowerCase().includes(software.product.toLowerCase()) ||
            v.vendorProject.toLowerCase().includes(software.vendor.toLowerCase())
        );

        const newCves = affectingKev.filter((v) => v.dateAdded >= periodStartStr).length;

        // Calculate risk score based on KEV presence
        const riskScore = affectingKev.length > 0 ? Math.min(100, 40 + affectingKev.length * 10) : 20;
        const riskLevel =
          riskScore >= 80 ? "CRITICAL" : riskScore >= 60 ? "HIGH" : riskScore >= 40 ? "MEDIUM" : "LOW";

        results.push({
          software: software.id,
          displayName: software.displayName,
          msv: null, // Would need to query MSV for each
          compliant: affectingKev.length === 0,
          newCvesThisPeriod: newCves,
          riskScore,
          riskLevel,
        });
      }
    }

    return results;
  }

  /**
   * Find industry-relevant threats
   */
  async getIndustryIntel(industry: string, periodDays: number): Promise<IntelItem[]> {
    const mappings = this.loadIndustryMappings();
    if (!mappings) return [];

    // Find matching industry
    const industryMapping = mappings.industries.find(
      (m) =>
        m.industry.toLowerCase() === industry.toLowerCase() ||
        m.aliases?.some((a) => a.toLowerCase() === industry.toLowerCase())
    );

    if (!industryMapping) return [];

    // Get KEV entries that match industry's common software
    const kev = await this.kevClient.fetchCatalog();
    const periodStart = new Date();
    periodStart.setDate(periodStart.getDate() - periodDays);
    const periodStartStr = periodStart.toISOString().split("T")[0];

    const relevantEntries = kev.vulnerabilities.filter((entry) => {
      if (entry.dateAdded < periodStartStr) return false;

      const productLower = entry.product.toLowerCase();
      const vendorLower = entry.vendorProject.toLowerCase();

      return industryMapping.commonSoftware.some(
        (sw) => productLower.includes(sw.toLowerCase()) || vendorLower.includes(sw.toLowerCase())
      );
    });

    return relevantEntries.map((entry) => ({
      ...this.kevEntryToIntelItem(entry),
      industryRelevance: [industry],
    }));
  }

  // ===========================================================================
  // VulnCheck KEV Integration
  // ===========================================================================

  /**
   * Get VulnCheck KEV delta — entries NOT in CISA KEV (early warning)
   * Returns null if VulnCheck API key is not configured.
   */
  async getVulnCheckKevDelta(periodDays: number): Promise<VulnCheckKevDelta | null> {
    if (!this.vulnCheckClient) return null;

    try {
      const [vcCatalog, cisaCatalog] = await Promise.all([
        this.vulnCheckClient.fetchKevCatalog(),
        this.kevClient.fetchCatalog(),
      ]);

      // Build CISA CVE set for fast lookup
      const cisaCveSet = new Set(cisaCatalog.vulnerabilities.map((v) => v.cveID));

      // All VulnCheck-only entries (all time)
      const allVcOnly = vcCatalog.entries.filter((entry) => {
        const cves = Array.isArray(entry.cve) ? entry.cve : [entry.cve];
        return cves.every((cve) => !cisaCveSet.has(cve));
      });

      // VulnCheck-only entries added this period
      const periodStart = new Date();
      periodStart.setDate(periodStart.getDate() - periodDays);
      const periodStartStr = periodStart.toISOString().split("T")[0];

      const recentVcOnly = allVcOnly.filter((entry) => {
        const dateAdded = entry.date_added?.split("T")[0] || "";
        return dateAdded >= periodStartStr;
      });

      // Convert to IntelItems
      const vulncheckOnlyEntries = recentVcOnly
        .map((entry) => this.vcKevEntryToIntelItem(entry))
        .sort((a, b) => b.dateAdded.localeCompare(a.dateAdded));

      return {
        vulncheckOnlyEntries,
        totalVulnCheckKev: vcCatalog.count,
        totalCisaKev: cisaCatalog.count,
        totalVulnCheckOnly: allVcOnly.length,
      };
    } catch (error) {
      // Log but don't fail the report if VulnCheck is unavailable
      console.error(`\x1b[33mVulnCheck KEV fetch failed: ${(error as Error).message}\x1b[0m`);
      return null;
    }
  }

  /**
   * Convert VulnCheck KEV entry to IntelItem
   */
  private vcKevEntryToIntelItem(entry: VulnCheckKevEntry): IntelItem {
    const cves = Array.isArray(entry.cve) ? entry.cve : [entry.cve];
    const primaryCve = cves[0] || "UNKNOWN";
    const hasExploitDb = entry.vulncheck_xdb && entry.vulncheck_xdb.length > 0;
    const hasExploitEvidence = entry.vulncheck_reported_exploitation && entry.vulncheck_reported_exploitation.length > 0;

    return {
      id: primaryCve,
      title: entry.vulnerabilityName || entry.description || `${entry.vendorProject || entry.vendor} ${entry.product} Vulnerability`,
      description: entry.shortDescription || entry.description || "",
      priority: entry.knownRansomwareCampaignUse === "Known" ? "CRITICAL" : "HIGH",
      dateAdded: entry.date_added?.split("T")[0] || "",
      affectedProducts: [entry.product],
      source: "VULNCHECK",
      exploitationStatus: hasExploitEvidence ? "ACTIVE" : hasExploitDb ? "POC_AVAILABLE" : "ACTIVE",
      ransomwareAssociated: entry.knownRansomwareCampaignUse === "Known",
      remediation: entry.required_action,
    };
  }

  // ===========================================================================
  // Critical Zero-Days
  // ===========================================================================

  /**
   * Get critical zero-days from the period
   * Defined as: KEV entries with active exploitation + high EPSS
   */
  async getCriticalZeroDays(periodDays: number): Promise<IntelItem[]> {
    const [kevDelta, vcKevDelta] = await Promise.all([
      this.getKevDelta(periodDays),
      this.getVulnCheckKevDelta(periodDays),
    ]);

    // Merge CISA KEV entries + VulnCheck-only entries (deduplicated by CVE ID)
    const seenIds = new Set<string>();
    const mergedEntries: IntelItem[] = [];
    for (const e of kevDelta.newEntries) {
      if (!seenIds.has(e.id)) { seenIds.add(e.id); mergedEntries.push(e); }
    }
    if (vcKevDelta) {
      for (const e of vcKevDelta.vulncheckOnlyEntries) {
        if (!seenIds.has(e.id)) { seenIds.add(e.id); mergedEntries.push(e); }
      }
    }

    // Get EPSS scores for merged entries (limit to 30 for EPSS batch limit)
    const cves = mergedEntries.slice(0, 30).map((e) => e.id);
    const epssScores = cves.length > 0 ? await this.epssClient.getScores(cves) : [];
    const epssMap = new Map(epssScores.map((s) => [s.cve, s.epss]));

    const currentYear = new Date().getFullYear();

    // Enrich with EPSS scores, CVE year, and zero-day classification
    const enriched = mergedEntries.map((item) => {
      // Extract year from CVE ID (e.g., CVE-2026-12345 -> 2026)
      const yearMatch = item.id.match(/^CVE-(\d{4})-/);
      const cveYear = yearMatch ? parseInt(yearMatch[1]) : undefined;

      // Zero-day classification:
      // 1. No patch available (remediation suggests mitigations, not patching)
      //    OR source is VulnCheck with active exploitation (not yet in CISA KEV = early warning)
      // 2. Recently published CVE (within ~1 year of current date)
      const remediation = (item.remediation || "").toLowerCase();
      const hasNoPatch = remediation.includes("mitigat") ||
                         remediation.includes("discontinue") ||
                         remediation.includes("no patch") ||
                         remediation.includes("workaround") ||
                         remediation === ""; // VulnCheck entries may have no required_action
      const isVulnCheckOnly = item.source === "VULNCHECK";
      const isRecentCve = cveYear !== undefined && (currentYear - cveYear) <= 1;
      const isZeroDay = (hasNoPatch || isVulnCheckOnly) && isRecentCve;

      return {
        ...item,
        epssScore: epssMap.get(item.id),
        priority: this.calculatePriority(item, epssMap.get(item.id)),
        isZeroDay,
        cveYear,
      };
    });

    // Filter to critical priority and sort: zero-days first, then by priority
    return enriched
      .filter((item) => item.priority === "CRITICAL" || item.priority === "HIGH")
      .sort((a, b) => {
        // Zero-days always first
        if (a.isZeroDay && !b.isZeroDay) return -1;
        if (!a.isZeroDay && b.isZeroDay) return 1;
        // Then by priority
        const priorityOrder = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, INFO: 4 };
        return priorityOrder[a.priority] - priorityOrder[b.priority];
      });
  }

  // ===========================================================================
  // Data Source Timestamps
  // ===========================================================================

  /**
   * Get validation timestamps for all data sources
   */
  async getDataValidation(): Promise<{ source: string; timestamp: string; isCurrent: boolean }[]> {
    const now = new Date();
    const staleThresholdHours = 24;

    const validations: { source: string; timestamp: string; isCurrent: boolean }[] = [];

    // KEV cache
    const kevCachePath = resolve(this.dataDir, "kev-cache.json");
    if (existsSync(kevCachePath)) {
      const cache = JSON.parse(readFileSync(kevCachePath, "utf-8"));
      const timestamp = cache.lastUpdated || cache.data?.dateReleased;
      if (timestamp) {
        const age = (now.getTime() - new Date(timestamp).getTime()) / (1000 * 60 * 60);
        validations.push({
          source: "CISA KEV",
          timestamp,
          isCurrent: age < staleThresholdHours,
        });
      }
    }

    // EPSS cache
    const epssCachePath = resolve(this.dataDir, "epss-cache.json");
    if (existsSync(epssCachePath)) {
      const cache = JSON.parse(readFileSync(epssCachePath, "utf-8"));
      const timestamp = cache.lastUpdated;
      if (timestamp) {
        const age = (now.getTime() - new Date(timestamp).getTime()) / (1000 * 60 * 60);
        validations.push({
          source: "EPSS",
          timestamp,
          isCurrent: age < staleThresholdHours,
        });
      }
    }

    // VulnCheck KEV cache
    const vcKevCachePath = resolve(this.dataDir, "cache", "vulncheck-kev-catalog.json");
    if (existsSync(vcKevCachePath)) {
      try {
        const cache = JSON.parse(readFileSync(vcKevCachePath, "utf-8"));
        const timestamp = cache.lastUpdated;
        if (timestamp) {
          const age = (now.getTime() - new Date(timestamp).getTime()) / (1000 * 60 * 60);
          validations.push({
            source: "VulnCheck KEV",
            timestamp,
            isCurrent: age < staleThresholdHours,
          });
        }
      } catch {
        // Cache corrupted
      }
    }

    // NVD cache (check for any nvd-*.json files)
    const nvdCachePath = resolve(this.dataDir, "msv-cache.json");
    if (existsSync(nvdCachePath)) {
      const cache = JSON.parse(readFileSync(nvdCachePath, "utf-8"));
      const timestamp = cache.lastUpdated;
      if (timestamp) {
        const age = (now.getTime() - new Date(timestamp).getTime()) / (1000 * 60 * 60);
        validations.push({
          source: "NVD",
          timestamp,
          isCurrent: age < staleThresholdHours,
        });
      }
    }

    return validations;
  }

  // ===========================================================================
  // Helper Methods
  // ===========================================================================

  private kevEntryToIntelItem(entry: KevEntry): IntelItem {
    return {
      id: entry.cveID,
      title: entry.vulnerabilityName,
      description: entry.shortDescription,
      priority: entry.knownRansomwareCampaignUse === "Known" ? "CRITICAL" : "HIGH",
      dateAdded: entry.dateAdded,
      affectedProducts: [entry.product],
      source: "KEV",
      exploitationStatus: "ACTIVE",
      ransomwareAssociated: entry.knownRansomwareCampaignUse === "Known",
      remediation: entry.requiredAction,
    };
  }

  private calculatePriority(item: IntelItem, epssScore?: number): IntelPriority {
    // Ransomware = always critical
    if (item.ransomwareAssociated) return "CRITICAL";

    // High EPSS = critical
    if (epssScore && epssScore > 0.5) return "CRITICAL";

    // In KEV = at least high
    if (item.source === "KEV") return "HIGH";

    // Medium EPSS = high
    if (epssScore && epssScore > 0.2) return "HIGH";

    return "MEDIUM";
  }

  // ===========================================================================
  // Cache Management
  // ===========================================================================

  private loadHistoricalKevCache(): HistoricalKevCache {
    const cachePath = resolve(this.dataDir, "kev-historical.json");
    if (existsSync(cachePath)) {
      try {
        return JSON.parse(readFileSync(cachePath, "utf-8"));
      } catch {
        // Corrupted cache
      }
    }
    return { snapshots: [], lastUpdated: "" };
  }

  private saveKevSnapshot(catalog: KevCatalog): void {
    const cache = this.loadHistoricalKevCache();
    const today = new Date().toISOString().split("T")[0];

    // Don't add duplicate for same day
    if (cache.snapshots.some((s) => s.date === today)) {
      return;
    }

    cache.snapshots.push({
      date: today,
      count: catalog.count,
      cveIds: catalog.vulnerabilities.map((v) => v.cveID),
    });

    // Keep only last N days
    cache.snapshots = cache.snapshots
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, HISTORICAL_CACHE_DAYS);

    cache.lastUpdated = new Date().toISOString();

    writeFileSync(
      resolve(this.dataDir, "kev-historical.json"),
      JSON.stringify(cache, null, 2)
    );
  }

  private findSnapshotForDate(
    cache: HistoricalKevCache,
    daysAgo: number
  ): { date: string; count: number } | null {
    const targetDate = new Date();
    targetDate.setDate(targetDate.getDate() - daysAgo);
    const targetStr = targetDate.toISOString().split("T")[0];

    // Find closest snapshot to target date
    for (const snapshot of cache.snapshots) {
      if (snapshot.date <= targetStr) {
        return snapshot;
      }
    }
    return null;
  }

  private loadHistoricalEpssCache(): HistoricalEpssCache {
    const cachePath = resolve(this.dataDir, "epss-historical.json");
    if (existsSync(cachePath)) {
      try {
        return JSON.parse(readFileSync(cachePath, "utf-8"));
      } catch {
        // Corrupted cache
      }
    }
    return { snapshots: [], lastUpdated: "" };
  }

  private saveEpssSnapshot(scores: { cve: string; epss: number }[]): void {
    const cache = this.loadHistoricalEpssCache();
    const today = new Date().toISOString().split("T")[0];

    // Don't add duplicate for same day
    if (cache.snapshots.some((s) => s.date === today)) {
      return;
    }

    cache.snapshots.push({
      date: today,
      scores: scores.slice(0, 500), // Keep top 500 to limit size
    });

    // Keep only last N days
    cache.snapshots = cache.snapshots
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, HISTORICAL_CACHE_DAYS);

    cache.lastUpdated = new Date().toISOString();

    writeFileSync(
      resolve(this.dataDir, "epss-historical.json"),
      JSON.stringify(cache, null, 2)
    );
  }

  private findEpssSnapshotForDate(
    cache: HistoricalEpssCache,
    daysAgo: number
  ): { date: string; scores: { cve: string; epss: number }[] } | null {
    const targetDate = new Date();
    targetDate.setDate(targetDate.getDate() - daysAgo);
    const targetStr = targetDate.toISOString().split("T")[0];

    for (const snapshot of cache.snapshots) {
      if (snapshot.date <= targetStr) {
        return snapshot;
      }
    }
    return null;
  }

  private loadSoftwareCatalog(): SoftwareCatalog | null {
    if (this.softwareCatalog) return this.softwareCatalog;

    const catalogPath = resolve(this.dataDir, "SoftwareCatalog.json");
    if (existsSync(catalogPath)) {
      try {
        this.softwareCatalog = JSON.parse(readFileSync(catalogPath, "utf-8"));
        return this.softwareCatalog;
      } catch {
        // Corrupted catalog
      }
    }
    return null;
  }

  private loadIndustryMappings(): IndustryMappingsCatalog | null {
    if (this.industryMappings) return this.industryMappings;

    const mappingsPath = resolve(this.dataDir, "IndustryMappings.json");
    if (existsSync(mappingsPath)) {
      try {
        this.industryMappings = JSON.parse(readFileSync(mappingsPath, "utf-8"));
        return this.industryMappings;
      } catch {
        // Corrupted mappings
      }
    }
    return null;
  }
}
