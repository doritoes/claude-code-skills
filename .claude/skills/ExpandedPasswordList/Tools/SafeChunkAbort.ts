#!/usr/bin/env bun
/**
 * SafeChunkAbort.ts - Safe Chunk Abort with Comprehensive Validation
 *
 * Addresses TWO Hashtopolis edge cases:
 *
 * 1. STUCK CHUNKS - chunks with crackPos NULL errors don't auto-timeout
 *    because the agent keeps communicating (even though progress fails to save).
 *    Validated with safety gates before aborting.
 *
 * 2. ORPHANED CHUNKS - running chunks whose parent task is ARCHIVED.
 *    These occur when a task is archived while chunks are still processing.
 *    These are always invalid and can be aborted immediately without gates.
 *
 * STUCK CHUNK SAFETY GATES:
 * - GATE A: Chunk exists and is in DISPATCHED state
 * - GATE B: Chunk has been running for minimum time (>15 min default)
 * - GATE C: Progress is NOT advancing (verified over 30s window)
 * - GATE D: Parent task is healthy (not archived, has keyspace)
 *
 * RESOLUTION METHODS (in order of preference):
 * 1. AGENT RESTART (default) - Restart the agent service on the worker
 *    - Causes agent to stop communicating → 30s timeout → chunk released
 *    - Hashtopolis handles the transition properly
 *    - Agent comes back online and picks up new work
 *
 * 2. DIRECT ABORT (fallback) - Set chunk state=6 directly
 *    - Used when agent restart fails or --direct flag specified
 *    - May cause agent crash (per Lesson #13)
 *    - Hashtopolis creates replacement chunk
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
const CLAUDE_DIR = resolve(SKILL_DIR, "..", "..");
const ENV_FILE = resolve(CLAUDE_DIR, ".env");

// =============================================================================
// Configuration
// =============================================================================

interface ServerConfig {
  serverIp: string;
  dbPassword: string;
  sshUser: string;
}

interface ChunkInfo {
  chunkId: number;
  taskId: number;
  taskName: string;
  state: number;
  progress: number;
  agentId: number | null;
  agentName: string | null;
  dispatchTime: number;
  minutesRunning: number;
  keyspace: number;
  taskArchived: boolean;
}

interface GateResult {
  gate: string;
  passed: boolean;
  message: string;
}

// =============================================================================
// Server Configuration
// =============================================================================

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
  // Priority 1: Read from .claude/.env file
  const env = loadEnvFile();

  if (env.HASHCRACK_SERVER_URL && env.HASHCRACK_DB_PASSWORD) {
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
    // Terraform failed
  }

  throw new Error("Cannot determine server IP. Update HASHCRACK_SERVER_URL in .claude/.env");
}

function execSQL(config: ServerConfig, sql: string): string {
  const cleanSql = sql.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
  const b64Sql = Buffer.from(cleanSql).toString('base64');
  const cmd = `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=15 ${config.sshUser}@${config.serverIp} "echo ${b64Sql} | base64 -d | sudo docker exec -i hashtopolis-db mysql -u hashtopolis -p'${config.dbPassword}' hashtopolis -sN"`;

  try {
    return execSync(cmd, { encoding: "utf-8", timeout: 60000 }).trim();
  } catch (e: any) {
    const stdout = e.stdout ? e.stdout.toString().trim() : "";
    if (stdout) return stdout;
    return "";
  }
}

// =============================================================================
// Chunk Information
// =============================================================================

function getChunkInfo(config: ServerConfig, chunkId: number): ChunkInfo | null {
  const result = execSQL(config, `
    SELECT
      c.chunkId, c.taskId, t.taskName, c.state, c.progress,
      c.agentId, a.agentName, c.dispatchTime,
      TIMESTAMPDIFF(MINUTE, FROM_UNIXTIME(c.dispatchTime), NOW()) as minutes_running,
      t.keyspace, t.isArchived
    FROM Chunk c
    JOIN Task t ON c.taskId = t.taskId
    LEFT JOIN Agent a ON c.agentId = a.agentId
    WHERE c.chunkId = ${chunkId}
  `);

  if (!result) return null;

  const parts = result.split("\t");
  return {
    chunkId: parseInt(parts[0]),
    taskId: parseInt(parts[1]),
    taskName: parts[2],
    state: parseInt(parts[3]),
    progress: parseInt(parts[4]) || 0,
    agentId: parts[5] ? parseInt(parts[5]) : null,
    agentName: parts[6] || null,
    dispatchTime: parseInt(parts[7]) || 0,
    minutesRunning: parseInt(parts[8]) || 0,
    keyspace: parseInt(parts[9]) || 0,
    taskArchived: parts[10] === "1"
  };
}

function getChunkProgress(config: ServerConfig, chunkId: number): number {
  const result = execSQL(config, `SELECT progress FROM Chunk WHERE chunkId = ${chunkId}`);
  return parseInt(result) || 0;
}

// =============================================================================
// Safety Gates
// =============================================================================

function runGateA(chunk: ChunkInfo | null): GateResult {
  // GATE A: Chunk exists and is DISPATCHED
  if (!chunk) {
    return { gate: "A", passed: false, message: "Chunk not found" };
  }
  if (chunk.state !== 2) {
    const stateNames: Record<number, string> = {
      0: "NEW", 2: "DISPATCHED", 4: "FINISHED", 6: "ABORTED", 9: "TRIMMED"
    };
    return {
      gate: "A",
      passed: false,
      message: `Chunk is not DISPATCHED (state=${chunk.state} ${stateNames[chunk.state] || "UNKNOWN"})`
    };
  }
  return { gate: "A", passed: true, message: `Chunk ${chunk.chunkId} is DISPATCHED` };
}

function runGateB(chunk: ChunkInfo, minMinutes: number): GateResult {
  // GATE B: Minimum running time
  if (chunk.minutesRunning < minMinutes) {
    return {
      gate: "B",
      passed: false,
      message: `Chunk running for only ${chunk.minutesRunning} min (minimum: ${minMinutes} min)`
    };
  }
  return {
    gate: "B",
    passed: true,
    message: `Chunk running for ${chunk.minutesRunning} min (>= ${minMinutes} min threshold)`
  };
}

async function runGateC(config: ServerConfig, chunkId: number, waitSeconds: number): Promise<GateResult> {
  // GATE C: Progress stagnation check
  const progress1 = getChunkProgress(config, chunkId);

  console.log(`│ GATE C: Checking progress stagnation (${waitSeconds}s wait)...`);
  console.log(`│         Initial progress: ${(progress1/100).toFixed(2)}%`);

  await new Promise(resolve => setTimeout(resolve, waitSeconds * 1000));

  const progress2 = getChunkProgress(config, chunkId);
  console.log(`│         Final progress: ${(progress2/100).toFixed(2)}%`);

  if (progress2 > progress1) {
    return {
      gate: "C",
      passed: false,
      message: `Progress IS advancing (${(progress1/100).toFixed(2)}% → ${(progress2/100).toFixed(2)}%) - chunk is NOT stuck`
    };
  }

  return {
    gate: "C",
    passed: true,
    message: `Progress NOT advancing over ${waitSeconds}s (stuck at ${(progress2/100).toFixed(2)}%)`
  };
}

function runGateD(chunk: ChunkInfo): GateResult {
  // GATE D: Task health
  if (chunk.taskArchived) {
    return { gate: "D", passed: false, message: "Parent task is ARCHIVED - cannot abort chunk" };
  }
  if (chunk.keyspace === 0) {
    return { gate: "D", passed: false, message: "Parent task has keyspace=0 - task not initialized" };
  }
  return { gate: "D", passed: true, message: `Parent task ${chunk.taskId} is healthy (keyspace=${chunk.keyspace})` };
}

// =============================================================================
// Detection
// =============================================================================

interface StuckChunk {
  chunkId: number;
  taskId: number;
  taskName: string;
  agentName: string;
  minutesRunning: number;
  progress: number;
}

interface OrphanedChunk {
  chunkId: number;
  taskId: number;
  taskName: string;
  agentName: string;
  minutesRunning: number;
  progress: number;
}

/**
 * Detect orphaned chunks - running chunks whose parent task is ARCHIVED
 * These are always invalid and should be aborted immediately.
 */
