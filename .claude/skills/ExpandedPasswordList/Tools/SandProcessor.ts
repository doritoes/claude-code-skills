#!/usr/bin/env bun
/**
 * SandProcessor.ts - SAND Batch Processing Orchestrator
 *
 * Transforms SAND (hard hashes from Stage 1) into DIAMONDS (cracked) and GLASS
 * (uncrackable) using escalating attack phases with intelligent hashlist reuse.
 *
 * Key features:
 * - Hashlist reuse: Create ONE hashlist per batch, run MULTIPLE attacks
 * - Intelligent parallelization: maxAgents=1 for rules, 0 for brute force
 * - State tracking: Resume from where we left off
 * - Strategy evolution: Learn from crack rates, reorder attacks
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { execSync } from "node:child_process";
import { SandStateManager, DEFAULT_ATTACK_ORDER } from "./SandStateManager";
import { DATA_DIR, SAND_DIR, DIAMONDS_DIR, GLASS_DIR, HASH_TYPE_SHA1 } from "./config";

// =============================================================================
// Configuration
// =============================================================================

const CURRENT_FILE = fileURLToPath(import.meta.url);
const SKILL_DIR = dirname(dirname(CURRENT_FILE));
const HASHCRACK_DIR = resolve(SKILL_DIR, "..", "Hashcrack", "tools");

// =============================================================================
// Attack Presets
// =============================================================================

interface AttackPreset {
  name: string;
  phase: string;
  attackCmd: string;
  fileIds: number[];
  maxAgents: number;  // 0 = unlimited, 1 = single agent (for rules)
  isSmall: number;    // 1 = small job (quick completion)
  priority: number;
  expectedRate: number;
  description: string;
}

/**
 * Attack presets organized by phase.
 * File IDs reference files uploaded to Hashtopolis.
 *
 * IMPORTANT: SAND = hashes that SURVIVED rockyou.txt + nocap.rule (OneRule+bussin)
 * DO NOT repeat attacks that are subsets of what was already tried!
 *
 * Strategy:
 * 1. NEW WORDLISTS - rizzyou.txt has GenZ terms NOT in rockyou
 * 2. HYBRID ATTACKS - append patterns not covered by rules (-a 6)
 * 3. COMBINATOR - word+word combinations (-a 1)
 * 4. MASK - pure pattern-based attacks (-a 3)
 * 5. BRUTE FORCE - exhaustive short passwords
 *
 * NOTE: Adjust fileIds based on your Hashtopolis file configuration!
 * Query with: SELECT fileId, filename FROM File;
 */
