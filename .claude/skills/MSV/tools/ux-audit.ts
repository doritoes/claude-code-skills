#!/usr/bin/env bun
/**
 * ux-audit.ts - MSV UX Consistency Audit
 *
 * Queries every product in the catalog and flags UX issues that would
 * make a user think the tool is unreliable:
 *   - Garbage/impossible version numbers
 *   - MSV from wrong product (sub-component contamination)
 *   - Recommended > Latest version
 *   - MSV > Latest version (for non-branch products)
 *   - UNDETERMINED for products with known CVE history
 *   - Version branches that don't match product versioning
 *   - Errors/crashes
 *
 * Known false positives (confirmed non-bugs as of 2026-09-16, left as-is —
 * fixing the heuristic further isn't worth the fragility):
 *   - Mozilla Firefox GARBAGE_VERSION/GARBAGE_BRANCH_MSV — Firefox legitimately
 *     uses bare major-version integers ("156", "155", "145"), not garbage. The
 *     catalogUsesBuildNumbers escape hatch checks sw.latestVersion, which is
 *     stored dotted ("147.0.2") even though live branch data is bare-integer.
 *   - Redis RECOMMENDED_GT_LATEST — catalog latestVersion "3.1.0" is the
 *     intentional last Windows-native port version (see catalog notes: "Windows
 *     port (3.x) discontinued; use Docker/WSL for current versions"), while
 *     recommendedVersion is correctly computed from general CVE-fix data. Not
 *     a staleness bug — don't "fix" latestVersion to the general-release latest.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const skillDir = resolve(import.meta.dir, "..");
const catalogPath = resolve(skillDir, "data/SoftwareCatalog.json");
const catalog = JSON.parse(readFileSync(catalogPath, "utf-8"));

interface Issue {
  id: string;
  displayName: string;
  severity: "CRITICAL" | "WARNING" | "INFO";
  issue: string;
  detail: string;
}

const issues: Issue[] = [];
const results: Array<{
  id: string;
  name: string;
  msv: string | null;
  recommended: string | null;
  latest: string | null;
  confidence: string;
  cveCount: number;
  sources: string;
  branches: string[];
  error?: string;
}> = [];

// Import the query function by running msv.ts as a module
// Instead, we'll shell out to msv.ts with --format json for each product
const { execSync } = require("child_process");

let completed = 0;
const total = catalog.software.length;

for (const sw of catalog.software) {
  completed++;
  const pct = Math.round((completed / total) * 100);
  process.stderr.write(`\r[${pct}%] ${completed}/${total} - ${sw.id.padEnd(40)}`);

  try {
    const output = execSync(
      `bun ./tools/msv.ts query "${sw.id}" --format json`,
      {
        cwd: skillDir,
        timeout: 45000,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }
    );

    let data: any;
    try {
      data = JSON.parse(output);
    } catch {
      issues.push({
        id: sw.id,
        displayName: sw.displayName,
        severity: "CRITICAL",
        issue: "JSON_PARSE_FAIL",
        detail: `Output is not valid JSON: ${output.substring(0, 200)}`,
      });
      continue;
    }

    const msv = data.minimumSafeVersion || null;
    const recommended = data.recommendedVersion || null;
    const latest = data.latestVersion || null;
    const confidence = data.admiraltyRating?.rating || "?";
    const cveCount = data.cveCount || 0;
    const branches = (data.branches || []).map((b: any) => `${b.branch}:${b.msv}`);
    const sourceList = (data.sourceResults || [])
      .filter((s: any) => s.cveCount > 0)
      .map((s: any) => `${s.source}:${s.cveCount}`)
      .join(", ");

    results.push({
      id: sw.id,
      name: sw.displayName,
      msv,
      recommended,
      latest,
      confidence,
      cveCount,
      sources: sourceList,
      branches,
    });

    // === UX CHECKS ===

    // 1. Garbage version numbers (non-semver-like, single digits, etc.)
    // Skip for products whose catalog latestVersion confirms build-number/YYMM scheme
    const catalogLatest = sw.latestVersion || "";
    const catalogUsesBuildNumbers = /^\d+$/.test(catalogLatest) && parseInt(catalogLatest) > 100;
    const garbageVersion = (v: string | null, label: string) => {
      if (!v) return;
      // Single number that's unreasonably high or low — but skip if catalog confirms this scheme
      if (/^\d+$/.test(v) && (parseInt(v) > 100 || parseInt(v) < 1) && !catalogUsesBuildNumbers) {
        issues.push({ id: sw.id, displayName: sw.displayName, severity: "CRITICAL", issue: "GARBAGE_VERSION", detail: `${label} = "${v}" — looks like garbage` });
      }
      // Version with no dots and not a simple number (e.g., "N/A")
      if (v.includes("N/A") || v === "null" || v === "undefined") {
        issues.push({ id: sw.id, displayName: sw.displayName, severity: "INFO", issue: "NULL_VERSION", detail: `${label} = "${v}"` });
      }
    };
    garbageVersion(msv, "MSV");
    garbageVersion(recommended, "Recommended");
    garbageVersion(latest, "Latest");

    // 2. Version pattern mismatch — MSV major version doesn't match latest
    if (msv && latest && sw.versionPattern) {
      const versionRegex = new RegExp(sw.versionPattern);
      if (!versionRegex.test(msv)) {
        issues.push({ id: sw.id, displayName: sw.displayName, severity: "CRITICAL", issue: "MSV_PATTERN_MISMATCH", detail: `MSV "${msv}" doesn't match versionPattern "${sw.versionPattern}"` });
      }
    }

    // 3. Recommended > Latest (confusing to user)
    if (recommended && latest && recommended !== latest) {
      // Simple major version check
      const recMajor = parseInt(recommended.split(".")[0]);
      const latMajor = parseInt(latest.split(".")[0]);
      if (!isNaN(recMajor) && !isNaN(latMajor) && recMajor > latMajor + 1) {
        issues.push({ id: sw.id, displayName: sw.displayName, severity: "WARNING", issue: "RECOMMENDED_GT_LATEST", detail: `Recommended "${recommended}" >> Latest "${latest}"` });
      }
    }

    // 4. Branches with suspicious version numbers
    for (const branch of branches) {
      const [branchName, branchMsv] = branch.split(":");
      // Check for sub-component contamination patterns — skip if catalog confirms build-number scheme
      if (branchMsv && /^[0-9]+$/.test(branchMsv) && parseInt(branchMsv) > 50 && !catalogUsesBuildNumbers) {
        issues.push({ id: sw.id, displayName: sw.displayName, severity: "CRITICAL", issue: "GARBAGE_BRANCH_MSV", detail: `Branch "${branchName}" has MSV "${branchMsv}" — likely sub-component` });
      }
    }

    // 5. F6 confidence for products with CVEs (contradictory)
    if (confidence === "F6" && cveCount > 0) {
      issues.push({ id: sw.id, displayName: sw.displayName, severity: "WARNING", issue: "F6_WITH_CVES", detail: `Confidence F6 (insufficient data) but ${cveCount} CVEs found` });
    }

    // 6. Zero CVEs for critical priority products (suspicious)
    if (sw.priority === "critical" && cveCount === 0 && confidence === "F6") {
      issues.push({ id: sw.id, displayName: sw.displayName, severity: "WARNING", issue: "CRITICAL_NO_DATA", detail: `Critical priority product with 0 CVEs and F6 confidence` });
    }

    // 7. CVE fixed version that's clearly from wrong product
    if (data.exploitedCves) {
      for (const cve of data.exploitedCves) {
        if (cve.fixedVersion && sw.versionPattern) {
          const vr = new RegExp(sw.versionPattern);
          if (!vr.test(cve.fixedVersion) && !cve.fixedVersion.startsWith(">")) {
            issues.push({ id: sw.id, displayName: sw.displayName, severity: "WARNING", issue: "CVE_WRONG_PRODUCT_VERSION", detail: `${cve.cve} fixedVersion "${cve.fixedVersion}" doesn't match pattern "${sw.versionPattern}"` });
          }
        }
      }
    }

    // 8. UNDETERMINED MSV but has high-CVSS CVEs
    if (!msv || msv === "UNDETERMINED") {
      const highCvss = (data.exploitedCves || []).filter((c: any) => c.cvssScore && c.cvssScore >= 7.0);
      if (highCvss.length > 0) {
        issues.push({ id: sw.id, displayName: sw.displayName, severity: "INFO", issue: "UNDETERMINED_WITH_HIGH_CVSS", detail: `MSV undetermined but ${highCvss.length} CVEs with CVSS >= 7.0` });
      }
    }

  } catch (error: any) {
    const msg = error.message || String(error);
    const stderr = error.stderr?.toString() || "";
    results.push({
      id: sw.id,
      name: sw.displayName,
      msv: null,
      recommended: null,
      latest: null,
      confidence: "ERROR",
      cveCount: 0,
      sources: "",
      branches: [],
      error: msg.substring(0, 200),
    });
    issues.push({
      id: sw.id,
      displayName: sw.displayName,
      severity: "CRITICAL",
      issue: "QUERY_ERROR",
      detail: `${stderr.substring(0, 300) || msg.substring(0, 300)}`,
    });
  }
}

process.stderr.write("\n\n");

// === SUMMARY ===
const criticals = issues.filter(i => i.severity === "CRITICAL");
const warnings = issues.filter(i => i.severity === "WARNING");
const infos = issues.filter(i => i.severity === "INFO");
const errors = results.filter(r => r.error);
const determined = results.filter(r => r.msv && r.msv !== "UNDETERMINED" && !r.error);
const undetermined = results.filter(r => (!r.msv || r.msv === "UNDETERMINED") && !r.error);

console.log("=== MSV UX AUDIT RESULTS ===");
console.log(`Total products: ${total}`);
console.log(`MSV determined: ${determined.length}`);
console.log(`MSV undetermined: ${undetermined.length}`);
console.log(`Errors: ${errors.length}`);
console.log(`Issues: ${criticals.length} CRITICAL, ${warnings.length} WARNING, ${infos.length} INFO`);
console.log("");

if (criticals.length > 0) {
  console.log("=== CRITICAL ISSUES (user would flag as unreliable) ===");
  for (const i of criticals) {
    console.log(`  [${i.issue}] ${i.displayName} (${i.id}): ${i.detail}`);
  }
  console.log("");
}

if (warnings.length > 0) {
  console.log("=== WARNINGS (confusing UX) ===");
  for (const i of warnings) {
    console.log(`  [${i.issue}] ${i.displayName} (${i.id}): ${i.detail}`);
  }
  console.log("");
}

if (infos.length > 0) {
  console.log("=== INFO (minor concerns) ===");
  for (const i of infos) {
    console.log(`  [${i.issue}] ${i.displayName} (${i.id}): ${i.detail}`);
  }
  console.log("");
}

// Products with 0 CVEs (might indicate broken queries)
const zeroCve = results.filter(r => r.cveCount === 0 && !r.error);
if (zeroCve.length > 0) {
  console.log(`=== ZERO CVE PRODUCTS (${zeroCve.length}) ===`);
  for (const r of zeroCve) {
    console.log(`  ${r.name} (${r.id}) — confidence: ${r.confidence}`);
  }
  console.log("");
}
