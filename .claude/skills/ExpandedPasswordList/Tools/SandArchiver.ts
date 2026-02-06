#!/usr/bin/env bun
/**
 * SandArchiver.ts - Archive Completed SAND Tasks with State Update
 *
 * Wraps SafeArchiver to also update the SandStateManager when tasks complete.
 * This ensures the SAND processing state stays in sync with Hashtopolis.
 *
 * Workflow:
 * 1. Check which SAND tasks are safe to archive
 * 2. Archive completed tasks via SafeArchiver
 * 3. Update SandStateManager to move attacks from "remaining" to "applied"
 * 4. Record crack statistics for each attack
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SandStateManager } from "./SandStateManager";

const CURRENT_FILE = fileURLToPath(import.meta.url);
const SKILL_DIR = dirname(dirname(CURRENT_FILE));
const DATA_DIR = resolve(SKILL_DIR, "data");
const HASHCRACK_DIR = resolve(SKILL_DIR, "..", "Hashcrack");

// =============================================================================
// Server Configuration
// =============================================================================

interface ServerConfig {
  serverIp: string;
  dbPassword: string;
  sshUser: string;
}

function getServerConfig(): ServerConfig {
  const terraformDir = resolve(HASHCRACK_DIR, "terraform", "aws");

  try {
    const serverIp = execSync(`terraform output -raw server_ip`, {
      encoding: "utf-8",
      cwd: terraformDir,
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();
    const dbPassword = execSync(`terraform output -raw db_password`, {
      encoding: "utf-8",
      cwd: terraformDir,
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();
    return { serverIp, dbPassword, sshUser: "ubuntu" };
  } catch (e) {
    throw new Error("Cannot get server config from terraform");
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
    return "";
  }
}

// =============================================================================
// Task Analysis
// =============================================================================

interface SandTask {
  taskId: number;
  taskName: string;
  batchName: string;
  attackName: string;
  keyspace: number;
  keyspaceProgress: number;
  cracked: number;
  isComplete: boolean;
  isArchived: boolean;
  activeChunks: number;
  finishedChunks: number;
}

function parseSandTaskName(taskName: string): { batchName: string; attackName: string } | null {
  // Format: SAND-batch-XXXX-attackname
  const match = taskName.match(/^SAND-(batch-\d+)-(.+)$/);
  if (!match) return null;
  return { batchName: match[1], attackName: match[2] };
}

async function getSandTasks(config: ServerConfig, batchPattern?: string): Promise<SandTask[]> {
  const pattern = batchPattern ? `SAND-${batchPattern}%` : 'SAND-batch-%';

  const sql = `
    SELECT
      t.taskId,
      t.taskName,
      t.keyspace,
      t.keyspaceProgress,
      t.isArchived,
      COALESCE((SELECT SUM(cracked) FROM Chunk c WHERE c.taskId = t.taskId), 0) as cracked,
      (SELECT COUNT(*) FROM Chunk c WHERE c.taskId = t.taskId AND c.state NOT IN (4, 9)) as activeChunks,
      (SELECT COUNT(*) FROM Chunk c WHERE c.taskId = t.taskId AND c.state IN (4, 9)) as finishedChunks
    FROM Task t
    WHERE t.taskName LIKE '${pattern}'
    ORDER BY t.taskId
  `;

  const result = execSQL(config, sql);
  if (!result) return [];

  const tasks: SandTask[] = [];
  for (const line of result.split("\n")) {
    if (!line.trim()) continue;
    const [taskId, taskName, keyspace, keyspaceProgress, isArchived, cracked, activeChunks, finishedChunks] = line.split("\t");

    const parsed = parseSandTaskName(taskName);
    if (!parsed) continue;

    const ks = parseInt(keyspace) || 0;
    const ksProg = parseInt(keyspaceProgress) || 0;
    const active = parseInt(activeChunks) || 0;
    const finished = parseInt(finishedChunks) || 0;

    tasks.push({
      taskId: parseInt(taskId),
      taskName,
      batchName: parsed.batchName,
      attackName: parsed.attackName,
      keyspace: ks,
      keyspaceProgress: ksProg,
      cracked: parseInt(cracked) || 0,
      isComplete: ks > 0 && ksProg >= ks && active === 0,
      isArchived: isArchived === "1",
      activeChunks: active,
      finishedChunks: finished,
    });
  }

  return tasks;
}

// =============================================================================
// Archiving Logic
// =============================================================================

async function archiveTask(config: ServerConfig, taskId: number): Promise<boolean> {
  // Use SafeArchiver for the actual archive
  try {
    const result = execSync(
      `bun Tools/SafeArchiver.ts --task ${taskId}`,
      { encoding: "utf-8", cwd: SKILL_DIR, timeout: 60000 }
    );
    return result.includes("Archived");
  } catch (e) {
    console.error(`  Failed to archive task ${taskId}: ${(e as Error).message}`);
    return false;
  }
}

async function processCompletedTasks(options: {
  batchPattern?: string;
  dryRun?: boolean;
  collectFirst?: boolean;
}): Promise<void> {
  const { batchPattern, dryRun = false, collectFirst = true } = options;

  const config = getServerConfig();
  const stateManager = new SandStateManager(DATA_DIR);

  console.log("SandArchiver - Archive Completed SAND Tasks");
  console.log("=".repeat(50));
  console.log(`Server: ${config.serverIp}`);
  console.log(`Dry run: ${dryRun}`);
  console.log("");

  // Collect DIAMONDS first if requested
  if (collectFirst && !dryRun) {
    console.log("Collecting DIAMONDS before archiving...");
    try {
      execSync(`bun Tools/DiamondCollector.ts`, { encoding: "utf-8", cwd: SKILL_DIR, timeout: 120000 });
    } catch (e) {
      console.warn("  Warning: DiamondCollector failed, continuing...");
    }
    console.log("");
  }

  // Get all SAND tasks
  const tasks = await getSandTasks(config, batchPattern);

  if (tasks.length === 0) {
    console.log("No SAND tasks found.");
    return;
  }

  // Group by batch
  const batches = new Map<string, SandTask[]>();
  for (const task of tasks) {
    if (!batches.has(task.batchName)) {
      batches.set(task.batchName, []);
    }
    batches.get(task.batchName)!.push(task);
  }

  console.log(`Found ${tasks.length} tasks across ${batches.size} batches\n`);

  let totalArchived = 0;
  let totalSkipped = 0;

  for (const [batchName, batchTasks] of batches) {
    console.log(`\n${batchName}:`);

    const completedNotArchived = batchTasks.filter(t => t.isComplete && !t.isArchived);
    const inProgress = batchTasks.filter(t => !t.isComplete && !t.isArchived);
    const alreadyArchived = batchTasks.filter(t => t.isArchived);

    if (alreadyArchived.length > 0) {
      console.log(`  Already archived: ${alreadyArchived.length} tasks`);
    }

    if (inProgress.length > 0) {
      console.log(`  In progress: ${inProgress.length} tasks`);
      for (const t of inProgress) {
        const pct = t.keyspace > 0 ? ((t.keyspaceProgress / t.keyspace) * 100).toFixed(1) : "0";
        const status = t.keyspace === 0 ? "waiting for benchmark" : `${pct}% complete`;
        console.log(`    - ${t.attackName}: ${status} (${t.activeChunks} active chunks)`);
      }
    }

    if (completedNotArchived.length === 0) {
      console.log(`  No tasks ready to archive`);
      continue;
    }

    console.log(`  Ready to archive: ${completedNotArchived.length} tasks`);

    for (const task of completedNotArchived) {
      console.log(`\n  Task ${task.taskId}: ${task.attackName}`);
      console.log(`    Keyspace: ${task.keyspaceProgress.toLocaleString()}/${task.keyspace.toLocaleString()} (100%)`);
      console.log(`    Cracked: ${task.cracked.toLocaleString()}`);

      if (dryRun) {
        console.log(`    [DRY RUN] Would archive and update state`);
        totalSkipped++;
        continue;
      }

      // Archive the task
      const archived = await archiveTask(config, task.taskId);

      if (archived) {
        console.log(`    ✓ Archived`);
        totalArchived++;

        // Update SAND state
        const batchState = stateManager.getBatch(task.batchName);
        if (batchState) {
          // Estimate duration (we don't have exact timing, use 1 hour placeholder)
          stateManager.completeAttack(task.batchName, task.attackName, task.cracked, 3600);
          console.log(`    ✓ State updated: ${task.attackName} moved to applied`);
        } else {
          console.log(`    ⚠ No state found for ${task.batchName}`);
        }
      } else {
        console.log(`    ✗ Archive failed`);
        totalSkipped++;
      }
    }
  }

  // Summary
  console.log("\n" + "=".repeat(50));
  console.log("Summary:");
  console.log(`  Archived: ${totalArchived}`);
  console.log(`  Skipped: ${totalSkipped}`);

  // Show updated state
  if (totalArchived > 0) {
    console.log("\nUpdated SAND State:");
    const summary = stateManager.getSummary();
    console.log(`  Total batches: ${summary.totalBatches}`);
    console.log(`  Total cracked: ${summary.totalCracked.toLocaleString()}`);
  }
}

// =============================================================================
// CLI
// =============================================================================

function printHelp(): void {
  console.log(`
SandArchiver - Archive Completed SAND Tasks with State Update

Archives completed SAND tasks and updates the SandStateManager to track
which attacks have been applied.

Usage:
  bun SandArchiver.ts                          Archive all completed SAND tasks
  bun SandArchiver.ts --batch batch-0001       Archive specific batch
  bun SandArchiver.ts --dry-run                Preview without archiving
  bun SandArchiver.ts --no-collect             Skip DiamondCollector before archive

Options:
  --batch <pattern>   Only process matching batch (e.g., batch-0001)
  --dry-run           Preview what would be archived
  --no-collect        Skip collecting DIAMONDS before archiving

Workflow:
  1. Collects DIAMONDS (saves cracked passwords before archive)
  2. Checks which tasks are 100% complete
  3. Archives completed tasks via SafeArchiver
  4. Updates SandStateManager with attack completion
`);
}

if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    process.exit(0);
  }

  let batchPattern: string | undefined;
  let dryRun = false;
  let collectFirst = true;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--batch":
        batchPattern = args[++i];
        break;
      case "--dry-run":
        dryRun = true;
        break;
      case "--no-collect":
        collectFirst = false;
        break;
    }
  }

  try {
    await processCompletedTasks({ batchPattern, dryRun, collectFirst });
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
  }
}
