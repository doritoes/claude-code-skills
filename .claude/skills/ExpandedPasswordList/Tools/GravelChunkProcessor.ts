#!/usr/bin/env bun
/**
 * GravelChunkProcessor.ts - Chunked Stage 1: ALL GRAVEL → PEARLS + SAND on BIGRED
 *
 * Processes all 4,328 gravel batches by grouping them into chunks (~433 batches each),
 * concatenating into a single hashlist per chunk, running one hashcat attack
 * (nocap.txt + nocap.rule), then distributing results back to per-batch PEARLS + SAND.
 *
 * This replaces the per-batch 8-attack GravelProcessor approach:
 *   - nocap+nocap.rule = 29.99% crack rate (benchmarked across all batches)
 *   - brute-1 through brute-7 are redundant (Stage 2 runs them on SAND anyway)
 *   - 1 attack per chunk vs 8 per batch = massive time savings
 *
 * Usage:
 *   bun Tools/GravelChunkProcessor.ts --run                Process all gravel (40 chunks)
 *   bun Tools/GravelChunkProcessor.ts --run --chunks 50    Use 50 chunks instead of 40
 *   bun Tools/GravelChunkProcessor.ts --status             Show progress
 *   bun Tools/GravelChunkProcessor.ts --dry-run            Preview chunking plan
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
} from "node:fs";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { DATA_DIR, GRAVEL_DIR, SAND_DIR, PEARLS_DIR, HASH_TYPE_SHA1, decodeHexPlain } from "./config";
import { loadConfig, sshCmd, scpUpload, scpDownload, type BigRedConfig } from "./BigRedSync";

// =============================================================================
// Constants
// =============================================================================

const GRAVEL_STATE_PATH = resolve(DATA_DIR, "gravel-state.json");
const DEFAULT_CHUNKS = 40;

// =============================================================================
// State Management
// =============================================================================

interface ChunkBatchState {
  status: "pending" | "completed";
  pearlCount: number;
  sandCount: number;
  chunk: number;
}

interface GravelChunkState {
  version: string;
  attack: string;
  chunks: number;
  currentChunk: number;
  batches: Record<string, ChunkBatchState>;
  lastUpdated: string | null;
}

function loadState(): GravelChunkState {
  if (existsSync(GRAVEL_STATE_PATH)) {
    const raw = JSON.parse(readFileSync(GRAVEL_STATE_PATH, "utf-8"));
    // If it has the chunk fields, it's our format
    if (raw.version === "2.0" && raw.chunks !== undefined) {
      return raw as GravelChunkState;
    }
    // Otherwise it's the old v2.0 format — migrate
    return {
      version: "2.0",
      attack: raw.attack || "nocap-nocaprule",
      chunks: DEFAULT_CHUNKS,
      currentChunk: 0,
      batches: {},
      lastUpdated: null,
    };
  }
  return {
    version: "2.0",
    attack: "nocap-nocaprule",
    chunks: DEFAULT_CHUNKS,
    currentChunk: 0,
    batches: {},
    lastUpdated: null,
  };
}

function saveState(state: GravelChunkState): void {
  state.lastUpdated = new Date().toISOString();
  const tmpPath = GRAVEL_STATE_PATH + ".new";
  writeFileSync(tmpPath, JSON.stringify(state, null, 2));
  // Atomic rename
  const { renameSync } = require("node:fs");
  renameSync(tmpPath, GRAVEL_STATE_PATH);
}

// =============================================================================
// Gravel Batch Discovery
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

function chunkArray<T>(arr: T[], numChunks: number): T[][] {
  const result: T[][] = [];
  const chunkSize = Math.ceil(arr.length / numChunks);
  for (let i = 0; i < arr.length; i += chunkSize) {
    result.push(arr.slice(i, i + chunkSize));
  }
  return result;
}

// =============================================================================
// SSH / Screen Helpers (from GravelProcessor patterns)
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
// Chunk Building
// =============================================================================

/**
 * Build a chunk file by streaming gravel batch files to disk.
 * Writes incrementally to avoid holding ~8GB in memory.
 */
