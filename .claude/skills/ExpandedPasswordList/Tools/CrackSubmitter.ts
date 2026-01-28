#!/usr/bin/env bun
/**
 * CrackSubmitter.ts - Submit Candidates to Hashcrack
 *
 * Submits filtered SHA-1 hashes to Hashtopolis for cracking.
 * Uses parallel hash splitting strategy for rule attacks.
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { StateManager } from "./StateManager";

// Import Hashcrack client (relative path from skill to skill)
const CURRENT_FILE = fileURLToPath(import.meta.url);
const HASHCRACK_DIR = resolve(dirname(dirname(CURRENT_FILE)), "..", "Hashcrack", "tools");

// =============================================================================
// Configuration
// =============================================================================

const SKILL_DIR = dirname(dirname(CURRENT_FILE));
const DATA_DIR = resolve(SKILL_DIR, "data");
const CANDIDATES_DIR = resolve(DATA_DIR, "candidates");

// Cracking settings
const HASH_TYPE_SHA1 = 100;
const DEFAULT_ATTACK_CMD = "#HL# -r OneRuleToRuleThemAll.rule rockyou.txt";
const MAX_HASHES_PER_TASK = 1_000_000; // 1M hashes per hashlist

// =============================================================================
// Hashcrack Client Import
// =============================================================================

// Dynamic import to handle potential path issues
async function getHashtopolisClient() {
  try {
    const clientPath = resolve(HASHCRACK_DIR, "HashtopolisClient.ts");
    if (!existsSync(clientPath)) {
      throw new Error(`HashtopolisClient not found at ${clientPath}`);
    }
    const { HashtopolisClient, HASH_TYPES } = await import(clientPath);
    return { HashtopolisClient, HASH_TYPES };
  } catch (e) {
    console.error("Failed to import HashtopolisClient:", e);
    throw new Error("Hashcrack skill not properly installed. Ensure HashtopolisClient.ts exists.");
  }
}

// =============================================================================
// Submitter Implementation
// =============================================================================

interface BatchFile {
  name: string;
  path: string;
  hashes: string[];
}

/**
 * Load candidate batch files (supports both .txt and .txt.gz)
 */
async function loadBatches(batchNumber?: number): Promise<BatchFile[]> {
  if (!existsSync(CANDIDATES_DIR)) {
    throw new Error(`Candidates directory not found: ${CANDIDATES_DIR}`);
  }

  const files = readdirSync(CANDIDATES_DIR)
    .filter((f) => f.startsWith("batch-") && (f.endsWith(".txt") || f.endsWith(".txt.gz")))
    .sort();

  if (files.length === 0) {
    throw new Error("No candidate batch files found. Run Filter workflow first.");
  }

  const batches: BatchFile[] = [];

  for (const file of files) {
    // Extract batch number from filename (batch-001.txt or batch-001.txt.gz -> 1)
    const match = file.match(/batch-(\d+)\.txt(\.gz)?/);
    if (!match) continue;

    const num = parseInt(match[1]);
    const isCompressed = match[2] === ".gz";

    // Skip if specific batch requested and this isn't it
    if (batchNumber !== undefined && num !== batchNumber) continue;

    const path = resolve(CANDIDATES_DIR, file);
    let content: string;

    if (isCompressed) {
      const compressed = readFileSync(path);
      content = gunzipSync(compressed).toString("utf-8");
    } else {
      content = await Bun.file(path).text();
    }

    const hashes = content.trim().split("\n").filter((h) => h.length === 40);

    // Normalize name (remove .gz extension)
    const name = file.replace(".txt.gz", "").replace(".txt", "");

    batches.push({
      name,
      path,
      hashes,
    });
  }

  return batches;
}

/**
 * Submit batches to Hashcrack
 */
