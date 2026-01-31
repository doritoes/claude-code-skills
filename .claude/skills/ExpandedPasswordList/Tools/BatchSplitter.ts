#!/usr/bin/env bun
/**
 * BatchSplitter.ts - Split Cracked Results into Per-Batch PEARLS and SAND
 *
 * For each GRAVEL batch, creates corresponding:
 * - pearls/batch-XXXX.txt (HASH:PASSWORD pairs cracked from that batch)
 * - sand/batch-XXXX.txt (hashes from that batch NOT cracked)
 *
 * Invariant: GRAVEL[N] = PEARLS[N] + SAND[N]
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

import { existsSync, mkdirSync, readdirSync, createReadStream, writeFileSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";

// =============================================================================
// Configuration
// =============================================================================

const SKILL_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const DATA_DIR = resolve(SKILL_DIR, "data");
const CANDIDATES_DIR = resolve(DATA_DIR, "candidates");
const RESULTS_DIR = resolve(DATA_DIR, "results");
const PEARLS_DIR = resolve(DATA_DIR, "pearls");
const SAND_DIR = resolve(DATA_DIR, "sand");

// =============================================================================
// Utilities
// =============================================================================

function formatNumber(n: number): string {
  return n.toLocaleString();
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(0)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${mins}m`;
}

// =============================================================================
// PEARLS Loader
// =============================================================================

/**
 * Load all PEARLS (cracked hashes) into a Map of HASH -> PASSWORD
 */
async function loadPearls(pearlsPath: string): Promise<Map<string, string>> {
  if (!existsSync(pearlsPath)) {
    throw new Error(`PEARLS file not found: ${pearlsPath}\nRun ResultCollector.ts first.`);
  }

  console.log(`Loading PEARLS from ${pearlsPath}...`);
  const pearls = new Map<string, string>();
  const startTime = Date.now();
  let lineCount = 0;

  const fileStream = createReadStream(pearlsPath, { encoding: "utf-8" });
  const rl = createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    lineCount++;
    // Format: HASH:PASSWORD
    const colonIdx = line.indexOf(":");
    if (colonIdx === 40) {
      const hash = line.substring(0, 40).toUpperCase();
      const password = line.substring(41);
      pearls.set(hash, password);
    }

    if (lineCount % 100000 === 0) {
      process.stdout.write(`\r  Loaded ${formatNumber(lineCount)} PEARLS...`);
    }
  }

  const elapsed = (Date.now() - startTime) / 1000;
  console.log(`\r  Loaded ${formatNumber(pearls.size)} PEARLS in ${formatDuration(elapsed)}    `);

  return pearls;
}

// =============================================================================
// Batch Splitter
// =============================================================================

interface SplitStats {
  batchId: string;
  gravelCount: number;
  pearlsCount: number;
  sandCount: number;
}

/**
 * Split a single GRAVEL batch into PEARLS and SAND
 */
async function splitBatch(
  batchFile: string,
  pearls: Map<string, string>,
  pearlsDir: string,
  sandDir: string
): Promise<SplitStats> {
  const batchPath = resolve(CANDIDATES_DIR, batchFile);
  const batchId = basename(batchFile, ".txt").replace(".gz", "");
  const isGzipped = batchFile.endsWith(".gz");

  // Create read stream (with decompression if needed)
  let inputStream: NodeJS.ReadableStream;
  if (isGzipped) {
    const fileStream = createReadStream(batchPath);
    const gunzip = createGunzip();
    fileStream.pipe(gunzip);
    inputStream = gunzip;
  } else {
    inputStream = createReadStream(batchPath, { encoding: "utf-8" });
  }

  const rl = createInterface({
    input: inputStream,
    crlfDelay: Infinity,
  });

  const batchPearls: string[] = [];
  const batchSand: string[] = [];
  let gravelCount = 0;

  for await (const line of rl) {
    const hash = line.trim().toUpperCase();
    if (hash.length !== 40) continue;

    gravelCount++;

    const password = pearls.get(hash);
    if (password !== undefined) {
      // This hash was cracked - add to PEARLS
      batchPearls.push(`${hash}:${password}`);
    } else {
      // This hash was NOT cracked - add to SAND
      batchSand.push(hash);
    }
  }

  // Write PEARLS for this batch
  if (batchPearls.length > 0) {
    const pearlsPath = resolve(pearlsDir, `${batchId}.txt`);
    writeFileSync(pearlsPath, batchPearls.join("\n") + "\n");
  }

  // Write SAND for this batch
  if (batchSand.length > 0) {
    const sandPath = resolve(sandDir, `${batchId}.txt`);
    writeFileSync(sandPath, batchSand.join("\n") + "\n");
  }

  return {
    batchId,
    gravelCount,
    pearlsCount: batchPearls.length,
    sandCount: batchSand.length,
  };
}

/**
 * Split all GRAVEL batches into per-batch PEARLS and SAND
 */
