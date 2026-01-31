#!/usr/bin/env bun
/**
 * ResultCollector.ts - Collect Cracked Passwords from Hashcrack
 *
 * Retrieves cracked hash:password pairs from Hashtopolis and compiles results.
 * Tracks crack source/method for each password to enable cracking methodology analysis.
 *
 * Output formats:
 *   cracked.txt           - HASH:PASSWORD pairs
 *   cracked-with-source.txt - HASH:PASSWORD:SOURCE pairs
 *   crack-stats.json      - Statistics by attack method
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { StateManager } from "./StateManager";

// =============================================================================
// Configuration
// =============================================================================

const CURRENT_FILE = fileURLToPath(import.meta.url);
const SKILL_DIR = dirname(dirname(CURRENT_FILE));
const DATA_DIR = resolve(SKILL_DIR, "data");
const RESULTS_DIR = resolve(DATA_DIR, "results");
const CANDIDATES_DIR = resolve(DATA_DIR, "candidates");
const HASHCRACK_DIR = resolve(dirname(dirname(CURRENT_FILE)), "..", "Hashcrack", "tools");

// =============================================================================
// Attack Source Detection
// =============================================================================

/**
 * Parse attack command to determine human-readable source name
 */
function parseAttackSource(attackCmd: string, taskName: string): string {
  const cmd = attackCmd.toLowerCase();
  const name = taskName.toLowerCase();

  // Rule-based attacks
  if (cmd.includes("oneruletorulethem")) return "rockyou+onerule";
  if (cmd.includes("best64.rule")) return "best64";
  if (cmd.includes("dive.rule")) return "dive";
  if (cmd.includes("d3ad0ne.rule")) return "d3ad0ne";
  if (cmd.includes("generated2.rule")) return "generated2";
  if (cmd.includes("hob0.rule")) return "hob0";
  if (cmd.includes("-r ") && cmd.includes("rockyou")) return "rockyou+rule";

  // Attack modes
  if (cmd.includes("-a 1") || cmd.includes("-a1")) return "combinator";
  if (cmd.includes("-a 3") || cmd.includes("-a3")) return "mask";
  if (cmd.includes("-a 6") || cmd.includes("-a6")) return "hybrid-dict-mask";
  if (cmd.includes("-a 7") || cmd.includes("-a7")) return "hybrid-mask-dict";

  // Wordlist-only (no rules)
  if (cmd.includes("rockyou") && !cmd.includes("-r ")) return "rockyou-direct";
  if (cmd.includes("common") || cmd.includes("10k") || cmd.includes("100k")) return "common-list";

  // Check task name for hints
  if (name.includes("quick")) return "quick-wins";
  if (name.includes("prince")) return "prince";
  if (name.includes("markov")) return "markov";
  if (name.includes("brute")) return "bruteforce";

  // Default based on attack mode
  if (cmd.includes("-a 0") || cmd.includes("-a0")) return "dictionary";

  return "unknown";
}

// =============================================================================
// Hashcrack Client Import
// =============================================================================

async function getHashtopolisClient() {
  try {
    const clientPath = resolve(HASHCRACK_DIR, "HashtopolisClient.ts");
    if (!existsSync(clientPath)) {
      throw new Error(`HashtopolisClient not found at ${clientPath}`);
    }
    const { HashtopolisClient } = await import(clientPath);
    return { HashtopolisClient };
  } catch (e) {
    console.error("Failed to import HashtopolisClient:", e);
    throw new Error("Hashcrack skill not properly installed.");
  }
}

// =============================================================================
// Collector Implementation
// =============================================================================

interface CrackedEntry {
  hash: string;
  plain: string;
  source: string;
}

interface CollectResult {
  hashlistId: number;
  totalHashes: number;
  crackedCount: number;
  cracked: Array<{ hash: string; plain: string }>;
}

/**
 * Collect results from all hashlists
 */