function detectOrphanedChunks(config: ServerConfig): OrphanedChunk[] {
  const result = execSQL(config, `
    SELECT c.chunkId, c.taskId, t.taskName, a.agentName, c.progress,
      TIMESTAMPDIFF(MINUTE, FROM_UNIXTIME(c.dispatchTime), NOW()) as minutes_running
    FROM Chunk c
    JOIN Task t ON c.taskId = t.taskId
    LEFT JOIN Agent a ON c.agentId = a.agentId
    WHERE c.state = 2
      AND t.isArchived = 1
    ORDER BY minutes_running DESC
  `);

  if (!result) return [];

  return result.split("\n").filter(Boolean).map(line => {
    const parts = line.split("\t");
    return {
      chunkId: parseInt(parts[0]),
      taskId: parseInt(parts[1]),
      taskName: parts[2],
      agentName: parts[3] || "unknown",
      progress: parseInt(parts[4]) || 0,
      minutesRunning: parseInt(parts[5]) || 0
    };
  });
}

/**
 * Abort an orphaned chunk - simpler than stuck chunk resolution
 * No progress check needed since the parent task is archived.
 */
function abortOrphanedChunk(config: ServerConfig, chunkId: number, taskName: string): boolean {
  console.log(`│ Aborting orphaned chunk ${chunkId} (task: ${taskName})...`);

  // Set state=6 (ABORTED) and clear agentId
  execSQL(config, `
    UPDATE Chunk
    SET state = 6, agentId = NULL
    WHERE chunkId = ${chunkId} AND state = 2
  `);

  // Verify
  const verifyResult = execSQL(config, `SELECT state FROM Chunk WHERE chunkId = ${chunkId}`);
  const newState = parseInt(verifyResult);

  if (newState === 6) {
    console.log(`│ ✓ Chunk ${chunkId} aborted (orphaned - parent task archived)`);
    return true;
  } else {
    console.log(`│ ✗ Failed to abort chunk ${chunkId} (state=${newState})`);
    return false;
  }
}

