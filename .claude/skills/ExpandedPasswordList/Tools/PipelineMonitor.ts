#!/usr/bin/env bun
/**
 * PipelineMonitor.ts - Comprehensive Pipeline Health Monitor
 *
 * Consolidates all monitoring checks into a single tool to reduce manual intervention.
 * Runs all health checks and reports issues with recommended actions.
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

interface HealthCheck {
  name: string;
  status: "OK" | "WARNING" | "CRITICAL";
  message: string;
  action?: string;
  sql?: string;
}

interface PipelineStatus {
  agents: { alive: number; total: number; stale: string[] };
  chunks: { active: number; stuck: number[] };
  tasks: { pending: number; complete: number; stuck: string[] };
  pearls: number;
  issues: HealthCheck[];
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
    // Fallback to known values
    return {
      serverIp: "16.147.88.9",
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
// Health Checks
// =============================================================================

async function checkAgentHealth(config: ServerConfig): Promise<HealthCheck> {
  const result = execSQL(config, `
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN (UNIX_TIMESTAMP() - lastTime) < 60 THEN 1 ELSE 0 END) as alive,
      GROUP_CONCAT(CASE WHEN (UNIX_TIMESTAMP() - lastTime) >= 60 THEN agentName ELSE NULL END) as stale
    FROM Agent
  `);

  const [total, alive, stale] = result.split("\t");
  const aliveCount = parseInt(alive) || 0;
  const totalCount = parseInt(total) || 0;

  if (aliveCount === totalCount && totalCount > 0) {
    return { name: "Agent Health", status: "OK", message: `${aliveCount}/${totalCount} agents alive` };
  } else if (aliveCount > 0) {
    return {
      name: "Agent Health",
      status: "WARNING",
      message: `${aliveCount}/${totalCount} agents alive. Stale: ${stale || 'unknown'}`,
      action: "Reboot stale workers via AWS CLI"
    };
  } else {
    return {
      name: "Agent Health",
      status: "CRITICAL",
      message: "No agents responding",
      action: "Check if GPU VMs are running"
    };
  }
}

async function checkChunkProgress(config: ServerConfig): Promise<HealthCheck> {
  // Get active chunks
  const activeChunks = execSQL(config, `
    SELECT c.chunkId, c.progress, c.taskId, t.taskName
    FROM Chunk c
    JOIN Task t ON c.taskId = t.taskId
    WHERE c.state = 2
  `);

  if (!activeChunks) {
    return { name: "Chunk Progress", status: "WARNING", message: "No active chunks", action: "Check if work is queued" };
  }

  const chunks = activeChunks.split("\n").filter(Boolean);
  return {
    name: "Chunk Progress",
    status: "OK",
    message: `${chunks.length} active chunks`,
    action: "Run twice 20s apart to detect stuck chunks"
  };
}

async function checkChunkProgressAdvancing(config: ServerConfig): Promise<HealthCheck> {
  // First reading
  const reading1 = execSQL(config, `SELECT chunkId, progress FROM Chunk WHERE state=2`);

  if (!reading1) {
    return { name: "Chunk Advancement", status: "OK", message: "No active chunks to check" };
  }

  // Wait 20 seconds
  await new Promise(resolve => setTimeout(resolve, 20000));

  // Second reading
  const reading2 = execSQL(config, `SELECT chunkId, progress FROM Chunk WHERE state=2`);

  const parse = (data: string) => {
    const map = new Map<string, number>();
    data.split("\n").filter(Boolean).forEach(line => {
      const [id, progress] = line.split("\t");
      map.set(id, parseInt(progress) || 0);
    });
    return map;
  };

  const map1 = parse(reading1);
  const map2 = parse(reading2);

  const stuck: string[] = [];
  map1.forEach((progress, chunkId) => {
    if (map2.has(chunkId) && map2.get(chunkId) === progress) {
      stuck.push(chunkId);
    }
  });

  if (stuck.length === 0) {
    return { name: "Chunk Advancement", status: "OK", message: "All chunks progressing" };
  } else {
    return {
      name: "Chunk Advancement",
      status: "CRITICAL",
      message: `Stuck chunks: ${stuck.join(", ")}`,
      action: "Abort stuck chunks: UPDATE Chunk SET state=6, agentId=NULL WHERE chunkId IN (" + stuck.join(",") + ")",
      sql: `UPDATE Chunk SET state=6, agentId=NULL WHERE chunkId IN (${stuck.join(",")})`
    };
  }
}

async function checkPriorityAlignment(config: ServerConfig): Promise<HealthCheck> {
  const result = execSQL(config, `
    SELECT t.taskId, t.taskName, t.priority, tw.priority as wrapperPriority
    FROM Task t
    JOIN TaskWrapper tw ON t.taskWrapperId = tw.taskWrapperId
    WHERE t.isArchived = 0 AND t.priority != tw.priority
  `);

  if (!result) {
    return { name: "Priority Alignment", status: "OK", message: "Task and TaskWrapper priorities aligned" };
  }

  return {
    name: "Priority Alignment",
    status: "WARNING",
    message: "Priority mismatch found",
    action: "Sync priorities: UPDATE TaskWrapper tw JOIN Task t ON tw.taskWrapperId=t.taskWrapperId SET tw.priority=t.priority WHERE t.isArchived=0",
    sql: "UPDATE TaskWrapper tw JOIN Task t ON tw.taskWrapperId=t.taskWrapperId SET tw.priority=t.priority WHERE t.isArchived=0"
  };
}

async function checkTasksReadyToArchive(config: ServerConfig): Promise<HealthCheck> {
  // Find tasks that appear complete but may have issues
  const result = execSQL(config, `
    SELECT t.taskId, t.taskName,
      (SELECT COUNT(*) FROM Chunk c WHERE c.taskId=t.taskId AND c.state IN (0,2)) as active_chunks,
      (SELECT COUNT(*) FROM Chunk c WHERE c.taskId=t.taskId AND c.state=6) as aborted_chunks,
      (SELECT COUNT(*) FROM Chunk c WHERE c.taskId=t.taskId AND c.state=4) as finished_chunks
    FROM Task t
    WHERE t.isArchived = 0
    AND t.keyspaceProgress >= t.keyspace
    AND t.keyspace > 0
  `);

  if (!result) {
    return { name: "Archive Ready", status: "OK", message: "No tasks ready for archiving" };
  }

  const tasks = result.split("\n").filter(Boolean);
  const safeToArchive: string[] = [];
  const needsReview: string[] = [];

  for (const task of tasks) {
    const [taskId, taskName, active, aborted, finished] = task.split("\t");
    if (parseInt(active) === 0 && parseInt(aborted) === 0 && parseInt(finished) > 0) {
      safeToArchive.push(taskName);
    } else {
      needsReview.push(`${taskName} (active=${active}, aborted=${aborted})`);
    }
  }

  if (needsReview.length > 0) {
    return {
      name: "Archive Ready",
      status: "WARNING",
      message: `Tasks need review before archiving: ${needsReview.join(", ")}`,
      action: "Verify chunk states before archiving"
    };
  }

  if (safeToArchive.length > 0) {
    return {
      name: "Archive Ready",
      status: "OK",
      message: `Safe to archive: ${safeToArchive.join(", ")}`
    };
  }

  return { name: "Archive Ready", status: "OK", message: "No tasks ready for archiving" };
}

async function checkCracksPerTask(config: ServerConfig): Promise<HealthCheck> {
  // Check for tasks in same batch with significantly different crack counts
  const result = execSQL(config, `
    SELECT
      SUBSTRING_INDEX(t.taskName, '-part', 1) as batch,
      AVG(tw.cracked) as avg_cracked,
      MIN(tw.cracked) as min_cracked,
      MAX(tw.cracked) as max_cracked,
      COUNT(*) as task_count
    FROM Task t
    JOIN TaskWrapper tw ON t.taskWrapperId = tw.taskWrapperId
    WHERE t.isArchived = 0
    GROUP BY batch
    HAVING task_count > 1 AND (max_cracked - min_cracked) > avg_cracked * 0.5
  `);

  if (!result) {
    return { name: "Crack Distribution", status: "OK", message: "Crack counts consistent across batches" };
  }

  return {
    name: "Crack Distribution",
    status: "WARNING",
    message: "Some batches have uneven crack counts - may indicate incomplete work",
    action: "Review batch task completion status"
  };
}

async function checkUninitializedTasks(config: ServerConfig): Promise<HealthCheck> {
  // CRITICAL: Tasks with keyspace=0 cannot be assigned to workers
  // This causes GPU workers to sit idle - expensive waste of compute!
  const result = execSQL(config, `
    SELECT taskId, taskName
    FROM Task
    WHERE keyspace = 0 AND isArchived = 0
  `);

  if (!result) {
    return { name: "Task Initialization", status: "OK", message: "All tasks have valid keyspace" };
  }

  const uninitializedTasks = result.split("\n").filter(Boolean);
  const count = uninitializedTasks.length;

  return {
    name: "Task Initialization",
    status: "CRITICAL",
    message: `${count} tasks with keyspace=0 - GPU workers cannot get work!`,
    action: `Auto-fix: Set useNewBench=1 on ${count} tasks to trigger benchmark`,
    sql: "UPDATE Task SET useNewBench = 1 WHERE keyspace = 0 AND isArchived = 0"
  };
}

async function checkIdleAgents(config: ServerConfig): Promise<HealthCheck> {
  // Check for agents that are active but have no dispatched chunks
  // This indicates either all work is done, or tasks aren't initialized
  const result = execSQL(config, `
    SELECT a.agentId, a.agentName,
      TIMESTAMPDIFF(MINUTE, FROM_UNIXTIME(a.lastTime), NOW()) as minutes_idle
    FROM Agent a
    WHERE a.isActive = 1
      AND (UNIX_TIMESTAMP() - a.lastTime) > 120
      AND a.agentId NOT IN (SELECT DISTINCT agentId FROM Chunk WHERE state = 2 AND agentId IS NOT NULL)
  `);

  if (!result) {
    return { name: "Idle Agents", status: "OK", message: "No idle agents detected" };
  }

  const idleAgents = result.split("\n").filter(Boolean).map(line => {
    const [id, name, minutes] = line.split("\t");
    return `${name} (${minutes}min)`;
  });

  return {
    name: "Idle Agents",
    status: "WARNING",
    message: `Idle agents with no work: ${idleAgents.join(", ")}`,
    action: "Check for keyspace=0 tasks or restart stalled workers"
  };
}

async function getQuickStatus(config: ServerConfig): Promise<{ agents: number; chunks: number; pearls: number }> {
  const result = execSQL(config, `
    SELECT
      (SELECT COUNT(*) FROM Agent WHERE UNIX_TIMESTAMP() - lastTime < 60),
      (SELECT COUNT(*) FROM Chunk WHERE state=2),
      (SELECT COALESCE(SUM(isCracked), 0) FROM Hash)
  `);

  const [agents, chunks, pearls] = result.split("\t");
  return {
    agents: parseInt(agents) || 0,
    chunks: parseInt(chunks) || 0,
    pearls: parseInt(pearls) || 0
  };
}

// =============================================================================
// Main Monitor Function
// =============================================================================

async function runMonitor(options: { quick?: boolean; fix?: boolean; watch?: boolean } = {}): Promise<void> {
  console.log("╭─────────────────────────────────────────────────────────────╮");
  console.log("│        EXPANDEDPASSWORDLIST PIPELINE MONITOR                │");
  console.log("╰─────────────────────────────────────────────────────────────╯");
  console.log("");

  const config = getServerConfig();
  console.log(`Server: ${config.serverIp}`);
  console.log("");

  // Quick status
  const status = await getQuickStatus(config);
  console.log("┌─ QUICK STATUS ─────────────────────────────────────────────┐");
  console.log(`│ Agents: ${status.agents}/8    Chunks: ${status.chunks}    PEARLS: ${status.pearls.toLocaleString()}`);
  console.log("└────────────────────────────────────────────────────────────┘");
  console.log("");

  if (options.quick) {
    return;
  }

  console.log("┌─ HEALTH CHECKS ────────────────────────────────────────────┐");

  const checks: HealthCheck[] = [];

  // Run all checks
  checks.push(await checkAgentHealth(config));
  checks.push(await checkUninitializedTasks(config));  // CRITICAL: Detect keyspace=0 tasks
  checks.push(await checkIdleAgents(config));          // Detect idle workers
  checks.push(await checkPriorityAlignment(config));
  checks.push(await checkTasksReadyToArchive(config));
  checks.push(await checkCracksPerTask(config));

  // Only run chunk advancement check if not quick mode
  if (!options.quick && status.chunks > 0) {
    console.log("│ Checking chunk advancement (20 second wait)...             │");
    checks.push(await checkChunkProgressAdvancing(config));
  }

  // Display results
  for (const check of checks) {
    const icon = check.status === "OK" ? "✓" : check.status === "WARNING" ? "⚠" : "✗";
    const color = check.status === "OK" ? "\x1b[32m" : check.status === "WARNING" ? "\x1b[33m" : "\x1b[31m";
    console.log(`│ ${color}${icon}\x1b[0m ${check.name}: ${check.message}`);
    if (check.action) {
      console.log(`│   → ${check.action}`);
    }
  }

  console.log("└────────────────────────────────────────────────────────────┘");

  // Auto-fix mode
  if (options.fix) {
    const fixableIssues = checks.filter(c => c.sql && c.status !== "OK");
    if (fixableIssues.length > 0) {
      console.log("");
      console.log("┌─ AUTO-FIX ─────────────────────────────────────────────────┐");
      for (const issue of fixableIssues) {
        console.log(`│ Fixing: ${issue.name}`);
        if (issue.sql) {
          execSQL(config, issue.sql);
          console.log(`│ ✓ Applied fix`);
        }
      }
      console.log("└────────────────────────────────────────────────────────────┘");
    }
  }

  // Watch mode - AGGRESSIVE monitoring with auto-fix
  if (options.watch) {
    console.log("");
    console.log("┌─ AUTONOMOUS WATCH MODE ────────────────────────────────────┐");
    console.log("│ Checking every 90 seconds with AUTO-FIX enabled           │");
    console.log("│ Will alert on: idle agents, keyspace=0, stuck chunks      │");
    console.log("└────────────────────────────────────────────────────────────┘");
    console.log("Watching... (Ctrl+C to stop)\n");

    const runWatchCycle = async () => {
      const timestamp = new Date().toLocaleTimeString();
      const s = await getQuickStatus(config);

      // Check for idle agents (CRITICAL - expensive waste)
      const idleCheck = await checkIdleAgents(config);
      const uninitCheck = await checkUninitializedTasks(config);

      // Build status line
      let statusLine = `[${timestamp}] Agents: ${s.agents}/8 | Chunks: ${s.chunks} | PEARLS: ${s.pearls.toLocaleString()}`;

      // Alert on issues with ESCALATION PATH
      if (idleCheck.status !== "OK") {
        console.log(`\x1b[31m⚠️  ALERT: ${idleCheck.message}\x1b[0m`);
        console.log(`   ESCALATION PATH:`);
        console.log(`   1. Free stuck chunks: UPDATE Chunk SET state=6, agentId=NULL WHERE agentId=X AND state=2`);
        console.log(`   2. Restart agent service on worker VM`);
        console.log(`   3. Reboot worker EC2 instance`);
        console.log(`   4. Rebuild worker (terraform destroy/apply)`);
      }

      // Auto-fix keyspace=0 issues immediately
      if (uninitCheck.status !== "OK" && uninitCheck.sql) {
        console.log(`\x1b[33m⚡ AUTO-FIX: ${uninitCheck.message}\x1b[0m`);
        execSQL(config, uninitCheck.sql);
        console.log(`   ✓ Fixed uninitialized tasks`);
      }

      // Check agent count dropped
      if (s.agents < 8) {
        statusLine += ` \x1b[33m[${8 - s.agents} agents down]\x1b[0m`;
      }

      console.log(statusLine);
    };

    // Run immediately, then every 90 seconds
    await runWatchCycle();
    setInterval(runWatchCycle, 90000);
  }
}

// =============================================================================
// CLI
// =============================================================================

if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
PipelineMonitor - Comprehensive pipeline health monitoring

Usage:
  bun PipelineMonitor.ts              Run all health checks
  bun PipelineMonitor.ts --quick      Quick status only
  bun PipelineMonitor.ts --fix        Auto-fix simple issues
  bun PipelineMonitor.ts --watch      Continuous monitoring (60s interval)

Health Checks:
  - Agent health (alive/stale workers)
  - Chunk progress (active work)
  - Chunk advancement (detect stuck chunks - 20s wait)
  - Priority alignment (Task vs TaskWrapper)
  - Archive readiness (safe archiving validation)
  - Crack distribution (detect incomplete batches)
`);
    process.exit(0);
  }

  const options = {
    quick: args.includes("--quick"),
    fix: args.includes("--fix"),
    watch: args.includes("--watch")
  };

  try {
    await runMonitor(options);
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
  }
}
