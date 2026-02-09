#!/usr/bin/env bun
/**
 * DiamondAnalyzer.ts - Analyze Cracked Passwords to Extract Actionable Feedback
 *
 * REFACTORED 2026-02-09: Complete rewrite based on THEALGORITHM analysis.
 *
 * Previous approach FAILED because:
 * - Stripped suffixes from ALL passwords including random brute-force garbage
 * - nocap.txt baseline (6.4M words) swallowed almost every real root
 * - Produced noise like "lbvf", "c3bf" instead of actionable roots
 * - Could not distinguish structured passwords from random strings
 *
 * New approach:
 * 1. SEPARATE structured passwords from random/brute-force using entropy scoring
 * 2. EXTRACT roots only from structured passwords (word+suffix pattern)
 * 3. CLASSIFY new roots by cohort (names, cultural terms, compound words)
 * 4. PRODUCE actionable BETA.txt with real words + cohort analysis report
 * 5. GENERATE UNOBTAINIUM.rule from suffix/transformation patterns
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

import { createReadStream, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CURRENT_FILE = fileURLToPath(import.meta.url);
const SKILL_DIR = dirname(dirname(CURRENT_FILE));
const DATA_DIR = resolve(SKILL_DIR, "data");
const OUTPUT_DIR = resolve(DATA_DIR, "processed");

// =============================================================================
// Configuration
// =============================================================================

// nocap.txt (rockyou + rizzyou) as baseline — roots IN this are already covered
const NOCAP_PATH = resolve(DATA_DIR, "nocap.txt");
const ROCKYOU_PATH = resolve(DATA_DIR, "rockyou.txt");

// Entropy threshold: passwords above this are likely random/brute-force
// "p@ssw0rd1" ≈ 2.5 bits/char, "!0tUA6" ≈ 4.5 bits/char
const ENTROPY_THRESHOLD = 3.8;

// Minimum root length for extraction
const MIN_ROOT_LENGTH = 3;

// =============================================================================
// Cohort Detection Patterns
// =============================================================================

// Language/cultural patterns for classifying roots not in baseline
const COHORT_PATTERNS: Record<string, { description: string; patterns: RegExp[]; examples: string[] }> = {
  "turkish": {
    description: "Turkish names and words",
    patterns: [
      /^(oguz|elif|yekta|furkan|emre|burak|berkay|arda|kaan|onur|cem|tolga|baris|serkan|melis|defne|cansu|dilara|gamze|pinar|zeynep|selin|irem|buse|ece|ebru|murat|kemal|ahmet|mehmet|mustafa|yusuf|hakan|volkan|erdem|tugba|deniz|ayse|fatma|hatice|kubra)$/i,
    ],
    examples: ["furkan", "emre", "berkay", "elif", "zeynep"],
  },
  "indian": {
    description: "Indian/South Asian names and words",
    patterns: [
      /^(abhi|anuj|anup|arif|ashu|amit|anil|arun|ashok|deepak|gaurav|kapil|manoj|nitin|pankaj|rahul|rajesh|sanjay|sunil|vijay|vinod|ravi|sonu|guddu|pappu|tinku|rinku|vishal|sachin|rohit|vikas|akash|sunny|neha|pooja|priya|swati|divya|sneha|anjali|komal|nisha|manish|subhash|umesh|vimal|dhaval|nishu|harsh|kiran|jyoti|meena|rekha|geeta|seema|shubham|tushar|kunal|varun|arjun|vikram|naveen|dinesh|suresh|mukesh|ramesh|ganesh|mahesh|yogesh|hitesh|ritesh|jitesh|nilesh|naresh|lokesh|rakesh|rajesh|mangesh|kamlesh)$/i,
      /^(sri|shri|ram|jai|om|dev|lal|das)$/i,
    ],
    examples: ["umesh", "subhash", "dhaval", "nishu", "vimal"],
  },
  "arabic": {
    description: "Arabic/Middle Eastern names",
    patterns: [
      /^(ahmed|ali|hassan|hussein|khalid|mahmoud|mohamed|omar|youssef|zaid|bilal|faisal|hamza|nabil|rami|sami|tarek|walid|umer|ehab|afroz|kareem|jameel|rashid|saleem|shahid|tariq|wasim|zaheer|imran|irfan|nadeem|nasir|asif|arif|junaid|fahad|sultan|nasser|abdullah|jannat|fatima|aisha|zainab|maryam|abdel|abdal|abdur|abdu)$/i,
      /^(abu[a-z]{3,})$/i,  // abu- prefix with real name (abubakar, etc.)
    ],
    examples: ["abdullah", "jannat", "ahmed", "hamza", "bilal"],
  },
  "slavic": {
    description: "Slavic/Eastern European names (diminutives)",
    patterns: [
      /^(nastya|slavik|slava|vanya|ruslan|dima|misha|kolya|petya|sasha|maks|olia|olya|natasha|katya|tanya|lena|vera|svetlana|irina|marina|elena|galina|nadia|lyuba|andrei|sergei|dmitri|nikita|artem|roman|maxim|ivan|pavel|oleg|igor|vitaly|bogdan|yaroslav|taras|sveta|zhenya|lyosha|kostya|alyona|polina|ksenia|dasha|masha|anya|yulia|tolik|zhenya|volodya|grisha|pasha|borya|gosha|senya|fedya|mitya|vasya|tolya|lyonya|lyuda)$/i,
    ],
    examples: ["nastya", "slavik", "vanya", "ruslan", "dima"],
  },
  "chinese-pinyin": {
    description: "Chinese romanized (Pinyin) names",
    patterns: [
      /^(wang|zhang|zhao|zhou|chen|yang|huang|liu|sun|xiao|lin|lei|hui|yan|fang|hong|ming|jing|wei|qiang|yong|guang|ping|cheng|dong|feng|hao|jian|jun|long|qing|shan|tao|ting|xin|zhi|zhong|bao|cai|chang|chun|gang|guo|hai|han|hua|jie|kai|lan|liang|mei|nan|ning|peng|rong|rui|sheng|shu|song|wen|wu|xia|xue|yi|ying|yu|yuan|yue|zhe|zhen|zhu|bin|bo|chao|da|fan|guang|he|heng|ji|jin|ke|kang|li|lian|luo|meng|min|mo|mu|nian|pan|qi|qin|ren|si|tan|wan|xiang|xiu|xu|yao|ye|yin|yun|zeng|zhan|zheng|zi)$/i,
    ],
    examples: ["xiao", "zhou", "ming", "jing", "wei"],
  },
  "cricket": {
    description: "Cricket players, IPL teams, fan terms",
    patterns: [
      /^(virat|kohli|bumrah|pant|dhoni|sachin|rohit|jadeja|ashwin|rahane|shami|siraj|pandya|iyer|gill|csk|rcb|mi|kkr|srh|dc|pbks|rr|lsg|gt|thala|hitman|bleedblue|whistlepodu)$/i,
    ],
    examples: ["virat", "kohli", "dhoni", "csk", "rcb"],
  },
  "kpop-music": {
    description: "K-pop, current music artists, fandoms",
    patterns: [
      /^(jungkook|jimin|yoongi|namjoon|seokjin|hoseok|taehyung|jisoo|jennie|rose|lisa|yeji|bangtan|ateez|enhypen|newjeans|aespa|sza|badbunny|dualipa|postmalone|arianagrande|harrystyles|erastour|swiftie|belieber|directioner|arianator|beyhive|blink|army|stay|engene)$/i,
    ],
    examples: ["jungkook", "jimin", "bangtan", "sza", "badbunny"],
  },
  "gaming-streaming": {
    description: "Gaming, streaming, esports terms",
    patterns: [
      /^(minecraft|fortnite|roblox|valorant|genshin|overwatch|skyrim|pokemon|zelda|warzone|apex|pubg|twitch|pewdiepie|mrbeast|among|amogus|creeper|enderman|warden|steve|herobrine|noob|ggwp)$/i,
    ],
    examples: ["minecraft", "fortnite", "overwatch", "skyrim", "valorant"],
  },
  "sports-current": {
    description: "Current sports stars and fan culture",
    patterns: [
      /^(jokic|embiid|wembanyama|banchero|kuminga|foden|haaland|mbappe|vinicius|bellingham|mahomes|stroud|bryce|lamar|burrow|dubnation|lakernation|chiefskingdom|billsmafia)$/i,
    ],
    examples: ["jokic", "embiid", "wembanyama", "mahomes"],
  },
  "streetwear-culture": {
    description: "Streetwear brands, hype culture",
    patterns: [
      /^(bape|yeezy|vlone|fog|rhude|supreme|offwhite|stockx|goat|grailed|hypebeast|deadstock|sneakers)$/i,
    ],
    examples: ["bape", "yeezy", "vlone", "supreme"],
  },
  "compound-word": {
    description: "Compound words (two dictionary words joined)",
    patterns: [
      // Detected via length + recognizable sub-patterns
      /^[a-z]{4,}[a-z]{4,}$/i, // Will be filtered further by isCompoundWord()
    ],
    examples: ["dragonmaster", "strangerthings", "leagueoflegends"],
  },
};

// =============================================================================
// Types
// =============================================================================

interface StructuredPassword {
  original: string;
  root: string;
  suffix: string;
  prefix: string;
  isStructured: boolean;
  entropy: number;
}

interface CohortMatch {
  root: string;
  cohort: string;
  count: number;
  examples: string[]; // passwords containing this root
}

interface AnalysisResult {
  totalPasswords: number;
  uniquePasswords: number;
  structuredCount: number;
  randomCount: number;
  roots: Map<string, { count: number; examples: string[] }>;
  newRoots: Map<string, { count: number; examples: string[]; cohorts: string[] }>;
  cohortMatches: Map<string, CohortMatch[]>;
  suffixes: Map<string, number>;
  patterns: Map<string, number>;
  lengthDistribution: Map<number, number>;
}

// =============================================================================
// Entropy & Structure Detection
// =============================================================================

/**
 * Calculate Shannon entropy per character.
 * Random strings: ~4.0-5.0 bits/char
 * Structured passwords: ~2.0-3.5 bits/char
 */
