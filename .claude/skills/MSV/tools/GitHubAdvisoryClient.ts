/**
 * GitHubAdvisoryClient.ts - GitHub Advisory Database Client
 *
 * Fetches security advisories from GitHub's GraphQL API (GHSA).
 * URL: https://api.github.com/graphql
 *
 * Authentication: Personal Access Token (PAT) required
 * - Set GITHUB_TOKEN environment variable
 * - Token needs no special scopes for public advisory data
 *
 * Ecosystems supported:
 * - NPM (Node.js)
 * - PIP (Python)
 * - MAVEN (Java)
 * - NUGET (.NET)
 * - RUBYGEMS (Ruby)
 * - COMPOSER (PHP)
 * - GO (Golang)
 * - RUST (Cargo)
 * - And more...
 *
 * Rate limits: 5,000 points/hour for authenticated requests
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

// =============================================================================
// Constants
// =============================================================================

const GITHUB_GRAPHQL_URL = "https://api.github.com/graphql";
const REQUEST_TIMEOUT_MS = 30000;

// =============================================================================
// Types
// =============================================================================

export type GhsaEcosystem =
  | "NPM"
  | "PIP"
  | "MAVEN"
  | "NUGET"
  | "RUBYGEMS"
  | "COMPOSER"
  | "GO"
  | "RUST"
  | "ERLANG"
  | "SWIFT"
  | "PUB"
  | "HEX";

export type GhsaSeverity = "CRITICAL" | "HIGH" | "MODERATE" | "LOW";

export interface GhsaAdvisory {
  ghsaId: string;            // e.g., "GHSA-xxxx-xxxx-xxxx"
  cveId: string | null;      // e.g., "CVE-2025-12345"
  summary: string;
  description: string;
  severity: GhsaSeverity;
  cvssScore: number | null;
  cvssVector: string | null;
  publishedAt: string;
  updatedAt: string;
  withdrawnAt: string | null;
  references: string[];
  cwes: string[];
}

export interface GhsaVulnerability {
  advisory: GhsaAdvisory;
  package: {
    name: string;
    ecosystem: GhsaEcosystem;
  };
  vulnerableVersionRange: string;  // e.g., "< 2.0.0" or ">= 1.0.0, < 1.5.0"
  firstPatchedVersion: string | null;
}

export interface GhsaQueryResult {
  vulnerabilities: GhsaVulnerability[];
  pageInfo: {
    hasNextPage: boolean;
    endCursor: string | null;
  };
  rateLimitRemaining: number;
  rateLimitReset: string;
}

interface GraphQLResponse {
  data?: {
    securityVulnerabilities?: {
      edges: Array<{
        cursor: string;
        node: {
          advisory: {
            ghsaId: string;
            cveId?: string;
            summary: string;
            description: string;
            severity: GhsaSeverity;
            cvss?: {
              score: number;
              vectorString: string;
            };
            publishedAt: string;
            updatedAt: string;
            withdrawnAt?: string;
            references: Array<{ url: string }>;
            cwes: { nodes: Array<{ cweId: string }> };
          };
          firstPatchedVersion?: { identifier: string };
          package: {
            name: string;
            ecosystem: GhsaEcosystem;
          };
          vulnerableVersionRange: string;
        };
      }>;
      pageInfo: {
        hasNextPage: boolean;
        endCursor: string | null;
      };
    };
    rateLimit?: {
      remaining: number;
      resetAt: string;
      cost: number;
    };
  };
  errors?: Array<{ message: string }>;
}

interface CacheEntry {
  data: GhsaQueryResult;
  expiresAt: string;
}

// =============================================================================
// GitHub Advisory Client
// =============================================================================

export class GitHubAdvisoryClient {
  private cacheDir: string;
  private cacheDurationMs = 2 * 60 * 60 * 1000; // 2 hours
  private token: string | null;

  constructor(cacheDir: string, token?: string) {
    this.cacheDir = cacheDir;
    this.token = token || process.env.GITHUB_TOKEN || null;

    if (!existsSync(cacheDir)) {
      mkdirSync(cacheDir, { recursive: true });
    }
  }

  /**
   * Check if API token is configured
   */
  hasToken(): boolean {
    return !!this.token;
  }

  /**
   * Query vulnerabilities by ecosystem and optional package name
   */
  async queryByEcosystem(
    ecosystem: GhsaEcosystem,
    packageName?: string,
    severities?: GhsaSeverity[],
    limit: number = 50
  ): Promise<GhsaQueryResult> {
    const cacheKey = `ghsa-${ecosystem.toLowerCase()}${packageName ? `-${packageName}` : ""}`;
    const cached = this.getCache(cacheKey);
    if (cached) return cached;

    if (!this.hasToken()) {
      return {
        vulnerabilities: [],
        pageInfo: { hasNextPage: false, endCursor: null },
        rateLimitRemaining: 0,
        rateLimitReset: new Date().toISOString(),
      };
    }

    const result = await this.executeQuery(ecosystem, packageName, severities, limit);
    this.setCache(cacheKey, result);
    return result;
  }

  /**
   * Query vulnerabilities for a specific package
   */
  async queryByPackage(
    ecosystem: GhsaEcosystem,
    packageName: string
  ): Promise<GhsaVulnerability[]> {
    const result = await this.queryByEcosystem(ecosystem, packageName);
    return result.vulnerabilities;
  }

  /**
   * Get MSV (minimum safe version) for a package
   */
  async getMsv(
    ecosystem: GhsaEcosystem,
    packageName: string
  ): Promise<{ msv: string | null; vulnerabilities: number }> {
    const vulns = await this.queryByPackage(ecosystem, packageName);

    if (vulns.length === 0) {
      return { msv: null, vulnerabilities: 0 };
    }

    // Find highest patched version
    let msv: string | null = null;
    for (const vuln of vulns) {
      if (vuln.firstPatchedVersion) {
        if (!msv || this.compareVersions(vuln.firstPatchedVersion, msv) > 0) {
          msv = vuln.firstPatchedVersion;
        }
      }
    }

    return { msv, vulnerabilities: vulns.length };
  }

  /**
   * Execute GraphQL query
   */
  private async executeQuery(
    ecosystem: GhsaEcosystem,
    packageName?: string,
    severities?: GhsaSeverity[],
    limit: number = 50,
    cursor?: string
  ): Promise<GhsaQueryResult> {
    const query = `
      query($ecosystem: SecurityAdvisoryEcosystem!, $package: String, $first: Int!, $after: String, $severities: [SecurityAdvisorySeverity!]) {
        securityVulnerabilities(
          ecosystem: $ecosystem
          package: $package
          first: $first
          after: $after
          severities: $severities
        ) {
          edges {
            cursor
            node {
              advisory {
                ghsaId
                cveId
                summary
                description
                severity
                cvss {
                  score
                  vectorString
                }
                publishedAt
                updatedAt
                withdrawnAt
                references { url }
                cwes { nodes { cweId } }
              }
              firstPatchedVersion { identifier }
              package { name ecosystem }
              vulnerableVersionRange
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
        rateLimit {
          remaining
          resetAt
          cost
        }
      }
    `;

    const variables: Record<string, unknown> = {
      ecosystem,
      first: Math.min(limit, 100),
    };

    if (packageName) {
      variables.package = packageName;
    }
    if (severities && severities.length > 0) {
      variables.severities = severities;
    }
    if (cursor) {
      variables.after = cursor;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(GITHUB_GRAPHQL_URL, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Authorization": `bearer ${this.token}`,
          "Content-Type": "application/json",
          "User-Agent": "MSV-Skill/1.3 (GitHub Advisory Client)",
        },
        body: JSON.stringify({ query, variables }),
      });

      if (!response.ok) {
        throw new Error(`GitHub API failed: ${response.status}`);
      }

      const json = await response.json() as GraphQLResponse;

      if (json.errors && json.errors.length > 0) {
        throw new Error(`GraphQL error: ${json.errors[0].message}`);
      }

      const data = json.data?.securityVulnerabilities;
      const rateLimit = json.data?.rateLimit;

      const vulnerabilities = (data?.edges || []).map(edge => this.parseVulnerability(edge.node));

      return {
        vulnerabilities,
        pageInfo: {
          hasNextPage: data?.pageInfo.hasNextPage || false,
          endCursor: data?.pageInfo.endCursor || null,
        },
        rateLimitRemaining: rateLimit?.remaining || 0,
        rateLimitReset: rateLimit?.resetAt || new Date().toISOString(),
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Parse vulnerability from GraphQL response
   */
  private parseVulnerability(node: GraphQLResponse["data"]["securityVulnerabilities"]["edges"][0]["node"]): GhsaVulnerability {
    const advisory = node.advisory;

    return {
      advisory: {
        ghsaId: advisory.ghsaId,
        cveId: advisory.cveId || null,
        summary: advisory.summary,
        description: advisory.description,
        severity: advisory.severity,
        cvssScore: advisory.cvss?.score || null,
        cvssVector: advisory.cvss?.vectorString || null,
        publishedAt: advisory.publishedAt,
        updatedAt: advisory.updatedAt,
        withdrawnAt: advisory.withdrawnAt || null,
        references: advisory.references.map(r => r.url),
        cwes: advisory.cwes?.nodes?.map(c => c.cweId) || [],
      },
      package: {
        name: node.package.name,
        ecosystem: node.package.ecosystem,
      },
      vulnerableVersionRange: node.vulnerableVersionRange,
      firstPatchedVersion: node.firstPatchedVersion?.identifier || null,
    };
  }

  /**
   * Compare semantic versions
   */
  private compareVersions(a: string, b: string): number {
    const partsA = a.replace(/^[v=]/, "").split(".").map(p => parseInt(p, 10) || 0);
    const partsB = b.replace(/^[v=]/, "").split(".").map(p => parseInt(p, 10) || 0);
    const maxLen = Math.max(partsA.length, partsB.length);

    for (let i = 0; i < maxLen; i++) {
      const partA = partsA[i] || 0;
      const partB = partsB[i] || 0;
      if (partA !== partB) return partA - partB;
    }
    return 0;
  }

  // =============================================================================
  // Cache Management
  // =============================================================================

  private getCachePath(key: string): string {
    return resolve(this.cacheDir, `${key}.json`);
  }

  private getCache(key: string): GhsaQueryResult | null {
    const path = this.getCachePath(key);
    if (!existsSync(path)) return null;

    try {
      const entry: CacheEntry = JSON.parse(readFileSync(path, "utf-8"));
      if (new Date(entry.expiresAt) > new Date()) {
        return entry.data;
      }
    } catch {
      // Corrupted cache
    }
    return null;
  }

  private setCache(key: string, data: GhsaQueryResult): void {
    const entry: CacheEntry = {
      data,
      expiresAt: new Date(Date.now() + this.cacheDurationMs).toISOString(),
    };
    writeFileSync(this.getCachePath(key), JSON.stringify(entry, null, 2));
  }
}