async function splitAll(options: {
  pearlsPath?: string;
  startBatch?: number;
  endBatch?: number;
} = {}): Promise<void> {
  const pearlsPath = options.pearlsPath || resolve(RESULTS_DIR, "cracked.txt");

  // Ensure output directories exist
  if (!existsSync(PEARLS_DIR)) {
    mkdirSync(PEARLS_DIR, { recursive: true });
  }
  if (!existsSync(SAND_DIR)) {
    mkdirSync(SAND_DIR, { recursive: true });
  }

  // Load PEARLS
  const pearls = await loadPearls(pearlsPath);

  // Get GRAVEL batch files
  if (!existsSync(CANDIDATES_DIR)) {
    throw new Error(`GRAVEL directory not found: ${CANDIDATES_DIR}`);
  }

  let batchFiles = readdirSync(CANDIDATES_DIR)
    .filter((f) => f.startsWith("batch-") && (f.endsWith(".txt") || f.endsWith(".txt.gz")))
    .sort();

  // Filter by batch range if specified
  if (options.startBatch !== undefined || options.endBatch !== undefined) {
    batchFiles = batchFiles.filter((f) => {
      const match = f.match(/batch-(\d+)/);
      if (!match) return false;
      const batchNum = parseInt(match[1]);
      if (options.startBatch !== undefined && batchNum < options.startBatch) return false;
      if (options.endBatch !== undefined && batchNum > options.endBatch) return false;
      return true;
    });
  }

  if (batchFiles.length === 0) {
    throw new Error(`No GRAVEL batch files found in ${CANDIDATES_DIR}`);
  }

  console.log("");
  console.log("BatchSplitter - Per-Batch PEARLS and SAND");
  console.log("=========================================");
  console.log(`GRAVEL batches: ${batchFiles.length}`);
  console.log(`PEARLS loaded:  ${formatNumber(pearls.size)}`);
  console.log(`Output:         ${PEARLS_DIR}`);
  console.log(`                ${SAND_DIR}`);
  console.log("");

  const startTime = Date.now();
  let totalGravel = 0;
  let totalPearls = 0;
  let totalSand = 0;
  let processed = 0;

  for (const batchFile of batchFiles) {
    const stats = await splitBatch(batchFile, pearls, PEARLS_DIR, SAND_DIR);

    totalGravel += stats.gravelCount;
    totalPearls += stats.pearlsCount;
    totalSand += stats.sandCount;
    processed++;

    // Progress report every 100 batches
    if (processed % 100 === 0 || processed === batchFiles.length) {
      const elapsed = (Date.now() - startTime) / 1000;
      const rate = processed / elapsed;
      const eta = (batchFiles.length - processed) / rate;
      const pctDone = (processed / batchFiles.length) * 100;

      console.log(
        `Progress: ${processed}/${batchFiles.length} (${pctDone.toFixed(1)}%) | ` +
        `PEARLS: ${formatNumber(totalPearls)} | ` +
        `SAND: ${formatNumber(totalSand)} | ` +
        `ETA: ${formatDuration(eta)}`
      );
    }
  }

  const totalTime = (Date.now() - startTime) / 1000;
  const crackRate = (totalPearls / totalGravel) * 100;

  console.log("");
  console.log("Split Complete");
  console.log("==============");
  console.log(`GRAVEL total:  ${formatNumber(totalGravel)} hashes`);
  console.log(`PEARLS total:  ${formatNumber(totalPearls)} (${crackRate.toFixed(2)}%)`);
  console.log(`SAND total:    ${formatNumber(totalSand)} (${(100 - crackRate).toFixed(2)}%)`);
  console.log(`Batches:       ${batchFiles.length}`);
  console.log(`Time:          ${formatDuration(totalTime)}`);
  console.log("");
  console.log(`Output: ${PEARLS_DIR}/batch-*.txt`);
  console.log(`        ${SAND_DIR}/batch-*.txt`);

  // Verify invariant
  if (totalGravel !== totalPearls + totalSand) {
    console.error("");
    console.error(`WARNING: Invariant violated!`);
    console.error(`  GRAVEL (${totalGravel}) != PEARLS (${totalPearls}) + SAND (${totalSand})`);
    console.error(`  Difference: ${totalGravel - totalPearls - totalSand}`);
  }
}

// =============================================================================
// CLI
// =============================================================================

if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args[0] === "--help" || args[0] === "-h") {
    console.log(`
BatchSplitter - Split cracked results into per-batch PEARLS and SAND

For each GRAVEL batch, creates:
  - pearls/batch-XXXX.txt (HASH:PASSWORD pairs cracked from that batch)
  - sand/batch-XXXX.txt (hashes from that batch NOT cracked)

Invariant: GRAVEL[N] = PEARLS[N] + SAND[N]

Usage:
  bun BatchSplitter.ts                      Split all batches
  bun BatchSplitter.ts --start 1 --end 100  Split batch range
  bun BatchSplitter.ts --pearls <path>      Custom PEARLS file

Options:
  --pearls <path>    Path to cracked.txt (default: data/results/cracked.txt)
  --start <n>        Start at batch N
  --end <n>          End at batch N

Input:
  data/candidates/batch-*.txt   GRAVEL batches
  data/results/cracked.txt      All PEARLS (HASH:PASSWORD)

Output:
  data/pearls/batch-*.txt       Per-batch PEARLS
  data/sand/batch-*.txt         Per-batch SAND
`);
    process.exit(0);
  }

  // Parse arguments
  let pearlsPath: string | undefined;
  let startBatch: number | undefined;
  let endBatch: number | undefined;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--pearls":
        pearlsPath = args[++i];
        break;
      case "--start":
        startBatch = parseInt(args[++i]);
        break;
      case "--end":
        endBatch = parseInt(args[++i]);
        break;
    }
  }

  try {
    await splitAll({ pearlsPath, startBatch, endBatch });
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
  }
}
