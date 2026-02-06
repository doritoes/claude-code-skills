#!/usr/bin/env bun
/**
 * SandGenerator.ts - Generate SAND batches from GRAVEL and PEARLS
 *
 * SAND = GRAVEL - PEARLS (uncracked hashes after Stage 1)
 *
 * This tool:
 * 1. Loads GRAVEL batch (original candidate hashes)
 * 2. Loads PEARLS (cracked hashes from Stage 1)
 * 3. Filters GRAVEL to remove cracked hashes
 * 4. Writes remaining as SAND batch
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, createReadStream } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { createInterface } from "node:readline";

const CURRENT_FILE = fileURLToPath(import.meta.url);
const SKILL_DIR = dirname(dirname(CURRENT_FILE));
const DATA_DIR = resolve(SKILL_DIR, "data");
const CANDIDATES_DIR = resolve(DATA_DIR, "candidates");
const RESULTS_DIR = resolve(DATA_DIR, "results");
const SAND_DIR = resolve(DATA_DIR, "sand");

// =============================================================================
// PEARLS Loading (cracked hashes)
// =============================================================================

async function loadPearlHashes(): Promise<Set<string>> {
  const crackedFile = resolve(RESULTS_DIR, "cracked.txt");

  if (!existsSync(crackedFile)) {
    throw new Error(`Cracked file not found: ${crackedFile}`);
  }

  console.log("Loading PEARLS (cracked hashes)...");
  const startTime = Date.now();

  const pearls = new Set<string>();

  const fileStream = createReadStream(crackedFile);
  const rl = createInterface({ input: fileStream, crlfDelay: Infinity });

  for await (const line of rl) {
    // Format: hash:plaintext
    const colonIdx = line.indexOf(":");
    if (colonIdx === 40) {  // SHA-1 hash is 40 chars
      const hash = line.substring(0, 40).toLowerCase();
      pearls.add(hash);
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`  Loaded ${pearls.size.toLocaleString()} PEARLS in ${elapsed}s`);

  return pearls;
}

// =============================================================================
// GRAVEL Batch Loading
// =============================================================================

interface GravelBatch {
  batchNum: number;
  path: string;
  hashes: string[];
}

function listGravelBatches(): number[] {
  if (!existsSync(CANDIDATES_DIR)) {
    console.log(`Candidates directory not found: ${CANDIDATES_DIR}`);
    return [];
  }

  const files = readdirSync(CANDIDATES_DIR).filter(
    (f) => f.startsWith("batch-") && (f.endsWith(".txt") || f.endsWith(".txt.gz"))
  );

  const numbers: number[] = [];
  for (const file of files) {
    const match = file.match(/batch-(\d+)\.txt/);
    if (match) {
      numbers.push(parseInt(match[1]));
    }
  }

  return [...new Set(numbers)].sort((a, b) => a - b);
}

function loadGravelBatch(batchNum: number): GravelBatch | null {
  const paddedNum = String(batchNum).padStart(4, "0");
  const batchName = `batch-${paddedNum}`;

  // Try compressed first, then uncompressed
  const gzPath = resolve(CANDIDATES_DIR, `${batchName}.txt.gz`);
  const txtPath = resolve(CANDIDATES_DIR, `${batchName}.txt`);

  let content: string;
  let path: string;

  if (existsSync(gzPath)) {
    const compressed = readFileSync(gzPath);
    content = gunzipSync(compressed).toString("utf-8");
    path = gzPath;
  } else if (existsSync(txtPath)) {
    content = readFileSync(txtPath, "utf-8");
    path = txtPath;
  } else {
    return null;
  }

  // Parse hashes (SHA-1 = 40 chars)
  const hashes = content.trim().split("\n").filter((h) => h.length === 40);

  return { batchNum, path, hashes };
}

// =============================================================================
// SAND Generation
// =============================================================================

async function generateSandBatch(
  batchNum: number,
  pearls: Set<string>,
  options: { dryRun: boolean; compress: boolean }
): Promise<{ sandCount: number; gravelCount: number } | null> {
  const gravel = loadGravelBatch(batchNum);

  if (!gravel) {
    console.log(`  GRAVEL batch ${batchNum} not found`);
    return null;
  }

  console.log(`  GRAVEL batch ${batchNum}: ${gravel.hashes.length.toLocaleString()} hashes`);

  // Filter out cracked hashes
  const sand = gravel.hashes.filter((h) => !pearls.has(h.toLowerCase()));
  const crackedCount = gravel.hashes.length - sand.length;
  const crackRate = ((crackedCount / gravel.hashes.length) * 100).toFixed(1);

  console.log(`    Cracked: ${crackedCount.toLocaleString()} (${crackRate}%)`);
  console.log(`    SAND: ${sand.length.toLocaleString()} uncracked hashes`);

  if (options.dryRun) {
    console.log(`    [DRY RUN] Would write to sand/batch-${String(batchNum).padStart(4, "0")}.txt.gz`);
    return { sandCount: sand.length, gravelCount: gravel.hashes.length };
  }

  // Ensure sand directory exists
  if (!existsSync(SAND_DIR)) {
    mkdirSync(SAND_DIR, { recursive: true });
  }

  // Write SAND batch
  const paddedNum = String(batchNum).padStart(4, "0");
  const outputPath = resolve(SAND_DIR, options.compress ? `batch-${paddedNum}.txt.gz` : `batch-${paddedNum}.txt`);

  const content = sand.join("\n");
  if (options.compress) {
    const compressed = gzipSync(content);
    writeFileSync(outputPath, compressed);
    console.log(`    ✓ Wrote ${sand.length.toLocaleString()} hashes to ${basename(outputPath)} (${Math.round(compressed.length / 1024)}KB)`);
  } else {
    writeFileSync(outputPath, content);
    console.log(`    ✓ Wrote ${sand.length.toLocaleString()} hashes to ${basename(outputPath)}`);
  }

  return { sandCount: sand.length, gravelCount: gravel.hashes.length };
}

// =============================================================================
// CLI
// =============================================================================

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
SandGenerator - Generate SAND batches from GRAVEL and PEARLS

SAND = GRAVEL - PEARLS (hashes that survived Stage 1 cracking)

Usage:
  bun SandGenerator.ts --list                  List available GRAVEL batches
  bun SandGenerator.ts --batch <n>             Generate SAND for specific batch
  bun SandGenerator.ts --range <start>-<end>   Generate SAND for batch range
  bun SandGenerator.ts --all                   Generate SAND for all batches
  bun SandGenerator.ts --dry-run               Preview without writing files
  bun SandGenerator.ts --no-compress           Don't gzip output (default: compress)

Examples:
  bun SandGenerator.ts --list                  # See available GRAVEL batches
  bun SandGenerator.ts --batch 1 --dry-run     # Preview SAND for batch 1
  bun SandGenerator.ts --batch 1               # Generate SAND for batch 1
  bun SandGenerator.ts --range 1-10            # Generate SAND for batches 1-10
  bun SandGenerator.ts --all                   # Generate SAND for all batches

Data locations:
  GRAVEL: ${CANDIDATES_DIR}
  PEARLS: ${RESULTS_DIR}/cracked.txt
  SAND:   ${SAND_DIR}
`);
    process.exit(0);
  }

  console.log("╭─────────────────────────────────────────────────────────────╮");
  console.log("│              SAND GENERATOR                                 │");
  console.log("│         SAND = GRAVEL - PEARLS                              │");
  console.log("╰─────────────────────────────────────────────────────────────╯");
  console.log("");

  const dryRun = args.includes("--dry-run");
  const compress = !args.includes("--no-compress");

  if (args.includes("--list")) {
    const batches = listGravelBatches();
    console.log(`Available GRAVEL batches: ${batches.length}`);
    if (batches.length > 0) {
      console.log(`  Range: ${batches[0]} to ${batches[batches.length - 1]}`);
      console.log(`  Batches: ${batches.slice(0, 20).join(", ")}${batches.length > 20 ? "..." : ""}`);
    }
    return;
  }

  // Load PEARLS once for all batch processing
  const pearls = await loadPearlHashes();
  console.log("");

  const batchArg = args.find((a) => a.startsWith("--batch="));
  const rangeArg = args.find((a) => a.startsWith("--range="));
  const all = args.includes("--all");

  let batchNums: number[] = [];

  if (batchArg) {
    batchNums = [parseInt(batchArg.split("=")[1])];
  } else if (rangeArg) {
    const [start, end] = rangeArg.split("=")[1].split("-").map(Number);
    for (let i = start; i <= end; i++) {
      batchNums.push(i);
    }
  } else if (all) {
    batchNums = listGravelBatches();
  } else {
    console.log("Specify --batch=<n>, --range=<start>-<end>, or --all");
    console.log("Use --help for more options.");
    return;
  }

  console.log(`Processing ${batchNums.length} batch(es)...`);
  console.log("");

  let totalGravel = 0;
  let totalSand = 0;
  let batchesProcessed = 0;

  for (const batchNum of batchNums) {
    const result = await generateSandBatch(batchNum, pearls, { dryRun, compress });
    if (result) {
      totalGravel += result.gravelCount;
      totalSand += result.sandCount;
      batchesProcessed++;
    }
  }

  console.log("");
  console.log("─".repeat(60));
  console.log(`Summary:`);
  console.log(`  Batches processed: ${batchesProcessed}`);
  console.log(`  Total GRAVEL: ${totalGravel.toLocaleString()}`);
  console.log(`  Total SAND: ${totalSand.toLocaleString()}`);
  console.log(`  Cracked (PEARLS): ${(totalGravel - totalSand).toLocaleString()} (${((totalGravel - totalSand) / totalGravel * 100).toFixed(1)}%)`);

  if (dryRun) {
    console.log("\n(Dry run - no files written)");
  }
}

main().catch(console.error);
