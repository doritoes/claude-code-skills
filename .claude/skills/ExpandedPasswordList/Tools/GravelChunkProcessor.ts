#!/usr/bin/env bun
/**
 * GravelChunkProcessor.ts - Chunked Stage 1: ALL GRAVEL → PEARLS + SAND on BIGRED
 *
 * Processes all gravel batches by grouping into optimal chunks (14 batches
 * = ~7M hashes), running one hashcat attack per chunk (nocap.txt × nocap.rule),
 * then distributing results back to per-batch PEARLS and SAND.
 *
 * Why 14 batches per chunk?
 *   RTX 4060 Ti hash-lookup speed degrades above 5M hashes for mask attacks,
 *   but dict+rules (nocap.txt × nocap.rule) runs at ~4.3 GH/s — well below
 *   the lookup ceiling until ~8M hashes. 14 batches (7M) stays in the flat
 *   zone with zero speed loss while amortizing hashcat startup across more
 *   batches → ~14× faster than per-batch processing.
 *
 * Usage:
 *   bun Tools/GravelChunkProcessor.ts                           Process all remaining gravel
 *   bun Tools/GravelChunkProcessor.ts --dry-run                 Preview plan (read-only, no SSH)
 *   bun Tools/GravelChunkProcessor.ts --status                  Show progress
 *   bun Tools/GravelChunkProcessor.ts --collect-chunk 1         Re-collect chunk 1 results (fallback)
 *   bun Tools/GravelChunkProcessor.ts --batches-per-chunk 20    Override chunk size
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
  statSync,
  renameSync,
} from "node:fs";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { DATA_DIR, GRAVEL_DIR, SAND_DIR, PEARLS_DIR, HASH_TYPE_SHA1, decodeHexPlain } from "./config";
import { loadConfig, sshCmd, scpUpload, scpDownload, type BigRedConfig } from "./BigRedSync";

// =============================================================================
// Constants
// =============================================================================

const GRAVEL_STATE_PATH = resolve(DATA_DIR, "gravel-state.json");
const TMP_DIR = resolve(DATA_DIR, "tmp");
const DEFAULT_BATCHES_PER_CHUNK = 14; // 14 × 500K = 7M hashes: optimal for dict+rules on RTX 4060 Ti

// =============================================================================
// State Management — Compatible with GravelProcessor.ts
// =============================================================================

interface GravelBatchState {
  status: "completed";
  hashCount: number;
  pearlCount: number;
  sandCount: number;
  crackRate: string;
  durationSeconds: number;
  completedAt: string;
  chunk?: number;
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
    const raw = JSON.parse(readFileSync(GRAVEL_STATE_PATH, "utf-8"));
    return {
      version: raw.version || "3.0",
      batches: raw.batches || {},
      totalProcessed: raw.totalProcessed || Object.keys(raw.batches || {}).length,
      totalPearls: raw.totalPearls || 0,
      totalSand: raw.totalSand || 0,
      lastUpdated: raw.lastUpdated || null,
    };
  }
  return {
    version: "3.0",
    batches: {},
    totalProcessed: 0,
    totalPearls: 0,
    totalSand: 0,
    lastUpdated: null,
  };
}

function saveState(state: GravelState): void {
  state.lastUpdated = new Date().toISOString();
  state.totalProcessed = Object.keys(state.batches).length;
  state.totalPearls = Object.values(state.batches).reduce((s, b) => s + b.pearlCount, 0);
  state.totalSand = Object.values(state.batches).reduce((s, b) => s + b.sandCount, 0);
  const tmpPath = GRAVEL_STATE_PATH + ".tmp";
  writeFileSync(tmpPath, JSON.stringify(state, null, 2));
  renameSync(tmpPath, GRAVEL_STATE_PATH);
}

// =============================================================================
// Gravel Discovery & Chunking
// =============================================================================

function discoverGravelBatches(): string[] {
  if (!existsSync(GRAVEL_DIR)) {
    throw new Error(`GRAVEL_DIR not found: ${GRAVEL_DIR}`);
  }
  return readdirSync(GRAVEL_DIR)
    .filter(f => /^batch-\d{4}\.txt$/.test(f))
    .sort()
    .map(f => f.replace(".txt", ""));
}

function getPendingBatches(): string[] {
  const state = loadState();
  return discoverGravelBatches().filter(b => !state.batches[b]);
}

function chunkArray<T>(arr: T[], chunkSize: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += chunkSize) {
    result.push(arr.slice(i, i + chunkSize));
  }
  return result;
}

function chunkName(index: number): string {
  return `chunk-${String(index).padStart(3, "0")}`;
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
      if (attempt > 1) console.log(`  Reconnected after ${attempt} attempt(s).`);
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
    return parseInt(sshCmd(config, "pgrep -c hashcat 2>/dev/null || echo 0")) > 0;
  } catch { return false; }
}

function isScreenAlive(config: BigRedConfig, name: string): boolean {
  try {
    return parseInt(sshCmd(config, `screen -ls 2>/dev/null | grep -c '${name}' || echo 0`)) > 0;
  } catch { return false; }
}

function isLogComplete(config: BigRedConfig, logFile: string): boolean {
  try {
    return parseInt(sshCmd(config, `grep -c -E '^Status\\.\\.+: (Exhausted|Cracked)' ${logFile} 2>/dev/null || echo 0`, 5000)) > 0;
  } catch { return false; }
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(0)}s`;
  if (seconds < 3600) return `${(seconds / 60).toFixed(1)}m`;
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  return `${hrs}h ${mins}m`;
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)}GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${bytes}B`;
}

// =============================================================================
// Ensure Attack Files on BIGRED
// =============================================================================

function ensureAttackFiles(config: BigRedConfig): boolean {
  const files: Record<string, { local: string; remote: string }> = {
    "nocap.txt":  { local: resolve(DATA_DIR, "nocap.txt"),  remote: "wordlists/nocap.txt" },
    "nocap.rule": { local: resolve(DATA_DIR, "nocap.rule"), remote: "rules/nocap.rule" },
  };

  for (const [name, paths] of Object.entries(files)) {
    const remotePath = `${config.workDir}/${paths.remote}`;
    let remoteSize = 0;
    try {
      remoteSize = parseInt(sshCmd(config, `stat -c %s ${remotePath} 2>/dev/null || echo 0`));
    } catch { /* missing */ }

    if (remoteSize > 0) {
      console.log(`  ${name}: present (${formatSize(remoteSize)})`);
      continue;
    }

    if (!existsSync(paths.local)) {
      console.error(`  FAIL: ${name} missing on BIGRED and locally at ${paths.local}`);
      return false;
    }

    console.log(`  ${name}: uploading...`);
    const remoteDir = paths.remote.substring(0, paths.remote.lastIndexOf("/"));
    sshCmd(config, `mkdir -p ${config.workDir}/${remoteDir}`, 10000);
    scpUpload(config, paths.local, remotePath);
    console.log(`  ${name}: uploaded (${formatSize(statSync(paths.local).size)})`);
  }
  return true;
}

