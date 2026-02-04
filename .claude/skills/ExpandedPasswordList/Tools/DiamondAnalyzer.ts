#!/usr/bin/env bun
/**
 * DiamondAnalyzer.ts - Analyze Cracked Passwords to Extract Patterns
 *
 * Examines DIAMONDS (cracked passwords) to:
 * 1. Extract new root words not in rockyou → BETA.txt
 * 2. Identify transformation patterns → UNOBTAINIUM.rule
 * 3. Deduplicate results
 * 4. Track effectiveness metrics
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

import { createReadStream, existsSync, readFileSync, writeFileSync, createWriteStream } from "node:fs";
import { createInterface } from "node:readline";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const CURRENT_FILE = fileURLToPath(import.meta.url);
const SKILL_DIR = dirname(dirname(CURRENT_FILE));
const DATA_DIR = resolve(SKILL_DIR, "data");
const OUTPUT_DIR = resolve(DATA_DIR, "processed");

// =============================================================================
// Configuration
// =============================================================================

const MIN_ROOT_LENGTH = 4; // Minimum length for a root word
const MIN_ROOT_FREQUENCY = 3; // Minimum occurrences to be considered

// Use nocap.txt (rockyou + rizzyou combined) as baseline - BETA should be words NOT in this
const NOCAP_PATH = resolve(DATA_DIR, "nocap.txt");
const ROCKYOU_PATH = resolve(DATA_DIR, "rockyou.txt"); // Fallback if nocap doesn't exist

// Common password patterns to detect
const PATTERNS = {
  // Suffix patterns
  digitSuffix: /^(.+?)(\d+)$/,
  specialSuffix: /^(.+?)([!@#$%^&*()]+)$/,
  yearSuffix: /^(.+?)(19\d{2}|20\d{2})$/,
  digitSpecialSuffix: /^(.+?)(\d+)([!@#$%^&*()]+)$/,

  // Prefix patterns
  digitPrefix: /^(\d+)(.+)$/,

  // Case patterns
  capitalize: /^[A-Z][a-z]+/,
  allCaps: /^[A-Z]+$/,
  leetspeak: /[4@][a-zA-Z]*|[3e][a-zA-Z]*|[1!i][a-zA-Z]*|[0o][a-zA-Z]*/i,
};

// =============================================================================
// Analysis Functions
// =============================================================================

interface AnalysisResult {
  totalPasswords: number;
  uniquePasswords: number;
  rootWords: Map<string, number>; // root -> count
  patterns: Map<string, number>; // pattern -> count
  suffixes: Map<string, number>; // suffix -> count
  prefixes: Map<string, number>; // prefix -> count
  lengthDistribution: Map<number, number>;
}

/**
 * Extract potential root word from password
 */
