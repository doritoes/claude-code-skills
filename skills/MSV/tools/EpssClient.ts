/**
 * EpssClient.ts - FIRST.org EPSS (Exploit Prediction Scoring System) Client
 *
 * API Base: https://api.first.org/data/v1/epss
 * No authentication required.
 * Admiralty Rating: B3 (Usually Reliable, Possibly True - Probabilistic)
 *
 * EPSS provides a probability score (0-1) predicting likelihood of
 * exploitation in the next 30 days.
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

// =============================================================================
// Types
// =============================================================================

export interface EpssScore {
  cve: string;
  epss: number;
  percentile: number;
  date: string;
}

interface EpssApiResponse {
  status: string;
  "status-code": number;
  version: string;
  total: number;
  offset: number;
  limit: number;
  data: Array<{
    cve: string;
    epss: string;
    percentile: string;
    date: string;
  }>;
}

interface CacheFile<T> {
  version: number;
  lastUpdated: string;
  expiresAt: string;
  source: string;
  data: T;
}

// =============================================================================
// Constants
// =============================================================================

const EPSS_BASE_URL = "https://api.first.org/data/v1/epss";
const CACHE_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours
const REQUEST_TIMEOUT_MS = 30000; // 30 seconds

// =============================================================================
// Client
// =============================================================================

export class EpssClient {
  private cacheDir: string;

  constructor(cacheDir: string) {
    this.cacheDir = cacheDir;

    if (!existsSync(cacheDir)) {
      mkdirSync(cacheDir, { recursive: true });
    }
  }

  /**
   * Get EPSS score for a single CVE
   */
  async getScore(cveId: string): Promise<EpssScore | null> {
    const cacheKey = `epss-${cveId.replace(/[^a-zA-Z0-9-]/g, "_")}`;
    const cachePath = resolve(this.cacheDir, `${cacheKey}.json`);

    // Check cache
    if (existsSync(cachePath)) {
      try {
        const cached: CacheFile<EpssScore> = JSON.parse(
          readFileSync(cachePath, "utf-8")
        );
        if (new Date(cached.expiresAt) > new Date()) {
          return cached.data;
        }
      } catch {
        // Cache corrupted
      }
    }

    // Fetch from API
    const url = `${EPSS_BASE_URL}?cve=${encodeURIComponent(cveId)}`;
    const response = await fetch(url, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`EPSS API error: ${response.status} ${response.statusText}`);
    }

    const result: EpssApiResponse = await response.json();

    if (!result.data || result.data.length === 0) {
      return null;
    }

    const item = result.data[0];
    const score: EpssScore = {
      cve: item.cve,
      epss: parseFloat(item.epss),
      percentile: parseFloat(item.percentile),
      date: item.date,
    };

    // Cache the result
    const cacheData: CacheFile<EpssScore> = {
      version: 1,
      lastUpdated: new Date().toISOString(),
      expiresAt: new Date(Date.now() + CACHE_DURATION_MS).toISOString(),
      source: url,
      data: score,
    };

    writeFileSync(cachePath, JSON.stringify(cacheData, null, 2));

    return score;
  }

  /**
   * Get EPSS scores for multiple CVEs (batch query, max 30)
   */
  async getScores(cveIds: string[]): Promise<EpssScore[]> {
    if (cveIds.length === 0) return [];
    if (cveIds.length > 30) {
      throw new Error("EPSS batch query limited to 30 CVEs");
    }

    const cveList = cveIds.join(",");
    const url = `${EPSS_BASE_URL}?cve=${encodeURIComponent(cveList)}`;
    const response = await fetch(url, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`EPSS API error: ${response.status} ${response.statusText}`);
    }

    const result: EpssApiResponse = await response.json();

    return (result.data || []).map((item) => ({
      cve: item.cve,
      epss: parseFloat(item.epss),
      percentile: parseFloat(item.percentile),
      date: item.date,
    }));
  }

  /**
   * Check if EPSS score indicates high exploitation likelihood
   * EPSS > 0.5 = likely exploited, > 0.1 = elevated risk
   */
  isHighRisk(score: EpssScore): boolean {
    return score.epss > 0.1;
  }

  isLikelyExploited(score: EpssScore): boolean {
    return score.epss > 0.5;
  }

  /**
   * Get Admiralty rating based on EPSS score
   */
  getAdmiraltyRating(score?: EpssScore): { reliability: "B"; credibility: 3 | 4 } {
    if (score && score.epss > 0.5) {
      return { reliability: "B", credibility: 3 };
    }
    return { reliability: "B", credibility: 4 };
  }
}
