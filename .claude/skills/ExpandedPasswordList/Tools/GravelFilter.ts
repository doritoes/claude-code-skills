#!/usr/bin/env bun
/**
 * GravelFilter.ts - ROCKS → GRAVEL Filter (1:1 batch correspondence)
 *
 * Reads rockyou.txt from disk, computes SHA-1 hashes in memory, then filters
 * each ROCKS batch to produce a corresponding GRAVEL batch.
 *
 * Invariant: rocks/batch-NNNN.txt - SHA1(rockyou.txt) = gravel/batch-NNNN.txt
 *
 * No pre-computed indexes. No trust in intermediate files. Straight from source.
 *
 * Pipeline: rocks/ → [THIS] → gravel/
 *
 * Memory: ~3GB (14.3M SHA-1 hashes in Set). Use: bun --max-old-space-size=4096
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { DATA_DIR, ROCKS_DIR, GRAVEL_DIR } from "./config";

// =============================================================================
// Paths
// =============================================================================

const CURRENT_FILE = fileURLToPath(import.meta.url);
const TOOLS_DIR = dirname(CURRENT_FILE);
const SKILL_DIR = dirname(TOOLS_DIR);
const PROJECT_ROOT = resolve(SKILL_DIR, "..", "..", "..");
const DEFAULT_ROCKYOU = resolve(PROJECT_ROOT, "rockyou.txt");
const PROGRESS_FILE = resolve(DATA_DIR, "gravel-filter-progress.json");

// =============================================================================
// Progress Tracking
// =============================================================================

interface FilterProgress {
  lastCompletedBatch: number;
  totalRocksHashes: number;
  totalRockyouFiltered: number;
  totalGravelHashes: number;
  batchesProcessed: number;
  rockyouEntries: number;
  rockyouPath: string;
  startedAt: string;
  lastUpdated: string;
}

function loadProgress(): FilterProgress {
  if (existsSync(PROGRESS_FILE)) {
    return JSON.parse(readFileSync(PROGRESS_FILE, "utf-8"));
  }
  return {
    lastCompletedBatch: 0,
    totalRocksHashes: 0,
    totalRockyouFiltered: 0,
    totalGravelHashes: 0,
    batchesProcessed: 0,
    rockyouEntries: 0,
    rockyouPath: "",
    startedAt: new Date().toISOString(),
    lastUpdated: new Date().toISOString(),
  };
}

function saveProgress(progress: FilterProgress): void {
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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)}GB`;
}

// =============================================================================
// Core: Build rockyou SHA-1 Set from source
// =============================================================================

/**
 * Read rockyou.txt, SHA-1 hash every entry, return as Set<string> (uppercase hex).
 * This is the single source of truth — no pre-computed indexes.
 */
function buildRockyouHashSet(rockyouPath: string): Set<string> {
  console.log(`Reading rockyou.txt from: ${rockyouPath}`);
  const startTime = Date.now();

  const content = readFileSync(rockyouPath, "utf-8");
  const lines = content.split("\n");

  console.log(`  ${lines.length.toLocaleString()} lines read (${formatBytes(content.length)})`);
  console.log("  Computing SHA-1 hashes...");

  const hashSet = new Set<string>();
  let processed = 0;
  let skipped = 0;

  for (const line of lines) {
    // Skip empty lines
    if (line.length === 0) {
      skipped++;
      continue;
    }

    // Strip trailing \r if present (Windows line endings)
    const entry = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (entry.length === 0) {
      skipped++;
      continue;
    }

    const sha1 = createHash("sha1").update(entry, "utf-8").digest("hex").toUpperCase();
    hashSet.add(sha1);
    processed++;

    // Progress every 1M entries
    if (processed % 1_000_000 === 0) {
      const elapsed = (Date.now() - startTime) / 1000;
      const heapMB = Math.round(process.memoryUsage().heapUsed / (1024 * 1024));
      console.log(`    ${(processed / 1_000_000).toFixed(0)}M hashed... (${heapMB}MB heap, ${formatDuration(elapsed)})`);
    }
  }

  const elapsed = (Date.now() - startTime) / 1000;
  const heapMB = Math.round(process.memoryUsage().heapUsed / (1024 * 1024));

  console.log(`  Done: ${hashSet.size.toLocaleString()} unique SHA-1 hashes from ${processed.toLocaleString()} entries`);
  console.log(`  Skipped: ${skipped.toLocaleString()} empty lines`);
  console.log(`  Duplicates: ${(processed - hashSet.size).toLocaleString()}`);
  console.log(`  Time: ${formatDuration(elapsed)} | Heap: ${heapMB}MB`);

  return hashSet;
}