const ATTACK_PRESETS: Record<string, AttackPreset> = {
  // ==========================================================================
  // Phase 1: NEW WORDLISTS (highest value - completely new root words!)
  // SAND survived rockyou, so try words NOT in rockyou
  // ==========================================================================
  "newwords-rizzyou-nocaprule": {
    name: "newwords-rizzyou-nocaprule",
    phase: "new-wordlists",
    attackCmd: "#HL# rizzyou.txt -r nocap.rule",
    fileIds: [4, 10],  // rizzyou.txt=4, nocap.rule=10 (replaces OneRule)
    maxAgents: 1,  // Rule attack requires maxAgents=1
    isSmall: 0,
    priority: 100,
    expectedRate: 0.02,
    description: "GenZ words + nocap.rule (replaces OneRule — OneRule+bussin combined)",
  },
  "newwords-rizzyou-nocap": {
    name: "newwords-rizzyou-nocap",
    phase: "new-wordlists",
    attackCmd: "#HL# rizzyou.txt -r nocap.rule",
    fileIds: [4, 10],  // rizzyou.txt=4, nocap.rule=10 (OneRuleToRuleThemStill + bussin combined)
    maxAgents: 1,  // Rule attack requires maxAgents=1
    isSmall: 0,
    priority: 98,
    expectedRate: 0.03,
    description: "GenZ words + nocap.rule (Still+bussin combined, modern years)",
  },
  "newwords-nocap-genz": {
    name: "newwords-nocap-genz",
    phase: "new-wordlists",
    attackCmd: "#HL# nocap-plus.txt -r nocap.rule",
    fileIds: [11, 10],  // nocap-plus.txt=11 (superset of nocap.txt), nocap.rule=10
    maxAgents: 1,
    isSmall: 0,
    priority: 95,
    expectedRate: 0.015,
    description: "Combined wordlist + GenZ patterns (2015-2025 years)",
  },
  // Added 2026-02-09: batch-0005 strategy - test new assets against SAND
  "newwords-nocap-nocaprule": {
    name: "newwords-nocap-nocaprule",
    phase: "new-wordlists",
    attackCmd: "#HL# nocap-plus.txt -r nocap.rule",
    fileIds: [11, 10],  // nocap-plus.txt=11 (superset of nocap.txt), nocap.rule=10
    maxAgents: 1,
    isSmall: 0,
    priority: 93,
    expectedRate: 0.015,
    description: "Combined wordlist + modern rules (OneRule+bussin, modern years)",
  },
  "newwords-nocap-unobtainium": {
    name: "newwords-nocap-unobtainium",
    phase: "new-wordlists",
    attackCmd: "#HL# nocap-plus.txt -r UNOBTAINUM.rule",
    fileIds: [11, 8],  // nocap-plus.txt=11 (superset of nocap.txt), UNOBTAINUM.rule=8
    maxAgents: 1,
    isSmall: 0,
    priority: 91,
    expectedRate: 0.005,
    description: "Combined wordlist + DIAMOND-learned rules (cross-pollination test)",
  },

  // ==========================================================================
  // Phase 1b: NOCAP-PLUS ATTACKS (nocap.txt + cohort roots + BETA roots)
  // nocap-plus.txt = working copy with 3,509 new roots from cohort analysis
  // IMPORTANT: Upload nocap-plus.txt to Hashtopolis BEFORE running batch-0005
  //            then update NOCAP_PLUS_FILE_ID below with the assigned file ID
  // ==========================================================================
  "nocapplus-nocaprule": {
    name: "nocapplus-nocaprule",
    phase: "new-wordlists",
    attackCmd: "#HL# nocap-plus.txt -r nocap.rule",
    fileIds: [11, 10],  // nocap-plus.txt=11, nocap.rule=10
    maxAgents: 1,
    isSmall: 0,
    priority: 105,  // Higher than base nocap — new roots are the differentiator
    expectedRate: 0.02,
    description: "nocap + 3.5K cohort roots + nocap.rule (PRIMARY batch-0005+ attack)",
  },
  "nocapplus-unobtainium": {
    name: "nocapplus-unobtainium",
    phase: "new-wordlists",
    attackCmd: "#HL# nocap-plus.txt -r UNOBTAINUM.rule",
    fileIds: [11, 8],  // nocap-plus.txt=11, UNOBTAINUM.rule=8
    maxAgents: 1,
    isSmall: 0,
    priority: 90,
    expectedRate: 0.005,
    description: "nocap + cohort roots + DIAMOND rules (feedback cross-pollination)",
  },
  "hybrid-nocapplus-4digit": {
    name: "hybrid-nocapplus-4digit",
    phase: "hybrid",
    attackCmd: "#HL# -a 6 nocap-plus.txt ?d?d?d?d",
    fileIds: [11],  // nocap-plus.txt=11
    maxAgents: 0,
    isSmall: 0,
    priority: 82,  // Slightly higher than rockyou hybrid (new roots)
    expectedRate: 0.02,
    description: "nocap + cohort roots + 4 digit suffix (oguz1234, kohli2024)",
  },

  // ==========================================================================
  // Phase 3: HYBRID ATTACKS (after brute force seeds feedback loop)
  // Rules transform words, hybrids APPEND patterns
  // ==========================================================================
  "hybrid-rockyou-4digit": {
    name: "hybrid-rockyou-4digit",
    phase: "hybrid",
    attackCmd: "#HL# -a 6 rockyou.txt ?d?d?d?d",
    fileIds: [1],  // rockyou.txt only
    maxAgents: 0,  // Hybrid can use multiple agents
    isSmall: 0,
    priority: 80,
    expectedRate: 0.03,
    description: "rockyou + 4 digit suffix (password1234)",
  },
  "hybrid-rockyou-year": {
    name: "hybrid-rockyou-year",
    phase: "hybrid",
    attackCmd: "#HL# -a 6 rockyou.txt 20?d?d",
    fileIds: [1],
    maxAgents: 0,
    isSmall: 0,
    priority: 78,
    expectedRate: 0.02,
    description: "rockyou + year suffix (password2024)",
  },
  "hybrid-rizzyou-4digit": {
    name: "hybrid-rizzyou-4digit",
    phase: "hybrid",
    attackCmd: "#HL# -a 6 rizzyou.txt ?d?d?d?d",
    fileIds: [4],  // rizzyou.txt=4
    maxAgents: 0,
    isSmall: 1,  // Small wordlist = quick job
    priority: 75,
    expectedRate: 0.01,
    description: "GenZ words + 4 digit suffix (minecraft1234)",
  },
  "hybrid-rockyou-special-digits": {
    name: "hybrid-rockyou-special-digits",
    phase: "hybrid",
    attackCmd: "#HL# -a 6 rockyou.txt ?s?d?d?d",
    fileIds: [1],
    maxAgents: 0,
    isSmall: 0,
    priority: 72,
    expectedRate: 0.015,
    description: "rockyou + special + 3 digits (password!123)",
  },
  "hybrid-nocapplus-3digit": {
    name: "hybrid-nocapplus-3digit",
    phase: "hybrid",
    attackCmd: "#HL# -a 6 nocap-plus.txt ?d?d?d",
    fileIds: [11],  // nocap-plus.txt=11
    maxAgents: 0,
    isSmall: 0,
    priority: 70,
    expectedRate: 0.01,
    description: "nocap-plus + 3 digit suffix (password123)",
  },

  // ==========================================================================
  // Phase 4: COMBINATOR (word+word combinations - mode -a 1)
  // Creates compound passwords like "loveforever", "happyday"
  // ==========================================================================
  // NOTE: Disabled - files not uploaded to Hashtopolis
  // "combo-common-numbers": {
  //   name: "combo-common-numbers",
  //   phase: "combinator",
  //   attackCmd: "#HL# -a 1 common-words.txt numbers-1000.txt",
  //   fileIds: [10, 11],  // common-words.txt, numbers-1000.txt
  //   maxAgents: 0,
  //   isSmall: 1,
  //   priority: 65,
  //   expectedRate: 0.008,
  //   description: "Common words + numbers (love123, happy2024)",
  // },

  // ==========================================================================
  // Phase 5: MASK ATTACKS (common patterns, large keyspace)
  // Run last - less guaranteed, more speculative
  // ==========================================================================
  "mask-Ullllldd": {
    name: "mask-Ullllldd",
    phase: "mask",
    attackCmd: "#HL# -a 3 ?u?l?l?l?l?l?d?d",
    fileIds: [],
    maxAgents: 0,
    isSmall: 0,
    priority: 50,
    expectedRate: 0.01,
    description: "Uppercase + 5 lower + 2 digits (Summer23)",
  },
  "mask-lllllldd": {
    name: "mask-lllllldd",
    phase: "mask",
    attackCmd: "#HL# -a 3 ?l?l?l?l?l?l?d?d",
    fileIds: [],
    maxAgents: 0,
    isSmall: 0,
    priority: 48,
    expectedRate: 0.015,
    description: "6 lowercase + 2 digits (summer23)",
  },
  "mask-Ullllllld": {
    name: "mask-Ullllllld",
    phase: "mask",
    attackCmd: "#HL# -a 3 ?u?l?l?l?l?l?l?l?d",
    fileIds: [],
    maxAgents: 0,
    isSmall: 0,
    priority: 55,
    expectedRate: 0.008,
    description: "Uppercase + 7 lower + 1 digit (Password1)",
  },
  "mask-dddddddd": {
    name: "mask-dddddddd",
    phase: "mask",
    attackCmd: "#HL# -a 3 ?d?d?d?d?d?d?d?d",
    fileIds: [],
    maxAgents: 0,
    isSmall: 1,  // Only 10^8 = 100M combinations
    priority: 52,
    expectedRate: 0.005,
    description: "8 digits (phone numbers, dates)",
  },
  "mask-lllldddd": {
    name: "mask-lllldddd",
    phase: "mask",
    attackCmd: "#HL# -a 3 ?l?l?l?l?d?d?d?d",
    fileIds: [],
    maxAgents: 0,
    isSmall: 0,
    priority: 45,
    expectedRate: 0.008,
    description: "4 lowercase + 4 digits (love1234, test2024)",
  },

  // ==========================================================================
  // Phase 2: BRUTE FORCE (EARLY - guaranteed cracks seed feedback loop!)
  // Run early to get DIAMONDS for DiamondAnalyzer → UNOBTAINIUM.rule
  // ==========================================================================
  // NOTE: --increment mode does NOT work with Hashtopolis (agent gets stuck in clientError)
  // LESSON #55: Must use separate tasks for each password length
  // LESSON #55 UPDATE: Confirmed 2026-02-07 - separate tasks work, 163 passwords cracked
  "brute-1": {
    name: "brute-1",
    phase: "brute",
    attackCmd: "#HL# -a 3 ?a",
    fileIds: [],
    maxAgents: 0,
    isSmall: 1,
    priority: 99,  // HIGHEST - instant
    expectedRate: 0.0001,
    description: "Brute force 1 character (95 candidates)",
  },
  "brute-2": {
    name: "brute-2",
    phase: "brute",
    attackCmd: "#HL# -a 3 ?a?a",
    fileIds: [],
    maxAgents: 0,
    isSmall: 1,
    priority: 98,
    expectedRate: 0.0001,
    description: "Brute force 2 characters (9,025 candidates)",
  },
  "brute-3": {
    name: "brute-3",
    phase: "brute",
    attackCmd: "#HL# -a 3 ?a?a?a",
    fileIds: [],
    maxAgents: 0,
    isSmall: 1,
    priority: 97,
    expectedRate: 0.0001,
    description: "Brute force 3 characters (857,375 candidates)",
  },
  "brute-4": {
    name: "brute-4",
    phase: "brute",
    attackCmd: "#HL# -a 3 ?a?a?a?a",
    fileIds: [],
    maxAgents: 0,
    isSmall: 1,
    priority: 96,
    expectedRate: 0.0005,
    description: "Brute force 4 characters (81,450,625 candidates)",
  },
  "brute-5": {
    name: "brute-5",
    phase: "brute",
    attackCmd: "#HL# -a 3 ?a?a?a?a?a",
    fileIds: [],
    maxAgents: 0,
    isSmall: 1,  // Small job - quick completion
    priority: 92,  // HIGH - run early for feedback loop
    expectedRate: 0.005,
    description: "Brute force 5 characters",
  },
  "brute-6": {
    name: "brute-6",
    phase: "brute",
    attackCmd: "#HL# -a 3 ?a?a?a?a?a?a",
    fileIds: [],
    maxAgents: 0,
    isSmall: 0,
    priority: 89,  // HIGH - guaranteed patterns
    expectedRate: 0.003,
    description: "Brute force 6 characters",
  },
  "brute-7": {
    name: "brute-7",
    phase: "brute",
    attackCmd: "#HL# -a 3 ?a?a?a?a?a?a?a",
    fileIds: [],
    maxAgents: 0,
    isSmall: 0,
    priority: 86,  // Run before hybrid/mask
    expectedRate: 0.002,
    description: "Brute force 7 characters",
  },
  // NOTE: brute-8 intentionally excluded - ~51 hours is too expensive for standard pipeline
  // Use QuickAttack.ts for one-off brute-8 experiments when analyzing patterns

  // ==========================================================================
  // FEEDBACK LOOP: Test rules/words learned from DIAMONDS
  //
  // PURPOSE: Validate effectiveness of feedback-generated assets
  //
  // UNOBTAINIUM.rule contains ONLY rules NOT already in:
  //   - OneRuleToRuleThemStill.rule
  //   - nocap.rule
  //
  // If unobtainium cracks are ZERO, the feedback is working correctly
  // (all effective rules are already in the baseline files).
  // If unobtainium cracks are >0, we've found genuinely new patterns!
  //
  // Run these attacks EVERY batch to measure feedback effectiveness.
  // ==========================================================================
  "test-unobtainium": {
    name: "test-unobtainium",
    phase: "feedback",
    attackCmd: "#HL# rockyou.txt -r UNOBTAINUM.rule",
    fileIds: [1, 8],  // rockyou.txt=1, UNOBTAINUM.rule=8 (already on server)
    maxAgents: 1,
    isSmall: 0,
    priority: 45,  // Lower priority - run AFTER main attacks for comparison
    expectedRate: 0.001,  // Expected low (most patterns already covered)
    description: "TEST: rockyou + NEW rules not in OneRule/nocap (measures feedback effectiveness)",
  },
  "feedback-beta-nocaprule": {
    name: "feedback-beta-nocaprule",
    phase: "feedback",
    attackCmd: "#HL# BETA.txt -r nocap.rule",
    fileIds: [12, 10],  // BETA.txt=12, nocap.rule=10 (replaces OneRule)
    maxAgents: 1,
    isSmall: 1,  // BETA is small list of new roots
    priority: 110,  // Higher than NEW-WORDLISTS when available
    expectedRate: 0.01,
    description: "TEST: New root words from DIAMONDS + nocap.rule (replaces OneRule)",
  },
  "feedback-nocapplus-unobtainium": {
    name: "feedback-nocapplus-unobtainium",
    phase: "feedback",
    attackCmd: "#HL# nocap-plus.txt -r UNOBTAINUM.rule",
    fileIds: [11, 8],  // nocap-plus.txt=11, UNOBTAINUM.rule=8
    maxAgents: 1,
    isSmall: 0,
    priority: 108,
    expectedRate: 0.01,
    description: "TEST: nocap+cohorts + rules learned from DIAMONDS (full feedback cross)",
  },
  "feedback-beta-unobtainium": {
    name: "feedback-beta-unobtainium",
    phase: "feedback",
    attackCmd: "#HL# BETA.txt -r UNOBTAINUM.rule",
    fileIds: [12, 8],  // BETA.txt=12, UNOBTAINUM.rule=8
    maxAgents: 1,
    isSmall: 1,  // BETA is small list
    priority: 109,
    expectedRate: 0.005,
    description: "BETA.txt (9.9K roots) + DIAMOND-derived rules (feedback cross-pollination)",
  },
  "rizzyou-bussin": {
    name: "rizzyou-bussin",
    phase: "new-wordlists",
    attackCmd: "#HL# rizzyou.txt -r bussin.rule",
    fileIds: [4, 9],  // rizzyou.txt=4, bussin.rule=9
    maxAgents: 1,
    isSmall: 1,  // rizzyou is small, bussin.rule is small
    priority: 50,
    expectedRate: 0.005,
    description: "Modern GenZ wordlist + modern rule patterns (first bussin.rule test)",
  },
};

