#!/usr/bin/env bun
/**
 * ServerHealthCheck.ts - Proactive Server Health Monitoring
 *
 * Monitors Hashtopolis server health to prevent unresponsiveness:
 * - Memory usage (CRITICAL: >80% triggers warning, >90% triggers alert)
 * - Disk usage (>80% triggers warning)
 * - Docker container status
 * - MySQL database health
 *
 * ROOT CAUSE (from Algorithm investigation):
 * hashtopolis-backend uses ~3GB RAM (Apache workers), leaving <400MB free
 * on t3.medium (4GB). System hangs before OOM killer activates.
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

// Thresholds
const MEMORY_WARNING_PERCENT = 80;
const MEMORY_CRITICAL_PERCENT = 90;
const DISK_WARNING_PERCENT = 80;
const DISK_CRITICAL_PERCENT = 95;

interface HealthStatus {
  serverIp: string;
  memoryPercent: number;
  memoryUsedMB: number;
  memoryTotalMB: number;
  diskPercent: number;
  diskUsedGB: number;
  diskTotalGB: number;
  dockerStatus: { name: string; status: string }[];
  dbConnections: number;
  alerts: string[];
  warnings: string[];
  healthy: boolean;
}

// =============================================================================
// Configuration
// =============================================================================

function getServerConfig(): { serverIp: string; dbPassword: string } {
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
    return { serverIp, dbPassword };
  } catch (e) {
    // Try to get from AWS if terraform fails
    try {
      const ip = execSync(
        `aws ec2 describe-instances --instance-ids i-0eaf169037648f0ed --region us-west-2 --query "Reservations[*].Instances[*].PublicIpAddress" --output text`,
        { encoding: "utf-8" }
      ).trim();
      return { serverIp: ip, dbPassword: "NJyf6IviJRC1jYQ0u57tRuCm" };
    } catch {
      throw new Error("Cannot determine server IP");
    }
  }
}

function execSSH(serverIp: string, command: string): string {
  const isWindows = process.platform === "win32";
  const sshCmd = `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=15 ubuntu@${serverIp} "${command}"`;
  try {
    return execSync(sshCmd, {
      encoding: "utf-8",
      timeout: 30000,
      shell: isWindows ? "C:\Program Files\Git\bin\bash.exe" : "/bin/bash",
      windowsHide: true,
    }).trim();
  } catch (e) {
    throw new Error(`SSH failed: ${(e as Error).message}`);
  }
}

// =============================================================================
// Health Checks
// =============================================================================

async function checkHealth(): Promise<HealthStatus> {
  const config = getServerConfig();
  const alerts: string[] = [];
  const warnings: string[] = [];

  // Memory check
  const memInfo = execSSH(config.serverIp, "free -m | grep Mem");
  const memParts = memInfo.split(/\s+/);
  const memoryTotalMB = parseInt(memParts[1]);
  const memoryUsedMB = parseInt(memParts[2]);
  const memoryPercent = Math.round((memoryUsedMB / memoryTotalMB) * 100);

  if (memoryPercent >= MEMORY_CRITICAL_PERCENT) {
    alerts.push(`CRITICAL: Memory ${memoryPercent}% (${memoryUsedMB}MB/${memoryTotalMB}MB)`);
  } else if (memoryPercent >= MEMORY_WARNING_PERCENT) {
    warnings.push(`WARNING: Memory ${memoryPercent}% (${memoryUsedMB}MB/${memoryTotalMB}MB)`);
  }

  // Disk check
  const diskInfo = execSSH(config.serverIp, "df -BG / | tail -1");
  const diskParts = diskInfo.split(/\s+/);
  const diskTotalGB = parseInt(diskParts[1].replace("G", ""));
  const diskUsedGB = parseInt(diskParts[2].replace("G", ""));
  const diskPercent = parseInt(diskParts[4].replace("%", ""));

  if (diskPercent >= DISK_CRITICAL_PERCENT) {
    alerts.push(`CRITICAL: Disk ${diskPercent}% (${diskUsedGB}GB/${diskTotalGB}GB)`);
  } else if (diskPercent >= DISK_WARNING_PERCENT) {
    warnings.push(`WARNING: Disk ${diskPercent}% (${diskUsedGB}GB/${diskTotalGB}GB)`);
  }

  // Docker status
  const dockerInfo = execSSH(
    config.serverIp,
    "sudo docker ps --format '{{.Names}}|{{.Status}}'"
  );
  const dockerStatus = dockerInfo.split("\n").map((line) => {
    const [name, status] = line.split("|");
    return { name, status };
  });

  // Check for unhealthy or stopped containers
  for (const container of dockerStatus) {
    if (!container.status.includes("Up")) {
      alerts.push(`Container ${container.name} not running: ${container.status}`);
    } else if (container.status.includes("unhealthy")) {
      warnings.push(`Container ${container.name} unhealthy`);
    }
  }

  // Expected containers
  const expectedContainers = ["hashtopolis-backend", "hashtopolis-frontend", "hashtopolis-db"];
  for (const expected of expectedContainers) {
    if (!dockerStatus.find((c) => c.name === expected)) {
      alerts.push(`Missing container: ${expected}`);
    }
  }

  // DB connections check
  let dbConnections = 0;
  try {
    const connResult = execSSH(
      config.serverIp,
      `sudo docker exec hashtopolis-db mysql -u hashtopolis -p'${config.dbPassword}' -sNe "SELECT COUNT(*) FROM information_schema.processlist WHERE user='hashtopolis'"`
    );
    dbConnections = parseInt(connResult) || 0;
    if (dbConnections > 50) {
      warnings.push(`High DB connections: ${dbConnections}`);
    }
  } catch {
    // DB check failed
    warnings.push("Could not check DB connections");
  }

  const healthy = alerts.length === 0;

  return {
    serverIp: config.serverIp,
    memoryPercent,
    memoryUsedMB,
    memoryTotalMB,
    diskPercent,
    diskUsedGB,
    diskTotalGB,
    dockerStatus,
    dbConnections,
    alerts,
    warnings,
    healthy,
  };
}

function displayHealth(status: HealthStatus): void {
  console.log("╭────────────────────────────────────────────────────────────────────────────╮");
  console.log("│                     SERVER HEALTH CHECK                                    │");
  console.log("╰────────────────────────────────────────────────────────────────────────────╯");
  console.log("");
  console.log(`Server: ${status.serverIp}`);
  console.log("");

  // Memory
  const memColor =
    status.memoryPercent >= MEMORY_CRITICAL_PERCENT
      ? "\x1b[31m" // red
      : status.memoryPercent >= MEMORY_WARNING_PERCENT
        ? "\x1b[33m" // yellow
        : "\x1b[32m"; // green
  console.log(
    `Memory: ${memColor}${status.memoryPercent}%\x1b[0m (${status.memoryUsedMB}MB / ${status.memoryTotalMB}MB)`
  );

  // Disk
  const diskColor =
    status.diskPercent >= DISK_CRITICAL_PERCENT
      ? "\x1b[31m"
      : status.diskPercent >= DISK_WARNING_PERCENT
        ? "\x1b[33m"
        : "\x1b[32m";
  console.log(
    `Disk:   ${diskColor}${status.diskPercent}%\x1b[0m (${status.diskUsedGB}GB / ${status.diskTotalGB}GB)`
  );

  // Docker
  console.log("\nDocker Containers:");
  for (const container of status.dockerStatus) {
    const statusIcon = container.status.includes("Up") ? "✓" : "✗";
    const color = container.status.includes("Up") ? "\x1b[32m" : "\x1b[31m";
    console.log(`  ${color}${statusIcon}\x1b[0m ${container.name}: ${container.status}`);
  }

  // DB
  console.log(`\nDB Connections: ${status.dbConnections}`);

  // Alerts and warnings
  if (status.alerts.length > 0) {
    console.log("\n\x1b[31m═══ ALERTS ═══\x1b[0m");
    for (const alert of status.alerts) {
      console.log(`  \x1b[31m✗ ${alert}\x1b[0m`);
    }
  }

  if (status.warnings.length > 0) {
    console.log("\n\x1b[33m═══ WARNINGS ═══\x1b[0m");
    for (const warning of status.warnings) {
      console.log(`  \x1b[33m⚠ ${warning}\x1b[0m`);
    }
  }

  // Overall status
  console.log("");
  if (status.healthy) {
    console.log("\x1b[32m✓ Server is healthy\x1b[0m");
  } else {
    console.log("\x1b[31m✗ Server has issues - action required!\x1b[0m");
  }
}

async function watchLoop(): Promise<void> {
  console.log("Starting health monitoring (Ctrl+C to stop)...\n");

  const runCheck = async () => {
    const timestamp = new Date().toLocaleTimeString();
    try {
      const status = await checkHealth();

      if (!status.healthy || status.warnings.length > 0) {
        console.log(`\n[${timestamp}] Health check:`);
        displayHealth(status);
      } else {
        console.log(
          `[${timestamp}] OK - Memory: ${status.memoryPercent}%, Disk: ${status.diskPercent}%, Docker: ${status.dockerStatus.length}/3 up`
        );
      }
    } catch (e) {
      console.log(`\x1b[31m[${timestamp}] Health check failed: ${(e as Error).message}\x1b[0m`);
    }
  };

  await runCheck();
  setInterval(runCheck, 300000); // Every 5 minutes
}

// =============================================================================
// CLI
// =============================================================================

if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
ServerHealthCheck - Monitor Hashtopolis server health

Usage:
  bun ServerHealthCheck.ts              Single health check
  bun ServerHealthCheck.ts --watch      Continuous monitoring (5 min interval)
  bun ServerHealthCheck.ts --json       Output as JSON

Checks:
  - Memory usage (warn >80%, critical >90%)
  - Disk usage (warn >80%, critical >95%)
  - Docker container status
  - MySQL database connections

ROOT CAUSE NOTE:
  hashtopolis-backend uses ~3GB RAM (Apache workers).
  On t3.medium (4GB), this causes system hangs when memory fills.
  Consider upgrading to t3.large (8GB) if issues persist.
`);
    process.exit(0);
  }

  try {
    if (args.includes("--watch")) {
      watchLoop();
    } else {
      const status = await checkHealth();
      if (args.includes("--json")) {
        console.log(JSON.stringify(status, null, 2));
      } else {
        displayHealth(status);
      }
      process.exit(status.healthy ? 0 : 1);
    }
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
  }
}
