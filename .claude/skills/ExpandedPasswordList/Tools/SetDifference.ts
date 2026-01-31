#!/usr/bin/env bun
/**
 * SetDifference.ts - Stream-based HIBP vs Rockyou Filter
 *
 * Filters downloaded HIBP hashes to remove those already in rockyou.txt.
 * Memory-efficient: processes one prefix at a time with binary search.
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, appendFileSync, createWriteStream } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { StateManager } from "./StateManager";
import { RockyouHashIndex } from "./RockyouHasher";
import { HibpBatchManager } from "./HibpBatchManager";
import { PrefixBitmap } from "./PrefixBitmap";

// =============================================================================
// Configuration
// =============================================================================

const SKILL_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const DATA_DIR = resolve(SKILL_DIR, "data");
const HIBP_DIR = resolve(DATA_DIR, "hibp");
const CANDIDATES_DIR = resolve(DATA_DIR, "candidates");
const ROCKYOU_BIN = resolve(DATA_DIR, "rockyou-sha1.bin");

const DEFAULT_BATCH_SIZE = 1_000_000; // 1M hashes per output file

// =============================================================================
// Filter Implementation
// =============================================================================

interface CandidateEntry {
  hash: string;
  count: number;  // HIBP occurrence count
}

interface FilterResult {
  prefix: string;
  totalHashes: number;
  rockyouMatches: number;
  candidates: number;
  candidateHashes: string[];      // Legacy: hash only
  candidateEntries: CandidateEntry[];  // New: hash with count
}

/**
 * Filter a prefix from batched storage against rockyou index
 * Preserves HIBP occurrence counts for prioritization
 */
function filterPrefixFromBatch(
  prefix: string,
  batchManager: HibpBatchManager,
  rockyouIndex: RockyouHashIndex
): FilterResult {
  const entry = batchManager.getPrefix(prefix);

  if (!entry) {
    throw new Error(`HIBP prefix not found in batched storage: ${prefix}`);
  }

  const lines = entry.data.trim().split("\n").filter((l) => l.length > 0);

  let rockyouMatches = 0;
  let candidates = 0;
  const candidateHashes: string[] = [];
  const candidateEntries: CandidateEntry[] = [];

  for (const line of lines) {
    // HIBP format: SUFFIX:COUNT (suffix is 35 chars)
    const [suffix, countStr] = line.split(":");
    if (!suffix || suffix.length !== 35) continue;

    // Reconstruct full SHA-1 hash
    const fullHash = (prefix + suffix).toUpperCase();
    const count = parseInt(countStr) || 1;

    // Check if in rockyou
    if (rockyouIndex.exists(fullHash)) {
      rockyouMatches++;
    } else {
      candidates++;
      candidateHashes.push(fullHash);
      candidateEntries.push({ hash: fullHash, count });
    }
  }

  return {
    prefix,
    totalHashes: lines.length,
    rockyouMatches,
    candidates,
    candidateHashes,
    candidateEntries,
  };
}

/**
 * Filter a single prefix file against rockyou index
 * Returns both stats AND candidate hashes with counts to avoid reading file twice
 */
function filterPrefix(prefix: string, rockyouIndex: RockyouHashIndex): FilterResult {
  const hibpPath = resolve(HIBP_DIR, `${prefix}.txt`);

  if (!existsSync(hibpPath)) {
    throw new Error(`HIBP prefix file not found: ${hibpPath}`);
  }

  const content = readFileSync(hibpPath, "utf-8");
  const lines = content.trim().split("\n").filter((l) => l.length > 0);

  let rockyouMatches = 0;
  let candidates = 0;
  const candidateHashes: string[] = [];
  const candidateEntries: CandidateEntry[] = [];

  for (const line of lines) {
    // HIBP format: SUFFIX:COUNT (suffix is 35 chars)
    const [suffix, countStr] = line.split(":");
    if (!suffix || suffix.length !== 35) continue;

    // Reconstruct full SHA-1 hash
    const fullHash = (prefix + suffix).toUpperCase();
    const count = parseInt(countStr) || 1;

    // Check if in rockyou
    if (rockyouIndex.exists(fullHash)) {
      rockyouMatches++;
    } else {
      candidates++;
      candidateHashes.push(fullHash);
      candidateEntries.push({ hash: fullHash, count });
    }
  }

  return {
    prefix,
    totalHashes: lines.length,
    rockyouMatches,
    candidates,
    candidateHashes,
    candidateEntries,
  };
}

