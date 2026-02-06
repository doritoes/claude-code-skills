#!/usr/bin/env bun
/**
 * DiamondCollector.ts - Collect Cracked Passwords from SAND Processing
 *
 * Retrieves cracked hash:password pairs from SAND hashlists and saves them as DIAMONDS.
 * When ALL attacks complete for a batch, extracts uncracked hashes as GLASS.
 *
 * NOMENCLATURE (from Skill.md):
 *   GRAVEL → Stage 1 cracking → PEARLS (cracked) + SAND (uncracked)
 *   SAND   → Stage 2+ cracking → DIAMONDS (cracked) + GLASS (uncracked)
 *
 * IMPORTANT: This tool collects from SAND hashlists (named SAND-batch-XXXX).
 *            For Stage 1 results (PEARLS), use ResultCollector.ts instead.
 *
 * Output files:
 *   data/diamonds/batch-XXXX.txt           - HASH:PASSWORD pairs (DIAMONDS)
 *   data/diamonds/passwords-batch-XXXX.txt - Passwords only (for wordlist feedback)
 *   data/glass/batch-XXXX.txt              - Uncracked hashes (GLASS) - when batch complete
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { SandStateManager } from "./SandStateManager";
import { execSync } from "node:child_process";

// =============================================================================
// Configuration
// =============================================================================

const CURRENT_FILE = fileURLToPath(import.meta.url);
const SKILL_DIR = dirname(dirname(CURRENT_FILE));
const DATA_DIR = resolve(SKILL_DIR, "data");
const SAND_DIR = resolve(DATA_DIR, "sand");
const DIAMONDS_DIR = resolve(DATA_DIR, "diamonds");
const GLASS_DIR = resolve(DATA_DIR, "glass");
const HASHCRACK_DIR = resolve(SKILL_DIR, "..", "Hashcrack", "tools");

// =============================================================================
// Hashtopolis Client
// =============================================================================

async function getHashtopolisClient() {
  const clientPath = resolve(HASHCRACK_DIR, "HashtopolisClient.ts");
  if (!existsSync(clientPath)) {
    throw new Error(`HashtopolisClient not found at ${clientPath}`);
  }
  const { HashtopolisClient } = await import(clientPath);
  return { HashtopolisClient };
}

// =============================================================================
// Server Config (for checking task completion)
// =============================================================================

interface ServerConfig {
  serverIp: string;
  dbPassword: string;
  sshUser: string;
}

function getServerConfig(): ServerConfig {
  const terraformDir = resolve(HASHCRACK_DIR, "..", "terraform", "aws");

  try {
    const serverIp = execSync(`terraform output -raw server_ip`, { encoding: "utf-8", cwd: terraformDir }).trim();
    const dbPassword = execSync(`terraform output -raw db_password`, { encoding: "utf-8", cwd: terraformDir }).trim();
    return { serverIp, dbPassword, sshUser: "ubuntu" };
  } catch (e) {
    throw new Error("Cannot get server config from terraform. Ensure terraform is deployed.");
  }
}

function execSQL(config: ServerConfig, sql: string): string {
  const cleanSql = sql.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
  const b64Sql = Buffer.from(cleanSql).toString('base64');
  const cmd = `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 ${config.sshUser}@${config.serverIp} "echo ${b64Sql} | base64 -d | sudo docker exec -i hashtopolis-db mysql -u hashtopolis -p'${config.dbPassword}' hashtopolis -sN"`;

  try {
    const shell = process.platform === "win32" ? "C:\Program Files\Git\bin\bash.exe" : "/bin/bash";
    return execSync(cmd, { encoding: "utf-8", timeout: 30000, shell }).trim();
  } catch (e) {
    console.error("SQL error:", (e as Error).message);
    return "";
  }
}

// =============================================================================
// Collection Logic
// =============================================================================

interface CollectionResult {
  batchName: string;
  hashlistId: number;
  totalHashes: number;
  crackedCount: number;
  newDiamonds: number;
  glassExtracted: boolean;
}

/**
 * Load original SAND batch hashes for GLASS extraction
 */