async function collectResults(options: {
  poll?: boolean;
  pollInterval?: number;
  force?: boolean;
} = {}): Promise<void> {
  const { poll = false, pollInterval = 60000, force = false } = options;

  // Ensure results directory exists
  if (!existsSync(RESULTS_DIR)) {
    mkdirSync(RESULTS_DIR, { recursive: true });
  }

  const state = new StateManager(DATA_DIR);
  const pipelineState = state.load();

  // Check crack stage
  if (pipelineState.crack.hashlistIds.length === 0) {
    console.error("No hashlists to collect. Run Crack workflow first.");
    process.exit(1);
  }

  // Initialize client
  const { HashtopolisClient } = await getHashtopolisClient();
  const client = HashtopolisClient.fromEnv();

  console.log("ResultCollector");
  console.log("===============");
  console.log(`Hashlists: ${pipelineState.crack.hashlistIds.length}`);
  console.log(`Tasks: ${pipelineState.crack.taskIds.length}`);
  console.log(`Poll mode: ${poll}`);
  console.log("");

  // Build hashlistId -> taskId mapping
  const hashlistToTask = new Map<number, number>();
  for (let i = 0; i < pipelineState.crack.hashlistIds.length; i++) {
    const hashlistId = pipelineState.crack.hashlistIds[i];
    const taskId = pipelineState.crack.taskIds[i];
    if (taskId) {
      hashlistToTask.set(hashlistId, taskId);
    }
  }

  // Get task details to determine attack sources
  console.log("Fetching task details for source tracking...");
  const taskSources = new Map<number, string>();
  for (const taskId of pipelineState.crack.taskIds) {
    try {
      const taskStatus = await client.getTaskStatus(taskId);
      const taskName = taskStatus.name || `task-${taskId}`;

      // Get full task details including attackCmd
      const tasks = await client.listTasks();
      const task = tasks.find((t: any) => t.taskId === taskId);
      const attackCmd = (task?.attackCmd as string) || "";

      const source = parseAttackSource(attackCmd, taskName);
      taskSources.set(taskId, source);
    } catch (e) {
      taskSources.set(taskId, "unknown");
    }
  }
  console.log(`  Identified ${taskSources.size} task sources`);
  console.log("");

  const allCracked: CrackedEntry[] = [];
  const sourceStats: Record<string, number> = {};
  let totalHashes = 0;
  let totalCracked = 0;

  // Collect from each hashlist
  for (const hashlistId of pipelineState.crack.hashlistIds) {
    console.log(`Collecting hashlist ${hashlistId}...`);

    try {
      // Get hashlist info
      const hashlist = await client.getHashlist(hashlistId);
      const hashCount = (hashlist.hashCount as number) || 0;
      const crackedCount = (hashlist.crackedCount as number) || 0;

      totalHashes += hashCount;
      totalCracked += crackedCount;

      // Determine source for this hashlist
      const taskId = hashlistToTask.get(hashlistId);
      const source = taskId ? (taskSources.get(taskId) || "unknown") : "unknown";

      // Get cracked hashes with source
      const cracked = await client.getCrackedHashes(hashlistId);
      for (const { hash, plain } of cracked) {
        allCracked.push({ hash, plain, source });
        sourceStats[source] = (sourceStats[source] || 0) + 1;
      }

      console.log(`  Total: ${hashCount}, Cracked: ${crackedCount} (${((crackedCount / hashCount) * 100).toFixed(1)}%) [${source}]`);
    } catch (e) {
      console.error(`  Error collecting hashlist ${hashlistId}: ${e}`);
    }
  }

  // Update state
  state.updateCrackProgress(totalCracked);

  // Deduplicate - keep first source encountered for each hash
  const uniqueEntries = new Map<string, CrackedEntry>();
  for (const entry of allCracked) {
    if (!uniqueEntries.has(entry.hash)) {
      uniqueEntries.set(entry.hash, entry);
    }
  }

  // Extract just passwords (sorted, unique)
  const passwords = [...new Set([...uniqueEntries.values()].map(e => e.plain))].sort();

  // Write results
  console.log("");
  console.log("Writing results...");

  // Cracked hash:password pairs (simple format)
  const crackedPairs = [...uniqueEntries.values()]
    .map(e => `${e.hash}:${e.plain}`)
    .sort();
  writeFileSync(resolve(RESULTS_DIR, "cracked.txt"), crackedPairs.join("\n") + "\n");
  console.log(`  cracked.txt: ${crackedPairs.length} pairs`);

  // Cracked with source (HASH:PASSWORD:SOURCE)
  const crackedWithSource = [...uniqueEntries.values()]
    .map(e => `${e.hash}:${e.plain}:${e.source}`)
    .sort();
  writeFileSync(resolve(RESULTS_DIR, "cracked-with-source.txt"), crackedWithSource.join("\n") + "\n");
  console.log(`  cracked-with-source.txt: ${crackedWithSource.length} pairs with source`);

  // Statistics by attack method
  const stats = {
    timestamp: new Date().toISOString(),
    totalHashes,
    totalCracked,
    crackRate: totalHashes > 0 ? ((totalCracked / totalHashes) * 100).toFixed(2) + "%" : "0%",
    uniquePasswords: passwords.length,
    bySource: Object.entries(sourceStats)
      .sort((a, b) => b[1] - a[1])
      .map(([source, count]) => ({
        source,
        count,
        percentage: ((count / totalCracked) * 100).toFixed(2) + "%",
      })),
  };
  writeFileSync(resolve(RESULTS_DIR, "crack-stats.json"), JSON.stringify(stats, null, 2));
  console.log(`  crack-stats.json: statistics by attack method`);

  // Passwords only
  writeFileSync(resolve(RESULTS_DIR, "passwords.txt"), passwords.join("\n") + "\n");
  console.log(`  passwords.txt: ${passwords.length} unique passwords`);

  // Calculate hard passwords (SAND) - only for small datasets
  // For large datasets (>100 batches), use SandCalculator.ts instead
  let hardCount = 0;

  if (existsSync(CANDIDATES_DIR)) {
    const batchFiles = readdirSync(CANDIDATES_DIR)
      .filter((f) => f.startsWith("batch-") && (f.endsWith(".txt") || f.endsWith(".txt.gz")))
      .sort();

    // Only do in-memory SAND calculation for small datasets
    const MAX_BATCHES_IN_MEMORY = 100;

    if (batchFiles.length <= MAX_BATCHES_IN_MEMORY) {
      console.log("Extracting hard (uncracked) passwords...");
      const crackedHashes = new Set(uniqueEntries.keys());
      const hardHashes: string[] = [];

      for (const batchFile of batchFiles) {
        const batchPath = resolve(CANDIDATES_DIR, batchFile);
        let content: string;

        if (batchFile.endsWith(".gz")) {
          const compressed = readFileSync(batchPath);
          content = gunzipSync(compressed).toString("utf-8");
        } else {
          content = readFileSync(batchPath, "utf-8");
        }

        const hashes = content.trim().split("\n").filter((h) => h.length === 40);

        for (const hash of hashes) {
          if (!crackedHashes.has(hash)) {
            hardHashes.push(hash);
          }
        }
      }

      // Write hard passwords (uncracked SHA-1 hashes = SAND)
      if (hardHashes.length > 0) {
        writeFileSync(resolve(RESULTS_DIR, "uncracked.txt"), hardHashes.join("\n") + "\n");
        console.log(`  uncracked.txt: ${hardHashes.length.toLocaleString()} hard hashes (SAND)`);
      }

      hardCount = hardHashes.length;
    } else {
      console.log("");
      console.log(`  NOTE: ${batchFiles.length} GRAVEL batches detected (too large for in-memory SAND).`);
      console.log(`  Run SandCalculator.ts separately for streaming SAND calculation:`);
      console.log(`    bun Tools/SandCalculator.ts`);
      console.log("");
    }
  }

  // Update state
  state.updateResults(passwords.length, hardCount);

  // Summary
  console.log("");
  console.log("Collection Complete");
  console.log("===================");
  console.log(`Total hashes: ${totalHashes.toLocaleString()}`);
  console.log(`Cracked: ${totalCracked.toLocaleString()} (${((totalCracked / totalHashes) * 100).toFixed(2)}%)`);
  console.log(`Hard (uncracked): ${hardCount.toLocaleString()} (SAND)`);
  console.log(`Unique passwords: ${passwords.length.toLocaleString()} (PEARLS)`);
  console.log("");
  console.log("Crack sources:");
  for (const [source, count] of Object.entries(sourceStats).sort((a, b) => b[1] - a[1])) {
    const pct = ((count / totalCracked) * 100).toFixed(1);
    console.log(`  ${source}: ${count.toLocaleString()} (${pct}%)`);
  }
  console.log("");
  console.log(`Results saved to: ${RESULTS_DIR}`);

  // If polling, check if all tasks complete
  if (poll) {
    console.log("");
    console.log("Checking task completion status...");

    let allComplete = true;
    for (const taskId of pipelineState.crack.taskIds) {
      try {
        const status = await client.getTaskStatus(taskId);
        if (status.percentComplete < 100) {
          allComplete = false;
          console.log(`  Task ${taskId}: ${status.percentComplete.toFixed(1)}% complete`);
        }
      } catch (e) {
        console.error(`  Error checking task ${taskId}: ${e}`);
      }
    }

    if (!allComplete) {
      console.log("");
      console.log("Not all tasks complete. Run again later or use --poll to wait.");
    } else {
      state.completeCrack();
      console.log("");
      console.log("All tasks complete!");
    }
  }
}