function buildChunkFile(
  batchNames: string[],
  chunkIndex: number,
  tmpDir: string,
): { chunkPath: string; totalHashes: number } {
  const chunkName = `chunk-${String(chunkIndex).padStart(2, "0")}`;
  const chunkPath = resolve(tmpDir, `${chunkName}.txt`);

  console.log(`\nBuilding ${chunkName} from ${batchNames.length} batches...`);

  // Truncate the file first
  writeFileSync(chunkPath, "");

  let totalHashes = 0;

  for (let bi = 0; bi < batchNames.length; bi++) {
    const batchName = batchNames[bi];
    const gravelPath = resolve(GRAVEL_DIR, `${batchName}.txt`);
    if (!existsSync(gravelPath)) {
      console.error(`  WARNING: Missing gravel batch: ${gravelPath}`);
      continue;
    }
    const content = readFileSync(gravelPath, "utf-8");
    const hashes = content.trim().split(/\r?\n/).map(h => h.trim()).filter(h => h.length === 40);
    totalHashes += hashes.length;

    // Append to chunk file — one batch at a time (~17MB each)
    if (hashes.length > 0) {
      appendFileSync(chunkPath, hashes.join("\n") + "\n");
    }

    if ((bi + 1) % 100 === 0) {
      console.log(`  [${bi + 1}/${batchNames.length}] ${totalHashes.toLocaleString()} hashes so far...`);
    }
  }

  const fileSize = statSync(chunkPath).size;
  console.log(`  ${chunkName}: ${totalHashes.toLocaleString()} hashes (${formatSize(fileSize)})`);

  return { chunkPath, totalHashes };
}

// =============================================================================
// Hashcat Execution
// =============================================================================

function runHashcatOnChunk(
  config: BigRedConfig,
  chunkIndex: number,
): { potfileLines: number; durationSeconds: number } {
  const chunkName = `chunk-${String(chunkIndex).padStart(2, "0")}`;
  const screenName = `gcp-${chunkName}`;
  const logFile = `${config.workDir}/hashcat-${chunkName}.log`;
  const hashcatCmd = `hashcat -m ${HASH_TYPE_SHA1} hashlists/${chunkName}.txt wordlists/nocap.txt -r rules/nocap.rule --potfile-path potfiles/${chunkName}.pot -O -w 3 --status --status-timer 60`;

  console.log(`\nRunning hashcat on ${chunkName}...`);
  console.log(`  Command: ${hashcatCmd}`);

  if (isHashcatRunning(config)) {
    throw new Error("hashcat is already running on BIGRED — wait for it to finish");
  }

  const startTime = Date.now();

  // Clean up any previous session
  try {
    sshCmd(config, `screen -X -S ${screenName} quit 2>/dev/null; rm -f ${logFile}`, 10000);
  } catch { /* ignore */ }

  // Launch in screen
  const escapedCmd = hashcatCmd.replace(/'/g, "'\\''");
  const screenCmd = `screen -dmS ${screenName} bash -c 'cd ${config.workDir} && ${escapedCmd} > ${logFile} 2>&1'`;
  sshCmd(config, screenCmd, 15000);

  console.log(`  Screen session: ${screenName}`);
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
      const elapsed = formatDuration((Date.now() - startTime) / 1000);

      if (hcRunning || screenUp) {
        notRunningCount = 0;
        let progressInfo = "";
        try {
          const progress = sshCmd(config, `grep '^Progress' ${logFile} 2>/dev/null | tail -1`, 5000);
          if (progress.trim()) progressInfo = ` | ${progress.trim()}`;
        } catch { /* ignore */ }

        let potCount = 0;
        try {
          const result = sshCmd(config, `test -f ${config.workDir}/potfiles/${chunkName}.pot && wc -l < ${config.workDir}/potfiles/${chunkName}.pot || echo 0`);
          potCount = parseInt(result) || 0;
        } catch { /* ignore */ }

        console.log(`  [${elapsed}] running — potfile: ${potCount.toLocaleString()}${progressInfo}`);
      } else if (logDone) {
        console.log(`  [${elapsed}] hashcat finished (log confirmed).`);
        break;
      } else {
        notRunningCount++;
        console.log(`  [${elapsed}] not detected (check ${notRunningCount}/2)`);
        if (notRunningCount >= 2) {
          console.log(`  hashcat appears stopped.`);
          break;
        }
      }
    } catch {
      const elapsed = formatDuration((Date.now() - startTime) / 1000);
      console.log(`  [${elapsed}] SSH lost — hashcat safe in screen. Reconnecting...`);
      if (!waitForConnection(config, 300000)) {
        console.error("  Failed to reconnect after 5 min.");
        break;
      }
    }
  }

  // Get final potfile count
  let potfileLines = 0;
  try {
    const result = sshCmd(config, `test -f ${config.workDir}/potfiles/${chunkName}.pot && wc -l < ${config.workDir}/potfiles/${chunkName}.pot || echo 0`);
    potfileLines = parseInt(result) || 0;
  } catch { /* ignore */ }

  const durationSeconds = (Date.now() - startTime) / 1000;
  console.log(`  Completed: ${potfileLines.toLocaleString()} cracks in ${formatDuration(durationSeconds)}`);

  // Clean up screen
  try {
    sshCmd(config, `screen -X -S ${screenName} quit 2>/dev/null || true`, 5000);
  } catch { /* ignore */ }

  return { potfileLines, durationSeconds };
}