// =============================================================================
// Build Chunk File — Concatenate batch files into one hashlist
// =============================================================================

function buildChunkFile(batchNames: string[], chunkIdx: number): { chunkPath: string; totalHashes: number } {
  if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });

  const cn = chunkName(chunkIdx);
  const chunkPath = resolve(TMP_DIR, `${cn}.txt`);

  writeFileSync(chunkPath, ""); // truncate
  let totalHashes = 0;

  for (let i = 0; i < batchNames.length; i++) {
    const gravelPath = resolve(GRAVEL_DIR, `${batchNames[i]}.txt`);
    if (!existsSync(gravelPath)) {
      console.error(`  WARNING: Missing ${gravelPath}, skipping`);
      continue;
    }

    const content = readFileSync(gravelPath, "utf-8");
    const hashes = content.trim().split(/\r?\n/).map(h => h.trim()).filter(h => h.length === 40);
    totalHashes += hashes.length;

    if (hashes.length > 0) {
      appendFileSync(chunkPath, hashes.join("\n") + "\n");
    }
  }

  const fileSize = statSync(chunkPath).size;
  console.log(`  Built ${cn}: ${totalHashes.toLocaleString()} hashes (${formatSize(fileSize)}) from ${batchNames.length} batches`);
  return { chunkPath, totalHashes };
}

// =============================================================================
// Run Hashcat — Screen session with resume support
// =============================================================================

