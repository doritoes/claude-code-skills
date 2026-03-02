#!/usr/bin/env bun
/**
 * DeepAnalysis.ts - Deep Analysis of Pearls & Diamonds for Feedback Loop Optimization
 *
 * Produces actionable findings from pearls + diamonds data to improve
 * the feedback loop and longer password coverage.
 *
 * Usage:
 *   bun Tools/DeepAnalysis.ts --length      Length distribution (pearls vs diamonds)
 *   bun Tools/DeepAnalysis.ts --suffixes    Diamond suffix pattern extraction
 *   bun Tools/DeepAnalysis.ts --roots       Root source attribution
 *   bun Tools/DeepAnalysis.ts --long        9+ char deep dive
 *   bun Tools/DeepAnalysis.ts --feedback    Feedback loop health metrics
 *   bun Tools/DeepAnalysis.ts --beta        Per-root crack attribution for BETA.txt
 *   bun Tools/DeepAnalysis.ts --full        All sections
 *
 * READ-ONLY: Never modifies any data files.
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { DATA_DIR, DIAMONDS_DIR, PEARLS_DIR, FEEDBACK_DIR } from "./config";
import { SandStateManager, type BatchState } from "./SandStateManager";

// =============================================================================
// Constants
// =============================================================================

const NOCAP_PATH = resolve(DATA_DIR, "nocap.txt");
const NOCAP_PLUS_PATH = resolve(DATA_DIR, "nocap-plus.txt");
const BETA_PATH = resolve(FEEDBACK_DIR, "BETA.txt");
const COHORTS_DIR = resolve(DATA_DIR, "cohorts");
const NOCAP_RULE_PATH = resolve(DATA_DIR, "nocap.rule");
const UNOBTAINIUM_RULE_PATH = resolve(FEEDBACK_DIR, "unobtainium.rule");

const PEARLS_JSONL = resolve(PEARLS_DIR, "hash_plaintext_pairs.jsonl");
const DIAMONDS_JSONL = resolve(DIAMONDS_DIR, "hash_plaintext_pairs.jsonl");

/** Feedback attack prefixes for trend tracking */
const FEEDBACK_PREFIXES = ["feedback-", "nocapplus-", "hybrid-beta-", "combo-beta-"];

// =============================================================================
// Helpers
// =============================================================================

function pad(s: string, width: number, align: "left" | "right" = "left"): string {
  if (align === "right") return s.padStart(width);
  return s.padEnd(width);
}

function pct(n: number, total: number): string {
  if (total === 0) return "0.0%";
  return ((n / total) * 100).toFixed(1) + "%";
}

function formatNum(n: number): string {
  return n.toLocaleString();
}

/**
 * Stream a JSONL file, extract the "plain" field from each line.
 */
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

/**
 * Load a wordlist file into a Set (lowercased).
 */
async function loadWordSet(filePath: string): Promise<Set<string>> {
  if (!existsSync(filePath)) return new Set();
  const words = new Set<string>();
  const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed) words.add(trimmed.toLowerCase());
  }
  return words;
}

/**
 * Load existing hashcat rules from a file into a Set (for dedup checking).
 */
function loadRuleSet(filePath: string): Set<string> {
  if (!existsSync(filePath)) return new Set();
  const rules = new Set<string>();
  const content = readFileSync(filePath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#")) rules.add(trimmed);
  }
  return rules;
}

/**
 * Convert a literal suffix string to a hashcat append rule.
 * Returns null if suffix is too long (>15 operations).
 */
function suffixToRule(suffix: string): string | null {
  if (suffix.length === 0 || suffix.length > 15) return null;
  return suffix.split("").map(c => `$${c}`).join(" ");
}

/**
 * Classify a suffix into a type category.
 */
function classifySuffix(suffix: string): string {
  if (suffix.length === 0) return "none";
  if (/^\d+$/.test(suffix)) return "digits";
  if (/^[^a-zA-Z0-9]+$/.test(suffix)) return "special";
  if (/^[^a-zA-Z0-9]+\d+$/.test(suffix)) return "special+digits";
  if (/^[a-zA-Z]+$/.test(suffix)) return "alpha";
  return "mixed";
}

/**
 * Decompose a password into root + suffix by finding longest prefix in wordSet.
 * Returns the root, suffix, and which wordlist the root was found in.
 */
function decomposePassword(
  password: string,
  wordSets: Map<string, Set<string>>,
): { root: string; suffix: string; rootSource: string } {
  const lower = password.toLowerCase();

  // Try progressively shorter prefixes
  for (let len = lower.length; len >= 3; len--) {
    const candidate = lower.slice(0, len);
    const remainder = password.slice(len);

    // Check word sets in order of specificity
    for (const [name, wordSet] of wordSets) {
      if (wordSet.has(candidate)) {
        return { root: candidate, suffix: remainder, rootSource: name };
      }
    }
  }

  return { root: lower, suffix: "", rootSource: "unknown" };
}

// =============================================================================
// Section 1: Length Distribution
// =============================================================================

