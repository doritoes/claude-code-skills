#!/usr/bin/env bun
/**
 * HashlistCoverageAnalyzer.ts - Analyze Coverage Across Multiple Tasks
 *
 * When multiple tasks work on the same hashlist (or related hashlists in a batch),
 * this tool determines if the combined keyspace coverage is complete across all tasks.
 *
 * Use cases:
 * - Tasks that were restarted/cloned and together cover the keyspace
 * - Multiple attack phases on the same hashlist
 * - Batch tasks where some completed and some didn't but together they're done
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CURRENT_FILE = fileURLToPath(import.meta.url);
const SKILL_DIR = dirname(dirname(CURRENT_FILE));
const HASHCRACK_DIR = resolve(SKILL_DIR, "..", "Hashcrack");

// =============================================================================
// Configuration
// =============================================================================

interface ServerConfig {
  serverIp: string;
  dbPassword: string;
  sshUser: string;
}

interface TaskInfo {
  taskId: number;
  taskName: string;
  hashlistId: number;
  keyspace: number;
  keyspaceProgress: number;
  cracked: number;
  isArchived: number;
}

interface ChunkInfo {
  chunkId: number;
  taskId: number;
  skip: number;
  length: number;
  state: number;
}

interface HashlistGroup {
  hashlistId: number;
  tasks: TaskInfo[];
  chunks: ChunkInfo[];
  totalKeyspace: number;
  combinedCoverage: number;
  coveragePercent: number;
  isComplete: boolean;
  activeChunks: number;
  abortedChunks: number;
  finishedChunks: number;
}

// =============================================================================
// Server Configuration
// =============================================================================

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
    return {
      serverIp: "16.146.72.52",
      dbPassword: "NJyf6IviJRC1jYQ0u57tRuCm",
      sshUser: "ubuntu"
    };
  }
}

function execSQL(config: ServerConfig, sql: string): string {
  const cleanSql = sql.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
  const b64Sql = Buffer.from(cleanSql).toString('base64');
  const cmd = `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 ${config.sshUser}@${config.serverIp} "echo ${b64Sql} | base64 -d | sudo docker exec -i hashtopolis-db mysql -u hashtopolis -p'${config.dbPassword}' hashtopolis -sN"`;
  try {
    return execSync(cmd, { encoding: "utf-8", timeout: 30000, shell: "bash" }).trim();
  } catch (e) {
    console.error("SQL error:", (e as Error).message);
    return "";
  }
}

// =============================================================================
// Analysis Functions
// =============================================================================

/**
 * Get task info for specific task IDs
 */
function getTasksById(config: ServerConfig, taskIds: number[]): TaskInfo[] {
  const idList = taskIds.join(',');
  // Use tw.isArchived - UI uses TaskWrapper.isArchived for filtering (Lesson #28)
  const result = execSQL(config, `
    SELECT t.taskId, t.taskName, tw.hashlistId, t.keyspace, t.keyspaceProgress, tw.cracked, tw.isArchived
    FROM Task t
    JOIN TaskWrapper tw ON t.taskWrapperId = tw.taskWrapperId
    WHERE t.taskId IN (${idList})
    ORDER BY t.taskId
  `);

  if (!result) return [];

  return result.split('\n').filter(Boolean).map(line => {
    const [taskId, taskName, hashlistId, keyspace, keyspaceProgress, cracked, isArchived] = line.split('\t');
    return {
      taskId: parseInt(taskId),
      taskName,
      hashlistId: parseInt(hashlistId),
      keyspace: parseInt(keyspace) || 0,
      keyspaceProgress: parseInt(keyspaceProgress) || 0,
      cracked: parseInt(cracked) || 0,
      isArchived: parseInt(isArchived) || 0
    };
  });
}

/**
 * Get all chunks for given task IDs
 */
function getChunksForTasks(config: ServerConfig, taskIds: number[]): ChunkInfo[] {
  const idList = taskIds.join(',');
  const result = execSQL(config, `
    SELECT chunkId, taskId, skip, length, state
    FROM Chunk
    WHERE taskId IN (${idList})
    ORDER BY taskId, skip
  `);

  if (!result) return [];

  return result.split('\n').filter(Boolean).map(line => {
    const [chunkId, taskId, skip, length, state] = line.split('\t');
    return {
      chunkId: parseInt(chunkId),
      taskId: parseInt(taskId),
      skip: parseInt(skip) || 0,
      length: parseInt(length) || 0,
      state: parseInt(state) || 0
    };
  });
}

/**
 * Calculate combined coverage from chunks (union of ranges)
 * Handles overlapping chunks by merging ranges
 */