// =============================================================================
// Result Distribution — Stream potfile, distribute to per-batch PEARLS + SAND
// =============================================================================

/**
 * Stream the potfile once per batch. For each batch:
 *   1. Load batch gravel hashes into a Set (~350K entries, ~28MB)
 *   2. Stream potfile line by line
 *   3. Collect pearls (matches) and derive sand (remainder)
 *
 * Memory: only one batch Set in memory at a time (~28MB).
 * Potfile is read once per batch (~433 times for 10 chunks).
 * OS filesystem cache handles repeated reads — after first disk read,
 * subsequent passes are served from RAM at memory bandwidth speed.
 */
function streamPotfileForBatch(
  potfilePath: string,
  batchHashSet: Set<string>,
): { pearls: { hash: string; plain: string }[] } {
  const pearls: { hash: string; plain: string }[] = [];

  // Read in 64MB chunks to avoid loading entire ~3.8GB potfile into memory
  const CHUNK_SIZE = 64 * 1024 * 1024;
  const fileSize = statSync(potfilePath).size;

  const fileHandle = require("node:fs").openSync(potfilePath, "r");
  const buf = Buffer.alloc(CHUNK_SIZE);
  let leftover = "";
  let bytesRead: number;
  let offset = 0;

  while (offset < fileSize) {
    bytesRead = require("node:fs").readSync(fileHandle, buf, 0, CHUNK_SIZE, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;

    const chunk = leftover + buf.toString("utf-8", 0, bytesRead);
    const lastNewline = chunk.lastIndexOf("\n");

    let processable: string;
    if (lastNewline === -1) {
      leftover = chunk;
      continue;
    } else {
      processable = chunk.slice(0, lastNewline);
      leftover = chunk.slice(lastNewline + 1);
    }

    const lines = processable.split("\n");
    for (const line of lines) {
      if (line.length < 41) continue; // minimum: 40-char hash + ":"
      const colonIdx = line.indexOf(":");
      if (colonIdx !== 40) continue; // SHA-1 hash is exactly 40 chars
      const hash = line.slice(0, 40).toLowerCase();

      if (batchHashSet.has(hash)) {
        const rawPlain = line.slice(41).replace(/\r$/, "");
        pearls.push({ hash, plain: decodeHexPlain(rawPlain) });
        batchHashSet.delete(hash); // Remove to avoid duplicates and speed up future lookups
      }
    }
  }

  // Process leftover
  if (leftover.length > 41) {
    const colonIdx = leftover.indexOf(":");
    if (colonIdx === 40) {
      const hash = leftover.slice(0, 40).toLowerCase();
      if (batchHashSet.has(hash)) {
        const rawPlain = leftover.slice(41).replace(/\r$/, "");
        pearls.push({ hash, plain: decodeHexPlain(rawPlain) });
        batchHashSet.delete(hash);
      }
    }
  }

  require("node:fs").closeSync(fileHandle);
  return { pearls };
}

async function distributeResults(
  config: BigRedConfig,
  chunkIndex: number,
  batchNames: string[],
  state: GravelChunkState,
): Promise<{ totalPearls: number; totalSand: number }> {
  const chunkName = `chunk-${String(chunkIndex).padStart(2, "0")}`;

  // Ensure output directories
  for (const dir of [PEARLS_DIR, SAND_DIR]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  // Download potfile
  const localPotPath = resolve(PEARLS_DIR, `${chunkName}.pot`);
  const remotePotPath = `${config.workDir}/potfiles/${chunkName}.pot`;

  console.log(`\nDownloading potfile for ${chunkName}...`);
  scpDownload(config, remotePotPath, localPotPath, 1200000); // 20 min timeout for large potfiles

  if (!existsSync(localPotPath)) {
    console.error(`  ERROR: Downloaded potfile not found at ${localPotPath}`);
    return { totalPearls: 0, totalSand: 0 };
  }

  const potSize = statSync(localPotPath).size;
  console.log(`  Potfile: ${formatSize(potSize)}`);

  // Distribute to each batch by streaming potfile per-batch.
  // Each batch's Set is ~350K entries (~28MB). Potfile is streamed from
  // OS cache after first disk read (~3.8GB → ~0.4s per cached pass).
  let totalPearls = 0;
  let totalSand = 0;
  const pearlsJsonlPath = resolve(PEARLS_DIR, "hash_plaintext_pairs.jsonl");
  let batchesProcessed = 0;

  console.log(`  Distributing results to ${batchNames.length} batches...`);

  for (const batchName of batchNames) {
    // Skip already-completed batches
    if (state.batches[batchName]?.status === "completed") {
      batchesProcessed++;
      continue;
    }

    const gravelPath = resolve(GRAVEL_DIR, `${batchName}.txt`);
    if (!existsSync(gravelPath)) {
      console.error(`  WARNING: Missing gravel batch: ${gravelPath}, skipping`);
      continue;
    }

    const gravelContent = readFileSync(gravelPath, "utf-8");
    const gravelLines = gravelContent.trim().split(/\r?\n/).map(h => h.trim()).filter(h => h.length === 40);
    const gravelCount = gravelLines.length;

    // Build Set for this batch (mutable — streamPotfileForBatch deletes matches)
    const batchHashSet = new Set(gravelLines.map(h => h.toLowerCase()));

    // Stream potfile against this batch's Set
    const { pearls } = streamPotfileForBatch(localPotPath, batchHashSet);

    // Remaining hashes in Set = SAND (not cracked)
    const sandHashes = [...batchHashSet];

    // Verify invariant: PEARLS + SAND = GRAVEL
    const checkSum = pearls.length + sandHashes.length;
    if (checkSum !== gravelCount) {
      console.error(`  INVARIANT VIOLATION: ${batchName}: PEARLS(${pearls.length}) + SAND(${sandHashes.length}) = ${checkSum} != GRAVEL(${gravelCount})`);
    }

    // Append PEARLS to JSONL
    if (pearls.length > 0) {
      const jsonlLines = pearls.map(p => JSON.stringify(p)).join("\n") + "\n";
      appendFileSync(pearlsJsonlPath, jsonlLines);
    }

    // Write SAND (compressed)
    const sandPath = resolve(SAND_DIR, `${batchName}.txt.gz`);
    const sandContent = sandHashes.join("\n") + "\n";
    writeFileSync(sandPath, gzipSync(Buffer.from(sandContent)));

    // Update state
    state.batches[batchName] = {
      status: "completed",
      pearlCount: pearls.length,
      sandCount: sandHashes.length,
      chunk: chunkIndex,
    };

    totalPearls += pearls.length;
    totalSand += sandHashes.length;
    batchesProcessed++;

    // Progress every 50 batches
    if (batchesProcessed % 50 === 0) {
      const crackRate = gravelCount > 0 ? (pearls.length / gravelCount * 100).toFixed(1) : "0";
      console.log(`  [${batchesProcessed}/${batchNames.length}] ${batchName}: ${pearls.length.toLocaleString()} pearls, ${sandHashes.length.toLocaleString()} sand (${crackRate}%)`);
      // Save state periodically for resume safety
      saveState(state);
    }
  }

  // Final state save
  saveState(state);

  // Clean up local potfile
  try {
    unlinkSync(localPotPath);
  } catch { /* ignore */ }

  return { totalPearls, totalSand };
}

// =============================================================================
// BIGRED Cleanup
// =============================================================================

function cleanupBigred(config: BigRedConfig, chunkIndex: number): void {
  const chunkName = `chunk-${String(chunkIndex).padStart(2, "0")}`;
  console.log(`  Cleaning up BIGRED: ${chunkName}...`);

  // Hard failure — leftover files accumulate ~5.5GB per chunk and will fill disk
  sshCmd(config, [
    `rm -f ${config.workDir}/hashlists/${chunkName}.txt`,
    `rm -f ${config.workDir}/potfiles/${chunkName}.pot`,
    `rm -f ${config.workDir}/hashcat-${chunkName}.log`,
  ].join(" && "), 120000);
  console.log(`  Cleaned.`);
}

// =============================================================================
// Preflight Checks
// =============================================================================

function preflight(config: BigRedConfig): boolean {
  console.log("\n--- PRE-FLIGHT CHECKS ---");

  // 1. Check nocap.txt
  try {
    const size = sshCmd(config, `stat -c %s ${config.workDir}/wordlists/nocap.txt 2>/dev/null || echo 0`);
    if (parseInt(size) === 0) {
      console.error("  FAIL: nocap.txt not found on BIGRED");
      console.error("  Fix: bun Tools/BigRedSync.ts");
      return false;
    }
    console.log(`  nocap.txt: ${formatSize(parseInt(size))}`);
  } catch {
    console.error("  FAIL: Cannot check nocap.txt");
    return false;
  }

  // 2. Check nocap.rule
  try {
    const size = sshCmd(config, `stat -c %s ${config.workDir}/rules/nocap.rule 2>/dev/null || echo 0`);
    if (parseInt(size) === 0) {
      console.error("  FAIL: nocap.rule not found on BIGRED");
      console.error("  Fix: bun Tools/BigRedSync.ts");
      return false;
    }
    console.log(`  nocap.rule: ${formatSize(parseInt(size))}`);
  } catch {
    console.error("  FAIL: Cannot check nocap.rule");
    return false;
  }

  // 3. hashcat not running
  if (isHashcatRunning(config)) {
    console.error("  FAIL: hashcat is already running on BIGRED");
    return false;
  }
  console.log(`  hashcat: Not running (ready)`);

  // 4. Disk space
  try {
    const df = sshCmd(config, `df -h ${config.workDir} | tail -1 | awk '{print $4}'`);
    console.log(`  Disk free: ${df}`);
  } catch { /* ignore */ }

  // 5. Gravel directory
  const batches = discoverGravelBatches();
  console.log(`  Gravel batches: ${batches.length.toLocaleString()}`);

  console.log("--- PRE-FLIGHT PASSED ---\n");
  return true;
}

// =============================================================================
// Status Display
// =============================================================================

function showStatus(): void {
  const state = loadState();
  const allBatches = discoverGravelBatches();
  const completedBatches = Object.values(state.batches).filter(b => b.status === "completed");
  const pendingCount = allBatches.length - completedBatches.length;

  const totalPearls = completedBatches.reduce((sum, b) => sum + b.pearlCount, 0);
  const totalSand = completedBatches.reduce((sum, b) => sum + b.sandCount, 0);
  const totalHashes = totalPearls + totalSand;
  const overallRate = totalHashes > 0 ? (totalPearls / totalHashes * 100).toFixed(2) : "0";

  console.log("\n=== GravelChunkProcessor Status ===\n");
  console.log(`Attack:         ${state.attack}`);
  console.log(`Chunks:         ${state.chunks}`);
  console.log(`Current chunk:  ${state.currentChunk} / ${state.chunks}`);
  console.log(`\nBatches:`);
  console.log(`  Total:     ${allBatches.length.toLocaleString()}`);
  console.log(`  Completed: ${completedBatches.length.toLocaleString()}`);
  console.log(`  Pending:   ${pendingCount.toLocaleString()}`);
  console.log(`\nResults:`);
  console.log(`  PEARLS:     ${totalPearls.toLocaleString()}`);
  console.log(`  SAND:       ${totalSand.toLocaleString()}`);
  console.log(`  Crack rate: ${overallRate}%`);

  if (state.lastUpdated) {
    console.log(`\nLast updated: ${state.lastUpdated}`);
  }

  // Per-chunk summary
  if (completedBatches.length > 0) {
    const chunkStats = new Map<number, { pearls: number; sand: number; count: number }>();
    for (const b of completedBatches) {
      const existing = chunkStats.get(b.chunk) || { pearls: 0, sand: 0, count: 0 };
      existing.pearls += b.pearlCount;
      existing.sand += b.sandCount;
      existing.count++;
      chunkStats.set(b.chunk, existing);
    }

    console.log(`\nPer-chunk breakdown:`);
    for (const [chunk, stats] of [...chunkStats.entries()].sort((a, b) => a[0] - b[0])) {
      const chunkTotal = stats.pearls + stats.sand;
      const rate = chunkTotal > 0 ? (stats.pearls / chunkTotal * 100).toFixed(1) : "0";
      console.log(`  chunk-${String(chunk).padStart(2, "0")}: ${stats.count} batches, ${stats.pearls.toLocaleString()} pearls (${rate}%)`);
    }
  }
}

// =============================================================================
// Dry Run
// =============================================================================

function dryRun(numChunks: number): void {
  const allBatches = discoverGravelBatches();
  const state = loadState();

  // Filter out already-completed batches
  const pendingBatches = allBatches.filter(b => state.batches[b]?.status !== "completed");
  const chunks = chunkArray(pendingBatches, numChunks);

  console.log("\n=== DRY RUN: Chunking Plan ===\n");
  console.log(`Total gravel batches: ${allBatches.length.toLocaleString()}`);
  console.log(`Already completed:    ${(allBatches.length - pendingBatches.length).toLocaleString()}`);
  console.log(`Pending:              ${pendingBatches.length.toLocaleString()}`);
  console.log(`Chunks:               ${chunks.length}`);
  console.log(`Attack:               nocap.txt + nocap.rule`);
  console.log();

  let totalHashes = 0;
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const first = chunk[0];
    const last = chunk[chunk.length - 1];

    // Estimate hashes (count from first batch)
    let sampleCount = 0;
    const samplePath = resolve(GRAVEL_DIR, `${first}.txt`);
    if (existsSync(samplePath)) {
      const content = readFileSync(samplePath, "utf-8");
      sampleCount = content.trim().split(/\r?\n/).map(h => h.trim()).filter(h => h.length === 40).length;
    }

    const estHashes = sampleCount * chunk.length;
    const estSizeMB = (estHashes * 41) / (1024 * 1024); // 40 hex chars + newline
    totalHashes += estHashes;

    console.log(`  chunk-${String(i + 1).padStart(2, "0")}: ${chunk.length} batches (${first}..${last}), ~${estHashes.toLocaleString()} hashes (~${estSizeMB.toFixed(0)}MB)`);
  }

  console.log(`\nTotal estimated hashes: ${totalHashes.toLocaleString()}`);
  console.log(`Estimated total file size: ${formatSize(totalHashes * 41)}`);
  console.log(`\nTime estimate unknown — depends on NAS speed, SCP throughput, and hashcat dict+rules speed.`);
  console.log(`First chunk will establish a baseline.\n`);
}

// =============================================================================
// Main Run Loop
// =============================================================================

async function run(config: BigRedConfig, numChunks: number): Promise<void> {
  const allBatches = discoverGravelBatches();
  let state = loadState();

  // Filter out already-completed batches
  const pendingBatches = allBatches.filter(b => state.batches[b]?.status !== "completed");

  if (pendingBatches.length === 0) {
    console.log("All gravel batches already processed!");
    showStatus();
    return;
  }

  // Update state with chunk count
  state.chunks = numChunks;
  saveState(state);

  const chunks = chunkArray(pendingBatches, numChunks);

  console.log(`\nProcessing ${pendingBatches.length.toLocaleString()} batches in ${chunks.length} chunks`);
  console.log(`Attack: nocap.txt + nocap.rule`);

  // Use a temp dir for chunk files
  const tmpDir = resolve(DATA_DIR, "tmp");
  if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });

  const overallStartTime = Date.now();
  let grandTotalPearls = 0;
  let grandTotalSand = 0;

  // Determine starting chunk (resume from currentChunk)
  const startChunk = state.currentChunk > 0 ? state.currentChunk - 1 : 0;

  for (let i = startChunk; i < chunks.length; i++) {
    const chunkBatches = chunks[i];
    const chunkIndex = i + 1;
    const chunkStartTime = Date.now();

    console.log(`\n${"═".repeat(70)}`);
    console.log(`CHUNK ${chunkIndex} / ${chunks.length} — ${chunkBatches.length} batches (${chunkBatches[0]}..${chunkBatches[chunkBatches.length - 1]})`);
    console.log("═".repeat(70));

    // Filter out any batches in this chunk that are already completed
    const pendingInChunk = chunkBatches.filter(b => state.batches[b]?.status !== "completed");
    if (pendingInChunk.length === 0) {
      console.log(`  All ${chunkBatches.length} batches in this chunk already completed. Skipping.`);
      state.currentChunk = chunkIndex + 1;
      saveState(state);
      continue;
    }

    // Step 1: Build chunk file
    const { chunkPath, totalHashes } = buildChunkFile(
      pendingInChunk, chunkIndex, tmpDir,
    );

    // Step 2: Upload to BIGRED
    const chunkName = `chunk-${String(chunkIndex).padStart(2, "0")}`;
    const remoteHashlistPath = `${config.workDir}/hashlists/${chunkName}.txt`;
    console.log(`\nUploading ${chunkName}.txt to BIGRED...`);
    scpUpload(config, chunkPath, remoteHashlistPath, 1200000); // 20 min timeout
    console.log(`  Uploaded.`);

    // Delete local temp chunk file
    try { unlinkSync(chunkPath); } catch { /* ignore */ }

    // Step 3: Run hashcat
    state.currentChunk = chunkIndex;
    saveState(state);

    const { potfileLines, durationSeconds } = runHashcatOnChunk(config, chunkIndex);

    if (potfileLines === 0) {
      console.log(`  WARNING: Zero cracks. Check BIGRED logs.`);
    }

    // Step 4: Download potfile + distribute results
    const { totalPearls, totalSand } = await distributeResults(
      config, chunkIndex, pendingInChunk, state,
    );

    grandTotalPearls += totalPearls;
    grandTotalSand += totalSand;

    // Step 5: Clean up BIGRED
    cleanupBigred(config, chunkIndex);

    // Chunk summary
    const chunkDuration = (Date.now() - chunkStartTime) / 1000;
    const chunkRate = (totalPearls + totalSand) > 0 ? (totalPearls / (totalPearls + totalSand) * 100).toFixed(2) : "0";
    console.log(`\n  Chunk ${chunkIndex} complete: ${totalPearls.toLocaleString()} pearls, ${totalSand.toLocaleString()} sand (${chunkRate}%) in ${formatDuration(chunkDuration)}`);

    // Update current chunk pointer
    state.currentChunk = chunkIndex + 1;
    saveState(state);
  }

  // Clean up tmp dir
  try {
    const { rmdirSync } = require("node:fs");
    rmdirSync(tmpDir, { recursive: true });
  } catch { /* ignore */ }

  // Grand summary
  const overallDuration = (Date.now() - overallStartTime) / 1000;
  const overallRate = (grandTotalPearls + grandTotalSand) > 0
    ? (grandTotalPearls / (grandTotalPearls + grandTotalSand) * 100).toFixed(2)
    : "0";

  console.log(`\n${"═".repeat(70)}`);
  console.log(`ALL CHUNKS COMPLETE`);
  console.log("═".repeat(70));
  console.log(`Total time:   ${formatDuration(overallDuration)}`);
  console.log(`Total PEARLS: ${grandTotalPearls.toLocaleString()}`);
  console.log(`Total SAND:   ${grandTotalSand.toLocaleString()}`);
  console.log(`Crack rate:   ${overallRate}%`);
  console.log(`\nSAND ready for Stage 2: bun Tools/BigRedRunner.ts --next`);
}

