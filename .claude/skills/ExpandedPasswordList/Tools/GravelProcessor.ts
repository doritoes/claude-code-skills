#!/usr/bin/env bun
/**
 * GravelProcessor.ts - Stage 1: GRAVEL → PEARLS + SAND on BIGRED
 *
 * Processes GRAVEL batches through initial attacks on BIGRED local GPU,
 * producing PEARLS (cracked passwords) and SAND (uncracked hard hashes).
 *
 * Stage 1 Attack Order:
 *   brute-1 through brute-7 (catch all short passwords, 1-7 chars)
 *   rockyou-onerule (rockyou.txt × OneRuleToRuleThemStill.rule)
 *
 * After Stage 1, SAND goes into Stage 2 (BigRedRunner.ts) for escalating attacks.
 *
 * Usage:
 *   bun Tools/GravelProcessor.ts --next                Process next pending batch
 *   bun Tools/GravelProcessor.ts --batch 1             Process specific batch
 *   bun Tools/GravelProcessor.ts --batch 1 --resume    Resume interrupted batch
 *   bun Tools/GravelProcessor.ts --batch 1 --collect   Collect results only
 *   bun Tools/GravelProcessor.ts --batch 1 --status    Check BIGRED status
 *   bun Tools/GravelProcessor.ts --status              Show gravel-state summary
 *   bun Tools/GravelProcessor.ts --batch 1 --dry-run   Preview commands
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { DATA_DIR, GRAVEL_DIR, SAND_DIR, PEARLS_DIR, HASH_TYPE_SHA1, decodeHexPlain } from "./config";
import { loadConfig, sshCmd, scpUpload, scpDownload, type BigRedConfig } from "./BigRedSync";

// =============================================================================
// Constants
// =============================================================================

const SHELL = process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "/bin/bash";
const GRAVEL_STATE_PATH = resolve(DATA_DIR, "gravel-state.json");

/**
 * Stage 1 attacks — fast initial cracking to separate PEARLS from SAND.
 *
 * brute-1 through brute-7 catch all short passwords (1-7 chars).
 * rockyou-onerule applies 48K rules to the rockyou wordlist for dictionary attacks.
 *
 * Expected crack rate: 15-25% of GRAVEL
 * Expected time per batch: ~2-3 hours (dominated by brute-7 + rockyou-onerule)
 */
const STAGE1_ATTACK_ORDER = [
  "brute-1",          // ?a                    — instant
  "brute-2",          // ?a?a                  — instant
  "brute-3",          // ?a?a?a                — instant
  "brute-4",          // ?a?a?a?a              — instant
  "brute-5",          // ?a?a?a?a?a            — seconds
  "brute-6",          // ?a?a?a?a?a?a          — ~1.2 min
  "brute-7",          // ?a?a?a?a?a?a?a        — ~106 min
  "rockyou-onerule",  // rockyou.txt × OneRuleToRuleThemStill.rule
] as const;

type Stage1Attack = typeof STAGE1_ATTACK_ORDER[number];

/**
 * Hashcat commands for Stage 1 attacks.
 * #HL# is replaced with the hashlist path at runtime.
 */
const ATTACK_CMDS: Record<string, string> = {
  "brute-1":         "#HL# -a 3 ?a",
  "brute-2":         "#HL# -a 3 ?a?a",
  "brute-3":         "#HL# -a 3 ?a?a?a",
  "brute-4":         "#HL# -a 3 ?a?a?a?a",
  "brute-5":         "#HL# -a 3 ?a?a?a?a?a",
  "brute-6":         "#HL# -a 3 ?a?a?a?a?a?a",
  "brute-7":         "#HL# -a 3 ?a?a?a?a?a?a?a",
  "rockyou-onerule": "#HL# rockyou.txt -r OneRuleToRuleThemStill.rule",
};

/**
 * Map filenames to BIGRED remote paths (reused from BigRedRunner).
 */
const FILE_MAP: Record<string, string> = {
  "rockyou.txt":                  "wordlists/rockyou.txt",
  "OneRuleToRuleThemStill.rule":  "rules/OneRuleToRuleThemStill.rule",
};