// =============================================================================
// Server Configuration
// =============================================================================

interface ServerConfig {
  serverIp: string;
  dbPassword: string;
  sshUser: string;
}

function getServerConfig(): ServerConfig {
  const terraformDir = resolve(HASHCRACK_DIR, "..", "terraform", "aws");

  try {
    const serverIp = execSync(`terraform output -raw server_ip`, { encoding: "utf-8", cwd: terraformDir }).trim();
    const dbPassword = execSync(`terraform output -raw db_password`, { encoding: "utf-8", cwd: terraformDir }).trim();
    return { serverIp, dbPassword, sshUser: "ubuntu" };
  } catch (e) {
    throw new Error("Cannot get server config from terraform. Ensure terraform is deployed.");
  }
}

function execSQL(config: ServerConfig, sql: string): string {
  const cleanSql = sql.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
  const b64Sql = Buffer.from(cleanSql).toString('base64');
  const cmd = `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 ${config.sshUser}@${config.serverIp} "echo ${b64Sql} | base64 -d | sudo docker exec -i hashtopolis-db mysql -u hashtopolis -p'${config.dbPassword}' hashtopolis -sN"`;

  try {
    // Use Git Bash on Windows to avoid PowerShell execution policy issues
    const shell = process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "/bin/bash";
    return execSync(cmd, { encoding: "utf-8", timeout: 30000, shell }).trim();
  } catch (e) {
    console.error("SQL error:", (e as Error).message);
    return "";
  }
}

