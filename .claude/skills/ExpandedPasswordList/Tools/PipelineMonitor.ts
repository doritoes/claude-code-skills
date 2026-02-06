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
  // Use 120-second threshold (2 min) to account for timing variations
  // Agents check in every 5 seconds, but network/processing can cause gaps
  // EXCEPTION: Agents downloading hashlists (lastAct='getHashlist') may take longer
  // as large hashlist downloads can take several minutes - use 10 min threshold for those
  const result = execSQL(config, `
    SELECT
      COUNT(*) as total,
      SUM(CASE
        WHEN lastAct = 'getHashlist' AND (UNIX_TIMESTAMP() - lastTime) < 600 THEN 1
        WHEN lastAct != 'getHashlist' AND (UNIX_TIMESTAMP() - lastTime) < 120 THEN 1
        ELSE 0
      END) as alive,
      GROUP_CONCAT(CASE
        WHEN lastAct = 'getHashlist' AND (UNIX_TIMESTAMP() - lastTime) >= 600 THEN CONCAT(agentName, ' (downloading)')
        WHEN lastAct != 'getHashlist' AND (UNIX_TIMESTAMP() - lastTime) >= 120 THEN agentName
        ELSE NULL
      END) as stale
    FROM Agent
  `);

  const [total, alive, stale] = result.split("\t");
  const aliveCount = parseInt(alive) || 0;
  const totalCount = parseInt(total) || 0;

  // Also get count of agents currently downloading
  const downloadingResult = execSQL(config, `
    SELECT COUNT(*), GROUP_CONCAT(agentName)
    FROM Agent
    WHERE lastAct = 'getHashlist' AND (UNIX_TIMESTAMP() - lastTime) < 600
  `);
  const [downloadingCount, downloadingNames] = downloadingResult.split("\t");
  const downloading = parseInt(downloadingCount) || 0;

  if (aliveCount === totalCount && totalCount > 0) {
    let msg = `${aliveCount}/${totalCount} agents alive`;
    if (downloading > 0) {
      msg += ` (${downloading} downloading hashlists)`;
    }
    return { name: "Agent Health", status: "OK", message: msg };
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
  // CRITICAL: Also check agent assignments - agents may still be assigned even if chunks show complete
  const result = execSQL(config, `
    SELECT t.taskId, t.taskName,
      (SELECT COUNT(*) FROM Chunk c WHERE c.taskId=t.taskId AND c.state IN (0,2)) as active_chunks,
      (SELECT COUNT(*) FROM Chunk c WHERE c.taskId=t.taskId AND c.state=6) as aborted_chunks,
      (SELECT COUNT(*) FROM Chunk c WHERE c.taskId=t.taskId AND c.state=4) as finished_chunks,
      (SELECT COUNT(*) FROM Assignment a WHERE a.taskId=t.taskId) as assigned_agents
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
    const [taskId, taskName, active, aborted, finished, assigned] = task.split("\t");
    // CRITICAL: Must also have no assigned agents - they may still be working even if stats show 100%
    if (parseInt(active) === 0 && parseInt(aborted) === 0 && parseInt(finished) > 0 && parseInt(assigned) === 0) {
      safeToArchive.push(taskName);
    } else if (parseInt(assigned) > 0) {
      needsReview.push(`${taskName} (${assigned} agent(s) assigned)`);
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
  // EXCEPTION: Agents downloading hashlists (lastAct='getHashlist') are not idle -
  // they're actively downloading work, which can take several minutes for large files
  const result = execSQL(config, `
    SELECT a.agentId, a.agentName,
      TIMESTAMPDIFF(MINUTE, FROM_UNIXTIME(a.lastTime), NOW()) as minutes_idle,
      a.lastAct
    FROM Agent a
    WHERE a.isActive = 1
      AND (UNIX_TIMESTAMP() - a.lastTime) > 120
      AND a.lastAct != 'getHashlist'
      AND a.agentId NOT IN (SELECT DISTINCT agentId FROM Chunk WHERE state = 2 AND agentId IS NOT NULL)
  `);

  if (!result) {
    return { name: "Idle Agents", status: "OK", message: "No idle agents detected" };
  }

  const idleAgents = result.split("\n").filter(Boolean).map(line => {
    const [id, name, minutes, lastAct] = line.split("\t");
    return `${name} (${minutes}min, ${lastAct})`;
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
  // Use 120-second threshold (2 min) to match checkAgentHealth
  const result = execSQL(config, `
    SELECT
      (SELECT COUNT(*) FROM Agent WHERE UNIX_TIMESTAMP() - lastTime < 120),
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
// Server Health Check (Docker, Memory, Disk)
// =============================================================================

interface ServerHealth {
  docker: { running: number; total: number; containers: string[] };
  memory: { used: string; total: string; percent: number };
  disk: { used: string; total: string; percent: number };
  uptime: string;
  healthy: boolean;
  issues: string[];
}

interface DatabaseHealth {
  hashTableMb: number;
  hashTableRows: number;
  totalDbMb: number;
  activeHashlists: number;
  archivableHashlists: number;
  estimatedReclaimMb: number;
  needsCleanup: boolean;
}

async function checkServerHealth(config: ServerConfig): Promise<ServerHealth> {
  const health: ServerHealth = {
    docker: { running: 0, total: 0, containers: [] },
    memory: { used: "0", total: "0", percent: 0 },
    disk: { used: "0", total: "0", percent: 0 },
    uptime: "unknown",
    healthy: true,
    issues: []
  };

  try {
    // Run all checks in one SSH command for efficiency
    // Use unique markers that won't appear in output data
    // IMPORTANT: Keep command on single line to avoid shell escaping issues
    const remoteCmd = "echo '###DOCKER###' && sudo docker ps --format '{{.Names}}:{{.Status}}' 2>/dev/null && echo '###MEMORY###' && free -h | grep Mem && echo '###DISK###' && df -h / | tail -1 && echo '###UPTIME###' && (uptime -p 2>/dev/null || uptime) && echo '###END###'";
    const cmd = `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 ${config.sshUser}@${config.serverIp} "${remoteCmd}"`;

    const result = execSync(cmd, { encoding: "utf-8", timeout: 30000 }).trim();

    // Parse using regex to extract sections between markers
    const dockerMatch = result.match(/###DOCKER###\n([\s\S]*?)###MEMORY###/);
    const memoryMatch = result.match(/###MEMORY###\n([\s\S]*?)###DISK###/);
    const diskMatch = result.match(/###DISK###\n([\s\S]*?)###UPTIME###/);
    const uptimeMatch = result.match(/###UPTIME###\n([\s\S]*?)###END###/);

    // Parse Docker
    if (dockerMatch && dockerMatch[1]) {
      const containers = dockerMatch[1].trim().split("\n").filter(l => l.includes(":"));
      health.docker.total = containers.length;
      health.docker.running = containers.filter(c => c.toLowerCase().includes("up")).length;
      health.docker.containers = containers.map(c => {
        const colonIdx = c.indexOf(":");
        const name = c.substring(0, colonIdx);
        const status = c.substring(colonIdx + 1);
        return `${name} (${status.toLowerCase().includes("up") ? "✓" : "✗"})`;
      });
      if (health.docker.running < health.docker.total) {
        health.issues.push(`${health.docker.total - health.docker.running} container(s) not running`);
      }
    }

    // Parse Memory: "Mem:           7.6Gi       1.7Gi       5.3Gi..."
    if (memoryMatch && memoryMatch[1]) {
      const memLine = memoryMatch[1].trim();
      const parts = memLine.split(/\s+/);
      // parts[0] = "Mem:", parts[1] = total, parts[2] = used, parts[3] = free...
      health.memory.total = parts[1] || "0";
      health.memory.used = parts[2] || "0";
      // Calculate percent from used/total (handle Gi/Mi suffixes)
      const parseSize = (s: string): number => {
        const num = parseFloat(s);
        if (s.includes("Gi")) return num * 1024;
        if (s.includes("Mi")) return num;
        return num;
      };
      const usedMi = parseSize(health.memory.used);
      const totalMi = parseSize(health.memory.total);
      if (totalMi > 0) {
        health.memory.percent = Math.round((usedMi / totalMi) * 100);
      }
      if (health.memory.percent > 85) {
        health.issues.push(`Memory usage high: ${health.memory.percent}%`);
      }
    }

    // Parse Disk: "/dev/root        48G   23G   26G  47% /"
    if (diskMatch && diskMatch[1]) {
      const diskLine = diskMatch[1].trim();
      const parts = diskLine.split(/\s+/);
      // parts[0] = device, parts[1] = size, parts[2] = used, parts[3] = avail, parts[4] = use%
      health.disk.total = parts[1] || "0";
      health.disk.used = parts[2] || "0";
      const percentStr = parts[4] || "0%";
      health.disk.percent = parseInt(percentStr.replace("%", "")) || 0;
      if (health.disk.percent > 80) {
        health.issues.push(`Disk usage high: ${health.disk.percent}%`);
      }
    }

    // Parse Uptime
    if (uptimeMatch && uptimeMatch[1]) {
      health.uptime = uptimeMatch[1].trim();
    }

    health.healthy = health.issues.length === 0;
  } catch (e) {
    health.healthy = false;
    health.issues.push(`SSH failed: ${(e as Error).message.substring(0, 50)}`);
  }

  return health;
}

async function checkDatabaseHealth(config: ServerConfig): Promise<DatabaseHealth> {
  const health: DatabaseHealth = {
    hashTableMb: 0,
    hashTableRows: 0,
    totalDbMb: 0,
    activeHashlists: 0,
    archivableHashlists: 0,
    estimatedReclaimMb: 0,
    needsCleanup: false
  };

  // Get Hash table size
  const hashSize = execSQL(config, `
    SELECT ROUND(SUM(data_length + index_length) / 1024 / 1024, 2)
    FROM information_schema.tables
    WHERE table_schema = 'hashtopolis' AND table_name = 'Hash'
  `);
  health.hashTableMb = parseFloat(hashSize) || 0;

  // Get Hash row count
  const hashRows = execSQL(config, `SELECT COUNT(*) FROM Hash`);
  health.hashTableRows = parseInt(hashRows) || 0;

  // Get total DB size
  const totalDb = execSQL(config, `
    SELECT ROUND(SUM(data_length + index_length) / 1024 / 1024, 2)
    FROM information_schema.tables
    WHERE table_schema = 'hashtopolis'
  `);
  health.totalDbMb = parseFloat(totalDb) || 0;

  // Get active (non-archived) hashlists count
  const activeHashlists = execSQL(config, `SELECT COUNT(*) FROM Hashlist WHERE isArchived = 0`);
  health.activeHashlists = parseInt(activeHashlists) || 0;

  // Get archivable hashlists (all tasks archived but hashlist not)
  const archivable = execSQL(config, `
    SELECT COUNT(DISTINCT hl.hashlistId)
    FROM Hashlist hl
    WHERE hl.isArchived = 0
    AND NOT EXISTS (
      SELECT 1 FROM Task t
      JOIN TaskWrapper tw ON t.taskWrapperId = tw.taskWrapperId
      WHERE tw.hashlistId = hl.hashlistId AND t.isArchived = 0
    )
  `);
  health.archivableHashlists = parseInt(archivable) || 0;

  // Estimate reclaimable space (archivable hashlists × avg 62500 rows × 230 bytes)
  if (health.archivableHashlists > 0) {
    health.estimatedReclaimMb = Math.round(health.archivableHashlists * 62500 * 230 / 1024 / 1024);
  }

  // Determine if cleanup is needed (Hash table > 5GB or disk > 70%)
  health.needsCleanup = health.hashTableMb > 5000 || health.archivableHashlists > 50;

  return health;
}

// Helper to pad lines with ANSI codes (strips codes for length calc)
function padBox(content: string, width: number = 58): string {
  const visibleLength = content.replace(/\x1b\[[0-9;]*m/g, '').length;
  const padding = width - visibleLength;
  return content + ' '.repeat(Math.max(0, padding));
}

function displayDatabaseHealth(db: DatabaseHealth, diskPercent: number): void {
  console.log("┌─ DATABASE HEALTH ──────────────────────────────────────────┐");

  // Hash table size
  const hashStatus = db.hashTableMb < 5000 ? "\x1b[32m✓\x1b[0m" :
                     db.hashTableMb < 10000 ? "\x1b[33m⚠\x1b[0m" : "\x1b[31m✗\x1b[0m";
  console.log(`│ ${padBox(`${hashStatus} Hash Table: ${db.hashTableMb.toLocaleString()} MB (${db.hashTableRows.toLocaleString()} rows)`)} │`);

  // Total DB size
  console.log(`│ ${padBox(`○ Total Database: ${db.totalDbMb.toLocaleString()} MB`)} │`);

  // Active vs archivable hashlists
  console.log(`│ ${padBox(`○ Active Hashlists: ${db.activeHashlists.toLocaleString()}`)} │`);

  if (db.archivableHashlists > 0) {
    console.log(`│ ${padBox(`\x1b[33m⚠\x1b[0m Archivable Hashlists: ${db.archivableHashlists} (can reclaim ~${db.estimatedReclaimMb} MB)`)} │`);
  }

  // Cleanup recommendation
  if (db.needsCleanup || diskPercent > 70) {
    console.log(`│ ${padBox('')} │`);
    console.log(`│ ${padBox(`\x1b[33m→ CLEANUP RECOMMENDED:\x1b[0m`)} │`);
    console.log(`│ ${padBox(`  1. Export passwords: bun Tools/PasswordExporter.ts export`)} │`);
    console.log(`│ ${padBox(`  2. Archive hashlists: bun Tools/HashlistArchiver.ts`)} │`);
    if (db.hashTableMb > 10000) {
      console.log(`│ ${padBox(`  3. Optimize table: OPTIMIZE TABLE Hash (after archiving)`)} │`);
    }
  }

  console.log("└────────────────────────────────────────────────────────────┘");
}

function displayServerHealth(health: ServerHealth): void {
  console.log("┌─ SERVER HEALTH ────────────────────────────────────────────┐");

  // Docker
  const dockerStatus = health.docker.running === health.docker.total && health.docker.total > 0
    ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
  console.log(`│ ${padBox(`${dockerStatus} Docker: ${health.docker.running}/${health.docker.total} containers running`)} │`);
  for (const container of health.docker.containers) {
    console.log(`│ ${padBox(`  ${container}`)} │`);
  }

  // Memory
  const memStatus = health.memory.percent <= 85 ? "\x1b[32m✓\x1b[0m" : "\x1b[33m⚠\x1b[0m";
  console.log(`│ ${padBox(`${memStatus} Memory: ${health.memory.used}/${health.memory.total} (${health.memory.percent}%)`)} │`);

  // Disk
  const diskStatus = health.disk.percent <= 80 ? "\x1b[32m✓\x1b[0m" : "\x1b[33m⚠\x1b[0m";
  console.log(`│ ${padBox(`${diskStatus} Disk: ${health.disk.used}/${health.disk.total} (${health.disk.percent}%)`)} │`);

  // Uptime
  console.log(`│ ${padBox(`○ Uptime: ${health.uptime}`)} │`);

  // Issues
  if (health.issues.length > 0) {
    console.log(`│ ${padBox('')} │`);
    console.log(`│ ${padBox(`\x1b[33mIssues:\x1b[0m`)} │`);
    for (const issue of health.issues) {
      console.log(`│ ${padBox(`  → ${issue}`)} │`);
    }
  }

  console.log("└────────────────────────────────────────────────────────────┘");
}

// =============================================================================
// Worker Health Check (via AWS CLI)
// =============================================================================

interface WorkerHealth {
  name: string;
  ip: string;
  diskPercent: number;
  diskUsed: string;
  diskTotal: string;
  hashlistSize: string;
  status: "healthy" | "warning" | "critical" | "unreachable";
}

async function checkWorkerDiskHealth(): Promise<WorkerHealth[]> {
  const workers: WorkerHealth[] = [];
  const AWS_REGION = "us-west-2";

  try {
    // Get worker IPs from AWS
    const awsCmd = `aws ec2 describe-instances --filters "Name=tag:Name,Values=hashcrack-gpu-worker-*" "Name=instance-state-name,Values=running" --query "Reservations[*].Instances[*].[Tags[?Key=='Name'].Value|[0],PublicIpAddress]" --output text --region ${AWS_REGION}`;
    const awsResult = execSync(awsCmd, {
      encoding: "utf-8",
      timeout: 30000,
      shell: process.platform === "win32" ? "C:\Program Files\Git\bin\bash.exe" : "/bin/bash",
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    if (!awsResult) return workers;

    const workerList = awsResult.split("\n").map(line => {
      const [name, ip] = line.split("\t");
      return { name: name || "unknown", ip };
    }).filter(w => w.ip && w.ip !== "None");

    // Check each worker
    for (const worker of workerList) {
      const health: WorkerHealth = {
        name: worker.name,
        ip: worker.ip,
        diskPercent: 0,
        diskUsed: "N/A",
        diskTotal: "N/A",
        hashlistSize: "N/A",
        status: "unreachable",
      };

      try {
        const sshCmd = `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 -o BatchMode=yes ubuntu@${worker.ip} "df -h / | tail -1 && du -sh /opt/hashtopolis-agent/hashlists/ 2>/dev/null | cut -f1"`;
        const result = execSync(sshCmd, {
          encoding: "utf-8",
          timeout: 15000,
          shell: process.platform === "win32" ? "C:\Program Files\Git\bin\bash.exe" : "/bin/bash",
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
        }).trim();

        const lines = result.split("\n");
        if (lines[0]) {
          const dfParts = lines[0].split(/\s+/);
          if (dfParts.length >= 5) {
            health.diskTotal = dfParts[1];
            health.diskUsed = dfParts[2];
            health.diskPercent = parseInt(dfParts[4].replace("%", "")) || 0;
          }
        }
        if (lines[1]) {
          health.hashlistSize = lines[1];
        }

        health.status = health.diskPercent >= 85 ? "critical" :
                        health.diskPercent >= 70 ? "warning" : "healthy";
      } catch (e) {
        // Worker unreachable
      }

      workers.push(health);
    }
  } catch (e) {
    // AWS CLI failed
  }

  return workers;
}

function displayWorkerHealth(workers: WorkerHealth[]): void {
  if (workers.length === 0) {
    console.log("┌─ WORKER DISK HEALTH ───────────────────────────────────────┐");
    console.log("│ \x1b[33m⚠ Could not get worker info (check AWS CLI)\x1b[0m               │");
    console.log("└────────────────────────────────────────────────────────────┘");
    return;
  }

  console.log("┌─ WORKER DISK HEALTH ───────────────────────────────────────┐");

  const healthy = workers.filter(w => w.status === "healthy").length;
  const warning = workers.filter(w => w.status === "warning").length;
  const critical = workers.filter(w => w.status === "critical").length;
  const unreachable = workers.filter(w => w.status === "unreachable").length;

  // Summary line
  const summaryIcon = critical > 0 ? "\x1b[31m✗\x1b[0m" : warning > 0 ? "\x1b[33m⚠\x1b[0m" : "\x1b[32m✓\x1b[0m";
  console.log(`│ ${summaryIcon} Workers: ${workers.length} total | ${healthy} healthy | ${warning} warning | ${critical} critical | ${unreachable} unreachable`);

  // Show disk range
  const reachable = workers.filter(w => w.status !== "unreachable");
  if (reachable.length > 0) {
    const minDisk = Math.min(...reachable.map(w => w.diskPercent));
    const maxDisk = Math.max(...reachable.map(w => w.diskPercent));
    const avgHashlist = reachable.map(w => w.hashlistSize).filter(s => s !== "N/A")[0] || "N/A";
    console.log(`│   Disk: ${minDisk}-${maxDisk}% | Hashlists: ~${avgHashlist} each`);
  }

  // Show warnings/criticals
  const problems = workers.filter(w => w.status === "warning" || w.status === "critical");
  if (problems.length > 0) {
    console.log(`│   \x1b[33m→ Run: bun Tools/WorkerHealthCheck.ts --clean\x1b[0m`);
  }

  console.log("└────────────────────────────────────────────────────────────┘");
}

// =============================================================================
// Main Monitor Function
// =============================================================================

async function runMonitor(options: { quick?: boolean; fix?: boolean; watch?: boolean; workers?: boolean } = {}): Promise<void> {
  console.log("╭─────────────────────────────────────────────────────────────╮");
  console.log("│        EXPANDEDPASSWORDLIST PIPELINE MONITOR                │");
  console.log("╰─────────────────────────────────────────────────────────────╯");
  console.log("");

  const config = getServerConfig();
  console.log(`Server: ${config.serverIp}`);
  console.log("");

  // Server health check (docker, memory, disk)
  const serverHealth = await checkServerHealth(config);
  displayServerHealth(serverHealth);
  console.log("");

  // Database health check (Hash table size, archivable hashlists)
  const dbHealth = await checkDatabaseHealth(config);
  displayDatabaseHealth(dbHealth, serverHealth.disk.percent);
  console.log("");

  // Worker disk health (only if --workers flag)
  if (options.workers) {
    console.log("Checking worker disk health (via AWS CLI)...");
    const workerHealth = await checkWorkerDiskHealth();
    displayWorkerHealth(workerHealth);
    console.log("");
  }

  // Quick status
  const status = await getQuickStatus(config);
  console.log("┌─ QUICK STATUS ─────────────────────────────────────────────┐");
  if (status.queryFailed) {
    console.log("│ \x1b[31m⚠ QUERY FAILED - Cannot get status (check server connection)\x1b[0m │");
    console.log("│ SSH or MySQL may be unresponsive. Check server health.    │");
  } else {
    const line = `Agents: ${status.agents}/8    Chunks: ${status.chunks}    PEARLS: ${status.pearls.toLocaleString()}`;
    console.log(`│ ${line.padEnd(58)} │`);
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
  bun PipelineMonitor.ts --quick      Quick status only (server + DB summary)
  bun PipelineMonitor.ts --health     Full health checks (default)
  bun PipelineMonitor.ts --fix        Auto-fix keyspace=0 (useNewBench only)
  bun PipelineMonitor.ts --watch      Continuous monitoring (30s interval)
  bun PipelineMonitor.ts --cleanup    Run HashlistArchiver to reclaim disk
  bun PipelineMonitor.ts --workers    Include GPU worker disk health (via AWS CLI)

Health Checks:
  - Server health (Docker, Memory, Disk usage)
  - Database health (Hash table size, archivable hashlists)
  - Agent health (alive/stale workers)
  - Task initialization (keyspace=0 detection)
  - Idle agents (workers with no work assigned)
  - Queue depth (tasks with remaining work)
  - Long-running chunks (>15min detection)
  - Chunk advancement (detect stuck chunks - 20s wait)
  - Priority alignment (Task vs TaskWrapper)
  - Archive readiness (safe archiving validation)
  - Crack distribution (detect incomplete batches)
  - Worker disk health (--workers flag, requires AWS CLI)

Database Cleanup (--cleanup):
  - Exports cracked passwords before deleting (safeguards PEARLS)
  - Archives hashlists where all tasks are complete
  - Deletes Hash table rows to reclaim disk space
  - Run OPTIMIZE TABLE Hash after large cleanups

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
    watch: args.includes("--watch"),
    cleanup: args.includes("--cleanup"),
    workers: args.includes("--workers"),
    health: args.includes("--health") || (!args.includes("--quick") && !args.includes("--cleanup"))
  };

  try {
    if (options.cleanup) {
      await runCleanup();
    } else {
      await runMonitor(options);
    }
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
  }
}

async function runCleanup(): Promise<void> {
  console.log("╭─────────────────────────────────────────────────────────────╮");
  console.log("│        DATABASE CLEANUP                                     │");
  console.log("╰─────────────────────────────────────────────────────────────╯");
  console.log("");

  const config = getServerConfig();

  // Check current state
  const dbHealth = await checkDatabaseHealth(config);

  console.log(`Current State:`);
  console.log(`  Hash Table: ${dbHealth.hashTableMb.toLocaleString()} MB (${dbHealth.hashTableRows.toLocaleString()} rows)`);
  console.log(`  Archivable Hashlists: ${dbHealth.archivableHashlists}`);
  console.log(`  Estimated Reclaim: ~${dbHealth.estimatedReclaimMb} MB`);
  console.log("");

  if (dbHealth.archivableHashlists === 0) {
    console.log("✓ No hashlists ready for cleanup. All clean!");
    return;
  }

  console.log("Running HashlistArchiver...");
  console.log("");

  // Run HashlistArchiver
  try {
    const { execSync } = await import("child_process");
    const archiverPath = resolve(SKILL_DIR, "Tools", "HashlistArchiver.ts");
    execSync(`bun run "${archiverPath}"`, {
      encoding: "utf-8",
      stdio: "inherit",
      timeout: 600000
    });
  } catch (e) {
    console.error("HashlistArchiver failed:", (e as Error).message);
  }

  // Check final state
  console.log("");
  console.log("Checking final state...");
  const finalHealth = await checkDatabaseHealth(config);

  console.log("");
  console.log("┌─ CLEANUP RESULTS ───────────────────────────────────────────┐");
  console.log(`│ Hash Table: ${dbHealth.hashTableMb.toLocaleString()} MB → ${finalHealth.hashTableMb.toLocaleString()} MB`);
  console.log(`│ Reclaimed: ~${Math.max(0, dbHealth.hashTableMb - finalHealth.hashTableMb).toLocaleString()} MB`);
  console.log("└────────────────────────────────────────────────────────────┘");

  if (finalHealth.hashTableMb > 5000) {
    console.log("");
    console.log("\x1b[33mNote: Hash table still large. Run OPTIMIZE TABLE Hash on server:\x1b[0m");
    console.log(`  ssh ubuntu@${config.serverIp} "sudo docker exec hashtopolis-db mysql -uroot -p'<password>' hashtopolis -e 'OPTIMIZE TABLE Hash'"`);
  }
}