// =============================================================================
// Gravel State Management
// =============================================================================

interface GravelBatchState {
  status: "pending" | "in_progress" | "completed";
  hashCount: number;
  attacksApplied: string[];
  attacksRemaining: string[];
  pearlCount: number;
  sandCount: number;
  startedAt: string | null;
  completedAt: string | null;
}

interface GravelState {
  version: string;
  batches: Record<string, GravelBatchState>;
  totalProcessed: number;
  totalPearls: number;
  totalSand: number;
  lastUpdated: string | null;
}

function loadGravelState(): GravelState {
  if (existsSync(GRAVEL_STATE_PATH)) {
    return JSON.parse(readFileSync(GRAVEL_STATE_PATH, "utf-8"));
  }
  return {
    version: "1.0",
    batches: {},
    totalProcessed: 0,
    totalPearls: 0,
    totalSand: 0,
    lastUpdated: null,
  };
}

function saveGravelState(state: GravelState): void {
  state.lastUpdated = new Date().toISOString();
  writeFileSync(GRAVEL_STATE_PATH, JSON.stringify(state, null, 2));
}

function initBatch(state: GravelState, batchName: string, hashCount: number): void {
  state.batches[batchName] = {
    status: "pending",
    hashCount,
    attacksApplied: [],
    attacksRemaining: [...STAGE1_ATTACK_ORDER],
    pearlCount: 0,
    sandCount: 0,
    startedAt: null,
    completedAt: null,
  };
  saveGravelState(state);
}

function getNextPendingBatch(state: GravelState): string | null {
  // Find all gravel batch files
  if (!existsSync(GRAVEL_DIR)) return null;

  const files = readdirSync(GRAVEL_DIR)
    .filter(f => f.match(/^batch-\d{4}\.txt$/))
    .sort();

  for (const file of files) {
    const batchName = file.replace(".txt", "");
    const batchState = state.batches[batchName];
    if (!batchState || batchState.status === "pending") {
      return batchName;
    }
  }
  return null;
}

// =============================================================================
// Command Translation
// =============================================================================

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function translateCmd(attackCmd: string, batchName: string, workDir: string): string {
  let cmd = attackCmd.replace("#HL#", `hashlists/${batchName}.txt`);

  for (const [filename, remotePath] of Object.entries(FILE_MAP)) {
    const regex = new RegExp(`(?<![/\\w])${escapeRegex(filename)}(?![/\\w])`, "g");
    cmd = cmd.replace(regex, remotePath);
  }

  const potfile = `potfiles/${batchName}.pot`;
  return `hashcat -m ${HASH_TYPE_SHA1} ${cmd} --potfile-path ${potfile} -O -w 3 --status --status-timer 60`;
}

// =============================================================================
// SSH / Screen Helpers (mirrors BigRedRunner)
// =============================================================================

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitForConnection(config: BigRedConfig, maxWaitMs = 300000): boolean {
  const startTime = Date.now();
  let attempt = 0;

  while (Date.now() - startTime < maxWaitMs) {
    attempt++;
    try {
      sshCmd(config, "echo connected", 10000);
      console.log(`  Reconnected after ${attempt} attempt(s).`);
      return true;
    } catch {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      const waitTime = Math.min(10000 * attempt, 30000);
      console.log(`  Retry ${attempt}: unreachable (${elapsed}s), waiting ${waitTime / 1000}s...`);
      sleepSync(waitTime);
    }
  }
  return false;
}

function getPotfileCount(config: BigRedConfig, batchName: string): number {
  try {
    const result = sshCmd(config, `test -f ${config.workDir}/potfiles/${batchName}.pot && wc -l < ${config.workDir}/potfiles/${batchName}.pot || echo 0`);
    return parseInt(result) || 0;
  } catch {
    return 0;
  }
}

function isHashcatRunning(config: BigRedConfig): boolean {
  try {
    const result = sshCmd(config, "pgrep -c hashcat 2>/dev/null || echo 0");
    return parseInt(result) > 0;
  } catch {
    return false;
  }
}