function calculateCombinedCoverage(chunks: ChunkInfo[]): number {
  // Only count finished chunks (state 4) or trimmed (state 9)
  const finishedChunks = chunks.filter(c => c.state === 4 || c.state === 9);

  if (finishedChunks.length === 0) return 0;

  // Convert to ranges and sort
  const ranges = finishedChunks
    .map(c => ({ start: c.skip, end: c.skip + c.length }))
    .sort((a, b) => a.start - b.start);

  // Merge overlapping ranges
  const merged: { start: number; end: number }[] = [];
  for (const range of ranges) {
    if (merged.length === 0) {
      merged.push({ ...range });
    } else {
      const last = merged[merged.length - 1];
      if (range.start <= last.end) {
        // Overlapping - extend
        last.end = Math.max(last.end, range.end);
      } else {
        // Non-overlapping - add new
        merged.push({ ...range });
      }
    }
  }

  // Sum merged ranges
  return merged.reduce((sum, r) => sum + (r.end - r.start), 0);
}

/**
 * Group tasks by hashlist and analyze coverage
 */
function analyzeTaskGroups(config: ServerConfig, taskIds: number[]): HashlistGroup[] {
  const tasks = getTasksById(config, taskIds);
  const chunks = getChunksForTasks(config, taskIds);

  // Group by hashlistId
  const groups = new Map<number, HashlistGroup>();

  for (const task of tasks) {
    if (!groups.has(task.hashlistId)) {
      groups.set(task.hashlistId, {
        hashlistId: task.hashlistId,
        tasks: [],
        chunks: [],
        totalKeyspace: 0,
        combinedCoverage: 0,
        coveragePercent: 0,
        isComplete: false,
        activeChunks: 0,
        abortedChunks: 0,
        finishedChunks: 0
      });
    }
    groups.get(task.hashlistId)!.tasks.push(task);
  }

  // Add chunks to groups and calculate coverage
  for (const chunk of chunks) {
    const task = tasks.find(t => t.taskId === chunk.taskId);
    if (task && groups.has(task.hashlistId)) {
      groups.get(task.hashlistId)!.chunks.push(chunk);
    }
  }

  // Calculate coverage for each group
  for (const group of groups.values()) {
    // Use the max keyspace among tasks (they should be the same for same attack)
    group.totalKeyspace = Math.max(...group.tasks.map(t => t.keyspace));
    group.combinedCoverage = calculateCombinedCoverage(group.chunks);
    group.coveragePercent = group.totalKeyspace > 0
      ? Math.round((group.combinedCoverage / group.totalKeyspace) * 100)
      : 0;
    group.isComplete = group.combinedCoverage >= group.totalKeyspace && group.totalKeyspace > 0;

    // Count chunk states
    group.activeChunks = group.chunks.filter(c => c.state === 0 || c.state === 2).length;
    group.abortedChunks = group.chunks.filter(c => c.state === 6).length;
    group.finishedChunks = group.chunks.filter(c => c.state === 4 || c.state === 9).length;
  }

  return Array.from(groups.values());
}

/**
 * Archive tasks for a complete hashlist group
 */
function archiveGroup(config: ServerConfig, group: HashlistGroup, dryRun: boolean): void {
  for (const task of group.tasks) {
    if (task.isArchived) {
      console.log(`    Task ${task.taskId}: Already archived`);
      continue;
    }

    if (!dryRun) {
      execSQL(config, `
        UPDATE Task t
        JOIN TaskWrapper tw ON t.taskWrapperId = tw.taskWrapperId
        SET t.isArchived = 1, t.priority = 0, tw.isArchived = 1
        WHERE t.taskId = ${task.taskId}
      `);
      execSQL(config, `DELETE FROM Assignment WHERE taskId = ${task.taskId}`);
      console.log(`    Task ${task.taskId}: ✓ Archived`);
    } else {
      console.log(`    Task ${task.taskId}: (would archive)`);
    }
  }
}

// =============================================================================
// Display Functions
// =============================================================================