async function analyzeLength(): Promise<void> {
  console.log("\n══════════════════════════════════════════════════════════════");
  console.log("  SECTION 1: LENGTH DISTRIBUTION — Pearls vs Diamonds");
  console.log("══════════════════════════════════════════════════════════════\n");

  // --- Diamonds: parse all ---
  const diamondLengths: Record<number, number> = {};
  let diamondTotal = 0;

  if (!existsSync(DIAMONDS_JSONL)) {
    console.log("  ERROR: Diamonds JSONL not found at " + DIAMONDS_JSONL);
    return;
  }

  for await (const pw of streamDiamondPasswords(DIAMONDS_JSONL)) {
    diamondLengths[pw.length] = (diamondLengths[pw.length] ?? 0) + 1;
    diamondTotal++;
  }
  console.log(`  Diamonds loaded: ${formatNum(diamondTotal)} passwords`);

  // --- Pearls: sample every 1000th line ---
  // Format is JSONL: {"hash":"...","plain":"..."}
  // SHA-1 = 40 chars, so we can estimate length from line length for speed,
  // but JSONL has JSON overhead. We'll parse sampled lines instead.
  const pearlLengths: Record<number, number> = {};
  let pearlTotal = 0;
  let pearlSampled = 0;

  if (!existsSync(PEARLS_JSONL)) {
    console.log("  WARNING: Pearls JSONL not found at " + PEARLS_JSONL);
    console.log("  Showing diamonds-only distribution.\n");
  } else {
    const rl = createInterface({ input: createReadStream(PEARLS_JSONL), crlfDelay: Infinity });
    for await (const line of rl) {
      pearlTotal++;
      if (pearlTotal % 1000 !== 0) continue; // sample every 1000th
      if (!line.startsWith("{")) continue;
      try {
        const obj = JSON.parse(line);
        const pw = obj.plain;
        if (!pw) continue;
        pearlLengths[pw.length] = (pearlLengths[pw.length] ?? 0) + 1;
        pearlSampled++;
      } catch { /* skip */ }
    }
    console.log(`  Pearls scanned: ${formatNum(pearlTotal)} lines, sampled ${formatNum(pearlSampled)}`);
  }

  // --- Display ---
  const allLengths = new Set([
    ...Object.keys(diamondLengths).map(Number),
    ...Object.keys(pearlLengths).map(Number),
  ]);
  const minLen = Math.min(...allLengths);
  const maxLen = Math.min(Math.max(...allLengths), 30);

  const hasPearls = pearlSampled > 0;
  const header = hasPearls
    ? pad("Len", 5) + pad("Pearls (samp)", 16, "right") + pad("Prl %", 8, "right") + pad("Diamonds", 12, "right") + pad("Dia %", 8, "right") + pad("Delta", 8, "right")
    : pad("Len", 5) + pad("Diamonds", 12, "right") + pad("Dia %", 8, "right");

  console.log("\n" + header);
  console.log("─".repeat(hasPearls ? 57 : 25));

  for (let len = minLen; len <= maxLen; len++) {
    const dCount = diamondLengths[len] ?? 0;
    const pCount = pearlLengths[len] ?? 0;
    if (dCount === 0 && pCount === 0) continue;

    const dPct = diamondTotal > 0 ? (dCount / diamondTotal) * 100 : 0;

    if (hasPearls) {
      const pPct = pearlSampled > 0 ? (pCount / pearlSampled) * 100 : 0;
      const delta = dPct - pPct;
      const deltaStr = delta > 0 ? `+${delta.toFixed(1)}pp` : `${delta.toFixed(1)}pp`;
      console.log(
        pad(String(len), 5) +
        pad(formatNum(pCount), 16, "right") +
        pad(pPct.toFixed(1) + "%", 8, "right") +
        pad(formatNum(dCount), 12, "right") +
        pad(dPct.toFixed(1) + "%", 8, "right") +
        pad(deltaStr, 8, "right")
      );
    } else {
      console.log(
        pad(String(len), 5) +
        pad(formatNum(dCount), 12, "right") +
        pad(dPct.toFixed(1) + "%", 8, "right")
      );
    }
  }

  // Summary stats
  const d9plus = Object.entries(diamondLengths)
    .filter(([len]) => Number(len) >= 9)
    .reduce((sum, [, count]) => sum + count, 0);

  console.log("\n  Summary:");
  console.log(`    Diamonds 9+ chars: ${formatNum(d9plus)} (${pct(d9plus, diamondTotal)})`);

  if (hasPearls) {
    const p9plus = Object.entries(pearlLengths)
      .filter(([len]) => Number(len) >= 9)
      .reduce((sum, [, count]) => sum + count, 0);
    console.log(`    Pearls 9+ chars (sampled): ${formatNum(p9plus)} (${pct(p9plus, pearlSampled)})`);
    const delta9 = (d9plus / diamondTotal) * 100 - (p9plus / pearlSampled) * 100;
    console.log(`    Delta 9+: ${delta9 > 0 ? "+" : ""}${delta9.toFixed(1)}pp`);
  }
}

// =============================================================================
// Section 2: Suffix Pattern Extraction
// =============================================================================

