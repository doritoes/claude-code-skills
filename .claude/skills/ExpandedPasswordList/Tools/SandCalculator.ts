#!/usr/bin/env bun
/**
 * SandCalculator.ts - Memory-Efficient SAND Calculation
 *
 * Calculates SAND = GRAVEL - PEARLS using streaming to handle 2B+ hashes.
 *
 * Strategy:
 * 1. Load PEARLS (cracked hashes) into a Set (~8GB for 200M hashes)
 * 2. Stream GRAVEL batch files one at a time
 * 3. Output hashes not in PEARLS to SAND files
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

import { existsSync, mkdirSync, readdirSync, createReadStream, createWriteStream, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";
import { pipeline } from "node:stream/promises";

// =============================================================================
// Configuration
// =============================================================================

const SKILL_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const DATA_DIR = resolve(SKILL_DIR, "data");
const CANDIDATES_DIR = resolve(DATA_DIR, "candidates");
const RESULTS_DIR = resolve(DATA_DIR, "results");
const SAND_DIR = resolve(DATA_DIR, "sand");

const SAND_BATCH_SIZE = 1_000_000; // 1M hashes per output file

// =============================================================================
// Utilities
// =============================================================================

function formatNumber(n: number): string {
  return n.toLocaleString();
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
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
 * Load PEARLS (cracked hashes) from results directory into a Set
 * Expects cracked.txt with HASH:PASSWORD format
 */
async function loadPearls(pearlsPath?: string): Promise<Set<string>> {
  const defaultPath = resolve(RESULTS_DIR, "cracked.txt");
  const path = pearlsPath || defaultPath;

  if (!existsSync(path)) {
    throw new Error(`PEARLS file not found: ${path}\nRun ResultCollector.ts first.`);
  }

  const stats = statSync(path);
  console.log(`Loading PEARLS from ${path} (${formatBytes(stats.size)})...`);

  const pearls = new Set<string>();
  const startTime = Date.now();
  let lineCount = 0;

  const fileStream = createReadStream(path, { encoding: "utf-8" });
  const rl = createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    lineCount++;
    // Format: HASH:PASSWORD - extract just the hash
    const colonIdx = line.indexOf(":");
    if (colonIdx === 40) {
      const hash = line.substring(0, 40).toUpperCase();
      pearls.add(hash);
    }

    if (lineCount % 1_000_000 === 0) {
      console.log(`  Loaded ${formatNumber(lineCount)} PEARLS...`);
    }
  }

  const elapsed = (Date.now() - startTime) / 1000;
  console.log(`  Loaded ${formatNumber(pearls.size)} unique PEARLS in ${formatDuration(elapsed)}`);

  return pearls;
}

// =============================================================================
// SAND Calculator
// =============================================================================

interface SandResult {
  gravelTotal: number;
  pearlsCount: number;
  sandCount: number;
  batchesWritten: number;
  duration: number;
}

/**
 * Stream GRAVEL and output SAND (hashes not in PEARLS)
 */