async function submitBatches(options: {
  batchNumber?: number;
  all?: boolean;
  dryRun?: boolean;
  workers?: number;
} = {}): Promise<void> {
  const { dryRun = false, workers = 1 } = options;

  const state = new StateManager(DATA_DIR);
  const pipelineState = state.load();

  // Check filter stage
  if (pipelineState.filter.status !== "completed" && !options.batchNumber) {
    console.warn("Warning: Filter stage not complete");
  }

  // Load batches
  const batches = await loadBatches(options.batchNumber);

  if (batches.length === 0) {
    console.error("No batches to submit");
    process.exit(1);
  }

  // Calculate totals
  const totalHashes = batches.reduce((sum, b) => sum + b.hashes.length, 0);

  console.log("CrackSubmitter");
  console.log("==============");
  console.log(`Batches to submit: ${batches.length}`);
  console.log(`Total hashes: ${totalHashes.toLocaleString()}`);
  console.log(`Workers: ${workers}`);
  console.log(`Dry run: ${dryRun}`);
  console.log("");

  if (dryRun) {
    console.log("DRY RUN - No submissions made");
    for (const batch of batches) {
      console.log(`  ${batch.name}: ${batch.hashes.length.toLocaleString()} hashes`);
    }
    return;
  }

  // Initialize Hashcrack client
  const { HashtopolisClient, HASH_TYPES } = await getHashtopolisClient();
  const client = HashtopolisClient.fromEnv();

  // Test connection
  console.log("Testing Hashcrack connection...");
  const connected = await client.testConnection();
  if (!connected) {
    console.error("Failed to connect to Hashtopolis server");
    process.exit(1);
  }
  console.log("Connected successfully");
  console.log("");

  state.startCrack();

  for (const batch of batches) {
    console.log(`Submitting ${batch.name}...`);

    try {
      // For parallel rule attacks with multiple workers, split hashes
      if (workers > 1 && batch.hashes.length > workers) {
        // Split into sub-batches for parallel workers
        const chunkSize = Math.ceil(batch.hashes.length / workers);

        for (let i = 0; i < workers; i++) {
          const start = i * chunkSize;
          const end = Math.min(start + chunkSize, batch.hashes.length);
          const subHashes = batch.hashes.slice(start, end);

          if (subHashes.length === 0) continue;

          const hashlistName = `HIBP-${batch.name}-part${i + 1}`;

          const hashlistId = await client.createHashlist({
            name: hashlistName,
            hashTypeId: HASH_TYPE_SHA1,
            hashes: subHashes,
          });

          console.log(`  Created hashlist ${hashlistId}: ${hashlistName} (${subHashes.length} hashes)`);

          // Create task with maxAgents=1 for parallel rule attack
          const taskId = await client.createTask({
            name: `Crack-${hashlistName}`,
            hashlistId,
            attackCmd: DEFAULT_ATTACK_CMD,
            maxAgents: 1, // Force one agent per task for parallelization
            priority: 10,
          });

          console.log(`  Created task ${taskId}`);

          state.addHashlist(hashlistId, taskId, subHashes.length);
        }
      } else {
        // Single hashlist for this batch
        const hashlistName = `HIBP-${batch.name}`;

        const hashlistId = await client.createHashlist({
          name: hashlistName,
          hashTypeId: HASH_TYPE_SHA1,
          hashes: batch.hashes,
        });

        console.log(`  Created hashlist ${hashlistId}: ${hashlistName}`);

        const taskId = await client.createTask({
          name: `Crack-${hashlistName}`,
          hashlistId,
          attackCmd: DEFAULT_ATTACK_CMD,
          maxAgents: workers > 1 ? 1 : 0, // Unlimited if single worker mode
          priority: 10,
        });

        console.log(`  Created task ${taskId}`);

        state.addHashlist(hashlistId, taskId, batch.hashes.length);
      }

      console.log("");
    } catch (e) {
      console.error(`  Error submitting ${batch.name}: ${e}`);
      state.failCrack((e as Error).message);
      throw e;
    }
  }

  state.flush();

  console.log("Submission Complete");
  console.log("===================");
  console.log(`Hashlists created: ${pipelineState.crack.hashlistIds.length}`);
  console.log(`Tasks created: ${pipelineState.crack.taskIds.length}`);
  console.log("");
  console.log("Monitor progress with: bun Tools/ProgressTracker.ts");
  console.log("Or check Hashtopolis web UI");
}

// =============================================================================
// CLI Usage
// =============================================================================

if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args[0] === "--help" || args[0] === "-h") {
    console.log(`
CrackSubmitter - Submit candidates to Hashcrack

Usage:
  bun CrackSubmitter.ts --all              Submit all candidate batches
  bun CrackSubmitter.ts --batch <n>        Submit specific batch number
  bun CrackSubmitter.ts --dry-run          Show what would be submitted
  bun CrackSubmitter.ts --workers <n>      Split across N parallel workers

Options:
  --all             Submit all available batches
  --batch <n>       Submit only batch number N
  --dry-run         Preview without submitting
  --workers <n>     Number of parallel workers (splits hashes)

Input: ${CANDIDATES_DIR}/
`);
    process.exit(0);
  }

  // Parse arguments
  let batchNumber: number | undefined;
  let all = false;
  let dryRun = false;
  let workers = 1;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--batch":
        batchNumber = parseInt(args[++i]);
        break;
      case "--all":
        all = true;
        break;
      case "--dry-run":
        dryRun = true;
        break;
      case "--workers":
        workers = parseInt(args[++i]) || 1;
        break;
    }
  }

  if (!all && batchNumber === undefined) {
    console.error("Specify --all or --batch <n>");
    process.exit(1);
  }

  try {
    await submitBatches({ batchNumber, all, dryRun, workers });
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
  }
}
