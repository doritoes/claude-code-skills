#!/usr/bin/env bun
/**
 * RocksExtractor.ts - Extract ALL HIBP hashes into ROCKS batch files
 *
 * Reads HIBP batched JSON files and extracts ALL SHA-1 hashes (no filtering)
 * into plain text batch files. This materializes the ROCKS pipeline stage
 * that was previously skipped by GravelFilter.
 *
 * Pipeline: hibp-batched/ (JSON) → rocks/ (plain text) → gravel/ (filtered)
 *
 * The ROCKS stage enables per-batch verification:
 *   rocks/batch-NNNN.txt - rockyou = gravel/batch-NNNN.txt
 *
 * Usage:
 *   bun Tools/RocksExtractor.ts              Extract all (with resume)
 *   bun Tools/RocksExtractor.ts --no-resume  Start fresh
 *   bun Tools/RocksExtractor.ts --status     Show progress
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, openSync, writeSync, closeSync } from "node:fs";
import { resolve } from "node:path";
import { DATA_DIR, ROCKS_DIR } from "./config";
import { streamBatchPrefixes } from "./HibpStreamReader";

// =============================================================================
// Configuration
// =============================================================================

const HIBP_BATCH_DIR = resolve(DATA_DIR, "hibp-batched");
const BATCH_SIZE = 500_000;
const PROGRESS_FILE = resolve(DATA_DIR, "rocks-progress.json");

// =============================================================================
// Progress Tracking
// =============================================================================

interface RocksProgress {
  lastCompletedHibpBatch: number; // 0-255, -1 if none completed
  totalHashesExtracted: number;
  batchesWritten: number;
  startedAt: string;
  lastUpdated: string;
}

function loadProgress(): RocksProgress {
  if (existsSync(PROGRESS_FILE)) {
    return JSON.parse(readFileSync(PROGRESS_FILE, "utf-8"));
  }
  return {
    lastCompletedHibpBatch: -1,
    totalHashesExtracted: 0,
    batchesWritten: 0,
    startedAt: new Date().toISOString(),
    lastUpdated: new Date().toISOString(),
  };
}

function saveProgress(progress: RocksProgress): void {
  progress.lastUpdated = new Date().toISOString();
  writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

// =============================================================================
// Utilities
// =============================================================================

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(0)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${mins}m`;
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

// =============================================================================
// Extraction Logic
// =============================================================================

async function extractRocks(options: { resume?: boolean } = {}): Promise<void> {
  const { resume = true } = options;

  if (!existsSync(ROCKS_DIR)) {
    mkdirSync(ROCKS_DIR, { recursive: true });
  }

  if (!existsSync(HIBP_BATCH_DIR)) {
    console.error(`HIBP batch directory not found: ${HIBP_BATCH_DIR}`);
    process.exit(1);
  }

  let progress: RocksProgress;
  if (resume) {
    progress = loadProgress();
  } else {
    progress = {
      lastCompletedHibpBatch: -1,
      totalHashesExtracted: 0,
      batchesWritten: 0,
      startedAt: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
    };
  }

  const startFrom = progress.lastCompletedHibpBatch + 1;
  const remainingBatches = 256 - startFrom;

  console.log("");
  console.log("RocksExtractor - HIBP → ROCKS");
  console.log("=============================");
  console.log(`HIBP source:  ${HIBP_BATCH_DIR}`);
  console.log(`ROCKS output: ${ROCKS_DIR}`);
  console.log(`Batch size:   ${BATCH_SIZE.toLocaleString()} hashes per file`);
  console.log(`Resume from:  HIBP batch ${startFrom} (${remainingBatches} remaining)`);
  console.log(`Extracted:    ${progress.totalHashesExtracted.toLocaleString()} hashes so far`);
  console.log(`Batches:      ${progress.batchesWritten} written so far`);
  console.log("");

  if (remainingBatches === 0) {
    console.log("All HIBP batches already extracted!");
    return;
  }

  const startTime = Date.now();
  let batchNumber = progress.batchesWritten;
  let totalExtracted = progress.totalHashesExtracted;

  // Stream directly to files — no large array in memory.
  // Buffer small chunks (~2MB) and flush to fd periodically.
  const BUFFER_FLUSH = 50_000; // flush every 50K lines (~2MB)
  let fd: number | null = null;
  let lineCount = 0;
  let writeBuffer = "";

  const nextBatchFile = () => {
    batchNumber++;
    return resolve(ROCKS_DIR, `batch-${String(batchNumber).padStart(4, "0")}.txt`);
  };

  const flushBuffer = () => {
    if (writeBuffer && fd !== null) {
      writeSync(fd, writeBuffer);
      writeBuffer = "";
    }
  };

  const rotateBatch = () => {
    flushBuffer();
    if (fd !== null) closeSync(fd);
    fd = openSync(nextBatchFile(), "w");
    lineCount = 0;
  };

  // Open first batch file
  rotateBatch();

  // Process each HIBP batch file (00-FF)
  for (let hibpIdx = startFrom; hibpIdx < 256; hibpIdx++) {
    const hibpId = hibpIdx.toString(16).toUpperCase().padStart(2, "0");
    const batchPath = resolve(HIBP_BATCH_DIR, `hibp-${hibpId}.json.gz`);

    if (!existsSync(batchPath)) {
      console.log(`  SKIP hibp-${hibpId}.json.gz (not found)`);
      continue;
    }

    let batchHashes = 0;

    for (const { prefix, data } of streamBatchPrefixes(hibpId, HIBP_BATCH_DIR)) {
      const lines = data.split("\n").filter((l) => l.length > 0);

      for (const line of lines) {
        const colonIdx = line.indexOf(":");
        if (colonIdx !== 35) continue;

        const suffix = line.substring(0, 35);
        const fullHash = (prefix + suffix).toUpperCase();

        writeBuffer += fullHash + "\n";
        lineCount++;
        batchHashes++;
        totalExtracted++;

        // Flush write buffer periodically
        if (lineCount % BUFFER_FLUSH === 0) {
          flushBuffer();
        }

        // Rotate to next batch file at BATCH_SIZE
        if (lineCount >= BATCH_SIZE) {
          rotateBatch();
        }
      }
    }

    // Progress report
    const now = Date.now();
    const elapsed = (now - startTime) / 1000;
    const processed = hibpIdx - startFrom + 1;
    const rate = processed / elapsed;
    const remaining = 255 - hibpIdx;
    const eta = rate > 0 ? remaining / rate : 0;

    console.log(
      `  HIBP ${hibpId}: ${batchHashes.toLocaleString()} hashes | ` +
        `Total: ${totalExtracted.toLocaleString()} | ` +
        `ROCKS batches: ${batchNumber} | ` +
        `${processed}/${remainingBatches} (${((processed / remainingBatches) * 100).toFixed(1)}%) | ` +
        `ETA: ${formatDuration(eta)}`
    );

    // Save progress after each HIBP batch
    progress.lastCompletedHibpBatch = hibpIdx;
    progress.totalHashesExtracted = totalExtracted;
    progress.batchesWritten = batchNumber;
    saveProgress(progress);

    // GC hint between batches
    if (global.gc) global.gc();
  }

  // Flush remaining data and close last file
  flushBuffer();
  if (fd !== null) closeSync(fd);

  // Final save
  progress.totalHashesExtracted = totalExtracted;
  progress.batchesWritten = batchNumber;
  saveProgress(progress);

  const totalTime = (Date.now() - startTime) / 1000;
  const avgPerBatch = totalExtracted / batchNumber;

  console.log("");
  console.log("Extraction Complete");
  console.log("===================");
  console.log(`Total hashes extracted: ${totalExtracted.toLocaleString()}`);
  console.log(`ROCKS batches written:  ${batchNumber}`);
  console.log(`Avg hashes per batch:   ${Math.round(avgPerBatch).toLocaleString()}`);
  console.log(`Time: ${formatDuration(totalTime)}`);
  console.log("");
  console.log("Next step: Regenerate GRAVEL from ROCKS");
  console.log("  bun Tools/GravelFilter.ts");
}

// =============================================================================
// Status Display
// =============================================================================

function showStatus(): void {
  const progress = loadProgress();

  console.log("");
  console.log("RocksExtractor Progress");
  console.log("=======================");
  console.log(`HIBP batches completed: ${progress.lastCompletedHibpBatch + 1}/256`);
  console.log(`Hashes extracted:       ${progress.totalHashesExtracted.toLocaleString()}`);
  console.log(`ROCKS batches written:  ${progress.batchesWritten}`);
  console.log(`Started:                ${progress.startedAt}`);
  console.log(`Last updated:           ${progress.lastUpdated}`);

  // Count actual files on disk
  if (existsSync(ROCKS_DIR)) {
    const files = readdirSync(ROCKS_DIR).filter((f) => f.startsWith("batch-") && f.endsWith(".txt"));
    console.log(`Files on disk:          ${files.length}`);
  }

  const pct = ((progress.lastCompletedHibpBatch + 1) / 256) * 100;
  if (pct < 100) {
    console.log(`\nProgress: ${pct.toFixed(1)}% — resume with: bun Tools/RocksExtractor.ts`);
  } else {
    console.log(`\nComplete! Next: bun Tools/GravelFilter.ts`);
  }
}

// =============================================================================
// CLI
// =============================================================================

if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args[0] === "--help" || args[0] === "-h") {
    console.log(`
RocksExtractor - Extract ALL HIBP hashes into ROCKS batch files

Usage:
  bun Tools/RocksExtractor.ts              Extract all (with resume)
  bun Tools/RocksExtractor.ts --no-resume  Start fresh
  bun Tools/RocksExtractor.ts --status     Show progress

Pipeline: hibp-batched/ (JSON) → rocks/ (plain text) → gravel/ (filtered)
Output:   ${ROCKS_DIR}/batch-NNNN.txt (${BATCH_SIZE.toLocaleString()} hashes each)

Each output file contains plain SHA-1 hashes (uppercase, one per line).
Resume is automatic — interrupted runs continue from the last completed HIBP batch.
`);
    process.exit(0);
  }

  if (args[0] === "--status") {
    showStatus();
    process.exit(0);
  }

  const resume = !args.includes("--no-resume");

  try {
    await extractRocks({ resume });
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    console.error((e as Error).stack);
    process.exit(1);
  }
}
