#!/usr/bin/env bun
/**
 * StateRecovery.ts - Rebuild state.json from existing batch files
 *
 * Scans hibp-batched directory and reconstructs the completedPrefixes list
 * from actual downloaded data.
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

import { existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const SKILL_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const DATA_DIR = resolve(SKILL_DIR, "data");
const HIBP_BATCH_DIR = resolve(DATA_DIR, "hibp-batched");
const STATE_FILE = resolve(DATA_DIR, "state.json");

interface PipelineState {
  version: number;
  lastUpdated: string;
  download: {
    status: "pending" | "in_progress" | "completed";
    completedPrefixes: string[];
    totalHashes: number;
    startedAt?: string;
    completedAt?: string;
    useBatchedStorage?: boolean;
    etags?: Record<string, string>;
    checksums?: Record<string, string>;
  };
  filter: {
    status: "pending" | "in_progress" | "completed";
    completedPrefixes: string[];
    rockyouMatches: number;
    candidates: number;
    batchesWritten: number;
    useCompression?: boolean;
  };
  crack: {
    status: "pending" | "in_progress" | "completed";
    hashlistIds: number[];
    taskIds: number[];
    totalSubmitted: number;
    totalCracked: number;
  };
  results: {
    crackedPasswords: number;
    hardPasswords: number;
    lastCollected?: string;
    lastPublished?: string;
    publishedCommit?: string;
  };
}

function createEmptyState(): PipelineState {
  return {
    version: 1,
    lastUpdated: new Date().toISOString(),
    download: {
      status: "pending",
      completedPrefixes: [],
      totalHashes: 0,
      useBatchedStorage: true,
    },
    filter: {
      status: "pending",
      completedPrefixes: [],
      rockyouMatches: 0,
      candidates: 0,
      batchesWritten: 0,
    },
    crack: {
      status: "pending",
      hashlistIds: [],
      taskIds: [],
      totalSubmitted: 0,
      totalCracked: 0,
    },
    results: {
      crackedPasswords: 0,
      hardPasswords: 0,
    },
  };
}

async function recoverState(): Promise<void> {
  console.log("State Recovery Tool");
  console.log("===================");
  console.log("");

  if (!existsSync(HIBP_BATCH_DIR)) {
    console.log("No hibp-batched directory found. Nothing to recover.");
    return;
  }

  // Find all batch files
  const batchFiles = readdirSync(HIBP_BATCH_DIR)
    .filter((f) => f.startsWith("hibp-") && f.endsWith(".json.gz"))
    .sort();

  console.log(`Found ${batchFiles.length} batch files`);
  console.log("");

  const state = createEmptyState();
  state.download.status = "in_progress";
  state.download.startedAt = new Date().toISOString();

  let totalPrefixes = 0;
  let totalHashes = 0;
  let skippedBatches = 0;

  for (const batchFile of batchFiles) {
    const batchPath = resolve(HIBP_BATCH_DIR, batchFile);
    const stats = require("fs").statSync(batchPath);

    // Skip empty/corrupted files
    if (stats.size === 0) {
      console.log(`  Skipping empty batch: ${batchFile}`);
      skippedBatches++;
      continue;
    }

    try {
      const compressed = readFileSync(batchPath);
      const json = gunzipSync(compressed).toString("utf-8");
      const batch = JSON.parse(json);

      const prefixes = Object.keys(batch.entries || {});

      for (const prefix of prefixes) {
        state.download.completedPrefixes.push(prefix);
        totalPrefixes++;

        // Count hashes in this prefix
        const entry = batch.entries[prefix];
        if (entry?.data) {
          const lines = entry.data.trim().split("\n").filter((l: string) => l.length > 0);
          totalHashes += lines.length;
        }
      }

      console.log(`  ${batchFile}: ${prefixes.length} prefixes`);
    } catch (e) {
      console.log(`  Error reading ${batchFile}: ${e}`);
      skippedBatches++;
    }
  }

  state.download.totalHashes = totalHashes;

  // Check if download is complete (all 256 batches with all prefixes)
  if (state.download.completedPrefixes.length === 1048576) {
    state.download.status = "completed";
    state.download.completedAt = new Date().toISOString();
  }

  // Sort prefixes for cleaner state file
  state.download.completedPrefixes.sort();

  // Write recovered state
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

  console.log("");
  console.log("Recovery Complete");
  console.log("=================");
  console.log(`Batches processed: ${batchFiles.length - skippedBatches}`);
  console.log(`Batches skipped: ${skippedBatches}`);
  console.log(`Prefixes recovered: ${totalPrefixes.toLocaleString()}`);
  console.log(`Hashes counted: ${totalHashes.toLocaleString()}`);
  console.log(`State saved to: ${STATE_FILE}`);
  console.log("");
  console.log(`Progress: ${((totalPrefixes / 1048576) * 100).toFixed(1)}% complete`);
  console.log(`Remaining: ${(1048576 - totalPrefixes).toLocaleString()} prefixes`);
}

/**
 * Recover filter state from existing batch files
 */
