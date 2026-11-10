/**
 * LiveFetchers.test.ts
 *
 * LIVE network gate for every vendor advisory fetcher. This is the pre-commit
 * check that catches a fetcher whose upstream endpoint has broken/moved/changed
 * its contract — the class of failure that mocked tests (VendorFetchers.test.ts)
 * and warm-cache runs can't see.
 *
 * Design for reliable detection (not just logic):
 *  - Each fetcher uses a FRESH temp cache dir, forcing a real network fetch every
 *    run — a stale 4h cache must never be able to mask a dead endpoint.
 *  - One retry on failure absorbs a transient blip; a second failure fails the test.
 *  - A fetcher that returns zero advisories AND zero branches is a FAIL — that is
 *    exactly how the Atlassian `/cves` outage looked (bare request hung → 0 data).
 *
 * Retired fetchers (no viable vendor source — covered by NVD/VulnCheck/KEV) are
 * intentionally NOT listed: Fortinet, SonicWall, Juniper, Check Point, Adobe, F5.
 *
 * Mirrors the fetcher list in tools/tests/test-all-fetchers.ts — keep in sync.
 */

import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PaloAltoAdvisoryFetcher } from "../PaloAltoAdvisoryFetcher";
import { CiscoAdvisoryFetcher } from "../CiscoAdvisoryFetcher";
import { IvantiAdvisoryFetcher } from "../IvantiAdvisoryFetcher";
import { OPNsenseAdvisoryFetcher } from "../OPNsenseAdvisoryFetcher";
import { PfSenseAdvisoryFetcher } from "../PfSenseAdvisoryFetcher";
import { getVendorFetcher } from "../VendorAdvisory";

type FetchResult = { advisories?: unknown[]; branches?: unknown[] };

const PER_TEST_TIMEOUT_MS = 45_000;

/** A fresh temp cache dir per call forces a real network fetch (no warm cache). */
function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "livefetch-"));
}

/** Run a fetch with one retry to absorb a transient network blip. */
async function fetchWithRetry(fn: (dir: string) => Promise<FetchResult>): Promise<FetchResult> {
  const dirs: string[] = [];
  try {
    try {
      const d = freshDir(); dirs.push(d);
      return await fn(d);
    } catch {
      await new Promise((r) => setTimeout(r, 1500));
      const d = freshDir(); dirs.push(d);
      return await fn(d);
    }
  } finally {
    for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
  }
}

function viaVendor(vendor: string, product: string) {
  return (dir: string): Promise<FetchResult> => {
    const f = getVendorFetcher(vendor, product, dir);
    return f ? (f.fetch() as Promise<FetchResult>) : Promise.resolve({ advisories: [], branches: [] });
  };
}

const FETCHERS: Array<{ name: string; fn: (dir: string) => Promise<FetchResult> }> = [
  { name: "Palo Alto PAN-OS", fn: (d) => new PaloAltoAdvisoryFetcher(d).fetch("pan-os") },
  { name: "Cisco ASA", fn: (d) => new CiscoAdvisoryFetcher(d).fetch("asa") },
  { name: "Ivanti Connect Secure", fn: (d) => new IvantiAdvisoryFetcher(d, "connect_secure").fetch() },
  { name: "OPNsense", fn: (d) => new OPNsenseAdvisoryFetcher(d).fetch() },
  { name: "pfSense", fn: (d) => new PfSenseAdvisoryFetcher(d).fetch() },
  { name: "Mozilla Firefox", fn: viaVendor("mozilla", "firefox") },
  { name: "Microsoft Edge", fn: viaVendor("microsoft", "edge") },
  { name: "VMware", fn: viaVendor("vmware", "esxi") },
  { name: "Atlassian Confluence", fn: viaVendor("atlassian", "confluence") },
  { name: "Citrix", fn: viaVendor("citrix", "adc") },
  { name: "Oracle Java", fn: viaVendor("oracle", "java") },
  { name: "Curl", fn: viaVendor("curl", "curl") },
  { name: "Google Chrome", fn: viaVendor("google", "chrome") },
  { name: "SolarWinds Orion", fn: viaVendor("solarwinds", "orion_platform") },
];

describe("Live vendor fetchers (network gate)", () => {
  for (const { name, fn } of FETCHERS) {
    it(
      `${name} returns live advisory data`,
      async () => {
        const r = await fetchWithRetry(fn);
        expect(r).toBeDefined();
        const count = (r.advisories?.length ?? 0) + (r.branches?.length ?? 0);
        expect(count).toBeGreaterThan(0);
      },
      PER_TEST_TIMEOUT_MS,
    );
  }
});