async function analyzeSuffixes(): Promise<void> {
  console.log("\n══════════════════════════════════════════════════════════════");
  console.log("  SECTION 2: DIAMOND SUFFIX PATTERN EXTRACTION");
  console.log("══════════════════════════════════════════════════════════════\n");

  if (!existsSync(DIAMONDS_JSONL)) {
    console.log("  ERROR: Diamonds JSONL not found.");
    return;
  }

  // Load nocap-plus.txt into Set for root matching
  console.log("  Loading nocap-plus.txt for root lookups...");
  const nocapPlusSet = await loadWordSet(NOCAP_PLUS_PATH);
  console.log(`    nocap-plus.txt: ${formatNum(nocapPlusSet.size)} words`);

  const betaSet = await loadWordSet(BETA_PATH);
  console.log(`    BETA.txt: ${formatNum(betaSet.size)} words`);

  // Load existing rules for MISSING detection
  const existingRules = new Set<string>();
  for (const rulePath of [NOCAP_RULE_PATH, UNOBTAINIUM_RULE_PATH]) {
    for (const rule of loadRuleSet(rulePath)) {
      existingRules.add(rule);
    }
  }
  console.log(`    Existing rules loaded: ${formatNum(existingRules.size)}`);

  // Build ordered word sets for decomposition (most specific first)
  const wordSets = new Map<string, Set<string>>();
  wordSets.set("beta", betaSet);
  wordSets.set("nocap-plus", nocapPlusSet);

  // Analyze all diamonds
  const suffixCounts = new Map<string, number>();
  const suffixTypeCounts: Record<string, number> = {};
  const rootSourceCounts: Record<string, number> = {};
  let total = 0;

  for await (const pw of streamDiamondPasswords(DIAMONDS_JSONL)) {
    total++;
    const { suffix, rootSource } = decomposePassword(pw, wordSets);
    const suffType = classifySuffix(suffix);

    suffixTypeCounts[suffType] = (suffixTypeCounts[suffType] ?? 0) + 1;
    rootSourceCounts[rootSource] = (rootSourceCounts[rootSource] ?? 0) + 1;

    if (suffix.length > 0 && suffix.length <= 15) {
      suffixCounts.set(suffix, (suffixCounts.get(suffix) ?? 0) + 1);
    }
  }

  // Root source summary
  console.log(`\n  Root found in:  ` +
    Object.entries(rootSourceCounts)
      .sort(([, a], [, b]) => b - a)
      .map(([src, count]) => `${src} ${pct(count, total)}`)
      .join("  |  ")
  );

  // Suffix type summary
  console.log(`\n  Suffix type distribution (${formatNum(total)} diamonds):`);
  for (const [type, count] of Object.entries(suffixTypeCounts).sort(([, a], [, b]) => b - a)) {
    console.log(`    ${pad(type, 16)} ${pad(formatNum(count), 10, "right")} ${pad(pct(count, total), 8, "right")}`);
  }

  // Top suffixes
  const topSuffixes = Array.from(suffixCounts.entries())
    .sort(([, a], [, b]) => b - a)
    .slice(0, 50);

  console.log(`\n  Top 50 Suffixes:`);
  console.log(
    "  " + pad("Rank", 5) + pad("Suffix", 14) + pad("Count", 10, "right") +
    pad("Type", 16) + pad("Hashcat Rule", 24) + "Status"
  );
  console.log("  " + "─".repeat(80));

  let rank = 0;
  for (const [suffix, count] of topSuffixes) {
    rank++;
    const suffType = classifySuffix(suffix);
    const rule = suffixToRule(suffix);
    const ruleStr = rule ?? "(too long)";
    const status = rule && existingRules.has(rule) ? "EXISTS" : rule ? "MISSING" : "";

    // Show suffix with visible representation for specials
    const displaySuffix = suffix.length > 12 ? suffix.slice(0, 9) + "..." : suffix;

    console.log(
      "  " + pad(String(rank), 5) +
      pad(displaySuffix, 14) +
      pad(formatNum(count), 10, "right") +
      pad(suffType, 16) +
      pad(ruleStr, 24) +
      status
    );
  }

  // Count missing rules
  const missingRules: { suffix: string; rule: string; count: number }[] = [];
  for (const [suffix, count] of topSuffixes) {
    const rule = suffixToRule(suffix);
    if (rule && !existingRules.has(rule)) {
      missingRules.push({ suffix, rule, count });
    }
  }

  if (missingRules.length > 0) {
    console.log(`\n  ACTIONABLE: ${missingRules.length} MISSING rules in top 50 suffixes`);
    console.log("  Add these to UNOBTAINIUM.rule:");
    for (const { suffix, rule, count } of missingRules.slice(0, 20)) {
      console.log(`    ${rule}  # "${suffix}" (${formatNum(count)} diamonds)`);
    }
  }
}

// =============================================================================
// Section 3: Root Source Attribution
// =============================================================================

