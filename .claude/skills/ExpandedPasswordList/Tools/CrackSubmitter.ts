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
const SAND_DIR = resolve(DATA_DIR, "sand");

// Cracking settings
const HASH_TYPE_SHA1 = 100;
// Note: hashcat syntax is: #HL# wordlist -r rulefile (wordlist BEFORE -r)
const DEFAULT_ATTACK_CMD = "#HL# rockyou.txt -r OneRuleToRuleThemStill.rule";
const MAX_HASHES_PER_TASK = 1_000_000; // 1M hashes per hashlist

// File IDs in Hashtopolis (must be uploaded first)
const ROCKYOU_FILE_ID = 1;
const ONERULE_FILE_ID = 3;  // OneRuleToRuleThemStill.rule (was 2 for OneRuleToRuleThemAll.rule)
const ATTACK_FILES = [ROCKYOU_FILE_ID, ONERULE_FILE_ID];

// Custom attack presets (name -> { attackCmd, fileIds })
const ATTACK_PRESETS: Record<string, { attackCmd: string; fileIds: number[] }> = {
  default: { attackCmd: DEFAULT_ATTACK_CMD, fileIds: ATTACK_FILES },
  nocap: { attackCmd: "#HL# nocap.txt -r nocap.rule", fileIds: [5, 6] },  // nocap.txt=5, nocap.rule=6
};

// =============================================================================
// CRITICAL: Rule Attack Keyspace (READ THIS!)
// =============================================================================
// For rule attacks (-a 0 -r), hashcat's -s (skip) parameter skips WORDLIST
// ENTRIES, not keyspace positions. Setting keyspace=wordlist×rules causes
// Hashtopolis to create chunks with skip values > wordlist size, which fail.
//
// CORRECT: keyspace=0 (auto-calculate = wordlist size ~14M)
// WRONG:   keyspace=746B (wordlist × rules) - causes "Restore value > keyspace"
//
// Parallelization for rule attacks: Split HASHES into N hashlists, N tasks,
// with maxAgents=1 per task. This gives N parallel workers.
// See: Hashcrack/docs/PARALLELIZATION.md
// =============================================================================

// File line counts (for reference only - NOT used for keyspace!)
const ROCKYOU_LINES = 14_344_390;  // rockyou.txt
const ONERULE_LINES = 48_439;      // OneRuleToRuleThemStill.rule

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
 * CRITICAL: Check if a task with the given name already exists (prevents duplicate work!)
 * Returns task ID if exists, null if not
 */
function checkTaskExists(config: { serverIp: string; dbPassword: string; sshUser: string }, taskName: string): number | null {
  const result = execSQL(config, `SELECT taskId FROM Task WHERE taskName = '${taskName}' AND isArchived = 0 LIMIT 1`);
  if (result && result.trim()) {
    return parseInt(result.trim());
  }
  return null;
}

/**
 * Check if any tasks for a batch already exist
 * Returns array of existing part numbers
 */
function checkBatchExists(config: { serverIp: string; dbPassword: string; sshUser: string }, batchName: string): number[] {
  const result = execSQL(config, `SELECT taskName FROM Task WHERE taskName LIKE 'Crack-HIBP-${batchName}%' AND isArchived = 0`);
  if (!result || !result.trim()) {
    return [];
  }
  // Extract part numbers from task names
  const existingParts: number[] = [];
  for (const line of result.split('\n')) {
    const match = line.match(/-part(\d+)$/);
    if (match) {
      existingParts.push(parseInt(match[1]));
    }
  }
  return existingParts;
}

/**
 * Pre-flight gates to ensure infrastructure is ready
 * Returns useNewBench value based on agent benchmark format
 */
