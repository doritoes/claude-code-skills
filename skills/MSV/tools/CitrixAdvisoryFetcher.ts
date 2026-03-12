/**
 * CitrixAdvisoryFetcher.ts - Citrix Security Advisory Fetcher
 *
 * Fetches security advisories from Citrix support portal using:
 * 1. Sitemap discovery (sitemap_1.xml + sitemap_2.xml) to find security bulletins
 * 2. Server-rendered /external/article/ pages for parsing (not the broken SPA)
 *
 * Parses JSON-LD metadata, embedded flexDetails JS objects, and HTML sections
 * for CVEs, severity, affected products, and fixed versions.
 *
 * No API key required.
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

// =============================================================================
// Constants
// =============================================================================

const CITRIX_BASE = "https://support.citrix.com";
const SITEMAP_INDEX = `${CITRIX_BASE}/sitemap.xml`;
const REQUEST_TIMEOUT_MS = 30000;
const MAX_CONCURRENT_FETCHES = 5;
const MAX_BULLETINS_TO_FETCH = 100; // Safety cap on individual article fetches

// Security-related slug keywords for sitemap filtering
const SECURITY_SLUG_KEYWORDS = [
  "security-bulletin",
  "security-advisory",
  "security-update",
  "security-patch",
  "security-hotfix",
  "cve-",
  "vulnerability",
];

// =============================================================================
// Types
// =============================================================================

export interface CitrixVulnerability {
  bulletinId: string;         // e.g., "CTX693420"
  title: string;
  severity: "critical" | "high" | "medium" | "low";
  cveIds: string[];
  affectedProducts: string[];
  fixedVersions: string[];
  publishedDate: string;
  url: string;
  cvssScore?: number;
}

export interface CitrixAdvisoryResult {
  vulnerabilities: CitrixVulnerability[];
  msvByProduct: Record<string, string>;
  lastUpdated: string;
  source: string;
}

interface CacheEntry {
  data: CitrixAdvisoryResult;
  expiresAt: string;
}

interface SitemapUrl {
  loc: string;
  ctxId: string;
}

// =============================================================================
// Citrix Product Mappings
// =============================================================================

const CITRIX_PRODUCTS: Record<string, string[]> = {
  "netscaler": ["NetScaler", "Citrix ADC", "NetScaler ADC"],
  "netscaler_gateway": ["NetScaler Gateway", "Citrix Gateway"],
  "xenserver": ["XenServer", "Citrix Hypervisor"],
  "xenapp": ["XenApp"],
  "xendesktop": ["XenDesktop", "Virtual Apps and Desktops"],
  "citrix_workspace": ["Workspace App", "Citrix Receiver"],
  "sharefile": ["ShareFile"],
  "storefront": ["StoreFront"],
  "provisioning": ["Provisioning Services", "PVS"],
  "sd_wan": ["SD-WAN", "Citrix SD-WAN"],
};

// =============================================================================
// Citrix Advisory Fetcher
// =============================================================================

export class CitrixAdvisoryFetcher {
  private cacheDir: string;
  private cacheDurationMs = 4 * 60 * 60 * 1000; // 4 hours
  private product: string;

  constructor(cacheDir: string, product: string = "all") {
    this.cacheDir = cacheDir;
    this.product = product.toLowerCase();
    if (!existsSync(cacheDir)) {
      mkdirSync(cacheDir, { recursive: true });
    }
  }

  /**
   * Fetch Citrix security bulletins via sitemap discovery + article parsing
   */
  async fetch(): Promise<CitrixAdvisoryResult> {
    const cacheKey = `citrix-${this.product}`;
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

    // Phase 1: Discover security bulletin URLs from sitemap
    const bulletinUrls = await this.discoverBulletins();

    // Phase 2: Fetch and parse individual bulletins
    const vulnerabilities = await this.fetchBulletins(bulletinUrls);

    // Filter by product if specified
    const filteredVulns = this.product === "all"
      ? vulnerabilities
      : this.filterByProduct(vulnerabilities);

    // Calculate MSV per product
    const msvByProduct = this.calculateMsv(filteredVulns);

    const result: CitrixAdvisoryResult = {
      vulnerabilities: filteredVulns,
      msvByProduct,
      lastUpdated: new Date().toISOString(),
      source: SITEMAP_INDEX,
    };

    // Cache result
    const entry: CacheEntry = {
      data: result,
      expiresAt: new Date(Date.now() + this.cacheDurationMs).toISOString(),
    };
    writeFileSync(cachePath, JSON.stringify(entry, null, 2));

    return result;
  }

  // ===========================================================================
  // Phase 1: Sitemap Discovery
  // ===========================================================================

  /**
   * Discover security bulletin URLs from Citrix sitemaps
   */
  private async discoverBulletins(): Promise<SitemapUrl[]> {
    // Fetch sitemap index to get child sitemap URLs
    const indexXml = await this.fetchText(SITEMAP_INDEX);
    const sitemapUrls = this.extractSitemapUrls(indexXml);

    // Fetch all child sitemaps
    const allUrls: SitemapUrl[] = [];
    for (const sitemapUrl of sitemapUrls) {
      try {
        const xml = await this.fetchText(sitemapUrl);
        const urls = this.extractArticleUrls(xml);
        allUrls.push(...urls);
      } catch (err) {
        // Skip broken sitemaps
      }
    }

    // Filter to security-related articles by slug keywords
    const securityUrls = allUrls.filter(u => {
      const slug = u.loc.toLowerCase();
      return SECURITY_SLUG_KEYWORDS.some(kw => slug.includes(kw));
    });

    // Cap to prevent excessive fetching
    return securityUrls.slice(0, MAX_BULLETINS_TO_FETCH);
  }

  /**
   * Extract child sitemap URLs from sitemap index XML
   */
  private extractSitemapUrls(xml: string): string[] {
    const urls: string[] = [];
    const pattern = /<loc>\s*(https?:\/\/[^<]+sitemap[^<]*\.xml)\s*<\/loc>/gi;
    let match;
    while ((match = pattern.exec(xml)) !== null) {
      urls.push(match[1].trim());
    }
    return urls;
  }

  /**
   * Extract article URLs and CTX IDs from a sitemap XML
   */
  private extractArticleUrls(xml: string): SitemapUrl[] {
    const urls: SitemapUrl[] = [];
    const pattern = /<loc>\s*(https?:\/\/[^<]*\/external\/article\/(CTX\d+)\/[^<]*)\s*<\/loc>/gi;
    let match;
    while ((match = pattern.exec(xml)) !== null) {
      urls.push({ loc: match[1].trim(), ctxId: match[2] });
    }
    return urls;
  }

  // ===========================================================================
  // Phase 2: Article Parsing
  // ===========================================================================

  /**
   * Fetch and parse individual security bulletins with concurrency control
   */
  private async fetchBulletins(urls: SitemapUrl[]): Promise<CitrixVulnerability[]> {
    const vulns: CitrixVulnerability[] = [];

    // Process in batches for concurrency control
    for (let i = 0; i < urls.length; i += MAX_CONCURRENT_FETCHES) {
      const batch = urls.slice(i, i + MAX_CONCURRENT_FETCHES);
      const results = await Promise.allSettled(
        batch.map(u => this.parseBulletin(u))
      );

      for (const result of results) {
        if (result.status === "fulfilled" && result.value) {
          vulns.push(result.value);
        }
      }
    }

    // Sort by published date descending
    vulns.sort((a, b) => {
      const dateA = new Date(a.publishedDate).getTime() || 0;
      const dateB = new Date(b.publishedDate).getTime() || 0;
      return dateB - dateA;
    });

    return vulns;
  }

  /**
   * Parse a single security bulletin page
   */
  private async parseBulletin(url: SitemapUrl): Promise<CitrixVulnerability | null> {
    try {
      const html = await this.fetchText(url.loc);

      // Extract CVE IDs from full page
      const cvePattern = /CVE-\d{4}-\d{4,7}/gi;
      const cveMatches = html.match(cvePattern) || [];
      const cveIds = [...new Set(cveMatches.map(c => c.toUpperCase()))];

      // Extract title from JSON-LD or <h1>/<h2>
      const title = this.extractTitle(html, url.ctxId);

      // Extract severity from flexDetails kbFlexMapValueList
      const severity = this.extractSeverity(html);

      // Extract published date from JSON-LD or #date_time
      const publishedDate = this.extractDate(html);

      // Extract affected products from title, body, and JSON-LD
      const affectedProducts = this.extractProducts(html);

      // Extract fixed versions from description/resolution sections
      const fixedVersions = this.extractFixedVersions(html);

      // Extract CVSS score if present in body text
      const cvssScore = this.extractCvssScore(html);

      // Skip non-security bulletins that slipped through slug filter
      const titleLower = title.toLowerCase();

      // Exclude known non-vulnerability article types
      if (titleLower.includes("validation report") ||
          titleLower.includes("applying security hotfixes") ||
          titleLower.includes("how to") ||
          titleLower.includes("mitigating")) {
        return null;
      }

      // Require: "Security Bulletin/Advisory" in title OR has CVEs + "security" keyword
      const isSecurityBulletin =
        titleLower.includes("security bulletin") ||
        titleLower.includes("security advisory") ||
        titleLower.includes("security update") ||
        html.includes('"articleTypeName":"Security Bulletin"') ||
        (cveIds.length > 0 && titleLower.includes("security")) ||
        (cveIds.length > 0 && titleLower.includes("vulnerability"));

      if (!isSecurityBulletin) return null;

      return {
        bulletinId: url.ctxId,
        title,
        severity,
        cveIds,
        affectedProducts,
        fixedVersions,
        publishedDate,
        url: url.loc,
        cvssScore,
      };
    } catch {
      return null;
    }
  }

  /**
   * Extract title from JSON-LD or HTML headings
   */
  private extractTitle(html: string, ctxId: string): string {
    // Try JSON-LD first
    const jsonLd = this.extractJsonLd(html);
    if (jsonLd?.headline) return jsonLd.headline;

    // Try <h1> or <h2 class="wolken-h3">
    const h1Match = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
    if (h1Match) return h1Match[1].trim();

    const h2Match = html.match(/<h2[^>]*class="wolken-h3"[^>]*>([^<]+)<\/h2>/i);
    if (h2Match) return h2Match[1].trim();

    return `Citrix Security Bulletin ${ctxId}`;
  }

  /**
   * Extract severity from flexDetails embedded JS or body text
   */
  private extractSeverity(html: string): CitrixVulnerability["severity"] {
    // flexDetails is inside JSON.parse('...') — the attributeName and lovName are
    // separated by flexAttributeLOVList array, so use a broader pattern
    // Look for: "attributeName":"Severity" ... "lovName":"Critical" (with LOV list in between)
    const flexMatch = html.match(/"attributeName"\s*:\s*"Severity"[\s\S]*?"lovName"\s*:\s*"([^"]+)"/i);
    if (flexMatch) {
      const sev = flexMatch[1].toLowerCase();
      if (sev.includes("critical")) return "critical";
      if (sev.includes("high")) return "high";
      if (sev.includes("medium") || sev.includes("moderate")) return "medium";
      if (sev.includes("low")) return "low";
    }

    // Fallback: CVSS score in body text (e.g., "CVSSv4 8.4")
    const cvssMatch = html.match(/CVSS[v\d.]*\s*(?:score[:\s]*)?\s*(\d+\.\d+)/i);
    if (cvssMatch) {
      const score = parseFloat(cvssMatch[1]);
      if (score >= 9.0) return "critical";
      if (score >= 7.0) return "high";
      if (score >= 4.0) return "medium";
      return "low";
    }

    // Fallback: text patterns in body
    const lower = html.toLowerCase();
    if (lower.includes("severity: critical") || lower.includes("severity:critical")) return "critical";
    if (lower.includes("severity: high") || lower.includes("severity:high")) return "high";
    if (lower.includes("severity: medium") || lower.includes("severity:medium")) return "medium";
    if (lower.includes("severity: low") || lower.includes("severity:low")) return "low";

    return "medium";
  }

  /**
   * Extract published date from JSON-LD or JS var d = '...' literal
   */
  private extractDate(html: string): string {
    // Try JSON-LD first (most reliable)
    const jsonLd = this.extractJsonLd(html);
    if (jsonLd?.datePublished) {
      return this.parseFlexDate(jsonLd.datePublished);
    }

    // #date_time is empty in source HTML — date is set by JS: var d = 'MM-DD-YYYY HH:mm'
    const jsDateMatch = html.match(/var\s+d\s*=\s*'(\d{1,2}-\d{1,2}-\d{4}[^']*)'/);
    if (jsDateMatch) {
      return this.parseFlexDate(jsDateMatch[1]);
    }

    // Changelog table in #additionalInfo often has ISO dates (YYYY-MM-DD)
    const changelogMatch = html.match(/id="additionalInfo"[\s\S]*?(\d{4}-\d{2}-\d{2})/);
    if (changelogMatch) {
      return changelogMatch[1];
    }

    // Last resort: use a far-past sentinel so unknown dates sort to the bottom
    return "1970-01-01";
  }

  /**
   * Parse Citrix date formats (MM-DD-YYYY, MM-DD-YYYY HH:MM) to YYYY-MM-DD
   */
  private parseFlexDate(dateStr: string): string {
    // MM-DD-YYYY or MM-DD-YYYY HH:MM
    const mdyMatch = dateStr.match(/(\d{1,2})-(\d{1,2})-(\d{4})/);
    if (mdyMatch) {
      const [, month, day, year] = mdyMatch;
      return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
    }

    // ISO format passthrough
    if (dateStr.match(/\d{4}-\d{2}-\d{2}/)) {
      return dateStr.split("T")[0];
    }

    try {
      const d = new Date(dateStr);
      if (!isNaN(d.getTime())) return d.toISOString().split("T")[0];
    } catch {}

    return new Date().toISOString().split("T")[0];
  }

  /**
   * Extract affected products from JSON-LD name field and headline only.
   * Avoids full-body regex which picks up every mention (changelog, links, etc.)
   */
  private extractProducts(html: string): string[] {
    const products = new Set<string>();

    // JSON-LD name field (array of product names) — most reliable
    const jsonLd = this.extractJsonLd(html);
    if (jsonLd?.name) {
      const names = Array.isArray(jsonLd.name) ? jsonLd.name : [jsonLd.name];
      for (const n of names) {
        if (typeof n === "string" && n.length > 0) {
          products.add(n);
        }
      }
    }

    // JSON-LD keywords (e.g., ["Security Bulletin", "NetScaler"])
    // Filter out support portal categories that aren't product names
    const KEYWORD_BLOCKLIST = new Set([
      "security bulletin", "security advisory", "security update",
      "problem solution", "reference", "customer service article",
      "how to", "known issue", "alert",
    ]);
    if (jsonLd?.keywords) {
      const kws = Array.isArray(jsonLd.keywords) ? jsonLd.keywords : [];
      for (const kw of kws) {
        if (typeof kw === "string" && kw.length > 0 && !KEYWORD_BLOCKLIST.has(kw.toLowerCase())) {
          products.add(kw);
        }
      }
    }

    // Extract from headline/title only (not full body)
    const headline = jsonLd?.headline || "";
    const productPatterns = [
      /NetScaler\s*(?:ADC|Gateway|Console|Agent)?/gi,
      /Citrix\s*(?:ADC|Gateway|Hypervisor|Workspace\s*App|Virtual\s*Apps\s*and\s*Desktops?|SD-WAN|Secure\s*Access\s*Client|Session\s*Recording)/gi,
      /XenServer/gi,
      /StoreFront/gi,
      /ShareFile/gi,
    ];

    for (const pattern of productPatterns) {
      const matches = headline.match(pattern);
      if (matches) {
        for (const m of matches) {
          products.add(m.trim());
        }
      }
    }

    return [...products];
  }

  /**
   * Extract fixed versions from description and introduction sections.
   * Note: There is NO #resolution section on Citrix pages — only
   * #description, #introduction, #environment, #additionalInfo.
   */
  private extractFixedVersions(html: string): string[] {
    const versions = new Set<string>();

    // Extract content from description and introduction sections
    const sectionPattern = /id="(?:description|introduction)"[\s\S]*?<div[^>]*class="article-detail-card-content[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi;
    let sectionMatch;
    const sectionText: string[] = [];
    while ((sectionMatch = sectionPattern.exec(html)) !== null) {
      sectionText.push(sectionMatch[1]);
    }

    const text = sectionText.join("\n");

    if (text.length > 0) {
      // Look for version patterns near "fix" / "upgrade" / "later" context
      const fixedPatterns = [
        // "NetScaler ADC 14.1-29.72 and later" or "upgrade to 13.1-55.36"
        /(?:upgrade\s+to|fixed\s+in|later\s+than|and\s+later|or\s+later)[^\d]{0,30}(\d+\.\d+(?:\.\d+)*(?:-\d+(?:\.\d+)*)?)(?=\s|<|$|,|;)/gi,
        /(\d+\.\d+(?:\.\d+)*(?:-\d+(?:\.\d+)*)?)(?:\s+and\s+later|\s+or\s+later)/gi,
        // Table cells with version numbers after a "Fixed" header row
        /(?:fixed|remediated|patched)[^<]*<\/(?:td|th|p)>[\s\S]*?<(?:td|p)[^>]*>\s*(\d+\.\d+(?:\.\d+)*(?:-\d+(?:\.\d+)*)?)(?=\s|<)/gi,
      ];

      for (const pattern of fixedPatterns) {
        let match;
        while ((match = pattern.exec(text)) !== null) {
          const v = match[1];
          if (this.isValidVersion(v)) {
            versions.add(v);
          }
        }
      }
    }

    // Fallback: search broader body for explicit fix patterns (no greedy version scraping)
    if (versions.size === 0) {
      const fixedPatterns = [
        /(?:fixed\s+in|upgrade\s+to|updated?\s+to|patched\s+in|remediated\s+in)\s+(?:version\s+)?(\d+\.\d+(?:\.\d+)*(?:-\d+(?:\.\d+)*)?)(?=\s|<|$|,)/gi,
        /(\d+\.\d+(?:\.\d+)*(?:-\d+(?:\.\d+)*)?)(?:\s+and\s+later|\s+or\s+later)/gi,
      ];

      for (const pattern of fixedPatterns) {
        let match;
        while ((match = pattern.exec(html)) !== null) {
          const v = match[1];
          if (this.isValidVersion(v)) {
            versions.add(v);
          }
        }
      }
    }

    return [...versions].sort((a, b) => this.compareVersions(a, b));
  }

  /**
   * Extract CVSS score from body text
   */
  private extractCvssScore(html: string): number | undefined {
    // Look for CVSS score patterns
    const patterns = [
      /CVSS[^0-9]*?(\d+\.\d+)/i,
      /score[^0-9]*?(\d+\.\d+)\s*(?:\/\s*10)?/i,
    ];

    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match) {
        const score = parseFloat(match[1]);
        if (score >= 0 && score <= 10) return score;
      }
    }

    return undefined;
  }

  /**
   * Extract JSON-LD metadata from page
   */
  private extractJsonLd(html: string): any | null {
    const match = html.match(/<script\s+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/i);
    if (!match) return null;

    try {
      return JSON.parse(match[1]);
    } catch {
      return null;
    }
  }

  /**
   * Check if a version string is valid (not a year, CVE number, etc.)
   */
  private isValidVersion(version: string): boolean {
    const parts = version.split(/[.-]/);
    if (parts.length < 2) return false;

    const major = parseInt(parts[0], 10);
    // Filter out years
    if (major >= 2020 && major <= 2030 && parts.length <= 2) return false;
    // Filter out very small numbers that are likely noise
    if (major === 0 && parts.length === 2) return false;

    return true;
  }

  // ===========================================================================
  // Filtering and MSV Calculation
  // ===========================================================================

  /**
   * Filter vulnerabilities by product
   */
  private filterByProduct(vulns: CitrixVulnerability[]): CitrixVulnerability[] {
    const productNames = CITRIX_PRODUCTS[this.product] || [this.product];

    return vulns.filter(vuln => {
      return vuln.affectedProducts.some(prod => {
        const prodLower = prod.toLowerCase();
        return productNames.some(name => prodLower.includes(name.toLowerCase()));
      });
    });
  }

  /**
   * Calculate minimum safe version per product
   */
  private calculateMsv(vulns: CitrixVulnerability[]): Record<string, string> {
    const productVersions = new Map<string, string[]>();

    for (const vuln of vulns) {
      for (const product of vuln.affectedProducts) {
        const productKey = this.normalizeProductName(product);
        if (!productKey) continue; // Skip empty product names
        for (const version of vuln.fixedVersions) {
          if (!productVersions.has(productKey)) {
            productVersions.set(productKey, []);
          }
          productVersions.get(productKey)!.push(version);
        }
      }
    }

    const msv: Record<string, string> = {};
    for (const [product, versions] of productVersions) {
      versions.sort((a, b) => this.compareVersions(a, b));
      if (versions.length > 0) {
        msv[product] = versions[versions.length - 1];
      }
    }

    return msv;
  }

  /**
   * Normalize product name
   */
  private normalizeProductName(name: string): string {
    return name
      .toLowerCase()
      .replace(/citrix\s*/i, "")
      .replace(/[^a-z0-9]/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_|_$/g, "");
  }

  /**
   * Compare version strings (handles Citrix format like 14.1-29.72)
   */
  private compareVersions(a: string, b: string): number {
    if (!a || !b) return 0;

    // Split on . and - to handle versions like 14.1-29.72
    const partsA = a.split(/[.-]/).map(p => parseInt(p, 10) || 0);
    const partsB = b.split(/[.-]/).map(p => parseInt(p, 10) || 0);
    const maxLen = Math.max(partsA.length, partsB.length);

    for (let i = 0; i < maxLen; i++) {
      const partA = partsA[i] || 0;
      const partB = partsB[i] || 0;
      if (partA !== partB) return partA - partB;
    }
    return 0;
  }

  // ===========================================================================
  // HTTP Helpers
  // ===========================================================================

  /**
   * Fetch a URL and return text content
   */
  private async fetchText(url: string): Promise<string> {
    const response = await fetch(url, {
      headers: {
        "Accept": "text/html, application/xml, text/xml",
        "User-Agent": "MSV-Skill/1.0 (PAI Infrastructure)",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`Citrix fetch error: ${response.status} ${response.statusText} (${url})`);
    }

    return response.text();
  }
}