async function detectStuckChunks(config: ServerConfig, minMinutes: number): Promise<StuckChunk[]> {
  // Find chunks that have been running > minMinutes with no progress change over 30s
  const candidates = execSQL(config, `
    SELECT c.chunkId, c.taskId, t.taskName, a.agentName, c.progress,
      TIMESTAMPDIFF(MINUTE, FROM_UNIXTIME(c.dispatchTime), NOW()) as minutes_running
    FROM Chunk c
    JOIN Task t ON c.taskId = t.taskId
    LEFT JOIN Agent a ON c.agentId = a.agentId
    WHERE c.state = 2
      AND c.dispatchTime > 0
      AND TIMESTAMPDIFF(MINUTE, FROM_UNIXTIME(c.dispatchTime), NOW()) >= ${minMinutes}
      AND t.isArchived = 0
    ORDER BY minutes_running DESC
  `);

  if (!candidates) return [];

  const chunks = candidates.split("\n").filter(Boolean).map(line => {
    const parts = line.split("\t");
    return {
      chunkId: parseInt(parts[0]),
      taskId: parseInt(parts[1]),
      taskName: parts[2],
      agentName: parts[3] || "unknown",
      progress: parseInt(parts[4]) || 0,
      minutesRunning: parseInt(parts[5]) || 0
    };
  });

  if (chunks.length === 0) return [];

  // Now check if each is actually stuck (progress not advancing)
  console.log(`│ Found ${chunks.length} long-running chunks. Checking for stagnation...`);

  const progressMap1 = new Map<number, number>();
  chunks.forEach(c => progressMap1.set(c.chunkId, c.progress));

  console.log(`│ Waiting 30 seconds to detect stagnation...`);
  await new Promise(resolve => setTimeout(resolve, 30000));

  const stuckChunks: StuckChunk[] = [];

  for (const chunk of chunks) {
    const progress2 = getChunkProgress(config, chunk.chunkId);
    const progress1 = progressMap1.get(chunk.chunkId) || 0;

    if (progress2 === progress1) {
      stuckChunks.push({ ...chunk, progress: progress2 });
    }
  }

  return stuckChunks;
}

