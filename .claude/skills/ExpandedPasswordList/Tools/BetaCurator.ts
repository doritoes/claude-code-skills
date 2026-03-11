#!/usr/bin/env bun
/**
 * BetaCurator.ts - Curate BETA.txt using crack statistics
 *
 * Streams all diamonds, counts cracks per BETA.txt root, and generates
 * an exclusion list of cohort/discovered roots that produced 0 cracks.
 * Cohort source files are NOT modified — only BETA.txt is slimmed down.
 *
 * The exclusion list (beta-exclusions.txt) is respected by DiamondFeedback
 * when rebuilding BETA.txt, so excluded roots stay out across batches.
 *
 * Usage:
 *   bun Tools/BetaCurator.ts                  Dry run — show what would change
 *   bun Tools/BetaCurator.ts --execute        Apply changes (write files)
 *   bun Tools/BetaCurator.ts --min-cracks 3   Exclude roots with < 3 cracks (default: 1)
 *
 * Output:
 *   data/feedback/beta-exclusions.txt  Roots excluded from BETA.txt (cohort files untouched)
 *   data/feedback/BETA.txt             Rebuilt without excluded roots
 *
 * @author PAI (Personal AI Infrastructure)
 */

import { createReadStream, existsSync, writeFileSync, readdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { DATA_DIR, DIAMONDS_DIR, FEEDBACK_DIR } from "./config";

const BETA_PATH = resolve(FEEDBACK_DIR, "BETA.txt");
const DISCOVERED_ROOTS_PATH = resolve(FEEDBACK_DIR, "discovered-roots.txt");
const EXCLUSIONS_PATH = resolve(FEEDBACK_DIR, "beta-exclusions.txt");
const COHORTS_DIR = resolve(DATA_DIR, "cohorts");
const DIAMONDS_JSONL = resolve(DIAMONDS_DIR, "hash_plaintext_pairs.jsonl");

const MIN_ROOT_LENGTH = 4;

// =============================================================================
// Helpers
// =============================================================================

function formatNum(n: number): string {
  return n.toLocaleString();
}

function pct(n: number, total: number): string {
  if (total === 0) return "0.0%";
  return ((n / total) * 100).toFixed(1) + "%";
}

function pad(s: string, width: number, align: "left" | "right" = "left"): string {
  if (align === "right") return s.padStart(width);
  return s.padEnd(width);
}

async function loadWordSet(filePath: string): Promise<Set<string>> {
  if (!existsSync(filePath)) return new Set();
  const words = new Set<string>();
  const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#")) words.add(trimmed.toLowerCase());
  }
  return words;
}

async function* streamDiamondPasswords(filePath: string): AsyncGenerator<string> {
  if (!existsSync(filePath)) return;
  const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.startsWith("{")) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.plain) yield obj.plain;
    } catch { /* skip malformed */ }
  }
}

// =============================================================================
// Main
// =============================================================================

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const execute = args.includes("--execute");
  const minCracksIdx = args.indexOf("--min-cracks");
  const minCracks = minCracksIdx !== -1 ? parseInt(args[minCracksIdx + 1], 10) || 1 : 1;

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
BetaCurator — Curate BETA.txt using crack statistics

Usage:
  bun Tools/BetaCurator.ts                  Dry run (show what would change)
  bun Tools/BetaCurator.ts --execute        Apply changes
  bun Tools/BetaCurator.ts --min-cracks 3   Exclude roots with < 3 cracks (default: 1)

What it does:
  1. Streams all diamonds, counts cracks per BETA.txt root (longest-prefix match)
  2. Generates beta-exclusions.txt for roots with < threshold cracks
  3. Rebuilds BETA.txt = discovered + cohorts - exclusions
  4. Cohort source files are NEVER modified

Files:
  beta-exclusions.txt   Excluded roots (respected by DiamondFeedback on rebuild)
  BETA.txt              Rebuilt without excluded roots