function loadSandBatchHashes(batchName: string): string[] {
  const gzPath = resolve(SAND_DIR, `${batchName}.txt.gz`);
  const txtPath = resolve(SAND_DIR, `${batchName}.txt`);

  let content: string;

  if (existsSync(gzPath)) {
    const compressed = readFileSync(gzPath);
    content = gunzipSync(compressed).toString("utf-8");
  } else if (existsSync(txtPath)) {
    content = readFileSync(txtPath, "utf-8");
  } else {
    return [];
  }

  return content.trim().split("\n").filter((h) => h.length === 40);
}

/**
 * Check if all attacks for a batch are complete
 */
function areAllAttacksComplete(config: ServerConfig, taskIds: number[]): boolean {
  if (taskIds.length === 0) return false;

  for (const taskId of taskIds) {
    // Check if task has unfinished chunks
    // Chunk states: 0=INIT, 2=ASSIGNED, 4=FINISHED, 6=DISPATCHED, 9=TRIMMED
    const unfinished = execSQL(config, `
      SELECT COUNT(*) FROM Chunk
      WHERE taskId = ${taskId}
      AND state NOT IN (4, 9)
    `);

    if (parseInt(unfinished) > 0) {
      return false;
    }

    // Also check keyspace progress
    const progress = execSQL(config, `
      SELECT keyspaceProgress, keyspace FROM Task WHERE taskId = ${taskId}
    `);

    if (progress) {
      const [kProgress, kSpace] = progress.split("\t").map(Number);
      if (kSpace > 0 && kProgress < kSpace) {
        return false;
      }
    }
  }

  return true;
}

/**
 * Collect DIAMONDS from a single SAND batch
 */