// =============================================================================
// Agent Restart Function (Preferred Method)
// =============================================================================

function getAgentWorkerIp(config: ServerConfig, agentId: number): string | null {
  // Get agent's lastIp (private IP within VPC)
  const result = execSQL(config, `SELECT lastIp FROM Agent WHERE agentId = ${agentId}`);
  return result || null;
}

function getWorkerPublicIp(privateIp: string): string | null {
  // Query AWS for instance with this private IP
  const isWindows = process.platform === "win32";
  try {
    const awsCmd = `aws ec2 describe-instances --region us-west-2 --filters "Name=private-ip-address,Values=${privateIp}" --query "Reservations[*].Instances[*].PublicIpAddress" --output text`;
    const result = execSync(awsCmd, {
      encoding: "utf-8",
      timeout: 30000,
      shell: isWindows ? "C:\\Program Files\\Git\\bin\\bash.exe" : "/bin/bash",
      windowsHide: true,
    }).trim();
    return result && result !== "None" ? result : null;
  } catch (e) {
    return null;
  }
}

function restartAgentService(workerIp: string): boolean {
  // Restart hashtopolis-agent service on the worker
  console.log(`│ Restarting agent service on ${workerIp}...`);

  try {
    const sshCmd = `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 ubuntu@${workerIp} "sudo systemctl restart hashtopolis-agent"`;
    execSync(sshCmd, { encoding: "utf-8", timeout: 30000 });
    console.log(`│ ✓ Agent service restarted`);
    return true;
  } catch (e) {
    console.log(`│ ✗ Failed to restart agent: ${(e as Error).message}`);
    return false;
  }
}

async function restartAgentAndWaitForTimeout(
  config: ServerConfig,
  agentId: number,
  chunkId: number
): Promise<boolean> {
  // Step 1: Get agent's private IP
  const privateIp = getAgentWorkerIp(config, agentId);
  if (!privateIp) {
    console.log(`│ ✗ Could not get agent's private IP`);
    return false;
  }
  console.log(`│ Agent private IP: ${privateIp}`);

  // Step 2: Get worker's public IP for SSH
  const publicIp = getWorkerPublicIp(privateIp);
  if (!publicIp) {
    console.log(`│ ✗ Could not get worker's public IP`);
    return false;
  }
  console.log(`│ Worker public IP: ${publicIp}`);

  // Step 3: Restart agent service
  const restarted = restartAgentService(publicIp);
  if (!restarted) {
    return false;
  }

  // Step 4: Wait for Hashtopolis timeout (30s) + buffer
  console.log(`│ Waiting 45s for Hashtopolis timeout...`);
  await new Promise(resolve => setTimeout(resolve, 45000));

  // Step 5: Verify chunk was released
  const result = execSQL(config, `SELECT state FROM Chunk WHERE chunkId = ${chunkId}`);
  const newState = parseInt(result);

  if (newState !== 2) {
    console.log(`│ ✓ Chunk released (state=${newState})`);
    return true;
  } else {
    console.log(`│ ⚠ Chunk still DISPATCHED after agent restart`);
    return false;
  }
}

// =============================================================================
// Direct Abort Function (Fallback)
// =============================================================================

