#!/usr/bin/env bun
/**
 * DiamondFeedback.ts - Analyze DIAMONDS to Extract Feedback for Next Batch
 *
 * REFACTORED 2026-02-09: Aligned with DiamondAnalyzer v2.0 approach.
 *
 * Previous approach FAILED because extractRoot() stripped suffixes from ALL
 * passwords including random brute-force garbage. Now uses entropy-based
 * classification from DiamondAnalyzer to separate structured from random.
 *
 * Creates a feedback loop by analyzing cracked passwords (DIAMONDS):
 * 1. NEW ROOT WORDS - Entropy-filtered, cohort-classified → BETA.txt
 * 2. NEW PATTERNS - Common transformations → unobtainium.rule
 * 3. COHORT WORDLISTS - Loaded from data/cohorts/ and merged into BETA.txt
 *
 * WORKFLOW:
 *   DiamondCollector → DiamondFeedback → Upload to Hashtopolis → Next batch
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { resolve, dirname } from "node:path";
// decodeHexPlain no longer needed here — $HEX decoding happens at potfile ingest (BigRedRunner/GravelProcessor)
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

// =============================================================================
// Configuration
// =============================================================================

const CURRENT_FILE = fileURLToPath(import.meta.url);
const SKILL_DIR = dirname(dirname(CURRENT_FILE));
const DATA_DIR = resolve(SKILL_DIR, "data");
const DIAMONDS_DIR = resolve(DATA_DIR, "diamonds");
const FEEDBACK_DIR = resolve(DATA_DIR, "feedback");
const HASHCRACK_DIR = resolve(SKILL_DIR, "..", "Hashcrack", "tools");

// Thresholds for inclusion
const MIN_ROOT_LENGTH = 3;
const MIN_ROOT_FREQUENCY = 2;  // Must appear in at least 2 passwords
const MIN_PATTERN_FREQUENCY = 5;  // Pattern must appear at least 5 times
const MIN_SUFFIX_FREQUENCY = 3;

// Entropy threshold: passwords above this are likely random/brute-force
const ENTROPY_THRESHOLD = 3.8;

// Baseline wordlists to compare against
const NOCAP_PATH = resolve(DATA_DIR, "nocap.txt");
const ROCKYOU_PATH = resolve(DATA_DIR, "rockyou.txt");

// Cohort wordlists directory
const COHORTS_DIR = resolve(DATA_DIR, "cohorts");

// Persistent discovered roots — accumulates across ALL batches
const DISCOVERED_ROOTS_PATH = resolve(FEEDBACK_DIR, "discovered-roots.txt");

// Sand state for feedback metrics
const SAND_STATE_PATH = resolve(DATA_DIR, "sand-state.json");

// Baseline rule files to compare against (avoid duplicating existing rules)
const ONERULE_PATH = resolve(SKILL_DIR, "..", "..", "..", "OneRuleToRuleThemStill.rule");
const NOCAP_RULE_PATH = resolve(DATA_DIR, "nocap.rule");

// =============================================================================
// Types
// =============================================================================

interface AnalysisResult {
  totalPasswords: number;
  uniquePasswords: number;
  rootWords: Map<string, number>;
  patterns: Map<string, number>;
  suffixes: Map<string, number>;
  prefixes: Map<string, number>;
  lengthDistribution: Map<number, number>;
  charsetDistribution: {
    lowercase: number;
    uppercase: number;
    digits: number;
    special: number;
    mixed: number;
  };
}

interface FeedbackReport {
  timestamp: string;
  batchesAnalyzed: string[];
  totalDiamonds: number;
  uniquePasswords: number;
  baselineLoaded: boolean;
  baselinePath: string | null;
  baselineRootCount: number;
  baselineRulesLoaded: boolean;
  baselineRuleSources: string[];
  baselineRuleCount: number;
  totalRootsExtracted: number;
  newRoots: number;
  candidateRules: number;
  filteredRules: number;
  newRules: number;
  topNewRoots: string[];
  topPatterns: string[];
  betaPath: string;
  rulePath: string;
}

// =============================================================================
// Analysis Functions
// =============================================================================

/**
 * Calculate Shannon entropy per character.
 * Random strings: ~4.0-5.0 bits/char, Structured passwords: ~2.0-3.5 bits/char
 */