function runChunkAttack(config: BigRedConfig, chunkIdx: number): number {
  const cn = chunkName(chunkIdx);
  const screenName = `gcp-${cn}`;
  const logFile = `${config.workDir}/hashcat-${cn}.log`;
  const potPath = `${config.workDir}/potfiles/${cn}.pot`;
  const hashcatCmd = `hashcat -m ${HASH_TYPE_SHA1} hashlists/${cn}.txt wordlists/nocap.txt -r rules/nocap.rule --potfile-path potfiles/${cn}.pot -O -w 3 --status --status-timer 60`;

  const startTime = Date.now();

  // Resume detection
  const screenUp = isScreenAlive(config, screenName);
  const hcRunning = isHashcatRunning(config);

  if (screenUp) {
    console.log(`  RESUMING: screen '${screenName}' still running`);
  } else if (hcRunning) {
    throw new Error("hashcat is already running on BIGRED (not this chunk). Wait or kill it.");
  } else {
    // Fresh launch
    try { sshCmd(config, `screen -X -S ${screenName} quit 2>/dev/null; rm -f ${logFile}`, 10000); } catch { /* ignore */ }

    const escapedCmd = hashcatCmd.replace(/'/g, "'\\''");
    sshCmd(config, `screen -dmS ${screenName} bash -c 'cd ${config.workDir} && ${escapedCmd} > ${logFile} 2>&1'`, 15000);
    console.log(`  Launched in screen: ${screenName}`);
    sleepSync(3000);

    if (!isHashcatRunning(config) && !isScreenAlive(config, screenName)) {
      try { console.error(sshCmd(config, `cat ${logFile} 2>/dev/null || echo '(no log)'`, 10000)); } catch { /* ignore */ }
      throw new Error("hashcat failed to start");
    }
  }

  // Poll for completion
  const POLL_INTERVAL = 30000;
  const MAX_WAIT = 6 * 60 * 60 * 1000;
  let notRunningCount = 0;

  while (Date.now() - startTime < MAX_WAIT) {
    sleepSync(POLL_INTERVAL);

    try {
      const running = isHashcatRunning(config) || isScreenAlive(config, screenName);
      const logDone = isLogComplete(config, logFile);
      const elapsed = formatDuration((Date.now() - startTime) / 1000);

      if (running) {
        notRunningCount = 0;
        let info = "";
        try {
          const progress = sshCmd(config, `grep '^Progress' ${logFile} 2>/dev/null | tail -1`, 5000);
          if (progress.trim()) info = ` | ${progress.trim()}`;
        } catch { /* ignore */ }

        let potCount = 0;
        try { potCount = parseInt(sshCmd(config, `test -f ${potPath} && wc -l < ${potPath} || echo 0`)) || 0; } catch { /* ignore */ }

        console.log(`  [${elapsed}] running — ${potCount.toLocaleString()} cracks${info}`);
      } else if (logDone) {
        console.log(`  [${elapsed}] hashcat finished.`);
        break;
      } else {
        notRunningCount++;
        console.log(`  [${elapsed}] not detected (check ${notRunningCount}/2)`);
        if (notRunningCount >= 2) break;
      }
    } catch {
      const elapsed = formatDuration((Date.now() - startTime) / 1000);
      console.log(`  [${elapsed}] SSH lost — hashcat safe in screen. Reconnecting...`);
      if (!waitForConnection(config, 300000)) break;
    }
  }

  // Final potfile count
  let potLines = 0;
  try { potLines = parseInt(sshCmd(config, `test -f ${potPath} && wc -l < ${potPath} || echo 0`)) || 0; } catch { /* ignore */ }

  const duration = (Date.now() - startTime) / 1000;
  console.log(`  Done: ${potLines.toLocaleString()} cracks in ${formatDuration(duration)}`);

  try { sshCmd(config, `screen -X -S ${screenName} quit 2>/dev/null || true`, 5000); } catch { /* ignore */ }

  return duration;
}

// =============================================================================
// Collect & Distribute — Download potfile, split to per-batch PEARLS + SAND
// =============================================================================

function collectChunkResults(
  config: BigRedConfig,
  chunkIdx: number,
  batchNames: string[],
  durationSeconds: number,
): { totalPearls: number; totalSand: number } {
  const cn = chunkName(chunkIdx);

  for (const dir of [PEARLS_DIR, SAND_DIR]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  // Download potfile to tmp
  const localPotPath = resolve(TMP_DIR, `${cn}.pot`);
  const remotePotPath = `${config.workDir}/potfiles/${cn}.pot`;

  console.log(`  Downloading potfile...`);
  scpDownload(config, remotePotPath, localPotPath, 1200000);

  if (!existsSync(localPotPath)) {
    console.error(`  ERROR: Potfile not found after download`);
    return { totalPearls: 0, totalSand: 0 };
  }

  console.log(`  Potfile: ${formatSize(statSync(localPotPath).size)}`);

  // Load potfile into Map<hash, plaintext> for O(1) per-batch lookups.
  // At 10 batches × 500K × 30% ≈ 1.5M entries × ~200 bytes ≈ 300MB — fits in RAM.
  console.log(`  Loading potfile into memory...`);
  const potMap = new Map<string, string>();
  const potContent = readFileSync(localPotPath, "utf-8");
  for (const line of potContent.split("\n")) {
    if (line.length < 42) continue; // min: 40 hex + ":" + 1 char
    const colonIdx = line.indexOf(":");
    if (colonIdx !== 40) continue;
    const hash = line.slice(0, 40).toLowerCase();
    const rawPlain = line.slice(41).replace(/\r$/, "");
    potMap.set(hash, decodeHexPlain(rawPlain));
  }
  console.log(`  Loaded ${potMap.size.toLocaleString()} cracked hashes`);

  // Distribute to per-batch PEARLS + SAND
  const state = loadState();
  const pearlsJsonlPath = resolve(PEARLS_DIR, "hash_plaintext_pairs.jsonl");
  let totalPearls = 0;
  let totalSand = 0;

  for (let i = 0; i < batchNames.length; i++) {
    const batchName = batchNames[i];

    // Skip already-completed batches (resume safety)
    if (state.batches[batchName]) continue;

    const gravelPath = resolve(GRAVEL_DIR, `${batchName}.txt`);
    if (!existsSync(gravelPath)) {
      console.error(`  WARNING: Missing ${gravelPath}, skipping`);
      continue;
    }

    const gravelContent = readFileSync(gravelPath, "utf-8");
    const gravelHashes = gravelContent.trim().split(/\r?\n/).map(h => h.trim()).filter(h => h.length === 40);
    const hashCount = gravelHashes.length;

    // Split: cracked → PEARLS, uncracked → SAND
    const pearls: { hash: string; plain: string }[] = [];
    const sandHashes: string[] = [];

    for (const h of gravelHashes) {
      const lower = h.toLowerCase();
      const plain = potMap.get(lower);
      if (plain !== undefined) {
        pearls.push({ hash: lower, plain });
      } else {
        sandHashes.push(h);
      }
    }

    // Invariant: PEARLS + SAND = GRAVEL
    if (pearls.length + sandHashes.length !== hashCount) {
      console.error(`  INVARIANT VIOLATION: ${batchName}: ${pearls.length}+${sandHashes.length} != ${hashCount}`);
    }

    // Write PEARLS (append to JSONL) — BEFORE state save (safe failure mode: duplicates, not loss)
    if (pearls.length > 0) {
      appendFileSync(pearlsJsonlPath, pearls.map(p => JSON.stringify(p)).join("\n") + "\n");
    }

    // Write SAND (compressed)
    const sandPath = resolve(SAND_DIR, `${batchName}.txt.gz`);
    writeFileSync(sandPath, gzipSync(Buffer.from(sandHashes.join("\n") + "\n")));

    // Update state — AFTER writing outputs
    const crackRate = hashCount > 0 ? (pearls.length / hashCount * 100).toFixed(2) : "0.00";
    state.batches[batchName] = {
      status: "completed",
      hashCount,
      pearlCount: pearls.length,
      sandCount: sandHashes.length,
      crackRate,
      durationSeconds: 0, // chunk duration, not per-batch
      completedAt: new Date().toISOString(),
      chunk: chunkIdx,
    };

    totalPearls += pearls.length;
    totalSand += sandHashes.length;

    // Progress + periodic state save
    if ((i + 1) % 5 === 0 || i === batchNames.length - 1) {
      const rate = hashCount > 0 ? (pearls.length / hashCount * 100).toFixed(1) : "0";
      console.log(`  [${i + 1}/${batchNames.length}] ${batchName}: ${pearls.length.toLocaleString()} pearls, ${sandHashes.length.toLocaleString()} sand (${rate}%)`);
      saveState(state);
    }
  }

  // Final save
  saveState(state);

  // Clean up local potfile
  try { unlinkSync(localPotPath); } catch { /* ignore */ }

  return { totalPearls, totalSand };
}

// =============================================================================
// Clean Up BIGRED
// =============================================================================

function cleanupBigred(config: BigRedConfig, chunkIdx: number): void {
  const cn = chunkName(chunkIdx);
  // Hard failure — leftover files fill disk
  sshCmd(config, [
    `rm -f ${config.workDir}/hashlists/${cn}.txt`,
    `rm -f ${config.workDir}/potfiles/${cn}.pot`,
    `rm -f ${config.workDir}/hashcat-${cn}.log`,
  ].join(" && "), 120000);
}

// =============================================================================
// Process One Chunk — build → upload → attack → collect → cleanup
// =============================================================================

function processChunk(config: BigRedConfig, chunkIdx: number, batchNames: string[]): void {
  const cn = chunkName(chunkIdx);
  const first = batchNames[0];
  const last = batchNames[batchNames.length - 1];

  console.log(`\n${"═".repeat(70)}`);
  console.log(`CHUNK ${chunkIdx} — ${cn} — ${batchNames.length} batches (${first}..${last})`);
  console.log("═".repeat(70));

  // Filter out already-completed batches in this chunk
  const state = loadState();
  const pending = batchNames.filter(b => !state.batches[b]);
  if (pending.length === 0) {
    console.log(`  All ${batchNames.length} batches already completed. Skipping.`);
    return;
  }
  if (pending.length < batchNames.length) {
    console.log(`  ${batchNames.length - pending.length} already done, processing ${pending.length} remaining`);
  }

  // 1. Build chunk file
  console.log(`\n  Step 1: Build chunk hashlist`);
  const { chunkPath, totalHashes } = buildChunkFile(pending, chunkIdx);

  if (totalHashes === 0) {
    console.error(`  ERROR: Zero hashes in chunk. Skipping.`);
    try { unlinkSync(chunkPath); } catch { /* ignore */ }
    return;
  }

  // 2. Upload to BIGRED
  console.log(`\n  Step 2: Upload to BIGRED`);
  const remoteHashlist = `${config.workDir}/hashlists/${cn}.txt`;
  scpUpload(config, chunkPath, remoteHashlist, 1200000);
  console.log(`  Uploaded.`);
  try { unlinkSync(chunkPath); } catch { /* ignore */ }

  // 3. Run hashcat
  console.log(`\n  Step 3: Run hashcat`);
  const durationSeconds = runChunkAttack(config, chunkIdx);

  // 4. Collect results
  console.log(`\n  Step 4: Collect & distribute results`);
  const { totalPearls, totalSand } = collectChunkResults(config, chunkIdx, pending, durationSeconds);

  // 5. Clean up BIGRED
  console.log(`\n  Step 5: Cleanup`);
  cleanupBigred(config, chunkIdx);

  const rate = (totalPearls + totalSand) > 0
    ? (totalPearls / (totalPearls + totalSand) * 100).toFixed(2)
    : "0";
  console.log(`\n  ${cn} complete: ${totalPearls.toLocaleString()} pearls, ${totalSand.toLocaleString()} sand (${rate}%)`);
}

// =============================================================================
// Main Run — Process all remaining gravel
// =============================================================================

function run(config: BigRedConfig, batchesPerChunk: number): void {
  const pending = getPendingBatches();
  if (pending.length === 0) {
    console.log("\nAll gravel batches already processed.");
    showStatus();
    return;
  }

  const chunks = chunkArray(pending, batchesPerChunk);

  console.log(`\nProcessing ${pending.length.toLocaleString()} batches in ${chunks.length} chunks (${batchesPerChunk} batches/chunk)`);
  console.log(`Attack: nocap.txt × nocap.rule`);
  console.log(`Estimated time: ~${formatDuration(chunks.length * 228)}`);

  // Ensure attack files once
  console.log(`\nChecking attack files...`);
  if (!ensureAttackFiles(config)) {
    throw new Error("Attack files missing — run bun Tools/BigRedSync.ts first");
  }

  const overallStart = Date.now();
  let completed = 0;
  let consecutiveFailures = 0;

  for (let i = 0; i < chunks.length; i++) {
    try {
      processChunk(config, i + 1, chunks[i]);
      completed++;
      consecutiveFailures = 0;

      // Progress
      const elapsed = formatDuration((Date.now() - overallStart) / 1000);
      const remaining = chunks.length - (i + 1);
      const avgPerChunk = (Date.now() - overallStart) / 1000 / (i + 1);
      const eta = formatDuration(remaining * avgPerChunk);
      console.log(`\n--- ${i + 1}/${chunks.length} chunks done (${elapsed} elapsed, ~${eta} remaining) ---`);
    } catch (e) {
      console.error(`\nERROR on chunk ${i + 1}: ${(e as Error).message}`);
      consecutiveFailures++;
      if (consecutiveFailures >= 3) {
        console.error("3 consecutive chunk failures — stopping.");
        break;
      }
      console.log("Waiting 30s before next chunk...");
      sleepSync(30000);
    }
  }

  // Summary
  const totalElapsed = formatDuration((Date.now() - overallStart) / 1000);
  const state = loadState();
  const rate = state.totalPearls + state.totalSand > 0
    ? (state.totalPearls / (state.totalPearls + state.totalSand) * 100).toFixed(2)
    : "0";

  console.log(`\n${"═".repeat(70)}`);
  console.log(`ALL DONE — ${completed} chunks in ${totalElapsed}`);
  console.log("═".repeat(70));
  console.log(`PEARLS: ${state.totalPearls.toLocaleString()}`);
  console.log(`SAND:   ${state.totalSand.toLocaleString()}`);
  console.log(`Rate:   ${rate}%`);
  console.log(`\nSAND ready for Stage 2: bun Tools/BigRedRunner.ts --next`);
}

// =============================================================================
// Dry Run — Purely read-only: no SSH, no state writes, no uploads
// =============================================================================

function dryRun(batchesPerChunk: number): void {
  const pending = getPendingBatches();
  const allBatches = discoverGravelBatches();
  const chunks = chunkArray(pending, batchesPerChunk);

  console.log("\n=== DRY RUN: Chunking Plan ===");
  console.log("This is read-only. No files uploaded, no state written, no SSH.\n");

  console.log(`Total gravel batches: ${allBatches.length.toLocaleString()}`);
  console.log(`Already completed:    ${(allBatches.length - pending.length).toLocaleString()}`);
  console.log(`Pending:              ${pending.length.toLocaleString()}`);
  console.log(`Batches per chunk:    ${batchesPerChunk}`);
  console.log(`Chunks:               ${chunks.length}`);
  console.log(`Attack:               nocap.txt × nocap.rule`);

  // Check attack files exist locally
  const nocapPath = resolve(DATA_DIR, "nocap.txt");
  const rulePath = resolve(DATA_DIR, "nocap.rule");
  console.log(`\nAttack files (local):`);
  console.log(`  nocap.txt:  ${existsSync(nocapPath) ? formatSize(statSync(nocapPath).size) : "NOT FOUND"}`);
  console.log(`  nocap.rule: ${existsSync(rulePath) ? formatSize(statSync(rulePath).size) : "NOT FOUND"}`);

  // Sample first batch for hash count estimate
  let sampleCount = 0;
  if (pending.length > 0) {
    const samplePath = resolve(GRAVEL_DIR, `${pending[0]}.txt`);
    if (existsSync(samplePath)) {
      sampleCount = readFileSync(samplePath, "utf-8").trim().split(/\r?\n/).map(h => h.trim()).filter(h => h.length === 40).length;
    }
  }

  console.log(`\nChunk plan:`);
  let totalEst = 0;
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const first = chunk[0];
    const last = chunk[chunk.length - 1];
    const estHashes = sampleCount * chunk.length;
    totalEst += estHashes;
    console.log(`  ${chunkName(i + 1)}: ${chunk.length} batches (${first}..${last}), ~${estHashes.toLocaleString()} hashes (~${formatSize(estHashes * 41)})`);
  }

  console.log(`\nTotal estimated hashes: ${totalEst.toLocaleString()} (${formatSize(totalEst * 41)})`);
  console.log(`Estimated GPU time: ~${formatDuration(chunks.length * 192)} (3.2 min/chunk at ~4.3 GH/s dict+rules)`);
  console.log(`Estimated total time: ~${formatDuration(chunks.length * 228)} (including upload/collect overhead)`);
}

// =============================================================================
// Status Display
// =============================================================================

function showStatus(): void {
  const state = loadState();
  const allBatches = discoverGravelBatches();
  const completedCount = Object.keys(state.batches).length;
  const pendingCount = allBatches.length - completedCount;

  console.log("\n=== GravelChunkProcessor Status ===\n");
  console.log(`Gravel batches:  ${allBatches.length.toLocaleString()}`);
  console.log(`  Completed:     ${completedCount.toLocaleString()}`);
  console.log(`  Pending:       ${pendingCount.toLocaleString()}`);
  console.log(`  PEARLS:        ${state.totalPearls.toLocaleString()}`);
  console.log(`  SAND:          ${state.totalSand.toLocaleString()}`);

  if (completedCount > 0) {
    const rate = (state.totalPearls / (state.totalPearls + state.totalSand) * 100).toFixed(2);
    console.log(`  Crack rate:    ${rate}%`);
  }

  if (state.lastUpdated) {
    console.log(`  Last updated:  ${state.lastUpdated}`);
  }

  // Per-chunk breakdown
  const chunkStats = new Map<number, { pearls: number; sand: number; count: number }>();
  for (const b of Object.values(state.batches)) {
    if (b.chunk === undefined) continue;
    const s = chunkStats.get(b.chunk) || { pearls: 0, sand: 0, count: 0 };
    s.pearls += b.pearlCount;
    s.sand += b.sandCount;
    s.count++;
    chunkStats.set(b.chunk, s);
  }

  if (chunkStats.size > 0) {
    console.log(`\nPer-chunk breakdown:`);
    for (const [idx, s] of [...chunkStats.entries()].sort((a, b) => a[0] - b[0])) {
      const total = s.pearls + s.sand;
      const rate = total > 0 ? (s.pearls / total * 100).toFixed(1) : "0";
      console.log(`  ${chunkName(idx)}: ${s.count} batches, ${s.pearls.toLocaleString()} pearls (${rate}%)`);
    }
  }

  // Live BIGRED status — graceful failure if unreachable
  showBigredStatus(completedCount, pendingCount);

  if (pendingCount > 0) {
    console.log(`\nResume: bun Tools/GravelChunkProcessor.ts`);
  } else {
    console.log(`\nAll batches processed. SAND ready for Stage 2.`);
  }
}

function showBigredStatus(completedCount: number, pendingCount: number): void {
  let config: BigRedConfig;
  try {
    config = loadConfig();
  } catch {
    console.log(`\nBIGRED: config not found`);
    return;
  }

  console.log(`\n--- BIGRED Live Status ---`);

  // Check connectivity
  try {
    sshCmd(config, "echo ok", 10000);
  } catch {
    console.log(`  Status: UNREACHABLE`);
    return;
  }

  console.log(`  Status: CONNECTED (${config.user}@${config.host})`);

  // Check for GCP screen sessions
  let screens = "";
  try {
    screens = sshCmd(config, "screen -ls 2>/dev/null | grep 'gcp-chunk' || echo ''", 5000).trim();
  } catch { /* ignore */ }

  const hasScreen = screens.length > 0 && !screens.startsWith("No Sockets");

  // Check if hashcat is running
  const hcRunning = isHashcatRunning(config);

  if (!hasScreen && !hcRunning) {
    console.log(`  hashcat: IDLE (no active chunks)`);

    // Show last completed chunk for context
    if (completedCount > 0 && pendingCount > 0) {
      const nextChunkIdx = Math.floor(completedCount / DEFAULT_BATCHES_PER_CHUNK) + 1;
      console.log(`  Next chunk: ${chunkName(nextChunkIdx)} (${pendingCount} batches remaining)`);
    }
    return;
  }

  // Active session found — get details
  if (hasScreen) {
    // Extract chunk name from screen session (e.g., "gcp-chunk-042")
    const match = screens.match(/gcp-(chunk-\d+)/);
    const activeChunk = match ? match[1] : "unknown";
    console.log(`  Screen: ${match ? `gcp-${activeChunk}` : screens.split("\t")[1]?.trim() || screens}`);

    const cn = activeChunk;
    const logFile = `${config.workDir}/hashcat-${cn}.log`;
    const potPath = `${config.workDir}/potfiles/${cn}.pot`;

    // Potfile cracks
    let potCount = 0;
    try {
      potCount = parseInt(sshCmd(config, `test -f ${potPath} && wc -l < ${potPath} || echo 0`, 5000)) || 0;
    } catch { /* ignore */ }
    console.log(`  Cracks: ${potCount.toLocaleString()}`);

    // Progress from log
    try {
      const progressLine = sshCmd(config, `grep '^Progress' ${logFile} 2>/dev/null | tail -1`, 5000).trim();
      if (progressLine) console.log(`  ${progressLine}`);
    } catch { /* ignore */ }

    // Speed from log
    try {
      const speedLine = sshCmd(config, `grep '^Speed' ${logFile} 2>/dev/null | tail -1`, 5000).trim();
      if (speedLine) console.log(`  ${speedLine}`);
    } catch { /* ignore */ }

    // ETA from log
    try {
      const etaLine = sshCmd(config, `grep '^Time.Estimated' ${logFile} 2>/dev/null | tail -1`, 5000).trim();
      if (etaLine) console.log(`  ${etaLine}`);
    } catch { /* ignore */ }

    // Hash target info
    try {
      const hashLine = sshCmd(config, `grep '^Hash.Target' ${logFile} 2>/dev/null | tail -1`, 5000).trim();
      if (hashLine) console.log(`  ${hashLine}`);
    } catch { /* ignore */ }
  } else if (hcRunning) {
    console.log(`  hashcat: RUNNING (no GCP screen detected — may be manual run)`);
  }

  // GPU stats (temp + utilization)
  try {
    const gpuInfo = sshCmd(config, "nvidia-smi --query-gpu=temperature.gpu,utilization.gpu --format=csv,noheader,nounits 2>/dev/null || echo ''", 5000).trim();
    if (gpuInfo && gpuInfo !== "") {
      const [temp, util] = gpuInfo.split(",").map(s => s.trim());
      console.log(`  GPU: ${util}% utilization, ${temp}°C`);
    }
  } catch { /* ignore */ }
}

// =============================================================================
// Collect Chunk — Fallback for failed collection
// =============================================================================

function collectChunkFallback(config: BigRedConfig, chunkIdx: number, batchesPerChunk: number): void {
  const pending = getPendingBatches();
  const allBatches = discoverGravelBatches();

  // We need to reconstruct which batches were in this chunk.
  // Chunks are deterministic: same ordering, same size.
  // But pending batches change as batches complete. We need the ORIGINAL chunk assignment.
  // Look at state to find which batches have this chunk index.
  const state = loadState();
  let batchNames = Object.entries(state.batches)
    .filter(([_, b]) => b.chunk === chunkIdx)
    .map(([name]) => name)
    .sort();

  // Also include pending batches that WOULD be in this chunk
  const allPending = allBatches.filter(b => !state.batches[b]);
  const pendingChunks = chunkArray(allPending, batchesPerChunk);
  if (chunkIdx - 1 < pendingChunks.length) {
    for (const b of pendingChunks[chunkIdx - 1]) {
      if (!batchNames.includes(b)) batchNames.push(b);
    }
    batchNames.sort();
  }

  if (batchNames.length === 0) {
    console.error(`ERROR: No batches found for chunk ${chunkIdx}`);
    return;
  }

  console.log(`\nRe-collecting chunk ${chunkIdx} (${batchNames.length} batches)`);
  const { totalPearls, totalSand } = collectChunkResults(config, chunkIdx, batchNames, 0);
  console.log(`  Collected: ${totalPearls.toLocaleString()} pearls, ${totalSand.toLocaleString()} sand`);
}

// =============================================================================
// CLI
// =============================================================================

if (import.meta.main) {
  const args = process.argv.slice(2);

  let dryRunFlag = false;
  let statusFlag = false;
  let collectChunk: number | undefined;
  let batchesPerChunk = DEFAULT_BATCHES_PER_CHUNK;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--dry-run":
        dryRunFlag = true;
        break;
      case "--status":
        statusFlag = true;
        break;
      case "--collect-chunk":
        collectChunk = parseInt(args[++i]);
        break;
      case "--batches-per-chunk":
        batchesPerChunk = parseInt(args[++i]);
        if (isNaN(batchesPerChunk) || batchesPerChunk < 1) {
          console.error("ERROR: --batches-per-chunk must be a positive integer");
          process.exit(1);
        }
        break;
      case "--help":
      case "-h":
        console.log(`
GravelChunkProcessor - Chunked Stage 1: ALL GRAVEL → PEARLS + SAND

Processes all gravel batches in VRAM-optimal chunks (default: 14 batches = 7M hashes).
Runs nocap.txt × nocap.rule on each chunk, distributes results to per-batch PEARLS + SAND.

Usage:
  bun Tools/GravelChunkProcessor.ts                           Process all remaining gravel
  bun Tools/GravelChunkProcessor.ts --dry-run                 Preview plan (read-only, no SSH)
  bun Tools/GravelChunkProcessor.ts --status                  Show progress
  bun Tools/GravelChunkProcessor.ts --collect-chunk 1         Re-collect chunk 1 (fallback)
  bun Tools/GravelChunkProcessor.ts --batches-per-chunk 20    Override chunk size

Why 14 batches per chunk?
  Dict+rules (nocap.txt × nocap.rule) runs at ~4.3 GH/s on RTX 4060 Ti.
  Hash-lookup stays above 4.3 GH/s up to ~8M hashes, so 7M (14 batches)
  has zero speed penalty. More batches per chunk = fewer hashcat startups.

Expected: ~30% crack rate, ~20 hours for all 4,328 batches.
Pipeline: GRAVEL → [GravelChunkProcessor] → PEARLS + SAND → [BigRedRunner Stage 2] → DIAMONDS + GLASS
`);
        process.exit(0);
    }
  }

  if (statusFlag) {
    showStatus();
    process.exit(0);
  }

  if (dryRunFlag) {
    dryRun(batchesPerChunk);
    process.exit(0);
  }

  // Modes requiring SSH
  try {
    const config = loadConfig();
    console.log(`BIGRED: ${config.user}@${config.host}`);

    try { sshCmd(config, "echo connected", 10000); } catch {
      console.error("ERROR: Cannot connect to BIGRED.");
      process.exit(1);
    }

    sshCmd(config, `mkdir -p ${config.workDir}/{wordlists,rules,hashlists,potfiles}`, 10000);

    if (collectChunk !== undefined) {
      collectChunkFallback(config, collectChunk, batchesPerChunk);
    } else {
      console.log(`Stage 1 (GRAVEL → PEARLS + SAND) — Chunked Mode`);
      run(config, batchesPerChunk);
    }
  } catch (e) {
    console.error(`\nError: ${(e as Error).message}`);
    process.exit(1);
  }
}