function abortChunkDirect(config: ServerConfig, chunkId: number, reason: string): boolean {
  console.log(`│ Direct abort: Setting chunk ${chunkId} to ABORTED...`);

  // Set state=6 (ABORTED) and clear agentId
  // This allows Hashtopolis to create a replacement chunk
  const result = execSQL(config, `
    UPDATE Chunk
    SET state = 6, agentId = NULL
    WHERE chunkId = ${chunkId} AND state = 2
  `);

  // Verify the abort succeeded
  const verifyResult = execSQL(config, `SELECT state FROM Chunk WHERE chunkId = ${chunkId}`);
  const newState = parseInt(verifyResult);

  if (newState === 6) {
    console.log(`│ ✓ Chunk ${chunkId} aborted successfully (state=6)`);
    console.log(`│ ✓ Reason: ${reason}`);
    console.log(`│ ✓ Hashtopolis will create replacement chunk automatically`);
    console.log(`│ ⚠ Note: Agent may crash (per Lesson #13)`);
    return true;
  } else {
    console.log(`│ ✗ Abort may have failed (state=${newState})`);
    return false;
  }
}

// =============================================================================
// Combined Resolution Function
// =============================================================================

async function resolveStuckChunk(
  config: ServerConfig,
  chunk: ChunkInfo,
  options: { directAbort: boolean }
): Promise<boolean> {
  const reason = `Stuck for ${chunk.minutesRunning} min, progress stagnant`;

  if (options.directAbort) {
    // User requested direct abort
    console.log(`│ Using DIRECT ABORT (--direct flag)`);
    return abortChunkDirect(config, chunk.chunkId, reason);
  }

  // Default: Try agent restart first
  console.log(`│ METHOD 1: Agent restart (preferred)`);

  if (chunk.agentId) {
    const success = await restartAgentAndWaitForTimeout(config, chunk.agentId, chunk.chunkId);
    if (success) {
      return true;
    }
    console.log(`│`);
    console.log(`│ METHOD 2: Direct abort (fallback)`);
  } else {
    console.log(`│ No agent assigned - using direct abort`);
  }

  return abortChunkDirect(config, chunk.chunkId, reason);
}

// =============================================================================
// Main Functions
// =============================================================================