async function collectBatch(
  batchName: string,
  options: { extractGlass?: boolean; force?: boolean } = {}
): Promise<CollectionResult | null> {
  const { extractGlass = false, force = false } = options;

  // Ensure directories exist
  if (!existsSync(DIAMONDS_DIR)) {
    mkdirSync(DIAMONDS_DIR, { recursive: true });
  }
  if (!existsSync(GLASS_DIR)) {
    mkdirSync(GLASS_DIR, { recursive: true });
  }

  // Load state
  const stateManager = new SandStateManager(DATA_DIR);
  const batchState = stateManager.getBatch(batchName);

  if (!batchState) {
    console.error(`No state found for ${batchName}. Run SandProcessor first.`);
    return null;
  }

  if (!batchState.hashlistId) {
    console.error(`No hashlist ID for ${batchName}`);
    return null;
  }

  console.log(`\nCollecting DIAMONDS from ${batchName}...`);
  console.log(`  Hashlist ID: ${batchState.hashlistId}`);
  console.log(`  Total hashes: ${batchState.hashCount.toLocaleString()}`);

  // Get Hashtopolis client
  const { HashtopolisClient } = await getHashtopolisClient();
  const client = HashtopolisClient.fromEnv();

  // Get cracked hashes
  const cracked = await client.getCrackedHashes(batchState.hashlistId);
  console.log(`  Cracked: ${cracked.length.toLocaleString()}`);

  // Load existing DIAMONDS to deduplicate
  const diamondsPath = resolve(DIAMONDS_DIR, `${batchName}.txt`);
  const existingDiamonds = new Set<string>();

  if (existsSync(diamondsPath) && !force) {
    const existing = readFileSync(diamondsPath, "utf-8").trim().split("\n");
    for (const line of existing) {
      const hash = line.split(":")[0];
      if (hash) existingDiamonds.add(hash);
    }
    console.log(`  Existing DIAMONDS: ${existingDiamonds.size.toLocaleString()}`);
  }

  // Filter to only new cracks
  const newCracks = cracked.filter((c) => !existingDiamonds.has(c.hash));
  console.log(`  New DIAMONDS: ${newCracks.length.toLocaleString()}`);

  // Write DIAMONDS
  if (newCracks.length > 0 || force) {
    // Combine existing + new
    const allDiamonds = [
      ...Array.from(existingDiamonds).map((h) => {
        // Reconstruct from existing file
        const match = cracked.find((c) => c.hash === h);
        return match ? `${match.hash}:${match.plain}` : null;
      }).filter(Boolean),
      ...newCracks.map((c) => `${c.hash}:${c.plain}`),
    ];

    // Dedupe and sort
    const uniqueDiamonds = [...new Set(allDiamonds)].sort();
    writeFileSync(diamondsPath, uniqueDiamonds.join("\n") + "\n");
    console.log(`  Wrote ${uniqueDiamonds.length.toLocaleString()} DIAMONDS to ${diamondsPath}`);

    // Also write passwords-only file for wordlist feedback
    const passwordsPath = resolve(DIAMONDS_DIR, `passwords-${batchName}.txt`);
    const passwords = [...new Set(cracked.map((c) => c.plain))].sort();
    writeFileSync(passwordsPath, passwords.join("\n") + "\n");
    console.log(`  Wrote ${passwords.length.toLocaleString()} passwords to ${passwordsPath}`);
  }

  // Update state with cracked count
  stateManager.updateCracked(batchName, cracked.length);

  // Check if we should extract GLASS
  let glassExtracted = false;

  if (extractGlass) {
    const config = getServerConfig();
    const taskIds = Object.values(batchState.taskIds);
    const allComplete = areAllAttacksComplete(config, taskIds);

    if (allComplete || force) {
      console.log(`\n  Extracting GLASS (uncracked hashes)...`);

      // Load original SAND hashes
      const originalHashes = loadSandBatchHashes(batchName);
      if (originalHashes.length === 0) {
        console.error(`  Cannot load original SAND batch file for ${batchName}`);
      } else {
        // Create set of cracked hashes
        const crackedSet = new Set(cracked.map((c) => c.hash));

        // GLASS = original SAND - cracked
        const glassHashes = originalHashes.filter((h) => !crackedSet.has(h));

        const glassPath = resolve(GLASS_DIR, `${batchName}.txt`);
        writeFileSync(glassPath, glassHashes.join("\n") + "\n");
        console.log(`  Wrote ${glassHashes.length.toLocaleString()} GLASS hashes to ${glassPath}`);

        glassExtracted = true;

        // Mark batch as complete
        stateManager.completeBatch(batchName);
      }
    } else {
      console.log(`\n  GLASS extraction skipped - not all attacks complete`);
      console.log(`  Attacks remaining: ${batchState.attacksRemaining.length}`);
    }
  }

  return {
    batchName,
    hashlistId: batchState.hashlistId,
    totalHashes: batchState.hashCount,
    crackedCount: cracked.length,
    newDiamonds: newCracks.length,
    glassExtracted,
  };
}

/**
 * Collect DIAMONDS from all SAND batches
 */
async function collectAll(options: { extractGlass?: boolean; force?: boolean } = {}): Promise<void> {
  const stateManager = new SandStateManager(DATA_DIR);
  const state = stateManager.load();

  const batches = Object.keys(state.batches);
  if (batches.length === 0) {
    console.log("No SAND batches in state. Run SandProcessor first.");
    return;
  }

  console.log(`Collecting DIAMONDS from ${batches.length} batches...`);

  const results: CollectionResult[] = [];

  for (const batchName of batches) {
    const result = await collectBatch(batchName, options);
    if (result) {
      results.push(result);
    }
  }

  // Summary
  console.log("\n" + "=".repeat(60));
  console.log("Collection Summary");
  console.log("=".repeat(60));

  let totalHashes = 0;
  let totalCracked = 0;
  let totalNewDiamonds = 0;
  let totalGlass = 0;

  for (const r of results) {
    totalHashes += r.totalHashes;
    totalCracked += r.crackedCount;
    totalNewDiamonds += r.newDiamonds;

    const rate = r.totalHashes > 0 ? ((r.crackedCount / r.totalHashes) * 100).toFixed(2) : "0";
    const glassStatus = r.glassExtracted ? " [GLASS]" : "";
    console.log(`  ${r.batchName}: ${r.crackedCount.toLocaleString()} DIAMONDS (${rate}%)${glassStatus}`);
  }

  console.log("");
  console.log(`Total hashes: ${totalHashes.toLocaleString()}`);
  console.log(`Total DIAMONDS: ${totalCracked.toLocaleString()} (${((totalCracked / totalHashes) * 100).toFixed(2)}%)`);
  console.log(`New DIAMONDS this run: ${totalNewDiamonds.toLocaleString()}`);
  console.log("");
  console.log(`DIAMONDS saved to: ${DIAMONDS_DIR}`);
  if (results.some((r) => r.glassExtracted)) {
    console.log(`GLASS saved to: ${GLASS_DIR}`);
  }
}

