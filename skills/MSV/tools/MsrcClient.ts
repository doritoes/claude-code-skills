/**
 * MsrcClient.ts - Microsoft Security Response Center API Client
 *
 * API Base: https://api.msrc.microsoft.com/cvrf/v3.0
 * No API key required - free public access
 * Admiralty Rating: A2 (Completely Reliable, Probably True - Official Microsoft source)
 *
 * Provides security update information for Microsoft products including:
 * - Office 365, Microsoft 365
 * - Microsoft Edge
 * - Microsoft Teams
 * - Windows OS components
 * - .NET Framework
 * - Visual Studio
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

// =============================================================================
// Types
// =============================================================================

export interface MsrcUpdate {
  ID: string;                    // e.g., "2024-Jan"
  Alias: string;
  DocumentTitle: string;
  Severity: string | null;
  InitialReleaseDate: string;
  CurrentReleaseDate: string;
  CvrfUrl: string;
}

export interface MsrcVulnerability {
  CVE: string;
  Title: string;
  Notes: Array<{
    Title: string;
    Type: number;
    Ordinal: string;
    Value: string;
  }>;
  Threats: Array<{
    Type: number;
    Description: {
      Value: string;
    };
    ProductID: string[];
  }>;
  Remediations: Array<{
    Type: number;
    Description: {
      Value: string;
    };
    URL?: string;
    Supercedence?: string;
    ProductID: string[];
    FixedBuild?: string;
  }>;
  ProductStatuses: Array<{
    Type: number;
    ProductID: string[];
  }>;
  CVSSScoreSets?: Array<{
    BaseScore: number;
    TemporalScore?: number;
    Vector?: string;
    ProductID?: string[];
  }>;
}

export interface MsrcCvrfDocument {
  DocumentTitle: {
    Value: string;
  };
  DocumentType: {
    Value: string;
  };
  DocumentPublisher: {
    Type: number;
    ContactDetails: {
      Value: string;
    };
  };
  DocumentTracking: {
    Identification: {
      ID: {
        Value: string;
      };
      Alias: {
        Value: string;
      };
    };
    Status: number;
    Version: string;
    RevisionHistory: Array<{
      Number: string;
      Date: string;
      Description: {
        Value: string;
      };
    }>;
    InitialReleaseDate: string;
    CurrentReleaseDate: string;
  };
  ProductTree: {
    Branch: Array<{
      Type: number;
      Name: string;
      Items?: Array<{
        ProductID: string;
        Value: string;
      }>;
      Branch?: Array<{
        Type: number;
        Name: string;
        Items: Array<{
          ProductID: string;
          Value: string;
        }>;
      }>;
    }>;
    FullProductName: Array<{
      ProductID: string;
      Value: string;
    }>;
  };
  Vulnerability: MsrcVulnerability[];
}

export interface MsrcVulnResult {
  cveId: string;
  title: string;
  description: string;
  severity: string | null;
  cvssScore: number | null;
  fixedVersion: string | null;
  fixedBuild: string | null;
  affectedProducts: string[];
  publishedDate: string;
  kbArticle: string | null;
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

const MSRC_BASE_URL = "https://api.msrc.microsoft.com/cvrf/v3.0";
const CACHE_DURATION_MS = 6 * 60 * 60 * 1000; // 6 hours
const REQUEST_TIMEOUT_MS = 30000; // 30 seconds

// Product name mappings for filtering MSRC results
const PRODUCT_PATTERNS: Record<string, RegExp> = {
  "edge": /microsoft edge/i,
  "edge_chromium": /microsoft edge.*chromium/i,
  "office": /microsoft (office|365|word|excel|powerpoint|outlook|access)/i,
  "teams": /microsoft teams/i,
  "dotnet": /\.net (framework|core|\d)/i,
  "visual_studio": /visual studio(?! code)/i,
  "visual_studio_code": /visual studio code/i,
  "windows": /windows (10|11|server)/i,
  "exchange": /microsoft exchange/i,
  "sharepoint": /microsoft sharepoint/i,
  "azure": /azure/i,
};

// =============================================================================
// Client
// =============================================================================

export class MsrcClient {
  private cacheDir: string;
  private verbose: boolean;

  constructor(cacheDir: string, options?: { verbose?: boolean }) {
    this.cacheDir = cacheDir;
    this.verbose = options?.verbose ?? false;

    if (!existsSync(cacheDir)) {
      mkdirSync(cacheDir, { recursive: true });
    }
  }

  /**
   * Get list of all available security updates
   */
  async getUpdates(options?: { year?: number }): Promise<MsrcUpdate[]> {
    const cacheKey = options?.year ? `msrc-updates-${options.year}` : "msrc-updates";
    const cachePath = resolve(this.cacheDir, `${cacheKey}.json`);

    // Check cache
    if (existsSync(cachePath)) {
      try {
        const cached: CacheFile<MsrcUpdate[]> = JSON.parse(
          readFileSync(cachePath, "utf-8")
        );
        if (new Date(cached.expiresAt) > new Date()) {
          return cached.data;
        }
      } catch {
        // Cache corrupted
      }
    }

    // Build URL
    let url = `${MSRC_BASE_URL}/updates`;
    if (options?.year) {
      url += `('${options.year}')`;
    }

    if (this.verbose) {
      console.log(`Fetching MSRC updates from ${url}...`);
    }

    const response = await fetch(url, {
      headers: {
        "Accept": "application/json",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`MSRC API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    const updates: MsrcUpdate[] = data.value || [];

    // Cache the result
    const cacheData: CacheFile<MsrcUpdate[]> = {
      version: 1,
      lastUpdated: new Date().toISOString(),
      expiresAt: new Date(Date.now() + CACHE_DURATION_MS).toISOString(),
      source: url,
      data: updates,
    };

    writeFileSync(cachePath, JSON.stringify(cacheData, null, 2));

    return updates;
  }

  /**
   * Get CVRF document for a specific update (e.g., "2024-Jan")
   */
  async getCvrfDocument(updateId: string): Promise<MsrcCvrfDocument> {
    const cacheKey = `msrc-cvrf-${updateId.replace(/[^a-zA-Z0-9-]/g, "_")}`;
    const cachePath = resolve(this.cacheDir, `${cacheKey}.json`);

    // Check cache
    if (existsSync(cachePath)) {
      try {
        const cached: CacheFile<MsrcCvrfDocument> = JSON.parse(
          readFileSync(cachePath, "utf-8")
        );
        if (new Date(cached.expiresAt) > new Date()) {
          return cached.data;
        }
      } catch {
        // Cache corrupted
      }
    }

    const url = `${MSRC_BASE_URL}/cvrf/${updateId}`;

    if (this.verbose) {
      console.log(`Fetching MSRC CVRF document for ${updateId}...`);
    }

    const response = await fetch(url, {
      headers: {
        "Accept": "application/json",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`MSRC CVRF API error: ${response.status} ${response.statusText}`);
    }

    const document: MsrcCvrfDocument = await response.json();

    // Cache the result
    const cacheData: CacheFile<MsrcCvrfDocument> = {
      version: 1,
      lastUpdated: new Date().toISOString(),
      expiresAt: new Date(Date.now() + CACHE_DURATION_MS).toISOString(),
      source: url,
      data: document,
    };

    writeFileSync(cachePath, JSON.stringify(cacheData, null, 2));

    return document;
  }

  /**
   * Search for vulnerabilities affecting a specific Microsoft product
   * Returns recent vulnerabilities with fixed version information
   */
  async searchByProduct(
    productKey: string,
    options?: { maxMonths?: number; minCvss?: number }
  ): Promise<MsrcVulnResult[]> {
    const { maxMonths = 12, minCvss = 4.0 } = options || {};
    const results: MsrcVulnResult[] = [];

    // Get product pattern
    const productPattern = PRODUCT_PATTERNS[productKey.toLowerCase()];
    if (!productPattern) {
      if (this.verbose) {
        console.log(`No MSRC product pattern for: ${productKey}`);
      }
      return results;
    }

    // Get recent updates (last N months)
    const updates = await this.getUpdates();
    const now = new Date();
    const cutoffDate = new Date(now);
    cutoffDate.setMonth(cutoffDate.getMonth() - maxMonths);

    const recentUpdates = updates.filter(u => {
      const releaseDate = new Date(u.InitialReleaseDate);
      return releaseDate >= cutoffDate;
    });

    if (this.verbose) {
      console.log(`Searching ${recentUpdates.length} MSRC updates for ${productKey}...`);
    }

    // Fetch CVRF documents and extract vulnerabilities
    for (const update of recentUpdates.slice(0, 6)) { // Limit to last 6 months for speed
      try {
        const cvrf = await this.getCvrfDocument(update.ID);

        // Build product ID to name mapping
        const productMap = new Map<string, string>();
        for (const product of cvrf.ProductTree.FullProductName) {
          productMap.set(product.ProductID, product.Value);
        }

        // Process vulnerabilities
        for (const vuln of cvrf.Vulnerability) {
          // Find affected products matching our pattern
          const affectedProducts: string[] = [];
          for (const status of vuln.ProductStatuses || []) {
            if (!status.ProductID) continue;
            for (const productId of status.ProductID) {
              const productName = productMap.get(productId);
              if (productName && productPattern.test(productName)) {
                affectedProducts.push(productName);
              }
            }
          }

          if (affectedProducts.length === 0) continue;

          // Get CVSS score
          let cvssScore: number | null = null;
          if (vuln.CVSSScoreSets && vuln.CVSSScoreSets.length > 0) {
            cvssScore = vuln.CVSSScoreSets[0].BaseScore;
          }

          // Filter by minimum CVSS
          if (cvssScore !== null && cvssScore < minCvss) continue;

          // Get description from notes
          let description = "";
          const descNote = vuln.Notes?.find(n => n.Type === 1); // Description type
          if (descNote) {
            description = descNote.Value;
          }

          // Get severity from threats
          let severity: string | null = null;
          const severityThreat = vuln.Threats?.find(t => t.Type === 3); // Severity type
          if (severityThreat) {
            severity = severityThreat.Description.Value;
          }

          // Get fixed build/version from remediations
          let fixedBuild: string | null = null;
          let kbArticle: string | null = null;
          for (const remediation of vuln.Remediations || []) {
            if (remediation.FixedBuild) {
              fixedBuild = remediation.FixedBuild;
            }
            if (remediation.URL && remediation.URL.includes("support.microsoft.com")) {
              const kbMatch = remediation.URL.match(/\/(\d{6,})/);
              if (kbMatch) {
                kbArticle = `KB${kbMatch[1]}`;
              }
            }
          }

          // Extract title string - MSRC API returns title as { Value: string } or string
          const titleStr = typeof vuln.Title === "object" && vuln.Title !== null
            ? (vuln.Title as { Value?: string }).Value || ""
            : (vuln.Title as string) || "";

          results.push({
            cveId: vuln.CVE,
            title: titleStr,
            description,
            severity,
            cvssScore,
            fixedVersion: null, // MSRC uses build numbers, not versions
            fixedBuild,
            affectedProducts: [...new Set(affectedProducts)],
            publishedDate: update.InitialReleaseDate,
            kbArticle,
          });
        }
      } catch (error) {
        if (this.verbose) {
          console.log(`Failed to fetch CVRF for ${update.ID}: ${(error as Error).message}`);
        }
      }
    }

    // Sort by CVSS score descending
    results.sort((a, b) => (b.cvssScore || 0) - (a.cvssScore || 0));

    return results;
  }

  /**
   * Get vulnerabilities for a specific CVE ID
   */
  async getCve(cveId: string): Promise<MsrcVulnResult | null> {
    const cacheKey = `msrc-cve-${cveId.replace(/[^a-zA-Z0-9-]/g, "_")}`;
    const cachePath = resolve(this.cacheDir, `${cacheKey}.json`);

    // Check cache
    if (existsSync(cachePath)) {
      try {
        const cached: CacheFile<MsrcVulnResult> = JSON.parse(
          readFileSync(cachePath, "utf-8")
        );
        if (new Date(cached.expiresAt) > new Date()) {
          return cached.data;
        }
      } catch {
        // Cache corrupted
      }
    }

    // Search updates for this CVE
    const url = `${MSRC_BASE_URL}/updates('${cveId}')`;

    try {
      const response = await fetch(url, {
        headers: {
          "Accept": "application/json",
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        return null;
      }

      const data = await response.json();
      const updates: MsrcUpdate[] = data.value || [];

      if (updates.length === 0) {
        return null;
      }

      // Get the CVRF document containing this CVE
      const cvrf = await this.getCvrfDocument(updates[0].ID);

      // Find the vulnerability
      const vuln = cvrf.Vulnerability.find(v => v.CVE === cveId);
      if (!vuln) {
        return null;
      }

      // Build product ID to name mapping
      const productMap = new Map<string, string>();
      for (const product of cvrf.ProductTree.FullProductName) {
        productMap.set(product.ProductID, product.Value);
      }

      // Get affected products
      const affectedProducts: string[] = [];
      for (const status of vuln.ProductStatuses || []) {
        for (const productId of status.ProductID) {
          const productName = productMap.get(productId);
          if (productName) {
            affectedProducts.push(productName);
          }
        }
      }

      // Get CVSS score
      let cvssScore: number | null = null;
      if (vuln.CVSSScoreSets && vuln.CVSSScoreSets.length > 0) {
        cvssScore = vuln.CVSSScoreSets[0].BaseScore;
      }

      // Get description
      let description = "";
      const descNote = vuln.Notes?.find(n => n.Type === 1);
      if (descNote) {
        description = descNote.Value;
      }

      // Get severity
      let severity: string | null = null;
      const severityThreat = vuln.Threats?.find(t => t.Type === 3);
      if (severityThreat) {
        severity = severityThreat.Description.Value;
      }

      // Get fixed build
      let fixedBuild: string | null = null;
      let kbArticle: string | null = null;
      for (const remediation of vuln.Remediations || []) {
        if (remediation.FixedBuild) {
          fixedBuild = remediation.FixedBuild;
        }
        if (remediation.URL && remediation.URL.includes("support.microsoft.com")) {
          const kbMatch = remediation.URL.match(/\/(\d{6,})/);
          if (kbMatch) {
            kbArticle = `KB${kbMatch[1]}`;
          }
        }
      }

      // Extract title string - MSRC API returns title as { Value: string } or string
      const titleStr = typeof vuln.Title === "object" && vuln.Title !== null
        ? (vuln.Title as { Value?: string }).Value || ""
        : (vuln.Title as string) || "";

      const result: MsrcVulnResult = {
        cveId: vuln.CVE,
        title: titleStr,
        description,
        severity,
        cvssScore,
        fixedVersion: null,
        fixedBuild,
        affectedProducts: [...new Set(affectedProducts)],
        publishedDate: updates[0].InitialReleaseDate,
        kbArticle,
      };

      // Cache the result
      const cacheData: CacheFile<MsrcVulnResult> = {
        version: 1,
        lastUpdated: new Date().toISOString(),
        expiresAt: new Date(Date.now() + CACHE_DURATION_MS).toISOString(),
        source: url,
        data: result,
      };

      writeFileSync(cachePath, JSON.stringify(cacheData, null, 2));

      return result;
    } catch {
      return null;
    }
  }

  /**
   * Get Admiralty rating for MSRC source
   */
  getAdmiraltyRating(): { reliability: "A"; credibility: 2 } {
    return { reliability: "A", credibility: 2 };
  }
}
