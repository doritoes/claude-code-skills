#!/usr/bin/env bun
/**
 * AttackReview.ts - Post-Batch Attack Evaluation Tool
 *
 * Analyzes per-attack results from sand-state.json and prints actionable
 * recommendations for tuning DEFAULT_ATTACK_ORDER.
 *
 * Usage:
 *   bun Tools/AttackReview.ts                      ROI table + recommendations (fast, state-only)
 *   bun Tools/AttackReview.ts --batch batch-0001   Single batch analysis
 *   bun Tools/AttackReview.ts --overlap            Add password coverage/overlap analysis (~30s)
 *   bun Tools/AttackReview.ts --json               JSON output
 *
 * READ-ONLY: Never modifies sand-state.json, DEFAULT_ATTACK_ORDER, or any files.
 *
 * @author PAI (Personal AI Infrastructure)
 * @updated 2026-02-25 — v7.2 tiers (added 10-char masks, 5/6-digit hybrids)
 * @license MIT
 */

import { existsSync, readFileSync } from "node:fs";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { SandStateManager, DEFAULT_ATTACK_ORDER, type AttackResultEntry, type BatchState } from "./SandStateManager";
import { DATA_DIR, DIAMONDS_DIR, FEEDBACK_DIR } from "./config";

// =============================================================================
// Constants
// =============================================================================

const TIER_MAP: Record<string, number> = {
  "brute-1": 0, "brute-2": 0, "brute-3": 0, "brute-4": 0,
  "mask-d9": 0, "mask-d10": 0, "mask-d11": 0, "mask-d12": 0,
  "brute-6": 1, "brute-7": 1,
  "mask-l8": 1.5, "mask-ld8": 1.5,
  "feedback-beta-nocaprule": 2, "nocapplus-unobtainium": 2,
  "hybrid-beta-5digit": 2, "hybrid-beta-6digit": 2,
  "mask-Ullllllldd": 3,
  "hybrid-nocapplus-4digit": 3, "brute-5": 3, "mask-Ullllllld": 3,
  "hybrid-beta-4any": 3.5, "hybrid-nocapplus-3any": 3.5, "mask-l9": 3.5,
  "hybrid-nocapplus-5digit": 3.5,
  "mask-Ullllllllld": -1,  // Removed v7.2: keyspace 1,411T (~36 hrs), not 54T as planned
  "mask-Ullllldd": 4, "hybrid-nocapplus-special-digits": 4,
  // Removed from production (kept for historical display)
  "mask-lllllldd": -1, "mask-lllldddd": -1,  // v7.3: subsumed by mask-l8/ld8
  "hybrid-roots-4any": -1, "nocapplus-nocaprule": -1, "hybrid-nocapplus-3digit": -1,
  "brute-8": 99,
  "mask-ld9": 98,
};

const TIER_NAMES: Record<number, string> = {
  [-1]: "Removed",
  0: "Tier 0: Instant",
  1: "Tier 1: High ROI",
  1.5: "Tier 1a: Cheap Masks (8/9-char funnel)",
  2: "Tier 2: Feedback",
  3: "Tier 3: Medium ROI",
  3.5: "Tier 3a: Long-Password Discovery",
  4: "Tier 4: Low ROI",
  98: "Experimental: One-off",
  99: "Special: Manual",
};

/** Regex patterns for mask/brute attacks (used in --overlap classification).
 *  Only includes attacks in DEFAULT_ATTACK_ORDER (production pipeline).
 *  brute-8 excluded — one-off experiment on batch-0001, not in production. */
const ATTACK_REGEX: Record<string, RegExp> = {
  "brute-3": /^.{3}$/,
  "brute-4": /^.{4}$/,
  "brute-5": /^.{5}$/,
  "brute-6": /^.{6}$/,
  "brute-7": /^.{7}$/,
  "mask-l8": /^[a-z]{8}$/,
  "mask-ld8": /^[a-z0-9]{8}$/,
  "mask-l9": /^[a-z]{9}$/,
  "mask-lllllldd": /^[a-z]{6}[0-9]{2}$/,
  "mask-Ullllllld": /^[A-Z][a-z]{7}[0-9]$/,
  "mask-Ullllldd": /^[A-Z][a-z]{5}[0-9]{2}$/,
  "mask-lllldddd": /^[a-z]{4}[0-9]{4}$/,
  "mask-Ullllllldd": /^[A-Z][a-z]{7}[0-9]{2}$/,
  "mask-d9": /^[0-9]{9}$/,
  "mask-d10": /^[0-9]{10}$/,
  "mask-d11": /^[0-9]{11}$/,
  "mask-d12": /^[0-9]{12}$/,
  // One-off experiments (not in DEFAULT_ATTACK_ORDER, but data exists for comparison)
  "mask-ld9": /^[a-z0-9]{9}$/,
};

/**
 * Reverse-engineer possible wordlist roots from a cracked password.
 * Given password P, generates candidate words W such that some hashcat rule
 * could transform W into P. Covers: identity, case changes, digit/special
 * append/prepend, leet reverse, year strip, duplicate, reverse.
 *
 * Used by the overlap classifier to estimate dict+rule attack coverage.
 * For nocap.rule (48K rules), virtually any matched root implies coverage.
 */