async function checkAndAbortChunk(
  config: ServerConfig,
  chunkId: number,
  options: { doAbort: boolean; directAbort: boolean; minMinutes: number; waitSeconds: number }
): Promise<boolean> {
  console.log(`╭─────────────────────────────────────────────────────────────╮`);
  console.log(`│            SAFE CHUNK ABORT - Chunk ${chunkId}`.padEnd(62) + `│`);
  console.log(`╰─────────────────────────────────────────────────────────────╯`);
  console.log(``);

  // Get chunk info
  const chunk = getChunkInfo(config, chunkId);

  // Display chunk info
  if (chunk) {
    console.log(`┌─ CHUNK INFO ───────────────────────────────────────────────┐`);
    console.log(`│ Chunk ID: ${chunk.chunkId}`);
    console.log(`│ Task: ${chunk.taskName} (ID: ${chunk.taskId})`);
    console.log(`│ Agent: ${chunk.agentName || "none"} (ID: ${chunk.agentId || "none"})`);
    console.log(`│ Progress: ${(chunk.progress/100).toFixed(2)}%`);
    console.log(`│ Running: ${chunk.minutesRunning} minutes`);
    console.log(`│ State: ${chunk.state} (${chunk.state === 2 ? "DISPATCHED" : chunk.state === 4 ? "FINISHED" : chunk.state === 6 ? "ABORTED" : chunk.state === 9 ? "TRIMMED" : "OTHER"})`);
    console.log(`└────────────────────────────────────────────────────────────┘`);
    console.log(``);
  }

  // Run gates
  console.log(`┌─ SAFETY GATES ─────────────────────────────────────────────┐`);

  const gates: GateResult[] = [];

  // Gate A: Chunk exists and is DISPATCHED
  const gateA = runGateA(chunk);
  gates.push(gateA);
  console.log(`│ GATE A: ${gateA.passed ? "✓" : "✗"} ${gateA.message}`);

  if (!gateA.passed) {
    console.log(`└────────────────────────────────────────────────────────────┘`);
    console.log(`\n❌ ABORT BLOCKED: Gate A failed`);
    return false;
  }

  // Gate B: Minimum running time
  const gateB = runGateB(chunk!, options.minMinutes);
  gates.push(gateB);
  console.log(`│ GATE B: ${gateB.passed ? "✓" : "✗"} ${gateB.message}`);

  if (!gateB.passed) {
    console.log(`└────────────────────────────────────────────────────────────┘`);
    console.log(`\n❌ ABORT BLOCKED: Gate B failed (chunk not old enough)`);
    return false;
  }

  // Gate C: Progress stagnation (async)
  const gateC = await runGateC(config, chunkId, options.waitSeconds);
  gates.push(gateC);
  console.log(`│ GATE C: ${gateC.passed ? "✓" : "✗"} ${gateC.message}`);

  if (!gateC.passed) {
    console.log(`└────────────────────────────────────────────────────────────┘`);
    console.log(`\n❌ ABORT BLOCKED: Gate C failed (chunk is still progressing)`);
    return false;
  }

  // Gate D: Task health
  const gateD = runGateD(chunk!);
  gates.push(gateD);
  console.log(`│ GATE D: ${gateD.passed ? "✓" : "✗"} ${gateD.message}`);

  if (!gateD.passed) {
    console.log(`└────────────────────────────────────────────────────────────┘`);
    console.log(`\n❌ ABORT BLOCKED: Gate D failed`);
    return false;
  }

  console.log(`└────────────────────────────────────────────────────────────┘`);
  console.log(``);
  console.log(`✓ ALL GATES PASSED - Chunk ${chunkId} is confirmed STUCK`);
  console.log(``);

  // Perform resolution if requested
  if (options.doAbort) {
    console.log(`┌─ RESOLVING STUCK CHUNK ────────────────────────────────────┐`);
    const success = await resolveStuckChunk(config, chunk!, { directAbort: options.directAbort });
    console.log(`└────────────────────────────────────────────────────────────┘`);

    if (success) {
      console.log(`\n✓ Chunk ${chunkId} resolved. Hashtopolis will self-heal.`);
      console.log(`  Monitor with: bun Tools/PipelineMonitor.ts --quick`);
    }
    return success;
  } else {
    console.log(`┌─ DRY RUN ──────────────────────────────────────────────────┐`);
    console.log(`│ Chunk ${chunkId} is confirmed STUCK.`);
    console.log(`│`);
    console.log(`│ Resolution options:`);
    console.log(`│   --abort          Try agent restart, fallback to direct abort`);
    console.log(`│   --abort --direct Skip agent restart, abort chunk directly`);
    console.log(`│`);
    console.log(`│ Example:`);
    console.log(`│   bun Tools/SafeChunkAbort.ts --chunk ${chunkId} --abort`);
    console.log(`└────────────────────────────────────────────────────────────┘`);
    return true;
  }
}