function entropyPerChar(password: string): number {
  if (password.length === 0) return 0;
  const freq = new Map<string, number>();
  for (const c of password) {
    freq.set(c, (freq.get(c) || 0) + 1);
  }
  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / password.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * Determine if a password has structure (word-based) vs random.
 * Structured: "minecraft1234", "Abdullah@456", "nastya2023"
 * Random: "!0tUA6", "c3bf", "7eknr2rq"
 */
function classifyPassword(password: string): StructuredPassword {
  const entropy = entropyPerChar(password);

  // Extract potential root by removing suffix digits/specials and prefix digits
  let prefix = "";
  let suffix = "";
  let root = password;

  // Strip leading digits
  const prefixMatch = root.match(/^(\d+)(.*)/);
  if (prefixMatch) {
    prefix = prefixMatch[1];
    root = prefixMatch[2];
  }

  // Strip trailing digits
  const digitSuffix = root.match(/^(.*?)(\d+)$/);
  if (digitSuffix) {
    root = digitSuffix[1];
    suffix = digitSuffix[2];
  }

  // Strip trailing specials
  const specialSuffix = root.match(/^(.*?)([!@#$%^&*()_\-+=.]+)$/);
  if (specialSuffix) {
    root = specialSuffix[1];
    suffix = specialSuffix[2] + suffix;
  }

  root = root.toLowerCase();

  // Structured password criteria:
  // 1. Root is at least 3 chars of ONLY letters
  // 2. Root itself must look word-like (low entropy, consonant-vowel patterns)
  // 3. Short random roots (3-4 char) with high entropy are NOT structured
  const hasLetterRoot = root.length >= MIN_ROOT_LENGTH && /^[a-z]+$/i.test(root);
  const isLowEntropy = entropy < ENTROPY_THRESHOLD;
  const hasSuffix = suffix.length > 0 || prefix.length > 0;

  // Check if root looks like a real word (has vowels, not all consonants)
  const hasVowels = /[aeiouy]/i.test(root);
  const vowelRatio = (root.match(/[aeiouy]/gi) || []).length / root.length;

  // Root entropy — "minecraft" has low root entropy, "xfr" has high
  const rootEntropy = entropyPerChar(root);

  // A password is structured if:
  // - Has a letter root with vowels (real words have vowels)
  // - Root is either long enough (5+) to be a word, OR has low root entropy
  // - Short roots (3-4 chars) must have good vowel ratio to avoid "xfr", "eii", "cdf"
  const isLongRoot = root.length >= 5;
  const isShortButWordLike = root.length >= 3 && root.length <= 4 && vowelRatio >= 0.25 && rootEntropy < 2.5;
  const isStructured = hasLetterRoot && hasVowels && (isLongRoot || isShortButWordLike);

  return { original: password, root, suffix, prefix, isStructured, entropy };
}

// =============================================================================
// Baseline Loading
// =============================================================================

/**
 * Load baseline as a Set of lowercased words for O(1) lookup.
 * We store the RAW words (not extracted roots) because we want to check
 * if the root word itself exists as a password/word in the baseline.
 */
async function loadBaseline(): Promise<Set<string>> {
  const words = new Set<string>();

  const baselinePath = existsSync(NOCAP_PATH) ? NOCAP_PATH : ROCKYOU_PATH;
  if (!existsSync(baselinePath)) {
    console.warn("No baseline wordlist found");
    return words;
  }

  console.log(`Loading baseline from: ${baselinePath}`);

  const rl = createInterface({
    input: createReadStream(baselinePath),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (line.length >= MIN_ROOT_LENGTH) {
      words.add(line.toLowerCase().trim());
    }
  }

  console.log(`  Loaded ${words.size.toLocaleString()} baseline words`);
  return words;
}

// =============================================================================
// Cohort Classification
// =============================================================================

/**
 * Classify a root word into cohort(s) based on pattern matching.
 */
function classifyCohort(root: string): string[] {
  const matches: string[] = [];
  for (const [name, cohort] of Object.entries(COHORT_PATTERNS)) {
    if (name === "compound-word") continue; // handled separately
    for (const pattern of cohort.patterns) {
      if (pattern.test(root)) {
        matches.push(name);
        break;
      }
    }
  }
  return matches;
}

// =============================================================================
// Analysis Engine
// =============================================================================

/**
 * Analyze DIAMOND passwords — the core refactored logic.
 */
async function analyzePasswords(inputPath: string): Promise<AnalysisResult> {
  const result: AnalysisResult = {
    totalPasswords: 0,
    uniquePasswords: 0,
    structuredCount: 0,
    randomCount: 0,
    roots: new Map(),
    newRoots: new Map(),
    cohortMatches: new Map(),
    suffixes: new Map(),
    patterns: new Map(),
    lengthDistribution: new Map(),
  };

  const seen = new Set<string>();

  const rl = createInterface({
    input: createReadStream(inputPath),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    result.totalPasswords++;

    // Handle HASH:PASSWORD format
    const password = line.includes(":") ? line.split(":").slice(1).join(":") : line;
    if (!password || password.startsWith("$HEX[")) continue;

    // Dedup
    if (seen.has(password)) continue;
    seen.add(password);
    result.uniquePasswords++;

    // Length distribution
    result.lengthDistribution.set(password.length, (result.lengthDistribution.get(password.length) || 0) + 1);

    // Classify: structured vs random
    const classified = classifyPassword(password);

    if (classified.isStructured) {
      result.structuredCount++;

      // Track root
      const existing = result.roots.get(classified.root);
      if (existing) {
        existing.count++;
        if (existing.examples.length < 5) existing.examples.push(password);
      } else {
        result.roots.set(classified.root, { count: 1, examples: [password] });
      }

      // Track suffix patterns
      if (classified.suffix) {
        result.suffixes.set(classified.suffix, (result.suffixes.get(classified.suffix) || 0) + 1);
      }
    } else {
      result.randomCount++;
    }

    // Detect transformation patterns (on all passwords)
    if (/^[A-Z][a-z]/.test(password)) result.patterns.set("capitalize", (result.patterns.get("capitalize") || 0) + 1);
    if (/\d+$/.test(password)) {
      const dLen = password.match(/(\d+)$/)![1].length;
      result.patterns.set(`suffix:d${dLen}`, (result.patterns.get(`suffix:d${dLen}`) || 0) + 1);
    }
    if (/[!@#$%^&*()]/.test(password)) result.patterns.set("has-special", (result.patterns.get("has-special") || 0) + 1);
    const yearMatch = password.match(/(20[12]\d)$/);
    if (yearMatch) result.patterns.set(`suffix:year:${yearMatch[1]}`, (result.patterns.get(`suffix:year:${yearMatch[1]}`) || 0) + 1);
  }

  return result;
}

/**
 * Find roots that are NOT in the baseline wordlist.
 * These are the genuinely new discoveries.
 */
function findNewRoots(
  roots: Map<string, { count: number; examples: string[] }>,
  baseline: Set<string>
): Map<string, { count: number; examples: string[]; cohorts: string[] }> {
  const newRoots = new Map<string, { count: number; examples: string[]; cohorts: string[] }>();

  for (const [root, data] of roots) {
    // Skip if root exists as a word in baseline
    if (baseline.has(root)) continue;

    // Also skip very short roots that are likely noise
    if (root.length < 3) continue;

    // Skip if it looks like a keyboard pattern or common fragment
    if (/^(qwer|asdf|zxcv|abcd|pass|word|test|admin|user|login|1234)/.test(root)) continue;

    // Classify into cohorts
    const cohorts = classifyCohort(root);

    newRoots.set(root, { ...data, cohorts });
  }

  return newRoots;
}

/**
 * Group new roots by cohort for actionable reporting.
 */
function buildCohortReport(
  newRoots: Map<string, { count: number; examples: string[]; cohorts: string[] }>
): Map<string, CohortMatch[]> {
  const report = new Map<string, CohortMatch[]>();

  // Initialize all cohorts
  for (const name of Object.keys(COHORT_PATTERNS)) {
    report.set(name, []);
  }
  report.set("unclassified", []);

  for (const [root, data] of newRoots) {
    if (data.cohorts.length === 0) {
      // Unclassified — still valuable, just not matched to a known cohort
      report.get("unclassified")!.push({
        root,
        cohort: "unclassified",
        count: data.count,
        examples: data.examples,
      });
    } else {
      for (const cohort of data.cohorts) {
        report.get(cohort)!.push({
          root,
          cohort,
          count: data.count,
          examples: data.examples,
        });
      }
    }
  }

  return report;
}

// =============================================================================
// Output Generation
// =============================================================================

/**
 * Generate BETA.txt — ACTIONABLE new root words for password cracking.
 *
 * CRITICAL DESIGN DECISION: BETA.txt must be HIGH-SIGNAL, not exhaustive.
 * A 50K-entry BETA.txt full of noise is WORSE than a 200-entry BETA.txt
 * of real words, because hashcat will waste GPU time on garbage.
 *
 * Inclusion criteria:
 * 1. Cohort-matched roots — ALWAYS included (these are real names/words)
 * 2. Unclassified roots — ONLY if freq >= 3 AND length >= 5
 *    (high frequency across different passwords = likely real word, not noise)
 * 3. Cohort wordlists — the bulk of BETA.txt comes from GENERATED cohort
 *    wordlists (Turkish names, Indian names, etc.), NOT from diamond extraction
 */
function generateBeta(
  newRoots: Map<string, { count: number; examples: string[]; cohorts: string[] }>,
  outputPath: string
): number {
  const betaRoots: string[] = [];

  for (const [root, data] of newRoots) {
    if (data.cohorts.length > 0) {
      // Cohort-matched: always include
      betaRoots.push(root);
    } else if (data.count >= 3 && root.length >= 5) {
      // Unclassified but high-frequency + long enough to be a real word
      betaRoots.push(root);
    }
    // Skip: low-frequency unclassified short roots (noise)
  }

  // Sort: cohort-matched first, then by length (longer = more likely real)
  betaRoots.sort((a, b) => {
    const aData = newRoots.get(a)!;
    const bData = newRoots.get(b)!;
    const aHasCohort = aData.cohorts.length > 0 ? 1 : 0;
    const bHasCohort = bData.cohorts.length > 0 ? 1 : 0;
    if (bHasCohort !== aHasCohort) return bHasCohort - aHasCohort;
    return bData.count - aData.count;
  });

  writeFileSync(outputPath, betaRoots.join("\n") + "\n");
  return betaRoots.length;
}

/**
 * Generate UNOBTAINIUM.rule — suffix/transformation rules from DIAMONDS.
 */
function generateUnobtainium(
  suffixes: Map<string, number>,
  patterns: Map<string, number>,
  outputPath: string
): number {
  const rules = new Set<string>();

  // Generate append rules from top suffixes
  const sortedSuffixes = Array.from(suffixes.entries())
    .filter(([_, count]) => count >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 100);

  for (const [suffix] of sortedSuffixes) {
    const rule = suffix.split("").map(c => `$${c}`).join(" ");
    rules.add(rule);
  }

  // Year suffix rules (2015-2026)
  for (let year = 2015; year <= 2026; year++) {
    rules.add(`$${String(year)[0]} $${String(year)[1]} $${String(year)[2]} $${String(year)[3]}`);
  }

  // Common transformation combos from patterns
  if ((patterns.get("capitalize") || 0) > 10) {
    rules.add("c");
    rules.add("c $1");
    rules.add("c $1 $2 $3");
  }

  const ruleArray = Array.from(rules);

  const header = [
    "# UNOBTAINIUM.rule - Auto-generated from DIAMOND analysis",
    "# PURPOSE: Suffix/transformation rules discovered from cracked passwords.",
    `# Generated: ${new Date().toISOString()}`,
    `# Rules: ${ruleArray.length}`,
    "",
  ];

  writeFileSync(outputPath, header.join("\n") + ruleArray.join("\n") + "\n");
  return ruleArray.length;
}

/**
 * Generate cohort analysis report (Markdown).
 */
function generateCohortReport(
  result: AnalysisResult,
  cohortReport: Map<string, CohortMatch[]>,
  outputPath: string
): void {
  const lines: string[] = [
    `# DIAMOND Analysis Report — Cohort Discovery`,
    ``,
    `**Generated:** ${new Date().toISOString()}`,
    `**Input:** ${result.totalPasswords.toLocaleString()} passwords, ${result.uniquePasswords.toLocaleString()} unique`,
    ``,
    `## Password Classification`,
    ``,
    `| Category | Count | % |`,
    `|----------|-------|---|`,
    `| Structured (word-based) | ${result.structuredCount.toLocaleString()} | ${((result.structuredCount / result.uniquePasswords) * 100).toFixed(1)}% |`,
    `| Random/brute-force | ${result.randomCount.toLocaleString()} | ${((result.randomCount / result.uniquePasswords) * 100).toFixed(1)}% |`,
    `| **Unique roots extracted** | **${result.roots.size.toLocaleString()}** | |`,
    `| **New roots (not in baseline)** | **${result.newRoots.size.toLocaleString()}** | |`,
    ``,
    `## Cohort Discovery`,
    ``,
    `New roots NOT in nocap.txt, classified by category:`,
    ``,
  ];

  // Separate actionable cohorts from unclassified noise
  const actionableCohorts = Array.from(cohortReport.entries())
    .filter(([name, matches]) => name !== "unclassified" && matches.length > 0)
    .sort((a, b) => b[1].length - a[1].length);

  const unclassified = cohortReport.get("unclassified") || [];

  // Show actionable cohorts first
  for (const [cohort, matches] of actionableCohorts) {
    const desc = COHORT_PATTERNS[cohort]?.description || cohort;
    lines.push(`### ${cohort} — ${desc} (${matches.length} new roots)`);
    lines.push(``);

    const sorted = matches.sort((a, b) => b.count - a.count);
    for (const match of sorted.slice(0, 30)) {
      const exStr = match.examples.slice(0, 3).join(", ");
      lines.push(`- **${match.root}** (${match.count}x) — e.g. ${exStr}`);
    }
    if (sorted.length > 30) {
      lines.push(`- ... and ${sorted.length - 30} more`);
    }
    lines.push(``);
  }

  // Show unclassified separately — these are NOT in BETA.txt unless freq >= 3 AND len >= 5
  if (unclassified.length > 0) {
    const highConf = unclassified.filter(m => m.count >= 3 && m.root.length >= 5);
    const noise = unclassified.length - highConf.length;

    lines.push(`### Unclassified (${unclassified.length} total, ${highConf.length} in BETA.txt, ${noise} filtered as noise)`);
    lines.push(``);
    lines.push(`Only unclassified roots with **frequency >= 3** and **length >= 5** are included in BETA.txt.`);
    lines.push(``);

    if (highConf.length > 0) {
      lines.push(`**High-confidence unclassified (included in BETA.txt):**`);
      const sorted = highConf.sort((a, b) => b.count - a.count);
      for (const match of sorted.slice(0, 20)) {
        const exStr = match.examples.slice(0, 3).join(", ");
        lines.push(`- **${match.root}** (${match.count}x) — e.g. ${exStr}`);
      }
      if (sorted.length > 20) {
        lines.push(`- ... and ${sorted.length - 20} more`);
      }
    }
    lines.push(``);
  }

  // Use actionableCohorts for the rest of the report
  const sortedCohorts = actionableCohorts;

  // Top suffix patterns
  lines.push(`## Top Suffix Patterns`);
  lines.push(``);
  lines.push(`| Suffix | Count |`);
  lines.push(`|--------|-------|`);
  const topSuffixes = Array.from(result.suffixes.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20);
  for (const [suffix, count] of topSuffixes) {
    lines.push(`| \`${suffix}\` | ${count.toLocaleString()} |`);
  }
  lines.push(``);

  // Actionable recommendations
  lines.push(`## Actionable Recommendations`);
  lines.push(``);
  for (const [cohort, matches] of sortedCohorts) {
    if (cohort === "unclassified" || matches.length < 2) continue;
    const desc = COHORT_PATTERNS[cohort]?.description || cohort;
    lines.push(`- **${cohort}**: Found ${matches.length} roots. Build a ${desc} wordlist (estimated 500-5000 entries).`);
  }
  lines.push(``);

  writeFileSync(outputPath, lines.join("\n"));
}

// =============================================================================
// CLI
// =============================================================================

function printHelp(): void {
  console.log(`
DiamondAnalyzer v2.0 - Cohort-Based Password Analysis

REFACTORED: Separates structured passwords from random brute-force noise,
classifies new roots by cultural/linguistic cohort, produces actionable output.

Usage:
  bun DiamondAnalyzer.ts --analyze <file>   Analyze and show summary
  bun DiamondAnalyzer.ts --beta <file>      Generate BETA.txt (new roots)
  bun DiamondAnalyzer.ts --rules <file>     Generate UNOBTAINIUM.rule
  bun DiamondAnalyzer.ts --full <file>      Full analysis + all outputs

Input Format:
  Plain passwords (one per line) or HASH:PASSWORD format

Output Files:
  data/processed/BETA.txt              New root words (structured, not in baseline)
  data/processed/UNOBTAINIUM.rule      Suffix/transformation rules
  data/processed/cohort-report.md      Cohort analysis with recommendations
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

  // Ensure output directory
  if (!existsSync(OUTPUT_DIR)) {
    mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`DiamondAnalyzer v2.0 — Cohort-Based Analysis`);
  console.log(`${"=".repeat(60)}\n`);
  console.log(`Input: ${inputFile}\n`);

  // Step 1: Analyze passwords
  console.log("Step 1: Classifying passwords (structured vs random)...");
  const result = await analyzePasswords(inputFile);

  console.log(`  Total: ${result.totalPasswords.toLocaleString()}`);
  console.log(`  Unique: ${result.uniquePasswords.toLocaleString()}`);
  console.log(`  Structured: ${result.structuredCount.toLocaleString()} (${((result.structuredCount / result.uniquePasswords) * 100).toFixed(1)}%)`);
  console.log(`  Random: ${result.randomCount.toLocaleString()} (${((result.randomCount / result.uniquePasswords) * 100).toFixed(1)}%)`);
  console.log(`  Unique roots: ${result.roots.size.toLocaleString()}`);

  // Step 2: Load baseline and find new roots
  console.log("\nStep 2: Comparing roots against baseline...");
  const baseline = await loadBaseline();
  result.newRoots = findNewRoots(result.roots, baseline);
  console.log(`  New roots (not in baseline): ${result.newRoots.size.toLocaleString()}`);

  // Step 3: Classify into cohorts
  console.log("\nStep 3: Classifying new roots into cohorts...");
  const cohortReport = buildCohortReport(result.newRoots);
  result.cohortMatches = cohortReport;

  for (const [cohort, matches] of cohortReport) {
    if (matches.length > 0) {
      const desc = COHORT_PATTERNS[cohort]?.description || "Unclassified";
      const topRoots = matches.slice(0, 5).map(m => m.root).join(", ");
      console.log(`  ${cohort} (${matches.length}): ${topRoots}`);
    }
  }

  // Show top roots by frequency
  console.log("\nTop 20 new roots by frequency:");
  const topNew = Array.from(result.newRoots.entries())
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 20);
  for (const [root, data] of topNew) {
    const cohortStr = data.cohorts.length > 0 ? ` [${data.cohorts.join(", ")}]` : "";
    console.log(`  ${root} (${data.count}x)${cohortStr} — ${data.examples.slice(0, 2).join(", ")}`);
  }

  // Step 4: Generate outputs
  if (betaIdx !== -1 || fullIdx !== -1) {
    console.log("\nStep 4a: Generating BETA.txt...");
    const betaPath = resolve(OUTPUT_DIR, "BETA.txt");
    const betaCount = generateBeta(result.newRoots, betaPath);
    console.log(`  Generated: ${betaCount} new root words`);
    console.log(`  Saved to: ${betaPath}`);
  }

  if (rulesIdx !== -1 || fullIdx !== -1) {
    console.log("\nStep 4b: Generating UNOBTAINIUM.rule...");
    const rulePath = resolve(OUTPUT_DIR, "UNOBTAINIUM.rule");
    const ruleCount = generateUnobtainium(result.suffixes, result.patterns, rulePath);
    console.log(`  Generated: ${ruleCount} rules`);
    console.log(`  Saved to: ${rulePath}`);
  }

  if (fullIdx !== -1) {
    console.log("\nStep 4c: Generating cohort report...");
    const reportPath = resolve(OUTPUT_DIR, "cohort-report.md");
    generateCohortReport(result, cohortReport, reportPath);
    console.log(`  Saved to: ${reportPath}`);
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log("Analysis complete.");
  console.log(`${"=".repeat(60)}\n`);
}

main().catch(console.error);