// =============================================================================
// CLI Entry Point
// =============================================================================

if (import.meta.main) {
  const args = process.argv.slice(2);

  let runFlag = false;
  let statusFlag = false;
  let dryRunFlag = false;
  let numChunks = DEFAULT_CHUNKS;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--run":
        runFlag = true;
        break;
      case "--status":
        statusFlag = true;
        break;
      case "--dry-run":
        dryRunFlag = true;
        break;
      case "--chunks":
        numChunks = parseInt(args[++i]);
        if (isNaN(numChunks) || numChunks < 1) {
          console.error("ERROR: --chunks must be a positive integer");
          process.exit(1);
        }
        break;
      case "--help":
      case "-h":
        console.log(`
GravelChunkProcessor - Chunked Stage 1: ALL GRAVEL → PEARLS + SAND

Processes all 4,328 gravel batches by grouping into chunks, running
nocap.txt + nocap.rule on each chunk, then distributing results to
per-batch PEARLS (JSONL) and SAND (gzipped).

Usage:
  bun Tools/GravelChunkProcessor.ts --run                Process all gravel (40 chunks)
  bun Tools/GravelChunkProcessor.ts --run --chunks 50    Use 50 chunks instead of 40
  bun Tools/GravelChunkProcessor.ts --status             Show progress
  bun Tools/GravelChunkProcessor.ts --dry-run            Preview chunking plan

Attack: nocap.txt × nocap.rule (48,428 rules)
Expected crack rate: ~30%
Expected time: unknown until first chunk completes (chunk 1 benchmarked ~1.5 hrs)

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
    dryRun(numChunks);
    process.exit(0);
  }

  if (!runFlag) {
    console.error("ERROR: Specify --run, --status, or --dry-run (use --help for usage)");
    process.exit(1);
  }

  // === Main run ===
  try {
    const config = loadConfig();
    console.log(`BIGRED: ${config.user}@${config.host}`);
    console.log(`Stage: 1 (GRAVEL → PEARLS + SAND) — Chunked Mode`);

    // Test connectivity
    try {
      sshCmd(config, "echo connected", 10000);
    } catch {
      console.error("ERROR: Cannot connect to BIGRED. Check network and SSH key.");
      process.exit(1);
    }

    // Ensure remote directories exist
    sshCmd(config, `mkdir -p ${config.workDir}/{wordlists,rules,hashlists,potfiles,results}`);

    // Preflight
    if (!preflight(config)) {
      process.exit(1);
    }

    run(config, numChunks).catch(e => {
      console.error(`\nFATAL: ${(e as Error).message}`);
      process.exit(1);
    });
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
  }
}