// =============================================================================
// Hashtopolis Client
// =============================================================================

async function getHashtopolisClient() {
  const clientPath = resolve(HASHCRACK_DIR, "HashtopolisClient.ts");
  if (!existsSync(clientPath)) {
    throw new Error(`HashtopolisClient not found at ${clientPath}`);
  }
  const { HashtopolisClient } = await import(clientPath);
  return { HashtopolisClient };
}

// =============================================================================
// SAND Batch Loading
// =============================================================================

interface SandBatch {
  name: string;
  path: string;
  hashes: string[];
}

async function loadSandBatch(batchNumber: number): Promise<SandBatch | null> {
  const paddedNum = String(batchNumber).padStart(4, "0");
  const batchName = `batch-${paddedNum}`;

  // Try both compressed and uncompressed
  const gzPath = resolve(SAND_DIR, `${batchName}.txt.gz`);
  const txtPath = resolve(SAND_DIR, `${batchName}.txt`);

  let content: string;
  let path: string;

  if (existsSync(gzPath)) {
    const compressed = readFileSync(gzPath);
    content = gunzipSync(compressed).toString("utf-8");
    path = gzPath;
  } else if (existsSync(txtPath)) {
    content = readFileSync(txtPath, "utf-8");
    path = txtPath;
  } else {
    return null;
  }

  const hashes = content.trim().split("\n").filter((h) => h.length === 40);

  return { name: batchName, path, hashes };
}

function listSandBatches(): number[] {
  if (!existsSync(SAND_DIR)) {
    return [];
  }

  const files = readdirSync(SAND_DIR).filter(
    (f) => f.startsWith("batch-") && (f.endsWith(".txt") || f.endsWith(".txt.gz"))
  );

  const numbers: number[] = [];
  for (const file of files) {
    const match = file.match(/batch-(\d+)\.txt/);
    if (match) {
      numbers.push(parseInt(match[1]));
    }
  }

  return numbers.sort((a, b) => a - b);
}

// =============================================================================
// File Validation (GATE: Verify attack files exist before task creation)
// =============================================================================

interface FileInfo {
  fileId: number;
  filename: string;
  size: number;
  isSecret: number;
}

/**
 * GATE: Verify all required files exist in Hashtopolis File table
 * This MUST pass before creating tasks, otherwise workers get "Keyspace measure failed!"
 */
function validateFilesExist(config: ServerConfig, fileIds: number[]): { valid: boolean; missing: number[]; files: FileInfo[] } {
  if (fileIds.length === 0) {
    return { valid: true, missing: [], files: [] };
  }

  const sql = `SELECT fileId, filename, size, isSecret FROM File WHERE fileId IN (${fileIds.join(",")})`;
  const result = execSQL(config, sql);

  const found: FileInfo[] = [];
  if (result) {
    for (const line of result.split("\n")) {
      if (!line.trim()) continue;
      const [id, name, size, secret] = line.split("\t");
      found.push({
        fileId: parseInt(id),
        filename: name,
        size: parseInt(size) || 0,
        isSecret: parseInt(secret) || 0,
      });
    }
  }

  const foundIds = new Set(found.map(f => f.fileId));
  const missing = fileIds.filter(id => !foundIds.has(id));

  return {
    valid: missing.length === 0,
    missing,
    files: found,
  };
}

/**
 * GATE: Verify file downloads work (not returning ERR3)
 * ERR3 = "file not present" - means files exist in DB but not at expected path
 */
function validateFileDownloads(config: ServerConfig, fileIds: number[]): { valid: boolean; errors: string[] } {
  if (fileIds.length === 0) {
    return { valid: true, errors: [] };
  }

  // Get an agent token to test downloads
  const token = execSQL(config, "SELECT token FROM Agent WHERE isActive=1 LIMIT 1");
  if (!token) {
    return { valid: false, errors: ["No active agents to test file downloads"] };
  }

  const errors: string[] = [];
  for (const fileId of fileIds) {
    // Download first 100 bytes to check for ERR3
    const testCmd = `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 ${config.sshUser}@${config.serverIp} "curl -s 'http://localhost:8080/getFile.php?file=${fileId}&token=${token}' | head -c 100"`;
    try {
      // Use Git Bash on Windows to avoid PowerShell execution policy issues
      const shell = process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "/bin/bash";
      const content = execSync(testCmd, { encoding: "utf-8", timeout: 30000, shell }).trim();

      if (content.includes("ERR3")) {
        errors.push(`File ${fileId}: ERR3 (file not present at expected path)`);
      } else if (content.length < 10) {
        errors.push(`File ${fileId}: Empty or truncated response`);
      }
    } catch (e) {
      errors.push(`File ${fileId}: Download test failed`);
    }
  }

  return { valid: errors.length === 0, errors };
}

