#!/usr/bin/env bun
/**
 * TaskArchiver.ts - Archive Completed Hashtopolis Tasks
 *
 * Archives completed tasks and optionally cleans up hashlists to free database space.
 * Run after collecting PEARLS to prevent Hashtopolis from becoming cluttered.
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { StateManager } from "./StateManager";

// =============================================================================
// Configuration
// =============================================================================

const SKILL_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const DATA_DIR = resolve(SKILL_DIR, "data");
const ENV_PATH = resolve(dirname(SKILL_DIR), "..", ".env");

interface Config {
  serverIp: string;
  dbPassword: string;
}

// =============================================================================
// Environment Loading
// =============================================================================

function loadConfig(): Config {
  if (!existsSync(ENV_PATH)) {
    throw new Error(`.env not found at ${ENV_PATH}`);
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

  if (!serverIp) {
    throw new Error("HASHCRACK_SERVER_URL not configured in .env");
  }

  const dbPassword = env.HASHCRACK_DB_PASSWORD || "";
  if (!dbPassword) {
    throw new Error("HASHCRACK_DB_PASSWORD not configured in .env");
  }

  return { serverIp, dbPassword };
}

// =============================================================================
// SQL Execution
// =============================================================================

function execSQL(config: Config, sql: string): string {
  const escapedSql = sql.replace(/"/g, '\\"');
  const cmd = `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 ubuntu@${config.serverIp} "docker exec hashtopolis-db mysql -u hashtopolis -p'${config.dbPassword}' -N -e \\"${escapedSql}\\" hashtopolis 2>/dev/null"`;

  try {
    return execSync(cmd, { encoding: "utf-8", timeout: 30000 }).trim();
  } catch (e) {
    return "";
  }
}

// =============================================================================
// Task Archiver
// =============================================================================

interface TaskInfo {
  taskId: number;
  taskName: string;
  keyspace: number;
  keyspaceProgress: number;
  isComplete: boolean;
  hashlistId: number;
  crackedCount: number;
}

interface ArchiveResult {
  tasksArchived: number;
  hashlistsDeleted: number;
  hashesDeleted: number;
}

/**
 * Get all tasks and their status
 */
function getTasks(config: Config): TaskInfo[] {
  const sql = `
    SELECT t.taskId, t.taskName, t.keyspace, t.keyspaceProgress, tw.hashlistId,
           (SELECT COUNT(*) FROM Hash h WHERE h.hashlistId = tw.hashlistId AND h.isCracked = 1) as crackedCount
    FROM Task t
    JOIN TaskWrapper tw ON t.taskWrapperId = tw.taskWrapperId
    WHERE t.isArchived = 0
    ORDER BY t.taskId
  `;

  const result = execSQL(config, sql);
  if (!result) return [];

  const tasks: TaskInfo[] = [];
  for (const line of result.split("\n")) {
    const parts = line.split("\t");
    if (parts.length >= 6) {
      const keyspace = parseInt(parts[2]) || 0;
      const keyspaceProgress = parseInt(parts[3]) || 0;

      tasks.push({
        taskId: parseInt(parts[0]),
        taskName: parts[1],
        keyspace,
        keyspaceProgress,
        isComplete: keyspaceProgress >= keyspace && keyspace > 0,
        hashlistId: parseInt(parts[4]),
        crackedCount: parseInt(parts[5]) || 0,
      });
    }
  }

  return tasks;
}

/**
 * Archive completed tasks
 */
function archiveTasks(config: Config, taskIds: number[]): number {
  if (taskIds.length === 0) return 0;

  const idList = taskIds.join(",");

  // Archive tasks
  execSQL(config, `UPDATE Task SET isArchived = 1 WHERE taskId IN (${idList})`);

  // Archive task wrappers
  execSQL(config, `
    UPDATE TaskWrapper tw
    SET tw.isArchived = 1
    WHERE tw.taskWrapperId IN (
      SELECT t.taskWrapperId FROM Task t WHERE t.taskId IN (${idList})
    )
  `);

  return taskIds.length;
}

/**
 * Delete hashlists (and their hashes) for archived tasks
 * WARNING: This permanently deletes cracked password data!
 */
function deleteHashlists(config: Config, hashlistIds: number[]): { hashlistsDeleted: number; hashesDeleted: number } {
  if (hashlistIds.length === 0) return { hashlistsDeleted: 0, hashesDeleted: 0 };

  const idList = hashlistIds.join(",");

  // Count hashes before deletion
  const hashCount = parseInt(execSQL(config, `SELECT COUNT(*) FROM Hash WHERE hashlistId IN (${idList})`)) || 0;

  // Delete hashes first (foreign key constraint)
  execSQL(config, `DELETE FROM Hash WHERE hashlistId IN (${idList})`);

  // Delete hashlists
  execSQL(config, `DELETE FROM Hashlist WHERE hashlistId IN (${idList})`);

  return { hashlistsDeleted: hashlistIds.length, hashesDeleted: hashCount };
}

