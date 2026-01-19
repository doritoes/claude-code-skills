/**
 * MsrcAdvisoryFetcher.ts - Microsoft Security Response Center Advisory Fetcher
 *
 * Fetches security advisories from Microsoft's MSRC CVRF API.
 * API: https://api.msrc.microsoft.com/cvrf/v3.0/
 *
 * No API key required. Returns CVRF/JSON format with full CVE details.
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

// =============================================================================
// Constants
// =============================================================================

const MSRC_API_BASE = "https://api.msrc.microsoft.com/cvrf/v3.0";
const REQUEST_TIMEOUT_MS = 30000;

// =============================================================================
// Types
// =============================================================================

export interface MsrcAdvisory {
  cveId: string;
  cveTitle: string;
  severity: "Critical" | "Important" | "Moderate" | "Low" | "Unknown";
  impact: string;
  affectedProducts: string[];
  fixedVersions: string[];
  kbArticles: string[];
  releaseDate: string;
  exploited: boolean;
  exploitedInWild: boolean;
}

export interface MsrcProductResult {
  product: string;
  advisories: MsrcAdvisory[];
  msv: string | null;
  lastUpdated: string;
}

interface CacheEntry {
  data: MsrcProductResult;
  expiresAt: string;
}

// CVRF API response types
interface CvrfDocument {
  DocumentTitle: string;
  DocumentType: string;
  DocumentPublisher: { Type: number };
  DocumentTracking: {
    Identification: { ID: string };
    Status: string;
    Version: string;
    RevisionHistory: Array<{ Number: string; Date: string; Description: string }>;
    InitialReleaseDate: string;
    CurrentReleaseDate: string;
  };
  DocumentNotes: Array<{ Title: string; Type: number; Ordinal: string; Value: string }>;
  ProductTree: {
    Branch: Array<{
      Type: number;
      Name: string;
      Branch?: Array<{ Type: number; Name: string; Items?: Array<{ ProductID: string; Value: string }> }>;
      Items?: Array<{ ProductID: string; Value: string }>;
    }>;
    FullProductName: Array<{ ProductID: string; Value: string }>;
  };
  Vulnerability: Array<{
    CVE: string;
    Title: { Value: string };
    Notes: Array<{ Title: string; Type: number; Ordinal: string; Value: string }>;
    ProductStatuses: Array<{
      Type: number;
      ProductID: string[];
    }>;
    Threats: Array<{
      Type: number;
      Description: { Value: string };
      ProductID?: string[];
    }>;
    CVSSScoreSets: Array<{
      BaseScore: number;
      TemporalScore?: number;
      Vector?: string;
      ProductID?: string[];
    }>;
    Remediations: Array<{
      Type: number;
      Description: { Value: string };
      URL?: string;
      ProductID?: string[];
      Supercedence?: string;
      RestartRequired?: { Value: string };
      SubType?: string;
    }>;
  }>;
}

// =============================================================================
// Product Mappings
// =============================================================================

// Map MSV catalog product names to MSRC product search terms
const PRODUCT_SEARCH_TERMS: Record<string, string[]> = {
  "edge_chromium": ["Microsoft Edge", "Edge (Chromium-based)"],
  "teams": ["Microsoft Teams"],
  "365_apps": ["Microsoft 365 Apps", "Microsoft Office"],
  "visual_studio_code": ["Visual Studio Code"],
  "onedrive": ["OneDrive"],
  "skype": ["Skype"],
  "windows_powershell": ["Windows PowerShell"],
  "powershell": ["PowerShell"],
};

// =============================================================================
// MSRC Advisory Fetcher
// =============================================================================

export class MsrcAdvisoryFetcher {
  private cacheDir: string;
  private cacheDurationMs = 4 * 60 * 60 * 1000; // 4 hours

  constructor(cacheDir: string) {
    this.cacheDir = cacheDir;
    if (!existsSync(cacheDir)) {
      mkdirSync(cacheDir, { recursive: true });
    }
  }

  /**
   * Get the current month's CVRF document ID (e.g., "2026-Jan")
   */
  private getCurrentMonthId(): string {
    const now = new Date();
    const year = now.getFullYear();
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const month = months[now.getMonth()];
    return `${year}-${month}`;
  }

  /**
   * Get the previous N months' CVRF document IDs
   */
  private getRecentMonthIds(count: number = 3): string[] {
    const ids: string[] = [];
    const now = new Date();
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

    for (let i = 0; i < count; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      ids.push(`${d.getFullYear()}-${months[d.getMonth()]}`);
    }

    return ids;
  }

  /**
   * Fetch CVRF document for a specific month
   */
  private async fetchCvrf(monthId: string): Promise<CvrfDocument | null> {
    const url = `${MSRC_API_BASE}/cvrf/${monthId}`;

    try {
      const response = await fetch(url, {
        headers: {
          "Accept": "application/json",
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        if (response.status === 404) {
          // Month not released yet
          return null;
        }
        throw new Error(`MSRC API error: ${response.status} ${response.statusText}`);
      }

      return await response.json() as CvrfDocument;
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new Error(`MSRC API timeout for ${monthId}`);
      }
      throw error;
    }
  }

  /**
   * Extract advisories for a specific product from CVRF document
   */
  private extractProductAdvisories(cvrf: CvrfDocument, productTerms: string[]): MsrcAdvisory[] {
    const advisories: MsrcAdvisory[] = [];

    // Build product ID to name mapping
    const productMap = new Map<string, string>();
    for (const product of cvrf.ProductTree.FullProductName) {
      productMap.set(product.ProductID, product.Value);
    }

    // Find product IDs matching our search terms
    const matchingProductIds = new Set<string>();
    for (const [id, name] of productMap) {
      const nameLower = name.toLowerCase();
      for (const term of productTerms) {
        if (nameLower.includes(term.toLowerCase())) {
          matchingProductIds.add(id);
          break;
        }
      }
    }

    if (matchingProductIds.size === 0) {
      return advisories;
    }

    // Extract vulnerabilities affecting matching products
    for (const vuln of cvrf.Vulnerability) {
      // Check if any product status includes our products
      let affectsProduct = false;
      const affectedProductNames: string[] = [];

      for (const status of vuln.ProductStatuses || []) {
        for (const pid of status.ProductID || []) {
          if (matchingProductIds.has(pid)) {
            affectsProduct = true;
            const productName = productMap.get(pid);
            if (productName && !affectedProductNames.includes(productName)) {
              affectedProductNames.push(productName);
            }
          }
        }
      }

      if (!affectsProduct) continue;

      // Extract severity
      let severity: MsrcAdvisory["severity"] = "Unknown";
      for (const threat of vuln.Threats || []) {
        if (threat.Type === 3) { // Severity type
          const desc = threat.Description?.Value?.toLowerCase() || "";
          if (desc.includes("critical")) severity = "Critical";
          else if (desc.includes("important")) severity = "Important";
          else if (desc.includes("moderate")) severity = "Moderate";
          else if (desc.includes("low")) severity = "Low";
        }
      }

      // Check exploitation status
      let exploited = false;
      let exploitedInWild = false;
      for (const threat of vuln.Threats || []) {
        if (threat.Type === 1) { // Exploit status type
          const desc = threat.Description?.Value?.toLowerCase() || "";
          if (desc.includes("exploited") && desc.includes("yes")) {
            exploited = true;
            exploitedInWild = true;
          }
        }
      }

      // Extract KB articles
      const kbArticles: string[] = [];
      const fixedVersions: string[] = [];
      for (const remediation of vuln.Remediations || []) {
        if (remediation.Description?.Value) {
          // Extract KB number
          const kbMatch = remediation.Description.Value.match(/KB(\d+)/i);
          if (kbMatch && !kbArticles.includes(kbMatch[0])) {
            kbArticles.push(kbMatch[0]);
          }
        }
        // Extract version from URL if present
        if (remediation.URL) {
          const versionMatch = remediation.URL.match(/(\d+\.\d+\.\d+(?:\.\d+)?)/);
          if (versionMatch && !fixedVersions.includes(versionMatch[1])) {
            fixedVersions.push(versionMatch[1]);
          }
        }
      }

      // Get impact type
      let impact = "";
      for (const threat of vuln.Threats || []) {
        if (threat.Type === 0) { // Impact type
          impact = threat.Description?.Value || "";
        }
      }

      advisories.push({
        cveId: vuln.CVE,
        cveTitle: vuln.Title?.Value || "",
        severity,
        impact,
        affectedProducts: affectedProductNames,
        fixedVersions,
        kbArticles,
        releaseDate: cvrf.DocumentTracking.CurrentReleaseDate,
        exploited,
        exploitedInWild,
      });
    }

    return advisories;
  }

  /**
   * Fetch advisories for a Microsoft product
   */
  async fetchProductAdvisories(product: string): Promise<MsrcProductResult> {
    const cacheKey = `msrc-${product}`;
    const cachePath = resolve(this.cacheDir, `${cacheKey}.json`);

    // Check cache
    if (existsSync(cachePath)) {
      try {
        const entry: CacheEntry = JSON.parse(readFileSync(cachePath, "utf-8"));
        if (new Date(entry.expiresAt) > new Date()) {
          return entry.data;
        }
      } catch {
        // Corrupted cache
      }
    }

    const productTerms = PRODUCT_SEARCH_TERMS[product] || [product];
    const allAdvisories: MsrcAdvisory[] = [];

    // Fetch recent months
    const monthIds = this.getRecentMonthIds(3);

    for (const monthId of monthIds) {
      try {
        const cvrf = await this.fetchCvrf(monthId);
        if (cvrf) {
          const monthAdvisories = this.extractProductAdvisories(cvrf, productTerms);
          allAdvisories.push(...monthAdvisories);
        }
      } catch (error) {
        // Continue with other months
        console.warn(`Failed to fetch MSRC ${monthId}:`, error);
      }
    }

    // Calculate MSV from fixed versions
    let msv: string | null = null;
    const fixedVersions = allAdvisories
      .flatMap(a => a.fixedVersions)
      .filter((v, i, arr) => arr.indexOf(v) === i)
      .sort((a, b) => this.compareVersions(b, a)); // Descending

    if (fixedVersions.length > 0) {
      msv = fixedVersions[0]; // Highest version
    }

    const result: MsrcProductResult = {
      product,
      advisories: allAdvisories,
      msv,
      lastUpdated: new Date().toISOString(),
    };

    // Cache result
    const entry: CacheEntry = {
      data: result,
      expiresAt: new Date(Date.now() + this.cacheDurationMs).toISOString(),
    };
    writeFileSync(cachePath, JSON.stringify(entry, null, 2));

    return result;
  }

  /**
   * Get list of updates for a specific month
   */
  async getMonthlyUpdates(monthId?: string): Promise<{ cves: string[]; products: string[] }> {
    const id = monthId || this.getCurrentMonthId();
    const cvrf = await this.fetchCvrf(id);

    if (!cvrf) {
      return { cves: [], products: [] };
    }

    const cves = cvrf.Vulnerability.map(v => v.CVE);
    const products = cvrf.ProductTree.FullProductName.map(p => p.Value);

    return { cves, products: [...new Set(products)] };
  }

  /**
   * Compare version strings
   */
  private compareVersions(a: string, b: string): number {
    const partsA = a.split(".").map(p => parseInt(p, 10) || 0);
    const partsB = b.split(".").map(p => parseInt(p, 10) || 0);
    const maxLen = Math.max(partsA.length, partsB.length);

    for (let i = 0; i < maxLen; i++) {
      const partA = partsA[i] || 0;
      const partB = partsB[i] || 0;
      if (partA !== partB) return partA - partB;
    }
    return 0;
  }
}

// =============================================================================
// CLI Testing
// =============================================================================

if (import.meta.main) {
  const dataDir = resolve(import.meta.dir, "..", "data");
  const fetcher = new MsrcAdvisoryFetcher(dataDir);

  const product = process.argv[2] || "edge_chromium";
  console.log(`Fetching MSRC advisories for: ${product}`);

  try {
    const result = await fetcher.fetchProductAdvisories(product);
    console.log(`\nFound ${result.advisories.length} advisories`);
    console.log(`MSV: ${result.msv || "Not determined"}`);

    if (result.advisories.length > 0) {
      console.log("\nRecent advisories:");
      for (const adv of result.advisories.slice(0, 5)) {
        console.log(`  ${adv.cveId}: ${adv.cveTitle} [${adv.severity}]`);
        if (adv.exploitedInWild) console.log(`    ⚠️  Exploited in the wild!`);
      }
    }
  } catch (error) {
    console.error("Error:", error);
  }
}
