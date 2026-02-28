/**
 * NvdClient.ts - NIST National Vulnerability Database API Client
 *
 * API Base: https://services.nvd.nist.gov/rest/json/cves/2.0
 * No authentication required (rate limited to 5 requests/30 seconds without API key).
 * Admiralty Rating: C3 (Fairly Reliable, Possibly True - Government DB)
 *
 * NVD provides CVE details including affected version ranges via CPE configurations.
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

// =============================================================================
// Types
// =============================================================================

export interface NvdCve {
  id: string;
  sourceIdentifier: string;
  published: string;
  lastModified: string;
  vulnStatus: string;
  descriptions: Array<{ lang: string; value: string }>;
  metrics?: {
    cvssMetricV31?: Array<{
      source: string;
      type: string;
      cvssData: {
        baseScore: number;
        baseSeverity: string;
        vectorString: string;
      };
    }>;
    cvssMetricV30?: Array<{
      source: string;
      type: string;
      cvssData: {
        baseScore: number;
        baseSeverity: string;
      };
    }>;
  };
  configurations?: NvdConfiguration[];
  cisaExploitAdd?: string;
  cisaActionDue?: string;
  cisaRequiredAction?: string;
  cisaVulnerabilityName?: string;
}

export interface NvdConfiguration {
  nodes: NvdNode[];
}

export interface NvdNode {
  operator: string;
  negate: boolean;
  cpeMatch: NvdCpeMatch[];
}

export interface NvdCpeMatch {
  vulnerable: boolean;
  criteria: string;
  versionStartIncluding?: string;
  versionStartExcluding?: string;
  versionEndIncluding?: string;
  versionEndExcluding?: string;
  matchCriteriaId: string;
}

export interface NvdApiResponse {
  resultsPerPage: number;
  startIndex: number;
  totalResults: number;
  vulnerabilities: Array<{ cve: NvdCve }>;
}

export interface VersionInfo {
  cve: string;
  vendor: string;
  product: string;
  fixedVersion: string | null;
  affectedRange: string;
  cvssScore: number | null;
  severity: string | null;
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

const NVD_BASE_URL = "https://services.nvd.nist.gov/rest/json/cves/2.0";
const CACHE_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours
const REQUEST_TIMEOUT_MS = 30000; // 30 seconds

// Rate limit constants (NVD official limits)
// Without API key: 5 requests per 30 seconds
// With API key: 50 requests per 30 seconds
const RATE_LIMIT_WINDOW_MS = 30000; // 30 second window
const RATE_LIMIT_NO_KEY = 5;  // 5 requests per 30 seconds without key
const RATE_LIMIT_WITH_KEY = 50; // 50 requests per 30 seconds with key

// Retry constants
const MAX_RETRIES = 5;
const INITIAL_BACKOFF_MS = 2000; // Start with 2 second delay
const MAX_BACKOFF_MS = 60000; // Max 60 second delay
const BACKOFF_MULTIPLIER = 2;

// =============================================================================
// Rate Limiter (Token Bucket) - SINGLETON for all NvdClient instances
// =============================================================================

class TokenBucketRateLimiter {
  private tokens: number;
  private maxTokens: number;
  private refillRate: number; // tokens per ms
  private lastRefill: number;

  constructor(maxTokens: number, windowMs: number) {
    this.maxTokens = maxTokens;
    this.tokens = maxTokens;
    this.refillRate = maxTokens / windowMs;
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const tokensToAdd = elapsed * this.refillRate;
    this.tokens = Math.min(this.maxTokens, this.tokens + tokensToAdd);
    this.lastRefill = now;
  }

  async acquire(): Promise<void> {
    this.refill();

    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }

    // Wait for token to become available
    const waitTime = Math.ceil((1 - this.tokens) / this.refillRate);
    await new Promise(resolve => setTimeout(resolve, waitTime));
    this.refill();
    this.tokens -= 1;
  }

  getAvailableTokens(): number {
    this.refill();
    return Math.floor(this.tokens);
  }

  /** Reconfigure rate limiter (e.g., when API key detected later) */
  reconfigure(maxTokens: number, windowMs: number): void {
    this.maxTokens = maxTokens;
    this.refillRate = maxTokens / windowMs;
    // Don't reset tokens - keep current state
    this.tokens = Math.min(this.tokens, maxTokens);
  }

  getMaxTokens(): number {
    return this.maxTokens;
  }
}

