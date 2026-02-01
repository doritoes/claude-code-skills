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
import { existsSync, readFileSync } from "node:fs";

const CURRENT_FILE = fileURLToPath(import.meta.url);
const SKILL_DIR = dirname(dirname(CURRENT_FILE));
const HASHCRACK_DIR = resolve(SKILL_DIR, "..", "Hashcrack");
const CLAUDE_DIR = resolve(SKILL_DIR, "..", "..");  // .claude directory
const ENV_FILE = resolve(CLAUDE_DIR, ".env");

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

/**
 * Load environment variables from .claude/.env file
 */
function loadEnvFile(): Record<string, string> {
  const env: Record<string, string> = {};
  if (existsSync(ENV_FILE)) {
    const content = readFileSync(ENV_FILE, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const [key, ...valueParts] = trimmed.split('=');
        if (key && valueParts.length > 0) {
          env[key.trim()] = valueParts.join('=').trim();
        }
      }
    }
  }
  return env;
}

function getServerConfig(): ServerConfig {
  // Priority 1: Read from .claude/.env file (source of truth)
  const env = loadEnvFile();

  if (env.HASHCRACK_SERVER_URL && env.HASHCRACK_DB_PASSWORD) {
    // Extract IP from URL like "http://54.188.7.212:8080"
    const urlMatch = env.HASHCRACK_SERVER_URL.match(/https?:\/\/([^:\/]+)/);
    if (urlMatch) {
      return {
        serverIp: urlMatch[1],
        dbPassword: env.HASHCRACK_DB_PASSWORD,
        sshUser: "ubuntu"
      };
    }
  }

  // Priority 2: Try terraform outputs
  const terraformDir = resolve(HASHCRACK_DIR, "terraform", "aws");
  try {
    const serverIp = execSync(`terraform output -raw server_ip`, {
      encoding: "utf-8",
      cwd: terraformDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000
    }).trim();
    const dbPassword = execSync(`terraform output -raw db_password`, {
      encoding: "utf-8",
      cwd: terraformDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000
    }).trim();
    if (serverIp && dbPassword) {
      return { serverIp, dbPassword, sshUser: "ubuntu" };
    }
  } catch (e) {
    // Terraform failed, continue to error
  }

  // Priority 3: FAIL with clear error - never hardcode IPs
  console.error("\x1b[31mERROR: Cannot determine server IP!\x1b[0m");
  console.error("Options to fix:");
  console.error("  1. Update HASHCRACK_SERVER_URL in .claude/.env");
  console.error("  2. Run: cd .claude/skills/Hashcrack/terraform/aws && terraform refresh");
  console.error("");
  console.error("After server reboot, update .env with:");
  console.error("  HASHCRACK_SERVER_URL=http://<NEW_IP>:8080");
  throw new Error("Server IP not configured. See error message above.");
}

