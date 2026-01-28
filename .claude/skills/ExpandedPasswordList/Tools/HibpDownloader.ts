#!/usr/bin/env bun
/**
 * HibpDownloader.ts - HIBP Pwned Passwords Downloader
 *
 * Downloads HIBP Pwned Passwords dataset by 5-character prefix ranges.
 * Supports resume, parallel downloads, and progress tracking.
 *
 * API: https://api.pwnedpasswords.com/range/{prefix}
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

import { existsSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { StateManager } from "./StateManager";
import { HibpBatchManager } from "./HibpBatchManager";

// =============================================================================
// Configuration
// =============================================================================

const SKILL_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const DATA_DIR = resolve(SKILL_DIR, "data");
const HIBP_DIR = resolve(DATA_DIR, "hibp");
const HIBP_BATCH_DIR = resolve(DATA_DIR, "hibp-batched");

const HIBP_API = "https://api.pwnedpasswords.com/range";
const MAX_PREFIX = 0xfffff; // 16^5 - 1 = 1,048,575
const TOTAL_PREFIXES = MAX_PREFIX + 1; // 1,048,576

// Rate limiting - HIBP recommends ~1500 req/min
const DEFAULT_PARALLEL = 10;
const RETRY_DELAYS = [1000, 2000, 5000, 10000]; // Exponential backoff
const MIN_REQUEST_INTERVAL_MS = 40; // ~25 req/sec = 1500/min per worker

// =============================================================================
// Downloader Implementation
// =============================================================================

interface DownloadResult {
  prefix: string;
  hashCount: number;
  bytes: number;
  retries: number;
  etag?: string;
  unchanged?: boolean;  // True if ETag matched (304 Not Modified)
}

/**
 * Download a single prefix from HIBP API
 */