function extractRoot(password: string): string | null {
  // Remove common suffixes
  let root = password
    .replace(/\d+$/, "") // trailing digits
    .replace(/[!@#$%^&*()]+$/, "") // trailing specials
    .replace(/^\d+/, "") // leading digits
    .toLowerCase();

  // Must be at least MIN_ROOT_LENGTH chars
  if (root.length < MIN_ROOT_LENGTH) {
    return null;
  }

  // Must contain at least some letters
  if (!/[a-z]/i.test(root)) {
    return null;
  }

  return root;
}

/**
 * Detect transformation patterns in password
 */
function detectPatterns(password: string): string[] {
  const detected: string[] = [];

  // Length
  detected.push(`len:${password.length}`);

  // Case
  if (/^[A-Z][a-z]+/.test(password)) {
    detected.push("case:capitalize");
  }
  if (/^[A-Z]+$/.test(password)) {
    detected.push("case:upper");
  }
  if (/^[a-z]+$/.test(password)) {
    detected.push("case:lower");
  }

  // Digit suffix
  const digitMatch = password.match(/(\d+)$/);
  if (digitMatch) {
    const digits = digitMatch[1];
    detected.push(`suffix:d${digits.length}`);
    if (/^(19|20)\d{2}$/.test(digits)) {
      detected.push("suffix:year");
    }
  }

  // Special suffix
  const specialMatch = password.match(/([!@#$%^&*()]+)$/);
  if (specialMatch) {
    detected.push(`suffix:s${specialMatch[1].length}`);
    detected.push(`suffix:${specialMatch[1]}`);
  }

  // Digit prefix
  if (/^\d+/.test(password)) {
    detected.push("prefix:digits");
  }

  // Leetspeak detection
  if (/[4@]/.test(password) && /[a-zA-Z]/.test(password)) {
    detected.push("leet:a->@/4");
  }
  if (/[3]/.test(password) && /[a-zA-Z]/.test(password)) {
    detected.push("leet:e->3");
  }
  if (/[1!]/.test(password) && /[ilIL]/.test(password)) {
    detected.push("leet:i->1/!");
  }
  if (/[0]/.test(password) && /[oO]/.test(password)) {
    detected.push("leet:o->0");
  }

  return detected;
}

/**
 * Convert detected patterns to hashcat rules
 */
function patternToRule(pattern: string): string | null {
  // Suffix rules
  if (pattern.startsWith("suffix:d")) {
    const len = parseInt(pattern.slice(8));
    // $0 $1 $2 etc for appending digits
    return Array(len).fill(0).map((_, i) => `$${i}`).join(" ");
  }

  if (pattern === "suffix:!") return "$!";
  if (pattern === "suffix:@") return "$@";
  if (pattern === "suffix:#") return "$#";
  if (pattern === "suffix:$") return "$$";
  if (pattern === "suffix:!@") return "$! $@";
  if (pattern === "suffix:123") return "$1 $2 $3";
  if (pattern === "suffix:1234") return "$1 $2 $3 $4";

  // Case rules
  if (pattern === "case:capitalize") return "c";
  if (pattern === "case:upper") return "u";
  if (pattern === "case:lower") return "l";

  // Leetspeak rules
  if (pattern === "leet:a->@/4") return "sa@ sa4";
  if (pattern === "leet:e->3") return "se3";
  if (pattern === "leet:i->1/!") return "si1 si!";
  if (pattern === "leet:o->0") return "so0";

  return null;
}

/**
 * Analyze a file of cracked passwords
 */
async function analyzePasswords(inputPath: string): Promise<AnalysisResult> {
  const result: AnalysisResult = {
    totalPasswords: 0,
    uniquePasswords: 0,
    rootWords: new Map(),
    patterns: new Map(),
    suffixes: new Map(),
    prefixes: new Map(),
    lengthDistribution: new Map(),
  };

  const seen = new Set<string>();

  const rl = createInterface({
    input: createReadStream(inputPath),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    result.totalPasswords++;

    // Handle hash:password format
    const password = line.includes(":") ? line.split(":").slice(1).join(":") : line;

    if (!password) continue;

    // Dedup
    if (seen.has(password)) continue;
    seen.add(password);
    result.uniquePasswords++;

    // Length distribution
    const len = password.length;
    result.lengthDistribution.set(len, (result.lengthDistribution.get(len) || 0) + 1);

    // Extract root
    const root = extractRoot(password);
    if (root) {
      result.rootWords.set(root, (result.rootWords.get(root) || 0) + 1);
    }

    // Detect patterns
    const patterns = detectPatterns(password);
    for (const p of patterns) {
      result.patterns.set(p, (result.patterns.get(p) || 0) + 1);
    }

    // Track suffixes
    const digitSuffix = password.match(/(\d+)$/);
    if (digitSuffix) {
      result.suffixes.set(digitSuffix[1], (result.suffixes.get(digitSuffix[1]) || 0) + 1);
    }

    const specialSuffix = password.match(/([!@#$%^&*()]+)$/);
    if (specialSuffix) {
      result.suffixes.set(specialSuffix[1], (result.suffixes.get(specialSuffix[1]) || 0) + 1);
    }
  }

  return result;
}

/**
 * Load baseline words for comparison (nocap.txt = rockyou + rizzyou)
 * BETA.txt should contain words NOT in nocap.txt
 */
async function loadBaselineRoots(): Promise<Set<string>> {
  const roots = new Set<string>();

  // Prefer nocap.txt (combined wordlist), fallback to rockyou.txt
  const baselinePath = existsSync(NOCAP_PATH) ? NOCAP_PATH : ROCKYOU_PATH;

  if (!existsSync(baselinePath)) {
    console.warn("No baseline wordlist found at", NOCAP_PATH, "or", ROCKYOU_PATH);
    return roots;
  }

  console.log(`Loading baseline from: ${baselinePath}`);

  const rl = createInterface({
    input: createReadStream(baselinePath),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const root = extractRoot(line);
    if (root) {
      roots.add(root);
    }
  }

  return roots;
}

/**
 * Generate BETA.txt - new root words not in rockyou
 */
async function generateBeta(
  analysis: AnalysisResult,
  rockyouRoots: Set<string>,
  outputPath: string
): Promise<number> {
  const beta: string[] = [];

  for (const [root, count] of analysis.rootWords) {
    if (count >= MIN_ROOT_FREQUENCY && !rockyouRoots.has(root)) {
      beta.push(root);
    }
  }

  // Sort by frequency (most common first)
  beta.sort((a, b) => (analysis.rootWords.get(b) || 0) - (analysis.rootWords.get(a) || 0));

  // Deduplicate (already unique from Map)
  writeFileSync(outputPath, beta.join("\n") + "\n");
  return beta.length;
}

/**
 * Generate UNOBTAINIUM.rule - new rules from patterns
 */
function generateUnobtainium(analysis: AnalysisResult, outputPath: string): number {
  const rules = new Set<string>();

  // Sort patterns by frequency
  const sortedPatterns = Array.from(analysis.patterns.entries())
    .sort((a, b) => b[1] - a[1]);

  for (const [pattern, count] of sortedPatterns) {
    // Only patterns that appear frequently
    if (count < 10) continue;

    const rule = patternToRule(pattern);
    if (rule) {
      rules.add(rule);
    }
  }

  // Add common suffix rules from actual data
  const sortedSuffixes = Array.from(analysis.suffixes.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 50); // Top 50 suffixes

  for (const [suffix, count] of sortedSuffixes) {
    if (count < 5) continue;
    // Generate append rule for this suffix
    const rule = suffix.split("").map(c => `$${c}`).join(" ");
    rules.add(rule);
  }

  const ruleArray = Array.from(rules);
  writeFileSync(outputPath, ruleArray.join("\n") + "\n");
  return ruleArray.length;
}

// =============================================================================
// CLI
// =============================================================================

function printHelp(): void {
  console.log(`
DiamondAnalyzer - Analyze cracked passwords to extract patterns

Usage:
  bun DiamondAnalyzer.ts --analyze <file>        Analyze password file
  bun DiamondAnalyzer.ts --beta <file>           Generate BETA.txt (new roots)
  bun DiamondAnalyzer.ts --rules <file>          Generate UNOBTAINIUM.rule
  bun DiamondAnalyzer.ts --full <file>           Full analysis + all outputs

Input Format:
  Plain passwords (one per line) or HASH:PASSWORD format

Output Files:
  data/processed/BETA.txt            New root words
  data/processed/UNOBTAINIUM.rule    New rules
  data/processed/analysis-report.md  Full analysis report
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h") || args.length === 0) {
    printHelp();
    return;
  }

  const analyzeIdx = args.indexOf("--analyze");
  const betaIdx = args.indexOf("--beta");
  const rulesIdx = args.indexOf("--rules");
  const fullIdx = args.indexOf("--full");

  let inputFile: string | undefined;
  if (analyzeIdx !== -1) inputFile = args[analyzeIdx + 1];
  if (betaIdx !== -1) inputFile = args[betaIdx + 1];
  if (rulesIdx !== -1) inputFile = args[rulesIdx + 1];
  if (fullIdx !== -1) inputFile = args[fullIdx + 1];

  if (!inputFile || !existsSync(inputFile)) {
    console.error(`Input file not found: ${inputFile}`);
    process.exit(1);
  }

  console.log(`\nAnalyzing: ${inputFile}\n`);

  // Run analysis
  const analysis = await analyzePasswords(inputFile);

  console.log(`Total passwords: ${analysis.totalPasswords.toLocaleString()}`);
  console.log(`Unique passwords: ${analysis.uniquePasswords.toLocaleString()}`);
  console.log(`Unique root words: ${analysis.rootWords.size.toLocaleString()}`);
  console.log(`Patterns detected: ${analysis.patterns.size}`);

  // Length distribution
  console.log("\nLength Distribution:");
  const lengths = Array.from(analysis.lengthDistribution.entries())
    .sort((a, b) => a[0] - b[0]);
  for (const [len, count] of lengths.slice(0, 15)) {
    const bar = "█".repeat(Math.min(50, Math.round(count / analysis.uniquePasswords * 200)));
    console.log(`  ${len.toString().padStart(2)}: ${bar} ${count.toLocaleString()}`);
  }

  // Top patterns
  console.log("\nTop Patterns:");
  const topPatterns = Array.from(analysis.patterns.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  for (const [pattern, count] of topPatterns) {
    console.log(`  ${pattern}: ${count.toLocaleString()}`);
  }

  // Generate outputs if requested
  if (betaIdx !== -1 || fullIdx !== -1) {
    console.log("\nLoading baseline words for comparison (nocap.txt or rockyou.txt)...");
    const baselineRoots = await loadBaselineRoots();
    console.log(`  Loaded ${baselineRoots.size.toLocaleString()} baseline roots`);

    const betaPath = resolve(OUTPUT_DIR, "BETA.txt");
    const betaCount = await generateBeta(analysis, baselineRoots, betaPath);
    console.log(`\nGenerated BETA.txt: ${betaCount} new root words (not in baseline)`);
    console.log(`  Saved to: ${betaPath}`);
  }

  if (rulesIdx !== -1 || fullIdx !== -1) {
    const rulePath = resolve(OUTPUT_DIR, "UNOBTAINIUM.rule");
    const ruleCount = generateUnobtainium(analysis, rulePath);
    console.log(`\nGenerated UNOBTAINIUM.rule: ${ruleCount} rules`);
    console.log(`  Saved to: ${rulePath}`);
  }
}

main().catch(console.error);