async function detectAndAbort(
  config: ServerConfig,
  options: { doAbort: boolean; directAbort: boolean; minMinutes: number }
): Promise<void> {
  console.log(`╭─────────────────────────────────────────────────────────────╮`);
  console.log(`│            SAFE CHUNK ABORT - Auto Detection                │`);
  console.log(`╰─────────────────────────────────────────────────────────────╯`);
  console.log(``);

  // First: Check for orphaned chunks (running chunks with archived parent tasks)
  console.log(`┌─ ORPHANED CHUNK DETECTION ──────────────────────────────────┐`);
  console.log(`│ Looking for orphaned chunks (archived tasks with running chunks)...`);

  const orphanedChunks = detectOrphanedChunks(config);

  if (orphanedChunks.length > 0) {
    console.log(`│`);
    console.log(`│ Found ${orphanedChunks.length} ORPHANED chunk(s):`);
    for (const chunk of orphanedChunks) {
      console.log(`│   - Chunk ${chunk.chunkId}: ${chunk.taskName} on ${chunk.agentName}`);
      console.log(`│     Running ${chunk.minutesRunning} min (TASK ARCHIVED - should not be running)`);
    }
    console.log(`└────────────────────────────────────────────────────────────┘`);
    console.log(``);

    if (options.doAbort) {
      console.log(`┌─ RESOLVING ORPHANED CHUNKS ───────────────────────────────┐`);
      let resolved = 0;
      for (const chunk of orphanedChunks) {
        const success = abortOrphanedChunk(config, chunk.chunkId, chunk.taskName);
        if (success) resolved++;
      }
      console.log(`└────────────────────────────────────────────────────────────┘`);
      console.log(`\n✓ Resolved ${resolved}/${orphanedChunks.length} orphaned chunk(s).`);
      console.log(``);
    } else {
      console.log(`┌─ DRY RUN (ORPHANED) ──────────────────────────────────────┐`);
      console.log(`│ Found ${orphanedChunks.length} orphaned chunk(s).`);
      console.log(`│ Use --abort to resolve them.`);
      console.log(`└────────────────────────────────────────────────────────────┘`);
      console.log(``);
    }
  } else {
    console.log(`│ ✓ No orphaned chunks detected`);
    console.log(`└────────────────────────────────────────────────────────────┘`);
    console.log(``);
  }

  // Second: Check for stuck chunks (normal detection)
  console.log(`┌─ STUCK CHUNK DETECTION ─────────────────────────────────────┐`);
  console.log(`│ Minimum age: ${options.minMinutes} minutes`);
  console.log(`│ Looking for stuck chunks...`);

  const stuckChunks = await detectStuckChunks(config, options.minMinutes);

  if (stuckChunks.length === 0 && orphanedChunks.length === 0) {
    console.log(`│ ✓ No stuck chunks detected`);
    console.log(`└────────────────────────────────────────────────────────────┘`);
    return;
  }

  if (stuckChunks.length === 0) {
    console.log(`│ ✓ No stuck chunks detected`);
    console.log(`└────────────────────────────────────────────────────────────┘`);
    return;
  }

  console.log(`│`);
  console.log(`│ Found ${stuckChunks.length} STUCK chunk(s):`);
  for (const chunk of stuckChunks) {
    console.log(`│   - Chunk ${chunk.chunkId}: ${chunk.taskName} on ${chunk.agentName}`);
    console.log(`│     Running ${chunk.minutesRunning} min, stuck at ${(chunk.progress/100).toFixed(2)}%`);
  }
  console.log(`└────────────────────────────────────────────────────────────┘`);
  console.log(``);

  if (options.doAbort) {
    console.log(`┌─ RESOLVING STUCK CHUNKS ───────────────────────────────────┐`);
    let resolved = 0;
    for (const chunk of stuckChunks) {
      // Get full chunk info for resolveStuckChunk
      const fullChunk = getChunkInfo(config, chunk.chunkId);
      if (fullChunk) {
        console.log(`│`);
        console.log(`│ Chunk ${chunk.chunkId} (${chunk.taskName}):`);
        const success = await resolveStuckChunk(config, fullChunk, { directAbort: options.directAbort });
        if (success) {
          resolved++;
        } else {
          console.log(`│ ⚠ Failed to resolve chunk ${chunk.chunkId}`);
        }
      }
    }
    console.log(`└────────────────────────────────────────────────────────────┘`);
    console.log(`\n✓ Resolved ${resolved}/${stuckChunks.length} stuck chunk(s). Hashtopolis will self-heal.`);
  } else {
    console.log(`┌─ DRY RUN ──────────────────────────────────────────────────┐`);
    console.log(`│ Found ${stuckChunks.length} stuck chunk(s).`);
    console.log(`│`);
    console.log(`│ Resolution options:`);
    console.log(`│   --abort          Try agent restart, fallback to direct abort`);
    console.log(`│   --abort --direct Skip agent restart, abort chunk directly`);
    console.log(`│`);
    console.log(`│ Example:`);
    console.log(`│   bun Tools/SafeChunkAbort.ts --detect --abort`);
    console.log(`└────────────────────────────────────────────────────────────┘`);
  }
}

// =============================================================================
// CLI
// =============================================================================

if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
SafeChunkAbort - Safely resolve stuck and orphaned chunks

PURPOSE:
  Addresses two Hashtopolis edge cases:

  1. STUCK CHUNKS - Chunks with crackPos NULL errors that don't auto-timeout
     (agent keeps communicating, resetting timeout clock).

  2. ORPHANED CHUNKS - Running chunks whose parent task is ARCHIVED.
     These occur when a task is archived while chunks are still processing.
     The --detect flag automatically finds and handles both types.