// =============================================================================
// Batch Processing
// =============================================================================

function getRocksBatches(): { number: number; filename: string }[] {
  if (!existsSync(ROCKS_DIR)) return [];

  return readdirSync(ROCKS_DIR)
    .filter((f) => f.startsWith("batch-") && f.endsWith(".txt"))
    .map((f) => {
      const match = f.match(/^batch-(\d+)\.txt$/);
      return match ? { number: parseInt(match[1]), filename: f } : null;
    })
    .filter((x): x is { number: number; filename: string } => x !== null)
    .sort((a, b) => a.number - b.number);
}

/**
 * Filter a single rocks batch → gravel batch using the in-memory hash Set
 */
function filterBatch(
  rockyouHashes: Set<string>,
  rocksBatchFile: string,
  gravelBatchFile: string
): { rocksCount: number; filteredCount: number; gravelCount: number } {
  const content = readFileSync(rocksBatchFile, "utf-8");
  const lines = content.split("\n").filter((l) => l.length > 0);

  const gravelHashes: string[] = [];
  let filteredCount = 0;

  for (const hash of lines) {
    if (rockyouHashes.has(hash.toUpperCase())) {
      filteredCount++;
    } else {
      gravelHashes.push(hash);
    }
  }

  // Write gravel batch (even if empty — maintains 1:1 correspondence)
  writeFileSync(gravelBatchFile, gravelHashes.join("\n") + "\n");

  return {
    rocksCount: lines.length,
    filteredCount,
    gravelCount: gravelHashes.length,
  };
}

/**
 * Filter all rocks batches → gravel batches
 */
async function filterAllBatches(options: {
  resume?: boolean;
  rockyouPath?: string;
} = {}): Promise<void> {
  const { resume = true, rockyouPath = DEFAULT_ROCKYOU } = options;

  // Validate rockyou.txt exists
  if (!existsSync(rockyouPath)) {
    console.error(`rockyou.txt not found: ${rockyouPath}`);
    console.error("Provide path: bun Tools/GravelFilter.ts --rockyou /path/to/rockyou.txt");
    process.exit(1);
  }

  // Ensure gravel dir exists
  if (!existsSync(GRAVEL_DIR)) {
    mkdirSync(GRAVEL_DIR, { recursive: true });
  }

  // Get rocks batches
  const rocksBatches = getRocksBatches();
  if (rocksBatches.length === 0) {
    console.error(`No rocks batches found in ${ROCKS_DIR}`);
    console.error("Run: bun Tools/RocksExtractor.ts first");
    process.exit(1);
  }

  // Build SHA-1 hash set from rockyou.txt (the expensive part)
  const rockyouHashes = buildRockyouHashSet(rockyouPath);

  let progress: FilterProgress;
  if (resume) {
    progress = loadProgress();
    // If resuming but rockyou path changed, warn
    if (progress.rockyouPath && progress.rockyouPath !== rockyouPath) {
      console.warn(`\nWARNING: rockyou path changed since last run!`);
      console.warn(`  Previous: ${progress.rockyouPath}`);
      console.warn(`  Current:  ${rockyouPath}`);
      console.warn(`  Use --no-resume to start fresh\n`);
    }
  } else {
    progress = {
      lastCompletedBatch: 0,
      totalRocksHashes: 0,
      totalRockyouFiltered: 0,
      totalGravelHashes: 0,
      batchesProcessed: 0,
      rockyouEntries: rockyouHashes.size,
      rockyouPath,
      startedAt: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
    };
  }

  // Update rockyou metadata
  progress.rockyouEntries = rockyouHashes.size;
  progress.rockyouPath = rockyouPath;

  // Filter to pending batches
  const pendingBatches = rocksBatches.filter((b) => b.number > progress.lastCompletedBatch);

  console.log("");
  console.log("GravelFilter - ROCKS → GRAVEL Filter");
  console.log("============================================");
  console.log(`Rockyou source: ${rockyouPath}`);
  console.log(`Rockyou hashes: ${rockyouHashes.size.toLocaleString()}`);
  console.log(`ROCKS source:   ${ROCKS_DIR}`);
  console.log(`GRAVEL output:  ${GRAVEL_DIR}`);
  console.log(`Total batches:  ${rocksBatches.length}`);
  console.log(`Already done:   ${progress.batchesProcessed}`);
  console.log(`Pending:        ${pendingBatches.length}`);
  console.log(`Mode:           1:1 (rocks[N] - SHA1(rockyou) = gravel[N])`);
  console.log("");

  if (pendingBatches.length === 0) {
    console.log("All batches already filtered!");
    return;
  }

  const startTime = Date.now();

  for (let i = 0; i < pendingBatches.length; i++) {
    const batch = pendingBatches[i];
    const batchName = `batch-${String(batch.number).padStart(4, "0")}`;
    const rocksFile = resolve(ROCKS_DIR, batch.filename);
    const gravelFile = resolve(GRAVEL_DIR, `${batchName}.txt`);

    const result = filterBatch(rockyouHashes, rocksFile, gravelFile);

    progress.totalRocksHashes += result.rocksCount;
    progress.totalRockyouFiltered += result.filteredCount;
    progress.totalGravelHashes += result.gravelCount;
    progress.batchesProcessed++;
    progress.lastCompletedBatch = batch.number;

    // Verify invariant
    const invariantOk = result.rocksCount === result.filteredCount + result.gravelCount;

    // Progress report
    const elapsed = (Date.now() - startTime) / 1000;
    const processed = i + 1;
    const rate = processed / elapsed;
    const remaining = pendingBatches.length - processed;
    const eta = rate > 0 ? remaining / rate : 0;
    const filterPct = result.rocksCount > 0
      ? ((result.filteredCount / result.rocksCount) * 100).toFixed(1)
      : "0";

    console.log(
      `  ${batchName}: ${result.rocksCount.toLocaleString()} rocks → ` +
        `${result.gravelCount.toLocaleString()} gravel (${filterPct}% filtered) ` +
        `${invariantOk ? "OK" : "MISMATCH!"} | ` +
        `${processed}/${pendingBatches.length} | ` +
        `ETA: ${formatDuration(eta)}`
    );

    if (!invariantOk) {
      console.error(`  INVARIANT VIOLATION: ${result.rocksCount} != ${result.filteredCount} + ${result.gravelCount}`);
    }

    // Save progress every 50 batches
    if (processed % 50 === 0) {
      saveProgress(progress);
    }
  }

  // Final save
  saveProgress(progress);

  const totalTime = (Date.now() - startTime) / 1000;
  const overallFilterRate = progress.totalRocksHashes > 0
    ? ((progress.totalRockyouFiltered / progress.totalRocksHashes) * 100).toFixed(2)
    : "0";

  console.log("");
  console.log("Filter Complete");
  console.log("===============");
  console.log(`Batches processed:      ${progress.batchesProcessed}`);
  console.log(`Total ROCKS hashes:     ${progress.totalRocksHashes.toLocaleString()}`);
  console.log(`Rockyou filtered:       ${progress.totalRockyouFiltered.toLocaleString()} (${overallFilterRate}%)`);
  console.log(`GRAVEL output:          ${progress.totalGravelHashes.toLocaleString()}`);
  console.log(`Time:                   ${formatDuration(totalTime)}`);
  console.log(`Invariant:              rocks[N] - SHA1(rockyou) = gravel[N]`);
}

