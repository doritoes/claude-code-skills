/**
 * VendorCacheRoundtrip.test.ts
 *
 * Regression tests for the Mozilla vendor-advisory CACHE ROUND-TRIP bug
 * (`adv.fixedVersions?.values is not a function`, surfaced by `msv query
 * firefox --force`).
 *
 * Root cause: MozillaAdvisory.fixedVersions was a `Map`. Vendor fetchers cache
 * their results with JSON.stringify, and a Map serializes to `{}` — so after a
 * cache round-trip the data was gone AND the read path (`.values()`) threw on
 * the resulting plain object.
 *
 * The existing VendorFetchers.test.ts uses mock objects that never pass through
 * the cache, so it could not catch a serialization defect. These tests
 * deliberately exercise the on-disk cache round-trip, which is the only place
 * this class of bug shows up. Keep real cache-round-trip coverage for any
 * fetcher whose cached shape is non-trivial (Maps, Sets, class instances).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MozillaVendorAdvisoryFetcher } from "../VendorAdvisory";

/** Write the Mozilla core-fetcher cache file (mozilla-<product>.json) directly. */
function seedCoreCache(dir: string, product: string, fixedVersions: unknown): void {
  const entry = {
    data: {
      product,
      msv: "153.0.0",
      latestVersion: "153.0.0",
      lastUpdated: new Date().toISOString(),
      source: "test",
      advisories: [
        {
          mfsa: "mfsa2026-01",
          announced: "2026-01-01T00:00:00Z",
          impact: "high",
          title: "Test advisory",
          products: ["Firefox 153"],
          fixedVersions,
          vulnerabilities: [
            { cve: "CVE-2026-16393", title: "Test vuln", impact: "high" },
          ],
        },
      ],
    },
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(), // +1h, not expired
  };
  writeFileSync(join(dir, `mozilla-${product}.json`), JSON.stringify(entry, null, 2));
}

describe("Mozilla vendor-advisory cache round-trip", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vendorcache-"));
  });
  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("preserves fixedVersions through a serialized core cache", async () => {
    // What the FIXED core writes: a plain object (Record), which JSON round-trips intact.
    seedCoreCache(dir, "firefox", { firefox: "153.0.0" });

    const result = await new MozillaVendorAdvisoryFetcher(dir, "firefox").fetch();
    const adv = result.advisories.find((a) => a.id === "CVE-2026-16393");

    expect(adv).toBeDefined();
    expect(adv!.fixedVersions).toContain("153.0.0");
  });

  it("does not throw on a legacy cache where fixedVersions serialized to {}", async () => {
    // What the BUGGY code left on disk: a Map stringified to an empty object.
    // Must degrade gracefully (empty list), never throw `.values is not a function`.
    // If fetch() throws, this await rejects and the test fails.
    seedCoreCache(dir, "firefox", {});

    const result = await new MozillaVendorAdvisoryFetcher(dir, "firefox").fetch();

    const adv = result.advisories.find((a) => a.id === "CVE-2026-16393");
    expect(adv).toBeDefined();
    expect(adv!.fixedVersions).toEqual([]);
  });

  it("documents why fixedVersions must be a Record, not a Map (JSON-stability)", () => {
    // A Record survives JSON.stringify; a Map does not — it becomes `{}`.
    const asRecord = { fixedVersions: { firefox: "153.0.0" } };
    expect(JSON.parse(JSON.stringify(asRecord)).fixedVersions).toEqual({ firefox: "153.0.0" });

    const asMap = { fixedVersions: new Map([["firefox", "153.0.0"]]) };
    expect(JSON.parse(JSON.stringify(asMap)).fixedVersions).toEqual({}); // data lost
  });
});
