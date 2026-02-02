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
    // Per Golden Rule #1 and Lesson #21: Do NOT auto-abort chunks
    return {
      name: "Chunk Advancement",
      status: "CRITICAL",
      message: `Stuck chunks: ${stuck.join(", ")}`,
      action: "MANUAL: Archive task + recreate, OR use Hashtopolis UI, OR wait for agent timeout"
      // NO sql field - per Golden Rule #1: "NEVER Manipulate Database Directly"
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
  // NOTE: Hashtopolis progress is centipercent (0-10000 = 0-100%), divide by 100 for display
  const stuckDetails = stuckChunks.map(c =>
    `chunk ${c.chunkId} on ${c.agentName} (${c.minutes}min, ${(c.progress/100).toFixed(1)}%)`
  ).join(", ");

  // Per Golden Rule #1 and Lesson #21: Do NOT auto-abort chunks
  // Direct chunk manipulation causes stuck tasks and data corruption
  return {
    name: "Long-Running Chunks (>15min)",
    status: "CRITICAL",
    message: `${stuckChunks.length} STUCK chunks (>15min, no progress): ${stuckDetails}`,
    action: "MANUAL: Archive task + recreate, OR use Hashtopolis UI, OR wait for agent timeout"
    // NO sql field - per Golden Rule #1: "NEVER Manipulate Database Directly"
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
  // Per Lesson #46: Agents use OLD benchmark format ("74240:5460.54")
  // Tasks MUST have useNewBench=0 to match agent format
  // If keyspace=0 and useNewBench=0, agents should benchmark normally
  // If keyspace=0 and useNewBench=1, there's a FORMAT MISMATCH - fix to 0

  // First, count ALL keyspace=0 tasks
  const allUninitialized = execSQL(config, `
    SELECT COUNT(*) FROM Task WHERE keyspace = 0 AND isArchived = 0
  `);
  const totalCount = parseInt(allUninitialized) || 0;

  if (totalCount === 0) {
    return { name: "Task Initialization", status: "OK", message: "All tasks have valid keyspace" };
  }

  // Check for tasks with WRONG benchmark format (useNewBench=1 should be 0)
  const wrongFormatResult = execSQL(config, `
    SELECT taskId, taskName
    FROM Task
    WHERE keyspace = 0 AND useNewBench = 1 AND isArchived = 0
  `);

  const wrongFormatTasks = wrongFormatResult ? wrongFormatResult.split("\n").filter(Boolean) : [];
  const wrongFormatCount = wrongFormatTasks.length;

  if (wrongFormatCount > 0) {
    // Tasks have wrong benchmark format - fix to useNewBench=0
    return {
      name: "Task Initialization",
      status: "CRITICAL",
      message: `${wrongFormatCount} tasks with keyspace=0 AND wrong format (useNewBench=1, should be 0)`,
      action: `Auto-fix: Set useNewBench=0 to match agent benchmark format`,
      sql: "UPDATE Task SET useNewBench = 0 WHERE keyspace = 0 AND useNewBench = 1 AND isArchived = 0"
    };
  } else {
    // Tasks have correct format (useNewBench=0) but still keyspace=0
    // This means agents aren't benchmarking - check agents, files, assignments
    return {
      name: "Task Initialization",
      status: "WARNING",
      message: `${totalCount} tasks with keyspace=0 (correct format but not benchmarked)`,
      action: "Investigate: Are agents alive? Files accessible (isSecret=1)? Assignments exist?"
      // No SQL fix - this requires investigation
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

interface QuickStatus {
  agents: number;
  chunks: number;
  pearls: number;
  queryFailed: boolean;  // True if SQL query failed/timed out
}

async function getQuickStatus(config: ServerConfig): Promise<QuickStatus> {
  // IMPORTANT: Use TaskWrapper.cracked instead of SUM(isCracked) FROM Hash
  // The Hash table has millions of rows - scanning it causes timeouts
  // TaskWrapper already has aggregated crack counts per task (Lesson #41)
  const result = execSQL(config, `
    SELECT
      (SELECT COUNT(*) FROM Agent WHERE UNIX_TIMESTAMP() - lastTime < 60),
      (SELECT COUNT(*) FROM Chunk WHERE state=2),
      (SELECT COALESCE(SUM(cracked), 0) FROM TaskWrapper)
  `);

  // CRITICAL: Detect query failures (Lesson #42)
  // Empty result means query failed - don't silently return 0s
  if (!result || !result.includes("\t")) {
    return { agents: -1, chunks: -1, pearls: -1, queryFailed: true };
  }

  const [agents, chunks, pearls] = result.split("\t");
  return {
    agents: parseInt(agents) || 0,
    chunks: parseInt(chunks) || 0,
    pearls: parseInt(pearls) || 0,
    queryFailed: false
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
  if (status.queryFailed) {
    console.log("│ \x1b[31m⚠ QUERY FAILED - Cannot get status (check server connection)\x1b[0m");
    console.log("│ SSH or MySQL may be unresponsive. Check server health.");
  } else {
    console.log(`│ Agents: ${status.agents}/8    Chunks: ${status.chunks}    PEARLS: ${status.pearls.toLocaleString()}`);
  }
  console.log("└────────────────────────────────────────────────────────────┘");
  console.log("");

  // Abort early if queries are failing
  if (status.queryFailed && !options.watch) {
    console.log("\x1b[31mCannot run health checks - server queries failing.\x1b[0m");
    console.log("Try: ssh ubuntu@" + config.serverIp + " 'sudo docker ps'");
    return;
  }

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

  // Watch mode - Health monitoring per Golden Rule #5 (30s intervals)
  // NOTE: Watch mode does NOT auto-abort chunks (per Golden Rule #1, Lesson #21)
  // NOTE: Watch mode does NOT add batches (per Lesson #39) - monitor queue separately
  if (options.watch) {
    console.log("");
    console.log("┌─ WATCH MODE (30s interval per Golden Rule #5) ────────────┐");
    console.log("│ Monitors: agents, chunks, queue depth, stuck detection    │");
    console.log("│ Auto-fixes: useNewBench=0 for format-mismatch tasks ONLY  │");
    console.log("│ NO auto-abort: Per Golden Rule #1, Lesson #21             │");
    console.log("│ NO batch submission: Per Lesson #39 (monitor queue only)  │");
    console.log("└────────────────────────────────────────────────────────────┘");
    console.log("Watching... (Ctrl+C to stop)\n");

    let lastQueueWarning = 0;

    const runWatchCycle = async () => {
      const timestamp = new Date().toLocaleTimeString();
      const s = await getQuickStatus(config);

      // Handle query failures gracefully
      if (s.queryFailed) {
        console.log(`[${timestamp}] \x1b[31m⚠ QUERY FAILED - server unresponsive\x1b[0m`);
        return;
      }

      // Check queue depth (tasks with remaining work)
      const queueResult = execSQL(config, `
        SELECT COUNT(*) FROM Task
        WHERE isArchived=0 AND keyspace>0 AND keyspaceProgress<keyspace
      `);
      const queueDepth = parseInt(queueResult) || 0;

      // Check for idle agents (CRITICAL - expensive waste)
      const idleCheck = await checkIdleAgents(config);
      const uninitCheck = await checkUninitializedTasks(config);

      // Build status line
      let statusLine = `[${timestamp}] Agents: ${s.agents}/8 | Chunks: ${s.chunks} | Queue: ${queueDepth} | PEARLS: ${s.pearls.toLocaleString()}`;

      // Queue depth warning (every 5 minutes max)
      const now = Date.now();
      if (queueDepth < 8 && (now - lastQueueWarning) > 300000) {
        console.log(`\x1b[33m⚠️  LOW QUEUE: Only ${queueDepth} tasks with work remaining!\x1b[0m`);
        console.log(`   Submit more batches: bun Tools/CrackSubmitter.ts --batch N`);
        lastQueueWarning = now;
      }

      // Alert on idle agents with ESCALATION PATH
      if (idleCheck.status !== "OK") {
        console.log(`\x1b[31m⚠️  ALERT: ${idleCheck.message}\x1b[0m`);
        console.log(`   ESCALATION PATH:`);
        console.log(`   1. Check queue depth (are there tasks with work?)`);
        console.log(`   2. Check if tasks need benchmark (keyspace=0)`);
        console.log(`   3. If agent truly stale: reboot worker EC2 instance`);

        // AUTO-REBOOT: Workers stale >15 min with tasks available (Lesson #46)
        await autoRebootStaleWorkers(config, queueDepth);
      }

      // Auto-fix format mismatch (set useNewBench=0 per Lesson #46)
      if (uninitCheck.status === "CRITICAL" && uninitCheck.sql) {
        console.log(`\x1b[33m⚡ AUTO-FIX: ${uninitCheck.message}\x1b[0m`);
        execSQL(config, uninitCheck.sql);
        console.log(`   ✓ Set useNewBench=0 to match agent format`);
      }

      // Check for stuck chunks - WARN ONLY, do NOT auto-abort (Golden Rule #1)
      if (s.chunks > 0) {
        const longRunningCheck = await checkLongRunningChunks(config);
        if (longRunningCheck.status === "CRITICAL") {
          console.log(`\x1b[31m🔥 STUCK CHUNKS: ${longRunningCheck.message}\x1b[0m`);
          console.log(`   Per Golden Rule #1: Manual intervention required`);
          console.log(`   Options: (1) Wait for timeout (2) Archive task + recreate (3) Use Hashtopolis UI`);
          // NO auto-abort per Lesson #21: "NEVER Manipulate Chunk State Directly"
        }
      }

      // Check agent count dropped
      if (s.agents < 8) {
        statusLine += ` \x1b[33m[${8 - s.agents} agents down]\x1b[0m`;
      }

      console.log(statusLine);
    };

    // Run immediately, then every 30 seconds (per Golden Rule #5)
    await runWatchCycle();
    setInterval(runWatchCycle, 30000);
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
  bun PipelineMonitor.ts --fix        Auto-fix keyspace=0 (useNewBench only)
  bun PipelineMonitor.ts --watch      Continuous monitoring (30s interval)

Health Checks:
  - Agent health (alive/stale workers)
  - Task initialization (keyspace=0 detection)
  - Idle agents (workers with no work assigned)
  - Queue depth (tasks with remaining work)
  - Long-running chunks (>15min detection)
  - Chunk advancement (detect stuck chunks - 20s wait)
  - Priority alignment (Task vs TaskWrapper)
  - Archive readiness (safe archiving validation)
  - Crack distribution (detect incomplete batches)

Auto-Fix (--fix and --watch):
  - Sets useNewBench=0 on tasks with format mismatch (useNewBench=1 should be 0)
  - Does NOT auto-abort chunks (per Golden Rule #1, Lesson #21)
  - Does NOT add batches (per Lesson #39)

Stuck Chunk Resolution (MANUAL per Golden Rule #1):
  - Detect chunks running >15 minutes with no progress
  - Options: Wait for timeout, Archive+recreate task, Use Hashtopolis UI
  - DO NOT directly manipulate Chunk state (causes stuck tasks)

Queue Management (per Lesson #39):
  - Watch mode monitors queue depth but does NOT add batches
  - Submit batches manually: bun Tools/CrackSubmitter.ts --batch N
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
