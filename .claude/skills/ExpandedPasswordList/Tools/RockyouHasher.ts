#!/usr/bin/env bun
/**
 * RockyouHasher.ts - Generate SHA-1 Binary Index from rockyou.txt
 *
 * Creates a sorted binary file of SHA-1 hashes for efficient lookup.
 * Each hash stored as 20 bytes (raw binary), enabling O(log n) binary search.
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

import { createReadStream, existsSync, writeFileSync, readFileSync, statSync, createWriteStream } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

// =============================================================================
// Configuration
// =============================================================================

const SKILL_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const DATA_DIR = resolve(SKILL_DIR, "data");
const OUTPUT_FILE = resolve(DATA_DIR, "rockyou-sha1.bin");

// Default rockyou.txt location (configurable via args)
const DEFAULT_ROCKYOU = resolve(process.env.HOME || "", "AI-Projects/rockyou.txt");

// =============================================================================
// Hasher Implementation
// =============================================================================

interface HashEntry {
  hash: Buffer;
  line: number;
}

async function hashRockyou(inputPath: string, outputPath: string): Promise<void> {
  if (!existsSync(inputPath)) {
    throw new Error(`Input file not found: ${inputPath}`);
  }

  const stats = statSync(inputPath);
  console.log(`Input: ${inputPath} (${(stats.size / 1024 / 1024).toFixed(1)} MB)`);
  console.log(`Output: ${outputPath}`);
  console.log("");

  // Phase 1: Hash all passwords and collect in memory
  console.log("Phase 1: Hashing passwords...");
  const hashes: Buffer[] = [];
  let lineCount = 0;
  let errorCount = 0;

  const fileStream = createReadStream(inputPath, { encoding: "latin1" });
  const rl = createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  const startTime = Date.now();
  let lastReport = startTime;

  for await (const line of rl) {
    lineCount++;

    // Skip empty lines
    if (line.length === 0) continue;

    try {
      const hash = createHash("sha1").update(line, "latin1").digest();
      hashes.push(hash);
    } catch (e) {
      errorCount++;
      if (errorCount < 10) {
        console.error(`  Warning: Could not hash line ${lineCount}: ${e}`);
      }
    }

    // Progress report every 5 seconds
    const now = Date.now();
    if (now - lastReport > 5000) {
      const elapsed = (now - startTime) / 1000;
      const rate = lineCount / elapsed;
      console.log(`  Processed ${lineCount.toLocaleString()} lines (${rate.toFixed(0)}/sec)`);
      lastReport = now;
    }
  }

  const hashTime = (Date.now() - startTime) / 1000;
  console.log(`  Hashed ${hashes.length.toLocaleString()} passwords in ${hashTime.toFixed(1)}s`);
  if (errorCount > 0) {
    console.log(`  Skipped ${errorCount} lines due to errors`);
  }
  console.log("");

  // Phase 2: Sort hashes (for binary search)
  console.log("Phase 2: Sorting hashes...");
  const sortStart = Date.now();

  hashes.sort(Buffer.compare);

  const sortTime = (Date.now() - sortStart) / 1000;
  console.log(`  Sorted in ${sortTime.toFixed(1)}s`);
  console.log("");

  // Phase 3: Write binary file
  console.log("Phase 3: Writing binary file...");
  const writeStart = Date.now();

  // Calculate total size: 20 bytes per hash
  const totalSize = hashes.length * 20;
  const outputBuffer = Buffer.allocUnsafe(totalSize);

  for (let i = 0; i < hashes.length; i++) {
    hashes[i].copy(outputBuffer, i * 20);
  }

  writeFileSync(outputPath, outputBuffer);

  const writeTime = (Date.now() - writeStart) / 1000;
  const outStats = statSync(outputPath);
  console.log(`  Wrote ${(outStats.size / 1024 / 1024).toFixed(1)} MB in ${writeTime.toFixed(1)}s`);
  console.log("");

  // Summary
  const totalTime = (Date.now() - startTime) / 1000;
  console.log("Summary");
  console.log("=======");
  console.log(`Total hashes: ${hashes.length.toLocaleString()}`);
  console.log(`File size: ${(outStats.size / 1024 / 1024).toFixed(1)} MB`);
  console.log(`Total time: ${totalTime.toFixed(1)}s`);
  console.log("");
  console.log(`Binary search lookups: O(log ${hashes.length.toLocaleString()}) = ~${Math.ceil(Math.log2(hashes.length))} comparisons`);
}

// =============================================================================
// Binary Search Utility
// =============================================================================

/**
 * Check if a SHA-1 hash exists in the binary file
 * @param sha1Hex - 40-character hex string
 * @param binPath - Path to rockyou-sha1.bin
 * @returns true if hash exists in rockyou
 */