/**
 * Filter all downloaded prefixes
 */
async function filterAll(options: {
  batchSize?: number;
  resume?: boolean;
  prefix?: string;
} = {}): Promise<void> {
  const { batchSize = DEFAULT_BATCH_SIZE, resume = true } = options;

  // Ensure directories exist
  if (!existsSync(CANDIDATES_DIR)) {
    mkdirSync(CANDIDATES_DIR, { recursive: true });
  }

  // Load rockyou index
  if (!existsSync(ROCKYOU_BIN)) {
    console.error(`Rockyou index not found: ${ROCKYOU_BIN}`);
    console.error("Run: bun Tools/RockyouHasher.ts first");
    process.exit(1);
  }

  console.log("Loading rockyou SHA-1 index...");
  const rockyouIndex = new RockyouHashIndex(ROCKYOU_BIN);

  const state = new StateManager(DATA_DIR);
  const pipelineState = state.load();

  // Check download stage
  if (pipelineState.download.status !== "completed" && !options.prefix) {
    console.warn("Warning: Download stage not complete");
  }

  // Get list of HIBP prefix files
  const hibpFiles = readdirSync(HIBP_DIR)
    .filter((f) => f.endsWith(".txt"))
    .map((f) => f.replace(".txt", ""))
    .sort();

  if (hibpFiles.length === 0) {
    console.error("No HIBP files found. Run Download workflow first.");
    process.exit(1);
  }

  // Filter to single prefix if specified
  const prefixesToProcess = options.prefix
    ? [options.prefix.toUpperCase()]
    : hibpFiles;

  // Get already completed
  const completed = new Set(
    resume ? pipelineState.filter.completedPrefixes : []
  );

  const pending = prefixesToProcess.filter((p) => !completed.has(p));

  console.log("");
  console.log("SetDifference Filter");
  console.log("====================");
  console.log(`HIBP prefixes: ${hibpFiles.length}`);
  console.log(`Already filtered: ${completed.size}`);
  console.log(`Remaining: ${pending.length}`);
  console.log(`Batch size: ${batchSize.toLocaleString()} hashes`);
  console.log("");

  if (pending.length === 0) {
    console.log("All prefixes already filtered!");
    return;
  }

  state.startFilter();

  let processed = 0;
  let totalRockyouMatches = 0;
  let totalCandidates = 0;
  const startTime = Date.now();
  let lastReport = startTime;

  // Current batch buffer
  let currentBatch: string[] = [];
  let batchNumber = pipelineState.filter.batchesWritten;

  // Helper to flush batch to disk
  const flushBatch = () => {
    if (currentBatch.length === 0) return;

    batchNumber++;
    const batchFile = resolve(CANDIDATES_DIR, `batch-${String(batchNumber).padStart(3, "0")}.txt`);
    writeFileSync(batchFile, currentBatch.join("\n") + "\n");
    state.incrementBatchesWritten();

    console.log(`  Wrote batch ${batchNumber}: ${currentBatch.length.toLocaleString()} hashes`);
    currentBatch = [];
  };

  for (const prefix of pending) {
    try {
      const result = filterPrefix(prefix, rockyouIndex);

      processed++;
      totalRockyouMatches += result.rockyouMatches;
      totalCandidates += result.candidates;

      state.addFilteredPrefix(prefix, result.rockyouMatches, result.candidates);

      // Add candidates to batch buffer (using pre-computed hashes from filterPrefix)
      for (const hash of result.candidateHashes) {
        currentBatch.push(hash);

        // Flush if batch is full
        if (currentBatch.length >= batchSize) {
          flushBatch();
        }
      }

      // Progress report
      const now = Date.now();
      if (now - lastReport > 5000 || processed === pending.length) {
        const elapsed = (now - startTime) / 1000;
        const rate = processed / elapsed;
        const remaining = pending.length - processed;
        const eta = remaining / rate;
        const filterRate = totalRockyouMatches / (totalRockyouMatches + totalCandidates) * 100;

        console.log(
          `Progress: ${processed}/${pending.length} prefixes ` +
            `(${((processed / pending.length) * 100).toFixed(1)}%) | ` +
            `${rate.toFixed(1)}/sec | ` +
            `Filtered: ${filterRate.toFixed(1)}% | ` +
            `Candidates: ${totalCandidates.toLocaleString()}`
        );
        lastReport = now;
      }
    } catch (e) {
      console.error(`Error processing prefix ${prefix}: ${e}`);
    }
  }

  // Flush remaining batch
  flushBatch();

  state.completeFilter();

  // Summary
  const totalTime = (Date.now() - startTime) / 1000;
  console.log("");
  console.log("Filter Complete");
  console.log("===============");
  console.log(`Prefixes processed: ${processed.toLocaleString()}`);
  console.log(`Rockyou matches (filtered): ${totalRockyouMatches.toLocaleString()}`);
  console.log(`Candidates (new passwords): ${totalCandidates.toLocaleString()}`);
  console.log(`Filter rate: ${(totalRockyouMatches / (totalRockyouMatches + totalCandidates) * 100).toFixed(2)}%`);
  console.log(`Output batches: ${batchNumber}`);
  console.log(`Time: ${formatDuration(totalTime)}`);
}

