#!/usr/bin/env bun
/**
 * SetDifferenceStream.ts - Memory-efficient HIBP vs Rockyou Filter
 *
 * Uses streaming reader to process HIBP batches without loading entire JSON.
 * Peak memory: ~500MB (350MB decompressed batch + 286MB rockyou index)
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

import { existsSync, mkdirSync, writeFileSync, createWriteStream } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { StateManager } from "./StateManager";
import { RockyouHashIndex } from "./RockyouHasher";
import { streamBatchPrefixes } from "./HibpStreamReader";
import { PrefixBitmap } from "./PrefixBitmap";

// =============================================================================
// Configuration
// =============================================================================

const SKILL_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const DATA_DIR = resolve(SKILL_DIR, "data");
const HIBP_BATCH_DIR = resolve(DATA_DIR, "hibp-batched");
const CANDIDATES_DIR = resolve(DATA_DIR, "candidates");
const ROCKYOU_BIN = resolve(DATA_DIR, "rockyou-sha1.bin");

const DEFAULT_BATCH_SIZE = 500_000; // 500K hashes per output file

// =============================================================================
// Filter Implementation
// =============================================================================

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

/**
 * Filter all prefixes from batched storage using streaming reader
 * Memory efficient: ~500MB peak vs ~8GB with old method
 */
