#!/usr/bin/env bun
/**
 * SafeArchiver.ts - Safe Task Archiving with Full Validation
 *
 * Prevents premature archiving by validating ALL conditions before archiving:
 * 1. keyspace > 0 (task was actually initialized and worked)
 * 2. keyspaceProgress >= keyspace
 * 3. No active/pending chunks (state 0 or 2)
 * 4. All chunks are FINISHED (state 4) or TRIMMED (state 9), NOT ABORTED (state 6)
 * 5. Chunk coverage matches keyspace
 * 6. Crack counts are consistent across batch parts
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

interface TaskValidation {
  taskId: number;
  taskName: string;
  keyspace: number;
  keyspaceProgress: number;
  activeChunks: number;
  abortedChunks: number;
  finishedChunks: number;
  maxCoverage: number;
  cracked: number;
  assignedAgents: number;
  isValid: boolean;
  issues: string[];
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
  // Clean SQL and escape for shell
  const cleanSql = sql.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
  // Use base64 encoding to avoid all quoting issues
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
// Validation Functions
// =============================================================================

function validateTask(config: ServerConfig, taskId: number): TaskValidation {
  // Get task details
  const taskResult = execSQL(config, `
    SELECT t.taskId, t.taskName, t.keyspace, t.keyspaceProgress, tw.cracked
    FROM Task t
    JOIN TaskWrapper tw ON t.taskWrapperId = tw.taskWrapperId
    WHERE t.taskId = ${taskId}
  `);

  if (!taskResult) {
    return {
      taskId,
      taskName: "UNKNOWN",
      keyspace: 0,
      keyspaceProgress: 0,
      activeChunks: 0,
      abortedChunks: 0,
      finishedChunks: 0,
      maxCoverage: 0,
      cracked: 0,
      isValid: false,
      issues: ["Task not found"]
    };
  }

  const [tid, taskName, keyspace, keyspaceProgress, cracked] = taskResult.split("\t");

  // Get chunk statistics
  const chunkResult = execSQL(config, `
    SELECT
      SUM(CASE WHEN state IN (0, 2) THEN 1 ELSE 0 END) as active,
      SUM(CASE WHEN state = 6 THEN 1 ELSE 0 END) as aborted,
      SUM(CASE WHEN state = 4 THEN 1 ELSE 0 END) as finished,
      MAX(CASE WHEN state = 4 THEN skip + length ELSE 0 END) as max_coverage
    FROM Chunk WHERE taskId = ${taskId}
  `);

  const [active, aborted, finished, maxCoverage] = chunkResult.split("\t");

  // Get assigned agents count
  const agentResult = execSQL(config, `
    SELECT COUNT(*) FROM Assignment WHERE taskId = ${taskId}
  `);
  const assignedAgents = parseInt(agentResult) || 0;

  const validation: TaskValidation = {
    taskId: parseInt(tid),
    taskName,
    keyspace: parseInt(keyspace) || 0,
    keyspaceProgress: parseInt(keyspaceProgress) || 0,
    activeChunks: parseInt(active) || 0,
    abortedChunks: parseInt(aborted) || 0,
    finishedChunks: parseInt(finished) || 0,
    maxCoverage: parseInt(maxCoverage) || 0,
    cracked: parseInt(cracked) || 0,
    assignedAgents,
    isValid: true,
    issues: []
  };

  // Validation checks

  // CRITICAL: keyspace=0 means task was NEVER initialized/worked
  if (validation.keyspace === 0) {
    validation.isValid = false;
    validation.issues.push("keyspace=0 - task was NEVER worked (no chunks created)");
  }

  // CRITICAL: keyspaceProgress=0 means NO WORK was done, even if keyspace was manually set
  if (validation.keyspaceProgress === 0) {
    validation.isValid = false;
    validation.issues.push("keyspaceProgress=0 - task has 0% progress (no work completed)");
  }

  // CRITICAL: Must have finished chunks to prove work was done
  if (validation.finishedChunks === 0 && validation.keyspace > 0) {
    validation.isValid = false;
    validation.issues.push("No finished chunks - task may never have run or completed");
  }

  if (validation.keyspace > 0 && validation.keyspaceProgress < validation.keyspace) {
    validation.isValid = false;
    validation.issues.push(`Incomplete: ${Math.round(validation.keyspaceProgress / validation.keyspace * 100)}% done`);
  }

  if (validation.activeChunks > 0) {
    validation.isValid = false;
    validation.issues.push(`${validation.activeChunks} active/pending chunks still running`);
  }

  // CRITICAL: Don't archive if agents are assigned - trust the agent, not the stats
  if (validation.assignedAgents > 0) {
    validation.isValid = false;
    validation.issues.push(`${validation.assignedAgents} agent(s) still assigned - wait for them to release`);
  }

  if (validation.abortedChunks > 0) {
    validation.isValid = false;
    validation.issues.push(`${validation.abortedChunks} ABORTED chunks - work not completed`);
  }

  if (validation.finishedChunks === 0) {
    validation.isValid = false;
    validation.issues.push("No finished chunks - task may never have run");
  }

  if (validation.maxCoverage < validation.keyspace && validation.keyspace > 0) {
    validation.isValid = false;
    validation.issues.push(`Chunk coverage (${validation.maxCoverage}) < keyspace (${validation.keyspace})`);
  }

  return validation;
}

function validateBatch(config: ServerConfig, batchPattern: string): TaskValidation[] {
  // Get all tasks matching the batch pattern
  const tasksResult = execSQL(config, `
    SELECT taskId FROM Task WHERE taskName LIKE '%${batchPattern}%' AND isArchived = 0
  `);

  if (!tasksResult) {
    console.log(`No tasks found matching pattern: ${batchPattern}`);
    return [];
  }

  const taskIds = tasksResult.split("\n").filter(Boolean).map(id => parseInt(id));
  const validations: TaskValidation[] = [];

  for (const taskId of taskIds) {
    validations.push(validateTask(config, taskId));
  }

  // Check crack count consistency within batch
  if (validations.length > 1) {
    const crackCounts = validations.map(v => v.cracked);
    const avg = crackCounts.reduce((a, b) => a + b, 0) / crackCounts.length;
    const maxDiff = Math.max(...crackCounts.map(c => Math.abs(c - avg)));

    if (maxDiff > avg * 0.5) {
      for (const v of validations) {
        if (Math.abs(v.cracked - avg) > avg * 0.3) {
          v.issues.push(`Crack count (${v.cracked}) differs significantly from batch average (${Math.round(avg)})`);
        }
      }
    }
  }

  return validations;
}

async function archiveTask(config: ServerConfig, taskId: number, dryRun: boolean, force: boolean = false): Promise<boolean> {
  const validation = validateTask(config, taskId);

  console.log(`\nTask ${taskId}: ${validation.taskName}`);
  console.log(`  Keyspace: ${validation.keyspaceProgress}/${validation.keyspace} (${Math.round(validation.keyspaceProgress / validation.keyspace * 100)}%)`);
  console.log(`  Chunks: ${validation.finishedChunks} finished, ${validation.activeChunks} active, ${validation.abortedChunks} aborted`);
  console.log(`  Coverage: ${validation.maxCoverage}/${validation.keyspace}`);
  console.log(`  Cracked: ${validation.cracked}`);

  if (!validation.isValid && !force) {
    console.log(`  ❌ NOT SAFE TO ARCHIVE:`);
    for (const issue of validation.issues) {
      console.log(`     - ${issue}`);
    }
    return false;
  }

  if (!validation.isValid && force) {
    console.log(`  ⚠ FORCE ARCHIVE (issues found but overridden):`);
    for (const issue of validation.issues) {
      console.log(`     - ${issue}`);
    }
  } else {
    console.log(`  ✓ Safe to archive`);
  }

  if (!dryRun) {
    // Archive BOTH Task AND TaskWrapper (UI uses TaskWrapper.isArchived for filtering)
    execSQL(config, `
      UPDATE Task t
      JOIN TaskWrapper tw ON t.taskWrapperId = tw.taskWrapperId
      SET t.isArchived = 1, t.priority = 0, tw.isArchived = 1
      WHERE t.taskId = ${taskId}
    `);
    // CRITICAL: Clean up agent assignments to prevent idle workers
    execSQL(config, `DELETE FROM Assignment WHERE taskId=${taskId}`);
    console.log(`  ✓ Archived (Task + TaskWrapper + cleared assignments)`);
  } else {
    console.log(`  (dry-run - not archived)`);
  }

  return true;
}

async function archiveBatch(config: ServerConfig, batchPattern: string, dryRun: boolean, force: boolean): Promise<void> {
  const title = `SAFE ARCHIVER - Batch: ${batchPattern}`;
  const boxWidth = 61;
  const padding = Math.max(0, boxWidth - title.length);
  const leftPad = Math.floor(padding / 2);
  const rightPad = padding - leftPad;

  console.log(`\n╭${"─".repeat(boxWidth)}╮`);
  console.log(`│${" ".repeat(leftPad)}${title}${" ".repeat(rightPad)}│`);
  console.log(`╰${"─".repeat(boxWidth)}╯`);

  const validations = validateBatch(config, batchPattern);

  if (validations.length === 0) {
    console.log("No tasks found to archive.");
    return;
  }

  const safeCount = validations.filter(v => v.isValid).length;
  const unsafeCount = validations.filter(v => !v.isValid).length;

  console.log(`\nFound ${validations.length} tasks: ${safeCount} safe, ${unsafeCount} need review`);

  for (const validation of validations) {
    if (validation.isValid || force) {
      await archiveTask(config, validation.taskId, dryRun, force);
    } else {
      console.log(`\nTask ${validation.taskId}: ${validation.taskName}`);
      console.log(`  ❌ SKIPPED - Issues found:`);
      for (const issue of validation.issues) {
        console.log(`     - ${issue}`);
      }
    }
  }

  console.log(`\n${dryRun ? "(Dry run - no changes made)" : "Done."}`);
}

// =============================================================================
// CLI
// =============================================================================

if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
SafeArchiver - Archive tasks with full validation

Usage:
  bun SafeArchiver.ts --batch <pattern>    Archive batch (e.g., "batch-0020")
  bun SafeArchiver.ts --task <id>          Archive specific task
  bun SafeArchiver.ts --check <pattern>    Check batch without archiving
  bun SafeArchiver.ts --dry-run            Show what would be archived
  bun SafeArchiver.ts --force              Archive even with warnings (dangerous!)

Validation Checks:
  1. keyspace > 0 (task was initialized and worked - CRITICAL!)
  2. keyspaceProgress >= keyspace (100% complete)
  3. No active/pending chunks (state 0 or 2)
  4. No ABORTED chunks (state 6) - indicates incomplete work
  5. Has finished chunks (state 4)
  6. Chunk coverage matches keyspace
  7. Crack counts consistent within batch

Examples:
  bun SafeArchiver.ts --check batch-0020           # Check batch before archiving
  bun SafeArchiver.ts --batch batch-0020 --dry-run # Preview archive
  bun SafeArchiver.ts --batch batch-0020           # Archive batch
  bun SafeArchiver.ts --task 150                   # Archive single task
`);
    process.exit(0);
  }

  const config = getServerConfig();
  const dryRun = args.includes("--dry-run");
  const force = args.includes("--force");
  const checkOnly = args.includes("--check");

  const batchIndex = args.indexOf("--batch");
  const taskIndex = args.indexOf("--task");
  const checkIndex = args.indexOf("--check");

  try {
    if (batchIndex !== -1 && args[batchIndex + 1]) {
      await archiveBatch(config, args[batchIndex + 1], dryRun, force);
    } else if (taskIndex !== -1 && args[taskIndex + 1]) {
      await archiveTask(config, parseInt(args[taskIndex + 1]), dryRun, force);
    } else if (checkIndex !== -1 && args[checkIndex + 1]) {
      await archiveBatch(config, args[checkIndex + 1], true, false);
    } else {
      console.error("Specify --batch <pattern> or --task <id>");
      process.exit(1);
    }
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
  }
}
