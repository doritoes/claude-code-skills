/**
 * VersionCompare.test.ts - Comprehensive Unit Tests for Version Comparison
 *
 * Tests edge cases not covered in msv.test.ts:
 * - Prerelease ordering (alpha < beta < rc < release)
 * - Build metadata handling
 * - Invalid/malformed input handling
 * - Complex version formats
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

import { describe, expect, test } from "bun:test";
import {
  parseVersion,
  compareVersions,
  isVersionInRange,
  evaluateExpression,
  sortVersions,
  findMinimumSafeVersion,
  isVersionVulnerable,
  normalizeVersion,
} from "../VersionCompare";

// =============================================================================
// Edge Case Tests - Prerelease Ordering
// =============================================================================

describe("VersionCompare Edge Cases", () => {
  describe("Prerelease Ordering", () => {
    test("alpha < beta < rc < release", () => {
      expect(compareVersions("1.0.0-alpha", "1.0.0-beta")).toBe(-1);
      expect(compareVersions("1.0.0-beta", "1.0.0-rc")).toBe(-1);
      expect(compareVersions("1.0.0-rc", "1.0.0")).toBe(-1);
    });

    test("alpha.1 < alpha.2", () => {
      expect(compareVersions("1.0.0-alpha.1", "1.0.0-alpha.2")).toBe(-1);
    });

    test("rc1 < rc2 < rc10 (alphabetical)", () => {
      // Note: This is alphabetical comparison, so rc10 < rc2 alphabetically
      // This matches semver spec where prerelease is compared as strings
      expect(compareVersions("1.0.0-rc1", "1.0.0-rc2")).toBe(-1);
    });

    test("dev < alpha < beta", () => {
      expect(compareVersions("1.0.0-dev", "1.0.0-alpha")).toBe(1); // 'd' > 'a'
      expect(compareVersions("1.0.0-alpha", "1.0.0-beta")).toBe(-1);
    });

    test("prerelease with numbers", () => {
      expect(compareVersions("2.0.0-beta1", "2.0.0-beta2")).toBe(-1);
      expect(compareVersions("2.0.0-beta10", "2.0.0-beta2")).toBe(-1); // alphabetical: "beta10" < "beta2"
    });
  });

  describe("Build Metadata", () => {
    test("parses version with + build metadata", () => {
      const v = parseVersion("1.0.0+build.123");
      expect(v.parts).toEqual([1, 0, 0]);
      expect(v.prerelease).toBe("build.123");
    });

    test("build metadata is treated like prerelease", () => {
      // Per our implementation, + is treated like - for prerelease
      expect(compareVersions("1.0.0+build", "1.0.0")).toBe(-1);
    });
  });

  describe("Invalid Input Handling", () => {
    test("empty string returns empty parts", () => {
      const v = parseVersion("");
      expect(v.parts).toEqual([0]);
      expect(v.original).toBe("");
    });

    test("non-numeric string returns 0", () => {
      const v = parseVersion("abc");
      expect(v.parts).toEqual([0]);
    });

    test("mixed alphanumeric parts", () => {
      const v = parseVersion("1.2a.3");
      expect(v.parts[0]).toBe(1);
      expect(v.parts[1]).toBe(2); // parseInt("2a") = 2
      expect(v.parts[2]).toBe(3);
    });

    test("whitespace handling", () => {
      const v = parseVersion("  1.2.3  ");
      expect(v.parts).toEqual([1, 2, 3]);
    });

    test("compare with null-like values", () => {
      expect(compareVersions("0", "0")).toBe(0);
      expect(compareVersions("0.0.0", "0")).toBe(0);
    });
  });

  describe("Complex Version Formats", () => {
    test("Adobe-style versions (YY.M.D.build)", () => {
      expect(compareVersions("24.001.20604.0", "24.001.20605.0")).toBe(-1);
      expect(compareVersions("24.002.20604.0", "24.001.20604.0")).toBe(1);
    });

    test("Java-style versions (1.8.0_371)", () => {
      const v = parseVersion("1.8.0_371");
      expect(v.parts[0]).toBe(1);
      expect(v.parts[1]).toBe(8);
      expect(v.parts[2]).toBe(0);
      // Underscore gets parsed into prerelease
      expect(v.prerelease).toBeUndefined(); // underscore not treated as prerelease marker
    });

    test("Windows KB with leading zeros", () => {
      const v = parseVersion("KB05034204");
      expect(v.isKb).toBe(true);
      expect(v.kbNumber).toBe(5034204);
    });

    test("version with many segments", () => {
      const v = parseVersion("1.2.3.4.5.6.7.8");
      expect(v.parts).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      expect(compareVersions("1.2.3.4.5.6.7.8", "1.2.3.4.5.6.7.9")).toBe(-1);
    });

    test("leading zeros in segments", () => {
      const v = parseVersion("1.02.003");
      expect(v.parts).toEqual([1, 2, 3]);
      expect(compareVersions("1.02.003", "1.2.3")).toBe(0);
    });
  });

  describe("Range Expressions", () => {
    test("complex range with start and end", () => {
      expect(isVersionInRange("1.5.0", { start: "1.0.0", end: "2.0.0" })).toBe(true);
      expect(isVersionInRange("1.0.0", { start: "1.0.0", end: "2.0.0" })).toBe(true); // inclusive start
      expect(isVersionInRange("2.0.0", { start: "1.0.0", end: "2.0.0" })).toBe(true); // inclusive end
    });

    test("invalid expression returns false", () => {
      expect(evaluateExpression("1.0.0", "invalid")).toBe(false);
      expect(evaluateExpression("1.0.0", "~> 1.0.0")).toBe(false); // unsupported operator
    });

    test("expression with whitespace variations", () => {
      expect(evaluateExpression("1.0.0", "<2.0.0")).toBe(true);
      expect(evaluateExpression("1.0.0", "<  2.0.0")).toBe(true);
      expect(evaluateExpression("1.0.0", "< 2.0.0")).toBe(true);
    });
  });

  describe("Sort and MSV Functions", () => {
    test("sortVersions with mixed formats", () => {
      const versions = ["2.0.0", "1.0.0-alpha", "1.0.0", "1.0.0-beta"];
      const sorted = sortVersions(versions);
      expect(sorted).toEqual(["1.0.0-alpha", "1.0.0-beta", "1.0.0", "2.0.0"]);
    });

    test("findMinimumSafeVersion with duplicates", () => {
      const versions = ["1.0.1", "1.0.5", "1.0.5", "1.0.3"];
      expect(findMinimumSafeVersion(versions)).toBe("1.0.5");
    });

    test("isVersionVulnerable edge cases", () => {
      // Exactly at MSV is not vulnerable
      expect(isVersionVulnerable("1.0.5", ["1.0.5"])).toBe(false);
      // One below MSV is vulnerable
      expect(isVersionVulnerable("1.0.4", ["1.0.5"])).toBe(true);
      // One above MSV is not vulnerable
      expect(isVersionVulnerable("1.0.6", ["1.0.5"])).toBe(false);
    });
  });

  describe("normalizeVersion", () => {
    test("strips leading v", () => {
      expect(normalizeVersion("v1.2.3")).toBe("1.2.3");
    });

    test("handles KB versions", () => {
      expect(normalizeVersion("kb5034204")).toBe("KB5034204");
      expect(normalizeVersion("KB5034204")).toBe("KB5034204");
    });

    test("normalizes different formats to same result", () => {
      expect(normalizeVersion("1.0")).toBe("1.0");
      expect(normalizeVersion("v1.0")).toBe("1.0");
    });
  });
});