function reverseRuleRoots(password: string): Set<string> {
  const roots = new Set<string>();
  const lower = password.toLowerCase();
  const len = password.length;

  // Identity + case variants (: l u c rules)
  roots.add(lower);
  roots.add(password);

  // Strip trailing digits 1-4 ($0..$9, $0$1, etc.)
  for (let n = 1; n <= 4; n++) {
    if (len > n && /^\d+$/.test(password.slice(-n))) {
      roots.add(password.slice(0, -n).toLowerCase());
    }
  }

  // Strip leading digits 1-2 (^0..^9, ^1^2)
  for (let n = 1; n <= 2; n++) {
    if (len > n && /^\d+$/.test(password.slice(0, n))) {
      roots.add(password.slice(n).toLowerCase());
    }
  }

  // Strip trailing special char ($! $@ $# etc.)
  if (len > 1 && /[^a-zA-Z0-9]/.test(password[len - 1])) {
    roots.add(password.slice(0, -1).toLowerCase());
    // Special + digits combo ($!$1$2$3)
    for (let n = 1; n <= 3; n++) {
      if (len > n + 1 && /^[^a-zA-Z0-9]\d+$/.test(password.slice(-(n + 1)))) {
        roots.add(password.slice(0, -(n + 1)).toLowerCase());
      }
    }
  }

  // Strip leading special char (^! ^@ etc.)
  if (len > 1 && /[^a-zA-Z0-9]/.test(password[0])) {
    roots.add(password.slice(1).toLowerCase());
  }

  // Strip year suffix 1950-2029
  if (len > 4 && /^(19[5-9]\d|20[0-2]\d)$/.test(password.slice(-4))) {
    roots.add(password.slice(0, -4).toLowerCase());
  }

  // Reverse (r rule)
  roots.add([...lower].reverse().join(""));

  // Duplicate (d rule): first half == second half
  if (len >= 4 && len % 2 === 0) {
    const half = password.slice(0, len / 2);
    if (half.toLowerCase() === password.slice(len / 2).toLowerCase()) {
      roots.add(half.toLowerCase());
    }
  }

  // Leet reverse (sa@ se3 si1 so0 ss$ st7)
  const leetMap: [string, RegExp][] = [
    ["a", /[@4]/g], ["e", /[3]/g], ["i", /[1!]/g],
    ["o", /[0]/g], ["s", /[$5]/g], ["t", /[7+]/g],
  ];
  let unleeted = lower;
  for (const [char, regex] of leetMap) {
    unleeted = unleeted.replace(regex, char);
  }
  if (unleeted !== lower) {
    roots.add(unleeted);
    // Also strip trailing digits from unleeted form
    for (let n = 1; n <= 4; n++) {
      if (unleeted.length > n && /^\d+$/.test(unleeted.slice(-n))) {
        roots.add(unleeted.slice(0, -n));
      }
    }
  }

  roots.delete("");
  return roots;
}

/** Feedback attack names (for trend tracking) */
const FEEDBACK_ATTACK_NAMES = [
  "feedback-beta-nocaprule",
  "nocapplus-nocaprule",
  "nocapplus-unobtainium",
];

// =============================================================================
// Types
// =============================================================================

interface AttackROI {
  attack: string;
  tier: number;
  cracks: number;
  rate: number;           // cracks / hashCount
  durationSeconds: number;
  cracksPerMin: number | null;  // null for brute-8 (durationSeconds=0)
  costSharePct: number | null;  // fraction of batch time
  marginalROI: number | null;   // rate / costShare
  batches: number;        // how many batches included this attack
}

interface Recommendation {
  type: "DROP" | "REORDER" | "KEEP_ON_TRIAL" | "INVESTIGATE" | "BUDGET_ALERT" | "ADD";
  attack: string;
  reason: string;
}

interface FeedbackTrendRow {
  batch: string;
  feedbackCracks: number;
  betaSize: number;
}

interface OverlapEntry {
  password: string;
  coveredBy: string[];
}

interface JsonOutput {
  roiTable: AttackROI[];
  tierSummary: Record<string, { cracks: number; rate: number; durationSeconds: number }>;
  feedbackTrend: FeedbackTrendRow[];
  recommendations: Recommendation[];
  overlap?: {
    classification: Record<string, number>;
    exclusive: Record<string, number>;
    uncoveredCount: number;
    uncoveredSample: string[];
  };
}