/**
 * Poll until all tasks complete
 */
async function pollUntilComplete(intervalMs = 60000): Promise<void> {
  const { HashtopolisClient } = await getHashtopolisClient();
  const client = HashtopolisClient.fromEnv();
  const state = new StateManager(DATA_DIR);
  const pipelineState = state.load();

  console.log("Polling for completion...");
  console.log(`Interval: ${intervalMs / 1000}s`);
  console.log("Press Ctrl+C to stop");
  console.log("");

  while (true) {
    let allComplete = true;
    let totalProgress = 0;

    for (const taskId of pipelineState.crack.taskIds) {
      try {
        const status = await client.getTaskStatus(taskId);
        totalProgress += status.percentComplete;
        if (status.percentComplete < 100) {
          allComplete = false;
        }
      } catch (e) {
        // Ignore errors during polling
      }
    }

    const avgProgress = totalProgress / pipelineState.crack.taskIds.length;
    console.log(`[${new Date().toISOString()}] Average progress: ${avgProgress.toFixed(1)}%`);

    if (allComplete) {
      console.log("");
      console.log("All tasks complete! Running final collection...");
      await collectResults({ force: true });
      break;
    }

    await Bun.sleep(intervalMs);
  }
}

// =============================================================================
// CLI Usage
// =============================================================================

