#!/usr/bin/env bun
/**
 * GravelProcessor.ts - Stage 1: GRAVEL → PEARLS + SAND on BIGRED
 *
 * Processes GRAVEL batches through nocap.txt × nocap.rule on BIGRED,
 * producing PEARLS (cracked passwords) and SAND (uncracked hashes).
 *
 * Single command does everything: upload → run → collect → done.
 *
 * Usage:
 *   bun Tools/GravelProcessor.ts --batch 1           Process batch (upload, attack, collect)
 *   bun Tools/GravelProcessor.ts --next              Process next unprocessed batch
 *   bun Tools/GravelProcessor.ts --batch 1 --collect Collect results only (fallback)
 *   bun Tools/GravelProcessor.ts --batch 1 --dry-run Preview what would happen (read-only)
 *   bun Tools/GravelProcessor.ts --status            Show gravel-state summary
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { DATA_DIR, GRAVEL_DIR, SAND_DIR, PEARLS_DIR, HASH_TYPE_SHA1, decodeHexPlain } from "./config";
import { loadConfig, sshCmd, scpUpload, scpDownload, type BigRedConfig } from "./BigRedSync";

// =============================================================================
// Constants
// =============================================================================

const GRAVEL_STATE_PATH = resolve(DATA_DIR, "gravel-state.json");

/**
 * Local paths for nocap attack files (source of truth: data/ directory).
 */
const NOCAP_FILES: Record<string, { local: string; remote: string }> = {
  "nocap.txt":  { local: resolve(DATA_DIR, "nocap.txt"),  remote: "wordlists/nocap.txt" },
  "nocap.rule": { local: resolve(DATA_DIR, "nocap.rule"), remote: "rules/nocap.rule" },
};

// =============================================================================
// State Management
// =============================================================================

interface GravelBatchState {
  status: "completed";
  hashCount: number;
  pearlCount: number;
  sandCount: number;
  crackRate: string;
  durationSeconds: number;
  completedAt: string;
}

interface GravelState {
  version: string;
  batches: Record<string, GravelBatchState>;
  totalProcessed: number;
  totalPearls: number;
  totalSand: number;
  lastUpdated: string | null;
}

function loadState(): GravelState {
  if (existsSync(GRAVEL_STATE_PATH)) {
    return JSON.parse(readFileSync(GRAVEL_STATE_PATH, "utf-8"));
  }
  return {
    version: "2.0",
    batches: {},
    totalProcessed: 0,
    totalPearls: 0,
    totalSand: 0,
    lastUpdated: null,
  };
}

function saveState(state: GravelState): void {
  state.lastUpdated = new Date().toISOString();
  // Write to temp, then rename (safe for irreplaceable data)
  const tmpPath = GRAVEL_STATE_PATH + ".tmp";
  writeFileSync(tmpPath, JSON.stringify(state, null, 2));
  const { renameSync } = require("node:fs");
  renameSync(tmpPath, GRAVEL_STATE_PATH);
}

function getNextBatch(): string | null {
  if (!existsSync(GRAVEL_DIR)) return null;
  const state = loadState();
  const files = readdirSync(GRAVEL_DIR)
    .filter(f => f.match(/^batch-\d{4}\.txt$/))
    .sort();
  for (const file of files) {
    const name = file.replace(".txt", "");
    if (!state.batches[name]) return name;
  }
  return null;
}

// =============================================================================
// SSH / Screen Helpers
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