// =============================================================================
// Task Creation
// =============================================================================

async function createTaskViaDB(
  config: ServerConfig,
  params: {
    name: string;
    hashlistId: number;
    attackCmd: string;
    maxAgents: number;
    priority: number;
    fileIds: number[];
    isSmall: number;
  }
): Promise<{ wrapperId: number; taskId: number }> {
  const useNewBench = 0;  // ALWAYS use OLD format per Lesson #46

  // GATE: Verify all files exist before creating task
  if (params.fileIds.length > 0) {
    const fileCheck = validateFilesExist(config, params.fileIds);
    if (!fileCheck.valid) {
      throw new Error(`GATE FAILED: Missing files in Hashtopolis: ${fileCheck.missing.join(", ")}. Upload files first.`);
    }

    // Check file sizes for corruption (files < 100 bytes are likely ERR3 error messages)
    for (const file of fileCheck.files) {
      if (file.size < 100) {
        throw new Error(`GATE FAILED: File ${file.fileId} (${file.filename}) is corrupted (${file.size} bytes). Re-upload required.`);
      }
    }
  }

  // 1. Create TaskWrapper
  const wrapperSQL = `INSERT INTO TaskWrapper (priority, taskType, hashlistId, accessGroupId, taskWrapperName, isArchived, cracked, maxAgents) VALUES (${params.priority}, 0, ${params.hashlistId}, 1, '${params.name}', 0, 0, ${params.maxAgents})`;

  execSQL(config, wrapperSQL);
  const wrapperId = parseInt(execSQL(config, "SELECT MAX(taskWrapperId) FROM TaskWrapper"));

  // 2. Create Task
  const taskSQL = `INSERT INTO Task (taskName, attackCmd, chunkTime, statusTimer, keyspace, keyspaceProgress, priority, maxAgents, color, isSmall, isCpuTask, useNewBench, skipKeyspace, crackerBinaryId, crackerBinaryTypeId, taskWrapperId, isArchived, notes, staticChunks, chunkSize, forcePipe, usePreprocessor, preprocessorCommand) VALUES ('${params.name}', '${params.attackCmd}', 600, 5, 0, 0, ${params.priority}, ${params.maxAgents}, NULL, ${params.isSmall}, 0, ${useNewBench}, 0, 1, 1, ${wrapperId}, 0, '', 0, 0, 0, 0, '')`;

  execSQL(config, taskSQL);
  const taskId = parseInt(execSQL(config, "SELECT MAX(taskId) FROM Task"));

  // 3. Link files to task
  for (const fileId of params.fileIds) {
    execSQL(config, `INSERT INTO FileTask (fileId, taskId) VALUES (${fileId}, ${taskId})`);
  }

  return { wrapperId, taskId };
}

// =============================================================================
// Main Processing Logic
// =============================================================================