function execSQL(config: ServerConfig, sql: string): string {
  // Clean SQL and collapse whitespace
  const cleanSql = sql.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();

  // Use base64 encoding through a bash heredoc-like approach that works on Windows
  // SSH to server, decode base64, pipe to mysql
  const b64Sql = Buffer.from(cleanSql).toString('base64');

  // Build command that works across platforms
  const sshCmd = `echo '${b64Sql}' | base64 -d | sudo docker exec -i hashtopolis-db mysql -u hashtopolis -p'${config.dbPassword}' hashtopolis -sN`;
  const cmd = `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=15 ${config.sshUser}@${config.serverIp} "${sshCmd}"`;

  try {
    // Use longer timeout (60s)
    const result = execSync(cmd, { encoding: "utf-8", timeout: 60000 });
    return result.trim();
  } catch (e: any) {
    const errMsg = e.message || String(e);
    const stdout = e.stdout ? e.stdout.toString().trim() : "";
    // Return stdout if available (some errors still produce output)
    if (stdout) return stdout;
    // Only log actual errors, not empty results
    if (!errMsg.includes("ETIMEDOUT") && !errMsg.includes("Command failed") && !errMsg.includes("returned code 1")) {
      console.error("SQL error:", errMsg.substring(0, 100));
    }
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

/**
 * Check for chunks dispatched >15 minutes - these are candidates for stuck detection.
 * Per user requirement: detect within 15 minutes, resolve within 5 minutes after.
 *
 * Detection logic:
 * 1. Find chunks dispatched >15 minutes
 * 2. For those chunks, check if progress is advancing (20s window)
 * 3. If progress unchanged in 20s AND chunk is >15 min old, flag as STUCK
 * 4. Auto-abort stuck chunks when --fix is enabled
 */
async function checkLongRunningChunks(config: ServerConfig): Promise<HealthCheck> {
  // Find chunks dispatched >15 minutes (900 seconds)
  const longRunning = execSQL(config, `
    SELECT c.chunkId, c.taskId, c.progress, c.agentId,
      TIMESTAMPDIFF(MINUTE, FROM_UNIXTIME(c.dispatchTime), NOW()) as minutes_dispatched,
      t.taskName, a.agentName
    FROM Chunk c
    JOIN Task t ON c.taskId = t.taskId
    LEFT JOIN Agent a ON c.agentId = a.agentId
    WHERE c.state = 2
      AND c.dispatchTime > 0
      AND TIMESTAMPDIFF(MINUTE, FROM_UNIXTIME(c.dispatchTime), NOW()) >= 15
    ORDER BY minutes_dispatched DESC
  `);

  if (!longRunning) {
    return { name: "Long-Running Chunks (>15min)", status: "OK", message: "No chunks running >15 minutes" };
  }

  const chunks = longRunning.split("\n").filter(Boolean).map(line => {
    const parts = line.split("\t");
    return {
      chunkId: parts[0],
      taskId: parts[1],
      progress: parseFloat(parts[2]) || 0,
      agentId: parts[3],
      minutes: parseInt(parts[4]) || 0,
      taskName: parts[5],
      agentName: parts[6] || 'unknown'
    };
  });

  // Now check if these long-running chunks are actually progressing
  // Take first reading
  const progressMap1 = new Map<string, number>();
  chunks.forEach(c => progressMap1.set(c.chunkId, c.progress));

  // Wait 20 seconds
  console.log("│ Checking long-running chunk progress (20s wait)...         │");
  await new Promise(resolve => setTimeout(resolve, 20000));

  // Second reading
  const reading2 = execSQL(config, `
    SELECT chunkId, progress FROM Chunk
    WHERE chunkId IN (${chunks.map(c => c.chunkId).join(",")}) AND state = 2
  `);

  const progressMap2 = new Map<string, number>();
  if (reading2) {
    reading2.split("\n").filter(Boolean).forEach(line => {
      const [id, progress] = line.split("\t");
      progressMap2.set(id, parseFloat(progress) || 0);
    });
  }

  // Identify truly stuck chunks (no progress in 20s AND >15 min old)
  const stuckChunks = chunks.filter(c => {
    const progress1 = progressMap1.get(c.chunkId) || 0;
    const progress2 = progressMap2.get(c.chunkId) || 0;
    // Chunk is stuck if it exists in both readings with same progress
    return progressMap2.has(c.chunkId) && progress1 === progress2;
  });

  const progressingChunks = chunks.filter(c => {
    const progress1 = progressMap1.get(c.chunkId) || 0;
    const progress2 = progressMap2.get(c.chunkId) || 0;
    return progressMap2.has(c.chunkId) && progress2 > progress1;
  });

  if (stuckChunks.length === 0) {
    if (progressingChunks.length > 0) {
      return {
        name: "Long-Running Chunks (>15min)",
        status: "OK",
        message: `${progressingChunks.length} chunks running >15min but progressing normally`
      };
    }
    return { name: "Long-Running Chunks (>15min)", status: "OK", message: "No stuck chunks detected" };
  }

  // Build detailed message about stuck chunks
  const stuckDetails = stuckChunks.map(c =>
    `chunk ${c.chunkId} on ${c.agentName} (${c.minutes}min, ${c.progress.toFixed(1)}%)`
  ).join(", ");

  const chunkIds = stuckChunks.map(c => c.chunkId);

  return {
    name: "Long-Running Chunks (>15min)",
    status: "CRITICAL",
    message: `${stuckChunks.length} STUCK chunks (>15min, no progress): ${stuckDetails}`,
    action: `AUTO-ABORT: UPDATE Chunk SET state=6, agentId=NULL WHERE chunkId IN (${chunkIds.join(",")})`,
    sql: `UPDATE Chunk SET state=6, agentId=NULL WHERE chunkId IN (${chunkIds.join(",")})`
  };
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
  //
  // Per Lesson #16: Tasks are created with keyspace=0, useNewBench=1
  // Agents benchmark on pickup → determines keyspace → creates chunks
  // ONLY set useNewBench=1 on tasks where useNewBench=0 (prevents benchmark)

  // First, count ALL keyspace=0 tasks
  const allUninitialized = execSQL(config, `
    SELECT COUNT(*) FROM Task WHERE keyspace = 0 AND isArchived = 0
  `);
  const totalCount = parseInt(allUninitialized) || 0;

  if (totalCount === 0) {
    return { name: "Task Initialization", status: "OK", message: "All tasks have valid keyspace" };
  }

  // Per Lesson #16: Only tasks with useNewBench=0 can be fixed by setting useNewBench=1
  const fixableResult = execSQL(config, `
    SELECT taskId, taskName
    FROM Task
    WHERE keyspace = 0 AND useNewBench = 0 AND isArchived = 0
  `);

  const fixableTasks = fixableResult ? fixableResult.split("\n").filter(Boolean) : [];
  const fixableCount = fixableTasks.length;

  if (fixableCount > 0) {
    // There ARE tasks we can fix by setting useNewBench=1
    return {
      name: "Task Initialization",
      status: "CRITICAL",
      message: `${totalCount} tasks with keyspace=0 (${fixableCount} fixable with useNewBench=1)`,
      action: `Auto-fix: Set useNewBench=1 on ${fixableCount} tasks to trigger benchmark`,
      sql: "UPDATE Task SET useNewBench = 1 WHERE keyspace = 0 AND useNewBench = 0 AND isArchived = 0"
    };
  } else {
    // Tasks already have useNewBench=1 but still stuck - different problem!
    // Per Lesson #16: If useNewBench=1 but keyspace=0, agents aren't picking up tasks
    // Possible causes: no agents, files not accessible (isSecret), priority too low
    return {
      name: "Task Initialization",
      status: "WARNING",
      message: `${totalCount} tasks with keyspace=0 but useNewBench=1 (agents not benchmarking - check files/priority/agents)`,
      action: "Investigate: Are files accessible (isSecret=1)? Are agents idle? Is priority > 0?"
      // No SQL fix - this requires investigation, not blind UPDATE
    };
  }
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

  // Only run chunk checks if not quick mode and there are active chunks
  if (!options.quick && status.chunks > 0) {
    // First check for long-running chunks (>15 min) - this is the primary stuck detection
    console.log("│ Checking for long-running chunks (>15 min)...              │");
    const longRunningCheck = await checkLongRunningChunks(config);
    checks.push(longRunningCheck);

    // Only run general chunk advancement if no long-running chunks found
    // This avoids double-waiting 20s
    if (longRunningCheck.status === "OK" && !longRunningCheck.message.includes("progressing")) {
      console.log("│ Checking chunk advancement (20 second wait)...             │");
      checks.push(await checkChunkProgressAdvancing(config));
    }
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

      // Check for long-running stuck chunks and AUTO-ABORT (per user requirement)
      if (s.chunks > 0) {
        const longRunningCheck = await checkLongRunningChunks(config);
        if (longRunningCheck.status === "CRITICAL" && longRunningCheck.sql) {
          console.log(`\x1b[31m🔥 STUCK CHUNKS DETECTED: ${longRunningCheck.message}\x1b[0m`);
          console.log(`   ⚡ AUTO-ABORTING stuck chunks...`);
          execSQL(config, longRunningCheck.sql);
          console.log(`   ✓ Aborted stuck chunks (agents may crash - per Lesson #13)`);
        }
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
  bun PipelineMonitor.ts --fix        Auto-fix issues (keyspace=0, stuck chunks)
  bun PipelineMonitor.ts --watch      Continuous monitoring (90s interval) with AUTO-FIX

Health Checks:
  - Agent health (alive/stale workers)
  - Task initialization (keyspace=0 detection - auto-fixable)
  - Idle agents (workers with no work assigned)
  - Long-running chunks (>15min detection - auto-abortable)
  - Chunk advancement (detect stuck chunks - 20s wait)
  - Priority alignment (Task vs TaskWrapper)
  - Archive readiness (safe archiving validation)
  - Crack distribution (detect incomplete batches)

Stuck Chunk Detection (per user requirement):
  - Detect chunks running >15 minutes with no progress
  - Auto-abort stuck chunks in --fix and --watch modes
  - Resolution within 5 minutes of detection
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
