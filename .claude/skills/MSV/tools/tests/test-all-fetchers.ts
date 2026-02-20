#!/usr/bin/env bun
/**
 * Test All Vendor Advisory Fetchers
 *
 * Systematically tests each fetcher and reports:
 * - Connection status
 * - Data quality (advisories, branches, versions)
 * - Error details
 *
 * Retired fetchers (no viable vendor data source — use NVD/VulnCheck/KEV instead):
 * - Fortinet: FortiGuard RSS has no version data
 * - SonicWall: PSIRT portal WAF-blocked (Incapsula)
 * - Juniper: Native feeds dead (Salesforce migration behind auth)
 * - Check Point: No public API or RSS feed
 * - Adobe: helpx.adobe.com CDN blocks non-browser requests
 * - F5: No public machine-readable advisory feed
 */

import { PaloAltoAdvisoryFetcher } from "../PaloAltoAdvisoryFetcher";
import { CiscoAdvisoryFetcher } from "../CiscoAdvisoryFetcher";
import { IvantiAdvisoryFetcher } from "../IvantiAdvisoryFetcher";
import { CurlAdvisoryFetcher } from "../CurlAdvisoryFetcher";
import { OPNsenseAdvisoryFetcher } from "../OPNsenseAdvisoryFetcher";
import { PfSenseAdvisoryFetcher } from "../PfSenseAdvisoryFetcher";
import { AtlassianAdvisoryFetcher } from "../AtlassianAdvisoryFetcher";
import { CitrixAdvisoryFetcher } from "../CitrixAdvisoryFetcher";
import { OracleAdvisoryFetcher } from "../OracleAdvisoryFetcher";
import { getVendorFetcher } from "../VendorAdvisory";

const CACHE_DIR = "../data/cache";
const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";

interface TestResult {
  vendor: string;
  status: "PASS" | "FAIL" | "PARTIAL";
  advisoryCount: number;
  branchCount: number;
  hasVersionData: boolean;
  error?: string;
  sampleAdvisory?: string;
  sampleBranch?: string;
  duration: number;
}

async function testFetcher(
  name: string,
  fetchFn: () => Promise<{ advisories: any[]; branches: any[] }>
): Promise<TestResult> {
  const start = Date.now();
  try {
    const result = await fetchFn();
    const duration = Date.now() - start;

    // Check if advisories have version data
    const hasVersionData = result.advisories.some(
      (a: any) =>
        (a.affectedVersions?.length > 0) ||
        (a.fixedVersions?.length > 0)
    );

    const sampleAdvisory = result.advisories[0]
      ? `${result.advisories[0].id}: ${result.advisories[0].title?.slice(0, 40)}...`
      : undefined;

    const sampleBranch = result.branches[0]
      ? `${result.branches[0].branch}.x: MSV ${result.branches[0].msv}`
      : undefined;

    return {
      vendor: name,
      status: result.branches.length > 0 ? "PASS" : (result.advisories.length > 0 ? "PARTIAL" : "FAIL"),
      advisoryCount: result.advisories.length,
      branchCount: result.branches.length,
      hasVersionData,
      sampleAdvisory,
      sampleBranch,
      duration,
    };
  } catch (error) {
    return {
      vendor: name,
      status: "FAIL",
      advisoryCount: 0,
      branchCount: 0,
      hasVersionData: false,
      error: (error as Error).message,
      duration: Date.now() - start,
    };
  }
}