function isScreenAlive(config: BigRedConfig, screenName: string): boolean {
  try {
    const result = sshCmd(config, `screen -ls 2>/dev/null | grep -c '${screenName}' || echo 0`);
    return parseInt(result) > 0;
  } catch {
    return false;
  }
}

function isLogComplete(config: BigRedConfig, logFile: string): boolean {
  try {
    const result = sshCmd(config, `grep -c -E '^Status\\.\\.+: (Exhausted|Cracked)' ${logFile} 2>/dev/null || echo 0`, 5000);
    return parseInt(result) > 0;
  } catch {
    return false;
  }
}

// =============================================================================
// Attack Execution
// =============================================================================

interface AttackResult {
  attack: string;
  crackedBefore: number;
  crackedAfter: number;
  newCracks: number;
  durationSeconds: number;
}

function runAttack(config: BigRedConfig, attackName: string, batchName: string, dryRun: boolean): AttackResult {
  const attackCmd = ATTACK_CMDS[attackName];
  if (!attackCmd) {
    throw new Error(`Unknown attack: ${attackName}`);
  }

  const hashcatCmd = translateCmd(attackCmd, batchName, config.workDir);

  console.log(`\n${"─".repeat(60)}`);
  console.log(`Attack: ${attackName}`);
  console.log(`Command: ${hashcatCmd}`);

  if (dryRun) {
    console.log("[DRY RUN] Would execute on BIGRED");
    return { attack: attackName, crackedBefore: 0, crackedAfter: 0, newCracks: 0, durationSeconds: 0 };
  }

  if (isHashcatRunning(config)) {
    console.log("WARNING: hashcat is already running on BIGRED!");
    return { attack: attackName, crackedBefore: 0, crackedAfter: 0, newCracks: 0, durationSeconds: -1 };
  }

  const crackedBefore = getPotfileCount(config, batchName);
  console.log(`Potfile before: ${crackedBefore} cracked`);

  const startTime = Date.now();
  const screenName = `gp-${batchName}`;
  const logFile = `${config.workDir}/hashcat-gravel-${attackName}.log`;

  // Clean up previous session
  try {
    sshCmd(config, `screen -X -S ${screenName} quit 2>/dev/null; rm -f ${logFile}`, 10000);
  } catch { /* ignore */ }

  // Launch hashcat in screen
  const escapedCmd = hashcatCmd.replace(/'/g, "'\\''");
  const screenCmd = `screen -dmS ${screenName} bash -c 'cd ${config.workDir} && ${escapedCmd} > ${logFile} 2>&1'`;
  sshCmd(config, screenCmd, 15000);

  console.log(`Running in screen: ${screenName}`);
  sleepSync(3000);

  // Verify started
  if (!isHashcatRunning(config) && !isScreenAlive(config, screenName)) {
    console.error("ERROR: hashcat failed to start. Checking log...");
    try {
      const log = sshCmd(config, `cat ${logFile} 2>/dev/null || echo '(no log)'`, 10000);
      console.error(log);
    } catch { /* ignore */ }
    return { attack: attackName, crackedBefore, crackedAfter: crackedBefore, newCracks: 0, durationSeconds: 0 };
  }

  // Poll for completion
  const POLL_INTERVAL = 30000;
  const MAX_WAIT = 6 * 60 * 60 * 1000; // 6 hours (rockyou-onerule can be long)
  let notRunningCount = 0;

  while (Date.now() - startTime < MAX_WAIT) {
    sleepSync(POLL_INTERVAL);

    try {
      const hcRunning = isHashcatRunning(config);
      const screenUp = isScreenAlive(config, screenName);
      const logDone = isLogComplete(config, logFile);
      const potCount = getPotfileCount(config, batchName);
      const elapsed = formatDuration((Date.now() - startTime) / 1000);
      const newSince = potCount - crackedBefore;

      if (hcRunning || screenUp) {
        notRunningCount = 0;
        let progressInfo = "";
        try {
          const progress = sshCmd(config, `grep '^Progress' ${logFile} 2>/dev/null | tail -1`, 5000);
          if (progress.trim()) progressInfo = ` | ${progress.trim()}`;
        } catch { /* ignore */ }
        console.log(`  [${elapsed}] running — potfile: ${potCount.toLocaleString()} (+${newSince})${progressInfo}`);
      } else if (logDone) {
        console.log(`  hashcat finished (log confirmed).`);
        break;
      } else {
        notRunningCount++;
        console.log(`  [${elapsed}] not detected (check ${notRunningCount}/2) — potfile: ${potCount.toLocaleString()}`);
        if (notRunningCount >= 2) {
          console.log(`  hashcat appears stopped.`);
          break;
        }
      }
    } catch {
      const elapsed = formatDuration((Date.now() - startTime) / 1000);
      console.log(`  [${elapsed}] SSH lost — hashcat safe in screen. Reconnecting...`);
      if (!waitForConnection(config, 300000)) {
        console.error(`  Failed to reconnect. hashcat still running in screen.`);
        break;
      }
    }
  }

  // Read final potfile
  let crackedAfter = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    crackedAfter = getPotfileCount(config, batchName);
    if (crackedAfter >= crackedBefore) break;
    sleepSync(5000);
    try { sshCmd(config, "echo ok", 10000); } catch { waitForConnection(config, 60000); }
  }

  const newCracks = crackedAfter - crackedBefore;
  const durationSeconds = (Date.now() - startTime) / 1000;

  console.log(`\nCompleted: ${attackName}`);
  console.log(`  Duration: ${formatDuration(durationSeconds)}`);
  console.log(`  New cracks: ${newCracks.toLocaleString()}`);
  console.log(`  Total potfile: ${crackedAfter.toLocaleString()}`);

  // Clean up screen
  if (isLogComplete(config, logFile)) {
    try { sshCmd(config, `screen -X -S ${screenName} quit 2>/dev/null || true`, 5000); } catch { /* ignore */ }
  }

  return { attack: attackName, crackedBefore, crackedAfter, newCracks, durationSeconds };
}

