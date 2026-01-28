#!/usr/bin/env bun
/**
 * HibpBatchManager.ts - Batched HIBP Storage Manager
 *
 * Stores HIBP prefix data in batched archives instead of 1M individual files.
 * Groups prefixes by first 2 hex chars (256 batches of ~4K prefixes each).
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync, gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";

// =============================================================================
// Configuration
// =============================================================================

const SKILL_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const DATA_DIR = resolve(SKILL_DIR, "data");
const HIBP_BATCH_DIR = resolve(DATA_DIR, "hibp-batched");

// 256 batches (00-FF), each containing ~4096 prefixes
const BATCH_COUNT = 256;
const PREFIXES_PER_BATCH = 4096; // 16^3

// Memory management: max batches to keep in cache before evicting oldest
// Each batch can be ~4MB uncompressed, so 16 batches ≈ 64MB cache
const MAX_CACHED_BATCHES = 16;

// =============================================================================
// Types
// =============================================================================

export interface HibpEntry {
  prefix: string;
  data: string;  // Raw HIBP response (SUFFIX:COUNT lines)
  etag?: string;
  fetchedAt: string;
}

/**
 * Parsed hash entry with occurrence count
 */
export interface HibpHashEntry {
  hash: string;      // Full 40-char SHA-1 hash
  count: number;     // Occurrence count from HIBP
}

/**
 * Parse HIBP data into hash entries with counts
 */
export function parseHibpData(prefix: string, data: string): HibpHashEntry[] {
  const entries: HibpHashEntry[] = [];
  const lines = data.trim().split("\n").filter((l) => l.length > 0);

  for (const line of lines) {
    const [suffix, countStr] = line.split(":");
    if (!suffix || suffix.length !== 35) continue;

    const hash = (prefix + suffix).toUpperCase();
    const count = parseInt(countStr) || 1;

    entries.push({ hash, count });
  }

  return entries;
}

export interface HibpBatch {
  batchId: string;  // "00" - "FF"
  entries: Record<string, HibpEntry>;  // prefix -> entry
  checksum?: string;
  lastUpdated: string;
}

// =============================================================================
// Batch Manager
// =============================================================================

export class HibpBatchManager {
  private batchDir: string;
  private batchCache: Map<string, HibpBatch> = new Map();

  constructor(dataDir?: string) {
    this.batchDir = dataDir ? resolve(dataDir, "hibp-batched") : HIBP_BATCH_DIR;

    if (!existsSync(this.batchDir)) {
      mkdirSync(this.batchDir, { recursive: true });
    }
  }

  /**
   * Get batch ID for a prefix (first 2 chars)
   */
  getBatchId(prefix: string): string {
    return prefix.substring(0, 2).toUpperCase();
  }

  /**
   * Get batch file path
   */
  getBatchPath(batchId: string): string {
    return resolve(this.batchDir, `hibp-${batchId}.json.gz`);
  }

  /**
   * Load a batch from disk (with caching and automatic eviction)
   */
  loadBatch(batchId: string): HibpBatch {
    // Check cache first
    if (this.batchCache.has(batchId)) {
      return this.batchCache.get(batchId)!;
    }

    // Evict oldest batches if cache is full to prevent memory leak
    this.evictIfNeeded();

    const batchPath = this.getBatchPath(batchId);

    if (existsSync(batchPath)) {
      try {
        const compressed = readFileSync(batchPath);
        const json = gunzipSync(compressed).toString("utf-8");
        const batch = JSON.parse(json) as HibpBatch;
        this.batchCache.set(batchId, batch);
        return batch;
      } catch (e) {
        console.warn(`Warning: Could not load batch ${batchId}: ${e}`);
      }
    }

    // Create new empty batch
    const batch: HibpBatch = {
      batchId,
      entries: {},
      lastUpdated: new Date().toISOString(),
    };
    this.batchCache.set(batchId, batch);
    return batch;
  }

  /**
   * Evict oldest batches if cache exceeds limit
   * Saves evicted batches to disk first to prevent data loss
   */
  private evictIfNeeded(): void {
    while (this.batchCache.size >= MAX_CACHED_BATCHES) {
      // Get first (oldest) batch in cache
      const oldestBatchId = this.batchCache.keys().next().value;
      if (oldestBatchId) {
        this.flushBatch(oldestBatchId);
      } else {
        break;
      }
    }
  }

  /**
   * Save a batch to disk
   */
  saveBatch(batchId: string): string {
    const batch = this.batchCache.get(batchId);
    if (!batch) {
      throw new Error(`Batch ${batchId} not in cache`);
    }

    batch.lastUpdated = new Date().toISOString();

    const json = JSON.stringify(batch);
    const compressed = gzipSync(json);

    // Compute checksum
    const checksum = createHash("sha256").update(compressed).digest("hex");
    batch.checksum = checksum;

    const batchPath = this.getBatchPath(batchId);
    writeFileSync(batchPath, compressed);

    return checksum;
  }

  /**
   * Store a prefix entry
   */
  storePrefix(prefix: string, data: string, etag?: string): void {
    const batchId = this.getBatchId(prefix);
    const batch = this.loadBatch(batchId);

    batch.entries[prefix] = {
      prefix,
      data,
      etag,
      fetchedAt: new Date().toISOString(),
    };
  }