/**
 * Get summary statistics
 */
function getStats(config: Config): { totalTasks: number; archivedTasks: number; totalHashes: number; crackedHashes: number } {
  const totalTasks = parseInt(execSQL(config, "SELECT COUNT(*) FROM Task")) || 0;
  const archivedTasks = parseInt(execSQL(config, "SELECT COUNT(*) FROM Task WHERE isArchived = 1")) || 0;
  const totalHashes = parseInt(execSQL(config, "SELECT COUNT(*) FROM Hash")) || 0;
  const crackedHashes = parseInt(execSQL(config, "SELECT COUNT(*) FROM Hash WHERE isCracked = 1")) || 0;

  return { totalTasks, archivedTasks, totalHashes, crackedHashes };
}

// =============================================================================
// Main Functions
// =============================================================================

async function showStatus(): Promise<void> {
  console.log("TaskArchiver - Status");
  console.log("=====================");

  const config = loadConfig();
  console.log(`Server: ${config.serverIp}`);
  console.log("");

  const tasks = getTasks(config);
  const completeTasks = tasks.filter((t) => t.isComplete);
  const incompleteTasks = tasks.filter((t) => !t.isComplete);

  console.log(`Active tasks: ${tasks.length}`);
  console.log(`  Complete: ${completeTasks.length}`);
  console.log(`  In progress: ${incompleteTasks.length}`);
  console.log("");

  const stats = getStats(config);
  console.log(`Database stats:`);
  console.log(`  Total tasks: ${stats.totalTasks}`);
  console.log(`  Archived tasks: ${stats.archivedTasks}`);
  console.log(`  Total hashes: ${stats.totalHashes.toLocaleString()}`);
  console.log(`  Cracked hashes: ${stats.crackedHashes.toLocaleString()}`);

  if (completeTasks.length > 0) {
    console.log("");
    console.log("Complete tasks ready to archive:");
    for (const task of completeTasks.slice(0, 10)) {
      console.log(`  ${task.taskId}: ${task.taskName} (${task.crackedCount} cracked)`);
    }
    if (completeTasks.length > 10) {
      console.log(`  ... and ${completeTasks.length - 10} more`);
    }
  }
}

async function archiveCompleted(options: { deleteHashlists?: boolean; dryRun?: boolean }): Promise<ArchiveResult> {
  const { deleteHashlists: shouldDelete = false, dryRun = false } = options;

  console.log("TaskArchiver - Archive Completed Tasks");
  console.log("======================================");

  const config = loadConfig();
  console.log(`Server: ${config.serverIp}`);
  console.log(`Delete hashlists: ${shouldDelete}`);
  console.log(`Dry run: ${dryRun}`);
  console.log("");

  const tasks = getTasks(config);
  const completeTasks = tasks.filter((t) => t.isComplete);

  if (completeTasks.length === 0) {
    console.log("No completed tasks to archive.");
    return { tasksArchived: 0, hashlistsDeleted: 0, hashesDeleted: 0 };
  }

  console.log(`Found ${completeTasks.length} completed tasks to archive:`);
  for (const task of completeTasks.slice(0, 5)) {
    console.log(`  ${task.taskId}: ${task.taskName}`);
  }
  if (completeTasks.length > 5) {
    console.log(`  ... and ${completeTasks.length - 5} more`);
  }
  console.log("");

  if (dryRun) {
    console.log("DRY RUN - No changes made.");
    return { tasksArchived: completeTasks.length, hashlistsDeleted: 0, hashesDeleted: 0 };
  }

  // Archive tasks
  const taskIds = completeTasks.map((t) => t.taskId);
  const archived = archiveTasks(config, taskIds);
  console.log(`Archived ${archived} tasks.`);

  let hashlistsDeleted = 0;
  let hashesDeleted = 0;

  // Optionally delete hashlists
  if (shouldDelete) {
    console.log("");
    console.log("Deleting hashlists (WARNING: This is permanent!)...");

    const hashlistIds = completeTasks.map((t) => t.hashlistId);
    const deleteResult = deleteHashlists(config, hashlistIds);
    hashlistsDeleted = deleteResult.hashlistsDeleted;
    hashesDeleted = deleteResult.hashesDeleted;

    console.log(`  Deleted ${hashlistsDeleted} hashlists`);
    console.log(`  Deleted ${hashesDeleted.toLocaleString()} hashes`);
  }

  // Update local state
  const state = new StateManager(DATA_DIR);
  const pipelineState = state.load();

  // Remove archived task/hashlist IDs from state
  const archivedTaskIds = new Set(taskIds);
  const archivedHashlistIds = new Set(completeTasks.map((t) => t.hashlistId));

  pipelineState.crack.taskIds = pipelineState.crack.taskIds.filter((id) => !archivedTaskIds.has(id));
  pipelineState.crack.hashlistIds = pipelineState.crack.hashlistIds.filter((id) => !archivedHashlistIds.has(id));
  state.save();

  console.log("");
  console.log("Archive Complete");
  console.log("================");
  console.log(`Tasks archived: ${archived}`);
  if (shouldDelete) {
    console.log(`Hashlists deleted: ${hashlistsDeleted}`);
    console.log(`Hashes deleted: ${hashesDeleted.toLocaleString()}`);
  }

  return { tasksArchived: archived, hashlistsDeleted, hashesDeleted };
}