function displayGroup(group: HashlistGroup): void {
  const statusIcon = group.isComplete ? '\x1b[32m✓\x1b[0m' : '\x1b[33m⚠\x1b[0m';
  const coverageColor = group.isComplete ? '\x1b[32m' : '\x1b[33m';

  console.log(`\n┌─ Hashlist ${group.hashlistId} ─────────────────────────────────────────┐`);
  console.log(`│ ${statusIcon} Coverage: ${coverageColor}${group.combinedCoverage.toLocaleString()}/${group.totalKeyspace.toLocaleString()} (${group.coveragePercent}%)\x1b[0m`);
  console.log(`│   Chunks: ${group.finishedChunks} finished, ${group.activeChunks} active, ${group.abortedChunks} aborted`);
  console.log(`│   Tasks: ${group.tasks.length}`);

  for (const task of group.tasks) {
    const archived = task.isArchived ? ' [archived]' : '';
    const taskCoverage = task.keyspace > 0
      ? Math.round((task.keyspaceProgress / task.keyspace) * 100)
      : 0;
    console.log(`│     ${task.taskId}: ${task.taskName}${archived}`);
    console.log(`│         Keyspace: ${task.keyspaceProgress.toLocaleString()}/${task.keyspace.toLocaleString()} (${taskCoverage}%), Cracked: ${task.cracked.toLocaleString()}`);
  }

  console.log(`└${"─".repeat(60)}┘`);
}

// =============================================================================
// CLI
// =============================================================================

function printHelp(): void {
  console.log(`
HashlistCoverageAnalyzer - Analyze coverage across multiple tasks

Usage:
  bun HashlistCoverageAnalyzer.ts --tasks <id1,id2,...>  Analyze specific tasks
  bun HashlistCoverageAnalyzer.ts --batch <pattern>      Analyze batch by name pattern
  bun HashlistCoverageAnalyzer.ts --archive              Archive complete groups
  bun HashlistCoverageAnalyzer.ts --dry-run              Preview without changes

Description:
  When multiple tasks work on the same hashlist, this tool:
  1. Groups tasks by hashlistId
  2. Calculates combined chunk coverage (union of finished ranges)
  3. Determines if the combined coverage completes the keyspace
  4. Optionally archives all tasks in complete groups

Examples:
  bun HashlistCoverageAnalyzer.ts --tasks 1207,1208,1209,1210,1211,1212,1213,1214
  bun HashlistCoverageAnalyzer.ts --tasks 1207,1208 --archive --dry-run
  bun HashlistCoverageAnalyzer.ts --batch batch-0125 --archive
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h') || args.length === 0) {
    printHelp();
    return;
  }

  const config = getServerConfig();
  const dryRun = args.includes('--dry-run');
  const doArchive = args.includes('--archive');

  let taskIds: number[] = [];

  // Parse --tasks
  const tasksIndex = args.indexOf('--tasks');
  if (tasksIndex !== -1 && args[tasksIndex + 1]) {
    taskIds = args[tasksIndex + 1].split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id));
  }

  // Parse --batch
  const batchIndex = args.indexOf('--batch');
  if (batchIndex !== -1 && args[batchIndex + 1]) {
    const pattern = args[batchIndex + 1];
    const result = execSQL(config, `
      SELECT taskId FROM Task WHERE taskName LIKE '%${pattern}%' AND isArchived = 0
    `);
    if (result) {
      taskIds = result.split('\n').filter(Boolean).map(id => parseInt(id));
    }
  }

  if (taskIds.length === 0) {
    console.error('No tasks specified. Use --tasks or --batch.');
    process.exit(1);
  }

  // Title
  console.log(`\n╭${"─".repeat(60)}╮`);
  console.log(`│${" ".repeat(12)}HASHLIST COVERAGE ANALYZER${" ".repeat(22)}│`);
  console.log(`╰${"─".repeat(60)}╯`);
  console.log(`\nAnalyzing ${taskIds.length} tasks...`);

  // Analyze
  const groups = analyzeTaskGroups(config, taskIds);

  if (groups.length === 0) {
    console.log('No task groups found.');
    return;
  }

  // Display results
  let completeGroups = 0;
  let incompleteGroups = 0;

  for (const group of groups) {
    displayGroup(group);
    if (group.isComplete) {
      completeGroups++;
    } else {
      incompleteGroups++;
    }
  }

  // Summary
  console.log(`\n${"─".repeat(62)}`);
  console.log(`Summary: ${groups.length} hashlist groups | ${completeGroups} complete | ${incompleteGroups} incomplete`);

  // Archive if requested
  if (doArchive && completeGroups > 0) {
    console.log(`\n${dryRun ? '[DRY RUN] ' : ''}Archiving complete groups...`);

    for (const group of groups) {
      if (group.isComplete) {
        console.log(`\n  Hashlist ${group.hashlistId}:`);
        archiveGroup(config, group, dryRun);
      }
    }

    if (!dryRun) {
      console.log('\n✓ Archive complete.');
    } else {
      console.log('\n(Dry run - no changes made)');
    }
  } else if (doArchive && completeGroups === 0) {
    console.log('\nNo complete groups to archive.');
  }
}

main().catch(console.error);