// Singleton rate limiter - shared across ALL NvdClient instances
// This is critical for proper rate limiting with concurrent requests
let sharedRateLimiter: TokenBucketRateLimiter | null = null;
let rateLimiterApiKeyState: boolean | null = null;

function getSharedRateLimiter(hasApiKey: boolean): TokenBucketRateLimiter {
  const targetLimit = hasApiKey ? RATE_LIMIT_WITH_KEY : RATE_LIMIT_NO_KEY;

  if (!sharedRateLimiter) {
    // First initialization
    sharedRateLimiter = new TokenBucketRateLimiter(targetLimit, RATE_LIMIT_WINDOW_MS);
    rateLimiterApiKeyState = hasApiKey;
  } else if (rateLimiterApiKeyState !== hasApiKey && hasApiKey) {
    // API key was added after initial setup - upgrade limit
    sharedRateLimiter.reconfigure(targetLimit, RATE_LIMIT_WINDOW_MS);
    rateLimiterApiKeyState = hasApiKey;
  }

  return sharedRateLimiter;
}

// =============================================================================
// Client
// =============================================================================

export class NvdClient {
  private cacheDir: string;
  private rateLimiter: TokenBucketRateLimiter;
  private apiKey: string | null;
  private verbose: boolean;

  constructor(cacheDir: string, options?: { verbose?: boolean }) {
    this.cacheDir = cacheDir;
    this.verbose = options?.verbose ?? false;

    // Check for API key in environment
    this.apiKey = process.env.NVD_API_KEY || null;

    // Use SHARED rate limiter (singleton) across all NvdClient instances
    // This ensures concurrent requests from warm/batch operations coordinate properly
    this.rateLimiter = getSharedRateLimiter(!!this.apiKey);

    if (this.verbose && this.apiKey) {
      console.log(`NVD API key detected - using higher rate limit (${this.rateLimiter.getMaxTokens()} req/30s)`);
    }

    if (!existsSync(cacheDir)) {
      mkdirSync(cacheDir, { recursive: true });
    }
  }

  /**
   * Execute a fetch with rate limiting and exponential backoff on 429
   */
  private async fetchWithRetry(url: string, operation: string): Promise<Response> {
    let lastError: Error | null = null;
    let backoffMs = INITIAL_BACKOFF_MS;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      // Wait for rate limit token
      await this.rateLimiter.acquire();

      try {
        const headers: Record<string, string> = {};
        if (this.apiKey) {
          headers["apiKey"] = this.apiKey;
        }

        const response = await fetch(url, {
          headers,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });

        // Success
        if (response.ok) {
          return response;
        }

        // Rate limited - apply exponential backoff
        if (response.status === 429 || response.status === 403) {
          const retryAfter = response.headers.get("Retry-After");
          const waitTime = retryAfter
            ? parseInt(retryAfter, 10) * 1000
            : backoffMs;

          if (this.verbose) {
            console.log(
              `NVD rate limit hit (${response.status}), attempt ${attempt}/${MAX_RETRIES}, ` +
              `waiting ${Math.round(waitTime / 1000)}s before retry...`
            );
          }

          if (attempt < MAX_RETRIES) {
            await new Promise(resolve => setTimeout(resolve, waitTime));
            backoffMs = Math.min(backoffMs * BACKOFF_MULTIPLIER, MAX_BACKOFF_MS);
            continue;
          }
        }

        // Other HTTP errors
        throw new Error(`NVD API error: ${response.status} ${response.statusText}`);
      } catch (error) {
        lastError = error as Error;

        // Network errors - retry with backoff
        if ((error as Error).name === "TimeoutError" ||
            (error as Error).message?.includes("fetch failed")) {
          if (this.verbose) {
            console.log(
              `NVD request timeout/failed for ${operation}, attempt ${attempt}/${MAX_RETRIES}, ` +
              `waiting ${Math.round(backoffMs / 1000)}s before retry...`
            );
          }

          if (attempt < MAX_RETRIES) {
            await new Promise(resolve => setTimeout(resolve, backoffMs));
            backoffMs = Math.min(backoffMs * BACKOFF_MULTIPLIER, MAX_BACKOFF_MS);
            continue;
          }
        }

        throw error;
      }
    }

