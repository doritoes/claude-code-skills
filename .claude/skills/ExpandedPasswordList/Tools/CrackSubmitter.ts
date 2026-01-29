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
import { execSync } from "node:child_process";
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
// Note: hashcat syntax is: #HL# wordlist -r rulefile (wordlist BEFORE -r)
const DEFAULT_ATTACK_CMD = "#HL# rockyou.txt -r OneRuleToRuleThemAll.rule";
const MAX_HASHES_PER_TASK = 1_000_000; // 1M hashes per hashlist

// File IDs in Hashtopolis (must be uploaded first)
const ROCKYOU_FILE_ID = 1;
const ONERULE_FILE_ID = 2;
const ATTACK_FILES = [ROCKYOU_FILE_ID, ONERULE_FILE_ID];

// rockyou.txt line count (14,344,391 passwords)
const ROCKYOU_LINES = 14_344_391;
// OneRuleToRuleThemAll.rule line count
const ONERULE_LINES = 51_993;
// Keyspace = wordlist × rules
const RULE_ATTACK_KEYSPACE = ROCKYOU_LINES * ONERULE_LINES;

// =============================================================================
// SSH + Database Task Creation (API createTask is broken in Hashtopolis 0.14.x)
// =============================================================================

/**
 * Get server connection details from terraform or environment
 */
function getServerConfig(): { serverIp: string; dbPassword: string; sshUser: string } {
  // Try terraform outputs first (HASHCRACK_DIR is skills/Hashcrack/tools)
  const terraformDir = resolve(HASHCRACK_DIR, "..", "terraform", "aws");
  console.log(`  Looking for terraform at: ${terraformDir}`);

  try {
    const serverIp = execSync(`terraform output -raw server_ip`, { encoding: "utf-8", cwd: terraformDir }).trim();
    const dbPassword = execSync(`terraform output -raw db_password`, { encoding: "utf-8", cwd: terraformDir }).trim();
    return { serverIp, dbPassword, sshUser: "ubuntu" };
  } catch (e) {
    console.error(`  Terraform error: ${(e as Error).message}`);
    throw new Error("Cannot get server config from terraform. Ensure terraform is deployed in skills/Hashcrack/terraform/aws");
  }
}

/**
 * Execute SQL on Hashtopolis database via SSH
 */
function execSQL(config: { serverIp: string; dbPassword: string; sshUser: string }, sql: string): string {
  const cmd = `ssh -o StrictHostKeyChecking=no ${config.sshUser}@${config.serverIp} "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'${config.dbPassword}' hashtopolis -sNe \\"${sql.replace(/"/g, '\\"')}\\""`;
  try {
    return execSync(cmd, { encoding: "utf-8", timeout: 60000 }).trim();
  } catch (e) {
    console.error(`SQL Error: ${sql}`);
    throw e;
  }
}

/**
 * Pre-flight gates to ensure infrastructure is ready
 * Returns useNewBench value based on agent benchmark format
 */
async function runPreFlightGates(config: { serverIp: string; dbPassword: string; sshUser: string }): Promise<{ useNewBench: number }> {
  console.log("\n=== PRE-FLIGHT GATES ===\n");

  // GATE A: Files exist in correct location
  console.log("GATE A: Checking files exist...");
  const fileCheckCmd = `ssh -o StrictHostKeyChecking=no ${config.sshUser}@${config.serverIp} "sudo docker exec hashtopolis-backend ls /usr/local/share/hashtopolis/files/"`;
  const files = execSync(fileCheckCmd, { encoding: "utf-8", timeout: 30000 }).trim();
  if (!files.includes("rockyou.txt") || !files.includes("OneRuleToRuleThemAll.rule")) {
    throw new Error("GATE A FAILED: Files not found at /usr/local/share/hashtopolis/files/. Stage files first.");
  }
  console.log("  ✓ Files found");

  // GATE B: File download test
  console.log("GATE B: Testing file download...");
  const token = execSQL(config, "SELECT token FROM Agent LIMIT 1");
  if (!token) {
    throw new Error("GATE B FAILED: No agents registered. Wait for agents to register.");
  }
  const downloadCmd = `ssh -o StrictHostKeyChecking=no ${config.sshUser}@${config.serverIp} "curl -s -w '%{size_download}' -o /dev/null 'http://localhost:8080/getFile.php?file=1&token=${token}'"`;
  const downloadSize = parseInt(execSync(downloadCmd, { encoding: "utf-8", timeout: 60000 }).trim());
  if (downloadSize < 1000000) {
    throw new Error(`GATE B FAILED: File download returned ${downloadSize} bytes. Expected ~139MB.`);
  }
  console.log(`  ✓ File download works (${(downloadSize / 1024 / 1024).toFixed(1)}MB)`);

  // GATE C: Agents trusted
  console.log("GATE C: Checking agent trust...");
  const trustedCount = parseInt(execSQL(config, "SELECT COUNT(*) FROM Agent WHERE isActive=1 AND isTrusted=1"));
  if (trustedCount < 1) {
    throw new Error("GATE C FAILED: No trusted agents. Trust agents first.");
  }
  console.log(`  ✓ ${trustedCount} trusted agents`);

  // GATE D: Files marked isSecret=1
  console.log("GATE D: Checking file secrets...");
  const secretFiles = parseInt(execSQL(config, "SELECT COUNT(*) FROM File WHERE isSecret=1 AND fileId IN (1,2)"));
  if (secretFiles < 2) {
    console.log("  Fixing: Setting isSecret=1 on files...");
    execSQL(config, "UPDATE File SET isSecret=1 WHERE fileId IN (1,2)");
  }
  console.log("  ✓ Files marked as secret");

  // GATE E: Detect benchmark format
  console.log("GATE E: Detecting benchmark format...");
  const benchmark = execSQL(config, "SELECT benchmark FROM Assignment LIMIT 1");
  let useNewBench = 1; // Default to new format
  if (benchmark && benchmark.includes(":")) {
    useNewBench = 0; // OLD format (time:speed)
    console.log(`  ✓ OLD benchmark format detected: ${benchmark} → useNewBench=0`);
  } else if (benchmark) {
    console.log(`  ✓ NEW benchmark format detected: ${benchmark} → useNewBench=1`);
  } else {
    console.log("  ⚠ No benchmarks yet, defaulting to useNewBench=1 (GPU)");
  }

  console.log("\n=== ALL GATES PASSED ===\n");
  return { useNewBench };
}

