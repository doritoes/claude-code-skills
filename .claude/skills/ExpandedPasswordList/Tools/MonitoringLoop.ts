#!/usr/bin/env bun
/**
 * MonitoringLoop.ts - Automated Pipeline Monitoring & Batch Management
 *
 * Monitors cracking progress, detects completion, collects results,
 * cleans up, and submits next batch automatically.
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

import { existsSync, readdirSync, readFileSync, appendFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync, spawn } from "node:child_process";
import { StateManager } from "./StateManager";

// =============================================================================
// Configuration
// =============================================================================

const SKILL_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const DATA_DIR = resolve(SKILL_DIR, "data");
const CANDIDATES_DIR = resolve(DATA_DIR, "candidates");
const RESULTS_DIR = resolve(DATA_DIR, "results");
const LOGS_DIR = resolve(DATA_DIR, "logs");
const ENV_PATH = resolve(dirname(SKILL_DIR), "..", ".env");

// Monitoring thresholds
const DEFAULT_CONFIG = {
  // Diminishing returns: stop if crack rate drops below this (cracks per hour)
  minCracksPerHour: 100,

  // Minimum run time before checking for diminishing returns (minutes)
  minRunTimeMinutes: 30,

  // Check interval (seconds)
  checkIntervalSeconds: 60,

  // Maximum batches to process (0 = unlimited)
  maxBatches: 0,

  // Number of parallel workers
  workers: 8,

  // Auto-submit next batch when current completes
  autoSubmitNext: true,

  // Clean workers between batches
  cleanWorkers: true,

  // Archive tasks after collection
  archiveTasks: true,
};

interface ServerConfig {
  serverIp: string;
  dbPassword: string;
}

interface BatchStatus {
  batchNumber: number;
  totalHashes: number;
  crackedHashes: number;
  crackPercent: number;
  keyspacePercent: number;
  activeTasks: number;
  activeChunks: number;
  startTime: number;
  lastCrackCount: number;
  lastCheckTime: number;
  cracksPerHour: number;
}

// =============================================================================
// Environment & Server Config
// =============================================================================

function loadServerConfig(): ServerConfig {
  // Try terraform first
  const terraformDir = resolve(SKILL_DIR, "..", "Hashcrack", "terraform", "aws");

  try {
    const serverIp = execSync("terraform output -raw server_ip", {
      encoding: "utf-8",
      cwd: terraformDir,
      timeout: 10000,
    }).trim();

    const dbPassword = execSync("terraform output -raw db_password", {
      encoding: "utf-8",
      cwd: terraformDir,
      timeout: 10000,
    }).trim();

    return { serverIp, dbPassword };
  } catch {
    // Fallback to .env
    if (!existsSync(ENV_PATH)) {
      throw new Error("Cannot load server config from terraform or .env");
    }

    const envContent = readFileSync(ENV_PATH, "utf-8");
    const env: Record<string, string> = {};

    for (const line of envContent.split("\n")) {
      const match = line.match(/^([^#=]+)=(.*)$/);
      if (match) {
        env[match[1].trim()] = match[2].trim();
      }
    }

    const serverUrl = env.HASHCRACK_SERVER_URL || "";
    const serverMatch = serverUrl.match(/https?:\/\/([^:\/]+)/);
    const serverIp = serverMatch ? serverMatch[1] : "";
    const dbPassword = env.HASHCRACK_DB_PASSWORD || "";

    if (!serverIp || !dbPassword) {
      throw new Error("HASHCRACK_SERVER_URL or HASHCRACK_DB_PASSWORD not configured");
    }

    return { serverIp, dbPassword };
  }
}

// =============================================================================
// SQL Execution
// =============================================================================

function execSQL(config: ServerConfig, sql: string): string {
  const escapedSql = sql.replace(/"/g, '\\"').replace(/\n/g, " ");
  const cmd = `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 ubuntu@${config.serverIp} "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'${config.dbPassword}' -N -e \\"${escapedSql}\\" hashtopolis 2>/dev/null"`;

  try {
    return execSync(cmd, { encoding: "utf-8", timeout: 30000 }).trim();
  } catch {
    return "";
  }
}

// =============================================================================
// Status Queries
// =============================================================================

function getActiveBatchStatus(config: ServerConfig): BatchStatus | null {
  // Get task and hashlist stats for non-archived items
  const sql = `
    SELECT
      COUNT(DISTINCT t.taskId) as activeTasks,
      (SELECT COUNT(*) FROM Chunk c JOIN Task t2 ON c.taskId = t2.taskId WHERE t2.isArchived = 0 AND c.state = 2) as activeChunks,
      SUM(hl.hashCount) as totalHashes,
      SUM(hl.cracked) as crackedHashes,
      AVG(t.keyspaceProgress / t.keyspace * 100) as avgKeyspacePct
    FROM Task t
    JOIN TaskWrapper tw ON t.taskWrapperId = tw.taskWrapperId
    JOIN Hashlist hl ON tw.hashlistId = hl.hashlistId
    WHERE t.isArchived = 0
  `;

  const result = execSQL(config, sql);
  if (!result) return null;

  const parts = result.split("\t");
  if (parts.length < 5) return null;

  const activeTasks = parseInt(parts[0]) || 0;
  const activeChunks = parseInt(parts[1]) || 0;
  const totalHashes = parseInt(parts[2]) || 0;
  const crackedHashes = parseInt(parts[3]) || 0;
  const keyspacePercent = parseFloat(parts[4]) || 0;

  if (activeTasks === 0) return null;

  // Extract batch number from task name (e.g., "Crack-HIBP-batch-0001-part1" -> 1)
  const taskNameResult = execSQL(config, "SELECT taskName FROM Task WHERE isArchived = 0 LIMIT 1");
  const batchMatch = taskNameResult.match(/batch-(\d+)/i);
  const batchNumber = batchMatch ? parseInt(batchMatch[1]) : 0;

  return {
    batchNumber,
    totalHashes,
    crackedHashes,
    crackPercent: totalHashes > 0 ? (crackedHashes / totalHashes) * 100 : 0,
    keyspacePercent,
    activeTasks,
    activeChunks,
    startTime: Date.now(), // Will be updated from state
    lastCrackCount: crackedHashes,
    lastCheckTime: Date.now(),
    cracksPerHour: 0,
  };
}

function getWorkerStatus(config: ServerConfig): { active: number; total: number; errors: number } {
  const activeResult = execSQL(config, "SELECT COUNT(*) FROM Agent WHERE isActive = 1");
  const totalResult = execSQL(config, "SELECT COUNT(*) FROM Agent");
  const errorResult = execSQL(
    config,
    "SELECT COUNT(*) FROM AgentError WHERE time > UNIX_TIMESTAMP() - 3600"
  );

  return {
    active: parseInt(activeResult) || 0,
    total: parseInt(totalResult) || 0,
    errors: parseInt(errorResult) || 0,
  };
}

function getGpuUtilization(serverIp: string): number[] {
  // Get GPU worker IPs from terraform
  const terraformDir = resolve(SKILL_DIR, "..", "Hashcrack", "terraform", "aws");

  try {
    const ipsRaw = execSync("terraform output -json gpu_worker_ips", {
      encoding: "utf-8",
      cwd: terraformDir,
      timeout: 10000,
    }).trim();

    const ips = JSON.parse(ipsRaw) as string[];
    const utilizations: number[] = [];

    for (const ip of ips.slice(0, 4)) {
      // Sample first 4 for speed
      try {
        const result = execSync(
          `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 -o BatchMode=yes ubuntu@${ip} "nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits" 2>/dev/null`,
          { encoding: "utf-8", timeout: 10000 }
        ).trim();
        utilizations.push(parseInt(result) || 0);
      } catch {
        utilizations.push(0);
      }
    }

    return utilizations;
  } catch {
    return [];
  }
}

// =============================================================================
// Batch Management
// =============================================================================

function getAvailableBatches(): number[] {
  if (!existsSync(CANDIDATES_DIR)) return [];

  const files = readdirSync(CANDIDATES_DIR).filter(
    (f) => f.startsWith("batch-") && (f.endsWith(".txt") || f.endsWith(".txt.gz"))
  );

  const batches: number[] = [];
  for (const file of files) {
    const match = file.match(/batch-(\d+)\.txt/);
    if (match) {
      batches.push(parseInt(match[1]));
    }
  }

  return batches.sort((a, b) => a - b);
}

function getCompletedBatches(state: StateManager): number[] {
  const pipelineState = state.load();
  return pipelineState.crack.completedBatches || [];
}

function getNextBatch(state: StateManager): number | null {
  const available = getAvailableBatches();
  const completed = getCompletedBatches(state);
  const completedSet = new Set(completed);

  for (const batch of available) {
    if (!completedSet.has(batch)) {
      return batch;
    }
  }

  return null;
}

// =============================================================================
// Actions
// =============================================================================

async function runResultCollector(): Promise<boolean> {
  console.log("\n>>> Running ResultCollector...");
  try {
    const result = execSync(`bun "${resolve(SKILL_DIR, "Tools", "ResultCollector.ts")}"`, {
      encoding: "utf-8",
      timeout: 600000, // 10 minutes
      cwd: SKILL_DIR,
    });
    console.log(result);
    return true;
  } catch (e) {
    console.error(`ResultCollector failed: ${(e as Error).message}`);
    return false;
  }
}

async function runTaskArchiver(): Promise<boolean> {
  console.log("\n>>> Running TaskArchiver...");
  try {
    const result = execSync(
      `bun "${resolve(SKILL_DIR, "Tools", "TaskArchiver.ts")}" --archive`,
      {
        encoding: "utf-8",
        timeout: 300000,
        cwd: SKILL_DIR,
      }
    );
    console.log(result);
    return true;
  } catch (e) {
    console.error(`TaskArchiver failed: ${(e as Error).message}`);
    return false;
  }
}

async function runWorkerCleanup(): Promise<boolean> {
  console.log("\n>>> Running WorkerCleanup...");
  try {
    const result = execSync(
      `bun "${resolve(SKILL_DIR, "Tools", "WorkerCleanup.ts")}" --clean`,
      {
        encoding: "utf-8",
        timeout: 300000,
        cwd: SKILL_DIR,
      }
    );
    console.log(result);
    return true;
  } catch (e) {
    console.error(`WorkerCleanup failed: ${(e as Error).message}`);
    return false;
  }
}

async function submitBatch(batchNumber: number, workers: number): Promise<boolean> {
  console.log(`\n>>> Submitting batch ${batchNumber} with ${workers} workers...`);
  try {
    const result = execSync(
      `bun "${resolve(SKILL_DIR, "Tools", "CrackSubmitter.ts")}" --batch ${batchNumber} --workers ${workers}`,
      {
        encoding: "utf-8",
        timeout: 600000,
        cwd: SKILL_DIR,
      }
    );
    console.log(result);
    return true;
  } catch (e) {
    console.error(`CrackSubmitter failed: ${(e as Error).message}`);
    return false;
  }
}

// =============================================================================
// Logging
// =============================================================================

function log(message: string): void {
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] ${message}`;
  console.log(logLine);

  // Also append to log file
  if (!existsSync(LOGS_DIR)) {
    execSync(`mkdir -p "${LOGS_DIR}"`);
  }
  const logFile = resolve(LOGS_DIR, `monitoring-${new Date().toISOString().split("T")[0]}.log`);
  appendFileSync(logFile, logLine + "\n");
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${mins}m`;
}

// =============================================================================
// Main Monitoring Loop
// =============================================================================

interface MonitoringState {
  currentBatch: number;
  batchStartTime: number;
  lastCrackCount: number;
  lastCheckTime: number;
  batchesCompleted: number;
}

async function monitoringLoop(config: typeof DEFAULT_CONFIG): Promise<void> {
  log("=".repeat(60));
  log("MonitoringLoop Starting");
  log("=".repeat(60));
  log(`Config: ${JSON.stringify(config, null, 2)}`);

  const serverConfig = loadServerConfig();
  log(`Server: ${serverConfig.serverIp}`);

  const state = new StateManager(DATA_DIR);
  let monitorState: MonitoringState = {
    currentBatch: 0,
    batchStartTime: Date.now(),
    lastCrackCount: 0,
    lastCheckTime: Date.now(),
    batchesCompleted: 0,
  };

  // Main loop
  while (true) {
    try {
      // Get current status
      const batchStatus = getActiveBatchStatus(serverConfig);
      const workerStatus = getWorkerStatus(serverConfig);

      if (!batchStatus || batchStatus.activeTasks === 0) {
        // No active batch - check if we should submit one
        log("No active batch detected");

        if (config.autoSubmitNext) {
          const nextBatch = getNextBatch(state);
          if (nextBatch !== null) {
            if (config.maxBatches > 0 && monitorState.batchesCompleted >= config.maxBatches) {
              log(`Max batches (${config.maxBatches}) reached. Stopping.`);
              break;
            }

            log(`Submitting next batch: ${nextBatch}`);
            const submitted = await submitBatch(nextBatch, config.workers);

            if (submitted) {
              monitorState.currentBatch = nextBatch;
              monitorState.batchStartTime = Date.now();
              monitorState.lastCrackCount = 0;
              monitorState.lastCheckTime = Date.now();
            }
          } else {
            log("No more batches available. Pipeline complete!");
            break;
          }
        } else {
          log("autoSubmitNext=false, waiting for manual intervention");
        }
      } else {
        // Active batch - check progress
        const runTime = Date.now() - monitorState.batchStartTime;
        const timeSinceLastCheck = Date.now() - monitorState.lastCheckTime;
        const newCracks = batchStatus.crackedHashes - monitorState.lastCrackCount;
        const cracksPerHour =
          timeSinceLastCheck > 0 ? (newCracks / timeSinceLastCheck) * 3600000 : 0;

        // Update state
        if (batchStatus.batchNumber !== monitorState.currentBatch) {
          monitorState.currentBatch = batchStatus.batchNumber;
          monitorState.batchStartTime = Date.now();
        }

        // Log status
        log("-".repeat(60));
        log(
          `Batch ${batchStatus.batchNumber} | ` +
            `Cracked: ${batchStatus.crackedHashes.toLocaleString()}/${batchStatus.totalHashes.toLocaleString()} (${batchStatus.crackPercent.toFixed(2)}%) | ` +
            `Keyspace: ${batchStatus.keyspacePercent.toFixed(4)}%`
        );
        log(
          `Workers: ${workerStatus.active}/${workerStatus.total} active | ` +
            `Chunks: ${batchStatus.activeChunks} | ` +
            `Errors (1h): ${workerStatus.errors}`
        );
        log(
          `Runtime: ${formatDuration(runTime)} | ` +
            `Crack rate: ${cracksPerHour.toFixed(0)}/hour | ` +
            `New cracks: +${newCracks}`
        );

        // Check for diminishing returns
        const minRunTimeMet = runTime > config.minRunTimeMinutes * 60 * 1000;

        if (minRunTimeMet && cracksPerHour < config.minCracksPerHour) {
          log(`\n*** DIMINISHING RETURNS DETECTED ***`);
          log(`Crack rate (${cracksPerHour.toFixed(0)}/hr) < threshold (${config.minCracksPerHour}/hr)`);
          log(`Completing batch ${batchStatus.batchNumber}...`);

          // 1. Collect results
          await runResultCollector();

          // 2. Archive tasks
          if (config.archiveTasks) {
            await runTaskArchiver();
          }

          // 3. Clean workers
          if (config.cleanWorkers) {
            await runWorkerCleanup();
          }

          // 4. Mark batch complete
          const pipelineState = state.load();
          pipelineState.crack.completedBatches = pipelineState.crack.completedBatches || [];
          pipelineState.crack.completedBatches.push(batchStatus.batchNumber);
          state.save();

          monitorState.batchesCompleted++;
          log(`Batch ${batchStatus.batchNumber} complete. Total completed: ${monitorState.batchesCompleted}`);

          // Reset for next batch
          monitorState.currentBatch = 0;
          monitorState.lastCrackCount = 0;
        } else {
          // Update tracking
          monitorState.lastCrackCount = batchStatus.crackedHashes;
          monitorState.lastCheckTime = Date.now();
        }
      }
    } catch (e) {
      log(`ERROR: ${(e as Error).message}`);
    }

    // Wait before next check
    await new Promise((resolve) => setTimeout(resolve, config.checkIntervalSeconds * 1000));
  }

  log("=".repeat(60));
  log("MonitoringLoop Complete");
  log(`Total batches processed: ${monitorState.batchesCompleted}`);
  log("=".repeat(60));
}

// =============================================================================
// One-Shot Status Check
// =============================================================================

async function showStatus(): Promise<void> {
  console.log("MonitoringLoop - Status Check");
  console.log("=".repeat(60));

  const serverConfig = loadServerConfig();
  console.log(`Server: ${serverConfig.serverIp}\n`);

  // Batch status
  const batchStatus = getActiveBatchStatus(serverConfig);
  if (batchStatus) {
    console.log(`Active Batch: ${batchStatus.batchNumber}`);
    console.log(
      `  Cracked: ${batchStatus.crackedHashes.toLocaleString()} / ${batchStatus.totalHashes.toLocaleString()} (${batchStatus.crackPercent.toFixed(2)}%)`
    );
    console.log(`  Keyspace: ${batchStatus.keyspacePercent.toFixed(4)}%`);
    console.log(`  Active tasks: ${batchStatus.activeTasks}`);
    console.log(`  Active chunks: ${batchStatus.activeChunks}`);
  } else {
    console.log("No active batch");
  }

  // Worker status
  console.log("");
  const workerStatus = getWorkerStatus(serverConfig);
  console.log(`Workers: ${workerStatus.active}/${workerStatus.total} active`);
  console.log(`Errors (last hour): ${workerStatus.errors}`);

  // GPU utilization
  console.log("");
  console.log("GPU Utilization (sample):");
  const gpuUtil = getGpuUtilization(serverConfig.serverIp);
  if (gpuUtil.length > 0) {
    gpuUtil.forEach((util, i) => console.log(`  Worker ${i + 1}: ${util}%`));
  } else {
    console.log("  (unable to check)");
  }

  // Batch queue
  console.log("");
  const state = new StateManager(DATA_DIR);
  const available = getAvailableBatches();
  const completed = getCompletedBatches(state);
  const nextBatch = getNextBatch(state);

  console.log(`Batch Queue:`);
  console.log(`  Total batches: ${available.length}`);
  console.log(`  Completed: ${completed.length}`);
  console.log(`  Remaining: ${available.length - completed.length}`);
  console.log(`  Next batch: ${nextBatch ?? "none"}`);
}

// =============================================================================
// CLI
// =============================================================================

if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args[0] === "--help" || args[0] === "-h") {
    console.log(`
MonitoringLoop - Automated Pipeline Monitoring & Batch Management

Monitors cracking progress, detects diminishing returns, collects results,
cleans up, and submits next batch automatically.

Usage:
  bun MonitoringLoop.ts                    Show current status
  bun MonitoringLoop.ts --run              Start monitoring loop
  bun MonitoringLoop.ts --run --max 10     Process max 10 batches then stop
  bun MonitoringLoop.ts --run --manual     Don't auto-submit (manual mode)

Options:
  --run                 Start the monitoring loop (long-running)
  --status              Show current status (default)
  --max <n>             Maximum batches to process (0=unlimited)
  --workers <n>         Number of parallel workers (default: 8)
  --min-rate <n>        Minimum cracks/hour before batch completion (default: 100)
  --min-time <n>        Minimum minutes before checking diminishing returns (default: 30)
  --interval <n>        Check interval in seconds (default: 60)
  --manual              Disable auto-submit (require manual batch submission)
  --no-archive          Don't archive tasks after completion
  --no-clean            Don't clean workers after completion

Examples:
  bun MonitoringLoop.ts --run                     # Full auto mode
  bun MonitoringLoop.ts --run --max 5             # Process 5 batches then stop
  bun MonitoringLoop.ts --run --min-rate 50       # Lower threshold for completion
  bun MonitoringLoop.ts --run --manual            # Monitor only, manual submissions
`);
    process.exit(0);
  }

  // Parse arguments
  const config = { ...DEFAULT_CONFIG };
  let runLoop = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--run":
        runLoop = true;
        break;
      case "--status":
        runLoop = false;
        break;
      case "--max":
        config.maxBatches = parseInt(args[++i]) || 0;
        break;
      case "--workers":
        config.workers = parseInt(args[++i]) || 8;
        break;
      case "--min-rate":
        config.minCracksPerHour = parseInt(args[++i]) || 100;
        break;
      case "--min-time":
        config.minRunTimeMinutes = parseInt(args[++i]) || 30;
        break;
      case "--interval":
        config.checkIntervalSeconds = parseInt(args[++i]) || 60;
        break;
      case "--manual":
        config.autoSubmitNext = false;
        break;
      case "--no-archive":
        config.archiveTasks = false;
        break;
      case "--no-clean":
        config.cleanWorkers = false;
        break;
    }
  }

  try {
    if (runLoop) {
      await monitoringLoop(config);
    } else {
      await showStatus();
    }
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
  }
}