function getPotfileCount(config: BigRedConfig, batchName: string): number {
  try {
    const result = sshCmd(config, `test -f ${config.workDir}/potfiles/${batchName}.pot && wc -l < ${config.workDir}/potfiles/${batchName}.pot || echo 0`);
    return parseInt(result) || 0;
  } catch {
    return 0;
  }
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(0)}s`;
  if (seconds < 3600) return `${(seconds / 60).toFixed(1)}m`;
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  return `${hrs}h ${mins}m`;
}

// =============================================================================
// Upload Gravel Batch
// =============================================================================

function uploadBatch(config: BigRedConfig, batchName: string): number {
  const txtPath = resolve(GRAVEL_DIR, `${batchName}.txt`);
  if (!existsSync(txtPath)) {
    throw new Error(`Gravel batch not found: ${txtPath}`);
  }

  const localSize = statSync(txtPath).size;
  const content = readFileSync(txtPath, "utf-8");
  const hashCount = content.trim().split("\n").map(h => h.trim()).filter(h => h.length === 40).length;

  // Skip if already uploaded with matching size
  try {
    const remoteSize = sshCmd(config, `stat -c %s ${config.workDir}/hashlists/${batchName}.txt 2>/dev/null || echo 0`);
    if (parseInt(remoteSize) === localSize) {
      console.log(`  Hashlist already on BIGRED (${hashCount.toLocaleString()} hashes)`);
      return hashCount;
    }
  } catch { /* upload anyway */ }

  console.log(`  Uploading ${batchName}.txt (${hashCount.toLocaleString()} hashes)...`);
  scpUpload(config, txtPath, `${config.workDir}/hashlists/${batchName}.txt`);
  console.log(`  Uploaded.`);
  return hashCount;
}

// =============================================================================
// Ensure Attack Files on BIGRED
// =============================================================================

function ensureAttackFiles(config: BigRedConfig): boolean {
  for (const [name, paths] of Object.entries(NOCAP_FILES)) {
    const remotePath = `${config.workDir}/${paths.remote}`;
    let remoteSize = 0;
    try {
      remoteSize = parseInt(sshCmd(config, `stat -c %s ${remotePath} 2>/dev/null || echo 0`));
    } catch { /* missing */ }

    if (remoteSize > 0) {
      console.log(`  ${name}: present on BIGRED (${(remoteSize / 1024 / 1024).toFixed(1)} MB)`);
      continue;
    }

    if (!existsSync(paths.local)) {
      console.error(`FAIL: ${name} missing on BIGRED and not found locally at ${paths.local}`);
      return false;
    }

    console.log(`  ${name}: missing on BIGRED — uploading from ${paths.local}...`);
    try {
      const remoteDir = paths.remote.substring(0, paths.remote.lastIndexOf("/"));
      sshCmd(config, `mkdir -p ${config.workDir}/${remoteDir}`, 10000);
      scpUpload(config, paths.local, remotePath);
      const newSize = parseInt(sshCmd(config, `stat -c %s ${remotePath} 2>/dev/null || echo 0`));
      console.log(`  ${name}: uploaded (${(newSize / 1024 / 1024).toFixed(1)} MB)`);
    } catch (e) {
      console.error(`FAIL: Could not upload ${name}: ${(e as Error).message}`);
      return false;
    }
  }
  return true;
}

// =============================================================================
// Run Attack — nocap.txt × nocap.rule
// =============================================================================

function runAttack(config: BigRedConfig, batchName: string): { newCracks: number; durationSeconds: number } {
  const hashcatCmd = `hashcat -m ${HASH_TYPE_SHA1} hashlists/${batchName}.txt wordlists/nocap.txt -r rules/nocap.rule --potfile-path potfiles/${batchName}.pot -O -w 3 --status --status-timer 60`;
  const screenName = `gp-${batchName}`;
  const logFile = `${config.workDir}/hashcat-gravel.log`;

  console.log(`\nAttack: nocap.txt × nocap.rule`);
  console.log(`Command: ${hashcatCmd}`);

  const crackedBefore = getPotfileCount(config, batchName);
  const startTime = Date.now();

  // Check if this batch's screen session is already running (resume after Ctrl+C)
  const alreadyRunning = isScreenAlive(config, screenName) || isHashcatRunning(config);

  if (alreadyRunning && isScreenAlive(config, screenName)) {
    console.log(`RESUMING: screen session '${screenName}' still running on BIGRED`);
    console.log(`Potfile so far: ${crackedBefore} cracked`);
  } else if (alreadyRunning) {
    // hashcat running but not our screen session — something else is using the GPU
    throw new Error("hashcat is already running on BIGRED (not this batch). Wait or kill it manually.");
  } else {
    // Fresh launch
    console.log(`Potfile before: ${crackedBefore} cracked`);

    // Clean up previous session
    try {
      sshCmd(config, `screen -X -S ${screenName} quit 2>/dev/null; rm -f ${logFile}`, 10000);
    } catch { /* ignore */ }

    // Launch in screen
    const escapedCmd = hashcatCmd.replace(/'/g, "'\\''");
    sshCmd(config, `screen -dmS ${screenName} bash -c 'cd ${config.workDir} && ${escapedCmd} > ${logFile} 2>&1'`, 15000);
    console.log(`Running in screen: ${screenName}`);
    sleepSync(3000);

    // Verify started
    if (!isHashcatRunning(config) && !isScreenAlive(config, screenName)) {
      console.error("ERROR: hashcat failed to start. Checking log...");
      try {
        const log = sshCmd(config, `cat ${logFile} 2>/dev/null || echo '(no log)'`, 10000);
        console.error(log);
      } catch { /* ignore */ }
      throw new Error("hashcat failed to start on BIGRED");
    }
  }

  // Poll for completion
  const POLL_INTERVAL = 30000;
  const MAX_WAIT = 6 * 60 * 60 * 1000; // 6 hours
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
        throw new Error("Failed to reconnect to BIGRED after SSH drop");
      }
    }
  }

  // Read final potfile count
  let crackedAfter = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    crackedAfter = getPotfileCount(config, batchName);
    if (crackedAfter >= crackedBefore) break;
    sleepSync(5000);
    try { sshCmd(config, "echo ok", 10000); } catch { waitForConnection(config, 60000); }
  }

  const newCracks = crackedAfter - crackedBefore;
  const durationSeconds = (Date.now() - startTime) / 1000;

  console.log(`\nAttack complete`);
  console.log(`  Duration: ${formatDuration(durationSeconds)}`);
  console.log(`  New cracks: ${newCracks.toLocaleString()}`);
  console.log(`  Total potfile: ${crackedAfter.toLocaleString()}`);

  // Clean up screen
  try { sshCmd(config, `screen -X -S ${screenName} quit 2>/dev/null || true`, 5000); } catch { /* ignore */ }

  return { newCracks, durationSeconds };
}

// =============================================================================
// Collect Results — PEARLS + SAND
// =============================================================================

function collectResults(config: BigRedConfig, batchName: string, durationSeconds: number): void {
  console.log(`\nCollecting results for ${batchName}`);
  console.log("─".repeat(50));

  const potCount = getPotfileCount(config, batchName);
  if (potCount === 0) {
    console.log("No results to collect (potfile empty or missing).");
    // Still write empty SAND = full GRAVEL
  }

  // Ensure output directories
  for (const dir of [PEARLS_DIR, SAND_DIR]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  // Download potfile
  const localPotPath = resolve(PEARLS_DIR, `${batchName}.pot`);
  if (potCount > 0) {
    console.log(`Downloading potfile (${potCount.toLocaleString()} entries)...`);
    scpDownload(config, `${config.workDir}/potfiles/${batchName}.pot`, localPotPath);
  }

  // Parse potfile → PEARLS
  const crackedHashes = new Set<string>();
  const parsedPairs: { hash: string; plain: string }[] = [];
  const passwords: string[] = [];

  if (potCount > 0 && existsSync(localPotPath)) {
    const potContent = readFileSync(localPotPath, "utf-8");
    for (const line of potContent.split("\n")) {
      if (!line.includes(":")) continue;
      const colonIdx = line.indexOf(":");
      const hash = line.slice(0, colonIdx).trim().toLowerCase();
      const plain = decodeHexPlain(line.slice(colonIdx + 1).replace(/\r$/, ""));
      if (/^[a-f0-9]{40}$/.test(hash)) {
        crackedHashes.add(hash);
        parsedPairs.push({ hash, plain });
        passwords.push(plain);
      }
    }
  }

  console.log(`PEARLS: ${parsedPairs.length.toLocaleString()} cracked passwords`);

  // Append to JSONL
  if (parsedPairs.length > 0) {
    const pearlsJsonlPath = resolve(PEARLS_DIR, "hash_plaintext_pairs.jsonl");
    const jsonlContent = parsedPairs.map(p => JSON.stringify(p)).join("\n") + "\n";
    appendFileSync(pearlsJsonlPath, jsonlContent);
    console.log(`  → appended to hash_plaintext_pairs.jsonl`);
  }

  // Load GRAVEL to compute SAND
  const gravelPath = resolve(GRAVEL_DIR, `${batchName}.txt`);
  if (!existsSync(gravelPath)) {
    throw new Error(`Gravel batch not found: ${gravelPath} — cannot compute SAND`);
  }

  const gravelContent = readFileSync(gravelPath, "utf-8");
  const gravelHashes = gravelContent.trim().split("\n").map(h => h.trim()).filter(h => h.length === 40);
  const totalHashes = gravelHashes.length;

  // SAND = GRAVEL - PEARLS
  const sandHashes = gravelHashes.filter(h => !crackedHashes.has(h.toLowerCase()));
  console.log(`SAND: ${sandHashes.length.toLocaleString()} uncracked hashes`);

  // Write SAND (compressed)
  const sandPath = resolve(SAND_DIR, `${batchName}.txt.gz`);
  writeFileSync(sandPath, gzipSync(Buffer.from(sandHashes.join("\n") + "\n")));
  console.log(`  → ${sandPath}`);

  const crackRate = totalHashes > 0 ? (parsedPairs.length / totalHashes * 100).toFixed(2) : "0.00";
  console.log(`\nCrack rate: ${parsedPairs.length.toLocaleString()} / ${totalHashes.toLocaleString()} (${crackRate}%)`);

  // Verify invariant: GRAVEL = PEARLS + SAND
  const check = parsedPairs.length + sandHashes.length;
  if (check !== totalHashes) {
    console.error(`WARNING: Invariant violation! PEARLS(${parsedPairs.length}) + SAND(${sandHashes.length}) = ${check} != GRAVEL(${totalHashes})`);
  } else {
    console.log(`Invariant OK: PEARLS(${parsedPairs.length}) + SAND(${sandHashes.length}) = GRAVEL(${totalHashes})`);
  }

  // Update state — only place state is ever written for a batch
  const state = loadState();
  state.batches[batchName] = {
    status: "completed",
    hashCount: totalHashes,
    pearlCount: parsedPairs.length,
    sandCount: sandHashes.length,
    crackRate,
    durationSeconds,
    completedAt: new Date().toISOString(),
  };
  state.totalProcessed = Object.keys(state.batches).length;
  state.totalPearls = Object.values(state.batches).reduce((sum, b) => sum + b.pearlCount, 0);
  state.totalSand = Object.values(state.batches).reduce((sum, b) => sum + b.sandCount, 0);
  saveState(state);
  console.log(`  Updated gravel-state.json`);

  // Clean up remote files
  try {
    sshCmd(config, `rm -f ${config.workDir}/hashlists/${batchName}.txt ${config.workDir}/potfiles/${batchName}.pot`, 10000);
    console.log(`  Cleaned up BIGRED work files`);
  } catch {
    console.log(`  WARNING: Could not clean BIGRED files (non-fatal)`);
  }

  // Top 20 passwords
  if (passwords.length > 0) {
    const freq = new Map<string, number>();
    for (const pw of passwords) freq.set(pw, (freq.get(pw) || 0) + 1);
    const top = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
    console.log("\nTop 20 passwords:");
    for (const [pw, count] of top) {
      console.log(`  ${count.toString().padStart(6)} x ${pw}`);
    }
  }

  console.log(`\nStage 1 complete for ${batchName}.`);
  console.log(`SAND ready for Stage 2: bun Tools/BigRedRunner.ts --batch ${batchName.replace("batch-", "")}`);
}

// =============================================================================
// Status Display
// =============================================================================

function showStatus(): void {
  const state = loadState();
  const batches = Object.entries(state.batches);

  console.log("\n=== GravelProcessor Status ===\n");

  let gravelCount = 0;
  if (existsSync(GRAVEL_DIR)) {
    gravelCount = readdirSync(GRAVEL_DIR).filter(f => f.match(/^batch-\d{4}\.txt$/)).length;
  }

  const completed = batches.length;
  const remaining = gravelCount - completed;

  console.log(`GRAVEL batches: ${gravelCount.toLocaleString()}`);
  console.log(`  Completed:  ${completed}`);
  console.log(`  Remaining:  ${remaining.toLocaleString()}`);
  console.log(`  Total PEARLS: ${state.totalPearls.toLocaleString()}`);
  console.log(`  Total SAND:   ${state.totalSand.toLocaleString()}`);

  if (completed > 0) {
    const avgRate = state.totalPearls / (state.totalPearls + state.totalSand) * 100;
    console.log(`  Avg crack rate: ${avgRate.toFixed(2)}%`);
  }

  if (state.lastUpdated) {
    console.log(`  Last updated: ${state.lastUpdated}`);
  }

  // Show last 5 completed batches
  if (batches.length > 0) {
    console.log("\nRecent batches:");
    const recent = batches.slice(-5);
    for (const [name, b] of recent) {
      console.log(`  ${name}: ${b.pearlCount.toLocaleString()} pearls, ${b.sandCount.toLocaleString()} sand (${b.crackRate}%) — ${formatDuration(b.durationSeconds)}`);
    }
  }

  const next = getNextBatch();
  if (next) {
    console.log(`\nNext: bun Tools/GravelProcessor.ts --batch ${next.replace("batch-", "").replace(/^0+/, "") || "0"}`);
  } else {
    console.log("\nAll batches processed.");
  }
}

// =============================================================================
// Dry Run — purely read-only, touches NOTHING
// =============================================================================

function dryRun(batchName: string): void {
  console.log(`\n=== DRY RUN: ${batchName} ===\n`);
  console.log("This is read-only. No files uploaded, no state written, no SSH commands.\n");

  // Check local gravel file
  const gravelPath = resolve(GRAVEL_DIR, `${batchName}.txt`);
  if (!existsSync(gravelPath)) {
    console.error(`FAIL: Gravel batch not found: ${gravelPath}`);
    return;
  }
  const content = readFileSync(gravelPath, "utf-8");
  const hashCount = content.trim().split("\n").map(h => h.trim()).filter(h => h.length === 40).length;
  console.log(`Gravel: ${gravelPath}`);
  console.log(`  ${hashCount.toLocaleString()} hashes`);

  // Check state
  const state = loadState();
  if (state.batches[batchName]) {
    console.log(`  State: ALREADY COMPLETED (${state.batches[batchName].crackRate}% crack rate)`);
    return;
  }
  console.log(`  State: not yet processed`);

  // Check local nocap files
  console.log("\nAttack files (local):");
  for (const [name, paths] of Object.entries(NOCAP_FILES)) {
    if (existsSync(paths.local)) {
      const size = statSync(paths.local).size;
      console.log(`  ${name}: ${(size / 1024 / 1024).toFixed(1)} MB`);
    } else {
      console.log(`  ${name}: NOT FOUND at ${paths.local}`);
    }
  }

  // Show what would happen
  console.log("\nPlan:");
  console.log(`  1. Upload ${batchName}.txt to BIGRED hashlists/`);
  console.log(`  2. Ensure nocap.txt + nocap.rule on BIGRED (upload if missing)`);
  console.log(`  3. Run: hashcat -m ${HASH_TYPE_SHA1} hashlists/${batchName}.txt wordlists/nocap.txt -r rules/nocap.rule --potfile-path potfiles/${batchName}.pot -O -w 3`);
  console.log(`  4. Poll until complete (~90-120 min expected)`);
  console.log(`  5. Download potfile, extract PEARLS + SAND`);
  console.log(`  6. Write PEARLS to data/pearls/hash_plaintext_pairs.jsonl`);
  console.log(`  7. Write SAND to data/sand/${batchName}.txt.gz`);
  console.log(`  8. Update gravel-state.json`);
  console.log(`  9. Clean up BIGRED work files`);
}

// =============================================================================
// Process Single Batch — upload → attack → collect
// =============================================================================

function processBatch(config: BigRedConfig, batchName: string): void {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Processing ${batchName}`);
  console.log("=".repeat(60));

  // Check if already completed
  const state = loadState();
  if (state.batches[batchName]) {
    const b = state.batches[batchName];
    console.log(`Already completed: ${b.pearlCount.toLocaleString()} pearls, ${b.sandCount.toLocaleString()} sand (${b.crackRate}%)`);
    return;
  }

  // 1. Upload gravel batch
  console.log(`\nUploading gravel batch...`);
  const hashCount = uploadBatch(config, batchName);
  console.log(`  ${hashCount.toLocaleString()} hashes`);

  // 2. Ensure attack files on BIGRED (only checks first batch, cached after)
  console.log(`\nChecking attack files...`);
  if (!ensureAttackFiles(config)) {
    throw new Error("Attack files missing — cannot proceed");
  }

  // 3. Check hashcat not already running
  if (isHashcatRunning(config)) {
    throw new Error("hashcat already running on BIGRED. Wait or kill it first.");
  }

  // 4. Run attack
  const { durationSeconds } = runAttack(config, batchName);

  // 5. Auto-collect results
  collectResults(config, batchName, durationSeconds);
}

