#!/usr/bin/env bun
/**
 * HibpStreamReader.ts - Memory-efficient HIBP batch reader
 *
 * Streams HIBP batch files prefix-by-prefix without loading entire JSON into memory.
 * Uses chunked parsing to extract prefixes from compressed JSON.
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const SKILL_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const DATA_DIR = resolve(SKILL_DIR, "data");
const HIBP_BATCH_DIR = resolve(DATA_DIR, "hibp-batched");

export interface HibpPrefixData {
  prefix: string;
  data: string; // Raw HIBP response (SUFFIX:COUNT lines)
}

/**
 * Stream prefixes from a single HIBP batch file using chunked regex parsing
 * Memory efficient: extracts one prefix at a time from decompressed buffer
 *
 * Note: Still needs to decompress full file (~350MB) but doesn't create
 * a full JavaScript object graph from JSON.parse() (~800MB+)
 */
export function* streamBatchPrefixes(
  batchId: string,
  batchDir: string = HIBP_BATCH_DIR
): Generator<HibpPrefixData> {
  const batchPath = resolve(batchDir, `hibp-${batchId}.json.gz`);

  if (!existsSync(batchPath)) {
    return;
  }

  // Decompress to buffer (still ~350MB but avoids JSON.parse overhead)
  let compressed: Buffer | null = readFileSync(batchPath);
  let decompressed: Buffer | null = gunzipSync(compressed);
  const content = decompressed.toString("utf-8");

  // Free buffers to help GC
  compressed = null;
  decompressed = null;

  // Pattern to match each prefix entry
  // Format: "00001":{"prefix":"00001","data":"...\r\n...\r\n...","etag":"...","fetchedAt":"..."}
  const prefixPattern = /"([0-9A-F]{5})"\s*:\s*\{\s*"prefix"\s*:\s*"[^"]+"\s*,\s*"data"\s*:\s*"([^"]*)"/gi;

  let match;
  while ((match = prefixPattern.exec(content)) !== null) {
    const prefix = match[1].toUpperCase();
    // Unescape the data string (handles \r\n and other escapes)
    const data = unescapeJsonString(match[2]);

    yield { prefix, data };
  }
}

/**
 * Alternative: Load batch with JSON.parse but only keep entries
 * This is faster but uses more memory (~800MB per batch)
 */
export function loadBatchEntries(
  batchId: string,
  batchDir: string = HIBP_BATCH_DIR
): Map<string, string> {
  const batchPath = resolve(batchDir, `hibp-${batchId}.json.gz`);
  const entries = new Map<string, string>();

  if (!existsSync(batchPath)) {
    return entries;
  }

  const compressed = readFileSync(batchPath);
  const decompressed = gunzipSync(compressed);
  const batch = JSON.parse(decompressed.toString("utf-8"));

  for (const [prefix, entry] of Object.entries(batch.entries)) {
    entries.set(prefix, (entry as { data: string }).data);
  }

  return entries;
}

/**
 * Unescape JSON string (handle \r\n, \\, etc.)
 */
function unescapeJsonString(s: string): string {
  return s
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\\\/g, "\\")
    .replace(/\\"/g, '"');
}

/**
 * Stream all prefixes from all HIBP batches
 */
export function* streamAllPrefixes(
  batchDir: string = HIBP_BATCH_DIR
): Generator<HibpPrefixData> {
  for (let i = 0; i < 256; i++) {
    const batchId = i.toString(16).toUpperCase().padStart(2, "0");
    yield* streamBatchPrefixes(batchId, batchDir);
  }
}

// =============================================================================
// CLI for testing
// =============================================================================

if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args[0] === "--help" || args[0] === "-h") {
    console.log(`
HibpStreamReader - Memory-efficient HIBP batch reader

Usage:
  bun HibpStreamReader.ts test <batchId>     Test streaming from a batch
  bun HibpStreamReader.ts count <batchId>    Count prefixes in a batch
  bun HibpStreamReader.ts sample <batchId>   Show first 3 prefixes

Options:
  --batch-dir <path>    Override batch directory
`);
    process.exit(0);
  }

  const command = args[0];
  const batchId = args[1]?.toUpperCase().padStart(2, "0") || "00";

  if (command === "test" || command === "count") {
    let count = 0;
    let totalHashes = 0;
    const startTime = Date.now();

    for (const prefix of streamBatchPrefixes(batchId)) {
      count++;
      const lines = prefix.data.split("\n").filter((l) => l.length > 0);
      totalHashes += lines.length;

      if (count % 1000 === 0) {
        console.log(`  Processed ${count} prefixes, ${totalHashes.toLocaleString()} hashes...`);
      }
    }

    const elapsed = (Date.now() - startTime) / 1000;
    console.log(`\nBatch ${batchId}:`);
    console.log(`  Prefixes: ${count}`);
    console.log(`  Hashes: ${totalHashes.toLocaleString()}`);
    console.log(`  Time: ${elapsed.toFixed(2)}s`);
  } else if (command === "sample") {
    let count = 0;
    for (const prefix of streamBatchPrefixes(batchId)) {
      console.log(`\nPrefix: ${prefix.prefix}`);
      const lines = prefix.data.split("\n").slice(0, 5);
      console.log(`  First 5 lines:`);
      for (const line of lines) {
        console.log(`    ${line}`);
      }
      count++;
      if (count >= 3) break;
    }
  }
}
