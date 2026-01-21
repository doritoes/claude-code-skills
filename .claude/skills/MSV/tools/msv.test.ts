/**
 * msv.test.ts - Test suite for MSV Skill
 *
 * Run with: bun test msv.test.ts
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import {
  parseVersion,
  compareVersions,
  isVersionInRange,
  evaluateExpression,
  sortVersions,
  findMinimumSafeVersion,
  isVersionVulnerable,
  normalizeVersion,
} from "./VersionCompare";

// =============================================================================
// VersionCompare Tests
// =============================================================================

describe("VersionCompare", () => {
  describe("parseVersion", () => {
    test("parses standard semver", () => {
      const v = parseVersion("1.2.3");
      expect(v.parts).toEqual([1, 2, 3]);
      expect(v.original).toBe("1.2.3");
    });

    test("parses Chrome-style version", () => {
      const v = parseVersion("122.0.6261.94");
      expect(v.parts).toEqual([122, 0, 6261, 94]);
    });

    test("parses Windows build version", () => {
      const v = parseVersion("10.0.22621.3880");
      expect(v.parts).toEqual([10, 0, 22621, 3880]);
    });

    test("parses KB version", () => {
      const v = parseVersion("KB5034204");
      expect(v.isKb).toBe(true);
      expect(v.kbNumber).toBe(5034204);
    });

    test("handles leading v", () => {
      const v = parseVersion("v2.1.0");
      expect(v.parts).toEqual([2, 1, 0]);
    });

    test("parses prerelease suffix", () => {
      const v = parseVersion("1.0.0-beta");
      expect(v.parts).toEqual([1, 0, 0]);
      expect(v.prerelease).toBe("beta");
    });
  });

  describe("compareVersions", () => {
    test("equal versions return 0", () => {
      expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    });

    test("lower version returns -1", () => {
      expect(compareVersions("1.0.0", "2.0.0")).toBe(-1);
      expect(compareVersions("1.0.0", "1.1.0")).toBe(-1);
      expect(compareVersions("1.0.0", "1.0.1")).toBe(-1);
    });

    test("higher version returns 1", () => {
      expect(compareVersions("2.0.0", "1.0.0")).toBe(1);
      expect(compareVersions("1.1.0", "1.0.0")).toBe(1);
      expect(compareVersions("1.0.1", "1.0.0")).toBe(1);
    });

    test("handles different length versions", () => {
      expect(compareVersions("1.0", "1.0.0")).toBe(0);
      expect(compareVersions("1.0.0.1", "1.0.0")).toBe(1);
    });

    test("prerelease is lower than release", () => {
      expect(compareVersions("1.0.0-alpha", "1.0.0")).toBe(-1);
      expect(compareVersions("1.0.0", "1.0.0-beta")).toBe(1);
    });

    test("compares KB versions", () => {
      expect(compareVersions("KB5034204", "KB5034205")).toBe(-1);
      expect(compareVersions("KB5034205", "KB5034204")).toBe(1);
    });

    test("Chrome-style versions", () => {
      expect(compareVersions("122.0.6261.94", "122.0.6261.95")).toBe(-1);
      expect(compareVersions("123.0.0.0", "122.0.6261.94")).toBe(1);
    });
  });

  describe("evaluateExpression", () => {
    test("less than", () => {
      expect(evaluateExpression("1.0.0", "< 2.0.0")).toBe(true);
      expect(evaluateExpression("2.0.0", "< 2.0.0")).toBe(false);
    });

    test("less than or equal", () => {
      expect(evaluateExpression("2.0.0", "<= 2.0.0")).toBe(true);
      expect(evaluateExpression("2.0.1", "<= 2.0.0")).toBe(false);
    });

    test("greater than", () => {
      expect(evaluateExpression("2.0.0", "> 1.0.0")).toBe(true);
      expect(evaluateExpression("1.0.0", "> 2.0.0")).toBe(false);
    });

    test("greater than or equal", () => {
      expect(evaluateExpression("2.0.0", ">= 2.0.0")).toBe(true);
      expect(evaluateExpression("1.9.9", ">= 2.0.0")).toBe(false);
    });

    test("equal", () => {
      expect(evaluateExpression("2.0.0", "= 2.0.0")).toBe(true);
      expect(evaluateExpression("2.0.0", "== 2.0.0")).toBe(true);
      expect(evaluateExpression("2.0.1", "= 2.0.0")).toBe(false);
    });

    test("not equal", () => {
      expect(evaluateExpression("2.0.0", "!= 1.0.0")).toBe(true);
      expect(evaluateExpression("2.0.0", "!= 2.0.0")).toBe(false);
    });
  });

  describe("isVersionInRange", () => {
    test("within start and end", () => {
      expect(isVersionInRange("1.5.0", { start: "1.0.0", end: "2.0.0" })).toBe(true);
    });

    test("outside range", () => {
      expect(isVersionInRange("0.5.0", { start: "1.0.0", end: "2.0.0" })).toBe(false);
      expect(isVersionInRange("2.5.0", { start: "1.0.0", end: "2.0.0" })).toBe(false);
    });

    test("uses expression when provided", () => {
      expect(isVersionInRange("1.5.0", { expression: "< 2.0.0" })).toBe(true);
    });
  });

  describe("sortVersions", () => {
    test("sorts in ascending order", () => {
      const versions = ["2.0.0", "1.0.0", "1.5.0", "3.0.0"];
      expect(sortVersions(versions)).toEqual(["1.0.0", "1.5.0", "2.0.0", "3.0.0"]);
    });

    test("does not mutate original array", () => {
      const versions = ["2.0.0", "1.0.0"];
      sortVersions(versions);
      expect(versions).toEqual(["2.0.0", "1.0.0"]);
    });
  });

  describe("findMinimumSafeVersion", () => {
    test("returns highest fixed version", () => {
      const fixedVersions = ["1.0.1", "1.0.5", "1.0.3"];
      expect(findMinimumSafeVersion(fixedVersions)).toBe("1.0.5");
    });

    test("returns null for empty array", () => {
      expect(findMinimumSafeVersion([])).toBeNull();
    });
  });

  describe("isVersionVulnerable", () => {
    test("vulnerable if below MSV", () => {
      expect(isVersionVulnerable("1.0.0", ["1.0.5", "1.0.3"])).toBe(true);
    });

    test("not vulnerable if at or above MSV", () => {
      expect(isVersionVulnerable("1.0.5", ["1.0.5", "1.0.3"])).toBe(false);
      expect(isVersionVulnerable("2.0.0", ["1.0.5", "1.0.3"])).toBe(false);
    });

    test("not vulnerable if no fixed versions", () => {
      expect(isVersionVulnerable("1.0.0", [])).toBe(false);
    });
  });

  describe("normalizeVersion", () => {
    test("normalizes standard versions", () => {
      expect(normalizeVersion("v1.2.3")).toBe("1.2.3");
    });

    test("normalizes KB versions", () => {
      expect(normalizeVersion("kb5034204")).toBe("KB5034204");
    });
  });
});

// =============================================================================
// Integration Tests (require network)
// =============================================================================

import { CisaKevClient } from "./CisaKevClient";
import { EpssClient } from "./EpssClient";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const TEST_CACHE_DIR = resolve(import.meta.dir, "..", "data", "test-cache-integration");
const NETWORK_TIMEOUT_MS = 60000; // 60 seconds for network tests

describe("Integration", () => {
  // Setup: ensure test cache directory exists
  beforeAll(() => {
    if (!existsSync(TEST_CACHE_DIR)) {
      mkdirSync(TEST_CACHE_DIR, { recursive: true });
    }
  });

  // Cleanup: remove test cache directory
  afterAll(() => {
    try {
      if (existsSync(TEST_CACHE_DIR)) {
        rmSync(TEST_CACHE_DIR, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup errors
    }
  });

  test("CISA KEV fetch works", async () => {
    const client = new CisaKevClient(TEST_CACHE_DIR);

    // Fetch the catalog
    const catalog = await client.fetchCatalog();

    // Verify catalog structure
    expect(catalog).toHaveProperty("title");
    expect(catalog).toHaveProperty("catalogVersion");
    expect(catalog).toHaveProperty("count");
    expect(catalog).toHaveProperty("vulnerabilities");
    expect(Array.isArray(catalog.vulnerabilities)).toBe(true);

    // KEV should have hundreds of entries
    expect(catalog.count).toBeGreaterThan(100);

    // Test findByCve with a well-known CVE (Log4j)
    const log4j = await client.findByCve("CVE-2021-44228");
    expect(log4j).not.toBeNull();
    expect(log4j?.cveID).toBe("CVE-2021-44228");
    expect(log4j?.vendorProject).toMatch(/apache/i);

    // Test getStats
    const stats = await client.getStats();
    expect(stats.totalCount).toBeGreaterThan(100);
    expect(stats.ransomwareCount).toBeGreaterThan(0);

    // Test Admiralty rating
    const rating = client.getAdmiraltyRating();
    expect(rating.reliability).toBe("A");
    expect(rating.credibility).toBe(1);
  }, NETWORK_TIMEOUT_MS);

  test("EPSS fetch works", async () => {
    const client = new EpssClient(TEST_CACHE_DIR);

    // Test with a well-known CVE (Log4j - should have high EPSS)
    const score = await client.getScore("CVE-2021-44228");

    // Verify score structure
    expect(score).not.toBeNull();
    expect(score?.cve).toBe("CVE-2021-44228");
    expect(typeof score?.epss).toBe("number");
    expect(typeof score?.percentile).toBe("number");
    expect(typeof score?.date).toBe("string");

    // EPSS should be between 0 and 1
    expect(score?.epss).toBeGreaterThanOrEqual(0);
    expect(score?.epss).toBeLessThanOrEqual(1);

    // Percentile should be between 0 and 1
    expect(score?.percentile).toBeGreaterThanOrEqual(0);
    expect(score?.percentile).toBeLessThanOrEqual(1);

    // Log4j should be high risk (EPSS > 0.1)
    expect(client.isHighRisk(score!)).toBe(true);

    // Test batch query
    const scores = await client.getScores([
      "CVE-2021-44228",
      "CVE-2021-45046",
    ]);
    expect(scores.length).toBe(2);

    // Test Admiralty rating
    const rating = client.getAdmiraltyRating(score!);
    expect(rating.reliability).toBe("B");
    expect([3, 4]).toContain(rating.credibility);
  }, NETWORK_TIMEOUT_MS);

  test("EPSS returns null for non-existent CVE", async () => {
    const client = new EpssClient(TEST_CACHE_DIR);

    const score = await client.getScore("CVE-9999-99999");
    expect(score).toBeNull();
  }, NETWORK_TIMEOUT_MS);
});