/**
 * Generate all 5-character hex prefixes
 */
function* generateAllPrefixes(): Generator<string> {
  for (let i = 0; i <= 0xfffff; i++) {
    yield i.toString(16).toUpperCase().padStart(5, "0");
  }
}

/**
 * Filter all prefixes from batched storage with optional compression
 * Writes both hash batches and a counts index for prioritization
 *
 * MEMORY EFFICIENT:
 * - Uses bitmap file for progress tracking (128KB vs 5MB+ array)
 * - Processes one HIBP batch (4096 prefixes) at a time
 * - Streams counts directly to disk with small buffer
 * - Reduces candidate batch size to limit memory
 */
async function filterAllBatched(options: {
  batchSize?: number;
  resume?: boolean;
  compress?: boolean;
  withCounts?: boolean;  // Write HASH:COUNT index file
} = {}): Promise<void> {
  const { batchSize = DEFAULT_BATCH_SIZE, resume = true, compress = false, withCounts = true } = options;

  // Ensure directories exist
  if (!existsSync(CANDIDATES_DIR)) {
    mkdirSync(CANDIDATES_DIR, { recursive: true });
  }

  // Load rockyou index
  if (!existsSync(ROCKYOU_BIN)) {
    console.error(`Rockyou index not found: ${ROCKYOU_BIN}`);
    console.error("Run: bun Tools/RockyouHasher.ts first");
    process.exit(1);
  }

  console.log("Loading rockyou SHA-1 index...");
  const rockyouIndex = new RockyouHashIndex(ROCKYOU_BIN);

  const state = new StateManager(DATA_DIR);
  const pipelineState = state.load();

  // Mark compression mode
  pipelineState.filter.useCompression = compress;

  // Check download stage
  if (pipelineState.download.status !== "completed") {
    console.warn("Warning: Download stage not complete");
  }

  // Use bitmap file for progress tracking (128KB vs 5MB+ string array)
  const bitmapPath = resolve(DATA_DIR, "filter-progress.bitmap");
  const progressBitmap = new PrefixBitmap(bitmapPath);

  // If not resuming, reset the bitmap
  if (!resume) {
    progressBitmap.reset();
  }

  // Total prefixes is known: 1,048,576 (00000-FFFFF)
  const TOTAL_PREFIXES = 1048576;
  const completedCount = progressBitmap.count();
  const pendingCount = TOTAL_PREFIXES - completedCount;

  console.log("");
  console.log("SetDifference Filter (Batched - Memory Efficient)");
  console.log("=================================================");
  console.log(`HIBP prefixes: ${TOTAL_PREFIXES.toLocaleString()}`);
  console.log(`Already filtered: ${completedCount.toLocaleString()}`);
  console.log(`Remaining: ${pendingCount.toLocaleString()}`);
  console.log(`Batch size: ${batchSize.toLocaleString()} hashes`);
  console.log(`Compression: ${compress}`);
  console.log(`Progress tracking: bitmap file (128KB)`);
  console.log("");

  if (pendingCount === 0) {
    console.log("All prefixes already filtered!");
    progressBitmap.close();
    return;
  }

  state.startFilter();

  let processed = 0;
  let totalRockyouMatches = pipelineState.filter.rockyouMatches || 0;
  let totalCandidates = pipelineState.filter.candidates || 0;
  const startTime = Date.now();
  let lastReport = startTime;
  let lastStateSave = startTime;

  // Current batch buffer - reduced from 1M to 500K to save memory
  const EFFECTIVE_BATCH_SIZE = Math.min(batchSize, 500000);
  let currentBatch: string[] = [];
  let batchNumber = pipelineState.filter.batchesWritten;

  // Counts index: stream directly to file with small buffer
  const countsIndexPath = resolve(CANDIDATES_DIR, "counts-index.txt");
  let countsStream: ReturnType<typeof createWriteStream> | null = null;
  if (withCounts) {
    countsStream = createWriteStream(countsIndexPath, { flags: "a" });
  }

  // Small buffer for counts (10K instead of 100K to reduce memory)
  let countsBuffer: string[] = [];
  const COUNTS_FLUSH_SIZE = 10000;

  const flushCountsBuffer = () => {
    if (countsBuffer.length > 0 && countsStream) {
      countsStream.write(countsBuffer.join("\n") + "\n");
      countsBuffer = [];
    }
  };

  // Helper to flush batch to disk (with optional compression)
  const flushBatch = () => {
    if (currentBatch.length === 0) return;

    batchNumber++;
    const batchContent = currentBatch.join("\n") + "\n";

    if (compress) {
      const batchFile = resolve(CANDIDATES_DIR, `batch-${String(batchNumber).padStart(3, "0")}.txt.gz`);
      const compressed = gzipSync(batchContent);
      writeFileSync(batchFile, compressed);
      console.log(`  Wrote batch ${batchNumber}: ${currentBatch.length.toLocaleString()} hashes (${(compressed.length / 1024 / 1024).toFixed(1)} MB compressed)`);
    } else {
      const batchFile = resolve(CANDIDATES_DIR, `batch-${String(batchNumber).padStart(3, "0")}.txt`);
      writeFileSync(batchFile, batchContent);
      console.log(`  Wrote batch ${batchNumber}: ${currentBatch.length.toLocaleString()} hashes`);
    }

    state.incrementBatchesWritten();
    currentBatch = [];
  };

  // Process one HIBP batch at a time (256 batches, each with ~4096 prefixes)
  // This keeps memory bounded to ~one batch (~200MB) at a time
  for (let hibpBatchIdx = 0; hibpBatchIdx < 256; hibpBatchIdx++) {
    const hibpBatchId = hibpBatchIdx.toString(16).toUpperCase().padStart(2, "0");

    // Create fresh batch manager for each HIBP batch to avoid memory accumulation
    const batchManager = new HibpBatchManager(DATA_DIR);

    // Check if this batch file exists
    const batchPath = batchManager.getBatchPath(hibpBatchId);
    if (!existsSync(batchPath)) {
      continue;
    }

    // Load just this one batch
    const hibpBatch = batchManager.loadBatch(hibpBatchId);
    const prefixesInBatch = Object.keys(hibpBatch.entries).sort();

    for (const prefix of prefixesInBatch) {
      // Skip already completed (O(1) bitmap lookup vs O(n) array includes)
      if (progressBitmap.has(prefix)) {
        continue;
      }

      try {
        const entry = hibpBatch.entries[prefix];
        if (!entry?.data) continue;

        const lines = entry.data.trim().split("\n").filter((l: string) => l.length > 0);

        let rockyouMatches = 0;
        let candidates = 0;

        for (const line of lines) {
          const colonIdx = line.indexOf(":");
          if (colonIdx !== 35) continue;

          const suffix = line.substring(0, 35);
          const count = parseInt(line.substring(36)) || 1;
          const fullHash = (prefix + suffix).toUpperCase();

          if (rockyouIndex.exists(fullHash)) {
            rockyouMatches++;
          } else {
            candidates++;
            currentBatch.push(fullHash);

            // Buffer counts for batch write (smaller buffer now)
            if (withCounts) {
              countsBuffer.push(`${fullHash}:${count}`);
              if (countsBuffer.length >= COUNTS_FLUSH_SIZE) {
                flushCountsBuffer();
              }
            }

            // Flush candidate batch if full (reduced size)
            if (currentBatch.length >= EFFECTIVE_BATCH_SIZE) {
              flushBatch();
            }
          }
        }

        processed++;
        totalRockyouMatches += rockyouMatches;
        totalCandidates += candidates;

        // Mark prefix as completed in bitmap (O(1) operation)
        progressBitmap.set(prefix);

        // Progress report
        const now = Date.now();
        if (now - lastReport > 5000) {
          const elapsed = (now - startTime) / 1000;
          const rate = processed / elapsed;
          const remaining = pendingCount - processed;
          const eta = remaining / rate;
          const filterRate = totalRockyouMatches / (totalRockyouMatches + totalCandidates) * 100;

          console.log(
            `Progress: ${processed.toLocaleString()}/${pendingCount.toLocaleString()} prefixes ` +
              `(${((processed / pendingCount) * 100).toFixed(1)}%) | ` +
              `HIBP batch: ${hibpBatchId} | ` +
              `${rate.toFixed(1)}/sec | ` +
              `ETA: ${formatDuration(eta)} | ` +
              `Filtered: ${filterRate.toFixed(1)}% | ` +
              `Candidates: ${totalCandidates.toLocaleString()}`
          );
          lastReport = now;
        }

        // Save state periodically (every 30 seconds) instead of per-prefix
        if (now - lastStateSave > 30000) {
          pipelineState.filter.rockyouMatches = totalRockyouMatches;
          pipelineState.filter.candidates = totalCandidates;
          state.save();
          lastStateSave = now;
        }
      } catch (e) {
        console.error(`Error processing prefix ${prefix}: ${e}`);
      }
    }

    // Flush counts buffer after each HIBP batch
    flushCountsBuffer();

    // Explicitly release HIBP batch memory
    // @ts-ignore - help GC
    hibpBatch.entries = null;
  }

  // Flush remaining candidate batch
  flushBatch();

  // Close counts stream
  if (countsStream) {
    flushCountsBuffer();
    countsStream.end();
    console.log(`  Wrote counts index: ${countsIndexPath}`);
  }

  // Save final state
  pipelineState.filter.rockyouMatches = totalRockyouMatches;
  pipelineState.filter.candidates = totalCandidates;
  state.completeFilter();

  // Close bitmap
  progressBitmap.close();

  // Summary
  const totalTime = (Date.now() - startTime) / 1000;
  console.log("");
  console.log("Filter Complete (Batched)");
  console.log("=========================");
  console.log(`Prefixes processed: ${processed.toLocaleString()}`);
  console.log(`Rockyou matches (filtered): ${totalRockyouMatches.toLocaleString()}`);
  console.log(`Candidates (GRAVEL): ${totalCandidates.toLocaleString()}`);
  console.log(`Filter rate: ${(totalRockyouMatches / (totalRockyouMatches + totalCandidates) * 100).toFixed(2)}%`);
  console.log(`Output batches: ${batchNumber}`);
  console.log(`Compression: ${compress ? "enabled" : "disabled"}`);
  if (withCounts) {
    console.log(`Counts index: ${countsIndexPath}`);
  }
  console.log(`Time: ${formatDuration(totalTime)}`);
}