async function processBatch(
  batchNumber: number,
  options: {
    attackName?: string;
    dryRun?: boolean;
    skipExisting?: boolean;
    numParts?: number;
  } = {}
): Promise<void> {
  const { dryRun = false, skipExisting = true, attackName, numParts = 1 } = options;

  console.log(`\n${"=".repeat(60)}`);
  console.log(`Processing SAND batch ${batchNumber}`);
  console.log("=".repeat(60));

  // Load batch
  const batch = await loadSandBatch(batchNumber);
  if (!batch) {
    console.error(`Batch ${batchNumber} not found in ${SAND_DIR}`);
    return;
  }

  console.log(`Loaded ${batch.name}: ${batch.hashes.length.toLocaleString()} hashes`);

  // Show parts mode
  if (numParts > 1) {
    console.log(`Parallel mode: Splitting into ${numParts} parts for faster rule attacks`);
  }

  // Initialize state manager
  const stateManager = new SandStateManager(DATA_DIR);
  let batchState = stateManager.getBatch(batch.name);

  // Get server config
  const config = getServerConfig();
  console.log(`Server: ${config.serverIp}`);

  // Get Hashtopolis client
  const { HashtopolisClient } = await getHashtopolisClient();
  const client = HashtopolisClient.fromEnv();

  // ==========================================================================
  // BATCH PARTS LOGIC
  // When numParts > 1, split hashes into multiple hashlists for parallel processing
  // ==========================================================================

  interface PartInfo {
    partNum: number;
    hashlistId: number;
    hashlistName: string;
    hashCount: number;
  }

  const parts: PartInfo[] = [];

  if (numParts === 1) {
    // SINGLE HASHLIST MODE (original behavior)
    let hashlistId: number;
    const hashlistName = `SAND-${batch.name}`;

    if (batchState?.hashlistId) {
      hashlistId = batchState.hashlistId;
      console.log(`Reusing existing hashlist ${hashlistId} from state for ${batch.name}`);
    } else {
      // Check if hashlist already exists on server (recovery from timeout/crash)
      console.log(`Checking for existing hashlist: ${hashlistName}...`);
      const existingId = await client.findHashlistByName(hashlistName);

      if (existingId) {
        hashlistId = existingId;
        console.log(`Found existing hashlist ${hashlistId} on server, recovering...`);
        stateManager.initBatch(batch.name, hashlistId, batch.hashes.length);
        batchState = stateManager.getBatch(batch.name)!;
      } else if (dryRun) {
        console.log(`[DRY RUN] Would create hashlist: ${hashlistName}`);
        hashlistId = 0;
      } else {
        console.log(`Creating new hashlist: ${hashlistName} (${batch.hashes.length.toLocaleString()} hashes)...`);
        hashlistId = await client.createHashlist({
          name: hashlistName,
          hashTypeId: HASH_TYPE_SHA1,
          hashes: batch.hashes,
        });
        console.log(`Created hashlist ${hashlistId}`);
        stateManager.initBatch(batch.name, hashlistId, batch.hashes.length);
        batchState = stateManager.getBatch(batch.name)!;
      }
    }
    parts.push({ partNum: 0, hashlistId, hashlistName, hashCount: batch.hashes.length });
  } else {
    // MULTI-PART MODE: Split into numParts hashlists for parallel rule attacks
    const hashesPerPart = Math.ceil(batch.hashes.length / numParts);
    console.log(`\nCreating ${numParts} hashlist parts (~${hashesPerPart.toLocaleString()} hashes each)...`);

    for (let p = 0; p < numParts; p++) {
      const start = p * hashesPerPart;
      const end = Math.min(start + hashesPerPart, batch.hashes.length);
      const partHashes = batch.hashes.slice(start, end);
      const hashlistName = `SAND-${batch.name}-part${p + 1}`;

      if (partHashes.length === 0) continue;  // Skip empty parts

      // Check if part already exists
      let hashlistId: number;
      const existingId = await client.findHashlistByName(hashlistName);

      if (existingId) {
        hashlistId = existingId;
        console.log(`  Part ${p + 1}: Reusing existing hashlist ${hashlistId}`);
      } else if (dryRun) {
        console.log(`  Part ${p + 1}: [DRY RUN] Would create ${hashlistName} (${partHashes.length.toLocaleString()} hashes)`);
        hashlistId = 0;
      } else {
        hashlistId = await client.createHashlist({
          name: hashlistName,
          hashTypeId: HASH_TYPE_SHA1,
          hashes: partHashes,
        });
        console.log(`  Part ${p + 1}: Created hashlist ${hashlistId} (${partHashes.length.toLocaleString()} hashes)`);
      }

      parts.push({ partNum: p + 1, hashlistId, hashlistName, hashCount: partHashes.length });
    }

    // Initialize batch state with first part's hashlist (for backwards compat)
    if (!batchState && parts.length > 0 && parts[0].hashlistId > 0) {
      stateManager.initBatch(batch.name, parts[0].hashlistId, batch.hashes.length);
      batchState = stateManager.getBatch(batch.name)!;
    }

    console.log(`Created ${parts.length} hashlist parts`);
  }

  // For single-part mode, use the first (and only) part's hashlistId
  const primaryHashlistId = parts[0]?.hashlistId || 0;

  // Determine which attacks to run
  let attacksToRun: string[];

  if (attackName) {
    // Single attack specified
    if (!ATTACK_PRESETS[attackName]) {
      console.error(`Unknown attack: ${attackName}`);
      console.error(`Available attacks: ${Object.keys(ATTACK_PRESETS).join(", ")}`);
      return;
    }
    attacksToRun = [attackName];
  } else {
    // All remaining attacks
    // IMPORTANT: empty array [] is truthy in JS — must check .length explicitly
    const remaining = batchState?.attacksRemaining;
    attacksToRun = (remaining && remaining.length > 0) ? remaining : [...DEFAULT_ATTACK_ORDER];
  }

  console.log(`\nAttacks to run: ${attacksToRun.length}`);
  for (const a of attacksToRun) {
    const preset = ATTACK_PRESETS[a];
    if (preset) {
      console.log(`  - ${a}: ${preset.description}`);
    }
  }

  // ==========================================================================
  // PRE-FLIGHT GATE: Validate ALL required files exist before creating tasks
  // This prevents "Keyspace measure failed!" errors from missing files
  // ==========================================================================
  console.log("\n--- PRE-FLIGHT: File Validation ---");

  // Collect all unique fileIds needed for planned attacks
  const allFileIds = new Set<number>();
  for (const attack of attacksToRun) {
    const preset = ATTACK_PRESETS[attack];
    if (preset?.fileIds) {
      for (const fid of preset.fileIds) {
        allFileIds.add(fid);
      }
    }
  }

  if (allFileIds.size > 0) {
    const fileIds = Array.from(allFileIds);
    console.log(`Checking files: ${fileIds.join(", ")}`);

    // GATE 1: Files exist in database
    const existCheck = validateFilesExist(config, fileIds);
    if (!existCheck.valid) {
      console.error(`\n❌ GATE FAILED: Missing files in Hashtopolis File table:`);
      for (const missing of existCheck.missing) {
        console.error(`   - fileId ${missing} NOT FOUND`);
      }
      console.error(`\nFix: Upload missing files to Hashtopolis before running attacks.`);
      console.error(`Query current files: SELECT fileId, filename FROM File;`);
      return;
    }

    console.log(`✓ All ${existCheck.files.length} files exist in database:`);
    for (const f of existCheck.files) {
      const sizeStr = f.size > 1000000
        ? `${(f.size / 1024 / 1024).toFixed(1)}MB`
        : `${(f.size / 1024).toFixed(1)}KB`;
      console.log(`   - ${f.fileId}: ${f.filename} (${sizeStr})`);
    }

    // GATE 2: Files are downloadable (not returning ERR3)
    if (!dryRun) {
      console.log("\nTesting file downloads...");
      const downloadCheck = validateFileDownloads(config, fileIds);
      if (!downloadCheck.valid) {
        console.error(`\n❌ GATE FAILED: File download errors:`);
        for (const err of downloadCheck.errors) {
          console.error(`   - ${err}`);
        }
        console.error(`\nFix: Run 'bun Tools/WarmStart.ts' to copy files to correct location.`);
        return;
      }
      console.log(`✓ All files downloadable`);
    }
  } else {
    console.log("(No external files needed for selected attacks)");
  }

  // GATE 3: Database health — Hash table bloat causes getHashlist timeout
  if (!dryRun) {
    console.log("\nChecking database health...");
    try {
      const hashTableSize = execSQL(config,
        "SELECT ROUND(data_length / 1024 / 1024, 1) FROM information_schema.tables WHERE table_schema='hashtopolis' AND table_name='Hash'"
      );
      const hashTableMB = parseFloat(hashTableSize) || 0;
      const hashlistCount = parseInt(execSQL(config,
        "SELECT COUNT(*) FROM Hashlist WHERE isArchived = 0"
      )) || 0;

      if (hashTableMB > 1000 && hashlistCount > 10) {
        console.error(`\n❌ GATE FAILED: Hash table bloated (${hashTableMB}MB, ${hashlistCount} hashlists)`);
        console.error(`   getHashlist.php will timeout and agents will be stuck!`);
        console.error(`\nFix: Clean up BEFORE submitting batch:`);
        console.error(`   1. bun Tools/PasswordExporter.ts export`);
        console.error(`   2. bun Tools/HashlistArchiver.ts`);
        return;
      }

      if (hashTableMB > 500) {
        console.log(`⚠ Hash table: ${hashTableMB}MB (consider cleanup soon)`);
      } else {
        console.log(`✓ Hash table healthy (${hashTableMB}MB)`);
      }
    } catch {
      console.log("⚠ Could not check database health (non-blocking)");
    }
  }

  console.log("--- PRE-FLIGHT COMPLETE ---\n");

  // Run each attack (creating tasks for each part in multi-part mode)
  for (const attack of attacksToRun) {
    const preset = ATTACK_PRESETS[attack];
    if (!preset) {
      console.warn(`Unknown attack ${attack}, skipping`);
      continue;
    }

    // Skip if already applied
    if (skipExisting && stateManager.isAttackApplied(batch.name, attack)) {
      console.log(`\n[SKIP] ${attack} already applied to ${batch.name}`);
      continue;
    }

    console.log(`\n--- Attack: ${attack} ---`);
    console.log(`Phase: ${preset.phase}`);
    console.log(`Command: ${preset.attackCmd}`);
    console.log(`maxAgents: ${preset.maxAgents}, isSmall: ${preset.isSmall}`);

    if (dryRun) {
      if (parts.length > 1) {
        console.log(`[DRY RUN] Would create ${parts.length} tasks for ${attack} (one per part)`);
      } else {
        console.log(`[DRY RUN] Would create task: SAND-${batch.name}-${attack}`);
      }
      continue;
    }

    // Create task(s) - one per part in multi-part mode
    let firstTaskId: number | undefined;

    for (const part of parts) {
      // Task name includes part number in multi-part mode
      const taskName = parts.length > 1
        ? `SAND-${batch.name}-part${part.partNum}-${attack}`
        : `SAND-${batch.name}-${attack}`;

      // Check if task already exists
      const existingTask = execSQL(config, `SELECT taskId FROM Task WHERE taskName = '${taskName}' AND isArchived = 0 LIMIT 1`);
      if (existingTask) {
        if (parts.length > 1) {
          console.log(`  Part ${part.partNum}: Task already exists (ID: ${existingTask}), skipping`);
        } else {
          console.log(`Task ${taskName} already exists (ID: ${existingTask}), skipping`);
        }
        if (!firstTaskId) firstTaskId = parseInt(existingTask);
        continue;
      }

      // Create task
      const { taskId } = await createTaskViaDB(config, {
        name: taskName,
        hashlistId: part.hashlistId,
        attackCmd: preset.attackCmd,
        maxAgents: preset.maxAgents,
        priority: preset.priority,
        fileIds: preset.fileIds,
        isSmall: preset.isSmall,
      });

      if (parts.length > 1) {
        console.log(`  Part ${part.partNum}: Created task ${taskId}`);
      } else {
        console.log(`Created task ${taskId}: ${taskName}`);
      }

      if (!firstTaskId) firstTaskId = taskId;
    }

    // Update state (use first task ID for tracking)
    if (firstTaskId) {
      stateManager.startAttack(batch.name, attack, firstTaskId);
    }
  }

  console.log(`\nBatch ${batchNumber} processing initiated.`);
  console.log(`Monitor with: bun Tools/PipelineMonitor.ts`);
}