/**
 * Create task via database (bypasses broken API)
 */
async function createTaskViaDB(
  config: { serverIp: string; dbPassword: string; sshUser: string },
  params: {
    name: string;
    hashlistId: number;
    attackCmd: string;
    maxAgents: number;
    priority: number;
    fileIds: number[];
    useNewBench?: number;
  }
): Promise<{ wrapperId: number; taskId: number }> {
  const useNewBench = params.useNewBench ?? 1;

  // 1. Create TaskWrapper (links hashlist to task)
  const wrapperSQL = `INSERT INTO TaskWrapper (priority, taskType, hashlistId, accessGroupId, taskWrapperName, isArchived, cracked, maxAgents) VALUES (${params.priority}, 0, ${params.hashlistId}, 1, '${params.name}', 0, 0, ${params.maxAgents})`;

  execSQL(config, wrapperSQL);
  const wrapperId = parseInt(execSQL(config, "SELECT MAX(taskWrapperId) FROM TaskWrapper"));

  // 2. Create Task with ALL required fields
  const taskSQL = `INSERT INTO Task (taskName, attackCmd, chunkTime, statusTimer, keyspace, keyspaceProgress, priority, maxAgents, color, isSmall, isCpuTask, useNewBench, skipKeyspace, crackerBinaryId, crackerBinaryTypeId, taskWrapperId, isArchived, notes, staticChunks, chunkSize, forcePipe, usePreprocessor, preprocessorCommand) VALUES ('${params.name}', '${params.attackCmd}', 600, 5, 0, 0, ${params.priority}, ${params.maxAgents}, NULL, 0, 0, ${useNewBench}, 0, 1, 1, ${wrapperId}, 0, '', 0, 0, 0, 0, '')`;

  execSQL(config, taskSQL);
  const taskId = parseInt(execSQL(config, "SELECT MAX(taskId) FROM Task"));

  // 3. Link files to task
  for (const fileId of params.fileIds) {
    execSQL(config, `INSERT INTO FileTask (fileId, taskId) VALUES (${fileId}, ${taskId})`);
  }

  console.log(`    TaskWrapper ${wrapperId}, Task ${taskId} (useNewBench=${useNewBench})`);
  return { wrapperId, taskId };
}

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

  // Initialize Hashcrack client (for hashlist creation - API works for this)
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

  // Get server config for database task creation (API createTask is broken)
  console.log("Getting server config for database operations...");
  const serverConfig = getServerConfig();
  console.log(`Server: ${serverConfig.serverIp}`);

  // Run pre-flight gates (MANDATORY)
  const { useNewBench } = await runPreFlightGates(serverConfig);

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

          console.log(`  Created hashlist ${hashlistId}: ${hashlistName} (${subHashes.length.toLocaleString()} hashes)`);

          // Create task via database (API createTask is broken in Hashtopolis 0.14.x)
          const { taskId } = await createTaskViaDB(serverConfig, {
            name: `Crack-${hashlistName}`,
            hashlistId,
            attackCmd: DEFAULT_ATTACK_CMD,
            maxAgents: 1, // Force one agent per task for parallelization
            priority: 10,
            fileIds: ATTACK_FILES,
            useNewBench,
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

        // Create task via database (API createTask is broken in Hashtopolis 0.14.x)
        const { taskId } = await createTaskViaDB(serverConfig, {
          name: `Crack-${hashlistName}`,
          hashlistId,
          attackCmd: DEFAULT_ATTACK_CMD,
          maxAgents: workers > 1 ? 1 : 0, // Unlimited if single worker mode
          priority: 10,
          fileIds: ATTACK_FILES,
          useNewBench,
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