async function recoverFilterState(): Promise<void> {
  console.log("Filter State Recovery");
  console.log("=====================");
  console.log("");

  const candidatesDir = resolve(DATA_DIR, "candidates");
  if (!existsSync(candidatesDir)) {
    console.log("No candidates directory found. Nothing to recover.");
    return;
  }

  // Find all batch files
  const batchFiles = readdirSync(candidatesDir)
    .filter((f) => f.startsWith("batch-") && (f.endsWith(".txt") || f.endsWith(".txt.gz")))
    .sort();

  console.log(`Found ${batchFiles.length} candidate batch files`);

  if (batchFiles.length === 0) {
    console.log("No batch files to recover from.");
    return;
  }

  // Load or create state
  let state: PipelineState;
  if (existsSync(STATE_FILE)) {
    try {
      state = JSON.parse(readFileSync(STATE_FILE, "utf-8"));
    } catch {
      state = createEmptyState();
    }
  } else {
    state = createEmptyState();
  }

  // Count hashes in batch files to estimate prefixes processed
  let totalCandidates = 0;
  let maxBatchNumber = 0;

  for (const batchFile of batchFiles) {
    // Extract batch number from filename (batch-001.txt.gz -> 1)
    const match = batchFile.match(/batch-(\d+)/);
    if (match) {
      const batchNum = parseInt(match[1]);
      if (batchNum > maxBatchNumber) {
        maxBatchNumber = batchNum;
      }
    }

    // Each batch has 1M hashes
    totalCandidates += 1_000_000;
  }

  // Estimate prefixes processed based on candidates
  // Average ~2050 candidates per prefix (based on 0.7% filter rate)
  const estimatedPrefixes = Math.floor(totalCandidates / 2050);

  // Generate the prefix list for completed prefixes
  // We need to mark prefixes 00000 through the estimated count as complete
  const completedPrefixes: string[] = [];
  for (let i = 0; i < estimatedPrefixes && i < 1048576; i++) {
    completedPrefixes.push(i.toString(16).toUpperCase().padStart(5, "0"));
  }

  // Update filter state
  state.filter.status = "in_progress";
  state.filter.completedPrefixes = completedPrefixes;
  state.filter.candidates = totalCandidates;
  state.filter.batchesWritten = maxBatchNumber;
  state.filter.rockyouMatches = Math.floor(totalCandidates * 0.007 / 0.993); // Estimate from 0.7% rate
  state.lastUpdated = new Date().toISOString();

  // Save state
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

  console.log("");
  console.log("Filter State Recovered");
  console.log("======================");
  console.log(`Batch files found: ${batchFiles.length}`);
  console.log(`Max batch number: ${maxBatchNumber}`);
  console.log(`Estimated candidates: ${totalCandidates.toLocaleString()}`);
  console.log(`Estimated prefixes completed: ${estimatedPrefixes.toLocaleString()}`);
  console.log(`State saved to: ${STATE_FILE}`);
  console.log("");
  console.log("Note: This is an estimate. Some prefixes may be reprocessed.");
}

if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args[0] === "--filter" || args[0] === "-f") {
    await recoverFilterState();
  } else {
    await recoverState();
    console.log("");
    console.log("To recover filter state, run: bun StateRecovery.ts --filter");
  }
}
