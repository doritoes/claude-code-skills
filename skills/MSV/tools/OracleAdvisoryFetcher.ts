/**
 * OracleAdvisoryFetcher.ts - Oracle Security Advisory Fetcher
 *
 * Fetches security advisories from Oracle's Critical Patch Update (CPU) pages.
 * Source: https://www.oracle.com/security-alerts/
 *
 * Oracle releases CPUs quarterly (January, April, July, October).
 * No API key required. Parses CVE data from CPU advisory pages.
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

// =============================================================================
// Constants
// =============================================================================

const ORACLE_SECURITY_BASE = "https://www.oracle.com/security-alerts";
const REQUEST_TIMEOUT_MS = 30000;

// CPU release months
const CPU_MONTHS = ["jan", "apr", "jul", "oct"];

// =============================================================================
// Types
// =============================================================================

export interface OracleVulnerability {
  cveId: string;
  product: string;
  component: string;
  protocol: string;
  severity: "critical" | "high" | "medium" | "low";
  cvssScore?: number;
  affectedVersions: string[];
  fixedVersions: string[];
  cpuDate: string;  // e.g., "2025-04"
  url: string;
  exploitable: boolean;
}

export interface OracleAdvisoryResult {
  vulnerabilities: OracleVulnerability[];
  msvByProduct: Record<string, string>;
  lastUpdated: string;
  source: string;
}

interface CacheEntry {
  data: OracleAdvisoryResult;
  expiresAt: string;
}

// =============================================================================
// Oracle Product Mappings
// =============================================================================

const ORACLE_PRODUCTS: Record<string, string[]> = {
  "java": ["Java SE", "Java", "JDK", "JRE", "GraalVM"],
  "database": ["Database", "Oracle Database", "MySQL"],
  "mysql": ["MySQL"],
  "weblogic": ["WebLogic Server", "WebLogic"],
  "fusion_middleware": ["Fusion Middleware"],
  "e_business_suite": ["E-Business Suite", "EBS"],
  "peoplesoft": ["PeopleSoft"],
  "siebel": ["Siebel"],
  "enterprise_manager": ["Enterprise Manager"],
  "virtualbox": ["VirtualBox", "VM VirtualBox"],
  "solaris": ["Solaris"],
  "linux": ["Oracle Linux"],
};

/**
 * Normalize catalog product keys to fetcher product keys.
 * Catalog uses CPE-style names (e.g., "weblogic_server", "adaptive_security_appliance_software")
 * but the fetcher uses short names (e.g., "weblogic", "virtualbox").
 */
const ORACLE_PRODUCT_ALIASES: Record<string, string> = {
  "weblogic_server": "weblogic",
  "vm_virtualbox": "virtualbox",
  "jdk": "java",
  "jre": "java",
  "java_se": "java",
  "graalvm": "java",
  "oracle_database": "database",
  "enterprise_manager_ops_center": "enterprise_manager",
};

// =============================================================================
// Oracle Advisory Fetcher
// =============================================================================

export class OracleAdvisoryFetcher {
  private cacheDir: string;
  private cacheDurationMs = 4 * 60 * 60 * 1000; // 4 hours
  private product: string;

  constructor(cacheDir: string, product: string = "all") {
    this.cacheDir = cacheDir;
    const key = product.toLowerCase();
    this.product = ORACLE_PRODUCT_ALIASES[key] || key;
    if (!existsSync(cacheDir)) {
      mkdirSync(cacheDir, { recursive: true });
    }
  }

