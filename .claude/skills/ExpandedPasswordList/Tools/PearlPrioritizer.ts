#!/usr/bin/env bun
/**
 * PearlPrioritizer.ts - Join PEARLS with HIBP Occurrence Counts
 *
 * Combines cracked passwords (PEARLS) with their HIBP occurrence counts
 * to produce a prioritized wordlist sorted by frequency.
 *
 * More frequently breached passwords are more valuable for cracking.
 *
 * Input:
 *   - data/results/cracked.txt (HASH:PASSWORD pairs)
 *   - data/candidates/counts-index.txt (HASH:COUNT pairs)
 *
 * Output:
 *   - data/results/pearls-prioritized.txt (PASSWORD sorted by count desc)
 *   - data/results/pearls-with-counts.txt (PASSWORD:COUNT for analysis)
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

import { existsSync, readFileSync, writeFileSync, createReadStream } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

// =============================================================================
// Configuration
// =============================================================================

const SKILL_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const DATA_DIR = resolve(SKILL_DIR, "data");
const RESULTS_DIR = resolve(DATA_DIR, "results");
const CANDIDATES_DIR = resolve(DATA_DIR, "candidates");

// =============================================================================
// Prioritizer Implementation
// =============================================================================

interface PearlEntry {
  password: string;
  hash: string;
  count: number;
}

/**
 * Load counts index into a Map for fast lookup
 * Uses streaming to handle large files
 */
async function loadCountsIndex(countsPath: string): Promise<Map<string, number>> {
  const counts = new Map<string, number>();

  if (!existsSync(countsPath)) {
    console.warn(`Counts index not found: ${countsPath}`);
    console.warn("Run SetDifference with --batched to generate counts-index.txt");
    return counts;
  }

  console.log("Loading counts index (streaming)...");

  const fileStream = createReadStream(countsPath);
  const rl = createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  let loaded = 0;
  for await (const line of rl) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === 40) {
      const hash = line.substring(0, 40);
      const count = parseInt(line.substring(41)) || 1;
      counts.set(hash, count);
      loaded++;

      if (loaded % 10_000_000 === 0) {
        console.log(`  Loaded ${(loaded / 1_000_000).toFixed(0)}M entries...`);
      }
    }
  }

  console.log(`  Loaded ${loaded.toLocaleString()} count entries`);
  return counts;
}

/**
 * Load cracked passwords (HASH:PASSWORD pairs)
 */
function loadCrackedPairs(crackedPath: string): Map<string, string> {
  const pairs = new Map<string, string>();

  if (!existsSync(crackedPath)) {
    throw new Error(`Cracked file not found: ${crackedPath}`);
  }

  const content = readFileSync(crackedPath, "utf-8");
  const lines = content.trim().split("\n");

  for (const line of lines) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === 40) {
      const hash = line.substring(0, 40);
      const password = line.substring(41);
      pairs.set(hash, password);
    }
  }

  console.log(`Loaded ${pairs.size.toLocaleString()} cracked pairs`);
  return pairs;
}

/**
 * Join PEARLS with counts and sort by frequency
 */
async function prioritizePearls(options: {
  top?: number;
  minCount?: number;
} = {}): Promise<void> {
  const { top, minCount = 1 } = options;

  const countsPath = resolve(CANDIDATES_DIR, "counts-index.txt");
  const crackedPath = resolve(RESULTS_DIR, "cracked.txt");
  const outputPath = resolve(RESULTS_DIR, "pearls-prioritized.txt");
  const outputWithCountsPath = resolve(RESULTS_DIR, "pearls-with-counts.txt");

  console.log("PearlPrioritizer");
  console.log("================");
  console.log("");

  // Load cracked pairs
  const crackedPairs = loadCrackedPairs(crackedPath);

  // Load counts index
  const countsIndex = await loadCountsIndex(countsPath);

  // Join: for each cracked hash, get its count
  console.log("");
  console.log("Joining PEARLS with counts...");

  const pearls: PearlEntry[] = [];
  let matched = 0;
  let unmatched = 0;

  for (const [hash, password] of crackedPairs) {
    const count = countsIndex.get(hash);
    if (count !== undefined && count >= minCount) {
      pearls.push({ password, hash, count });
      matched++;
    } else {
      // Hash not in counts index (might be from rockyou or other source)
      // Include with count=0 or skip based on minCount
      if (minCount <= 0) {
        pearls.push({ password, hash, count: 0 });
      }
      unmatched++;
    }
  }

  console.log(`  Matched: ${matched.toLocaleString()}`);
  console.log(`  Unmatched: ${unmatched.toLocaleString()}`);

  // Sort by count (descending), then by password (ascending) for stability
  console.log("");
  console.log("Sorting by occurrence count (most frequent first)...");
  pearls.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.password.localeCompare(b.password);
  });

  // Apply top-N limit if specified
  const outputPearls = top ? pearls.slice(0, top) : pearls;

  // Write prioritized passwords (just passwords, sorted by frequency)
  console.log("");
  console.log("Writing output files...");

  const passwordsContent = outputPearls.map((p) => p.password).join("\n") + "\n";
  writeFileSync(outputPath, passwordsContent);
  console.log(`  ${outputPath}`);
  console.log(`    ${outputPearls.length.toLocaleString()} passwords (sorted by frequency)`);

  // Write passwords with counts (for analysis)
  const withCountsContent = outputPearls
    .map((p) => `${p.password}:${p.count}`)
    .join("\n") + "\n";
  writeFileSync(outputWithCountsPath, withCountsContent);
  console.log(`  ${outputWithCountsPath}`);
  console.log(`    Format: PASSWORD:COUNT`);

  // Summary statistics
  console.log("");
  console.log("Statistics");
  console.log("==========");

  if (outputPearls.length > 0) {
    const totalOccurrences = outputPearls.reduce((sum, p) => sum + p.count, 0);
    const maxCount = outputPearls[0].count;
    const minOutputCount = outputPearls[outputPearls.length - 1].count;
    const avgCount = totalOccurrences / outputPearls.length;

    console.log(`Total passwords: ${outputPearls.length.toLocaleString()}`);
    console.log(`Total HIBP occurrences: ${totalOccurrences.toLocaleString()}`);
    console.log(`Max occurrences: ${maxCount.toLocaleString()} (${outputPearls[0].password})`);
    console.log(`Min occurrences: ${minOutputCount.toLocaleString()}`);
    console.log(`Avg occurrences: ${avgCount.toFixed(1)}`);

    // Show top 10
    console.log("");
    console.log("Top 10 Most Common PEARLS:");
    for (let i = 0; i < Math.min(10, outputPearls.length); i++) {
      const p = outputPearls[i];
      console.log(`  ${i + 1}. ${p.password} (${p.count.toLocaleString()} occurrences)`);
    }
  }
}