if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args[0] === "--help" || args[0] === "-h") {
    console.log(`
ResultCollector - Collect cracked passwords from Hashcrack

Retrieves HASH:PASSWORD pairs and tracks which attack method cracked each password.
This enables analysis of cracking methodology effectiveness.

Usage:
  bun ResultCollector.ts                   Collect current results
  bun ResultCollector.ts --poll            Poll until all tasks complete
  bun ResultCollector.ts --interval <ms>   Poll interval (default: 60000)
  bun ResultCollector.ts --force           Collect even if tasks incomplete

Options:
  --poll              Wait for all tasks to complete
  --interval <ms>     Polling interval in milliseconds
  --force             Collect regardless of completion status

Output files:
  cracked.txt              HASH:PASSWORD pairs
  cracked-with-source.txt  HASH:PASSWORD:SOURCE (attack method)
  passwords.txt            Unique passwords only (PEARLS)
  uncracked.txt            Uncracked hashes (SAND)
  crack-stats.json         Statistics by attack method

Source types:
  rockyou+onerule    Dictionary + OneRuleToRuleThemStill
  rockyou-direct     Dictionary match (no rules)
  best64, dive, etc  Specific rule files
  combinator         Word + word (-a 1)
  hybrid-*           Dictionary + mask (-a 6/7)
  mask               Pure mask attack (-a 3)
  bruteforce         Incremental brute force

Output: ${RESULTS_DIR}/
`);
    process.exit(0);
  }

  // Parse arguments
  let poll = false;
  let pollInterval = 60000;
  let force = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--poll":
        poll = true;
        break;
      case "--interval":
        pollInterval = parseInt(args[++i]) || 60000;
        break;
      case "--force":
        force = true;
        break;
    }
  }

  try {
    if (poll) {
      await pollUntilComplete(pollInterval);
    } else {
      await collectResults({ force });
    }
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
  }
}
