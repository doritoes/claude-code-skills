#!/usr/bin/env bun
/**
 * AgentManager.ts - Agent-to-Instance Mapping and Health Management
 *
 * Provides reliable mapping between Hashtopolis agents and AWS EC2 instances,
 * with automatic health monitoring and remediation.
 *
 * LESSON LEARNED: Confusing agent IDs with instance IDs wasted significant time.
 * This tool provides deterministic mapping via private IP address.
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
// Types
// =============================================================================

interface AgentInfo {
  agentId: number;
  agentName: string;
  privateIp: string;
  instanceId: string | null;
  publicIp: string | null;
  lastAct: string;
  secAgo: number;
  chunks: number;
  status: "healthy" | "idle" | "stale" | "critical" | "unknown";
}

interface ServerConfig {
  serverIp: string;
  dbPassword: string;
  sshUser: string;
  awsRegion: string;
}

// =============================================================================
// Configuration
// =============================================================================

function getServerConfig(): ServerConfig {
  const terraformDir = resolve(HASHCRACK_DIR, "terraform", "aws");

  try {
    const serverIp = execSync(`terraform output -raw server_ip`, {
      encoding: "utf-8",
      cwd: terraformDir,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    const dbPassword = execSync(`terraform output -raw db_password`, {
      encoding: "utf-8",
      cwd: terraformDir,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return { serverIp, dbPassword, sshUser: "ubuntu", awsRegion: "us-west-2" };
  } catch (e) {
    return {
      serverIp: "16.147.88.9",
      dbPassword: "NJyf6IviJRC1jYQ0u57tRuCm",
      sshUser: "ubuntu",
      awsRegion: "us-west-2",
    };
  }
}

function execSQL(config: ServerConfig, sql: string): string {
  const cleanSql = sql.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
  const b64Sql = Buffer.from(cleanSql).toString("base64");

  // Use PowerShell on Windows, bash on Unix
  const isWindows = process.platform === "win32";
  const sshCmd = `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=15 ${config.sshUser}@${config.serverIp} "echo ${b64Sql} | base64 -d | sudo docker exec -i hashtopolis-db mysql -u hashtopolis -p'${config.dbPassword}' hashtopolis -sN"`;

  try {
    if (isWindows) {
      // On Windows, use PowerShell to run SSH
      return execSync(sshCmd, {
        encoding: "utf-8",
        timeout: 45000,
        shell: "C:\\Program Files\\Git\\bin\\bash.exe",
        windowsHide: true,
      }).trim();
    } else {
      return execSync(sshCmd, {
        encoding: "utf-8",
        timeout: 45000,
        shell: "/bin/bash"
      }).trim();
    }
  } catch (e) {
    console.error("SQL error:", (e as Error).message);
    return "";
  }
}

// =============================================================================
// Instance Mapping (via AWS CLI)
// =============================================================================

interface InstanceInfo {
  instanceId: string;
  privateIp: string;
  publicIp: string;
  state: string;
}

function getInstancesByPrivateIp(region: string): Map<string, InstanceInfo> {
  const map = new Map<string, InstanceInfo>();
  const isWindows = process.platform === "win32";

  try {
    const awsCmd = `aws ec2 describe-instances --region ${region} --filters "Name=tag:Name,Values=*gpu*" --query "Reservations[*].Instances[*].[InstanceId,PrivateIpAddress,PublicIpAddress,State.Name]" --output text`;
    const result = execSync(awsCmd, {
      encoding: "utf-8",
      timeout: 45000,
      shell: isWindows ? "C:\\Program Files\\Git\\bin\\bash.exe" : "/bin/bash",
      windowsHide: true,
    }).trim();

    for (const line of result.split("\n")) {
      const [instanceId, privateIp, publicIp, state] = line.split("\t");
      if (privateIp && privateIp !== "None") {
        map.set(privateIp, {
          instanceId,
          privateIp,
          publicIp: publicIp === "None" ? "" : publicIp,
          state,
        });
      }
    }
  } catch (e) {
    console.error("AWS query error:", (e as Error).message);
  }

  return map;
}

// =============================================================================
// Agent Health
// =============================================================================

const STALE_THRESHOLD_SEC = 120; // 2 minutes = stale
const CRITICAL_THRESHOLD_SEC = 300; // 5 minutes = critical

function getAgentStatus(secAgo: number, chunks: number): "healthy" | "idle" | "stale" | "critical" {
  if (secAgo >= CRITICAL_THRESHOLD_SEC) return "critical";
  if (secAgo >= STALE_THRESHOLD_SEC) return "stale";
  // Agent is responsive but has no work
  if (chunks === 0) return "idle";
  return "healthy";
}

async function getAllAgents(config: ServerConfig): Promise<AgentInfo[]> {
  const result = execSQL(
    config,
    `SELECT a.agentId, a.agentName, a.lastIp, a.lastAct,
       TIMESTAMPDIFF(SECOND, FROM_UNIXTIME(a.lastTime), NOW()) as sec_ago,
       (SELECT COUNT(*) FROM Chunk c WHERE c.agentId=a.agentId AND c.state=2) as chunks
     FROM Agent a ORDER BY a.agentId`
  );

  if (!result) return [];

  // Get instance mapping
  const instanceMap = getInstancesByPrivateIp(config.awsRegion);

  const agents: AgentInfo[] = [];
  for (const line of result.split("\n")) {
    const [agentId, agentName, privateIp, lastAct, secAgo, chunks] = line.split("\t");
    const instance = instanceMap.get(privateIp);

    const chunkCount = parseInt(chunks);
    agents.push({
      agentId: parseInt(agentId),
      agentName,
      privateIp,
      instanceId: instance?.instanceId || null,
      publicIp: instance?.publicIp || null,
      lastAct,
      secAgo: parseInt(secAgo),
      chunks: chunkCount,
      status: getAgentStatus(parseInt(secAgo), chunkCount),
    });
  }

  return agents;
}

// =============================================================================
// Remediation Actions
// =============================================================================

function freeAgentChunks(config: ServerConfig, agentId: number): void {
  console.log(`  Freeing chunks for agent ${agentId}...`);
  execSQL(config, `UPDATE Chunk SET state=6, agentId=NULL WHERE agentId=${agentId} AND state=2`);
}

function rebootInstance(instanceId: string, region: string): boolean {
  console.log(`  Rebooting instance ${instanceId}...`);
  const isWindows = process.platform === "win32";
  try {
    execSync(`aws ec2 reboot-instances --instance-ids ${instanceId} --region ${region}`, {
      encoding: "utf-8",
      timeout: 45000,
      shell: isWindows ? "C:\\Program Files\\Git\\bin\\bash.exe" : "/bin/bash",
      windowsHide: true,
    });
    return true;
  } catch (e) {
    console.error(`  Failed to reboot: ${(e as Error).message}`);
    return false;
  }
}

async function remediateAgent(config: ServerConfig, agent: AgentInfo): Promise<void> {
  console.log(`\nRemediating agent ${agent.agentId} (${agent.agentName}):`);
  console.log(`  Status: ${agent.status}, Last seen: ${agent.secAgo}s ago`);

  // Step 1: Free any stuck chunks
  if (agent.chunks > 0) {
    freeAgentChunks(config, agent.agentId);
  }

  // Step 2: Reboot instance if we have the ID
  if (agent.instanceId) {
    rebootInstance(agent.instanceId, config.awsRegion);
  } else {
    console.log(`  ⚠️  Cannot reboot - no instance ID found for IP ${agent.privateIp}`);
  }
}

// =============================================================================
// Main Functions
// =============================================================================

async function showAgentStatus(): Promise<void> {
  const config = getServerConfig();
  const agents = await getAllAgents(config);

  console.log("╭────────────────────────────────────────────────────────────────────────────╮");
  console.log("│                        AGENT STATUS                                        │");
  console.log("╰────────────────────────────────────────────────────────────────────────────╯");
  console.log("");
  console.log("Agent │ Name                   │ Instance            │ Sec Ago │ Chunks │ Status");
  console.log("──────┼────────────────────────┼─────────────────────┼─────────┼────────┼────────");

  for (const agent of agents) {
    const statusIcon =
      agent.status === "healthy" ? "✓" :
      agent.status === "idle" ? "○" :
      agent.status === "stale" ? "⚠" : "✗";
    const statusColor =
      agent.status === "healthy" ? "\x1b[32m" :
      agent.status === "idle" ? "\x1b[36m" :  // cyan for idle
      agent.status === "stale" ? "\x1b[33m" :
      "\x1b[31m";

    console.log(
      `${String(agent.agentId).padStart(5)} │ ${agent.agentName.padEnd(22)} │ ${(agent.instanceId || "???").padEnd(19)} │ ${String(agent.secAgo).padStart(7)} │ ${String(agent.chunks).padStart(6)} │ ${statusColor}${statusIcon} ${agent.status}\x1b[0m`
    );
  }

  // Summary
  const healthy = agents.filter((a) => a.status === "healthy").length;
  const idle = agents.filter((a) => a.status === "idle").length;
  const stale = agents.filter((a) => a.status === "stale").length;
  const critical = agents.filter((a) => a.status === "critical").length;
  const totalChunks = agents.reduce((sum, a) => sum + a.chunks, 0);

  console.log("");
  console.log(`Summary: ${healthy} healthy, ${idle} idle, ${stale} stale, ${critical} critical | ${totalChunks}/8 chunks active`);

  if (idle > 0) {
    console.log(`\x1b[36m⚠️  ${idle} agent(s) healthy but no work - check for keyspace=0 tasks or work availability\x1b[0m`);
  }

  if (stale + critical > 0) {
    console.log("");
    console.log("Run with --fix to automatically remediate stale/critical agents");
  }
}

async function fixStaleAgents(): Promise<void> {
  const config = getServerConfig();
  const agents = await getAllAgents(config);

  // Only remediate stale/critical agents - idle agents are fine (just waiting for work)
  const problemAgents = agents.filter((a) => a.status === "stale" || a.status === "critical");

  if (problemAgents.length === 0) {
    console.log("All agents are healthy or idle. No remediation needed.");
    return;
  }

  console.log(`Found ${problemAgents.length} stale/critical agents needing remediation:`);

  for (const agent of problemAgents) {
    await remediateAgent(config, agent);
  }

  console.log("\nRemediation complete. Wait 2-3 minutes for agents to recover.");
}

async function watchLoop(): Promise<void> {
  const config = getServerConfig();

  console.log("╭────────────────────────────────────────────────────────────────────────────╮");
  console.log("│                    AUTONOMOUS AGENT MONITOR                                │");
  console.log("│  Checking every 60s, auto-remediating agents stale >2min                   │");
  console.log("╰────────────────────────────────────────────────────────────────────────────╯");
  console.log("");

  const runCycle = async () => {
    const timestamp = new Date().toLocaleTimeString();
    const agents = await getAllAgents(config);

    const healthy = agents.filter((a) => a.status === "healthy").length;
    const idle = agents.filter((a) => a.status === "idle").length;
    const stale = agents.filter((a) => a.status === "stale").length;
    const critical = agents.filter((a) => a.status === "critical").length;
    const totalChunks = agents.reduce((sum, a) => sum + a.chunks, 0);

    // Check for problems (stale/critical need attention, idle is a warning)
    const problemAgents = agents.filter((a) => a.status === "stale" || a.status === "critical");
    const idleAgents = agents.filter((a) => a.status === "idle");

    let statusLine = `[${timestamp}] Agents: ${healthy + idle}/8 | Chunks: ${totalChunks}/8`;

    if (problemAgents.length > 0) {
      console.log(`\x1b[31m${statusLine} | PROBLEMS DETECTED\x1b[0m`);

      for (const agent of problemAgents) {
        console.log(`  ⚠️  Agent ${agent.agentId} (${agent.agentName}): ${agent.status} - ${agent.secAgo}s ago`);

        // Auto-remediate critical agents
        if (agent.status === "critical") {
          await remediateAgent(config, agent);
        }
      }
    } else if (idleAgents.length > 0) {
      console.log(`\x1b[36m${statusLine} | ${idle} IDLE\x1b[0m`);
      for (const agent of idleAgents) {
        console.log(`  ○ Agent ${agent.agentId} (${agent.agentName}): healthy but no work`);
      }
      // Check for uninitialized tasks that might explain idle agents
      const uninitCount = execSQL(config, "SELECT COUNT(*) FROM Task WHERE keyspace=0 AND isArchived=0");
      if (uninitCount && parseInt(uninitCount) > 0) {
        console.log(`  → ${uninitCount} tasks with keyspace=0 - check agents are alive and files accessible`);
      }
    } else {
      console.log(statusLine);
    }
  };

  // Run immediately, then every 60 seconds
  await runCycle();
  setInterval(runCycle, 60000);
}

// =============================================================================
// CLI
// =============================================================================

if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
AgentManager - Agent-to-Instance Mapping and Health Management

Usage:
  bun AgentManager.ts              Show agent status with instance mapping
  bun AgentManager.ts --fix        Remediate stale/critical agents
  bun AgentManager.ts --watch      Continuous monitoring with auto-fix

Thresholds:
  Stale: >2 minutes since last contact
  Critical: >5 minutes (auto-remediated in watch mode)

Remediation:
  1. Free stuck chunks (SET state=6, agentId=NULL)
  2. Reboot EC2 instance
`);
    process.exit(0);
  }

  if (args.includes("--fix")) {
    fixStaleAgents();
  } else if (args.includes("--watch")) {
    watchLoop();
  } else {
    showAgentStatus();
  }
}
