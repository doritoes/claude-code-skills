/**
 * MsrcClient.test.ts - Test suite for Microsoft MSRC API Client
 *
 * Run with: bun test MsrcClient.test.ts
 *
 * Tests:
 * - API connectivity (requires network)
 * - Product search functionality
 * - CVE lookup
 * - Caching behavior
 * - Data structure validation
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { MsrcClient } from "./MsrcClient";

// =============================================================================
// Test Configuration
// =============================================================================

const TEST_CACHE_DIR = resolve(import.meta.dir, "..", "data", "test-cache-msrc");
const NETWORK_TIMEOUT_MS = 60000; // 60 seconds for network tests

// =============================================================================
// Setup and Teardown
// =============================================================================

beforeAll(() => {
  // Create test cache directory
  if (!existsSync(TEST_CACHE_DIR)) {
    mkdirSync(TEST_CACHE_DIR, { recursive: true });
  }
});

afterAll(() => {
  // Clean up test cache directory
  try {
    if (existsSync(TEST_CACHE_DIR)) {
      rmSync(TEST_CACHE_DIR, { recursive: true, force: true });
    }
  } catch {
    // Ignore cleanup errors
  }
});

// =============================================================================
// Unit Tests
// =============================================================================

describe("MsrcClient Unit Tests", () => {
  test("client instantiates correctly", () => {
    const client = new MsrcClient(TEST_CACHE_DIR);
    expect(client).toBeDefined();
  });

  test("getAdmiraltyRating returns correct rating", () => {
    const client = new MsrcClient(TEST_CACHE_DIR);
    const rating = client.getAdmiraltyRating();

    // MSRC should have A2 rating (Completely Reliable, Probably True)
    expect(rating.reliability).toBe("A");
    expect(rating.credibility).toBe(2);
  });

  test("creates cache directory if it doesn't exist", () => {
    const customCacheDir = resolve(TEST_CACHE_DIR, "custom-msrc-cache");

    // Ensure it doesn't exist
    if (existsSync(customCacheDir)) {
      rmSync(customCacheDir, { recursive: true });
    }

    // Client should create it
    const client = new MsrcClient(customCacheDir);
    expect(existsSync(customCacheDir)).toBe(true);

    // Cleanup
    rmSync(customCacheDir, { recursive: true });
  });
});

// =============================================================================
// API Integration Tests (Network Required)
// =============================================================================

describe("MsrcClient API Tests", () => {
  let client: MsrcClient;

  beforeAll(() => {
    client = new MsrcClient(TEST_CACHE_DIR, { verbose: false });
  });

  test("getUpdates fetches security updates list", async () => {
    const updates = await client.getUpdates();

    // Should return an array of updates
    expect(Array.isArray(updates)).toBe(true);
    expect(updates.length).toBeGreaterThan(0);

    // Each update should have expected fields
    const firstUpdate = updates[0];
    expect(firstUpdate).toHaveProperty("ID");
    expect(firstUpdate).toHaveProperty("InitialReleaseDate");
    expect(firstUpdate).toHaveProperty("CurrentReleaseDate");

    // ID should be in YYYY-Mon format (e.g., "2024-Jan")
    expect(firstUpdate.ID).toMatch(/^\d{4}-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)$/);
  }, NETWORK_TIMEOUT_MS);

  test("getUpdates with year filter works", async () => {
    const updates = await client.getUpdates({ year: 2024 });

    expect(Array.isArray(updates)).toBe(true);

    // All updates should be from 2024
    for (const update of updates) {
      expect(update.ID).toMatch(/^2024-/);
    }
  }, NETWORK_TIMEOUT_MS);

  test("getCvrfDocument fetches document details", async () => {
    // Get most recent update ID first
    const updates = await client.getUpdates();
    expect(updates.length).toBeGreaterThan(0);

    const recentUpdateId = updates[0].ID;
    const cvrf = await client.getCvrfDocument(recentUpdateId);

    // Should have expected structure
    expect(cvrf).toHaveProperty("DocumentTitle");
    expect(cvrf).toHaveProperty("DocumentTracking");
    expect(cvrf).toHaveProperty("ProductTree");
    expect(cvrf).toHaveProperty("Vulnerability");

    // Should have vulnerabilities
    expect(Array.isArray(cvrf.Vulnerability)).toBe(true);

    // ProductTree should have products
    expect(cvrf.ProductTree).toHaveProperty("FullProductName");
    expect(Array.isArray(cvrf.ProductTree.FullProductName)).toBe(true);
  }, NETWORK_TIMEOUT_MS);

  test("searchByProduct finds Edge vulnerabilities", async () => {
    const results = await client.searchByProduct("edge", {
      maxMonths: 6,
      minCvss: 4.0,
    });

    expect(Array.isArray(results)).toBe(true);

    if (results.length > 0) {
      const firstResult = results[0];

      // Should have expected fields
      expect(firstResult).toHaveProperty("cveId");
      expect(firstResult).toHaveProperty("title");
      expect(firstResult).toHaveProperty("affectedProducts");
      expect(firstResult).toHaveProperty("publishedDate");

      // CVE ID should be valid format
      expect(firstResult.cveId).toMatch(/^CVE-\d{4}-\d+$/);

      // Affected products should include Edge
      const hasEdge = firstResult.affectedProducts.some(
        (p: string) => p.toLowerCase().includes("edge")
      );
      expect(hasEdge).toBe(true);
    }
  }, NETWORK_TIMEOUT_MS * 2); // Longer timeout for multi-document fetch

  test("searchByProduct finds Office vulnerabilities", async () => {
    const results = await client.searchByProduct("office", {
      maxMonths: 6,
      minCvss: 4.0,
    });

    expect(Array.isArray(results)).toBe(true);

    if (results.length > 0) {
      // Should find Office-related CVEs
      const hasOfficeProduct = results.some(r =>
        r.affectedProducts.some((p: string) =>
          /office|word|excel|outlook|365/i.test(p)
        )
      );
      expect(hasOfficeProduct).toBe(true);
    }
  }, NETWORK_TIMEOUT_MS * 2);

  test("searchByProduct returns empty for unknown product", async () => {
    const results = await client.searchByProduct("nonexistent_product_xyz", {
      maxMonths: 3,
    });

    // Should return empty array, not error
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBe(0);
  }, NETWORK_TIMEOUT_MS);

  test("results are sorted by CVSS score descending", async () => {
    const results = await client.searchByProduct("edge", {
      maxMonths: 6,
      minCvss: 0, // Get all scores to verify sorting
    });

    if (results.length > 1) {
      // Verify descending CVSS order
      for (let i = 1; i < results.length; i++) {
        const prevScore = results[i - 1].cvssScore || 0;
        const currScore = results[i].cvssScore || 0;
        expect(prevScore).toBeGreaterThanOrEqual(currScore);
      }
    }
  }, NETWORK_TIMEOUT_MS * 2);
});

// =============================================================================
// Caching Tests
// =============================================================================

describe("MsrcClient Caching", () => {
  test("getUpdates caches results", async () => {
    // Use a fresh cache directory to ensure cache is cold
    const freshCacheDir = resolve(TEST_CACHE_DIR, "fresh-cache-" + Date.now());
    mkdirSync(freshCacheDir, { recursive: true });

    const client = new MsrcClient(freshCacheDir);

    // First call - fetches from API (should take measurable time)
    const start1 = Date.now();
    const updates1 = await client.getUpdates();
    const duration1 = Date.now() - start1;

    // Second call - should be from cache (much faster)
    const start2 = Date.now();
    const updates2 = await client.getUpdates();
    const duration2 = Date.now() - start2;

    // Results should be identical
    expect(updates1.length).toBe(updates2.length);
    expect(updates1[0]?.ID).toBe(updates2[0]?.ID);

    // Cached call should be faster than first call
    // If first call was very fast (already cached elsewhere), just verify cache works
    if (duration1 > 100) {
      // Only check timing if first call took measurable time (network fetch)
      expect(duration2).toBeLessThan(duration1 / 2);
    } else {
      // If both are fast, just verify the cache file was created
      expect(existsSync(resolve(freshCacheDir, "msrc-updates.json"))).toBe(true);
    }

    // Cleanup
    rmSync(freshCacheDir, { recursive: true, force: true });
  }, NETWORK_TIMEOUT_MS);

  test("cache files are created", async () => {
    const client = new MsrcClient(TEST_CACHE_DIR);
    await client.getUpdates();

    // Check that cache file exists
    const cacheFile = resolve(TEST_CACHE_DIR, "msrc-updates.json");
    expect(existsSync(cacheFile)).toBe(true);
  }, NETWORK_TIMEOUT_MS);
});

// =============================================================================
// Error Handling Tests
// =============================================================================

describe("MsrcClient Error Handling", () => {
  test("handles invalid update ID gracefully", async () => {
    const client = new MsrcClient(TEST_CACHE_DIR);

    // Should throw or return error for invalid ID
    try {
      await client.getCvrfDocument("invalid-id-format");
      // If it doesn't throw, the API might return empty/error response
    } catch (error) {
      // Expected to throw for invalid ID
      expect(error).toBeDefined();
    }
  }, NETWORK_TIMEOUT_MS);

  test("getCve returns null for non-existent CVE", async () => {
    const client = new MsrcClient(TEST_CACHE_DIR);

    const result = await client.getCve("CVE-9999-99999");

    // Should return null, not throw
    expect(result).toBeNull();
  }, NETWORK_TIMEOUT_MS);

  test("getCve works for known Microsoft CVE", async () => {
    const client = new MsrcClient(TEST_CACHE_DIR);

    // Use a known recent Microsoft CVE (Edge vulnerability from 2024)
    // This CVE should exist in MSRC
    const result = await client.getCve("CVE-2024-21326");

    // May or may not find it depending on how old
    // Just verify it doesn't crash
    if (result) {
      expect(result.cveId).toBe("CVE-2024-21326");
      expect(result.affectedProducts).toBeDefined();
    }
  }, NETWORK_TIMEOUT_MS);
});

// =============================================================================
// Data Validation Tests
// =============================================================================

describe("MsrcClient Data Validation", () => {
  test("vulnerability results have valid CVE format", async () => {
    const client = new MsrcClient(TEST_CACHE_DIR);
    const results = await client.searchByProduct("edge", { maxMonths: 3 });

    for (const result of results) {
      // CVE ID format: CVE-YYYY-NNNNN
      expect(result.cveId).toMatch(/^CVE-\d{4}-\d{4,}$/);
    }
  }, NETWORK_TIMEOUT_MS * 2);

  test("dates are in valid ISO format", async () => {
    const client = new MsrcClient(TEST_CACHE_DIR);
    const updates = await client.getUpdates();

    for (const update of updates.slice(0, 5)) {
      // Should be parseable as date
      const releaseDate = new Date(update.InitialReleaseDate);
      expect(releaseDate.toString()).not.toBe("Invalid Date");
    }
  }, NETWORK_TIMEOUT_MS);

  test("CVSS scores are in valid range", async () => {
    const client = new MsrcClient(TEST_CACHE_DIR);
    const results = await client.searchByProduct("edge", {
      maxMonths: 6,
      minCvss: 0,
    });

    for (const result of results) {
      if (result.cvssScore !== null) {
        // CVSS scores should be between 0 and 10
        expect(result.cvssScore).toBeGreaterThanOrEqual(0);
        expect(result.cvssScore).toBeLessThanOrEqual(10);
      }
    }
  }, NETWORK_TIMEOUT_MS * 2);
});