  /**
   * Fetch Oracle security advisories
   */
  async fetch(): Promise<OracleAdvisoryResult> {
    const cacheKey = `oracle-${this.product}`;
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

    // Fetch recent CPUs (last 4 quarters)
    const allVulns: OracleVulnerability[] = [];
    const currentYear = new Date().getFullYear();
    const currentMonth = new Date().getMonth(); // 0-indexed

    // Determine which CPUs to fetch
    const cpusToFetch: { year: number; month: string }[] = [];

    for (let i = 0; i < 4; i++) {
      // Go back i quarters
      let targetMonth = currentMonth - (i * 3);
      let targetYear = currentYear;

      while (targetMonth < 0) {
        targetMonth += 12;
        targetYear--;
      }

      // Find the closest CPU month
      const cpuMonthIdx = Math.floor(targetMonth / 3);
      const cpuMonth = CPU_MONTHS[cpuMonthIdx];

      // Avoid duplicates
      const key = `${targetYear}-${cpuMonth}`;
      if (!cpusToFetch.some(c => `${c.year}-${c.month}` === key)) {
        cpusToFetch.push({ year: targetYear, month: cpuMonth });
      }
    }

    // Fetch each CPU
    for (const cpu of cpusToFetch) {
      try {
        const vulns = await this.fetchCpu(cpu.year, cpu.month);
        allVulns.push(...vulns);
      } catch {
        // CPU may not exist yet or fetch failed
      }
    }

    // Filter by product if specified
    const filteredVulns = this.product === "all"
      ? allVulns
      : this.filterByProduct(allVulns);

    // Calculate MSV per product
    const msvByProduct = this.calculateMsv(filteredVulns);

    const result: OracleAdvisoryResult = {
      vulnerabilities: filteredVulns,
      msvByProduct,
      lastUpdated: new Date().toISOString(),
      source: ORACLE_SECURITY_BASE,
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
   * Fetch a specific CPU
   */
  private async fetchCpu(year: number, month: string): Promise<OracleVulnerability[]> {
    const url = `${ORACLE_SECURITY_BASE}/cpu${month}${year}.html`;

    const response = await fetch(url, {
      headers: {
        "Accept": "text/html",
        "User-Agent": "MSV-Skill/1.0 (PAI Infrastructure)",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`Oracle CPU fetch error: ${response.status} for ${url}`);
    }

    const html = await response.text();
    return this.parseCpu(html, year, month, url);
  }

  /**
   * Parse CPU HTML page
   */
  private parseCpu(html: string, year: number, month: string, sourceUrl: string): OracleVulnerability[] {
    const vulns: OracleVulnerability[] = [];
    const cpuDate = `${year}-${this.monthToNumber(month)}`;

    // Extract CVEs from the page
    const cvePattern = /CVE-\d{4}-\d+/gi;
    const cveMatches = [...new Set(html.match(cvePattern) || [])];

    for (const cveId of cveMatches) {
      // Find context around this CVE
      const idx = html.indexOf(cveId);
      if (idx === -1) continue;

      const contextStart = Math.max(0, idx - 500);
      const contextEnd = Math.min(html.length, idx + 1000);
      const context = html.slice(contextStart, contextEnd);

      // Extract product info
      const product = this.extractProduct(context);
      const component = this.extractComponent(context);

      // Extract severity and CVSS
      const { severity, cvssScore } = this.extractSeverity(context);

      // Extract versions
      const affectedVersions = this.extractAffectedVersions(context, product);
      const fixedVersions = this.extractFixedVersions(context, product);

      // Check if remotely exploitable
      const exploitable = this.isRemotelyExploitable(context);

      vulns.push({
        cveId: cveId.toUpperCase(),
        product,
        component,
        protocol: this.extractProtocol(context),
        severity,
        cvssScore,
        affectedVersions,
        fixedVersions,
        cpuDate,
        url: sourceUrl,
        exploitable,
      });
    }

    return vulns;
  }

  /**
   * Convert month name to number
   */
  private monthToNumber(month: string): string {
    const months: Record<string, string> = {
      jan: "01",
      apr: "04",
      jul: "07",
      oct: "10",
    };
    return months[month.toLowerCase()] || "01";
  }

  /**
   * Extract product name from context
   */
  private extractProduct(context: string): string {
    // Check for known Oracle product names
    const productPatterns = [
      /Oracle\s+(Java\s*SE|JDK|JRE|GraalVM)/i,
      /Oracle\s+(Database|MySQL)/i,
      /Oracle\s+(WebLogic\s*Server)/i,
      /Oracle\s+(Fusion\s*Middleware)/i,
      /Oracle\s+(E-Business\s*Suite)/i,
      /Oracle\s+(PeopleSoft)/i,
      /Oracle\s+(Siebel)/i,
      /Oracle\s+(Enterprise\s*Manager)/i,
      /Oracle\s*(VM\s*)?VirtualBox/i,
      /Oracle\s+(Solaris)/i,
      /Oracle\s+(Linux)/i,
    ];

    for (const pattern of productPatterns) {
      const match = context.match(pattern);
      if (match) {
        return match[0].trim();
      }
    }

    return "Oracle Product";
  }

  /**
   * Extract component name from context
   */
  private extractComponent(context: string): string {
    // Look for component patterns
    const componentMatch = context.match(/(?:Component|subcomponent)[:\s]+([^<\n,]+)/i);
    if (componentMatch) {
      return componentMatch[1].trim();
    }
    return "";
  }

  /**
   * Extract protocol from context
   */
  private extractProtocol(context: string): string {
    const protocolPatterns = [
      /protocol[:\s]+(HTTP|HTTPS|T3|T3S|IIOP|JRMP|LDAP|LDAPS)/i,
      /(HTTP|HTTPS|T3|IIOP|Multiple)/i,
    ];

    for (const pattern of protocolPatterns) {
      const match = context.match(pattern);
      if (match) {
        return match[1].toUpperCase();
      }
    }

    return "";
  }

  /**
   * Extract severity and CVSS score
   */
  private extractSeverity(context: string): { severity: OracleVulnerability["severity"]; cvssScore?: number } {
    // Look for CVSS score
    const cvssMatch = context.match(/(?:CVSS|Base\s*Score)[:\s]*(\d+\.?\d*)/i);
    let cvssScore: number | undefined;

    if (cvssMatch) {
      cvssScore = parseFloat(cvssMatch[1]);
    }

    // Determine severity from CVSS or text
    let severity: OracleVulnerability["severity"] = "medium";

    if (cvssScore !== undefined) {
      if (cvssScore >= 9.0) severity = "critical";
      else if (cvssScore >= 7.0) severity = "high";
      else if (cvssScore >= 4.0) severity = "medium";
      else severity = "low";
    } else {
      const lower = context.toLowerCase();
      if (lower.includes("critical")) severity = "critical";
      else if (lower.includes("high")) severity = "high";
      else if (lower.includes("medium") || lower.includes("moderate")) severity = "medium";
      else if (lower.includes("low")) severity = "low";
    }

    return { severity, cvssScore };
  }

  /**
   * Check if vulnerability is remotely exploitable
   */
  private isRemotelyExploitable(context: string): boolean {
    const lower = context.toLowerCase();
    return (
      lower.includes("remotely exploitable") ||
      lower.includes("network") ||
      lower.includes("http") ||
      !lower.includes("local")
    );
  }

  /**
   * Extract affected versions
   */
  private extractAffectedVersions(context: string, product: string): string[] {
    const versions: string[] = [];

    // Java version patterns
    if (product.toLowerCase().includes("java")) {
      const javaVersions = context.match(/(?:JDK|Java\s*SE|Java)\s*(\d+(?:\.\d+)*(?:u\d+)?)/gi);
      if (javaVersions) {
        for (const v of javaVersions) {
          const version = v.match(/(\d+(?:\.\d+)*(?:u\d+)?)/)?.[1];
          if (version && !versions.includes(version)) {
            versions.push(version);
          }
        }
      }
    }

    // VirtualBox version patterns
    if (product.toLowerCase().includes("virtualbox")) {
      const vboxVersions = context.match(/VirtualBox[^0-9]*(\d+\.\d+(?:\.\d+)?)/gi);
      if (vboxVersions) {
        for (const v of vboxVersions) {
          const version = v.match(/(\d+\.\d+(?:\.\d+)?)/)?.[1];
          if (version && !versions.includes(version)) {
            versions.push(version);
          }
        }
      }
    }

    // MySQL version patterns
    if (product.toLowerCase().includes("mysql")) {
      const mysqlVersions = context.match(/MySQL[^0-9]*(\d+\.\d+(?:\.\d+)?)/gi);
      if (mysqlVersions) {
        for (const v of mysqlVersions) {
          const version = v.match(/(\d+\.\d+(?:\.\d+)?)/)?.[1];
          if (version && !versions.includes(version)) {
            versions.push(version);
          }
        }
      }
    }

    // Generic version patterns
    if (versions.length === 0) {
      const genericVersions = context.match(/\b(\d+\.\d+(?:\.\d+)?(?:\.\d+)?)\b/g);
      if (genericVersions) {
        for (const v of genericVersions) {
          if (this.isValidVersion(v) && !versions.includes(v)) {
            versions.push(v);
          }
        }
      }
    }

    return versions;
  }

  /**
   * Extract fixed versions
   */
  private extractFixedVersions(context: string, product: string): string[] {
    const versions: string[] = [];

    // Look for "fixed in" patterns
    const fixedPattern = /(?:fixed|patch|upgrade|update)[^0-9]*(\d+(?:\.\d+)+(?:u\d+)?)/gi;
    const matches = context.matchAll(fixedPattern);

    for (const match of matches) {
      const version = match[1];
      if (this.isValidVersion(version) && !versions.includes(version)) {
        versions.push(version);
      }
    }

    return versions;
  }

  /**
   * Check if a version string is valid
   */
  private isValidVersion(version: string): boolean {
    const parts = version.split(".");
    if (parts.length < 2) return false;

    const major = parseInt(parts[0], 10);
    // Filter out years and other false positives
    if (major >= 2020 && major <= 2030) return false;

    return true;
  }

  /**
   * Filter vulnerabilities by product
   */
  private filterByProduct(vulns: OracleVulnerability[]): OracleVulnerability[] {
    const productNames = ORACLE_PRODUCTS[this.product] || [this.product];

    return vulns.filter(vuln => {
      const prodLower = vuln.product.toLowerCase();
      return productNames.some(name => prodLower.includes(name.toLowerCase()));
    });
  }

  /**
   * Calculate minimum safe version per product
   */
  private calculateMsv(vulns: OracleVulnerability[]): Record<string, string> {
    const productVersions = new Map<string, string[]>();

    for (const vuln of vulns) {
      const productKey = this.normalizeProductName(vuln.product);
      for (const version of vuln.fixedVersions) {
        if (!productVersions.has(productKey)) {
          productVersions.set(productKey, []);
        }
        productVersions.get(productKey)!.push(version);
      }
    }

    const msv: Record<string, string> = {};
    for (const [product, versions] of productVersions) {
      versions.sort((a, b) => this.compareVersions(a, b));
      if (versions.length > 0) {
        msv[product] = versions[versions.length - 1];
      }
    }

    // Fallback: If no versions extracted, use known latest versions
    // These are updated based on Oracle CPU releases
    if (Object.keys(msv).length === 0) {
      const knownLatest: Record<string, Record<string, string>> = {
        java: {
          "java_se_23": "23.0.2",
          "java_se_21": "21.0.6",
          "java_se_17": "17.0.14",
          "java_se_11": "11.0.26",
          "java_se_8": "8u441",
        },
        mysql: {
          "mysql_8.4": "8.4.4",
          "mysql_8.0": "8.0.41",
        },
        virtualbox: {
          "virtualbox_7": "7.1.6",
        },
        weblogic: {
          "weblogic_14": "14.1.2",
          "weblogic_12": "12.2.1.4",
        },
        all: {
          "java_se_23": "23.0.2",
          "java_se_21": "21.0.6",
          "java_se_17": "17.0.14",
          "java_se_11": "11.0.26",
          "java_se_8": "8u441",
          "mysql_8.4": "8.4.4",
          "mysql_8.0": "8.0.41",
          "virtualbox_7": "7.1.6",
        },
      };

      const productVersionMap = knownLatest[this.product] || knownLatest.all || {};
      for (const [key, version] of Object.entries(productVersionMap)) {
        msv[key] = version;
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
      .replace(/oracle\s*/i, "")
      .replace(/[^a-z0-9]/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_|_$/g, "");
  }

  /**
   * Compare version strings
   */
  private compareVersions(a: string, b: string): number {
    if (!a || !b) return 0;

    // Handle Java update notation (e.g., "8u411")
    const parseJavaVersion = (v: string) => {
      const match = v.match(/^(\d+)(?:u(\d+))?/);
      if (match) {
        return { major: parseInt(match[1], 10), update: parseInt(match[2] || "0", 10) };
      }
      return null;
    };

    const javaA = parseJavaVersion(a);
    const javaB = parseJavaVersion(b);

    if (javaA && javaB) {
      if (javaA.major !== javaB.major) return javaA.major - javaB.major;
      return javaA.update - javaB.update;
    }

    // Standard version comparison
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
  const product = process.argv[2] || "all";
  const fetcher = new OracleAdvisoryFetcher(dataDir, product);

  console.log(`Fetching Oracle security advisories for: ${product}...`);

  try {
    const result = await fetcher.fetch();
    console.log(`\nFound ${result.vulnerabilities.length} vulnerabilities`);
    console.log(`Source: ${result.source}`);

    if (Object.keys(result.msvByProduct).length > 0) {
      console.log("\nMinimum Safe Versions:");
      for (const [prod, version] of Object.entries(result.msvByProduct)) {
        console.log(`  ${prod}: ${version}`);
      }
    }

    if (result.vulnerabilities.length > 0) {
      console.log("\nRecent vulnerabilities:");
      for (const vuln of result.vulnerabilities.slice(0, 5)) {
        console.log(`  ${vuln.cveId}: ${vuln.product}`);
        console.log(`    Severity: ${vuln.severity}, CVSS: ${vuln.cvssScore || "N/A"}, CPU: ${vuln.cpuDate}`);
      }
    }
  } catch (error) {
    console.error("Error:", error);
  }
}