async function analyzeRoots(): Promise<void> {
  console.log("\n══════════════════════════════════════════════════════════════");
  console.log("  SECTION 3: ROOT SOURCE ATTRIBUTION");
  console.log("══════════════════════════════════════════════════════════════\n");

  if (!existsSync(DIAMONDS_JSONL)) {
    console.log("  ERROR: Diamonds JSONL not found.");
    return;
  }

  // Load wordlists into tagged sets
  console.log("  Loading wordlists...");
  const nocapSet = await loadWordSet(NOCAP_PATH);
  console.log(`    nocap.txt: ${formatNum(nocapSet.size)} words`);

  const betaSet = await loadWordSet(BETA_PATH);
  console.log(`    BETA.txt: ${formatNum(betaSet.size)} words`);

  // Load cohort files individually
  const cohortSets = new Map<string, Set<string>>();
  if (existsSync(COHORTS_DIR)) {
    const cohortFiles = readdirSync(COHORTS_DIR).filter(f => f.endsWith(".txt"));
    for (const file of cohortFiles) {
      const name = file.replace(".txt", "");
      const filePath = resolve(COHORTS_DIR, file);
      const words = await loadWordSet(filePath);
      cohortSets.set(name, words);
      console.log(`    cohort/${name}: ${formatNum(words.size)} words`);
    }
  }

  // Build ordered word sets: cohorts first (most specific), then beta, then baseline
  const wordSets = new Map<string, Set<string>>();
  for (const [name, set] of cohortSets) {
    wordSets.set(`cohort:${name}`, set);
  }
  wordSets.set("beta", betaSet);
  wordSets.set("baseline", nocapSet);

  // Analyze diamonds
  const sourceCounts: Record<string, number> = {};
  let total = 0;

  for await (const pw of streamDiamondPasswords(DIAMONDS_JSONL)) {
    total++;
    const { rootSource } = decomposePassword(pw, wordSets);
    sourceCounts[rootSource] = (sourceCounts[rootSource] ?? 0) + 1;
  }

  console.log(`\n  ROOT SOURCE ATTRIBUTION (${formatNum(total)} diamonds)\n`);
  console.log(
    "  " + pad("Source", 30) + pad("Diamonds", 12, "right") + pad("Share", 8, "right")
  );
  console.log("  " + "─".repeat(50));

  // Group cohorts together
  let cohortTotal = 0;
  const cohortBreakdown: [string, number][] = [];

  const sorted = Object.entries(sourceCounts).sort(([, a], [, b]) => b - a);
  for (const [source, count] of sorted) {
    if (source.startsWith("cohort:")) {
      cohortTotal += count;
      cohortBreakdown.push([source.replace("cohort:", ""), count]);
    } else {
      console.log(
        "  " + pad(source, 30) +
        pad(formatNum(count), 12, "right") +
        pad(pct(count, total), 8, "right")
      );
    }
  }

  // Print cohort aggregate + breakdown
  if (cohortTotal > 0) {
    console.log(
      "  " + pad("cohort files (combined)", 30) +
      pad(formatNum(cohortTotal), 12, "right") +
      pad(pct(cohortTotal, total), 8, "right")
    );
    cohortBreakdown.sort(([, a], [, b]) => b - a);
    for (const [name, count] of cohortBreakdown) {
      console.log(
        "  " + pad(`  ${name}`, 30) +
        pad(formatNum(count), 12, "right") +
        pad(pct(count, total), 8, "right")
      );
    }
  }

  console.log("  " + "─".repeat(50));
  console.log(
    "  " + pad("TOTAL", 30) +
    pad(formatNum(total), 12, "right") +
    pad("100.0%", 8, "right")
  );
}

// =============================================================================
// Section 4: Long Password Deep Dive (9+ chars)
// =============================================================================

