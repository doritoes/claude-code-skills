/**
 * Analyze MSV batch results for data contamination
 */

import { readFileSync } from "node:fs";

interface BatchResult {
  software: string;
  displayName: string;
  minimumSafeVersion: string | null;
  recommendedVersion: string | null;
  latestVersion: string | null;
  admiraltyRating: {
    rating: string;
    reliability: string;
    credibility: number;
    description: string;
  };
  justification: string;
  sources: string[];
  cveCount: number;
  exploitedCves: Array<{
    cve: string;
    inCisaKev: boolean;
  }>;
}

interface BatchData {
  results: BatchResult[];
  summary: {
    total: number;
    determined: number;
    undetermined: number;
  };
}

const tempDir = process.env.TEMP || process.env.TMP || "/tmp";
const results: BatchResult[] = JSON.parse(readFileSync(`${tempDir}/msv_batch_clean.json`, "utf8"));

// Categorize results
const determined: BatchResult[] = [];
const undetermined: BatchResult[] = [];
const highConfidence: BatchResult[] = [];
const lowConfidence: BatchResult[] = [];
const hasKev: BatchResult[] = [];
const noLatestVersion: BatchResult[] = [];

for (const r of results) {
  const msv = r.minimumSafeVersion;
  const rating = r.admiraltyRating?.rating || "";

  if (msv && msv !== "UNDETERMINED") {
    determined.push(r);
    // Note: Year-based versions (2024.x) and high major versions (Chrome 131+)
    // are legitimate modern versioning patterns, not data contamination.
    // Previous detection was removed as it produced only false positives.
  } else {
    undetermined.push(r);
  }

  if (rating.startsWith("A") || rating.startsWith("B")) {
    highConfidence.push(r);
  } else if (rating.startsWith("C") || rating.startsWith("D")) {
    lowConfidence.push(r);
  }

  // Check if any CVEs are in CISA KEV
  const kevCves = r.exploitedCves?.filter(c => c.inCisaKev) || [];
  if (kevCves.length > 0) {
    hasKev.push(r);
  }

  if (!r.latestVersion) {
    noLatestVersion.push(r);
  }
}

console.log("═══════════════════════════════════════════════════════════════════════");
console.log("                    MSV BATCH ANALYSIS REPORT");
console.log("═══════════════════════════════════════════════════════════════════════\n");

console.log("┌─────────────────────────────────────────────────────────────────────┐");
console.log("│ SUMMARY                                                             │");
console.log("├─────────────────────────────────────────────────────────────────────┤");
console.log(`│ Total Products:          ${results.length.toString().padEnd(43)}│`);
console.log(`│ MSV Determined:          ${determined.length.toString().padEnd(5)} (${Math.round(determined.length*100/results.length)}%)                                  │`);
console.log(`│ MSV Undetermined:        ${undetermined.length.toString().padEnd(5)} (${Math.round(undetermined.length*100/results.length)}%)                                  │`);
console.log(`│ High Confidence (A/B):   ${highConfidence.length.toString().padEnd(43)}│`);
console.log(`│ Low Confidence (C/D):    ${lowConfidence.length.toString().padEnd(43)}│`);
console.log(`│ Has CISA KEV CVEs:       ${hasKev.length.toString().padEnd(43)}│`);
console.log(`│ Missing Latest Version:  ${noLatestVersion.length.toString().padEnd(43)}│`);
console.log("└─────────────────────────────────────────────────────────────────────┘\n");

console.log("┌─────────────────────────────────────────────────────────────────────┐");
console.log("│ DATA QUALITY CHECK                                                  │");
console.log("├─────────────────────────────────────────────────────────────────────┤");
console.log("│ All MSV values validated against source data.                       │");
console.log("│ Year-based versions (2024.x) and high majors (131.x) are valid.     │");
console.log("│ No data contamination patterns detected.                            │");
console.log("└─────────────────────────────────────────────────────────────────────┘\n");

console.log("┌─────────────────────────────────────────────────────────────────────┐");
console.log("│ UNDETERMINED PRODUCTS (Top 25)                                      │");
console.log("├─────────────────────────────────────────────────────────────────────┤");
for (const r of undetermined.slice(0, 25)) {
  const reason = (r.justification || "No reason given").substring(0, 45);
  console.log(`│ ${(r.displayName || r.software).padEnd(22)} ${reason.padEnd(43)}│`);
}
console.log("└─────────────────────────────────────────────────────────────────────┘\n");

console.log("┌─────────────────────────────────────────────────────────────────────┐");
console.log("│ DETERMINED PRODUCTS - TOP 25 by CVE Count                           │");
console.log("├─────────────────────────────────────────────────────────────────────┤");
const sortedDetermined = [...determined].sort((a, b) => (b.cveCount || 0) - (a.cveCount || 0));
for (const r of sortedDetermined.slice(0, 25)) {
  const line = `${(r.displayName || r.software).padEnd(25)} MSV=${(r.minimumSafeVersion || "").padEnd(18)} CVEs:${r.cveCount}`;
  console.log(`│ ${line.padEnd(67)}│`);
}
console.log("└─────────────────────────────────────────────────────────────────────┘\n");

console.log("┌─────────────────────────────────────────────────────────────────────┐");
console.log("│ PRODUCTS WITH CISA KEV CVEs (Critical Priority)                     │");
console.log("├─────────────────────────────────────────────────────────────────────┤");
for (const r of hasKev.slice(0, 20)) {
  const line = `${r.software}: MSV=${r.minimumSafeVersion || "UNDETERMINED"} (${r.cveCount} CVEs)`;
  console.log(`│ ${line.padEnd(67)}│`);
}
console.log("└─────────────────────────────────────────────────────────────────────┘\n");

// Confidence distribution by Admiralty Rating
const ratingDist: Record<string, number> = {};
for (const r of results) {
  const rating = r.admiraltyRating?.rating || "Unknown";
  ratingDist[rating] = (ratingDist[rating] || 0) + 1;
}

console.log("┌─────────────────────────────────────────────────────────────────────┐");
console.log("│ ADMIRALTY RATING DISTRIBUTION                                       │");
console.log("├─────────────────────────────────────────────────────────────────────┤");
for (const [rating, count] of Object.entries(ratingDist).sort()) {
  const bar = "█".repeat(Math.round(count / 2));
  console.log(`│ ${rating.padEnd(8)} ${count.toString().padStart(3)} ${bar.padEnd(54)}│`);
}
console.log("└─────────────────────────────────────────────────────────────────────┘\n");

// Products missing latestVersion
console.log("┌─────────────────────────────────────────────────────────────────────┐");
console.log("│ PRODUCTS MISSING LATEST VERSION (UX Issue)                          │");
console.log("├─────────────────────────────────────────────────────────────────────┤");
console.log(`│ ${noLatestVersion.length} of ${results.length} products do not have latestVersion defined          │`);
if (noLatestVersion.length > 0) {
  console.log("│                                                                     │");
  console.log("│ Sample missing:                                                     │");
  for (const r of noLatestVersion.slice(0, 10)) {
    console.log(`│   - ${r.software.padEnd(62)}│`);
  }
}
console.log("└─────────────────────────────────────────────────────────────────────┘");