async function runPreFlightGates(config: { serverIp: string; dbPassword: string; sshUser: string }): Promise<{ useNewBench: number }> {
  console.log("\n=== PRE-FLIGHT GATES ===\n");

  // GATE A: Files exist in correct location
  console.log("GATE A: Checking files exist...");
  const fileCheckCmd = `ssh -o StrictHostKeyChecking=no ${config.sshUser}@${config.serverIp} "sudo docker exec hashtopolis-backend ls /var/www/hashtopolis/files/"`;
  const files = execSync(fileCheckCmd, { encoding: "utf-8", timeout: 30000 }).trim();
  if (!files.includes("rockyou.txt") || !files.includes("OneRuleToRuleThemStill.rule")) {
    throw new Error("GATE A FAILED: Files not found at /var/www/hashtopolis/files/. Stage OneRuleToRuleThemStill.rule first.");
  }
  console.log("  ✓ Files found");

  // GATE B: File download test - MUST pass (files must be downloadable by agents)
  // ERR3 = "file not present" - means getFile.php cannot find files at expected path
  // Fix: Run WarmStart.ts to copy files to /usr/local/share/hashtopolis/files/
  console.log("GATE B: Testing file download...");
  const token = execSQL(config, "SELECT token FROM Agent LIMIT 1");
  if (!token) {
    throw new Error("GATE B FAILED: No agents registered. Wait for agents to register.");
  }
  // Download file content to check for ERR3 error message
  const downloadContentCmd = `ssh -o StrictHostKeyChecking=no ${config.sshUser}@${config.serverIp} "curl -s 'http://localhost:8080/getFile.php?file=1&token=${token}' | head -c 100"`;
  const downloadContent = execSync(downloadContentCmd, { encoding: "utf-8", timeout: 60000 }).trim();

  if (downloadContent.includes("ERR3")) {
    throw new Error(`GATE B FAILED: File download returns ERR3 (file not present).
    Files exist at /var/www/hashtopolis/files/ but getFile.php expects /usr/local/share/hashtopolis/files/.
    FIX: Run 'bun Tools/WarmStart.ts' to copy files to correct location.`);
  }

  // Also check file size to detect truncated downloads
  const downloadSizeCmd = `ssh -o StrictHostKeyChecking=no ${config.sshUser}@${config.serverIp} "curl -s -w '%{size_download}' -o /dev/null 'http://localhost:8080/getFile.php?file=1&token=${token}'"`;
  const downloadSize = parseInt(execSync(downloadSizeCmd, { encoding: "utf-8", timeout: 60000 }).trim());

  if (downloadSize < 1000000) {
    throw new Error(`GATE B FAILED: File download returned only ${downloadSize} bytes (expected ~139MB for rockyou.txt).
    This indicates truncated or corrupted file download.
    FIX: Run 'bun Tools/WarmStart.ts' to copy files to correct location.`);
  }

  console.log(`  ✓ File download works (${(downloadSize / 1024 / 1024).toFixed(1)}MB)`)

  // GATE C: Agents trusted + ignoreErrors=1 (CRITICAL for rule attacks)
  console.log("GATE C: Checking agent trust and error handling...");
  const trustedCount = parseInt(execSQL(config, "SELECT COUNT(*) FROM Agent WHERE isActive=1 AND isTrusted=1"));
  if (trustedCount < 1) {
    throw new Error("GATE C FAILED: No trusted agents. Trust agents first.");
  }
  console.log(`  ✓ ${trustedCount} trusted agents`);

  // Set ignoreErrors=1 on ALL agents (required for rule attacks - prevents "Keyspace measure failed!")
  const noIgnoreErrors = parseInt(execSQL(config, "SELECT COUNT(*) FROM Agent WHERE ignoreErrors=0"));
  if (noIgnoreErrors > 0) {
    console.log(`  Fixing: Setting ignoreErrors=1 on ${noIgnoreErrors} agents...`);
    execSQL(config, "UPDATE Agent SET ignoreErrors=1 WHERE ignoreErrors=0");
  }
  console.log(`  ✓ All agents have ignoreErrors=1`);

  // GATE D: Files marked isSecret=1 (rockyou.txt + OneRuleToRuleThemStill.rule)
  console.log("GATE D: Checking file secrets...");
  const secretFiles = parseInt(execSQL(config, "SELECT COUNT(*) FROM File WHERE isSecret=1 AND fileId IN (1,3)"));
  if (secretFiles < 2) {
    console.log("  Fixing: Setting isSecret=1 on files 1 and 3...");
    execSQL(config, "UPDATE File SET isSecret=1 WHERE fileId IN (1,3)");
  }
  console.log("  ✓ Files marked as secret");

  // GATE E: Benchmark format - ALWAYS use OLD format (useNewBench=0)
  // LESSON 46: Verified agents provide OLD format benchmarks like "74240:5460.54" (time:speed)
  // NOT decimal values. useNewBench MUST match what agents actually provide.
  // Evidence: SELECT benchmark FROM Assignment shows "74240:5460.54" format.
  console.log("GATE E: Benchmark format...");
  const useNewBench = 0; // OLD format - matches what GPU workers actually provide
  console.log(`  ✓ Using OLD benchmark format (useNewBench=0) - matches agent benchmark format`);

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
  // CRITICAL: Default to OLD format (useNewBench=0) per Lesson #46
  // Agents provide "74240:5460.54" format (OLD, not decimal)
  const useNewBench = params.useNewBench ?? 0;

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
async function loadBatches(batchNumber?: number, inputDir: string = CANDIDATES_DIR): Promise<BatchFile[]> {
  if (!existsSync(inputDir)) {
    throw new Error(`Input directory not found: ${inputDir}`);
  }

  const files = readdirSync(inputDir)
    .filter((f) => f.startsWith("batch-") && (f.endsWith(".txt") || f.endsWith(".txt.gz")))
    .sort();

  if (files.length === 0) {
    throw new Error(`No batch files found in ${inputDir}`);
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

    const path = resolve(inputDir, file);
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
 * Calculate priority based on batch number.
 * Older batches (lower numbers) get HIGHER priority to ensure they complete first.
 * This prevents disk space issues from too many concurrent batches.
 *
 * Strategy: Use inverse batch number with high base
 * - batch-0001: priority 999
 * - batch-0100: priority 900
 * - batch-1000: priority 1
 * - batch-3000+: priority 1 (minimum)
 *
 * This scales to thousands of batches while maintaining relative order.
 *
 * CRITICAL: Minimum priority is 1, NOT 0!
 * Hashtopolis uses priority=0 to indicate completed tasks.
 * Using priority=0 for incomplete work is an ANTIPATTERN.
 */
function calculatePriority(batchNumber: number): number {
  const maxPriority = 1000;
  const calculated = maxPriority - batchNumber;
  return Math.max(1, calculated); // Never go below 1 (0 = completed task indicator)
}

/**
 * Extract batch number from batch name (e.g., "batch-0006" -> 6)
 */
function extractBatchNumber(batchName: string): number {
  const match = batchName.match(/batch-(\d+)/);
  return match ? parseInt(match[1], 10) : 0;
}

/**
 * Submit batches to Hashcrack
 */
async function submitBatches(options: {
  batchNumber?: number;
  all?: boolean;
  dryRun?: boolean;
  workers?: number;
  priorityOverride?: number;
  attackPreset?: string;
  sourceDir?: string;
} = {}): Promise<void> {
  const { dryRun = false, workers = 1, priorityOverride, attackPreset = "default", sourceDir = "candidates" } = options;

  // Get attack configuration from preset
  const attackConfig = ATTACK_PRESETS[attackPreset] || ATTACK_PRESETS.default;
  const inputDir = sourceDir === "sand" ? SAND_DIR : CANDIDATES_DIR;

  const state = new StateManager(DATA_DIR);
  const pipelineState = state.load();

  // Check filter stage
  if (pipelineState.filter.status !== "completed" && !options.batchNumber) {
    console.warn("Warning: Filter stage not complete");
  }

  // Load batches from appropriate directory
  const batches = await loadBatches(options.batchNumber, inputDir);

  if (batches.length === 0) {
    console.error("No batches to submit");
    process.exit(1);
  }

  // Calculate totals
  const totalHashes = batches.reduce((sum, b) => sum + b.hashes.length, 0);

  console.log("CrackSubmitter");
  console.log("==============");
  console.log(`Source: ${sourceDir} (${inputDir})`);
  console.log(`Attack: ${attackPreset} (${attackConfig.attackCmd})`);
  console.log(`File IDs: ${attackConfig.fileIds.join(", ")}`);
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

    // Calculate priority from batch number (older = higher priority)
    const batchNum = extractBatchNumber(batch.name);
    const priority = priorityOverride ?? calculatePriority(batchNum);
    console.log(`  Batch ${batchNum} → Priority ${priority}`);

    // Generate naming prefix based on source and attack
    // HIBP- for default pipeline, SAND-<attack>- for SAND testing
    const namePrefix = sourceDir === "sand"
      ? `SAND-${attackPreset}-${batch.name}`
      : `HIBP-${batch.name}`;

    // CRITICAL: Check for existing tasks to prevent duplicate work
    const existingParts = checkBatchExists(serverConfig, batch.name);
    if (existingParts.length > 0) {
      console.log(`  ⚠️  SKIPPING: Batch already has ${existingParts.length} existing tasks (parts: ${existingParts.join(', ')})`);
      console.log(`     To resubmit, first archive existing tasks with: SafeArchiver.ts --batch ${batch.name}`);
      continue;
    }

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

          const hashlistName = `${namePrefix}-part${i + 1}`;

          // Double-check this specific task doesn't exist
          const existingTaskId = checkTaskExists(serverConfig, `Crack-${hashlistName}`);
          if (existingTaskId) {
            console.log(`  ⚠️  SKIPPING part${i + 1}: Task ${existingTaskId} already exists`);
            continue;
          }

          const hashlistId = await client.createHashlist({
            name: hashlistName,
            hashTypeId: HASH_TYPE_SHA1,
            hashes: subHashes,
          });

          console.log(`  Created hashlist ${hashlistId}: ${hashlistName} (${subHashes.length.toLocaleString()} hashes)`);

          // Create task via database (API createTask is broken in Hashtopolis 0.14.x)
          // CRITICAL: Both Task.priority AND TaskWrapper.priority must match
          // Priority set in createTaskViaDB for both
          const { taskId } = await createTaskViaDB(serverConfig, {
            name: `Crack-${hashlistName}`,
            hashlistId,
            attackCmd: attackConfig.attackCmd,
            maxAgents: 1, // Force one agent per task for parallelization
            priority, // Dynamic priority based on batch number
            fileIds: attackConfig.fileIds,
            useNewBench,
          });

          console.log(`  Created task ${taskId} (priority=${priority})`);

          state.addHashlist(hashlistId, taskId, subHashes.length);
        }
      } else {
        // Single hashlist for this batch
        const hashlistName = namePrefix;
        const taskName = `Crack-${hashlistName}`;

        // CRITICAL: Check for existing task to prevent duplicate work
        const existingTaskId = checkTaskExists(serverConfig, taskName);
        if (existingTaskId !== null) {
          console.log(`  ⚠️  SKIPPING: Task "${taskName}" already exists (ID: ${existingTaskId})`);
          console.log(`     To resubmit, first archive the existing task with: SafeArchiver.ts --task ${existingTaskId}`);
          continue;
        }

        const hashlistId = await client.createHashlist({
          name: hashlistName,
          hashTypeId: HASH_TYPE_SHA1,
          hashes: batch.hashes,
        });

        console.log(`  Created hashlist ${hashlistId}: ${hashlistName}`);

        // Create task via database (API createTask is broken in Hashtopolis 0.14.x)
        // CRITICAL: For rule attacks, ALWAYS set maxAgents=1
        // Rule attacks can only effectively use 1 worker per task due to hashcat -s behavior
        // See: Hashcrack/docs/PARALLELIZATION.md
        const { taskId } = await createTaskViaDB(serverConfig, {
          name: taskName,
          hashlistId,
          attackCmd: attackConfig.attackCmd,
          maxAgents: 1, // Rule attacks: ALWAYS 1 worker per task (hashcat -s limitation)
          priority, // Dynamic priority based on batch number
          fileIds: attackConfig.fileIds,
          useNewBench,
        });

        console.log(`  Created task ${taskId} (priority=${priority})`);

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
  bun CrackSubmitter.ts --priority <n>     Override auto-calculated priority
  bun CrackSubmitter.ts --attack <preset>  Use attack preset (default, nocap)
  bun CrackSubmitter.ts --source <dir>     Source directory (candidates, sand)

Options:
  --all             Submit all available batches
  --batch <n>       Submit only batch number N
  --dry-run         Preview without submitting
  --workers <n>     Number of parallel workers (splits hashes)
  --priority <n>    Override priority (default: auto-calculated from batch number)
                    Higher priority = worked first. Older batches get higher priority.
                    Auto-calculation: priority = 1000 - batch_number
                    Example: batch-0006 gets priority 994, batch-0100 gets priority 900
                    CRITICAL: Minimum priority is 1, NOT 0 (0 = completed task indicator)
  --attack <preset> Attack preset: default (rockyou+OneRule), nocap (nocap.txt+nocap.rule)
  --source <dir>    Source: candidates (default), sand (uncracked from previous runs)

Input: ${CANDIDATES_DIR}/
`);
    process.exit(0);
  }

  // Parse arguments
  let batchNumber: number | undefined;
  let all = false;
  let dryRun = false;
  let workers = 1;
  let priorityOverride: number | undefined;
  let attackPreset = "default";
  let sourceDir = "candidates";

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
      case "--priority":
        priorityOverride = parseInt(args[++i]);
        break;
      case "--attack":
        attackPreset = args[++i] || "default";
        break;
      case "--source":
        sourceDir = args[++i] || "candidates";
        break;
    }
  }

  // Validate attack preset
  if (!ATTACK_PRESETS[attackPreset]) {
    console.error(`Unknown attack preset: ${attackPreset}`);
    console.error(`Available presets: ${Object.keys(ATTACK_PRESETS).join(", ")}`);
    process.exit(1);
  }

  if (!all && batchNumber === undefined) {
    console.error("Specify --all or --batch <n>");
    process.exit(1);
  }

  try {
    await submitBatches({ batchNumber, all, dryRun, workers, priorityOverride, attackPreset, sourceDir });
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
  }
}