/**
 * Filter a single prefix (for testing)
 */
async function filterSingle(prefix: string): Promise<void> {
  // Load rockyou index
  if (!existsSync(ROCKYOU_BIN)) {
    console.error(`Rockyou index not found: ${ROCKYOU_BIN}`);
    console.error("Run: bun Tools/RockyouHasher.ts first");
    process.exit(1);
  }

  console.log("Loading rockyou SHA-1 index...");
  const rockyouIndex = new RockyouHashIndex(ROCKYOU_BIN);

  const result = filterPrefix(prefix.toUpperCase(), rockyouIndex);

  console.log("");
  console.log(`Prefix: ${result.prefix}`);
  console.log(`Total hashes: ${result.totalHashes}`);
  console.log(`Rockyou matches: ${result.rockyouMatches}`);
  console.log(`Candidates: ${result.candidates}`);
  console.log(`Filter rate: ${(result.rockyouMatches / result.totalHashes * 100).toFixed(2)}%`);
}

/**
 * Format duration in human-readable form
 */
function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(0)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${mins}m`;
}

// =============================================================================
// CLI Usage
// =============================================================================

if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args[0] === "--help" || args[0] === "-h") {
    console.log(`
SetDifference - Filter HIBP hashes against rockyou.txt

Usage:
  bun SetDifference.ts                     Filter all downloaded prefixes
  bun SetDifference.ts --batched           Filter from batched HIBP storage
  bun SetDifference.ts --prefix <hex>      Filter single prefix
  bun SetDifference.ts --batch-size <n>    Hashes per output file (default: 1M)