    throw lastError || new Error(`NVD API failed after ${MAX_RETRIES} retries`);
  }

  /**
   * Get CVE details by CVE ID
   */
  async getCve(cveId: string): Promise<NvdCve | null> {
    const cacheKey = `nvd-cve-${cveId.replace(/[^a-zA-Z0-9-]/g, "_")}`;
    const cachePath = resolve(this.cacheDir, `${cacheKey}.json`);

    // Check cache first
    if (existsSync(cachePath)) {
      try {
        const cached: CacheFile<NvdCve> = JSON.parse(
          readFileSync(cachePath, "utf-8")
        );
        if (new Date(cached.expiresAt) > new Date()) {
          return cached.data;
        }
      } catch {
        // Cache corrupted, fetch fresh
      }
    }

    const url = `${NVD_BASE_URL}?cveId=${encodeURIComponent(cveId)}`;

    // Use rate-limited fetch with retry
    const response = await this.fetchWithRetry(url, `getCve(${cveId})`);
    const result: NvdApiResponse = await response.json();

    if (!result.vulnerabilities || result.vulnerabilities.length === 0) {
      return null;
    }

    const cve = result.vulnerabilities[0].cve;

    // Cache the result
    const cacheData: CacheFile<NvdCve> = {
      version: 1,
      lastUpdated: new Date().toISOString(),
      expiresAt: new Date(Date.now() + CACHE_DURATION_MS).toISOString(),
      source: url,
      data: cve,
    };

    writeFileSync(cachePath, JSON.stringify(cacheData, null, 2));

    return cve;
  }

  /**
   * Extract version information from CVE configurations
   */
  extractVersionInfo(cve: NvdCve, targetVendor?: string, targetProduct?: string): VersionInfo[] {
    const results: VersionInfo[] = [];

    if (!cve.configurations) return results;

    // Get CVSS score
    let cvssScore: number | null = null;
    let severity: string | null = null;
    if (cve.metrics?.cvssMetricV31?.[0]) {
      cvssScore = cve.metrics.cvssMetricV31[0].cvssData.baseScore;
      severity = cve.metrics.cvssMetricV31[0].cvssData.baseSeverity;
    } else if (cve.metrics?.cvssMetricV30?.[0]) {
      cvssScore = cve.metrics.cvssMetricV30[0].cvssData.baseScore;
      severity = cve.metrics.cvssMetricV30[0].cvssData.baseSeverity;
    }

    for (const config of cve.configurations) {
      for (const node of config.nodes) {
        for (const match of node.cpeMatch) {
          if (!match.vulnerable) continue;

          // Parse CPE to get vendor/product
          // Format: cpe:2.3:a:vendor:product:version:...
          const cpeParts = match.criteria.split(":");
          if (cpeParts.length < 5) continue;

          const vendor = cpeParts[3];
          const product = cpeParts[4];

          // Filter by target vendor/product if specified
          if (targetVendor && !vendor.toLowerCase().includes(targetVendor.toLowerCase())) {
            continue;
          }
          if (targetProduct && !product.toLowerCase().includes(targetProduct.toLowerCase())) {
            continue;
          }

          // Determine fixed version and affected range
          let fixedVersion: string | null = null;
          let affectedRange = "";

          if (match.versionEndExcluding) {
            fixedVersion = match.versionEndExcluding;
            if (match.versionStartIncluding) {
              affectedRange = `>= ${match.versionStartIncluding}, < ${match.versionEndExcluding}`;
            } else {
              affectedRange = `< ${match.versionEndExcluding}`;
            }
          } else if (match.versionEndIncluding) {
            // Fixed version is the next version after versionEndIncluding
            // We can't determine exact fixed version, but we know <= this is vulnerable
            affectedRange = `<= ${match.versionEndIncluding}`;
            fixedVersion = `> ${match.versionEndIncluding}`;
          } else {
            // Specific version affected
            const version = cpeParts[5];
            if (version && version !== "*") {
              affectedRange = `= ${version}`;
            } else {
              affectedRange = "all versions";
            }
          }

          results.push({
            cve: cve.id,
            vendor,
            product,
            fixedVersion,
            affectedRange,
            cvssScore,
            severity,
          });
        }
      }
    }

    return results;
  }

  /**
   * Get the minimum safe version for a product from multiple CVEs
   */
  async getMinimumSafeVersion(
    cveIds: string[],
    vendor: string,
    product: string
  ): Promise<{ version: string | null; details: VersionInfo[] }> {
    const allVersionInfo: VersionInfo[] = [];
    const fixedVersions: string[] = [];

    for (const cveId of cveIds) {
      try {
        const cve = await this.getCve(cveId);
        if (!cve) continue;

        const versionInfo = this.extractVersionInfo(cve, vendor, product);
        allVersionInfo.push(...versionInfo);

        for (const info of versionInfo) {
          if (info.fixedVersion && !info.fixedVersion.startsWith(">")) {
            fixedVersions.push(info.fixedVersion);
          }
        }
      } catch (error) {
        // Skip CVEs that fail to fetch
        console.warn(`Failed to fetch ${cveId}: ${(error as Error).message}`);
      }
    }

    // Find the highest fixed version (minimum safe version)
    let minimumSafeVersion: string | null = null;
    if (fixedVersions.length > 0) {
      // Sort versions and get the highest
      fixedVersions.sort((a, b) => {
        const partsA = a.split(".").map((p) => parseInt(p, 10) || 0);
        const partsB = b.split(".").map((p) => parseInt(p, 10) || 0);
        const maxLen = Math.max(partsA.length, partsB.length);
        for (let i = 0; i < maxLen; i++) {
          const partA = partsA[i] || 0;
          const partB = partsB[i] || 0;
          if (partA !== partB) return partA - partB;
        }
        return 0;
      });
      minimumSafeVersion = fixedVersions[fixedVersions.length - 1];
    }

    return { version: minimumSafeVersion, details: allVersionInfo };
  }

  /**
   * Search for CVEs by CPE name
   * NVD API supports cpeName parameter for CPE-based searches
   */
  async searchByCpe(
    cpe23: string,
    options: { maxResults?: number; minCvss?: number } = {}
  ): Promise<Array<{
    cve: string;
    description: string;
    cvssScore: number | null;
    severity: string | null;
    fixedVersion: string | null;
    affectedRange: string;
    published: string;
  }>> {
    const { maxResults = 20, minCvss = 4.0 } = options;
    const results: Array<{
      cve: string;
      description: string;
      cvssScore: number | null;
      severity: string | null;
      fixedVersion: string | null;
      affectedRange: string;
      published: string;
    }> = [];

    // Create cache key from CPE
    const cacheKey = `nvd-cpe-${cpe23.replace(/[^a-zA-Z0-9-]/g, "_")}`;
    const cachePath = resolve(this.cacheDir, `${cacheKey}.json`);

    // Check cache
    if (existsSync(cachePath)) {
      try {
        const cached: CacheFile<NvdApiResponse> = JSON.parse(
          readFileSync(cachePath, "utf-8")
        );
        if (new Date(cached.expiresAt) > new Date()) {
          // Process cached results
          return this.processCpeSearchResults(cached.data, minCvss, maxResults);
        }
      } catch {
        // Cache corrupted, fetch fresh
      }
    }

    // Extract vendor and product from CPE for keyword search
    // CPE format: cpe:2.3:a:vendor:product:version:...
    // Strip CPE 2.3 backslash escapes (e.g., notepad\+\+ → notepad++)
    const cpeParts = cpe23.split(":");
    const vendor = (cpeParts[3] || "").replace(/\\(.)/g, "$1");
    const product = (cpeParts[4] || "").replace(/\\(.)/g, "$1");

    // Use keywordSearch for NVD API queries
    // NVD ANDs multiple keywords, so "vendor product" fails when they're variants
    // of the same name (e.g., "notepad-plus-plus notepad++" → 0 results).
    // Use product alone if it differs from vendor; use vendor if product is just "*"
    let searchKeyword: string;
    if (!product || product === "*") {
      searchKeyword = vendor;
    } else if (vendor && vendor !== product && !product.includes(vendor.replace(/-/g, ""))) {
      // Different names: combine (e.g., "microsoft edge" → both needed)
      searchKeyword = `${vendor} ${product}`;
    } else {
      // Same or similar names: use product only (e.g., "notepad++" is enough)
      searchKeyword = product;
    }
    const url = `${NVD_BASE_URL}?keywordSearch=${encodeURIComponent(searchKeyword)}&resultsPerPage=${maxResults}`;

    // Use rate-limited fetch with retry
    const response = await this.fetchWithRetry(url, `searchByCpe(${searchKeyword})`);
    const result: NvdApiResponse = await response.json();

    // Cache the result
    const cacheData: CacheFile<NvdApiResponse> = {
      version: 1,
      lastUpdated: new Date().toISOString(),
      expiresAt: new Date(Date.now() + CACHE_DURATION_MS).toISOString(),
      source: url,
      data: result,
    };

    writeFileSync(cachePath, JSON.stringify(cacheData, null, 2));

    return this.processCpeSearchResults(result, minCvss, maxResults);
  }

  /**
   * Process NVD API response into structured CVE results
   */
  private processCpeSearchResults(
    result: NvdApiResponse,
    minCvss: number,
    maxResults: number
  ): Array<{
    cve: string;
    description: string;
    cvssScore: number | null;
    severity: string | null;
    fixedVersion: string | null;
    affectedRange: string;
    published: string;
  }> {
    const results: Array<{
      cve: string;
      description: string;
      cvssScore: number | null;
      severity: string | null;
      fixedVersion: string | null;
      affectedRange: string;
      published: string;
    }> = [];

    if (!result.vulnerabilities) return results;

    for (const vuln of result.vulnerabilities) {
      const cve = vuln.cve;

      // Get CVSS score
      let cvssScore: number | null = null;
      let severity: string | null = null;
      if (cve.metrics?.cvssMetricV31?.[0]) {
        cvssScore = cve.metrics.cvssMetricV31[0].cvssData.baseScore;
        severity = cve.metrics.cvssMetricV31[0].cvssData.baseSeverity;
      } else if (cve.metrics?.cvssMetricV30?.[0]) {
        cvssScore = cve.metrics.cvssMetricV30[0].cvssData.baseScore;
        severity = cve.metrics.cvssMetricV30[0].cvssData.baseSeverity;
      }

      // Filter by minimum CVSS (medium and above = 4.0+)
      if (cvssScore !== null && cvssScore < minCvss) {
        continue;
      }

      // Get description
      const description = cve.descriptions?.find(d => d.lang === "en")?.value || "No description available";

      // Extract version info from configurations
      let fixedVersion: string | null = null;
      let affectedRange = "unknown";

      if (cve.configurations) {
        for (const config of cve.configurations) {
          for (const node of config.nodes) {
            for (const match of node.cpeMatch) {
              if (!match.vulnerable) continue;

              if (match.versionEndExcluding) {
                fixedVersion = match.versionEndExcluding;
                if (match.versionStartIncluding) {
                  affectedRange = `>= ${match.versionStartIncluding}, < ${match.versionEndExcluding}`;
                } else {
                  affectedRange = `< ${match.versionEndExcluding}`;
                }
              } else if (match.versionEndIncluding) {
                affectedRange = `<= ${match.versionEndIncluding}`;
                fixedVersion = `> ${match.versionEndIncluding}`;
              }
            }
          }
        }
      }

      results.push({
        cve: cve.id,
        description,
        cvssScore,
        severity,
        fixedVersion,
        affectedRange,
        published: cve.published,
      });

      if (results.length >= maxResults) break;
    }

    // Sort by CVSS score descending (most critical first)
    results.sort((a, b) => (b.cvssScore || 0) - (a.cvssScore || 0));

    return results;
  }

  /**
   * Get rate limit status for monitoring
   */
  getRateLimitStatus(): {
    hasApiKey: boolean;
    maxRequestsPer30s: number;
    availableTokens: number;
  } {
    return {
      hasApiKey: !!this.apiKey,
      maxRequestsPer30s: this.apiKey ? RATE_LIMIT_WITH_KEY : RATE_LIMIT_NO_KEY,
      availableTokens: this.rateLimiter.getAvailableTokens(),
    };
  }

  /**
   * Get Admiralty rating for NVD source
   */
  getAdmiraltyRating(): { reliability: "C"; credibility: 3 } {
    return { reliability: "C", credibility: 3 };
  }
}