async function calculateSand(options: {
  pearls: Set<string>;
  outputDir?: string;
  batchSize?: number;
  resume?: boolean;
}): Promise<SandResult> {
  const { pearls, outputDir = SAND_DIR, batchSize = SAND_BATCH_SIZE, resume = false } = options;

  // Ensure output directory exists
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  // Get GRAVEL batch files
  if (!existsSync(CANDIDATES_DIR)) {
    throw new Error(`GRAVEL directory not found: ${CANDIDATES_DIR}`);
  }

  const batchFiles = readdirSync(CANDIDATES_DIR)
    .filter((f) => f.startsWith("batch-") && (f.endsWith(".txt") || f.endsWith(".txt.gz")))
    .sort();

  if (batchFiles.length === 0) {
    throw new Error(`No GRAVEL batch files found in ${CANDIDATES_DIR}`);
  }

  console.log("");
  console.log("SandCalculator - Streaming SAND Calculation");
  console.log("============================================");
  console.log(`GRAVEL batches: ${batchFiles.length}`);
  console.log(`PEARLS loaded: ${formatNumber(pearls.size)}`);
  console.log(`Output batch size: ${formatNumber(batchSize)}`);
  console.log(`Output directory: ${outputDir}`);
  console.log("");

  const startTime = Date.now();
  let gravelTotal = 0;
  let sandCount = 0;
  let currentBatch: string[] = [];
  let batchNumber = 0;
  let lastReport = startTime;

  // Helper to flush current batch to disk
  const flushBatch = () => {
    if (currentBatch.length === 0) return;

    batchNumber++;
    const batchPath = resolve(outputDir, `sand-${String(batchNumber).padStart(4, "0")}.txt`);
    const content = currentBatch.join("\n") + "\n";

    Bun.write(batchPath, content);
    console.log(`  Wrote sand-${String(batchNumber).padStart(4, "0")}.txt: ${formatNumber(currentBatch.length)} hashes`);

    currentBatch = [];
  };

  // Process each GRAVEL batch file
  for (let i = 0; i < batchFiles.length; i++) {
    const batchFile = batchFiles[i];
    const batchPath = resolve(CANDIDATES_DIR, batchFile);
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

    for await (const line of rl) {
      const hash = line.trim().toUpperCase();
      if (hash.length !== 40) continue;

      gravelTotal++;

      // Check if NOT in PEARLS → it's SAND
      if (!pearls.has(hash)) {
        sandCount++;
        currentBatch.push(hash);

        // Flush if batch is full
        if (currentBatch.length >= batchSize) {
          flushBatch();
        }
      }
    }

    // Progress report
    const now = Date.now();
    if (now - lastReport > 10000 || i === batchFiles.length - 1) {
      const elapsed = (now - startTime) / 1000;
      const rate = gravelTotal / elapsed;
      const pctDone = ((i + 1) / batchFiles.length) * 100;
      const remaining = batchFiles.length - i - 1;
      const eta = remaining > 0 ? (remaining / (i + 1)) * elapsed : 0;

      console.log(
        `Progress: ${i + 1}/${batchFiles.length} files (${pctDone.toFixed(1)}%) | ` +
        `GRAVEL: ${formatNumber(gravelTotal)} | ` +
        `SAND: ${formatNumber(sandCount)} | ` +
        `${formatNumber(Math.round(rate))}/sec | ` +
        `ETA: ${formatDuration(eta)}`
      );
      lastReport = now;
    }
  }

  // Flush remaining
  flushBatch();

  const totalTime = (Date.now() - startTime) / 1000;

  return {
    gravelTotal,
    pearlsCount: pearls.size,
    sandCount,
    batchesWritten: batchNumber,
    duration: totalTime,
  };
}

// =============================================================================
// Main
// =============================================================================

async function main(options: {
  pearlsPath?: string;
  outputDir?: string;
  batchSize?: number;
} = {}): Promise<void> {
  console.log("SAND Calculator");
  console.log("===============");
  console.log("SAND = GRAVEL - PEARLS (uncracked hashes)");
  console.log("");

  // Load PEARLS
  const pearls = await loadPearls(options.pearlsPath);

  // Calculate SAND
  const result = await calculateSand({
    pearls,
    outputDir: options.outputDir,
    batchSize: options.batchSize,
  });

  // Summary
  const pearlsPct = (result.pearlsCount / result.gravelTotal) * 100;
  const sandPct = (result.sandCount / result.gravelTotal) * 100;

  console.log("");
  console.log("SAND Calculation Complete");
  console.log("=========================");
  console.log(`GRAVEL (total candidates): ${formatNumber(result.gravelTotal)}`);
  console.log(`PEARLS (cracked):          ${formatNumber(result.pearlsCount)} (${pearlsPct.toFixed(2)}%)`);
  console.log(`SAND (uncracked):          ${formatNumber(result.sandCount)} (${sandPct.toFixed(2)}%)`);
  console.log(`Output batches:            ${result.batchesWritten}`);
  console.log(`Time:                      ${formatDuration(result.duration)}`);
  console.log("");
  console.log(`Output: ${SAND_DIR}/`);
}

// =============================================================================
// CLI
// =============================================================================

if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args[0] === "--help" || args[0] === "-h") {
    console.log(`
SandCalculator - Memory-efficient SAND = GRAVEL - PEARLS

Streams through 2B+ GRAVEL hashes without loading all into memory.
Outputs SAND (uncracked hashes) to batch files.

Usage:
  bun SandCalculator.ts                    Calculate SAND
  bun SandCalculator.ts --pearls <path>    Custom PEARLS file
  bun SandCalculator.ts --output <dir>     Custom output directory
  bun SandCalculator.ts --batch-size <n>   Hashes per output file (default: 1M)

Options:
  --pearls <path>     Path to cracked.txt (default: data/results/cracked.txt)
  --output <dir>      Output directory (default: data/sand/)
  --batch-size <n>    Number of hashes per output file

Memory usage:
  ~8GB for 200M PEARLS (Set overhead)
  ~50MB for streaming GRAVEL

Output: data/sand/sand-*.txt
`);
    process.exit(0);
  }

  // Parse arguments
  let pearlsPath: string | undefined;
  let outputDir: string | undefined;
  let batchSize: number | undefined;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--pearls":
        pearlsPath = args[++i];
        break;
      case "--output":
        outputDir = args[++i];
        break;
      case "--batch-size":
        batchSize = parseInt(args[++i]) || SAND_BATCH_SIZE;
        break;
    }
  }

  try {
    await main({ pearlsPath, outputDir, batchSize });
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
  }
}