// =============================================================================
// CLI Testing
// =============================================================================

if (import.meta.main) {
  const dataDir = resolve(import.meta.dir, "..", "data");
  const product = process.argv[2] || "all";
  const fetcher = new CitrixAdvisoryFetcher(dataDir, product);

  console.log(`Fetching Citrix security bulletins for: ${product}...`);

  try {
    const result = await fetcher.fetch();
    console.log(`\nFound ${result.vulnerabilities.length} security bulletins`);
    console.log(`Source: ${result.source}`);

    if (Object.keys(result.msvByProduct).length > 0) {
      console.log("\nMinimum Safe Versions:");
      for (const [prod, version] of Object.entries(result.msvByProduct)) {
        console.log(`  ${prod}: ${version}`);
      }
    }

    if (result.vulnerabilities.length > 0) {
      console.log("\nRecent bulletins:");
      for (const vuln of result.vulnerabilities.slice(0, 10)) {
        console.log(`  ${vuln.bulletinId}: ${vuln.title.slice(0, 80)}${vuln.title.length > 80 ? "..." : ""}`);
        console.log(`    Severity: ${vuln.severity}, CVEs: ${vuln.cveIds.join(", ") || "N/A"}`);
        console.log(`    Products: ${vuln.affectedProducts.join(", ") || "N/A"}`);
        if (vuln.fixedVersions.length > 0) {
          console.log(`    Fixed in: ${vuln.fixedVersions.join(", ")}`);
        }
      }
    }
  } catch (error) {
    console.error("Error:", error);
  }
}