/**
 * Verify existing rocks/gravel 1:1 correspondence
 */
async function verifyBatches(rockyouPath: string): Promise<void> {
  if (!existsSync(rockyouPath)) {
    console.error(`rockyou.txt not found: ${rockyouPath}`);
    process.exit(1);
  }

  const rockyouHashes = buildRockyouHashSet(rockyouPath);
  const rocksBatches = getRocksBatches();
  let violations = 0;
  let verified = 0;

  console.log(`\nVerifying ${rocksBatches.length} batch pairs...`);

  for (const batch of rocksBatches) {
    const batchName = `batch-${String(batch.number).padStart(4, "0")}`;
    const rocksFile = resolve(ROCKS_DIR, batch.filename);
    const gravelFile = resolve(GRAVEL_DIR, `${batchName}.txt`);

    if (!existsSync(gravelFile)) {
      console.log(`  ${batchName}: MISSING gravel file`);
      violations++;
      continue;
    }

    const rocksLines = readFileSync(rocksFile, "utf-8").split("\n").filter((l) => l.length > 0);
    const gravelLines = new Set(
      readFileSync(gravelFile, "utf-8").split("\n").filter((l) => l.length > 0)
    );

    let rockyouInGravel = 0;
    let gravelNotInRocks = 0;

    const rocksSet = new Set(rocksLines);
    for (const hash of gravelLines) {
      if (!rocksSet.has(hash)) gravelNotInRocks++;
      if (rockyouHashes.has(hash.toUpperCase())) rockyouInGravel++;
    }

    let unaccounted = 0;
    for (const hash of rocksLines) {
      if (!gravelLines.has(hash) && !rockyouHashes.has(hash.toUpperCase())) {
        unaccounted++;
      }
    }

    if (rockyouInGravel > 0 || gravelNotInRocks > 0 || unaccounted > 0) {
      console.log(
        `  ${batchName}: VIOLATION — rockyou_in_gravel=${rockyouInGravel}, ` +
          `gravel_not_in_rocks=${gravelNotInRocks}, unaccounted=${unaccounted}`
      );
      violations++;
    } else {
      verified++;
    }

    if ((verified + violations) % 100 === 0) {
      console.log(`  ... ${verified + violations}/${rocksBatches.length} checked`);
    }
  }

  console.log(
    `\nVerification: ${verified} OK, ${violations} violations out of ${rocksBatches.length} batches`
  );
}