function entropyPerChar(s: string): number {
  if (s.length === 0) return 0;
  const freq = new Map<string, number>();
  for (const c of s) freq.set(c, (freq.get(c) || 0) + 1);
  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / s.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * Extract root from a password using entropy-based classification.
 * Only returns roots from STRUCTURED passwords (word+suffix pattern).
 * Returns null for random/brute-force passwords.
 *
 * REFACTORED: Aligned with DiamondAnalyzer v2.0 approach.
 */
function extractRoot(password: string): string | null {
  // Strip prefix digits
  let root = password;
  const prefixMatch = root.match(/^(\d+)(.*)/);
  if (prefixMatch) root = prefixMatch[2];

  // Strip trailing digits
  const digitSuffix = root.match(/^(.*?)(\d+)$/);
  if (digitSuffix) root = digitSuffix[1];

  // Strip trailing specials
  const specialSuffix = root.match(/^(.*?)([!@#$%^&*()_\-+=.]+)$/);
  if (specialSuffix) root = specialSuffix[1];

  root = root.toLowerCase();

  // Must be at least MIN_ROOT_LENGTH chars of only letters
  if (root.length < MIN_ROOT_LENGTH || !/^[a-z]+$/i.test(root)) return null;

  // Must have vowels (real words have vowels)
  if (!/[aeiouy]/i.test(root)) return null;

  // Root entropy check for short roots (filter random fragments)
  const vowelRatio = (root.match(/[aeiouy]/gi) || []).length / root.length;
  const rootEnt = entropyPerChar(root);
  const isLongRoot = root.length >= 5;
  const isShortButWordLike = root.length >= 3 && root.length <= 4 && vowelRatio >= 0.25 && rootEnt < 2.5;

  if (!isLongRoot && !isShortButWordLike) return null;

  // Skip common patterns
  if (/^(qwer|asdf|zxcv|abcd|pass|word|test|admin|user|login|1234)/.test(root)) return null;

  return root;
}

/**
 * Detect transformation patterns in password
 */
function detectPatterns(password: string): string[] {
  const detected: string[] = [];

  // Length category
  if (password.length <= 6) detected.push("len:short");
  else if (password.length <= 8) detected.push("len:medium");
  else if (password.length <= 12) detected.push("len:long");
  else detected.push("len:very-long");

  // Case patterns
  if (/^[A-Z][a-z]+/.test(password)) detected.push("case:capitalize");
  if (/^[A-Z]+$/.test(password)) detected.push("case:upper");
  if (/^[a-z]+$/.test(password)) detected.push("case:lower");
  if (/^[a-z]+[A-Z]/.test(password)) detected.push("case:camel");

  // Digit suffix patterns
  const digitMatch = password.match(/(\d+)$/);
  if (digitMatch) {
    const digits = digitMatch[1];
    detected.push(`suffix:d${digits.length}`);

    // Specific year patterns
    if (/^(19|20)\d{2}$/.test(digits)) {
      detected.push("suffix:year");
      if (/^202[0-6]$/.test(digits)) detected.push("suffix:year-recent");
    }

    // Common number patterns
    if (/^123/.test(digits)) detected.push("suffix:123-seq");
    if (/^(\d)\1+$/.test(digits)) detected.push("suffix:repeated");
  }

  // Special character suffix
  const specialMatch = password.match(/([!@#$%^&*()]+)$/);
  if (specialMatch) {
    const special = specialMatch[1];
    detected.push(`suffix:special`);
    if (special === "!") detected.push("suffix:!");
    if (special === "@") detected.push("suffix:@");
    if (special === "!@") detected.push("suffix:!@");
    if (special === "123") detected.push("suffix:123");
  }

  // Combined suffix (digits + special)
  if (/\d+[!@#$%^&*()]+$/.test(password)) {
    detected.push("suffix:digit-special");
  }

  // Digit prefix
  if (/^\d+[a-zA-Z]/.test(password)) {
    detected.push("prefix:digits");
  }

  // Leetspeak detection
  if (/[4@]/.test(password) && /[a-zA-Z]/.test(password)) detected.push("leet:a");
  if (/3/.test(password) && /[eE]/.test(password)) detected.push("leet:e");
  if (/[1!]/.test(password) && /[iIlL]/.test(password)) detected.push("leet:i");
  if (/0/.test(password) && /[oO]/.test(password)) detected.push("leet:o");
  if (/\$/.test(password) && /[sS]/.test(password)) detected.push("leet:s");

  // Keyboard patterns
  if (/qwer|asdf|zxcv/i.test(password)) detected.push("keyboard:row");
  if (/qaz|wsx|edc/i.test(password)) detected.push("keyboard:column");

  // Repetition
  if (/(.)\1{2,}/.test(password)) detected.push("repeat:char");
  if (/(.{2,})\1+/.test(password)) detected.push("repeat:sequence");

  return detected;
}

/**
 * Convert pattern to hashcat rule
 */
function patternToRule(pattern: string, count: number): string | null {
  // Only generate rules for frequent patterns
  if (count < MIN_PATTERN_FREQUENCY) return null;

  // Suffix rules
  if (pattern === "suffix:d1") return "$0";  // Single digit
  if (pattern === "suffix:d2") return "$0 $1";  // Two digits
  if (pattern === "suffix:d3") return "$1 $2 $3";
  if (pattern === "suffix:d4") return "$1 $2 $3 $4";
  if (pattern === "suffix:!") return "$!";
  if (pattern === "suffix:@") return "$@";
  if (pattern === "suffix:!@") return "$! $@";
  if (pattern === "suffix:123") return "$1 $2 $3";
  if (pattern === "suffix:123-seq") return "$1 $2 $3";

  // Year suffixes (generate for recent years)
  if (pattern === "suffix:year-recent") {
    return null;  // Will generate specific year rules below
  }

  // Case rules
  if (pattern === "case:capitalize") return "c";
  if (pattern === "case:upper") return "u";
  if (pattern === "case:lower") return "l";

  // Leetspeak rules
  if (pattern === "leet:a") return "sa@";
  if (pattern === "leet:e") return "se3";
  if (pattern === "leet:i") return "si1";
  if (pattern === "leet:o") return "so0";
  if (pattern === "leet:s") return "ss$";

  return null;
}

/**
 * Generate specific suffix rules from actual data
 */
function generateSuffixRules(suffixes: Map<string, number>): string[] {
  const rules: string[] = [];

  // Sort by frequency
  const sorted = Array.from(suffixes.entries())
    .filter(([_, count]) => count >= MIN_SUFFIX_FREQUENCY)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 100);  // Top 100 suffixes

  for (const [suffix, _] of sorted) {
    // Generate append rule: $c for each character
    const rule = suffix.split("").map(c => `$${c}`).join(" ");
    rules.push(rule);
  }

  return rules;
}

/**
 * Analyze passwords from a file
 */
async function analyzeFile(filePath: string): Promise<AnalysisResult> {
  const result: AnalysisResult = {
    totalPasswords: 0,
    uniquePasswords: 0,
    rootWords: new Map(),
    patterns: new Map(),
    suffixes: new Map(),
    prefixes: new Map(),
    lengthDistribution: new Map(),
    charsetDistribution: {
      lowercase: 0,
      uppercase: 0,
      digits: 0,
      special: 0,
      mixed: 0,
    },
  };

  const seen = new Set<string>();

  const rl = createInterface({
    input: createReadStream(filePath),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    result.totalPasswords++;

    // Parse line: JSONL {"hash":"...","plain":"..."}, or plain text password
    let password: string;
    if (line.startsWith("{")) {
      try {
        const obj = JSON.parse(line);
        password = obj.plain || "";
      } catch {
        continue;
      }
    } else {
      password = line;
    }
    if (!password) continue;

    // Dedup
    if (seen.has(password)) continue;
    seen.add(password);
    result.uniquePasswords++;

    // Length distribution
    result.lengthDistribution.set(
      password.length,
      (result.lengthDistribution.get(password.length) || 0) + 1
    );

    // Charset analysis
    const hasLower = /[a-z]/.test(password);
    const hasUpper = /[A-Z]/.test(password);
    const hasDigit = /\d/.test(password);
    const hasSpecial = /[^a-zA-Z0-9]/.test(password);

    if (hasLower && !hasUpper && !hasDigit && !hasSpecial) result.charsetDistribution.lowercase++;
    else if (!hasLower && hasUpper && !hasDigit && !hasSpecial) result.charsetDistribution.uppercase++;
    else if (!hasLower && !hasUpper && hasDigit && !hasSpecial) result.charsetDistribution.digits++;
    else if (!hasLower && !hasUpper && !hasDigit && hasSpecial) result.charsetDistribution.special++;
    else result.charsetDistribution.mixed++;

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

    // Track actual suffixes
    const digitSuffix = password.match(/(\d+)$/);
    if (digitSuffix) {
      result.suffixes.set(digitSuffix[1], (result.suffixes.get(digitSuffix[1]) || 0) + 1);
    }

    const specialSuffix = password.match(/([!@#$%^&*()]+)$/);
    if (specialSuffix) {
      result.suffixes.set(specialSuffix[1], (result.suffixes.get(specialSuffix[1]) || 0) + 1);
    }

    // Track prefixes
    const digitPrefix = password.match(/^(\d+)/);
    if (digitPrefix) {
      result.prefixes.set(digitPrefix[1], (result.prefixes.get(digitPrefix[1]) || 0) + 1);
    }
  }

  return result;
}

interface BaselineResult {
  roots: Set<string>;
  loaded: boolean;
  path: string | null;
  count: number;
}

/**
 * Load baseline wordlist as raw lowercased words for O(1) lookup.
 *
 * REFACTORED: Load raw words instead of extracting roots from baseline.
 * The old approach extracted roots from 13.8M baseline entries, which
 * swallowed every real root. Now we check if the root word exists AS-IS
 * in the baseline (e.g., "minecraft" is in rockyou, so it's not new).
 */
async function loadBaselineRoots(): Promise<BaselineResult> {
  const roots = new Set<string>();

  // Prefer nocap.txt (rockyou + rizzyou), fallback to rockyou
  let baselinePath: string | null = null;
  if (existsSync(NOCAP_PATH)) {
    baselinePath = NOCAP_PATH;
  } else if (existsSync(ROCKYOU_PATH)) {
    baselinePath = ROCKYOU_PATH;
  }

  if (!baselinePath) {
    console.warn(`\nWARNING: No baseline wordlist found!`);
    console.warn(`  Expected: ${NOCAP_PATH}`);
    console.warn(`  Or: ${ROCKYOU_PATH}`);
    console.warn(`  Without a baseline, ALL roots will appear as "new".`);
    return { roots, loaded: false, path: null, count: 0 };
  }

  console.log(`\nLoading baseline words from: ${baselinePath}`);

  const rl = createInterface({
    input: createReadStream(baselinePath),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (line.length >= MIN_ROOT_LENGTH) {
      roots.add(line.toLowerCase().trim());
    }
  }

  // Also load cohort wordlists as baseline (roots we already know about)
  if (existsSync(COHORTS_DIR)) {
    const cohortFiles = readdirSync(COHORTS_DIR).filter(f => f.endsWith(".txt"));
    for (const file of cohortFiles) {
      const cohortPath = resolve(COHORTS_DIR, file);
      const rl2 = createInterface({
        input: createReadStream(cohortPath),
        crlfDelay: Infinity,
      });
      for await (const line of rl2) {
        const trimmed = line.trim().toLowerCase();
        if (trimmed && !trimmed.startsWith("#")) {
          roots.add(trimmed);
        }
      }
    }
  }

  console.log(`  Loaded ${roots.size.toLocaleString()} unique baseline words`);
  return { roots, loaded: true, path: baselinePath, count: roots.size };
}

interface BaselineRulesResult {
  rules: Set<string>;
  loaded: boolean;
  sources: string[];
  count: number;
}

/**
 * Load baseline rules from OneRuleToRuleThemStill and nocap.rule
 * Used to filter out rules that already exist in standard rule files
 */
async function loadBaselineRules(): Promise<BaselineRulesResult> {
  const rules = new Set<string>();
  const sources: string[] = [];

  const rulePaths = [
    { path: ONERULE_PATH, name: "OneRuleToRuleThemStill.rule" },
    { path: NOCAP_RULE_PATH, name: "nocap.rule" },
  ];

  for (const { path, name } of rulePaths) {
    if (!existsSync(path)) {
      console.log(`  Baseline rule file not found: ${name}`);
      continue;
    }

    const rl = createInterface({
      input: createReadStream(path),
      crlfDelay: Infinity,
    });

    let count = 0;
    for await (const line of rl) {
      // Skip comments and empty lines
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      // Normalize rule (remove extra whitespace)
      const normalizedRule = trimmed.replace(/\s+/g, " ");
      rules.add(normalizedRule);
      count++;
    }

    sources.push(`${name} (${count.toLocaleString()} rules)`);
  }

  return { rules, loaded: sources.length > 0, sources, count: rules.size };
}

/**
 * Analyze all DIAMONDS and generate feedback
 */
async function generateFeedback(options: {
  batches?: string[];
  minRootFreq?: number;
  upload?: boolean;
  dryRun?: boolean;
}): Promise<FeedbackReport> {
  const {
    batches,
    minRootFreq = MIN_ROOT_FREQUENCY,
    upload = false,
    dryRun = false
  } = options;

  // Ensure feedback directory exists
  if (!existsSync(FEEDBACK_DIR)) {
    mkdirSync(FEEDBACK_DIR, { recursive: true });
  }

  // Find DIAMOND files to analyze
  let diamondFiles: string[] = [];

  if (batches && batches.length > 0) {
    // Specific batches — look for passwords-batch-NNNN.txt (plain text passwords)
    for (const batch of batches) {
      const pwPath = resolve(DIAMONDS_DIR, `passwords-${batch}.txt`);
      if (existsSync(pwPath)) {
        diamondFiles.push(pwPath);
      } else {
        console.warn(`Warning: No DIAMONDS password file for ${batch}`);
      }
    }
  } else {
    // All batches — use passwords-batch-*.txt files (plain text, one per line)
    if (existsSync(DIAMONDS_DIR)) {
      diamondFiles = readdirSync(DIAMONDS_DIR)
        .filter(f => f.startsWith("passwords-batch-") && f.endsWith(".txt"))
        .map(f => resolve(DIAMONDS_DIR, f));
    }
    // Also include the append-only JSONL if it exists (for hash:plain analysis)
    const jsonlPath = resolve(DIAMONDS_DIR, "hash_plaintext_pairs.jsonl");
    if (existsSync(jsonlPath) && diamondFiles.length === 0) {
      diamondFiles.push(jsonlPath);
    }
  }

  if (diamondFiles.length === 0) {
    console.error("No DIAMOND files found to analyze");
    process.exit(1);
  }

  console.log(`\nAnalyzing ${diamondFiles.length} DIAMOND file(s)...`);

  // Aggregate analysis across all files
  const aggregated: AnalysisResult = {
    totalPasswords: 0,
    uniquePasswords: 0,
    rootWords: new Map(),
    patterns: new Map(),
    suffixes: new Map(),
    prefixes: new Map(),
    lengthDistribution: new Map(),
    charsetDistribution: { lowercase: 0, uppercase: 0, digits: 0, special: 0, mixed: 0 },
  };

  const batchesAnalyzed: string[] = [];

  for (const filePath of diamondFiles) {
    const batchName = filePath.split(/[/\\]/).pop()?.replace(".txt", "") || "unknown";
    batchesAnalyzed.push(batchName);

    console.log(`  Analyzing ${batchName}...`);
    const result = await analyzeFile(filePath);

    aggregated.totalPasswords += result.totalPasswords;
    aggregated.uniquePasswords += result.uniquePasswords;

    // Merge maps
    for (const [key, val] of result.rootWords) {
      aggregated.rootWords.set(key, (aggregated.rootWords.get(key) || 0) + val);
    }
    for (const [key, val] of result.patterns) {
      aggregated.patterns.set(key, (aggregated.patterns.get(key) || 0) + val);
    }
    for (const [key, val] of result.suffixes) {
      aggregated.suffixes.set(key, (aggregated.suffixes.get(key) || 0) + val);
    }
    for (const [key, val] of result.prefixes) {
      aggregated.prefixes.set(key, (aggregated.prefixes.get(key) || 0) + val);
    }
    for (const [key, val] of result.lengthDistribution) {
      aggregated.lengthDistribution.set(key, (aggregated.lengthDistribution.get(key) || 0) + val);
    }

    // Sum charset distribution
    aggregated.charsetDistribution.lowercase += result.charsetDistribution.lowercase;
    aggregated.charsetDistribution.uppercase += result.charsetDistribution.uppercase;
    aggregated.charsetDistribution.digits += result.charsetDistribution.digits;
    aggregated.charsetDistribution.special += result.charsetDistribution.special;
    aggregated.charsetDistribution.mixed += result.charsetDistribution.mixed;
  }

  console.log(`\nTotal passwords analyzed: ${aggregated.totalPasswords.toLocaleString()}`);
  console.log(`Unique passwords: ${aggregated.uniquePasswords.toLocaleString()}`);
  console.log(`Unique root words: ${aggregated.rootWords.size.toLocaleString()}`);

  // Load baseline for comparison
  const baseline = await loadBaselineRoots();

  // Find NEW roots (not in baseline)
  // REFACTORED: Only keep high-confidence roots that are genuinely new
  const newRoots: Array<{ root: string; count: number }> = [];
  for (const [root, count] of aggregated.rootWords) {
    if (count >= minRootFreq && !baseline.roots.has(root)) {
      // Additional filtering: require length >= 5 for unclassified roots
      // Short roots (3-4 chars) are almost always noise unless very high frequency
      if (root.length >= 5 || count >= 5) {
        newRoots.push({ root, count });
      }
    }
  }
  newRoots.sort((a, b) => b.count - a.count);

  console.log(`\nTotal roots extracted: ${aggregated.rootWords.size.toLocaleString()}`);
  console.log(`Baseline comparison: ${baseline.loaded ? `${baseline.count.toLocaleString()} words from ${baseline.path}` : "NOT LOADED (all roots appear new)"}`);
  console.log(`New roots discovered: ${newRoots.length.toLocaleString()}`);

  // Generate BETA.txt (discovered roots + cohort wordlists)
  // KEY: Uses persistent discovered-roots.txt to ACCUMULATE roots across batches
  const betaPath = resolve(FEEDBACK_DIR, "BETA.txt");
  // Metrics tracking (populated in the block below, used for sand-state update)
  let metricsDiscoveredTotal = 0;
  let metricsBetaSize = 0;
  let metricsNewDiscoveries = 0;
  if (!dryRun) {
    // Load previously discovered roots (persisted across batches)
    const discoveredRoots = new Set<string>();
    if (existsSync(DISCOVERED_ROOTS_PATH)) {
      const existing = readFileSync(DISCOVERED_ROOTS_PATH, "utf-8");
      for (const line of existing.split("\n")) {
        const word = line.trim().toLowerCase();
        if (word && !word.startsWith("#")) {
          discoveredRoots.add(word);
        }
      }
      console.log(`  Loaded ${discoveredRoots.size.toLocaleString()} previously discovered roots`);
    }

    // Add NEW roots from this batch to the persistent set
    const newDiscoveries = newRoots.filter(r => !discoveredRoots.has(r.root));
    for (const r of newRoots) {
      discoveredRoots.add(r.root);
    }
    console.log(`  +${newDiscoveries.length} new roots this batch (${discoveredRoots.size.toLocaleString()} total discovered)`);

    // Save updated discovered-roots.txt (persistent accumulation)
    const discoveredContent = [
      "# discovered-roots.txt — Persistent root accumulation across ALL batches",
      `# Updated: ${new Date().toISOString()}`,
      `# Total: ${discoveredRoots.size} roots`,
      "#",
      ...Array.from(discoveredRoots).sort(),
    ].join("\n") + "\n";
    writeFileSync(DISCOVERED_ROOTS_PATH, discoveredContent);

    // Build BETA.txt: ALL discovered roots + ALL cohort words
    const betaWords = new Set(discoveredRoots);

    // Merge cohort wordlists (the real value — comprehensive name lists)
    // Always include cohort words regardless of baseline — they ARE the payload
    let cohortWordsAdded = 0;
    if (existsSync(COHORTS_DIR)) {
      const cohortFiles = readdirSync(COHORTS_DIR).filter(f => f.endsWith(".txt"));
      for (const file of cohortFiles) {
        const cohortPath = resolve(COHORTS_DIR, file);
        const content = readFileSync(cohortPath, "utf-8");
        for (const line of content.split("\n")) {
          const word = line.trim().toLowerCase();
          if (word && !word.startsWith("#")) {
            betaWords.add(word);
            cohortWordsAdded++;
          }
        }
      }
      console.log(`  Merged ${cohortWordsAdded.toLocaleString()} words from cohort wordlists`);
    }

    const betaContent = Array.from(betaWords).join("\n") + "\n";
    writeFileSync(betaPath, betaContent);
    console.log(`  Wrote ${betaWords.size.toLocaleString()} total words to ${betaPath}`);

    // Capture metrics for sand-state update
    metricsDiscoveredTotal = discoveredRoots.size;
    metricsBetaSize = betaWords.size;
    metricsNewDiscoveries = newDiscoveries.length;
  }

  // Load baseline rules to filter against
  console.log(`\nLoading baseline rules for comparison...`);
  const baselineRules = await loadBaselineRules();
  if (baselineRules.loaded) {
    console.log(`  Baseline rules: ${baselineRules.count.toLocaleString()} from ${baselineRules.sources.join(", ")}`);
  } else {
    console.log(`  ⚠ No baseline rules loaded - all generated rules will be included`);
  }

  // Generate pattern-based rules (candidates before filtering)
  const candidateRules = new Set<string>();

  // From detected patterns
  for (const [pattern, count] of aggregated.patterns) {
    const rule = patternToRule(pattern, count);
    if (rule) candidateRules.add(rule);
  }

  // From actual suffixes
  const suffixRules = generateSuffixRules(aggregated.suffixes);
  for (const rule of suffixRules) {
    candidateRules.add(rule);
  }

  // Add year suffix rules (2015-2026)
  for (let year = 2015; year <= 2026; year++) {
    candidateRules.add(`$${String(year)[0]} $${String(year)[1]} $${String(year)[2]} $${String(year)[3]}`);
  }

  // Add common combination rules
  candidateRules.add("c $1");  // Capitalize + 1
  candidateRules.add("c $1 $2 $3");  // Capitalize + 123
  candidateRules.add("c $!");  // Capitalize + !
  candidateRules.add("l $1 $2 $3");  // Lowercase + 123
  candidateRules.add("u");  // Uppercase all
  candidateRules.add("sa@ se3 si1 so0");  // Full leetspeak

  // Filter out rules that already exist in baseline rule files
  const newRules: string[] = [];
  let filteredCount = 0;
  for (const rule of candidateRules) {
    const normalizedRule = rule.replace(/\s+/g, " ");
    if (baselineRules.rules.has(normalizedRule)) {
      filteredCount++;
    } else {
      newRules.push(rule);
    }
  }

  console.log(`\nRules analysis:`);
  console.log(`  Candidate rules generated: ${candidateRules.size}`);
  console.log(`  Already in baseline: ${filteredCount} (filtered out)`);
  console.log(`  NEW rules (not in OneRule/nocap): ${newRules.length}`);

  // Generate unobtainium.rule (only NEW rules not in existing rule files)
  // Preserves manually-added rules from previous runs (marked with "# Deep analysis" comments)
  const rulePath = resolve(FEEDBACK_DIR, "unobtainium.rule");
  if (!dryRun) {
    // Collect manually-added rules from existing file before overwriting
    const manualRules: string[] = [];
    if (existsSync(rulePath)) {
      const existing = readFileSync(rulePath, "utf-8");
      let inManualSection = false;
      for (const line of existing.split("\n")) {
        if (line.startsWith("# Deep analysis") || line.startsWith("# Manual")) {
          inManualSection = true;
          manualRules.push(line);
        } else if (inManualSection && line.trim() !== "") {
          // Continuation of manual section — non-empty rule lines
          manualRules.push(line);
        } else if (inManualSection && line.trim() === "") {
          // End of manual section
          inManualSection = false;
        }
      }
    }

    const allNewRules = [...newRules];
    // Merge manual rules, avoiding duplicates
    const ruleSet = new Set(newRules.map((r) => r.trim()));
    for (const mr of manualRules) {
      if (!mr.startsWith("#") && mr.trim() !== "" && !ruleSet.has(mr.trim())) {
        allNewRules.push(mr);
        ruleSet.add(mr.trim());
      }
    }

    const ruleLines = [
      "# UNOBTAINIUM.rule - Auto-generated from DIAMOND analysis",
      "#",
      "# PURPOSE: Rules discovered from cracked passwords (DIAMONDS) that are",
      "#          NOT already covered by OneRuleToRuleThemStill.rule or nocap.rule.",
      "#          This file should be TESTED each batch to measure effectiveness.",
      "#",
      `# Generated: ${new Date().toISOString()}`,
      `# Batches analyzed: ${batchesAnalyzed.join(", ")}`,
      `# Total passwords: ${aggregated.totalPasswords.toLocaleString()}`,
      `# Baseline filtered: ${filteredCount} rules (already in OneRule/nocap)`,
      `# New rules: ${allNewRules.length}`,
      "",
      "# NEW pattern-based rules (not in baseline)",
      ...newRules,
    ];

    // Re-append manual section if it existed
    if (manualRules.length > 0) {
      ruleLines.push("");
      ruleLines.push(...manualRules);
    }

    ruleLines.push("");
    const ruleContent = ruleLines.join("\n");
    writeFileSync(rulePath, ruleContent);
    const manualCount = manualRules.filter((r) => !r.startsWith("#")).length;
    console.log(`  Wrote ${newRules.length} auto + ${manualCount} manual rules to ${rulePath}`);
  }

  // Print analysis summary
  console.log("\n" + "=".repeat(60));
  console.log("FEEDBACK ANALYSIS SUMMARY");
  console.log("=".repeat(60));

  console.log("\nTop 10 NEW Root Words:");
  for (const { root, count } of newRoots.slice(0, 10)) {
    console.log(`  ${root}: ${count} occurrences`);
  }

  console.log("\nTop 10 Patterns:");
  const topPatterns = Array.from(aggregated.patterns.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  for (const [pattern, count] of topPatterns) {
    const pct = ((count / aggregated.uniquePasswords) * 100).toFixed(1);
    console.log(`  ${pattern}: ${count.toLocaleString()} (${pct}%)`);
  }

  console.log("\nTop 10 Suffixes:");
  const topSuffixes = Array.from(aggregated.suffixes.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  for (const [suffix, count] of topSuffixes) {
    console.log(`  "${suffix}": ${count.toLocaleString()}`);
  }

  console.log("\nCharset Distribution:");
  const total = aggregated.uniquePasswords;
  console.log(`  Lowercase only: ${aggregated.charsetDistribution.lowercase.toLocaleString()} (${((aggregated.charsetDistribution.lowercase / total) * 100).toFixed(1)}%)`);
  console.log(`  Uppercase only: ${aggregated.charsetDistribution.uppercase.toLocaleString()} (${((aggregated.charsetDistribution.uppercase / total) * 100).toFixed(1)}%)`);
  console.log(`  Digits only: ${aggregated.charsetDistribution.digits.toLocaleString()} (${((aggregated.charsetDistribution.digits / total) * 100).toFixed(1)}%)`);
  console.log(`  Mixed: ${aggregated.charsetDistribution.mixed.toLocaleString()} (${((aggregated.charsetDistribution.mixed / total) * 100).toFixed(1)}%)`);

  console.log("\nLength Distribution:");
  const lengths = Array.from(aggregated.lengthDistribution.entries())
    .sort((a, b) => a[0] - b[0]);
  for (const [len, count] of lengths.slice(0, 12)) {
    const bar = "█".repeat(Math.min(40, Math.round(count / total * 200)));
    console.log(`  ${len.toString().padStart(2)}: ${bar} ${count.toLocaleString()}`);
  }

  // Upload to Hashtopolis if requested
  if (upload && !dryRun) {
    console.log("\n" + "=".repeat(60));
    console.log("UPLOADING TO HASHTOPOLIS");
    console.log("=".repeat(60));
    await uploadFeedbackFiles(betaPath, rulePath);
  }

  // Generate report
  const report: FeedbackReport = {
    timestamp: new Date().toISOString(),
    batchesAnalyzed,
    totalDiamonds: aggregated.totalPasswords,
    uniquePasswords: aggregated.uniquePasswords,
    baselineLoaded: baseline.loaded,
    baselinePath: baseline.path,
    baselineRootCount: baseline.count,
    baselineRulesLoaded: baselineRules.loaded,
    baselineRuleSources: baselineRules.sources,
    baselineRuleCount: baselineRules.count,
    totalRootsExtracted: aggregated.rootWords.size,
    newRoots: newRoots.length,
    candidateRules: candidateRules.size,
    filteredRules: filteredCount,
    newRules: newRules.length,
    topNewRoots: newRoots.slice(0, 20).map(r => r.root),
    topPatterns: topPatterns.map(([p, _]) => p),
    betaPath,
    rulePath,
  };

  // Save report
  const reportPath = resolve(FEEDBACK_DIR, "feedback-report.json");
  if (!dryRun) {
    writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`\nReport saved to: ${reportPath}`);
  }

  // Update sand-state.json with feedback metrics for each analyzed batch
  if (!dryRun && existsSync(SAND_STATE_PATH)) {
    try {
      const sandState = JSON.parse(readFileSync(SAND_STATE_PATH, "utf-8"));
      // Update the LAST batch in batchesAnalyzed (the one just processed)
      const targetBatch = batchesAnalyzed[batchesAnalyzed.length - 1];
      if (targetBatch && sandState.batches?.[targetBatch]) {
        // Compute feedbackCracks from per-attack data
        const FEEDBACK_PREFIXES = ["feedback-", "nocapplus-"];
        const attackResults: Array<{ attack: string; newCracks: number }> =
          sandState.batches[targetBatch].attackResults || [];
        const feedbackCracks = attackResults
          .filter((r: { attack: string }) => FEEDBACK_PREFIXES.some(p => r.attack.startsWith(p)))
          .reduce((sum: number, r: { newCracks: number }) => sum + r.newCracks, 0);

        sandState.batches[targetBatch].feedback = {
          newRootsDiscovered: metricsNewDiscoveries,
          hibpPromoted: 0,  // tracked by DiamondAnalyzer separately
          totalDiscoveredRoots: metricsDiscoveredTotal,
          betaSize: metricsBetaSize,
          nocapPlusSize: 0,  // populated by rebuild-nocap-plus.py
          feedbackCracks,
        };
        writeFileSync(SAND_STATE_PATH, JSON.stringify(sandState, null, 2));
        console.log(`  Updated sand-state.json feedback metrics for ${targetBatch} (feedbackCracks: ${feedbackCracks})`);
      }
    } catch (e) {
      console.log(`  Warning: Could not update sand-state.json: ${e}`);
    }
  }

  return report;
}

/**
 * Upload feedback files to Hashtopolis
 */
async function uploadFileToHashtopolis(
  serverIp: string,
  sshUser: string,
  localPath: string,
  remoteFilename: string
): Promise<boolean> {
  // Pattern from FileUploader.ts: SCP → docker cp → copy to BOTH paths inside container
  try {
    // Step 1: SCP to server /tmp
    console.log(`  SCP to server /tmp/${remoteFilename}...`);
    execSync(`scp -o StrictHostKeyChecking=no "${localPath}" ${sshUser}@${serverIp}:/tmp/${remoteFilename}`, {
      encoding: "utf-8",
      timeout: 60000,
    });

    // Step 2: docker cp from host /tmp into container /tmp
    console.log(`  docker cp into container...`);
    execSync(`ssh -o StrictHostKeyChecking=no ${sshUser}@${serverIp} "sudo docker cp /tmp/${remoteFilename} hashtopolis-backend:/tmp/${remoteFilename}"`, {
      encoding: "utf-8",
      timeout: 30000,
    });

    // Step 3: Copy to BOTH Hashtopolis paths inside container (as root for permissions)
    console.log(`  Copying to both Hashtopolis file directories...`);
    const copyCmd = `ssh -o StrictHostKeyChecking=no ${sshUser}@${serverIp} "` +
      `sudo docker exec -u root hashtopolis-backend bash -c '` +
      `cp /tmp/${remoteFilename} /var/www/hashtopolis/files/${remoteFilename} && ` +
      `chown www-data:www-data /var/www/hashtopolis/files/${remoteFilename} && ` +
      `mkdir -p /usr/local/share/hashtopolis/files && ` +
      `cp /tmp/${remoteFilename} /usr/local/share/hashtopolis/files/${remoteFilename} && ` +
      `chown www-data:www-data /usr/local/share/hashtopolis/files/${remoteFilename} && ` +
      `rm /tmp/${remoteFilename}' && ` +
      `rm /tmp/${remoteFilename}"`;
    execSync(copyCmd, { encoding: "utf-8", timeout: 60000 });

    console.log(`  ${remoteFilename} uploaded successfully`);
    return true;
  } catch (e) {
    console.error(`  Failed to upload ${remoteFilename}: ${(e as Error).message}`);
    return false;
  }
}

async function uploadFeedbackFiles(betaPath: string, rulePath: string): Promise<void> {
  // Get server config from terraform
  const terraformDir = resolve(HASHCRACK_DIR, "..", "terraform", "aws");

  let serverIp: string;
  try {
    serverIp = execSync(`terraform output -raw server_ip`, { encoding: "utf-8", cwd: terraformDir }).trim();
  } catch (e) {
    console.error("Cannot get server IP from terraform");
    return;
  }

  const sshUser = "ubuntu";

  // Upload BETA.txt
  if (existsSync(betaPath)) {
    console.log(`Uploading BETA.txt to server...`);
    await uploadFileToHashtopolis(serverIp, sshUser, betaPath, "BETA.txt");
  }

  // Upload UNOBTAINUM.rule (note: server uses UNOBTAINUM spelling, fileId=8)
  if (existsSync(rulePath)) {
    console.log(`Uploading UNOBTAINUM.rule to server...`);
    await uploadFileToHashtopolis(serverIp, sshUser, rulePath, "UNOBTAINUM.rule");
  }

  // Update file sizes in database
  console.log("\nUpdating file sizes in database...");
  try {
    const dbPassword = execSync(`terraform output -raw db_password`, { encoding: "utf-8", cwd: terraformDir }).trim();
    const betaSize = existsSync(betaPath) ? readFileSync(betaPath).length : 0;
    const ruleSize = existsSync(rulePath) ? readFileSync(rulePath).length : 0;
    const sql = `UPDATE File SET size=${betaSize} WHERE fileId=12; UPDATE File SET size=${ruleSize} WHERE fileId=8; SELECT fileId, filename, size FROM File WHERE fileId IN (8, 12);`;
    const b64Sql = Buffer.from(sql).toString('base64');
    const shell = process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "/bin/bash";
    const result = execSync(
      `ssh -o StrictHostKeyChecking=no ${sshUser}@${serverIp} "echo ${b64Sql} | base64 -d | sudo docker exec -i hashtopolis-db mysql -u hashtopolis -p'${dbPassword}' hashtopolis -sN"`,
      { encoding: "utf-8", timeout: 30000, shell }
    );
    console.log(`  ${result}`);
  } catch (e) {
    console.warn(`  Warning: Could not update file sizes: ${(e as Error).message}`);
  }
}

// =============================================================================
// CLI Entry Point
// =============================================================================

function printHelp(): void {
  console.log(`
DiamondFeedback - Analyze DIAMONDS to Extract Feedback for Next Batch

This tool creates a feedback loop by analyzing cracked passwords (DIAMONDS)
to discover new root words and patterns that can improve future crack rates.

Usage:
  bun DiamondFeedback.ts                     Analyze all DIAMOND batches
  bun DiamondFeedback.ts --batch batch-0001  Analyze specific batch
  bun DiamondFeedback.ts --upload            Also upload to Hashtopolis
  bun DiamondFeedback.ts --dry-run           Preview without writing files

Options:
  --batch <name>     Analyze specific batch (can specify multiple)
  --min-freq <n>     Minimum root frequency (default: ${MIN_ROOT_FREQUENCY})
  --upload           Upload feedback files to Hashtopolis server
  --dry-run          Preview analysis without writing files

Output Files:
  data/feedback/BETA.txt           New root words (not in baseline)
  data/feedback/unobtainium.rule   New rules from patterns
  data/feedback/feedback-report.json  Analysis report

Workflow:
  1. Run DiamondCollector to gather cracked passwords
  2. Run DiamondFeedback to analyze and generate feedback
  3. Upload files to Hashtopolis (--upload or manual)
  4. Register files in Hashtopolis UI
  5. Update SandProcessor.ts file IDs for feedback attacks
  6. Next batch will use feedback-enhanced attacks
`);
}

if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    process.exit(0);
  }

  // Parse arguments
  const batches: string[] = [];
  let minRootFreq = MIN_ROOT_FREQUENCY;
  let upload = false;
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--batch":
        batches.push(args[++i]);
        break;
      case "--min-freq":
        minRootFreq = parseInt(args[++i]) || MIN_ROOT_FREQUENCY;
        break;
      case "--upload":
        upload = true;
        break;
      case "--dry-run":
        dryRun = true;
        break;
    }
  }

  try {
    await generateFeedback({
      batches: batches.length > 0 ? batches : undefined,
      minRootFreq,
      upload,
      dryRun,
    });
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
  }
}