// =============================================================================
// Upload Gravel Batch to BIGRED
// =============================================================================

function uploadGravelBatch(config: BigRedConfig, batchName: string): number {
  const txtPath = resolve(GRAVEL_DIR, `${batchName}.txt`);
  if (!existsSync(txtPath)) {
    throw new Error(`Gravel batch not found: ${txtPath}`);
  }

  const content = readFileSync(txtPath, "utf-8");
  const hashCount = content.trim().split("\n").filter(h => h.length === 40).length;

  // Check if already uploaded
  try {
    const remoteSize = sshCmd(config, `stat -c %s ${config.workDir}/hashlists/${batchName}.txt 2>/dev/null || echo 0`);
    const localSize = Buffer.byteLength(content);
    if (parseInt(remoteSize) === localSize) {
      console.log(`  Hashlist already on BIGRED (${hashCount.toLocaleString()} hashes)`);
      return hashCount;
    }
  } catch { /* upload anyway */ }

  console.log(`  Uploading ${batchName}.txt (${hashCount.toLocaleString()} hashes)...`);

  // Write to temp and upload (gravel files are uncompressed .txt)
  const tmpPath = resolve(GRAVEL_DIR, `${batchName}.upload.tmp`);
  writeFileSync(tmpPath, content);

  try {
    scpUpload(config, tmpPath, `${config.workDir}/hashlists/${batchName}.txt`);
  } finally {
    if (existsSync(tmpPath)) {
      const { unlinkSync } = require("node:fs");
      unlinkSync(tmpPath);
    }
  }

  console.log(`  Uploaded.`);
  return hashCount;
}

// =============================================================================
// Result Collection — PEARLS + SAND extraction
// =============================================================================