// =============================================================================
// Status Display
// =============================================================================

function showStatus(): void {
  const progress = loadProgress();
  const rocksBatches = getRocksBatches();

  let gravelCount = 0;
  if (existsSync(GRAVEL_DIR)) {
    gravelCount = readdirSync(GRAVEL_DIR).filter(
      (f) => f.startsWith("batch-") && f.endsWith(".txt")
    ).length;
  }

  console.log("");
  console.log("GravelFilter Status");
  console.log("==========================");
  console.log(`Rockyou source:    ${progress.rockyouPath || "(not set)"}`);
  console.log(`Rockyou hashes:    ${progress.rockyouEntries.toLocaleString()}`);
  console.log(`ROCKS batches:     ${rocksBatches.length}`);
  console.log(`GRAVEL batches:    ${gravelCount}`);
  console.log(`Batches filtered:  ${progress.batchesProcessed}`);
  console.log(`ROCKS hashes:      ${progress.totalRocksHashes.toLocaleString()}`);
  console.log(`Rockyou filtered:  ${progress.totalRockyouFiltered.toLocaleString()}`);
  console.log(`GRAVEL hashes:     ${progress.totalGravelHashes.toLocaleString()}`);
  console.log(`Started:           ${progress.startedAt}`);
  console.log(`Last updated:      ${progress.lastUpdated}`);

  if (progress.batchesProcessed < rocksBatches.length) {
    const remaining = rocksBatches.length - progress.batchesProcessed;
    console.log(`\nPending: ${remaining} batches — resume with: bun Tools/GravelFilter.ts`);
  } else {
    console.log(`\nComplete! All ${rocksBatches.length} batches filtered.`);
  }
}

// =============================================================================
// CLI
// =============================================================================

if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args[0] === "--help" || args[0] === "-h") {
    console.log(`
GravelFilter - ROCKS → GRAVEL Filter (1:1 batch correspondence)

Usage:
  bun Tools/GravelFilter.ts                   Filter all rocks → gravel (with resume)
  bun Tools/GravelFilter.ts --no-resume        Start fresh (re-filter all)
  bun Tools/GravelFilter.ts --verify            Verify rocks/gravel invariant
  bun Tools/GravelFilter.ts --status            Show progress
  bun Tools/GravelFilter.ts --rockyou PATH      Use alternate rockyou.txt

Pipeline: rocks/batch-NNNN.txt → [filter - SHA1(rockyou.txt)] → gravel/batch-NNNN.txt
Invariant: rocks[N] - SHA1(rockyou) = gravel[N]

Method:
  1. Reads rockyou.txt from disk (plain text)
  2. Computes SHA-1 hash of every entry in memory
  3. Filters each rocks batch against the hash Set
  4. Writes corresponding gravel batch

No pre-computed indexes. No trust in intermediate files.

Memory: ~3GB (14.3M SHA-1 hashes in Set)
  If OOM: bun --max-old-space-size=4096 Tools/GravelFilter.ts

Requires:
  - rocks/ directory populated by RocksExtractor.ts
  - rockyou.txt (default: ${DEFAULT_ROCKYOU})
`);
    process.exit(0);
  }

  // Parse --rockyou PATH
  let rockyouPath = DEFAULT_ROCKYOU;
  const rockyouIdx = args.indexOf("--rockyou");
  if (rockyouIdx !== -1 && args[rockyouIdx + 1]) {
    rockyouPath = resolve(args[rockyouIdx + 1]);
  }

  if (args[0] === "--status") {
    showStatus();
    process.exit(0);
  }

  if (args[0] === "--verify") {
    try {
      await verifyBatches(rockyouPath);
    } catch (e) {
      console.error(`Error: ${(e as Error).message}`);
      process.exit(1);
    }
    process.exit(0);
  }

  const resume = !args.includes("--no-resume");

  try {
    await filterAllBatches({ resume, rockyouPath });
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    console.error((e as Error).stack);
    process.exit(1);
  }
}