/**
 * Show collection status
 */
async function showStatus(): Promise<void> {
  console.log("DIAMOND Collection Status");
  console.log("=========================\n");

  // Check directories
  const diamondsExists = existsSync(DIAMONDS_DIR);
  const glassExists = existsSync(GLASS_DIR);

  console.log(`DIAMONDS directory: ${diamondsExists ? "exists" : "NOT FOUND"}`);
  console.log(`GLASS directory: ${glassExists ? "exists" : "NOT FOUND"}`);
  console.log("");

  // Load state
  const stateManager = new SandStateManager(DATA_DIR);
  const state = stateManager.load();

  if (Object.keys(state.batches).length === 0) {
    console.log("No SAND batches tracked. Run SandProcessor first.");
    return;
  }

  console.log("Batch Status:");
  for (const [name, batch] of Object.entries(state.batches)) {
    const rate = batch.hashCount > 0 ? ((batch.cracked / batch.hashCount) * 100).toFixed(2) : "0";
    const diamondFile = resolve(DIAMONDS_DIR, `${name}.txt`);
    const glassFile = resolve(GLASS_DIR, `${name}.txt`);

    const hasDiamonds = existsSync(diamondFile) ? "DIAMONDS" : "";
    const hasGlass = existsSync(glassFile) ? "GLASS" : "";
    const files = [hasDiamonds, hasGlass].filter(Boolean).join(", ") || "(no files)";

    console.log(`  ${name}: ${batch.cracked.toLocaleString()}/${batch.hashCount.toLocaleString()} (${rate}%) - ${files}`);
  }
}

// =============================================================================
// CLI Entry Point
// =============================================================================

if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args[0] === "--help" || args[0] === "-h") {
    console.log(`
DiamondCollector - Collect Cracked Passwords from SAND Processing

This tool retrieves cracked hashes from SAND hashlists and saves them as DIAMONDS.
When all attacks complete for a batch, it can extract uncracked hashes as GLASS.

NOMENCLATURE:
  GRAVEL → Stage 1 → PEARLS (cracked) + SAND (uncracked)
  SAND   → Stage 2 → DIAMONDS (cracked) + GLASS (uncracked after ALL attacks)

Usage:
  bun DiamondCollector.ts                         Collect all batches
  bun DiamondCollector.ts --batch <name>          Collect specific batch
  bun DiamondCollector.ts --glass                 Also extract GLASS if complete
  bun DiamondCollector.ts --force                 Force overwrite existing files
  bun DiamondCollector.ts --status                Show collection status

Options:
  --batch <name>   Batch name (e.g., batch-0001)
  --glass          Extract GLASS for completed batches
  --force          Overwrite existing DIAMOND/GLASS files
  --status         Show status of collected files

Output:
  DIAMONDS: ${DIAMONDS_DIR}/batch-XXXX.txt
  GLASS:    ${GLASS_DIR}/batch-XXXX.txt
`);
    process.exit(0);
  }

  // Parse arguments
  let batchName: string | undefined;
  let extractGlass = false;
  let force = false;
  let statusOnly = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--batch":
        batchName = args[++i];
        break;
      case "--glass":
        extractGlass = true;
        break;
      case "--force":
        force = true;
        break;
      case "--status":
        statusOnly = true;
        break;
    }
  }

  try {
    if (statusOnly) {
      await showStatus();
    } else if (batchName) {
      const result = await collectBatch(batchName, { extractGlass, force });
      if (result) {
        console.log("\nCollection complete.");
      }
    } else {
      await collectAll({ extractGlass, force });
    }
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
  }
}