Options:
  --prefix <hex>      Single 5-char hex prefix
  --batch-size <n>    Number of hashes per batch file
  --no-resume         Start fresh, ignore previous progress
  --batched           Read from batched HIBP storage (use with --batched download)
  --compress          Compress output batches with gzip
  --no-counts         Skip writing counts-index.txt (saves memory)

Input Modes:
  Default:  Individual files from ${HIBP_DIR}/
  Batched:  Compressed archives from ${resolve(DATA_DIR, "hibp-batched")}/

Output: ${CANDIDATES_DIR}/
`);
    process.exit(0);
  }

  // Parse arguments
  let prefix: string | undefined;
  let batchSize = DEFAULT_BATCH_SIZE;
  let resume = true;
  let batched = false;
  let compress = false;
  let withCounts = true;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--prefix":
        prefix = args[++i];
        break;
      case "--batch-size":
        batchSize = parseInt(args[++i]) || DEFAULT_BATCH_SIZE;
        break;
      case "--no-resume":
        resume = false;
        break;
      case "--batched":
        batched = true;
        break;
      case "--compress":
        compress = true;
        break;
      case "--no-counts":
        withCounts = false;
        break;
    }
  }

  try {
    if (prefix) {
      await filterSingle(prefix);
    } else if (batched) {
      await filterAllBatched({ batchSize, resume, compress, withCounts });
    } else {
      await filterAll({ batchSize, resume });
    }
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
  }
}