async function showStatus(): Promise<void> {
  const stateManager = new SandStateManager(DATA_DIR);
  const state = stateManager.load();
  const summary = stateManager.getSummary();

  console.log("SAND Processing Status");
  console.log("======================");
  console.log(`Started: ${state.startedAt || "Not started"}`);
  console.log(`Last updated: ${state.lastUpdated || "Never"}`);
  console.log("");
  console.log("Batch Summary:");
  console.log(`  Total: ${summary.totalBatches}`);
  console.log(`  Pending: ${summary.pending}`);
  console.log(`  In Progress: ${summary.inProgress}`);
  console.log(`  Completed: ${summary.completed}`);
  console.log(`  Failed: ${summary.failed}`);
  console.log("");
  console.log(`Total Cracked: ${summary.totalCracked.toLocaleString()} / ${summary.totalHashes.toLocaleString()}`);
  if (summary.totalHashes > 0) {
    console.log(`Overall Rate: ${((summary.totalCracked / summary.totalHashes) * 100).toFixed(2)}%`);
  }

  // Show per-batch details
  if (Object.keys(state.batches).length > 0) {
    console.log("\nPer-Batch Status:");
    for (const [name, batch] of Object.entries(state.batches)) {
      const rate = batch.hashCount > 0 ? ((batch.cracked / batch.hashCount) * 100).toFixed(1) : "0";
      console.log(`  ${name}: ${batch.status} (${batch.cracked.toLocaleString()}/${batch.hashCount.toLocaleString()} = ${rate}%)`);
      console.log(`    Applied: ${batch.attacksApplied.length}, Remaining: ${batch.attacksRemaining.length}`);
    }
  }

  // Show attack statistics
  const stats = stateManager.getAttackStats();
  if (Object.keys(stats).length > 0) {
    console.log("\nAttack Statistics:");
    for (const [name, s] of Object.entries(stats)) {
      console.log(`  ${name}: ${(s.avgRate * 100).toFixed(2)}% avg rate (${s.attempted} attempts)`);
    }
  }
}

async function showHistory(batchNumber: number): Promise<void> {
  const paddedNum = String(batchNumber).padStart(4, "0");
  const batchName = `batch-${paddedNum}`;

  const stateManager = new SandStateManager(DATA_DIR);
  const batch = stateManager.getBatch(batchName);

  if (!batch) {
    console.error(`No history for ${batchName}`);
    return;
  }

  console.log(`Attack History: ${batchName}`);
  console.log("=".repeat(40));
  console.log(`Hashlist ID: ${batch.hashlistId}`);
  console.log(`Hash Count: ${batch.hashCount.toLocaleString()}`);
  console.log(`Total Cracked: ${batch.cracked.toLocaleString()}`);
  console.log(`Status: ${batch.status}`);
  console.log("");
  console.log("Applied Attacks:");
  for (const attack of batch.attacksApplied) {
    const taskId = batch.taskIds[attack] || "?";
    console.log(`  ✓ ${attack} (Task ${taskId})`);
  }
  console.log("");
  console.log("Remaining Attacks:");
  for (const attack of batch.attacksRemaining) {
    console.log(`  ○ ${attack}`);
  }
}