`);
    process.exit(0);
  }

  console.log("══════════════════════════════════════════════════════════════");
  console.log("  BetaCurator — BETA.txt Root Curation");
  console.log("══════════════════════════════════════════════════════════════\n");

  if (!execute) {
    console.log("  *** DRY RUN — use --execute to apply changes ***\n");
  }

  // 1. Load BETA.txt
  if (!existsSync(BETA_PATH)) {
    console.error("  ERROR: BETA.txt not found at " + BETA_PATH);
    process.exit(1);
  }
  const betaSet = await loadWordSet(BETA_PATH);
  console.log(`  BETA.txt: ${formatNum(betaSet.size)} roots`);

  // 2. Load discovered-roots.txt
  const discoveredSet = await loadWordSet(DISCOVERED_ROOTS_PATH);
  console.log(`  discovered-roots.txt: ${formatNum(discoveredSet.size)} roots`);

  // 3. Load cohort words and track per-cohort membership
  const cohortWords = new Set<string>();
  const cohortSource = new Map<string, string>(); // word → cohort name
  const cohortFiles = new Map<string, Set<string>>(); // cohort name → words
  if (existsSync(COHORTS_DIR)) {
    const files = readdirSync(COHORTS_DIR).filter(f => f.endsWith(".txt"));
    for (const file of files) {
      const name = file.replace(".txt", "");
      const words = await loadWordSet(resolve(COHORTS_DIR, file));
      cohortFiles.set(name, words);
      for (const word of words) {
        cohortWords.add(word);
        if (!cohortSource.has(word)) cohortSource.set(word, name);
      }
    }
  }
  console.log(`  Cohort words: ${formatNum(cohortWords.size)} across ${cohortFiles.size} files`);

  // 4. Load previous exclusions
  const previousExclusions = await loadWordSet(EXCLUSIONS_PATH);
  if (previousExclusions.size > 0) {
    console.log(`  Previous exclusions: ${formatNum(previousExclusions.size)} roots`);
  }

  // 5. Stream all diamonds and count cracks per BETA root
  if (!existsSync(DIAMONDS_JSONL)) {
    console.error("  ERROR: Diamonds JSONL not found at " + DIAMONDS_JSONL);
    process.exit(1);
  }

  console.log(`\n  Streaming diamonds for root attribution (substring match)...`);
  const rootCracks = new Map<string, number>();
  let totalDiamonds = 0;
  let totalAttributed = 0;

  // Substring match: find ANY BETA root anywhere in the password.
  // This catches prefix (dict+rules), suffix (combinator), and middle (prepend+append).
  // For each password, extract all substrings of length >= MIN_ROOT_LENGTH
  // and check against betaSet. A password can attribute to multiple roots.
  for await (const pw of streamDiamondPasswords(DIAMONDS_JSONL)) {
    totalDiamonds++;
    const lower = pw.toLowerCase();
    let attributed = false;

    // Extract all substrings and check against betaSet
    // For a 12-char password: ~36 substrings (lengths 4-12, positions 0-N)
    for (let start = 0; start <= lower.length - MIN_ROOT_LENGTH; start++) {
      // Check longest first at this position (greedy)
      for (let end = lower.length; end >= start + MIN_ROOT_LENGTH; end--) {
        const candidate = lower.slice(start, end);
        if (betaSet.has(candidate)) {
          rootCracks.set(candidate, (rootCracks.get(candidate) ?? 0) + 1);
          attributed = true;
          break; // longest match at this position, move to next start
        }
      }
    }

    if (attributed) totalAttributed++;

    if (totalDiamonds % 5_000_000 === 0) {
      process.stdout.write(`\r  Streamed ${formatNum(totalDiamonds)} diamonds...`);
    }
  }
  console.log(`\r  Streamed ${formatNum(totalDiamonds)} diamonds, ${formatNum(totalAttributed)} attributed\n`);

  // 6. Classify ALL BETA roots (discovered + cohort)
  const toExclude: Array<{ root: string; cracks: number; source: string }> = [];
  const toKeepDiscovered: Array<{ root: string; cracks: number }> = [];
  const toKeepCohort: Array<{ root: string; cracks: number; cohort: string }> = [];

  // Per-cohort stats
  const cohortStats = new Map<string, { total: number; active: number; dead: number; totalCracks: number }>();

  for (const root of betaSet) {
    const cracks = rootCracks.get(root) ?? 0;
    const isDiscovered = discoveredSet.has(root);
    const isCohort = cohortWords.has(root);
    const cohortName = cohortSource.get(root) ?? "unknown";

    // Track cohort stats
    if (isCohort) {
      if (!cohortStats.has(cohortName)) {
        cohortStats.set(cohortName, { total: 0, active: 0, dead: 0, totalCracks: 0 });
      }
      const stats = cohortStats.get(cohortName)!;
      stats.total++;
      stats.totalCracks += cracks;
      if (cracks >= minCracks) stats.active++;
      else stats.dead++;
    }

    if (cracks >= minCracks || root.length < MIN_ROOT_LENGTH) {
      // Keep — has cracks, or too short to measure (substring match can't find roots < MIN_ROOT_LENGTH)
      if (isCohort) {
        toKeepCohort.push({ root, cracks, cohort: cohortName });
      } else {
        toKeepDiscovered.push({ root, cracks });
      }
    } else {
      // Exclude — below threshold and long enough to be measured
      const source = isCohort ? `cohort:${cohortName}` : "discovered";
      toExclude.push({ root, cracks, source });
    }
  }

  toKeepDiscovered.sort((a, b) => b.cracks - a.cracks);
  toKeepCohort.sort((a, b) => b.cracks - a.cracks);
  toExclude.sort((a, b) => a.source.localeCompare(b.source) || b.cracks - a.cracks);

  // 7. Report
  console.log("══════════════════════════════════════════════════════════════");
  console.log("  CURATION RESULTS");
  console.log("══════════════════════════════════════════════════════════════\n");

  console.log(`  Threshold: roots with < ${minCracks} crack${minCracks > 1 ? "s" : ""} across ${formatNum(totalDiamonds)} diamonds`);
  console.log(`  (${formatNum(totalDiamonds)} diamonds = ~5% of HIBP — statistical sample)\n`);

  console.log(`  Discovered roots to keep:   ${formatNum(toKeepDiscovered.length)}`);
  console.log(`  Cohort roots to keep:       ${formatNum(toKeepCohort.length)}`);
  console.log(`  Roots to EXCLUDE:           ${formatNum(toExclude.length)}`);

  // Breakdown by source
  const excludeBySource = new Map<string, number>();
  for (const { source } of toExclude) {
    excludeBySource.set(source, (excludeBySource.get(source) ?? 0) + 1);
  }

  console.log(`\n  Exclusions by source:`);
  const sortedSources = Array.from(excludeBySource.entries()).sort((a, b) => b[1] - a[1]);
  for (const [source, count] of sortedSources) {
    console.log(`    ${pad(source, 32)} ${pad(formatNum(count), 8, "right")} roots`);
  }

  // Per-cohort summary table
  console.log(`\n  Cohort health:`);
  console.log(
    "  " + pad("Cohort", 28) + pad("Total", 8, "right") + pad("Active", 8, "right") +
    pad("Dead", 8, "right") + pad("Dead%", 8, "right") + pad("Avg Cr", 10, "right")
  );
  console.log("  " + "─".repeat(70));

  const sortedCohorts = Array.from(cohortStats.entries())
    .sort(([, a], [, b]) => {
      const deadPctA = a.total > 0 ? a.dead / a.total : 0;
      const deadPctB = b.total > 0 ? b.dead / b.total : 0;
      return deadPctB - deadPctA; // worst cohorts first
    });

  for (const [name, stats] of sortedCohorts) {
    const deadPctVal = stats.total > 0 ? ((stats.dead / stats.total) * 100).toFixed(0) + "%" : "0%";
    const avg = stats.total > 0 ? (stats.totalCracks / stats.total).toFixed(1) : "0.0";
    console.log(
      "  " + pad(name, 28) +
      pad(formatNum(stats.total), 8, "right") +
      pad(formatNum(stats.active), 8, "right") +
      pad(formatNum(stats.dead), 8, "right") +
      pad(deadPctVal, 8, "right") +
      pad(avg, 10, "right")
    );
  }

  // New BETA.txt size
  const newBetaSize = toKeepDiscovered.length + toKeepCohort.length;
  const reduction = betaSet.size - newBetaSize;
  console.log(`\n  Current BETA.txt:  ${formatNum(betaSet.size)} roots`);
  console.log(`  New BETA.txt:      ${formatNum(newBetaSize)} roots`);
  console.log(`  Reduction:         ${formatNum(reduction)} roots (${pct(reduction, betaSet.size)})`);

  const reductionPct = betaSet.size > 0 ? reduction / betaSet.size : 0;
  if (reductionPct > 0.05) {
    console.log(`\n  Estimated feedback speedup: ~${(reductionPct * 100).toFixed(0)}% faster BETA-based attacks`);
    console.log(`    (combo-beta-*, hybrid-beta-*, feedback-beta-* all scale with BETA.txt size)`);
  }

  // Sample excluded roots
  if (toExclude.length > 0) {
    const showCount = Math.min(20, toExclude.length);
    console.log(`\n  Sample excluded roots (first ${showCount}):`);
    for (const { root, cracks, source } of toExclude.slice(0, showCount)) {
      console.log(`    ${pad(root, 24)} ${pad(String(cracks), 4, "right")} cracks  [${source}]`);
    }
    if (toExclude.length > showCount) {
      console.log(`    ... and ${formatNum(toExclude.length - showCount)} more`);
    }
  }

  // 8. Execute
  if (execute) {
    console.log("\n══════════════════════════════════════════════════════════════");
    console.log("  APPLYING CHANGES");
    console.log("══════════════════════════════════════════════════════════════\n");

    // Write beta-exclusions.txt
    const exclusionSet = new Set<string>();
    for (const { root } of toExclude) {
      exclusionSet.add(root);
    }

    const exclusionLines = [
      "# beta-exclusions.txt — Roots excluded from BETA.txt (cohort files untouched)",
      "#",
      "# Generated by BetaCurator based on crack statistics.",
      "# DiamondFeedback respects this file when rebuilding BETA.txt.",
      "# Re-run BetaCurator periodically to update as more batches complete.",
      "#",
      `# Curated: ${new Date().toISOString()}`,
      `# Diamonds analyzed: ${formatNum(totalDiamonds)}`,
      `# Threshold: < ${minCracks} crack${minCracks > 1 ? "s" : ""}`,
      `# Total excluded: ${exclusionSet.size}`,
      "#",
    ];

    // Group by source for readability
    for (const [source, count] of sortedSources) {
      exclusionLines.push(`# ${source}: ${count} roots`);
    }
    exclusionLines.push("#");
    exclusionLines.push(...Array.from(exclusionSet).sort());

    writeFileSync(EXCLUSIONS_PATH, exclusionLines.join("\n") + "\n");
    console.log(`  Wrote ${formatNum(exclusionSet.size)} exclusions to beta-exclusions.txt`);

    // Rebuild BETA.txt = discovered + cohorts - exclusions
    const newBetaWords = new Set<string>();

    // Add discovered roots (minus excluded)
    for (const root of discoveredSet) {
      if (!exclusionSet.has(root)) {
        newBetaWords.add(root);
      }
    }

    // Add cohort words (minus excluded)
    for (const word of cohortWords) {
      if (!exclusionSet.has(word)) {
        newBetaWords.add(word);
      }
    }

    const betaContent = Array.from(newBetaWords).join("\n") + "\n";
    writeFileSync(BETA_PATH, betaContent);
    console.log(`  Wrote ${formatNum(newBetaWords.size)} roots to BETA.txt (was ${formatNum(betaSet.size)})`);

    console.log(`\n  IMPORTANT: Sync updated BETA.txt to BIGRED before next batch`);
    console.log(`    bun Tools/BigRedSync.ts --sync-attack-files`);
  } else {
    console.log(`\n  To apply: bun Tools/BetaCurator.ts --execute`);
    if (minCracks === 1) {
      console.log(`  More aggressive: bun Tools/BetaCurator.ts --execute --min-cracks 3`);
    }
  }

  console.log("\n══════════════════════════════════════════════════════════════");
  console.log("  CURATION COMPLETE");
  console.log("══════════════════════════════════════════════════════════════");
}

main().catch((err) => {
  console.error("Fatal error:", err.message || err);
  process.exit(1);
});