// =============================================================================
// CLI
// =============================================================================

if (import.meta.main) {
  const args = process.argv.slice(2);

  let batchNumber: number | undefined;
  let statusFlag = false;
  let collectFlag = false;
  let dryRunFlag = false;
  let nextFlag = false;
  let allFlag = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--batch": batchNumber = parseInt(args[++i]); break;
      case "--next": nextFlag = true; break;
      case "--all": allFlag = true; break;
      case "--status": statusFlag = true; break;
      case "--collect": collectFlag = true; break;
      case "--dry-run": dryRunFlag = true; break;
      case "--help":
      case "-h":
        console.log(`
GravelProcessor - Stage 1: GRAVEL → PEARLS + SAND on BIGRED

Usage:
  bun Tools/GravelProcessor.ts --batch 1           Process one batch (upload, attack, collect)
  bun Tools/GravelProcessor.ts --next              Process next unprocessed batch
  bun Tools/GravelProcessor.ts --all               Process ALL remaining batches (walk away mode)
  bun Tools/GravelProcessor.ts --batch 1 --collect Collect results only (fallback if collection failed)
  bun Tools/GravelProcessor.ts --batch 1 --dry-run Preview what would happen (touches nothing)
  bun Tools/GravelProcessor.ts --status            Show gravel-state summary

Stage 1 Attack: nocap.txt x nocap.rule (~30% crack rate)
Pipeline: GRAVEL → [Stage 1] → PEARLS + SAND → [Stage 2: BigRedRunner] → DIAMONDS + GLASS
`);
        process.exit(0);
    }
  }

  // --status: show summary and exit
  if (statusFlag && batchNumber === undefined && !nextFlag && !allFlag) {
    showStatus();
    process.exit(0);
  }

  // --all: loop through every remaining batch
  if (allFlag) {
    try {
      const config = loadConfig();
      console.log(`BIGRED: ${config.user}@${config.host}`);
      console.log(`Mode: ALL — processing every remaining batch`);

      // Test connectivity
      try {
        sshCmd(config, "echo connected", 10000);
      } catch {
        console.error("ERROR: Cannot connect to BIGRED.");
        process.exit(1);
      }

      // Ensure remote dirs exist once
      sshCmd(config, `mkdir -p ${config.workDir}/{wordlists,rules,hashlists,potfiles}`, 10000);

      let completed = 0;
      let failed = 0;
      const allStart = Date.now();

      while (true) {
        const next = getNextBatch();
        if (!next) {
          console.log(`\nNo more batches to process.`);
          break;
        }

        try {
          processBatch(config, next);
          completed++;
        } catch (e) {
          console.error(`\nERROR on ${next}: ${(e as Error).message}`);
          failed++;
          if (failed >= 3) {
            console.error(`3 consecutive failures — stopping.`);
            break;
          }
          // Wait before retry on next batch
          console.log(`Waiting 30s before next batch...`);
          sleepSync(30000);
          continue;
        }
        // Reset failure counter on success
        failed = 0;

        // Progress summary
        const state = loadState();
        const totalBatches = existsSync(GRAVEL_DIR)
          ? readdirSync(GRAVEL_DIR).filter(f => f.match(/^batch-\d{4}\.txt$/)).length
          : 0;
        const remaining = totalBatches - Object.keys(state.batches).length;
        const elapsed = formatDuration((Date.now() - allStart) / 1000);
        console.log(`\n--- Progress: ${Object.keys(state.batches).length}/${totalBatches} complete, ${remaining} remaining, ${elapsed} elapsed ---\n`);
      }

      const totalElapsed = formatDuration((Date.now() - allStart) / 1000);
      console.log(`\n${"=".repeat(60)}`);
      console.log(`ALL DONE: ${completed} batches processed in ${totalElapsed}`);
      if (failed > 0) console.log(`  ${failed} failures`);
      showStatus();

    } catch (e) {
      console.error(`\nFatal error: ${(e as Error).message}`);
      process.exit(1);
    }
    process.exit(0);
  }

  // Resolve batch name for single-batch modes
  let batchName: string;

  if (nextFlag) {
    const next = getNextBatch();
    if (!next) {
      console.log("No pending gravel batches to process.");
      process.exit(0);
    }
    batchName = next;
    console.log(`Next batch: ${batchName}`);
  } else if (batchNumber !== undefined) {
    batchName = `batch-${String(batchNumber).padStart(4, "0")}`;
  } else {
    console.error("ERROR: --batch <n>, --next, or --all required (or --status for summary)");
    process.exit(1);
  }

  // --dry-run: print plan, touch NOTHING, exit
  if (dryRunFlag) {
    dryRun(batchName);
    process.exit(0);
  }

  // --collect: just collect results
  if (collectFlag) {
    try {
      const config = loadConfig();
      try { sshCmd(config, "echo connected", 10000); } catch {
        console.error("ERROR: Cannot connect to BIGRED.");
        process.exit(1);
      }
      collectResults(config, batchName, 0);
    } catch (e) {
      console.error(`\nError: ${(e as Error).message}`);
      process.exit(1);
    }
    process.exit(0);
  }

  // Single batch processing
  try {
    const config = loadConfig();
    console.log(`BIGRED: ${config.user}@${config.host}`);

    try { sshCmd(config, "echo connected", 10000); } catch {
      console.error("ERROR: Cannot connect to BIGRED.");
      process.exit(1);
    }

    sshCmd(config, `mkdir -p ${config.workDir}/{wordlists,rules,hashlists,potfiles}`, 10000);
    processBatch(config, batchName);

  } catch (e) {
    console.error(`\nError: ${(e as Error).message}`);
    process.exit(1);
  }
}