RESOLUTION METHODS:
  1. AGENT RESTART (default) - Restarts the agent service on the worker
     - Agent stops communicating → 30s Hashtopolis timeout → chunk released
     - Safer: Hashtopolis handles the transition properly
     - Agent comes back online and picks up new work

  2. DIRECT ABORT (--direct) - Sets chunk state=6 directly in database
     - Fallback when agent restart fails
     - May cause agent crash (per Lesson #13)
     - Hashtopolis creates replacement chunk

USAGE:
  bun SafeChunkAbort.ts --chunk <id>                Check chunk (dry-run)
  bun SafeChunkAbort.ts --chunk <id> --abort        Resolve using agent restart
  bun SafeChunkAbort.ts --chunk <id> --abort --direct   Skip restart, abort directly
  bun SafeChunkAbort.ts --detect                    Find stuck chunks (dry-run)
  bun SafeChunkAbort.ts --detect --abort            Resolve all stuck chunks

OPTIONS:
  --chunk <id>       Target specific chunk ID
  --detect           Auto-detect stuck chunks (>15 min, no progress)
  --abort            Actually resolve the stuck chunk (default is dry-run)
  --direct           Skip agent restart, abort chunk directly (fallback method)
  --min-minutes <n>  Minimum runtime before considering stuck (default: 15)
  --wait-seconds <n> Progress check window (default: 30)

SAFETY GATES:
  GATE A: Chunk must exist and be in DISPATCHED state (state=2)
  GATE B: Chunk must have been running for minimum time (default 15 min)
  GATE C: Progress must NOT be advancing (verified over 30s window)
  GATE D: Parent task must be healthy (not archived, has keyspace)

AFTER RESOLUTION:
  Hashtopolis automatically:
  - Creates new chunk for remaining keyspace
  - Assigns work to available agents

EXAMPLES:
  # Check if chunk 2399 is stuck (dry-run)
  bun SafeChunkAbort.ts --chunk 2399

  # Resolve chunk 2399 (try agent restart first, fallback to direct abort)
  bun SafeChunkAbort.ts --chunk 2399 --abort

  # Resolve chunk 2399 with direct abort only (skip agent restart)
  bun SafeChunkAbort.ts --chunk 2399 --abort --direct

  # Find all stuck chunks
  bun SafeChunkAbort.ts --detect

  # Resolve all stuck chunks
  bun SafeChunkAbort.ts --detect --abort

  # Use longer minimum runtime (30 min) before considering stuck
  bun SafeChunkAbort.ts --detect --min-minutes 30 --abort
`);
    process.exit(0);
  }

  const config = getServerConfig();

  const doAbort = args.includes("--abort");
  const doDetect = args.includes("--detect");
  const directAbort = args.includes("--direct");

  // Parse --min-minutes
  let minMinutes = 15;
  const minIdx = args.indexOf("--min-minutes");
  if (minIdx !== -1 && args[minIdx + 1]) {
    minMinutes = parseInt(args[minIdx + 1]) || 15;
  }

  // Parse --wait-seconds
  let waitSeconds = 30;
  const waitIdx = args.indexOf("--wait-seconds");
  if (waitIdx !== -1 && args[waitIdx + 1]) {
    waitSeconds = parseInt(args[waitIdx + 1]) || 30;
  }

  // Parse --chunk
  const chunkIdx = args.indexOf("--chunk");
  const chunkId = chunkIdx !== -1 && args[chunkIdx + 1] ? parseInt(args[chunkIdx + 1]) : null;

  try {
    if (doDetect) {
      await detectAndAbort(config, { doAbort, directAbort, minMinutes });
    } else if (chunkId) {
      await checkAndAbortChunk(config, chunkId, { doAbort, directAbort, minMinutes, waitSeconds });
    } else {
      console.error("Specify --chunk <id> or --detect");
      console.error("Run with --help for usage information");
      process.exit(1);
    }
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
  }
}