async function analyzeLong(): Promise<void> {
  console.log("\n══════════════════════════════════════════════════════════════");
  console.log("  SECTION 4: LONG PASSWORD DEEP DIVE (9+ chars)");
  console.log("══════════════════════════════════════════════════════════════\n");

  if (!existsSync(DIAMONDS_JSONL)) {
    console.log("  ERROR: Diamonds JSONL not found.");
    return;
  }

  // Collect 9+ char diamonds
  const longPasswords: string[] = [];
  let totalDiamonds = 0;

  for await (const pw of streamDiamondPasswords(DIAMONDS_JSONL)) {
    totalDiamonds++;
    if (pw.length >= 9) longPasswords.push(pw);
  }

  console.log(`  Total diamonds: ${formatNum(totalDiamonds)}`);
  console.log(`  9+ char diamonds: ${formatNum(longPasswords.length)} (${pct(longPasswords.length, totalDiamonds)})\n`);

  if (longPasswords.length === 0) {
    console.log("  No 9+ char diamonds found.");
    return;
  }

  // Classify by structural pattern
  const patternCounts: Record<string, { count: number; examples: string[] }> = {};

  function addPattern(pattern: string, pw: string) {
    if (!patternCounts[pattern]) patternCounts[pattern] = { count: 0, examples: [] };
    patternCounts[pattern].count++;
    if (patternCounts[pattern].examples.length < 3) {
      patternCounts[pattern].examples.push(pw);
    }
  }

  for (const pw of longPasswords) {
    const lower = pw.toLowerCase();
    const hasLower = /[a-z]/.test(pw);
    const hasUpper = /[A-Z]/.test(pw);
    const hasDigit = /\d/.test(pw);
    const hasSpecial = /[^a-zA-Z0-9]/.test(pw);

    // Classify into mutually exclusive categories (first match wins)
    if (/^[a-z]+\d+$/.test(pw)) {
      addPattern("word+digits", pw);
    } else if (/^[A-Z][a-z]+\d+$/.test(pw)) {
      addPattern("Word+digits", pw);
    } else if (/^[a-zA-Z]+[!@#$%^&*()_\-+=.]+\d+$/.test(pw)) {
      addPattern("word+special+digits", pw);
    } else if (/^[a-z]+$/.test(pw)) {
      addPattern("pure-lowercase", pw);
    } else if (/^[a-z0-9]+$/.test(pw) && hasLower && hasDigit) {
      addPattern("pure-alnum", pw);
    } else if (/^[A-Z][a-z]+[a-z]+$/.test(pw) && pw.length >= 9) {
      // Capitalize + lowercase continuation (e.g., "Iloveyou" but 9+)
      addPattern("Capitalize+word", pw);
    } else if (/^[a-zA-Z]+$/.test(pw) && hasLower && hasUpper) {
      addPattern("mixed-case-alpha", pw);
    } else if (/^\d+$/.test(pw)) {
      addPattern("pure-digits", pw);
    } else if (hasLower && hasDigit && !hasUpper && !hasSpecial) {
      // Interleaved lower+digit (not matching word+digits pattern)
      addPattern("interleaved-lower-digit", pw);
    } else if (hasSpecial && hasLower && hasDigit) {
      addPattern("complex-with-special", pw);
    } else if (hasUpper && hasLower && hasDigit && !hasSpecial) {
      addPattern("mixed-case+digits", pw);
    } else {
      addPattern("other", pw);
    }
  }

  // Print pattern summary
  const total = longPasswords.length;
  const sorted = Object.entries(patternCounts)
    .sort(([, a], [, b]) => b.count - a.count);

  console.log(
    "  " + pad("Pattern", 26) + pad("Count", 10, "right") +
    pad("Share", 8, "right") + "  Examples"
  );
  console.log("  " + "─".repeat(80));

  for (const [pattern, { count, examples }] of sorted) {
    const exStr = examples.slice(0, 2).map(e => e.length > 16 ? e.slice(0, 13) + "..." : e).join(", ");
    console.log(
      "  " + pad(pattern, 26) +
      pad(formatNum(count), 10, "right") +
      pad(pct(count, total), 8, "right") +
      "  " + exStr
    );
  }

  // Attack coverage mapping
  console.log("\n  ATTACK COVERAGE MAPPING:");
  console.log("  " + "─".repeat(80));

  const coverageMap: Record<string, string> = {
    "word+digits": "hybrid-nocapplus-4digit (4d), hybrid-nocapplus-3any (3 any)",
    "Word+digits": "hybrid-nocapplus-4digit (with c rule), hybrid-nocapplus-3any",
    "word+special+digits": "hybrid-nocapplus-3any (partial), hybrid-nocapplus-special-digits",
    "pure-lowercase": "mask-l9 (9 only), mask-l8 (8 only). NO coverage for 10+",
    "pure-alnum": "mask-ld8 (8 only). NO dedicated 9+ alnum mask",
    "Capitalize+word": "feedback-beta-nocaprule (if root in BETA), c rule",
    "mixed-case-alpha": "feedback rules (partial). NO dedicated mask",
    "pure-digits": "brute-7 (7 only). NO dedicated 9+ digit mask",
    "interleaved-lower-digit": "feedback-beta-nocaprule (partial). Mostly UNCOVERED",
    "complex-with-special": "hybrid-nocapplus-3any (partial). Mostly UNCOVERED",
    "mixed-case+digits": "feedback rules (partial). Mostly UNCOVERED",
    "other": "UNCOVERED",
  };

  for (const [pattern, { count }] of sorted) {
    const coverage = coverageMap[pattern] ?? "UNKNOWN";
    console.log(`  ${pad(pattern, 26)} → ${coverage}`);
  }

  // Uncovered summary
  const uncoveredPatterns = sorted
    .filter(([p]) => {
      const cov = coverageMap[p] ?? "";
      return cov.includes("UNCOVERED") || cov.includes("NO coverage") || cov.includes("NO dedicated");
    });

  if (uncoveredPatterns.length > 0) {
    const uncoveredCount = uncoveredPatterns.reduce((sum, [, { count }]) => sum + count, 0);
    console.log(`\n  GAP SUMMARY: ${formatNum(uncoveredCount)} (${pct(uncoveredCount, total)}) of 9+ char diamonds have weak/no attack coverage`);
    for (const [pattern, { count }] of uncoveredPatterns) {
      console.log(`    ${pad(pattern, 26)} ${formatNum(count)} (${pct(count, total)})`);
    }
  }
}

// =============================================================================
// Section 5: Feedback Loop Health
// =============================================================================

async function analyzeFeedback(): Promise<void> {
  console.log("\n══════════════════════════════════════════════════════════════");
  console.log("  SECTION 5: FEEDBACK LOOP HEALTH");
  console.log("══════════════════════════════════════════════════════════════\n");

  const mgr = new SandStateManager();
  const state = mgr.load();

  const completedBatches = Object.entries(state.batches)
    .filter(([, b]) => b.status === "completed")
    .sort(([a], [b]) => a.localeCompare(b));

  if (completedBatches.length === 0) {
    console.log("  No completed batches in sand-state.json.");
    return;
  }

  console.log(`  Completed batches: ${completedBatches.length}\n`);

  // Per-batch feedback data
  interface BatchRow {
    name: string;
    betaSize: number;
    feedbackCracks: number;
    totalCracks: number;
    hashCount: number;
    crackRate: number;
  }

  const rows: BatchRow[] = [];

  for (const [name, batch] of completedBatches) {
    let feedbackCracks = 0;
    for (const result of batch.attackResults) {
      if (FEEDBACK_PREFIXES.some(p => result.attack.startsWith(p))) {
        feedbackCracks += result.newCracks;
      }
    }

    const betaSize = batch.feedback?.betaSize ?? 0;
    const crackRate = batch.hashCount > 0 ? batch.cracked / batch.hashCount : 0;

    rows.push({
      name,
      betaSize,
      feedbackCracks,
      totalCracks: batch.cracked,
      hashCount: batch.hashCount,
      crackRate,
    });
  }

  // Display table
  console.log(
    "  " + pad("Batch", 14) +
    pad("BETA sz", 10, "right") +
    pad("FB Cracks", 11, "right") +
    pad("Total Cr", 10, "right") +
    pad("Rate", 8, "right") +
    pad("Marginal", 10, "right")
  );
  console.log("  " + "─".repeat(63));

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const prev = i > 0 ? rows[i - 1] : null;
    const marginal = prev ? row.feedbackCracks - prev.feedbackCracks : 0;
    const marginalStr = i === 0 ? "(base)" : (marginal >= 0 ? `+${marginal}` : String(marginal));

    console.log(
      "  " + pad(row.name, 14) +
      pad(row.betaSize > 0 ? formatNum(row.betaSize) : "—", 10, "right") +
      pad(formatNum(row.feedbackCracks), 11, "right") +
      pad(formatNum(row.totalCracks), 10, "right") +
      pad((row.crackRate * 100).toFixed(2) + "%", 8, "right") +
      pad(marginalStr, 10, "right")
    );
  }

  // Trend analysis
  if (rows.length >= 5) {
    const last5 = rows.slice(-5);
    const fbValues = last5.map(r => r.feedbackCracks);
    const firstFb = fbValues[0];
    const lastFb = fbValues[fbValues.length - 1];
    const avgFb = fbValues.reduce((a, b) => a + b, 0) / fbValues.length;

    console.log("\n  FEEDBACK TREND (last 5 batches):");
    console.log(`    First: ${firstFb}  |  Last: ${lastFb}  |  Avg: ${avgFb.toFixed(0)}`);

    const direction = lastFb > firstFb * 1.1 ? "IMPROVING"
      : lastFb < firstFb * 0.9 ? "DECLINING"
      : "FLAT";
    console.log(`    Direction: ${direction}`);

    if (direction === "FLAT") {
      console.log(`\n  DIAGNOSIS: Feedback cracks FLAT at ~${avgFb.toFixed(0)}/batch despite BETA.txt growth`);

      // Check BETA.txt growth
      const firstBeta = last5[0].betaSize;
      const lastBeta = last5[last5.length - 1].betaSize;
      if (firstBeta > 0 && lastBeta > firstBeta) {
        const growth = ((lastBeta - firstBeta) / firstBeta * 100).toFixed(0);
        console.log(`    BETA.txt grew ${growth}% (${formatNum(firstBeta)} → ${formatNum(lastBeta)}) but cracks didn't increase`);
        console.log("    ROOT CAUSE: New roots are increasingly niche (low frequency in HIBP)");
        console.log("    RECOMMENDATION: Shift from quantity to quality — curate top-performing roots");
      }
    } else if (direction === "IMPROVING") {
      console.log("\n  Feedback loop is healthy and compounding.");
    } else {
      console.log("\n  DIAGNOSIS: Feedback cracks DECLINING — investigate rule/wordlist quality");
    }
  }

  // Per-attack feedback breakdown
  console.log("\n  FEEDBACK ATTACK BREAKDOWN (cumulative):");
  console.log("  " + "─".repeat(50));

  const fbAttackTotals: Record<string, { cracks: number; batches: number }> = {};
  for (const [, batch] of completedBatches) {
    for (const result of batch.attackResults) {
      if (FEEDBACK_PREFIXES.some(p => result.attack.startsWith(p))) {
        if (!fbAttackTotals[result.attack]) fbAttackTotals[result.attack] = { cracks: 0, batches: 0 };
        fbAttackTotals[result.attack].cracks += result.newCracks;
        fbAttackTotals[result.attack].batches++;
      }
    }
  }

  for (const [attack, { cracks, batches }] of Object.entries(fbAttackTotals).sort(([, a], [, b]) => b.cracks - a.cracks)) {
    const avg = batches > 0 ? (cracks / batches).toFixed(0) : "0";
    console.log(`    ${pad(attack, 32)} ${pad(formatNum(cracks), 8, "right")} total  (${avg}/batch avg, ${batches} runs)`);
  }

  // UNOBTAINIUM.rule size tracking
  if (existsSync(UNOBTAINIUM_RULE_PATH)) {
    const ruleCount = loadRuleSet(UNOBTAINIUM_RULE_PATH).size;
    console.log(`\n  Current UNOBTAINIUM.rule: ${ruleCount} active rules`);
  }

  if (existsSync(BETA_PATH)) {
    const betaLines = readFileSync(BETA_PATH, "utf-8").split("\n").filter(l => l.trim()).length;
    console.log(`  Current BETA.txt: ${formatNum(betaLines)} roots`);
  }
}