async function main() {
  console.log(`\n${BOLD}═══════════════════════════════════════════════════════════════${RESET}`);
  console.log(`${BOLD}  MSV VENDOR ADVISORY FETCHER TEST SUITE${RESET}`);
  console.log(`${BOLD}═══════════════════════════════════════════════════════════════${RESET}\n`);

  const fetchers: Array<{ name: string; fn: () => Promise<any> }> = [
    // Network Security Vendors (with viable vendor advisory sources)
    {
      name: "Palo Alto PAN-OS",
      fn: () => new PaloAltoAdvisoryFetcher(CACHE_DIR).fetch("pan-os")
    },
    {
      name: "Cisco ASA",
      fn: () => new CiscoAdvisoryFetcher(CACHE_DIR).fetch("asa")
    },
    {
      name: "Ivanti Connect Secure",
      fn: () => new IvantiAdvisoryFetcher(CACHE_DIR, "connect_secure").fetch()
    },
    {
      name: "OPNsense",
      fn: () => new OPNsenseAdvisoryFetcher(CACHE_DIR).fetch()
    },
    {
      name: "pfSense",
      fn: () => new PfSenseAdvisoryFetcher(CACHE_DIR).fetch()
    },
    // Software Vendors (via VendorAdvisory wrappers)
    {
      name: "Mozilla Firefox",
      fn: async () => {
        const fetcher = getVendorFetcher("mozilla", "firefox", CACHE_DIR);
        return fetcher ? fetcher.fetch() : { advisories: [], branches: [] };
      }
    },
    {
      name: "Microsoft Edge",
      fn: async () => {
        const fetcher = getVendorFetcher("microsoft", "edge", CACHE_DIR);
        return fetcher ? fetcher.fetch() : { advisories: [], branches: [] };
      }
    },
    {
      name: "VMware",
      fn: async () => {
        const fetcher = getVendorFetcher("vmware", "esxi", CACHE_DIR);
        return fetcher ? fetcher.fetch() : { advisories: [], branches: [] };
      }
    },
    {
      name: "Atlassian Confluence",
      fn: async () => {
        const fetcher = getVendorFetcher("atlassian", "confluence", CACHE_DIR);
        return fetcher ? fetcher.fetch() : { advisories: [], branches: [] };
      }
    },
    {
      name: "Citrix",
      fn: async () => {
        const fetcher = getVendorFetcher("citrix", "adc", CACHE_DIR);
        return fetcher ? fetcher.fetch() : { advisories: [], branches: [] };
      }
    },
    {
      name: "Oracle Java",
      fn: async () => {
        const fetcher = getVendorFetcher("oracle", "java", CACHE_DIR);
        return fetcher ? fetcher.fetch() : { advisories: [], branches: [] };
      }
    },
    {
      name: "Curl",
      fn: async () => {
        const fetcher = getVendorFetcher("curl", "curl", CACHE_DIR);
        return fetcher ? fetcher.fetch() : { advisories: [], branches: [] };
      }
    },
    {
      name: "Google Chrome",
      fn: async () => {
        const fetcher = getVendorFetcher("google", "chrome", CACHE_DIR);
        return fetcher ? fetcher.fetch() : { advisories: [], branches: [] };
      }
    },
    {
      name: "SolarWinds Orion",
      fn: async () => {
        const fetcher = getVendorFetcher("solarwinds", "orion_platform", CACHE_DIR);
        return fetcher ? fetcher.fetch() : { advisories: [], branches: [] };
      }
    },
  ];

  const results: TestResult[] = [];

  for (const fetcher of fetchers) {
    process.stdout.write(`Testing ${fetcher.name.padEnd(20)}... `);
    const result = await testFetcher(fetcher.name, fetcher.fn);
    results.push(result);

    const statusColor = result.status === "PASS" ? GREEN :
                        result.status === "PARTIAL" ? YELLOW : RED;
    const statusIcon = result.status === "PASS" ? "✓" :
                       result.status === "PARTIAL" ? "◐" : "✗";

    console.log(
      `${statusColor}${statusIcon} ${result.status.padEnd(7)}${RESET} ` +
      `${DIM}(${result.duration}ms)${RESET} ` +
      `Adv:${result.advisoryCount} Br:${result.branchCount} ` +
      `${result.hasVersionData ? `${GREEN}HasVer${RESET}` : `${RED}NoVer${RESET}`}`
    );

    if (result.error) {
      console.log(`  ${RED}Error: ${result.error.slice(0, 60)}${RESET}`);
    }
    if (result.sampleBranch) {
      console.log(`  ${DIM}${result.sampleBranch}${RESET}`);
    }
  }

  // Summary
  console.log(`\n${BOLD}═══════════════════════════════════════════════════════════════${RESET}`);
  console.log(`${BOLD}  SUMMARY${RESET}`);
  console.log(`${BOLD}═══════════════════════════════════════════════════════════════${RESET}\n`);

  const passing = results.filter(r => r.status === "PASS").length;
  const partial = results.filter(r => r.status === "PARTIAL").length;
  const failing = results.filter(r => r.status === "FAIL").length;

  console.log(`${GREEN}PASS:    ${passing}${RESET} (returning branches + version data)`);
  console.log(`${YELLOW}PARTIAL: ${partial}${RESET} (advisories but no branches)`);
  console.log(`${RED}FAIL:    ${failing}${RESET} (errors or no data)`);

  console.log(`\n${DIM}Retired fetchers (no viable vendor source — covered by NVD/VulnCheck/KEV):${RESET}`);
  console.log(`${DIM}  Fortinet, SonicWall, Juniper, Check Point, Adobe, F5${RESET}`);

  if (results.some(r => r.status !== "PASS")) {
    console.log(`\n${BOLD}Issues to Fix:${RESET}`);
    for (const r of results.filter(r => r.status !== "PASS")) {
      console.log(`  ${r.status === "PARTIAL" ? YELLOW : RED}• ${r.vendor}${RESET}: ${r.error || "No branch data calculated"}`);
    }
  }

  return results;
}

main().catch(console.error);