/**
 * Analyze counts distribution
 */
async function analyzeDistribution(): Promise<void> {
  const countsPath = resolve(CANDIDATES_DIR, "counts-index.txt");

  if (!existsSync(countsPath)) {
    console.error(`Counts index not found: ${countsPath}`);
    process.exit(1);
  }

  console.log("Analyzing HIBP count distribution...");
  console.log("");

  const buckets: Record<string, number> = {
    "1": 0,
    "2-10": 0,
    "11-100": 0,
    "101-1K": 0,
    "1K-10K": 0,
    "10K-100K": 0,
    "100K-1M": 0,
    "1M+": 0,
  };

  const fileStream = createReadStream(countsPath);
  const rl = createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  let total = 0;
  let totalOccurrences = 0;

  for await (const line of rl) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === 40) {
      const count = parseInt(line.substring(41)) || 1;
      total++;
      totalOccurrences += count;

      if (count === 1) buckets["1"]++;
      else if (count <= 10) buckets["2-10"]++;
      else if (count <= 100) buckets["11-100"]++;
      else if (count <= 1000) buckets["101-1K"]++;
      else if (count <= 10000) buckets["1K-10K"]++;
      else if (count <= 100000) buckets["10K-100K"]++;
      else if (count <= 1000000) buckets["100K-1M"]++;
      else buckets["1M+"]++;
    }
  }

  console.log("HIBP Occurrence Distribution (GRAVEL)");
  console.log("=====================================");
  console.log(`Total hashes: ${total.toLocaleString()}`);
  console.log(`Total occurrences: ${totalOccurrences.toLocaleString()}`);
  console.log("");
  console.log("Distribution:");

  for (const [bucket, count] of Object.entries(buckets)) {
    const pct = ((count / total) * 100).toFixed(2);
    const bar = "█".repeat(Math.round(parseFloat(pct) / 2));
    console.log(`  ${bucket.padEnd(10)} ${count.toLocaleString().padStart(15)} (${pct}%) ${bar}`);
  }
}

// =============================================================================
// CLI Usage
// =============================================================================

if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args[0] === "--help" || args[0] === "-h") {
    console.log(`
PearlPrioritizer - Join PEARLS with HIBP Occurrence Counts

Usage:
  bun PearlPrioritizer.ts                  Prioritize all PEARLS by frequency
  bun PearlPrioritizer.ts --top <n>        Output only top N passwords
  bun PearlPrioritizer.ts --min-count <n>  Only include passwords with >= N occurrences
  bun PearlPrioritizer.ts --analyze        Analyze count distribution

Options:
  --top <n>        Limit output to top N most frequent passwords
  --min-count <n>  Filter out passwords with fewer than N occurrences
  --analyze        Show distribution analysis of counts-index.txt

Output:
  data/results/pearls-prioritized.txt   Passwords sorted by HIBP frequency
  data/results/pearls-with-counts.txt   PASSWORD:COUNT format for analysis

The prioritized wordlist puts most commonly breached passwords first,
making it more effective for password cracking attacks.
`);
    process.exit(0);
  }

  // Parse arguments
  let top: number | undefined;
  let minCount = 1;
  let analyze = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--top":
        top = parseInt(args[++i]);
        break;
      case "--min-count":
        minCount = parseInt(args[++i]) || 1;
        break;
      case "--analyze":
        analyze = true;
        break;
    }
  }

  try {
    if (analyze) {
      await analyzeDistribution();
    } else {
      await prioritizePearls({ top, minCount });
    }
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
  }
}