// =============================================================================
// Convenience Functions
// =============================================================================

/**
 * Get MSV for an npm package
 */
export async function getNpmMsv(
  cacheDir: string,
  packageName: string,
  token?: string
): Promise<{ msv: string | null; vulnerabilities: number }> {
  const client = new GitHubAdvisoryClient(cacheDir, token);
  return client.getMsv("NPM", packageName);
}

/**
 * Get MSV for a Python (pip) package
 */
export async function getPipMsv(
  cacheDir: string,
  packageName: string,
  token?: string
): Promise<{ msv: string | null; vulnerabilities: number }> {
  const client = new GitHubAdvisoryClient(cacheDir, token);
  return client.getMsv("PIP", packageName);
}

/**
 * Get MSV for a Maven package
 */
export async function getMavenMsv(
  cacheDir: string,
  packageName: string,
  token?: string
): Promise<{ msv: string | null; vulnerabilities: number }> {
  const client = new GitHubAdvisoryClient(cacheDir, token);
  return client.getMsv("MAVEN", packageName);
}

/**
 * Query GitHub advisories by ecosystem
 */
export async function queryGhsaByEcosystem(
  cacheDir: string,
  ecosystem: GhsaEcosystem,
  packageName?: string,
  token?: string
): Promise<GhsaQueryResult> {
  const client = new GitHubAdvisoryClient(cacheDir, token);
  return client.queryByEcosystem(ecosystem, packageName);
}
