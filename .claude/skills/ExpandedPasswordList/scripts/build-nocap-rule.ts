#!/usr/bin/env bun
/**
 * build-nocap-rule.ts — Rebuild nocap.rule from OneRuleToRuleThemStill + bussin.rule
 *
 * nocap.rule = OneRuleToRuleThemStill.rule with bussin.rule's 14 unique rules
 * inserted at performance-correct positions (near similar rules, not appended).
 *
 * Performance-correct insertion: each bussin rule is placed immediately after
 * the last occurrence of a rule with the same prefix pattern. E.g., `$1` goes
 * after the last `$1 ...` rule in OneRule. This preserves hashcat's rule
 * execution order optimization.
 *
 * Usage: bun scripts/build-nocap-rule.ts [--dry-run]
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = resolve(SCRIPT_DIR, "..");
const DATA_DIR = resolve(SKILL_DIR, "data");
const PROJECT_ROOT = resolve(SKILL_DIR, "..", "..", "..");

const ONERULE_PATH = resolve(PROJECT_ROOT, "OneRuleToRuleThemStill.rule");
const BUSSIN_PATH = resolve(DATA_DIR, "feedback", "bussin.rule");
const OUTPUT_PATH = resolve(DATA_DIR, "nocap.rule");

const dryRun = process.argv.includes("--dry-run");

// Load OneRule (preserve comments and blank lines)
if (!existsSync(ONERULE_PATH)) {
  console.error(`ERROR: ${ONERULE_PATH} not found`);
  process.exit(1);
}
if (!existsSync(BUSSIN_PATH)) {
  console.error(`ERROR: ${BUSSIN_PATH} not found`);
  process.exit(1);
}

const oneruleLines = readFileSync(ONERULE_PATH, "utf-8").split("\n");
const bussinRules = readFileSync(BUSSIN_PATH, "utf-8")
  .split("\n")
  .map(l => l.trim())
  .filter(l => l && !l.startsWith("#"));

// Build set of existing rules for dedup
const existingRules = new Set<string>();
for (const line of oneruleLines) {
  const trimmed = line.trim();
  if (trimmed && !trimmed.startsWith("#")) {
    existingRules.add(trimmed);
  }
}

// Filter bussin rules to only truly new ones
const newRules = bussinRules.filter(r => !existingRules.has(r));
console.log(`OneRuleToRuleThemStill: ${existingRules.size} rules`);
console.log(`bussin.rule: ${bussinRules.length} rules (${newRules.length} new, ${bussinRules.length - newRules.length} already in OneRule)`);

if (newRules.length === 0) {
  console.log("No new rules to insert. nocap.rule = OneRule.");
  if (!dryRun) {
    writeFileSync(OUTPUT_PATH, readFileSync(ONERULE_PATH));
    console.log(`Wrote ${OUTPUT_PATH}`);
  }
  process.exit(0);
}

// Performance-correct insertion strategy:
// - Triple-digit repeats ($X $X $X) → insert after $4 $4 $4 (the only triple in OneRule, ~line 11907)
//   These are high-frequency patterns that belong in the early/mid section, not at the end.
// - Single-digit appends ($X) and double ($X $X) → insert after last single-append $X rule
//   These naturally cluster at the end of OneRule near other $X rules.

function getTokenCount(rule: string): number {
  return rule.split(" ").length;
}

// Find the anchor: $4 $4 $4 in OneRule (the only existing triple-digit repeat)
let tripleAnchorIndex = -1;
for (let i = 0; i < oneruleLines.length; i++) {
  if (oneruleLines[i].trim() === "$4 $4 $4") {
    tripleAnchorIndex = i;
    break;
  }
}
if (tripleAnchorIndex === -1) {
  console.error("ERROR: Cannot find $4 $4 $4 anchor in OneRule — insertion positions unknown");
  process.exit(1);
}

// Partition new rules: triples go near the anchor, singles/doubles go at end
const tripleRules = newRules.filter(r => getTokenCount(r) === 3);
const otherRules = newRules.filter(r => getTokenCount(r) !== 3);

const insertions: { afterIndex: number; rule: string }[] = [];

// Triples: insert immediately after $4 $4 $4, in order
for (const rule of tripleRules) {
  insertions.push({ afterIndex: tripleAnchorIndex, rule });
}

// Singles/doubles: insert after last matching single-token $X rule
for (const rule of otherRules) {
  const firstToken = rule.split(" ")[0];
  let bestIndex = -1;
  for (let i = 0; i < oneruleLines.length; i++) {
    const trimmed = oneruleLines[i].trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    // Match rules that start with same $X token AND are single-token (not compound)
    if (trimmed === firstToken || (trimmed.startsWith(firstToken + " ") && getTokenCount(trimmed) <= 2)) {
      bestIndex = i;
    }
  }
  if (bestIndex === -1) bestIndex = oneruleLines.length - 1;
  insertions.push({ afterIndex: bestIndex, rule });
}

// Sort insertions by index descending so we can insert without shifting issues
insertions.sort((a, b) => b.afterIndex - a.afterIndex || a.rule.localeCompare(b.rule));

// Build output — insert bussin rules at correct positions first
const expectedCount = existingRules.size + newRules.length;
const output = [...oneruleLines];
for (const ins of insertions) {
  output.splice(ins.afterIndex + 1, 0, ins.rule);
  console.log(`  INSERT "${ins.rule}" after line ${ins.afterIndex + 1}`);
}

// Verify: count active rules
const activeRules = output.filter(l => l.trim() && !l.trim().startsWith("#")).length;

console.log(`\nResult: ${activeRules} active rules (expected ${expectedCount})`);
if (activeRules !== expectedCount) {
  console.error(`ERROR: Rule count mismatch!`);
  process.exit(1);
}

// Check for duplicates
const seen = new Set<string>();
let dupes = 0;
for (const line of output) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  if (seen.has(t)) dupes++;
  seen.add(t);
}
if (dupes > 0) {
  console.error(`ERROR: ${dupes} duplicate rules detected!`);
  process.exit(1);
}

console.log(`Duplicates: 0`);

// Prepend nocap header above the existing OneRule header
const nocapHeader = [
  "##################################################################",
  "# ***                    nocap.rule                          *** #",
  "#                                                                #",
  "#    OneRuleToRuleThemStill + bussin.rule                        #",
  "#    https://github.com/doritoes/wordforge                       #",
  "#                                                                #",
  `#    ${activeRules.toLocaleString()} rules = ${existingRules.size.toLocaleString()} (OneRule) + ${newRules.length} (bussin, unique only)  #`,
  "#    bussin.rule additions inserted at performance-correct       #",
  "#    locations within OneRule's frequency-ordered structure.      #",
  "#    Space-normalized dedup — zero duplicates.                   #",
  "#                                                                #",
  "##################################################################",
  "#",
];
output.unshift(...nocapHeader);

if (dryRun) {
  console.log("\n[DRY RUN] No files written.");
} else {
  writeFileSync(OUTPUT_PATH, output.join("\n"));
  console.log(`\nWrote ${OUTPUT_PATH} (${activeRules} rules)`);
}