async function analyzeStrategy(): Promise<void> {
  const stateManager = new SandStateManager(DATA_DIR);
  const stats = stateManager.getAttackStats();

  console.log("Strategy Analysis");
  console.log("=================");

  // Sort by effectiveness
  const sorted = Object.entries(stats)
    .map(([name, s]) => ({
      name,
      rate: s.avgRate,
      time: s.avgTimeSeconds,
      attempts: s.attempted,
      effectiveness: s.avgRate / Math.max(s.avgTimeSeconds / 3600, 0.1),
    }))
    .sort((a, b) => b.effectiveness - a.effectiveness);

  console.log("\nAttack Effectiveness (crack rate / hour):");
  for (const { name, rate, time, attempts, effectiveness } of sorted) {
    const status = effectiveness > 0.001 ? "✓" : "⚠";
    console.log(`  ${status} ${name}: ${(effectiveness * 100).toFixed(4)} eff (${(rate * 100).toFixed(2)}% in ${(time / 60).toFixed(0)}min, ${attempts} tries)`);
  }

  // Show ineffective attacks
  const ineffective = stateManager.getIneffectiveAttacks();
  if (ineffective.length > 0) {
    console.log("\n⚠ Ineffective attacks (consider skipping):");
    for (const name of ineffective) {
      console.log(`  - ${name}`);
    }
  }

  // Suggest reordering
  console.log("\n→ Run `bun Tools/SandStateManager.ts --reorder` to optimize attack order");
}

async function listAvailableAttacks(): Promise<void> {
  console.log("Available Attacks");
  console.log("=================\n");

  const phases = new Map<string, AttackPreset[]>();
  for (const preset of Object.values(ATTACK_PRESETS)) {
    if (!phases.has(preset.phase)) {
      phases.set(preset.phase, []);
    }
    phases.get(preset.phase)!.push(preset);
  }

  for (const [phase, presets] of phases) {
    console.log(`${phase.toUpperCase()}:`);
    for (const p of presets) {
      const agents = p.maxAgents === 0 ? "multi" : `${p.maxAgents}`;
      const small = p.isSmall ? " [SMALL]" : "";
      console.log(`  ${p.name}${small}`);
      console.log(`    ${p.description}`);
      console.log(`    Cmd: ${p.attackCmd}`);
      console.log(`    Agents: ${agents}, Priority: ${p.priority}, Expected: ${(p.expectedRate * 100).toFixed(1)}%`);
    }
    console.log("");
  }
}

// =============================================================================
// CLI Entry Point
// =============================================================================

if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args[0] === "--help" || args[0] === "-h") {
    console.log(`
SandProcessor - SAND Batch Processing Orchestrator

Usage:
  bun SandProcessor.ts --batch <n>                    Process SAND batch N (single hashlist)
  bun SandProcessor.ts --batch <n> --parts <p>        Split into P parts for parallel rule attacks
  bun SandProcessor.ts --batch <n> --workers <w>      Alias for --parts (split into W parts)
  bun SandProcessor.ts --batch <n> --attack <a>       Process single attack on batch
  bun SandProcessor.ts --batch <n> --dry-run          Preview without submitting
  bun SandProcessor.ts --status                       Show processing status
  bun SandProcessor.ts --history <n>                  Show attack history for batch
  bun SandProcessor.ts --analyze                      Analyze attack effectiveness
  bun SandProcessor.ts --attacks                      List available attacks
  bun SandProcessor.ts --list                         List available SAND batches

Options:
  --batch <n>      Batch number to process
  --parts <n>      Split batch into N parts for parallel processing (default: 1)
  --workers <n>    Alias for --parts (matches CrackSubmitter API)
  --attack <name>  Specific attack to run (see --attacks for list)
  --dry-run        Preview without creating tasks
  --status         Show overall status
  --history <n>    Show history for batch N
  --analyze        Analyze which attacks are effective
  --attacks        List all available attacks

Parallelization:
  With --parts 8, rule attacks run 8x faster by splitting the hashlist.
  Each part gets its own hashlist and tasks, running in parallel.

SAND Directory: ${SAND_DIR}
`);
    process.exit(0);
  }

  // Parse arguments
  let batchNumber: number | undefined;
  let attackName: string | undefined;
  let dryRun = false;
  let showStatusFlag = false;
  let historyBatch: number | undefined;
  let analyzeFlag = false;
  let listAttacksFlag = false;
  let listBatchesFlag = false;
  let numParts = 1;  // Default: single hashlist (no splitting)

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--batch":
        batchNumber = parseInt(args[++i]);
        break;
      case "--parts":
      case "--workers":
        numParts = parseInt(args[++i]);
        break;
      case "--attack":
        attackName = args[++i];
        break;
      case "--dry-run":
        dryRun = true;
        break;
      case "--status":
        showStatusFlag = true;
        break;
      case "--history":
        historyBatch = parseInt(args[++i]);
        break;
      case "--analyze":
        analyzeFlag = true;
        break;
      case "--attacks":
        listAttacksFlag = true;
        break;
      case "--list":
        listBatchesFlag = true;
        break;
    }
  }

  try {
    if (showStatusFlag) {
      await showStatus();
    } else if (historyBatch !== undefined) {
      await showHistory(historyBatch);
    } else if (analyzeFlag) {
      await analyzeStrategy();
    } else if (listAttacksFlag) {
      await listAvailableAttacks();
    } else if (listBatchesFlag) {
      const batches = listSandBatches();
      console.log(`Available SAND batches in ${SAND_DIR}:`);
      if (batches.length === 0) {
        console.log("  (none found)");
      } else {
        for (const n of batches) {
          console.log(`  batch-${String(n).padStart(4, "0")}`);
        }
      }
    } else if (batchNumber !== undefined) {
      await processBatch(batchNumber, { attackName, dryRun, numParts });
    } else {
      console.error("Specify --batch <n>, --status, --history <n>, --analyze, --attacks, or --list");
      process.exit(1);
    }
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
  }
}