async function collectResults(config: BigRedConfig, batchName: string): Promise<void> {
  console.log(`\nCollecting Stage 1 results for ${batchName}`);
  console.log("=".repeat(50));

  const potCount = getPotfileCount(config, batchName);
  if (potCount === 0) {
    console.log("No results to collect (potfile empty or missing).");
    return;
  }

  console.log(`Potfile: ${potCount.toLocaleString()} entries`);

  // Ensure output directories exist
  for (const dir of [PEARLS_DIR, SAND_DIR]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  // Download potfile
  const localPotPath = resolve(PEARLS_DIR, `${batchName}.pot`);
  console.log(`Downloading potfile...`);
  scpDownload(config, `${config.workDir}/potfiles/${batchName}.pot`, localPotPath);

  // Parse potfile
  const potContent = readFileSync(localPotPath, "utf-8");
  const lines = potContent.trim().split("\n").filter(l => l.includes(":"));

  const crackedHashes = new Set<string>();
  const parsedPairs: { hash: string; plain: string }[] = [];
  const passwords: string[] = [];

  for (const line of lines) {
    const colonIdx = line.indexOf(":");
    if (colonIdx < 0) continue;
    const hash = line.slice(0, colonIdx).trim().toLowerCase();
    const plain = decodeHexPlain(line.slice(colonIdx + 1));

    if (/^[a-f0-9]{40}$/.test(hash)) {
      crackedHashes.add(hash);
      parsedPairs.push({ hash, plain });
      passwords.push(plain);
    }
  }

  console.log(`PEARLS: ${parsedPairs.length.toLocaleString()} cracked passwords`);

  // Append to single JSONL file (one JSON object per line — no delimiter ambiguity)
  const pearlsJsonlPath = resolve(PEARLS_DIR, "hash_plaintext_pairs.jsonl");
  const jsonlContent = parsedPairs.map(p => JSON.stringify(p)).join("\n") + "\n";
  appendFileSync(pearlsJsonlPath, jsonlContent);
  console.log(`  → ${pearlsJsonlPath} (appended ${parsedPairs.length.toLocaleString()})`);

  // Load GRAVEL batch to compute SAND
  const gravelPath = resolve(GRAVEL_DIR, `${batchName}.txt`);
  if (!existsSync(gravelPath)) {
    console.error(`  WARNING: Gravel batch not found: ${gravelPath}`);
    console.error(`  Cannot compute SAND without source GRAVEL.`);
    return;
  }

  const gravelContent = readFileSync(gravelPath, "utf-8");
  const gravelHashes = gravelContent.trim().split("\n").filter(h => h.length === 40);
  const totalHashes = gravelHashes.length;

  // SAND = GRAVEL - PEARLS
  const sandHashes = gravelHashes.filter(h => !crackedHashes.has(h.toLowerCase()));
  console.log(`SAND: ${sandHashes.length.toLocaleString()} uncracked hashes`);

  // Write SAND (compressed)
  const sandPath = resolve(SAND_DIR, `${batchName}.txt.gz`);
  const sandContent = sandHashes.join("\n") + "\n";
  writeFileSync(sandPath, gzipSync(Buffer.from(sandContent)));
  console.log(`  → ${sandPath}`);

  const crackRate = totalHashes > 0 ? (parsedPairs.length / totalHashes * 100).toFixed(2) : "0";
  console.log(`\nResults: ${parsedPairs.length.toLocaleString()} / ${totalHashes.toLocaleString()} (${crackRate}%)`);

  // Verify invariant: GRAVEL = PEARLS + SAND
  const check = parsedPairs.length + sandHashes.length;
  if (check !== totalHashes) {
    console.error(`WARNING: Invariant violation! PEARLS(${parsedPairs.length}) + SAND(${sandHashes.length}) = ${check} != GRAVEL(${totalHashes})`);
  } else {
    console.log(`Invariant OK: PEARLS(${parsedPairs.length}) + SAND(${sandHashes.length}) = GRAVEL(${totalHashes})`);
  }

  // Update gravel-state
  const state = loadGravelState();
  const batch = state.batches[batchName];
  if (batch) {
    batch.pearlCount = parsedPairs.length;
    batch.sandCount = sandHashes.length;
    batch.status = "completed";
    batch.completedAt = new Date().toISOString();
    state.totalProcessed++;
    state.totalPearls += parsedPairs.length;
    state.totalSand += sandHashes.length;
    saveGravelState(state);
    console.log(`  Updated gravel-state.json`);
  }

  // Clean up remote files for this batch
  try {
    sshCmd(config, `rm -f ${config.workDir}/hashlists/${batchName}.txt ${config.workDir}/potfiles/${batchName}.pot`, 10000);
    console.log(`  Cleaned up BIGRED work files`);
  } catch {
    console.log(`  WARNING: Could not clean BIGRED files (non-fatal)`);
  }

  // Top 20 passwords
  const freq = new Map<string, number>();
  for (const pw of passwords) freq.set(pw, (freq.get(pw) || 0) + 1);
  const top = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
  if (top.length > 0) {
    console.log("\nTop 20 passwords:");
    for (const [pw, count] of top) {
      console.log(`  ${count.toString().padStart(6)} × ${pw}`);
    }
  }

  console.log(`\nStage 1 complete for ${batchName}.`);
  console.log(`SAND ready for Stage 2: bun Tools/BigRedRunner.ts --batch ${batchName.replace("batch-", "")}`);
}

// =============================================================================
// Preflight Checks
// =============================================================================

function preflight(config: BigRedConfig, batchName: string, attacks: string[]): boolean {
  console.log("\n--- PRE-FLIGHT CHECKS ---");

  // 1. Check hashlist
  const hashlistPath = `${config.workDir}/hashlists/${batchName}.txt`;
  try {
    const size = sshCmd(config, `stat -c %s ${hashlistPath} 2>/dev/null || echo 0`);
    if (parseInt(size) === 0) {
      console.error(`FAIL: Hashlist not found: ${hashlistPath}`);
      return false;
    }
    const lines = sshCmd(config, `wc -l < ${hashlistPath}`);
    console.log(`  Hashlist: ${parseInt(lines).toLocaleString()} hashes`);
  } catch {
    console.error(`FAIL: Cannot check hashlist`);
    return false;
  }

  // 2. Check required files
  const missingFiles = new Set<string>();
  for (const attack of attacks) {
    const cmd = ATTACK_CMDS[attack];
    if (!cmd) continue;
    for (const filename of Object.keys(FILE_MAP)) {
      if (cmd.includes(filename)) {
        const remotePath = `${config.workDir}/${FILE_MAP[filename]}`;
        try {
          const size = sshCmd(config, `stat -c %s ${remotePath} 2>/dev/null || echo 0`);
          if (parseInt(size) === 0) missingFiles.add(filename);
        } catch {
          missingFiles.add(filename);
        }
      }
    }
  }

  if (missingFiles.size > 0) {
    console.error(`FAIL: Missing files:`);
    for (const f of missingFiles) console.error(`  - ${f}`);
    console.error(`  Fix: bun Tools/BigRedSync.ts --force`);
    return false;
  }
  console.log(`  Attack files: All present`);

  // 3. hashcat status
  if (isHashcatRunning(config)) {
    console.log(`  WARNING: hashcat already running`);
  } else {
    console.log(`  hashcat: Not running (ready)`);
  }

  // 4. Disk space
  try {
    const df = sshCmd(config, `df -h ${config.workDir} | tail -1 | awk '{print $4}'`);
    console.log(`  Disk free: ${df}`);
  } catch { /* ignore */ }

  console.log("--- PRE-FLIGHT PASSED ---\n");
  return true;
}

// =============================================================================
// Status Display
// =============================================================================

function showStatus(config: BigRedConfig | null, batchName: string | null): void {
  const state = loadGravelState();
  const batches = Object.entries(state.batches);

  console.log("\n=== GravelProcessor Status ===\n");

  // Count gravel batches available
  let gravelCount = 0;
  if (existsSync(GRAVEL_DIR)) {
    gravelCount = readdirSync(GRAVEL_DIR).filter(f => f.match(/^batch-\d{4}\.txt$/)).length;
  }

  const completed = batches.filter(([, b]) => b.status === "completed").length;
  const inProgress = batches.filter(([, b]) => b.status === "in_progress").length;
  const pending = batches.filter(([, b]) => b.status === "pending").length;
  const untracked = gravelCount - batches.length;

  console.log(`GRAVEL batches: ${gravelCount.toLocaleString()}`);
  console.log(`  Completed:   ${completed}`);
  console.log(`  In progress: ${inProgress}`);
  console.log(`  Pending:     ${pending}`);
  console.log(`  Untracked:   ${untracked.toLocaleString()}`);
  console.log(`  Total PEARLS: ${state.totalPearls.toLocaleString()}`);
  console.log(`  Total SAND:   ${state.totalSand.toLocaleString()}`);

  if (state.lastUpdated) {
    console.log(`  Last updated: ${state.lastUpdated}`);
  }

  // Show in-progress batch details
  for (const [name, b] of batches) {
    if (b.status === "in_progress") {
      console.log(`\n  ${name}: ${b.attacksApplied.length}/${STAGE1_ATTACK_ORDER.length} attacks`);
      console.log(`    Applied: ${b.attacksApplied.join(", ") || "(none)"}`);
      console.log(`    Remaining: ${b.attacksRemaining.join(", ")}`);
    }
  }

  // Show BIGRED status if connected
  if (config && batchName) {
    console.log(`\nBIGRED Status:`);
    try {
      const hcRunning = isHashcatRunning(config);
      const potCount = getPotfileCount(config, batchName);
      console.log(`  hashcat: ${hcRunning ? "RUNNING" : "idle"}`);
      console.log(`  Potfile (${batchName}): ${potCount.toLocaleString()}`);

      try {
        const gpu = sshCmd(config, "nvidia-smi --query-gpu=name,temperature.gpu,utilization.gpu --format=csv,noheader 2>/dev/null || echo 'n/a'");
        console.log(`  GPU: ${gpu}`);
      } catch { /* ignore */ }
    } catch {
      console.log(`  (cannot connect to BIGRED)`);
    }
  }
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

// =============================================================================
// CLI Entry Point
// =============================================================================

if (import.meta.main) {
  const args = process.argv.slice(2);

  let batchNumber: number | undefined;
  let statusFlag = false;
  let collectFlag = false;
  let resumeFlag = false;
  let dryRun = false;
  let nextFlag = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--batch":
        batchNumber = parseInt(args[++i]);
        break;
      case "--next":
        nextFlag = true;
        break;
      case "--status":
        statusFlag = true;
        break;
      case "--collect":
        collectFlag = true;
        break;
      case "--resume":
        resumeFlag = true;
        break;
      case "--dry-run":
        dryRun = true;
        break;
      case "--help":
      case "-h":
        console.log(`
GravelProcessor - Stage 1: GRAVEL → PEARLS + SAND on BIGRED

Usage:
  bun Tools/GravelProcessor.ts --next                Process next pending batch
  bun Tools/GravelProcessor.ts --batch 1             Process specific batch
  bun Tools/GravelProcessor.ts --batch 1 --resume    Resume interrupted batch
  bun Tools/GravelProcessor.ts --batch 1 --collect   Collect results (PEARLS + SAND)
  bun Tools/GravelProcessor.ts --batch 1 --status    Check BIGRED status for batch
  bun Tools/GravelProcessor.ts --status              Show gravel-state summary
  bun Tools/GravelProcessor.ts --batch 1 --dry-run   Preview commands

Stage 1 Attack Order:
${STAGE1_ATTACK_ORDER.map((a, i) => `  ${(i + 1).toString().padStart(2)}. ${a.padEnd(20)} ${ATTACK_CMDS[a]}`).join("\n")}

Pipeline: GRAVEL → [Stage 1] → PEARLS + SAND → [Stage 2: BigRedRunner] → DIAMONDS + GLASS
`);
        process.exit(0);
    }
  }

  // Status without batch — show summary
  if (statusFlag && batchNumber === undefined && !nextFlag) {
    showStatus(null, null);
    process.exit(0);
  }

  // Resolve batch name
  let batchName: string;
  const state = loadGravelState();

  if (nextFlag) {
    const next = getNextPendingBatch(state);
    if (!next) {
      console.log("No pending gravel batches to process.");
      process.exit(0);
    }
    batchName = next;
    console.log(`Next batch: ${batchName}`);
  } else if (batchNumber !== undefined) {
    batchName = `batch-${String(batchNumber).padStart(4, "0")}`;
  } else {
    console.error("ERROR: --batch <n> or --next is required");
    process.exit(1);
  }

  try {
    const config = loadConfig();
    console.log(`BIGRED: ${config.user}@${config.host}`);
    console.log(`Batch: ${batchName}`);
    console.log(`Stage: 1 (GRAVEL → PEARLS + SAND)`);

    // Test connectivity
    try {
      sshCmd(config, "echo connected", 10000);
    } catch {
      console.error("ERROR: Cannot connect to BIGRED.");
      process.exit(1);
    }

    if (statusFlag) {
      showStatus(config, batchName);
      process.exit(0);
    }

    if (collectFlag) {
      await collectResults(config, batchName);
      process.exit(0);
    }

    // Upload gravel batch to BIGRED
    console.log(`\nUploading gravel batch...`);
    const hashCount = uploadGravelBatch(config, batchName);

    // Initialize batch state if needed
    let batchState = state.batches[batchName];
    if (!batchState) {
      initBatch(state, batchName, hashCount);
      batchState = state.batches[batchName];
    }

    // Determine attacks to run
    let attacksToRun: string[];
    if (resumeFlag && batchState.attacksRemaining.length > 0) {
      attacksToRun = [...batchState.attacksRemaining];
    } else if (batchState.status === "completed") {
      console.log(`Batch ${batchName} already completed.`);
      console.log(`  PEARLS: ${batchState.pearlCount.toLocaleString()}`);
      console.log(`  SAND: ${batchState.sandCount.toLocaleString()}`);
      process.exit(0);
    } else {
      attacksToRun = [...batchState.attacksRemaining];
      if (attacksToRun.length === 0) {
        attacksToRun = [...STAGE1_ATTACK_ORDER];
      }
    }

    // Preflight
    if (!dryRun) {
      if (!preflight(config, batchName, attacksToRun)) {
        process.exit(1);
      }
    }

    // Mark as in_progress
    batchState.status = "in_progress";
    batchState.startedAt = batchState.startedAt || new Date().toISOString();
    saveGravelState(state);

    console.log(`Attacks to run: ${attacksToRun.length}`);
    for (const a of attacksToRun) {
      const done = batchState.attacksApplied.includes(a);
      console.log(`  ${done ? "[DONE]" : "[    ]"} ${a}`);
    }

    // Run attacks
    const results: AttackResult[] = [];
    const batchStartTime = Date.now();

    for (const attack of attacksToRun) {
      if (batchState.attacksApplied.includes(attack)) {
        console.log(`\n[SKIP] ${attack} — already completed`);
        continue;
      }

      const result = runAttack(config, attack, batchName, dryRun);
      results.push(result);

      if (!dryRun && result.durationSeconds >= 0) {
        // Update state
        batchState.attacksApplied.push(attack);
        batchState.attacksRemaining = batchState.attacksRemaining.filter(a => a !== attack);
        saveGravelState(state);
      }
    }

    // Summary
    const totalDuration = (Date.now() - batchStartTime) / 1000;
    const totalNewCracks = results.reduce((sum, r) => sum + r.newCracks, 0);
    const finalPotCount = dryRun ? 0 : getPotfileCount(config, batchName);

    console.log(`\n${"=".repeat(60)}`);
    console.log(`STAGE 1 COMPLETE: ${batchName}`);
    console.log("=".repeat(60));
    console.log(`Total time: ${formatDuration(totalDuration)}`);
    console.log(`New cracks: ${totalNewCracks.toLocaleString()}`);
    console.log(`Total potfile: ${finalPotCount.toLocaleString()}`);

    if (results.length > 0 && !dryRun) {
      console.log("\nPer-attack results:");
      for (const r of results) {
        if (r.durationSeconds < 0) continue;
        console.log(`  ${r.attack.padEnd(25)} ${r.newCracks.toString().padStart(8)} cracks  ${formatDuration(r.durationSeconds).padStart(8)}`);
      }
    }

    if (!dryRun && finalPotCount > 0) {
      console.log(`\nNext: bun Tools/GravelProcessor.ts --batch ${batchName.replace("batch-", "")} --collect`);
    }
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
  }
}