// =============================================================================
// Section 6: BETA.txt Root Attribution
// =============================================================================

const DISCOVERED_ROOTS_PATH = resolve(FEEDBACK_DIR, "discovered-roots.txt");
const MIN_ROOT_LENGTH = 4;

async function analyzeBetaRoots(batchNum?: number): Promise<void> {
  console.log("\n══════════════════════════════════════════════════════════════");
  console.log("  SECTION 6: BETA.txt ROOT ATTRIBUTION" + (batchNum != null ? ` (batch-${String(batchNum).padStart(4, "0")} only)` : ""));
  console.log("══════════════════════════════════════════════════════════════\n");

  // Determine diamond source: per-batch password file or combined JSONL
  let diamondSource: string;
  let isBatchFile = false;
  if (batchNum != null) {
    const batchFile = resolve(DIAMONDS_DIR, `passwords-batch-${String(batchNum).padStart(4, "0")}.txt`);
    if (!existsSync(batchFile)) {
      console.log("  ERROR: Batch password file not found at " + batchFile);
      return;
    }
    diamondSource = batchFile;
    isBatchFile = true;
  } else {
    if (!existsSync(DIAMONDS_JSONL)) {
      console.log("  ERROR: Diamonds JSONL not found at " + DIAMONDS_JSONL);
      return;
    }
    diamondSource = DIAMONDS_JSONL;
  }

  if (!existsSync(BETA_PATH)) {
    console.log("  ERROR: BETA.txt not found at " + BETA_PATH);
    return;
  }

  // 1. Load BETA.txt into Set (lowercased)
  console.log("  Loading BETA.txt...");
  const betaSet = await loadWordSet(BETA_PATH);
  console.log(`    BETA.txt: ${formatNum(betaSet.size)} roots`);

  // 2. Build source map: for each BETA root, where did it come from?
  console.log("  Building source map...");
  const discoveredSet = new Set<string>();
  if (existsSync(DISCOVERED_ROOTS_PATH)) {
    const rl = createInterface({ input: createReadStream(DISCOVERED_ROOTS_PATH), crlfDelay: Infinity });
    for await (const line of rl) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#")) discoveredSet.add(trimmed.toLowerCase());
    }
    console.log(`    discovered-roots.txt: ${formatNum(discoveredSet.size)} roots`);
  }

  // Load cohort files → Map<word, cohortName>
  const cohortMembership = new Map<string, string>();
  if (existsSync(COHORTS_DIR)) {
    const cohortFiles = readdirSync(COHORTS_DIR).filter(f => f.endsWith(".txt"));
    for (const file of cohortFiles) {
      const name = file.replace(".txt", "");
      const filePath = resolve(COHORTS_DIR, file);
      const words = await loadWordSet(filePath);
      for (const word of words) {
        if (!cohortMembership.has(word)) {
          cohortMembership.set(word, name);
        }
      }
      console.log(`    cohort/${name}: ${formatNum(words.size)} words`);
    }
  }

  // Build rootSource for every BETA root
  const rootSource = new Map<string, string>();
  for (const root of betaSet) {
    if (discoveredSet.has(root)) {
      rootSource.set(root, "discovered");
    } else if (cohortMembership.has(root)) {
      rootSource.set(root, `cohort:${cohortMembership.get(root)!}`);
    } else {
      rootSource.set(root, "unknown");
    }
  }

  // 3. Stream diamonds, attribute each to a BETA root via longest-prefix match
  console.log(`  Streaming diamonds from ${isBatchFile ? "batch file" : "combined JSONL"}...`);
  const rootCracks = new Map<string, number>();
  let totalDiamonds = 0;
  let totalAttributed = 0;

  // Stream passwords from either JSONL or plain-text batch file
  async function* streamPasswords(): AsyncGenerator<string> {
    if (isBatchFile) {
      // Plain text: one password per line — strip \r only, preserve spaces
      const rl = createInterface({ input: createReadStream(diamondSource), crlfDelay: Infinity });
      for await (const line of rl) {
        const clean = line.replace(/\r$/, "");
        if (clean.length > 0) yield clean;
      }
    } else {
      yield* streamDiamondPasswords(diamondSource);
    }
  }

  for await (const pw of streamPasswords()) {
    totalDiamonds++;
    const lower = pw.toLowerCase();

    // Greedy longest-prefix match against BETA-only Set
    for (let len = lower.length; len >= MIN_ROOT_LENGTH; len--) {
      const candidate = lower.slice(0, len);
      if (betaSet.has(candidate)) {
        rootCracks.set(candidate, (rootCracks.get(candidate) ?? 0) + 1);
        totalAttributed++;
        break;
      }
    }
  }

  console.log(`    Diamonds streamed: ${formatNum(totalDiamonds)}`);
  console.log(`    Attributed to BETA roots: ${formatNum(totalAttributed)}`);

  // 4. Aggregate and report

  // Coverage summary
  let rootsWithCracks = 0;
  let rootsWithZero = 0;
  for (const root of betaSet) {
    if ((rootCracks.get(root) ?? 0) > 0) rootsWithCracks++;
    else rootsWithZero++;
  }

  console.log(`\n  COVERAGE SUMMARY`);
  console.log(`  Total BETA.txt roots:   ${formatNum(betaSet.size)}`);
  console.log(`  Roots with ≥1 crack:    ${formatNum(rootsWithCracks)} (${pct(rootsWithCracks, betaSet.size)})`);
  console.log(`  Roots with 0 cracks:    ${formatNum(rootsWithZero)} (${pct(rootsWithZero, betaSet.size)})`);
  console.log(`  Total attributions:     ${formatNum(totalAttributed)}`);

  // Top 50 roots by crack count
  const sortedRoots = Array.from(betaSet)
    .map(root => ({ root, cracks: rootCracks.get(root) ?? 0, source: rootSource.get(root) ?? "unknown" }))
    .filter(r => r.cracks > 0)
    .sort((a, b) => b.cracks - a.cracks);

  console.log(`\n  TOP 50 ROOTS BY CRACK COUNT`);
  console.log(
    "  " + pad("Root", 24) + pad("Source", 28) + pad("Cracks", 10, "right") + pad("Cum%", 8, "right")
  );
  console.log("  " + "─".repeat(70));

  let cumCracks = 0;
  for (const entry of sortedRoots.slice(0, 50)) {
    cumCracks += entry.cracks;
    const displayRoot = entry.root.length > 22 ? entry.root.slice(0, 19) + "..." : entry.root;
    const displaySource = entry.source.length > 26 ? entry.source.slice(0, 23) + "..." : entry.source;
    console.log(
      "  " + pad(displayRoot, 24) +
      pad(displaySource, 28) +
      pad(formatNum(entry.cracks), 10, "right") +
      pad(pct(cumCracks, totalAttributed), 8, "right")
    );
  }

  // Cohort ROI
  const cohortStats = new Map<string, { roots: number; cracking: number; dead: number; totalCracks: number }>();
  for (const root of betaSet) {
    const source = rootSource.get(root) ?? "unknown";
    if (!cohortStats.has(source)) {
      cohortStats.set(source, { roots: 0, cracking: 0, dead: 0, totalCracks: 0 });
    }
    const stats = cohortStats.get(source)!;
    stats.roots++;
    const cracks = rootCracks.get(root) ?? 0;
    stats.totalCracks += cracks;
    if (cracks > 0) stats.cracking++;
    else stats.dead++;
  }

  console.log(`\n  COHORT ROI`);
  console.log(
    "  " + pad("Source", 28) + pad("Roots", 8, "right") + pad("Cracking", 10, "right") +
    pad("Dead", 8, "right") + pad("Avg Cr/Root", 12, "right")
  );
  console.log("  " + "─".repeat(66));

  const sortedCohorts = Array.from(cohortStats.entries())
    .sort(([, a], [, b]) => {
      const avgA = a.roots > 0 ? a.totalCracks / a.roots : 0;
      const avgB = b.roots > 0 ? b.totalCracks / b.roots : 0;
      return avgB - avgA;
    });

  for (const [source, stats] of sortedCohorts) {
    const avg = stats.roots > 0 ? (stats.totalCracks / stats.roots).toFixed(2) : "0.00";
    const displaySource = source.length > 26 ? source.slice(0, 23) + "..." : source;
    console.log(
      "  " + pad(displaySource, 28) +
      pad(formatNum(stats.roots), 8, "right") +
      pad(formatNum(stats.cracking), 10, "right") +
      pad(formatNum(stats.dead), 8, "right") +
      pad(avg, 12, "right")
    );
  }

  // Concentration analysis
  if (sortedRoots.length > 0) {
    const top1pctIdx = Math.max(1, Math.ceil(betaSet.size * 0.01));
    const top10pctIdx = Math.max(1, Math.ceil(betaSet.size * 0.10));
    const bottom50pctStart = Math.floor(betaSet.size * 0.50);

    let top1cracks = 0;
    let top10cracks = 0;
    for (let i = 0; i < sortedRoots.length; i++) {
      if (i < top1pctIdx) top1cracks += sortedRoots[i].cracks;
      if (i < top10pctIdx) top10cracks += sortedRoots[i].cracks;
    }

    // Bottom 50%: all roots sorted by cracks descending, take the bottom half
    // This includes all zero-crack roots + the lowest-cracking roots
    const allRootsSorted = Array.from(betaSet)
      .map(root => rootCracks.get(root) ?? 0)
      .sort((a, b) => b - a);
    let bottom50cracks = 0;
    for (let i = bottom50pctStart; i < allRootsSorted.length; i++) {
      bottom50cracks += allRootsSorted[i];
    }

    console.log(`\n  CONCENTRATION`);
    console.log(`  Top 1% of roots (${formatNum(top1pctIdx)}) produce ${pct(top1cracks, totalAttributed)} of attributions`);
    console.log(`  Top 10% of roots (${formatNum(top10pctIdx)}) produce ${pct(top10cracks, totalAttributed)} of attributions`);
    console.log(`  Bottom 50% of roots (${formatNum(betaSet.size - bottom50pctStart)}) produce ${pct(bottom50cracks, totalAttributed)} of attributions`);
  }
}