// =============================================================================
// Helpers
// =============================================================================

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(0)}s`;
  if (seconds < 3600) return `${(seconds / 60).toFixed(1)}m`;
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  return `${hrs}h ${mins}m`;
}

function pad(s: string, width: number, align: "left" | "right" = "left"): string {
  if (align === "right") return s.padStart(width);
  return s.padEnd(width);
}

/**
 * Load passwords from a diamond passwords file, one per line.
 */
async function loadPasswords(filePath: string): Promise<string[]> {
  if (!existsSync(filePath)) return [];
  const passwords: string[] = [];
  const rl = createInterface({ input: createReadStream(filePath, "utf-8"), crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed) passwords.push(trimmed);
  }
  return passwords;
}

/**
 * Load a wordlist into a Set for fast lookup. Reads line-by-line to avoid OOM.
 */
async function loadWordlistSet(filePath: string): Promise<Set<string>> {
  if (!existsSync(filePath)) return new Set();
  const words = new Set<string>();
  const rl = createInterface({ input: createReadStream(filePath, "utf-8"), crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed) words.add(trimmed.toLowerCase());
  }
  return words;
}

// =============================================================================
// ROI Analysis (from state only)
// =============================================================================

function computeROI(batches: Record<string, BatchState>, filterBatch?: string): AttackROI[] {
  const attackAgg: Record<string, {
    cracks: number;
    totalHashes: number;
    durationSeconds: number;
    batchCount: number;
  }> = {};

  const batchEntries = filterBatch
    ? [[filterBatch, batches[filterBatch]] as const].filter(([, b]) => b)
    : Object.entries(batches).filter(([, b]) => b.status === "completed");

  for (const [, batch] of batchEntries) {
    if (!batch) continue;
    for (const result of batch.attackResults) {
      if (!attackAgg[result.attack]) {
        attackAgg[result.attack] = { cracks: 0, totalHashes: 0, durationSeconds: 0, batchCount: 0 };
      }
      const agg = attackAgg[result.attack];
      agg.cracks += result.newCracks;
      agg.totalHashes += batch.hashCount;
      agg.durationSeconds += result.durationSeconds;
      agg.batchCount++;
    }
  }

  // Total time across all attacks (excluding brute-8 with 0 duration)
  let totalTime = 0;
  for (const [attack, agg] of Object.entries(attackAgg)) {
    if (attack !== "brute-8" || agg.durationSeconds > 0) {
      totalTime += agg.durationSeconds;
    }
  }

  const results: AttackROI[] = [];
  for (const [attack, agg] of Object.entries(attackAgg)) {
    const rate = agg.totalHashes > 0 ? agg.cracks / agg.totalHashes : 0;
    const isBrute8NoTime = attack === "brute-8" && agg.durationSeconds === 0;

    let cracksPerMin: number | null = null;
    let costSharePct: number | null = null;
    let marginalROI: number | null = null;

    if (!isBrute8NoTime && agg.durationSeconds > 0) {
      cracksPerMin = agg.cracks / (agg.durationSeconds / 60);
      costSharePct = totalTime > 0 ? (agg.durationSeconds / totalTime) * 100 : 0;
      marginalROI = costSharePct > 0 ? (rate * 100) / costSharePct : 0;
    }

    results.push({
      attack,
      tier: TIER_MAP[attack] ?? -1,
      cracks: agg.cracks,
      rate,
      durationSeconds: agg.durationSeconds,
      cracksPerMin,
      costSharePct,
      marginalROI,
      batches: agg.batchCount,
    });
  }

  // Sort by cracks descending
  results.sort((a, b) => b.cracks - a.cracks);
  return results;
}

// =============================================================================
// Feedback Trend
// =============================================================================

function computeFeedbackTrend(batches: Record<string, BatchState>): FeedbackTrendRow[] {
  const rows: FeedbackTrendRow[] = [];

  // Sort batches by name for chronological order
  const sorted = Object.entries(batches)
    .filter(([, b]) => b.status === "completed")
    .sort(([a], [b]) => a.localeCompare(b));

  for (const [name, batch] of sorted) {
    // Sum feedback attack cracks from attackResults
    let feedbackCracks = 0;
    for (const result of batch.attackResults) {
      if (FEEDBACK_ATTACK_NAMES.includes(result.attack)) {
        feedbackCracks += result.newCracks;
      }
    }

    const betaSize = batch.feedback?.betaSize ?? 0;
    rows.push({ batch: name, feedbackCracks, betaSize });
  }

  return rows;
}

// =============================================================================
// Recommendations Engine
// =============================================================================

function generateRecommendations(roi: AttackROI[], trend: FeedbackTrendRow[]): Recommendation[] {
  const recs: Recommendation[] = [];

  // Index by attack name for quick lookup
  const roiByAttack = new Map(roi.map(r => [r.attack, r]));

  for (const entry of roi) {
    // Skip brute-8 from standard recommendations
    if (entry.attack === "brute-8") continue;

    // DROP: <0.01% rate after 3+ batches, <10 cracks total
    if (entry.batches >= 3 && entry.rate < 0.0001 && entry.cracks < 10) {
      recs.push({
        type: "DROP",
        attack: entry.attack,
        reason: `${entry.cracks} cracks across ${entry.batches} batches (${(entry.rate * 100).toFixed(4)}% rate) — below threshold`,
      });
      continue;
    }

    // KEEP ON TRIAL: <3 batches of data
    if (entry.batches < 3) {
      recs.push({
        type: "KEEP_ON_TRIAL",
        attack: entry.attack,
        reason: `Only ${entry.batches} batch(es) of data — need 3+ to evaluate`,
      });
      continue;
    }

    // BUDGET ALERT: >50% of time for <30% of cracks
    if (entry.costSharePct !== null && entry.costSharePct > 50) {
      const totalCracks = roi.reduce((sum, r) => sum + r.cracks, 0);
      const crackSharePct = totalCracks > 0 ? (entry.cracks / totalCracks) * 100 : 0;
      if (crackSharePct < 30) {
        recs.push({
          type: "BUDGET_ALERT",
          attack: entry.attack,
          reason: `Uses ${entry.costSharePct.toFixed(1)}% of batch time for ${crackSharePct.toFixed(1)}% of cracks`,
        });
      }
    }
  }

  // INVESTIGATE: Feedback attacks not improving after 5+ batches
  if (trend.length >= 5) {
    const last5 = trend.slice(-5);
    const firstCracks = last5[0].feedbackCracks;
    const lastCracks = last5[last5.length - 1].feedbackCracks;
    if (lastCracks <= firstCracks && firstCracks > 0) {
      recs.push({
        type: "INVESTIGATE",
        attack: "feedback-attacks",
        reason: `Feedback cracks not improving over last 5 batches (${firstCracks} → ${lastCracks}). Review BETA.txt quality and cohort diversity.`,
      });
    }
  }

  // REORDER: Check if a lower-position attack has higher cracks/min than the one above it
  // Build list in DEFAULT_ATTACK_ORDER sequence
  const orderIndex = new Map(DEFAULT_ATTACK_ORDER.map((a, i) => [a, i]));
  const ordered = roi
    .filter(r => orderIndex.has(r.attack) && r.cracksPerMin !== null)
    .sort((a, b) => (orderIndex.get(a.attack) ?? 99) - (orderIndex.get(b.attack) ?? 99));

  for (let i = 1; i < ordered.length; i++) {
    const above = ordered[i - 1];
    const below = ordered[i];
    // Only suggest reorder within same tier or adjacent tiers
    if (below.cracksPerMin !== null && above.cracksPerMin !== null
        && below.cracksPerMin > above.cracksPerMin * 1.5
        && below.tier <= above.tier) {
      recs.push({
        type: "REORDER",
        attack: below.attack,
        reason: `${below.attack} (${below.cracksPerMin.toFixed(1)}/min) has higher throughput than ${above.attack} (${above.cracksPerMin.toFixed(1)}/min) above it`,
      });
    }
  }

  return recs;
}

// =============================================================================
// Overlap Analysis (--overlap mode)
// =============================================================================

/**
 * Classify which attacks COULD have found each password.
 * Uses pre-computed lookup sets (inverted from wordlists) to avoid OOM.
 */
function classifyPassword(
  password: string,
  nocapPlusMatches: Set<string>,
  betaSet: Set<string>,
): string[] {
  const coveredBy: string[] = [];

  // Check mask/brute attacks via regex
  for (const [attack, regex] of Object.entries(ATTACK_REGEX)) {
    if (regex.test(password)) {
      coveredBy.push(attack);
    }
  }

  // Hybrid attacks: strip suffix, check if base word was found in nocap-plus
  // hybrid-nocapplus-4digit: word + 4 digits
  const match4d = password.match(/^(.+?)(\d{4})$/);
  if (match4d && nocapPlusMatches.has(match4d[1].toLowerCase())) {
    coveredBy.push("hybrid-nocapplus-4digit");
  }

  // hybrid-nocapplus-5digit: word + 5 digits
  const match5d = password.match(/^(.+?)(\d{5})$/);
  if (match5d && nocapPlusMatches.has(match5d[1].toLowerCase())) {
    coveredBy.push("hybrid-nocapplus-5digit");
  }

  // hybrid-nocapplus-special-digits: word + special + 3 digits
  const matchSpecDig = password.match(/^(.+?)([^a-zA-Z0-9])(\d{3})$/);
  if (matchSpecDig && nocapPlusMatches.has(matchSpecDig[1].toLowerCase())) {
    coveredBy.push("hybrid-nocapplus-special-digits");
  }

  // hybrid-nocapplus-3any: word + any 3 chars
  if (password.length >= 4) {
    const base3 = password.slice(0, -3).toLowerCase();
    if (nocapPlusMatches.has(base3)) {
      coveredBy.push("hybrid-nocapplus-3any");
    }
  }

  // hybrid-beta-4any: BETA word + any 4 chars
  if (password.length >= 5) {
    const base4 = password.slice(0, -4).toLowerCase();
    if (betaSet.has(base4)) {
      coveredBy.push("hybrid-beta-4any");
    }
  }

  // hybrid-beta-5digit: BETA word + 5 digits
  if (match5d && betaSet.has(match5d[1].toLowerCase())) {
    coveredBy.push("hybrid-beta-5digit");
  }

  // hybrid-beta-6digit: BETA word + 6 digits
  const match6d = password.match(/^(.+?)(\d{6})$/);
  if (match6d && betaSet.has(match6d[1].toLowerCase())) {
    coveredBy.push("hybrid-beta-6digit");
  }

  // Dict+rules attacks: reverse-engineer possible roots from password,
  // then check if any root was found in the wordlists.
  const roots = reverseRuleRoots(password);
  let inBeta = false;
  let inNocapPlus = false;
  for (const root of roots) {
    if (!inBeta && betaSet.has(root)) inBeta = true;
    if (!inNocapPlus && nocapPlusMatches.has(root)) inNocapPlus = true;
    if (inBeta && inNocapPlus) break;
  }

  if (inBeta) coveredBy.push("feedback-beta-nocaprule");
  if (inNocapPlus) {
    coveredBy.push("nocapplus-unobtainium");
  }

  return coveredBy;
}

/**
 * Detect structural patterns not covered by current attacks.
 */
function detectUncoveredPatterns(passwords: string[]): { pattern: string; count: number; sample: string }[] {
  const patterns: Record<string, { count: number; sample: string }> = {};

  function addPattern(key: string, pw: string) {
    if (!patterns[key]) patterns[key] = { count: 0, sample: pw };
    patterns[key].count++;
  }

  for (const pw of passwords) {
    // 9+ char all lowercase (not covered by brute-7 or mask-lllllldd)
    if (/^[a-z]{9,}$/.test(pw)) addPattern("lower-9plus", pw);
    // Capital + lowercase + 3+ digits (Ulll...ddd)
    if (/^[A-Z][a-z]+\d{3,}$/.test(pw) && pw.length >= 9) addPattern("Ulower-3plusdigits", pw);
    // All digits 9+ (not covered by brute-7 or mask-lllldddd)
    if (/^\d{9,}$/.test(pw)) addPattern("digits-9plus", pw);
    // Mixed case without digits (not covered by masks)
    if (/^[a-zA-Z]{9,}$/.test(pw) && /[a-z]/.test(pw) && /[A-Z]/.test(pw)) addPattern("mixedcase-9plus", pw);
    // Word + special + word pattern
    if (/^[a-zA-Z]+[^a-zA-Z0-9][a-zA-Z]+$/.test(pw)) addPattern("word-special-word", pw);
    // Leet speak (contains both letters and digit substitutions)
    if (/[a-zA-Z]/.test(pw) && /[0@1!3$5%7&]/.test(pw) && pw.length >= 8) addPattern("leet-8plus", pw);
  }

  return Object.entries(patterns)
    .map(([pattern, data]) => ({ pattern, ...data }))
    .filter(p => p.count >= 10) // Only report patterns with meaningful counts
    .sort((a, b) => b.count - a.count);
}

async function runOverlapAnalysis(
  batches: Record<string, BatchState>,
  filterBatch?: string,
): Promise<{
  classification: Record<string, number>;
  exclusive: Record<string, number>;
  uncoveredCount: number;
  uncoveredSample: string[];
  uncoveredPatterns: { pattern: string; count: number; sample: string }[];
  allPasswords: string[];
}> {
  // ── Inverted lookup pattern (same as DiamondFeedback OOM fix) ──
  // Instead of loading 14M-word nocap-plus.txt into a Set (~1.5GB OOM),
  // we build a candidate Set from passwords (~500MB), then STREAM
  // nocap-plus.txt against it. O(candidates) memory, not O(wordlist).

  console.log("\nLoading passwords for overlap analysis...");

  // Load passwords from relevant batches
  const batchNames = filterBatch
    ? [filterBatch]
    : Object.entries(batches)
        .filter(([, b]) => b.status === "completed")
        .map(([name]) => name)
        .sort();

  let allPasswords: string[] = [];
  for (const name of batchNames) {
    const pwPath = resolve(DIAMONDS_DIR, `passwords-${name}.txt`);
    const pws = await loadPasswords(pwPath);
    allPasswords = allPasswords.concat(pws);
  }

  if (allPasswords.length === 0) {
    console.log("  No password files found for analysis.");
    return { classification: {}, exclusive: {}, uncoveredCount: 0, uncoveredSample: [], uncoveredPatterns: [], allPasswords: [] };
  }

  console.log(`  Passwords to classify: ${allPasswords.length.toLocaleString()}`);

  // Step 1: Generate ALL candidate lookup words from passwords
  console.log("  Building candidate roots...");
  const allCandidates = new Set<string>();
  for (const pw of allPasswords) {
    // Dict+rules reverse roots
    const roots = reverseRuleRoots(pw);
    for (const r of roots) allCandidates.add(r);
    // Hybrid base words (strip digit/any suffixes)
    const m4d = pw.match(/^(.+?)(\d{4})$/);
    if (m4d) allCandidates.add(m4d[1].toLowerCase());
    const m5d = pw.match(/^(.+?)(\d{5})$/);
    if (m5d) allCandidates.add(m5d[1].toLowerCase());
    const m6d = pw.match(/^(.+?)(\d{6})$/);
    if (m6d) allCandidates.add(m6d[1].toLowerCase());
    const msd = pw.match(/^(.+?)([^a-zA-Z0-9])(\d{3})$/);
    if (msd) allCandidates.add(msd[1].toLowerCase());
    // hybrid-3any base
    if (pw.length >= 4) allCandidates.add(pw.slice(0, -3).toLowerCase());
  }
  console.log(`  Candidates: ${allCandidates.size.toLocaleString()} unique words`);

  // Step 2: Load BETA.txt into Set (small — 78K, no OOM risk)
  const betaPath = resolve(FEEDBACK_DIR, "BETA.txt");
  const betaSet = await loadWordlistSet(betaPath);
  console.log(`  BETA.txt: ${betaSet.size.toLocaleString()} words`);

  // Step 3: Stream nocap-plus.txt — find which candidates exist in wordlist
  console.log("  Streaming nocap-plus.txt against candidates...");
  const nocapPlusPath = resolve(DATA_DIR, "nocap-plus.txt");
  const nocapPlusMatches = new Set<string>();
  let nocapPlusTotal = 0;
  const rl = createInterface({ input: createReadStream(nocapPlusPath, "utf-8"), crlfDelay: Infinity });
  for await (const line of rl) {
    const word = line.trim().toLowerCase();
    if (word) {
      nocapPlusTotal++;
      if (allCandidates.has(word)) nocapPlusMatches.add(word);
    }
  }
  console.log(`  nocap-plus.txt: ${nocapPlusTotal.toLocaleString()} words streamed, ${nocapPlusMatches.size.toLocaleString()} candidates matched`);

  // Free candidate set — no longer needed
  allCandidates.clear();

  // Step 4: Classify each password using betaSet + nocapPlusMatches + regex
  console.log("  Classifying...");
  const classification: Record<string, number> = {};
  const exclusive: Record<string, number> = {};
  const uncovered: string[] = [];

  for (const pw of allPasswords) {
    const coveredBy = classifyPassword(pw, nocapPlusMatches, betaSet);

    for (const attack of coveredBy) {
      classification[attack] = (classification[attack] ?? 0) + 1;
    }

    if (coveredBy.length === 1) {
      exclusive[coveredBy[0]] = (exclusive[coveredBy[0]] ?? 0) + 1;
    } else if (coveredBy.length === 0) {
      uncovered.push(pw);
    }
  }

  const uncoveredPatterns = detectUncoveredPatterns(uncovered);

  return {
    classification,
    exclusive,
    uncoveredCount: uncovered.length,
    uncoveredSample: uncovered.slice(0, 20),
    uncoveredPatterns,
    allPasswords,
  };
}

// =============================================================================
// Display
// =============================================================================

function printROITable(roi: AttackROI[]): void {
  console.log("\n── ATTACK ROI TABLE ──────────────────────────────────────────────────────────────────────────");
  console.log("   Note: Earlier attacks steal credit from later ones. Use --overlap to quantify.\n");

  // Header
  console.log(
    pad("Attack", 32) +
    pad("Cracks", 10, "right") +
    pad("Rate", 10, "right") +
    pad("Time", 10, "right") +
    pad("Cracks/m", 10, "right") +
    pad("Cost%", 8, "right") +
    pad("mROI", 8, "right") +
    pad("Runs", 6, "right")
  );
  console.log("─".repeat(94));

  for (const entry of roi) {
    const isBrute8NA = entry.attack === "brute-8" && entry.durationSeconds === 0;

    console.log(
      pad(entry.attack, 32) +
      pad(entry.cracks.toLocaleString(), 10, "right") +
      pad((entry.rate * 100).toFixed(2) + "%", 10, "right") +
      pad(isBrute8NA ? "n/a" : formatDuration(entry.durationSeconds), 10, "right") +
      pad(entry.cracksPerMin !== null ? entry.cracksPerMin.toFixed(1) : "n/a", 10, "right") +
      pad(entry.costSharePct !== null ? entry.costSharePct.toFixed(1) + "%" : "n/a", 8, "right") +
      pad(entry.marginalROI !== null ? entry.marginalROI.toFixed(2) : "n/a", 8, "right") +
      pad(entry.batches.toString(), 6, "right")
    );
  }

  // Tier summary
  const tierAgg: Record<number, { cracks: number; durationSeconds: number; totalHashes: number }> = {};
  for (const entry of roi) {
    const tier = entry.tier;
    if (!tierAgg[tier]) tierAgg[tier] = { cracks: 0, durationSeconds: 0, totalHashes: 0 };
    tierAgg[tier].cracks += entry.cracks;
    if (entry.attack !== "brute-8" || entry.durationSeconds > 0) {
      tierAgg[tier].durationSeconds += entry.durationSeconds;
    }
  }

  const totalCracks = roi.reduce((sum, r) => sum + r.cracks, 0);

  const tierCol = 40;
  const lineWidth = tierCol + 12 + 10 + 12;

  console.log("\n" + "─".repeat(lineWidth));
  console.log(pad("Tier", tierCol) + pad("Cracks", 12, "right") + pad("Share", 10, "right") + pad("Time", 12, "right"));
  console.log("─".repeat(lineWidth));

  for (const tier of Object.keys(tierAgg).map(Number).sort((a, b) => a - b)) {
    const agg = tierAgg[tier];
    const share = totalCracks > 0 ? (agg.cracks / totalCracks) * 100 : 0;
    const tierName = TIER_NAMES[tier] ?? `Tier ${tier}`;

    console.log(
      pad(tierName, tierCol) +
      pad(agg.cracks.toLocaleString(), 12, "right") +
      pad(share.toFixed(1) + "%", 10, "right") +
      pad(agg.durationSeconds > 0 ? formatDuration(agg.durationSeconds) : "n/a", 12, "right")
    );
  }

  console.log("─".repeat(lineWidth));
  const totalTime = roi.reduce((sum, r) => {
    if (r.attack === "brute-8" && r.durationSeconds === 0) return sum;
    return sum + r.durationSeconds;
  }, 0);
  console.log(
    pad("TOTAL", tierCol) +
    pad(totalCracks.toLocaleString(), 12, "right") +
    pad("100.0%", 10, "right") +
    pad(formatDuration(totalTime), 12, "right")
  );
}

function printFeedbackTrend(trend: FeedbackTrendRow[]): void {
  console.log("\n── FEEDBACK TREND ────────────────────────────────────────────\n");

  if (trend.length === 0) {
    console.log("  No completed batches with feedback data.\n");
    return;
  }

  console.log(pad("Batch", 20) + pad("Feedback Cracks", 18, "right") + pad("BETA.txt Size", 16, "right"));
  console.log("─".repeat(54));

  for (const row of trend) {
    console.log(
      pad(row.batch, 20) +
      pad(row.feedbackCracks.toLocaleString(), 18, "right") +
      pad(row.betaSize > 0 ? row.betaSize.toLocaleString() : "—", 16, "right")
    );
  }

  if (trend.length < 3) {
    console.log("\n  Insufficient data for trend analysis (need 3+ batches).");
  } else {
    // Simple linear trend on feedback cracks
    const values = trend.map(r => r.feedbackCracks);
    const first = values[0];
    const last = values[values.length - 1];
    const delta = last - first;
    const direction = delta > 0 ? "IMPROVING" : delta < 0 ? "DECLINING" : "STABLE";
    console.log(`\n  Trend: ${direction} (${first} → ${last}, delta: ${delta > 0 ? "+" : ""}${delta})`);
  }
}

function printRecommendations(recs: Recommendation[]): void {
  console.log("\n── RECOMMENDATIONS ──────────────────────────────────────────\n");

  if (recs.length === 0) {
    console.log("  No actionable recommendations at this time.\n");
    return;
  }

  const typeEmoji: Record<string, string> = {
    DROP: "[DROP]",
    REORDER: "[REORDER]",
    KEEP_ON_TRIAL: "[TRIAL]",
    INVESTIGATE: "[INVESTIGATE]",
    BUDGET_ALERT: "[BUDGET]",
    ADD: "[ADD]",
  };

  for (const rec of recs) {
    console.log(`  ${typeEmoji[rec.type] ?? rec.type} ${rec.attack}`);
    console.log(`    ${rec.reason}`);
    console.log();
  }
}

function printOverlap(overlap: Awaited<ReturnType<typeof runOverlapAnalysis>>, totalPasswords: number): void {
  console.log("\n── OVERLAP ANALYSIS ─────────────────────────────────────────\n");

  // Coverage by attack
  console.log(pad("Attack", 32) + pad("Could Cover", 14, "right") + pad("Exclusive", 12, "right"));
  console.log("─".repeat(58));

  const sortedClassification = Object.entries(overlap.classification)
    .sort(([, a], [, b]) => b - a);

  for (const [attack, count] of sortedClassification) {
    const excl = overlap.exclusive[attack] ?? 0;
    console.log(
      pad(attack, 32) +
      pad(count.toLocaleString(), 14, "right") +
      pad(excl.toLocaleString(), 12, "right")
    );
  }

  console.log("─".repeat(58));
  console.log(
    pad("Uncovered", 32) +
    pad(overlap.uncoveredCount.toLocaleString(), 14, "right") +
    pad(`${totalPasswords > 0 ? ((overlap.uncoveredCount / totalPasswords) * 100).toFixed(1) : 0}%`, 12, "right")
  );

  // Uncovered patterns
  if (overlap.uncoveredPatterns.length > 0) {
    console.log("\n  Uncovered password patterns:");
    for (const p of overlap.uncoveredPatterns.slice(0, 10)) {
      console.log(`    ${pad(p.pattern, 25)} ${pad(p.count.toLocaleString(), 8, "right")}  (e.g. "${p.sample}")`);
    }
  }

  // Sample uncovered passwords
  if (overlap.uncoveredSample.length > 0) {
    console.log("\n  Sample uncovered passwords:");
    for (const pw of overlap.uncoveredSample.slice(0, 10)) {
      // Truncate long passwords for display
      const display = pw.length > 30 ? pw.slice(0, 27) + "..." : pw;
      console.log(`    ${display}`);
    }
  }
}

function printLengthDistribution(passwords: string[]): void {
  console.log("\n── PASSWORD LENGTH DISTRIBUTION ──────────────────────────────\n");

  const lengthBuckets: Record<number, number> = {};
  for (const pw of passwords) {
    const len = pw.length;
    lengthBuckets[len] = (lengthBuckets[len] ?? 0) + 1;
  }

  const maxLen = Math.max(...Object.keys(lengthBuckets).map(Number));
  const minLen = Math.min(...Object.keys(lengthBuckets).map(Number));
  const total = passwords.length;
  const maxCount = Math.max(...Object.values(lengthBuckets));
  const barMax = 40;

  console.log(pad("Len", 5) + pad("Count", 10, "right") + pad("Share", 8, "right") + pad("Cumul", 8, "right") + "  Bar");
  console.log("─".repeat(75));

  let cumulative = 0;
  for (let len = minLen; len <= Math.min(maxLen, 30); len++) {
    const count = lengthBuckets[len] ?? 0;
    if (count === 0) continue; // Skip empty rows
    cumulative += count;
    const share = total > 0 ? (count / total) * 100 : 0;
    const cumulShare = total > 0 ? (cumulative / total) * 100 : 0;
    const barLen = maxCount > 0 ? Math.round((count / maxCount) * barMax) : 0;
    const bar = "#".repeat(barLen);

    console.log(
      pad(String(len), 5) +
      pad(count.toLocaleString(), 10, "right") +
      pad(share.toFixed(1) + "%", 8, "right") +
      pad(cumulShare.toFixed(1) + "%", 8, "right") +
      "  " + bar
    );
  }

  // Aggregate 31+ if any
  let longCount = 0;
  for (let len = 31; len <= maxLen; len++) {
    longCount += lengthBuckets[len] ?? 0;
  }
  if (longCount > 0) {
    cumulative += longCount;
    const share = total > 0 ? (longCount / total) * 100 : 0;
    console.log(
      pad("31+", 5) +
      pad(longCount.toLocaleString(), 10, "right") +
      pad(share.toFixed(1) + "%", 8, "right") +
      pad("100.0%", 8, "right") +
      "  " + "#".repeat(Math.round((longCount / maxCount) * barMax))
    );
  }

  console.log("─".repeat(75));
  console.log(pad("Total", 5) + pad(total.toLocaleString(), 10, "right"));
}

// =============================================================================
// Main
// =============================================================================

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  const jsonMode = args.includes("--json");
  const overlapMode = args.includes("--overlap");
  let filterBatch: string | undefined;

  const batchIdx = args.indexOf("--batch");
  if (batchIdx !== -1 && args[batchIdx + 1]) {
    filterBatch = args[batchIdx + 1];
  }

  // Load state
  const mgr = new SandStateManager();
  const state = mgr.load();

  const completedBatches = Object.entries(state.batches)
    .filter(([, b]) => b.status === "completed");

  if (completedBatches.length === 0) {
    console.log("No completed batches in sand-state.json. Run some batches first.");
    process.exit(1);
  }

  if (filterBatch && !state.batches[filterBatch]) {
    console.error(`Batch "${filterBatch}" not found in sand-state.json.`);
    console.error(`Available: ${Object.keys(state.batches).join(", ")}`);
    process.exit(1);
  }

  // Compute ROI
  const roi = computeROI(state.batches, filterBatch);
  const trend = computeFeedbackTrend(state.batches);
  const recs = generateRecommendations(roi, trend);

  // Overlap analysis (optional)
  let overlap: Awaited<ReturnType<typeof runOverlapAnalysis>> | undefined;
  if (overlapMode) {
    overlap = await runOverlapAnalysis(state.batches, filterBatch);
  }

  // JSON output mode
  if (jsonMode) {
    const tierSummary: Record<string, { cracks: number; rate: number; durationSeconds: number }> = {};
    for (const entry of roi) {
      const tierName = TIER_NAMES[entry.tier] ?? `Tier ${entry.tier}`;
      if (!tierSummary[tierName]) tierSummary[tierName] = { cracks: 0, rate: 0, durationSeconds: 0 };
      tierSummary[tierName].cracks += entry.cracks;
      if (entry.attack !== "brute-8" || entry.durationSeconds > 0) {
        tierSummary[tierName].durationSeconds += entry.durationSeconds;
      }
    }
    // Compute rate for each tier
    const totalHashes = completedBatches.reduce((sum, [, b]) => sum + b.hashCount, 0);
    for (const tier of Object.values(tierSummary)) {
      tier.rate = totalHashes > 0 ? tier.cracks / totalHashes : 0;
    }

    const output: JsonOutput = {
      roiTable: roi,
      tierSummary,
      feedbackTrend: trend,
      recommendations: recs,
    };

    if (overlap) {
      output.overlap = {
        classification: overlap.classification,
        exclusive: overlap.exclusive,
        uncoveredCount: overlap.uncoveredCount,
        uncoveredSample: overlap.uncoveredSample,
      };
    }

    console.log(JSON.stringify(output, null, 2));
    return;
  }

  // Human-readable output
  const scope = filterBatch
    ? `Batch: ${filterBatch}`
    : `All completed batches (${completedBatches.length})`;

  console.log("══════════════════════════════════════════════════════════════");
  console.log("  ATTACK REVIEW — Post-Batch Evaluation");
  console.log(`  Scope: ${scope}`);
  console.log("══════════════════════════════════════════════════════════════");

  printROITable(roi);
  printFeedbackTrend(trend);
  printRecommendations(recs);

  if (overlap) {
    const totalPasswords = roi.reduce((sum, r) => sum + r.cracks, 0);
    printOverlap(overlap, totalPasswords);
    printLengthDistribution(overlap.allPasswords);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err.message || err);
  process.exit(1);
});