async function filterAllStreaming(options: {
  batchSize?: number;
  resume?: boolean;
  compress?: boolean;
  withCounts?: boolean;
} = {}): Promise<void> {
  const { batchSize = DEFAULT_BATCH_SIZE, resume = true, compress = false, withCounts = true } = options;

  // Ensure directories exist
  if (!existsSync(CANDIDATES_DIR)) {
    mkdirSync(CANDIDATES_DIR, { recursive: true });
  }

  // Load rockyou index (~286MB)
  if (!existsSync(ROCKYOU_BIN)) {
    console.error(`Rockyou index not found: ${ROCKYOU_BIN}`);
    console.error("Run: bun Tools/RockyouHasher.ts first");
    process.exit(1);
  }

  console.log("Loading rockyou SHA-1 index...");
  const rockyouIndex = new RockyouHashIndex(ROCKYOU_BIN);
  console.log(`  Loaded ${rockyouIndex.count.toLocaleString()} hashes`);

  const state = new StateManager(DATA_DIR);
  const pipelineState = state.load();

  // Use bitmap file for progress tracking (128KB)
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
  console.log("SetDifferenceStream Filter (Memory Efficient)");
  console.log("=============================================");
  console.log(`HIBP prefixes: ${TOTAL_PREFIXES.toLocaleString()}`);
  console.log(`Already filtered: ${completedCount.toLocaleString()}`);
  console.log(`Remaining: ${pendingCount.toLocaleString()}`);
  console.log(`Batch size: ${batchSize.toLocaleString()} hashes`);
  console.log(`Compression: ${compress}`);
  console.log(`Method: Streaming (low memory)`);
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

  // Current batch buffer
  let currentBatch: string[] = [];
  let batchNumber = pipelineState.filter.batchesWritten || 0;

  // Counts index stream
  const countsIndexPath = resolve(CANDIDATES_DIR, "counts-index.txt");
  let countsStream: ReturnType<typeof createWriteStream> | null = null;
  if (withCounts) {
    countsStream = createWriteStream(countsIndexPath, { flags: "a" });
  }

  // Small buffer for counts
  let countsBuffer: string[] = [];
  const COUNTS_FLUSH_SIZE = 10000;

  const flushCountsBuffer = () => {
    if (countsBuffer.length > 0 && countsStream) {
      countsStream.write(countsBuffer.join("\n") + "\n");
      countsBuffer = [];
    }
  };

  // Helper to flush batch to disk
  const flushBatch = () => {
    if (currentBatch.length === 0) return;

    batchNumber++;
    const batchContent = currentBatch.join("\n") + "\n";

    if (compress) {
      const batchFile = resolve(CANDIDATES_DIR, `batch-${String(batchNumber).padStart(4, "0")}.txt.gz`);
      const compressed = gzipSync(batchContent);
      writeFileSync(batchFile, compressed);
      console.log(`  Wrote batch ${batchNumber}: ${currentBatch.length.toLocaleString()} hashes (${(compressed.length / 1024 / 1024).toFixed(1)} MB compressed)`);
    } else {
      const batchFile = resolve(CANDIDATES_DIR, `batch-${String(batchNumber).padStart(4, "0")}.txt`);
      writeFileSync(batchFile, batchContent);
      console.log(`  Wrote batch ${batchNumber}: ${currentBatch.length.toLocaleString()} hashes`);
    }

    state.incrementBatchesWritten();
    currentBatch = [];
  };

  // Process each HIBP batch file (256 batches)
  for (let hibpBatchIdx = 0; hibpBatchIdx < 256; hibpBatchIdx++) {
    const hibpBatchId = hibpBatchIdx.toString(16).toUpperCase().padStart(2, "0");
    const batchPath = resolve(HIBP_BATCH_DIR, `hibp-${hibpBatchId}.json.gz`);

    if (!existsSync(batchPath)) {
      continue;
    }

    // Stream prefixes from this batch
    for (const { prefix, data } of streamBatchPrefixes(hibpBatchId, HIBP_BATCH_DIR)) {
      // Skip already completed
      if (progressBitmap.has(prefix)) {
        continue;
      }

      const lines = data.split("\n").filter((l) => l.length > 0);

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

          // Buffer counts
          if (withCounts) {
            countsBuffer.push(`${fullHash}:${count}`);
            if (countsBuffer.length >= COUNTS_FLUSH_SIZE) {
              flushCountsBuffer();
            }
          }

          // Flush candidate batch if full
          if (currentBatch.length >= batchSize) {
            flushBatch();
          }
        }
      }

      processed++;
      totalRockyouMatches += rockyouMatches;
      totalCandidates += candidates;

      // Mark prefix as completed
      progressBitmap.set(prefix);

      // Progress report
      const now = Date.now();
      if (now - lastReport > 10000) {
        const elapsed = (now - startTime) / 1000;
        const rate = processed / elapsed;
        const remaining = pendingCount - processed;
        const eta = remaining / rate;
        const filterRate = totalRockyouMatches / (totalRockyouMatches + totalCandidates) * 100;

        console.log(
          `Progress: ${processed.toLocaleString()}/${pendingCount.toLocaleString()} prefixes ` +
            `(${((processed / pendingCount) * 100).toFixed(1)}%) | ` +
            `HIBP batch: ${hibpBatchId} | ` +
            `${rate.toFixed(0)}/sec | ` +
            `ETA: ${formatDuration(eta)} | ` +
            `Filtered: ${filterRate.toFixed(1)}% | ` +
            `Candidates: ${totalCandidates.toLocaleString()}`
        );
        lastReport = now;
      }

      // Save state periodically
      if (now - lastStateSave > 60000) {
        pipelineState.filter.rockyouMatches = totalRockyouMatches;
        pipelineState.filter.candidates = totalCandidates;
        pipelineState.filter.batchesWritten = batchNumber;
        state.save();
        lastStateSave = now;
      }
    }

    // Flush counts buffer after each HIBP batch
    flushCountsBuffer();

    // Force GC hint between batches
    if (global.gc) {
      global.gc();
    }
  }

  // Flush remaining batch
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
  pipelineState.filter.batchesWritten = batchNumber;
  state.completeFilter();

  // Close bitmap
  progressBitmap.close();

  // Summary
  const totalTime = (Date.now() - startTime) / 1000;
  console.log("");
  console.log("Filter Complete (Streaming)");
  console.log("===========================");
  console.log(`Prefixes processed: ${processed.toLocaleString()}`);
  console.log(`Rockyou matches (filtered): ${totalRockyouMatches.toLocaleString()}`);
  console.log(`Candidates (GRAVEL): ${totalCandidates.toLocaleString()}`);
  console.log(`Filter rate: ${(totalRockyouMatches / (totalRockyouMatches + totalCandidates) * 100).toFixed(2)}%`);
  console.log(`Output batches: ${batchNumber}`);
  console.log(`Time: ${formatDuration(totalTime)}`);
}

// =============================================================================
// CLI Usage
// =============================================================================

if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args[0] === "--help" || args[0] === "-h") {
    console.log(`
SetDifferenceStream - Memory-efficient HIBP filter

Usage:
  bun SetDifferenceStream.ts                     Filter all batches
  bun SetDifferenceStream.ts --batch-size <n>    Hashes per output file

Options:
  --batch-size <n>    Number of hashes per batch file (default: 500K)
  --no-resume         Start fresh, ignore previous progress
  --compress          Compress output batches with gzip
  --no-counts         Skip writing counts-index.txt

Memory usage: ~500MB peak (286MB rockyou index + 350MB decompressed batch)
Output: ${CANDIDATES_DIR}/
`);
    process.exit(0);
  }

  // Parse arguments
  let batchSize = DEFAULT_BATCH_SIZE;
  let resume = true;
  let compress = false;
  let withCounts = true;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--batch-size":
        batchSize = parseInt(args[++i]) || DEFAULT_BATCH_SIZE;
        break;
      case "--no-resume":
        resume = false;
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
    await filterAllStreaming({ batchSize, resume, compress, withCounts });
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    console.error((e as Error).stack);
    process.exit(1);
  }
}