// =============================================================================
// Main
// =============================================================================

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  const runLength = args.includes("--length") || args.includes("--full");
  const runSuffixes = args.includes("--suffixes") || args.includes("--full");
  const runRoots = args.includes("--roots") || args.includes("--full");
  const runLong = args.includes("--long") || args.includes("--full");
  const runFeedback = args.includes("--feedback") || args.includes("--full");
  const runBeta = args.includes("--beta") || args.includes("--full");

  // Parse --batch N (used with --beta to filter to a single batch)
  let betaBatchNum: number | undefined;
  const batchIdx = args.indexOf("--batch");
  if (batchIdx !== -1 && batchIdx + 1 < args.length) {
    betaBatchNum = parseInt(args[batchIdx + 1], 10);
    if (isNaN(betaBatchNum)) {
      console.error("  ERROR: --batch requires a numeric batch number");
      process.exit(1);
    }
  }

  if (!runLength && !runSuffixes && !runRoots && !runLong && !runFeedback && !runBeta) {
    console.log("DeepAnalysis — Pipeline Feedback Loop & Long Password Analysis\n");
    console.log("Usage:");
    console.log("  bun Tools/DeepAnalysis.ts --length      Length distribution (pearls vs diamonds)");
    console.log("  bun Tools/DeepAnalysis.ts --suffixes    Diamond suffix pattern extraction");
    console.log("  bun Tools/DeepAnalysis.ts --roots       Root source attribution");
    console.log("  bun Tools/DeepAnalysis.ts --long        9+ char deep dive");
    console.log("  bun Tools/DeepAnalysis.ts --feedback    Feedback loop health metrics");
    console.log("  bun Tools/DeepAnalysis.ts --beta        Per-root crack attribution for BETA.txt");
    console.log("  bun Tools/DeepAnalysis.ts --full        All sections");
    process.exit(0);
  }

  console.log("══════════════════════════════════════════════════════════════");
  console.log("  DEEP ANALYSIS — Pipeline Feedback Loop & Long Passwords");
  console.log("  Data: " + DATA_DIR);
  console.log("══════════════════════════════════════════════════════════════");

  if (runLength) await analyzeLength();
  if (runSuffixes) await analyzeSuffixes();
  if (runRoots) await analyzeRoots();
  if (runLong) await analyzeLong();
  if (runFeedback) await analyzeFeedback();
  if (runBeta) await analyzeBetaRoots(betaBatchNum);

  console.log("\n══════════════════════════════════════════════════════════════");
  console.log("  ANALYSIS COMPLETE");
  console.log("══════════════════════════════════════════════════════════════");
}

main().catch((err) => {
  console.error("Fatal error:", err.message || err);
  process.exit(1);
});