async function archiveAll(options: { deleteHashlists?: boolean; dryRun?: boolean }): Promise<ArchiveResult> {
  const { deleteHashlists: shouldDelete = false, dryRun = false } = options;

  console.log("TaskArchiver - Archive ALL Tasks");
  console.log("================================");
  console.log("WARNING: This archives ALL tasks, including incomplete ones!");
  console.log("");

  const config = loadConfig();
  const tasks = getTasks(config);

  if (tasks.length === 0) {
    console.log("No tasks to archive.");
    return { tasksArchived: 0, hashlistsDeleted: 0, hashesDeleted: 0 };
  }

  console.log(`Found ${tasks.length} tasks to archive.`);
  console.log("");

  if (dryRun) {
    console.log("DRY RUN - No changes made.");
    return { tasksArchived: tasks.length, hashlistsDeleted: 0, hashesDeleted: 0 };
  }

  // Archive all tasks
  const taskIds = tasks.map((t) => t.taskId);
  const archived = archiveTasks(config, taskIds);
  console.log(`Archived ${archived} tasks.`);

  let hashlistsDeleted = 0;
  let hashesDeleted = 0;

  if (shouldDelete) {
    const hashlistIds = tasks.map((t) => t.hashlistId);
    const deleteResult = deleteHashlists(config, hashlistIds);
    hashlistsDeleted = deleteResult.hashlistsDeleted;
    hashesDeleted = deleteResult.hashesDeleted;
    console.log(`Deleted ${hashlistsDeleted} hashlists, ${hashesDeleted.toLocaleString()} hashes`);
  }

  return { tasksArchived: archived, hashlistsDeleted, hashesDeleted };
}

// =============================================================================
// CLI
// =============================================================================

if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args[0] === "--help" || args[0] === "-h") {
    console.log(`
TaskArchiver - Archive completed Hashtopolis tasks

Archives completed tasks to declutter the Hashtopolis UI.
Optionally deletes hashlists to free database space.

Usage:
  bun TaskArchiver.ts                    Show status
  bun TaskArchiver.ts --archive          Archive completed tasks
  bun TaskArchiver.ts --archive-all      Archive ALL tasks (including incomplete)
  bun TaskArchiver.ts --delete           Also delete hashlists (permanent!)
  bun TaskArchiver.ts --dry-run          Show what would be archived

Options:
  --archive          Archive only completed tasks
  --archive-all      Archive all tasks (use with caution)
  --delete           Delete hashlists after archiving (frees DB space)
  --dry-run          Preview without making changes

Examples:
  bun TaskArchiver.ts                          # Show status
  bun TaskArchiver.ts --archive                # Archive completed tasks
  bun TaskArchiver.ts --archive --delete       # Archive and delete hashlists
  bun TaskArchiver.ts --archive --dry-run      # Preview archival

WARNING: --delete permanently removes cracked password data from Hashtopolis!
         Make sure you've run ResultCollector.ts first to save PEARLS.
`);
    process.exit(0);
  }

  // Parse arguments
  let archive = false;
  let archiveAll = false;
  let deleteHashlistsFlag = false;
  let dryRun = false;

  for (const arg of args) {
    switch (arg) {
      case "--archive":
        archive = true;
        break;
      case "--archive-all":
        archiveAll = true;
        break;
      case "--delete":
        deleteHashlistsFlag = true;
        break;
      case "--dry-run":
        dryRun = true;
        break;
    }
  }

  try {
    if (archiveAll) {
      await archiveAll({ deleteHashlists: deleteHashlistsFlag, dryRun });
    } else if (archive) {
      await archiveCompleted({ deleteHashlists: deleteHashlistsFlag, dryRun });
    } else {
      await showStatus();
    }
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
  }
}
