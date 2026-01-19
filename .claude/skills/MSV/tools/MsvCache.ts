/**
 * MsvCache.ts - MSV Results Cache with Version Tracking
 *
 * Key principles:
 * 1. MSV never decreases - only check from cached MSV forward
 * 2. Store per-branch MSV for software with multiple release branches
 * 3. Track data sources and confidence for Admiralty rating
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

// =============================================================================
// Types
// =============================================================================

export interface MsvBranch {
  branch: string;           // e.g., "4.6", "4.4", "stable", "lts"
  msv: string;              // Minimum Safe Version
  latestKnown: string;      // Latest version we know about
  lastChecked: string;      // ISO date
  advisoriesChecked: string[]; // List of advisory IDs we've processed
}

export interface MsvCacheEntry {
  productId: string;
  displayName: string;
  vendor: string;
  branches: MsvBranch[];
  dataSources: string[];    // ["vendor_advisory", "nvd", "cisa_kev"]
  confidence: "high" | "medium" | "low" | "none";
  lastUpdated: string;
  notes?: string;
  // v2 fields
  justification?: string;          // Human-readable reason for MSV determination
  cveCount?: number;               // Number of CVEs analyzed
  hasKevCves?: boolean;            // True if any CVEs are in CISA KEV
  sourceResults?: SourceResult[];  // Per-source query results
}

export interface SourceResult {
  source: string;           // e.g., "AppThreat", "CISA KEV"
  queried: boolean;         // Whether this source was actually queried
  cveCount: number;         // Number of CVEs found from this source
  note?: string;            // Additional context (e.g., "no API key")
}

export interface MsvCacheFile {
  version: number;
  lastUpdated: string;
  entries: Record<string, MsvCacheEntry>;
}

// =============================================================================
// Cache Manager
// =============================================================================

export class MsvCache {
  private cachePath: string;
  private cache: MsvCacheFile | null = null;

  constructor(dataDir: string) {
    this.cachePath = resolve(dataDir, "msv-cache.json");

    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }
  }

  private load(): MsvCacheFile {
    if (this.cache) return this.cache;

    if (existsSync(this.cachePath)) {
      try {
        this.cache = JSON.parse(readFileSync(this.cachePath, "utf-8"));
        return this.cache!;
      } catch {
        // Corrupted, create new
      }
    }

    this.cache = {
      version: 1,
      lastUpdated: new Date().toISOString(),
      entries: {},
    };
    return this.cache;
  }

  private save(): void {
    if (!this.cache) return;
    this.cache.lastUpdated = new Date().toISOString();
    writeFileSync(this.cachePath, JSON.stringify(this.cache, null, 2));
  }

  /**
   * Get cached MSV entry for a product
   */
  get(productId: string): MsvCacheEntry | null {
    const cache = this.load();
    return cache.entries[productId] || null;
  }

  /**
   * Update MSV for a product (MSV can only increase)
   */
  update(entry: MsvCacheEntry): void {
    const cache = this.load();
    const existing = cache.entries[entry.productId];

    if (existing) {
      // Merge branches, MSV can only increase
      for (const newBranch of entry.branches) {
        const existingBranch = existing.branches.find(
          (b) => b.branch === newBranch.branch
        );

        if (existingBranch) {
          // Only update if new MSV is higher
          if (this.compareVersions(newBranch.msv, existingBranch.msv) > 0) {
            existingBranch.msv = newBranch.msv;
            existingBranch.lastChecked = newBranch.lastChecked;
          }
          // Always update latest known
          if (this.compareVersions(newBranch.latestKnown, existingBranch.latestKnown) > 0) {
            existingBranch.latestKnown = newBranch.latestKnown;
          }
          // Merge advisories
          existingBranch.advisoriesChecked = [
            ...new Set([
              ...existingBranch.advisoriesChecked,
              ...newBranch.advisoriesChecked,
            ]),
          ];
        } else {
          existing.branches.push(newBranch);
        }
      }

      // Update metadata
      existing.dataSources = [...new Set([...existing.dataSources, ...entry.dataSources])];
      existing.lastUpdated = new Date().toISOString();
      if (entry.confidence && this.confidenceRank(entry.confidence) > this.confidenceRank(existing.confidence)) {
        existing.confidence = entry.confidence;
      }

      // Update v2 fields (always use latest data for these)
      if (entry.justification) {
        existing.justification = entry.justification;
      }
      if (entry.cveCount !== undefined) {
        existing.cveCount = entry.cveCount;
      }
      if (entry.hasKevCves !== undefined) {
        existing.hasKevCves = entry.hasKevCves;
      }
      if (entry.sourceResults && entry.sourceResults.length > 0) {
        existing.sourceResults = entry.sourceResults;
      }
    } else {
      cache.entries[entry.productId] = entry;
    }

    this.save();
  }

  /**
   * Get the primary MSV for a product (highest MSV across all branches)
   */
  getPrimaryMsv(productId: string): { msv: string; branch: string } | null {
    const entry = this.get(productId);
    if (!entry || entry.branches.length === 0) return null;

    let highest = entry.branches[0];
    for (const branch of entry.branches) {
      if (this.compareVersions(branch.msv, highest.msv) > 0) {
        highest = branch;
      }
    }

    return { msv: highest.msv, branch: highest.branch };
  }

  /**
   * Check if we need to refresh data for a product
   */
  needsRefresh(productId: string, maxAgeHours = 24): boolean {
    const entry = this.get(productId);
    if (!entry) return true;

    const lastUpdated = new Date(entry.lastUpdated);
    const ageMs = Date.now() - lastUpdated.getTime();
    const ageHours = ageMs / (1000 * 60 * 60);

    return ageHours > maxAgeHours;
  }

  /**
   * List all cached products
   */
  list(): MsvCacheEntry[] {
    const cache = this.load();
    return Object.values(cache.entries);
  }

  /**
   * Compare two version strings
   */
  private compareVersions(a: string, b: string): number {
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

  private confidenceRank(level: string): number {
    const ranks: Record<string, number> = {
      high: 3,
      medium: 2,
      low: 1,
      none: 0,
    };
    return ranks[level] || 0;
  }
}