  /**
   * Get a prefix entry
   */
  getPrefix(prefix: string): HibpEntry | null {
    const batchId = this.getBatchId(prefix);
    const batch = this.loadBatch(batchId);
    return batch.entries[prefix] || null;
  }

  /**
   * Check if prefix exists
   */
  hasPrefix(prefix: string): boolean {
    const batchId = this.getBatchId(prefix);
    const batch = this.loadBatch(batchId);
    return prefix in batch.entries;
  }

  /**
   * Get ETag for a prefix (for incremental updates)
   */
  getEtag(prefix: string): string | null {
    const entry = this.getPrefix(prefix);
    return entry?.etag || null;
  }

  /**
   * Flush all dirty batches to disk
   */
  flushAll(): Map<string, string> {
    const checksums = new Map<string, string>();

    for (const batchId of this.batchCache.keys()) {
      const checksum = this.saveBatch(batchId);
      checksums.set(batchId, checksum);
    }

    return checksums;
  }

  /**
   * Flush a specific batch and remove from cache
   */
  flushBatch(batchId: string): string | null {
    if (!this.batchCache.has(batchId)) {
      return null;
    }

    const checksum = this.saveBatch(batchId);
    this.batchCache.delete(batchId);
    return checksum;
  }

  /**
   * Get count of prefixes in a batch
   */
  getBatchPrefixCount(batchId: string): number {
    const batch = this.loadBatch(batchId);
    return Object.keys(batch.entries).length;
  }

  /**
   * Get total prefix count across all batches
   */
  getTotalPrefixCount(): number {
    let total = 0;

    for (let i = 0; i < BATCH_COUNT; i++) {
      const batchId = i.toString(16).toUpperCase().padStart(2, "0");
      const batchPath = this.getBatchPath(batchId);

      if (existsSync(batchPath)) {
        const batch = this.loadBatch(batchId);
        total += Object.keys(batch.entries).length;
        // Unload from cache to save memory
        this.batchCache.delete(batchId);
      }
    }

    return total;
  }

  /**
   * Iterate over all prefixes (generator)
   */
  *iteratePrefixes(): Generator<HibpEntry> {
    for (let i = 0; i < BATCH_COUNT; i++) {
      const batchId = i.toString(16).toUpperCase().padStart(2, "0");
      const batchPath = this.getBatchPath(batchId);

      if (existsSync(batchPath)) {
        const batch = this.loadBatch(batchId);

        for (const entry of Object.values(batch.entries)) {
          yield entry;
        }

        // Unload from cache to save memory during iteration
        this.batchCache.delete(batchId);
      }
    }
  }

  /**
   * Verify batch checksum
   */
  verifyBatch(batchId: string, expectedChecksum: string): boolean {
    const batchPath = this.getBatchPath(batchId);

    if (!existsSync(batchPath)) {
      return false;
    }

    const compressed = readFileSync(batchPath);
    const actualChecksum = createHash("sha256").update(compressed).digest("hex");

    return actualChecksum === expectedChecksum;
  }

  /**
   * Get batch directory path
   */
  getBatchDir(): string {
    return this.batchDir;
  }
}

// =============================================================================
// CLI Usage
// =============================================================================

if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args[0] === "--help" || args[0] === "-h") {
    console.log(`
HibpBatchManager - Batched HIBP Storage

Usage:
  bun HibpBatchManager.ts stats          Show storage statistics
  bun HibpBatchManager.ts verify         Verify all batch checksums
  bun HibpBatchManager.ts get <prefix>   Get data for a prefix

Batch directory: ${HIBP_BATCH_DIR}
`);
    process.exit(0);
  }

  const manager = new HibpBatchManager();

  if (args[0] === "stats") {
    console.log("HIBP Batched Storage Statistics");
    console.log("================================");

    let totalPrefixes = 0;
    let totalBatches = 0;
    let totalSize = 0;

    for (let i = 0; i < BATCH_COUNT; i++) {
      const batchId = i.toString(16).toUpperCase().padStart(2, "0");
      const batchPath = manager.getBatchPath(batchId);

      if (existsSync(batchPath)) {
        totalBatches++;
        const stats = require("fs").statSync(batchPath);
        totalSize += stats.size;

        const batch = manager.loadBatch(batchId);
        totalPrefixes += Object.keys(batch.entries).length;
        manager.flushBatch(batchId); // Unload from cache
      }
    }

    console.log(`Batches: ${totalBatches} / ${BATCH_COUNT}`);
    console.log(`Prefixes: ${totalPrefixes.toLocaleString()}`);
    console.log(`Total size: ${(totalSize / 1024 / 1024).toFixed(2)} MB`);
  } else if (args[0] === "get" && args[1]) {
    const prefix = args[1].toUpperCase();
    const entry = manager.getPrefix(prefix);

    if (entry) {
      console.log(`Prefix: ${entry.prefix}`);
      console.log(`ETag: ${entry.etag || "none"}`);
      console.log(`Fetched: ${entry.fetchedAt}`);
      console.log(`Data lines: ${entry.data.split("\n").length}`);
    } else {
      console.log(`Prefix ${prefix} not found`);
    }
  } else {
    console.log("Use --help for usage information");
  }
}