export function hashExistsInRockyou(sha1Hex: string, binPath?: string): boolean {
  const path = binPath || OUTPUT_FILE;

  if (!existsSync(path)) {
    throw new Error(`Binary hash file not found: ${path}. Run RockyouHasher.ts first.`);
  }

  // Load file synchronously
  const buffer = Buffer.from(readFileSync(path));
  const hashCount = buffer.length / 20;

  // Convert hex to binary for comparison
  const target = Buffer.from(sha1Hex, "hex");

  // Binary search
  let low = 0;
  let high = hashCount - 1;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const offset = mid * 20;
    const current = buffer.subarray(offset, offset + 20);

    const cmp = Buffer.compare(target, current);

    if (cmp === 0) return true;
    if (cmp < 0) high = mid - 1;
    else low = mid + 1;
  }

  return false;
}

/**
 * Binary search helper that loads file once for multiple lookups
 */
export class RockyouHashIndex {
  private buffer: Buffer;
  private hashCount: number;

  constructor(binPath?: string) {
    const path = binPath || OUTPUT_FILE;

    if (!existsSync(path)) {
      throw new Error(`Binary hash file not found: ${path}. Run RockyouHasher.ts first.`);
    }

    // Use synchronous read for constructor
    this.buffer = Buffer.from(readFileSync(path));
    this.hashCount = this.buffer.length / 20;

    console.log(`Loaded ${this.hashCount.toLocaleString()} hashes from ${path}`);
  }

  /**
   * Check if SHA-1 hash exists (hex string input)
   */
  exists(sha1Hex: string): boolean {
    const target = Buffer.from(sha1Hex, "hex");
    return this.existsBinary(target);
  }

  /**
   * Check if SHA-1 hash exists (binary input)
   */
  existsBinary(target: Buffer): boolean {
    let low = 0;
    let high = this.hashCount - 1;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const offset = mid * 20;
      const current = this.buffer.subarray(offset, offset + 20);

      const cmp = Buffer.compare(target, current);

      if (cmp === 0) return true;
      if (cmp < 0) high = mid - 1;
      else low = mid + 1;
    }

    return false;
  }

  /**
   * Get total number of hashes in index
   */
  get count(): number {
    return this.hashCount;
  }
}

// =============================================================================
// CLI Usage
// =============================================================================

if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args[0] === "--help" || args[0] === "-h") {
    console.log(`
RockyouHasher - Generate SHA-1 binary index from rockyou.txt

Usage:
  bun RockyouHasher.ts [rockyou-path]    Generate binary hash file
  bun RockyouHasher.ts --test <hash>     Test if hash exists
  bun RockyouHasher.ts --stats           Show index statistics

Default rockyou.txt: ${DEFAULT_ROCKYOU}
Output: ${OUTPUT_FILE}
`);
    process.exit(0);
  }

  if (args[0] === "--test") {
    const hash = args[1];
    if (!hash || hash.length !== 40) {
      console.error("Usage: --test <40-char-sha1-hex>");
      process.exit(1);
    }

    try {
      const exists = hashExistsInRockyou(hash);
      console.log(exists ? "FOUND in rockyou" : "NOT FOUND in rockyou");
      process.exit(exists ? 0 : 1);
    } catch (e) {
      console.error((e as Error).message);
      process.exit(1);
    }
  }

  if (args[0] === "--stats") {
    if (!existsSync(OUTPUT_FILE)) {
      console.error("Index not found. Run without arguments to generate.");
      process.exit(1);
    }

    const stats = statSync(OUTPUT_FILE);
    const hashCount = stats.size / 20;

    console.log("Rockyou SHA-1 Index");
    console.log("===================");
    console.log(`File: ${OUTPUT_FILE}`);
    console.log(`Size: ${(stats.size / 1024 / 1024).toFixed(1)} MB`);
    console.log(`Hashes: ${hashCount.toLocaleString()}`);
    console.log(`Lookup complexity: O(log ${hashCount.toLocaleString()}) = ~${Math.ceil(Math.log2(hashCount))} comparisons`);
    process.exit(0);
  }

  // Default: generate hash file
  const inputPath = args[0] || DEFAULT_ROCKYOU;

  try {
    await hashRockyou(inputPath, OUTPUT_FILE);
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
  }
}