async function downloadPrefix(prefix: string, retryCount = 0): Promise<DownloadResult> {
  const url = `${HIBP_API}/${prefix}`;

  try {
    const response = await fetch(url, {
      headers: {
        "Add-Padding": "true", // k-anonymity padding
        "User-Agent": "PAI-ExpandedPasswordList/1.0",
      },
    });

    if (!response.ok) {
      if (response.status === 429) {
        // Rate limited - wait and retry
        const delay = RETRY_DELAYS[Math.min(retryCount, RETRY_DELAYS.length - 1)];
        await Bun.sleep(delay);
        return downloadPrefix(prefix, retryCount + 1);
      }
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const text = await response.text();
    const lines = text.trim().split("\n").filter((l) => l.length > 0);

    return {
      prefix,
      hashCount: lines.length,
      bytes: text.length,
      retries: retryCount,
    };
  } catch (e) {
    if (retryCount < RETRY_DELAYS.length) {
      const delay = RETRY_DELAYS[retryCount];
      await Bun.sleep(delay);
      return downloadPrefix(prefix, retryCount + 1);
    }
    throw e;
  }
}

/**
 * Download and save a prefix to disk
 */
async function downloadAndSave(prefix: string): Promise<DownloadResult> {
  const outPath = resolve(HIBP_DIR, `${prefix}.txt`);

  // Check if already downloaded
  if (existsSync(outPath)) {
    const content = await Bun.file(outPath).text();
    const lines = content.trim().split("\n").filter((l) => l.length > 0);
    return { prefix, hashCount: lines.length, bytes: content.length, retries: 0 };
  }

  const url = `${HIBP_API}/${prefix}`;

  const response = await fetch(url, {
    headers: {
      "Add-Padding": "true",
      "User-Agent": "PAI-ExpandedPasswordList/1.0",
    },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const text = await response.text();
  writeFileSync(outPath, text);

  const lines = text.trim().split("\n").filter((l) => l.length > 0);

  return {
    prefix,
    hashCount: lines.length,
    bytes: text.length,
    retries: 0,
  };
}

/**
 * Download with ETag support for incremental updates
 * Returns unchanged=true if content hasn't changed since lastEtag
 */
async function downloadWithEtag(
  prefix: string,
  lastEtag?: string,
  retryCount = 0
): Promise<DownloadResult & { data: string }> {
  const url = `${HIBP_API}/${prefix}`;

  try {
    const headers: Record<string, string> = {
      "Add-Padding": "true",
      "User-Agent": "PAI-ExpandedPasswordList/1.0",
    };

    // Include If-None-Match for conditional request
    if (lastEtag) {
      headers["If-None-Match"] = lastEtag;
    }

    const response = await fetch(url, { headers });

    // Handle 304 Not Modified
    if (response.status === 304) {
      return {
        prefix,
        hashCount: 0,
        bytes: 0,
        retries: retryCount,
        etag: lastEtag,
        unchanged: true,
        data: "",
      };
    }

    if (!response.ok) {
      if (response.status === 429) {
        const delay = RETRY_DELAYS[Math.min(retryCount, RETRY_DELAYS.length - 1)];
        await Bun.sleep(delay);
        return downloadWithEtag(prefix, lastEtag, retryCount + 1);
      }
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const text = await response.text();
    const etag = response.headers.get("ETag") || undefined;
    const lines = text.trim().split("\n").filter((l) => l.length > 0);

    return {
      prefix,
      hashCount: lines.length,
      bytes: text.length,
      retries: retryCount,
      etag,
      unchanged: false,
      data: text,
    };
  } catch (e) {
    if (retryCount < RETRY_DELAYS.length) {
      const delay = RETRY_DELAYS[retryCount];
      await Bun.sleep(delay);
      return downloadWithEtag(prefix, lastEtag, retryCount + 1);
    }
    throw e;
  }
}

/**
 * Download to batched storage with ETag tracking
 */
async function downloadToBatched(
  prefix: string,
  batchManager: HibpBatchManager
): Promise<DownloadResult> {
  // Check for existing ETag
  const existingEtag = batchManager.getEtag(prefix);

  const result = await downloadWithEtag(prefix, existingEtag || undefined);

  if (result.unchanged) {
    // Content unchanged, skip storing
    return {
      prefix: result.prefix,
      hashCount: result.hashCount,
      bytes: result.bytes,
      retries: result.retries,
      etag: result.etag,
      unchanged: true,
    };
  }

  // Store in batch
  batchManager.storePrefix(prefix, result.data, result.etag);

  return {
    prefix: result.prefix,
    hashCount: result.hashCount,
    bytes: result.bytes,
    retries: result.retries,
    etag: result.etag,
    unchanged: false,
  };
}

/**
 * Generate all 5-character hex prefixes
 */
function* generatePrefixes(start = 0, end = MAX_PREFIX): Generator<string> {
  for (let i = start; i <= end; i++) {
    yield i.toString(16).toUpperCase().padStart(5, "0");
  }
}

/**
 * Parse prefix string to number
 */
function parsePrefix(prefix: string): number {
  return parseInt(prefix, 16);
}

/**
 * Download all prefixes with parallel execution
 */
async function downloadAll(
  options: {
    parallel?: number;
    startPrefix?: string;
    endPrefix?: string;
    resume?: boolean;
  } = {}
): Promise<void> {
  const { parallel = DEFAULT_PARALLEL, resume = true } = options;

  // Ensure directories exist
  if (!existsSync(HIBP_DIR)) {
    mkdirSync(HIBP_DIR, { recursive: true });
  }

  const state = new StateManager(DATA_DIR);

  // Determine range
  const start = options.startPrefix ? parsePrefix(options.startPrefix) : 0;
  const end = options.endPrefix ? parsePrefix(options.endPrefix) : MAX_PREFIX;

  // Get already completed prefixes
  const completed = new Set(
    resume ? state.load().download.completedPrefixes : []
  );

  // Generate work queue
  const pending: string[] = [];
  for (const prefix of generatePrefixes(start, end)) {
    if (!completed.has(prefix)) {
      pending.push(prefix);
    }
  }

  console.log(`HIBP Downloader`);
  console.log(`===============`);
  console.log(`Range: ${start.toString(16).padStart(5, "0")} - ${end.toString(16).padStart(5, "0")}`);
  console.log(`Total prefixes: ${end - start + 1}`);
  console.log(`Already completed: ${completed.size}`);
  console.log(`Remaining: ${pending.length}`);
  console.log(`Parallel workers: ${parallel}`);
  console.log("");

  if (pending.length === 0) {
    console.log("All prefixes already downloaded!");
    return;
  }

  state.startDownload();

  let processed = 0;
  let totalHashes = 0;
  let totalBytes = 0;
  let totalRetries = 0;
  const startTime = Date.now();
  let lastReport = startTime;

  // Process in parallel batches
  while (pending.length > 0) {
    const batch = pending.splice(0, parallel);

    try {
      const results = await Promise.all(batch.map(downloadAndSave));

      for (const result of results) {
        processed++;
        totalHashes += result.hashCount;
        totalBytes += result.bytes;
        totalRetries += result.retries;

        state.addCompletedDownloadPrefix(result.prefix, result.hashCount);
      }

      // Progress report
      const now = Date.now();
      if (now - lastReport > 5000 || pending.length === 0) {
        const elapsed = (now - startTime) / 1000;
        const rate = processed / elapsed;
        const remaining = pending.length;
        const eta = remaining / rate;

        console.log(
          `Progress: ${processed}/${pending.length + processed} prefixes ` +
            `(${((processed / (pending.length + processed)) * 100).toFixed(1)}%) | ` +
            `${rate.toFixed(1)}/sec | ` +
            `ETA: ${formatDuration(eta)} | ` +
            `Hashes: ${totalHashes.toLocaleString()}`
        );
        lastReport = now;
      }
    } catch (e) {
      console.error(`Error processing batch: ${e}`);
      // Add failed prefixes back to queue
      pending.unshift(...batch);
      await Bun.sleep(5000);
    }
  }

  state.completeDownload();

  // Summary
  const totalTime = (Date.now() - startTime) / 1000;
  console.log("");
  console.log("Download Complete");
  console.log("=================");
  console.log(`Prefixes: ${processed.toLocaleString()}`);
  console.log(`Hashes: ${totalHashes.toLocaleString()}`);
  console.log(`Data: ${(totalBytes / 1024 / 1024 / 1024).toFixed(2)} GB`);
  console.log(`Time: ${formatDuration(totalTime)}`);
  console.log(`Retries: ${totalRetries}`);
}

/**
 * Download a single prefix (for testing)
 */
async function downloadSingle(prefix: string): Promise<void> {
  if (!existsSync(HIBP_DIR)) {
    mkdirSync(HIBP_DIR, { recursive: true });
  }

  console.log(`Downloading prefix ${prefix}...`);
  const result = await downloadAndSave(prefix);

  console.log(`Prefix: ${result.prefix}`);
  console.log(`Hashes: ${result.hashCount}`);
  console.log(`Size: ${result.bytes} bytes`);

  // Update state
  const state = new StateManager(DATA_DIR);
  state.addCompletedDownloadPrefix(result.prefix, result.hashCount);
  state.flush();
}

/**
 * Download a range of prefixes
 */
async function downloadRange(startHex: string, endHex: string, parallel = DEFAULT_PARALLEL): Promise<void> {
  await downloadAll({
    startPrefix: startHex,
    endPrefix: endHex,
    parallel,
    resume: true,
  });
}

/**
 * Download all prefixes to batched storage with ETag support
 * This is the preferred method for full downloads (256 archives vs 1M files)
 */
async function downloadAllBatched(
  options: {
    parallel?: number;
    startPrefix?: string;
    endPrefix?: string;
    resume?: boolean;
    incremental?: boolean;  // Use ETags for change detection
  } = {}
): Promise<void> {
  const { parallel = DEFAULT_PARALLEL, resume = true, incremental = false } = options;

  const state = new StateManager(DATA_DIR);
  const batchManager = new HibpBatchManager(DATA_DIR);

  // Mark that we're using batched storage and initialize tracking
  const pipelineState = state.load();
  pipelineState.download.useBatchedStorage = true;
  if (!pipelineState.download.etags) {
    pipelineState.download.etags = {};
  }
  if (!pipelineState.download.checksums) {
    pipelineState.download.checksums = {};
  }

  // Determine range
  const start = options.startPrefix ? parsePrefix(options.startPrefix) : 0;
  const end = options.endPrefix ? parsePrefix(options.endPrefix) : MAX_PREFIX;

  // Get already completed prefixes (from batch storage if resuming)
  const completed = new Set<string>();
  if (resume) {
    for (const completedPrefix of pipelineState.download.completedPrefixes) {
      completed.add(completedPrefix);
    }
  }

  // Generate work queue
  const pending: string[] = [];
  for (const prefix of generatePrefixes(start, end)) {
    if (!completed.has(prefix)) {
      pending.push(prefix);
    }
  }

  console.log(`HIBP Downloader (Batched Storage)`);
  console.log(`==================================`);
  console.log(`Range: ${start.toString(16).padStart(5, "0")} - ${end.toString(16).padStart(5, "0")}`);
  console.log(`Total prefixes: ${end - start + 1}`);
  console.log(`Already completed: ${completed.size}`);
  console.log(`Remaining: ${pending.length}`);
  console.log(`Parallel workers: ${parallel}`);
  console.log(`Incremental (ETag): ${incremental}`);
  console.log(`Output: ${batchManager.getBatchDir()}`);
  console.log("");

  if (pending.length === 0) {
    console.log("All prefixes already downloaded!");
    return;
  }

  state.startDownload();

  let processed = 0;
  let totalHashes = 0;
  let totalBytes = 0;
  let totalRetries = 0;
  let unchangedCount = 0;
  const startTime = Date.now();
  let lastReport = startTime;
  let lastBatchFlush = startTime;

  // Track which batches have been modified
  const modifiedBatches = new Set<string>();

  // Process in parallel batches
  while (pending.length > 0) {
    const batch = pending.splice(0, parallel);

    try {
      const results = await Promise.all(
        batch.map((p) => downloadToBatched(p, batchManager))
      );

      for (const result of results) {
        processed++;
        totalHashes += result.hashCount;
        totalBytes += result.bytes;
        totalRetries += result.retries;

        if (result.unchanged) {
          unchangedCount++;
        } else {
          // Track modified batch for flushing
          modifiedBatches.add(batchManager.getBatchId(result.prefix));
        }

        state.addCompletedDownloadPrefix(result.prefix, result.hashCount);

        // Track ETag if available
        if (result.etag && pipelineState.download.etags) {
          pipelineState.download.etags[result.prefix] = result.etag;
        }
      }

      // Progress report
      const now = Date.now();
      if (now - lastReport > 5000 || pending.length === 0) {
        const elapsed = (now - startTime) / 1000;
        const rate = processed / elapsed;
        const remaining = pending.length;
        const eta = remaining / rate;

        console.log(
          `Progress: ${processed}/${pending.length + processed} prefixes ` +
            `(${((processed / (pending.length + processed)) * 100).toFixed(1)}%) | ` +
            `${rate.toFixed(1)}/sec | ` +
            `ETA: ${formatDuration(eta)} | ` +
            `Hashes: ${totalHashes.toLocaleString()}` +
            (incremental ? ` | Unchanged: ${unchangedCount}` : "")
        );
        lastReport = now;
      }

      // Periodically flush batches for crash safety (every 60 seconds)
      // CRITICAL: Use flushBatch() to evict from memory, not flushAll() which leaks
      if (now - lastBatchFlush > 60000) {
        console.log(`Flushing ${modifiedBatches.size} modified batches (with eviction)...`);

        // Store checksums for integrity verification
        if (!pipelineState.download.checksums) {
          pipelineState.download.checksums = {};
        }

        // Flush each modified batch and EVICT from cache to prevent memory leak
        for (const batchId of modifiedBatches) {
          const checksum = batchManager.flushBatch(batchId);
          if (checksum) {
            pipelineState.download.checksums[batchId] = checksum;
          }
        }

        modifiedBatches.clear();
        lastBatchFlush = now;
        state.save();
      }
    } catch (e) {
      console.error(`Error processing batch: ${e}`);
      // Add failed prefixes back to queue
      pending.unshift(...batch);
      await Bun.sleep(5000);
    }
  }

  // Final flush - use flushAll here since we're done and don't care about memory
  console.log("Flushing all remaining batches...");
  const finalChecksums = batchManager.flushAll();
  if (!pipelineState.download.checksums) {
    pipelineState.download.checksums = {};
  }
  for (const [batchId, checksum] of finalChecksums) {
    pipelineState.download.checksums[batchId] = checksum;
  }

  state.completeDownload();

  // Summary
  const totalTime = (Date.now() - startTime) / 1000;
  console.log("");
  console.log("Download Complete (Batched)");
  console.log("===========================");
  console.log(`Prefixes: ${processed.toLocaleString()}`);
  console.log(`Hashes: ${totalHashes.toLocaleString()}`);
  console.log(`Data: ${(totalBytes / 1024 / 1024 / 1024).toFixed(2)} GB`);
  console.log(`Time: ${formatDuration(totalTime)}`);
  console.log(`Retries: ${totalRetries}`);
  if (incremental) {
    console.log(`Unchanged (304): ${unchangedCount}`);
  }
  console.log(`Batches: ${finalChecksums.size}`);
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
HibpDownloader - Download HIBP Pwned Passwords

Usage:
  bun HibpDownloader.ts                      Download all prefixes (resume-capable)
  bun HibpDownloader.ts --batched            Download to batched archives (recommended)
  bun HibpDownloader.ts --prefix <hex>       Download single prefix (e.g., 00000)
  bun HibpDownloader.ts --range <start-end>  Download range (e.g., 00000-000FF)
  bun HibpDownloader.ts --parallel <n>       Set parallel downloads (default: 10)

Options:
  --prefix <hex>      Single 5-char hex prefix
  --range <start-end> Hyphenated range of prefixes
  --parallel <n>      Number of concurrent downloads
  --no-resume         Start fresh, ignore previous progress
  --batched           Use batched storage (256 archives vs 1M files) [recommended]
  --incremental       Use ETags for change detection (requires --batched)

Storage Modes:
  Default:  Individual files in ${HIBP_DIR}/
  Batched:  Compressed archives in ${HIBP_BATCH_DIR}/

For full downloads, use --batched to avoid filesystem issues with 1M files.
`);
    process.exit(0);
  }

  // Parse arguments
  let prefix: string | undefined;
  let rangeStart: string | undefined;
  let rangeEnd: string | undefined;
  let parallel = DEFAULT_PARALLEL;
  let resume = true;
  let batched = false;
  let incremental = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--prefix":
        prefix = args[++i]?.toUpperCase();
        break;
      case "--range":
        const range = args[++i]?.toUpperCase();
        if (range?.includes("-")) {
          [rangeStart, rangeEnd] = range.split("-");
        }
        break;
      case "--parallel":
        parallel = parseInt(args[++i]) || DEFAULT_PARALLEL;
        break;
      case "--no-resume":
        resume = false;
        break;
      case "--batched":
        batched = true;
        break;
      case "--incremental":
        incremental = true;
        break;
    }
  }

  // Validate flags
  if (incremental && !batched) {
    console.error("--incremental requires --batched flag");
    process.exit(1);
  }

  try {
    if (prefix) {
      if (!/^[0-9A-F]{5}$/i.test(prefix)) {
        console.error("Prefix must be 5 hex characters (00000-FFFFF)");
        process.exit(1);
      }
      await downloadSingle(prefix);
    } else if (rangeStart && rangeEnd) {
      if (batched) {
        await downloadAllBatched({
          startPrefix: rangeStart,
          endPrefix: rangeEnd,
          parallel,
          resume,
          incremental,
        });
      } else {
        await downloadRange(rangeStart, rangeEnd, parallel);
      }
    } else if (batched) {
      await downloadAllBatched({ parallel, resume, incremental });
    } else {
      await downloadAll({ parallel, resume });
    }
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
  }
}
