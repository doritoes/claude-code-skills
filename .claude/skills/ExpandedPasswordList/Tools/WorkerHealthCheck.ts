#!/usr/bin/env bun
/**
 * WorkerHealthCheck.ts - Worker Disk Space and Health Monitoring
 *
 * Monitors GPU worker disk space, hashlist accumulation, and overall health.
 * Gets fresh public IPs from AWS CLI to handle IP changes on reboot.
 *
 * Key directories monitored:
 * - /opt/hashtopolis-agent/hashlists/ - Downloaded hash files
 * - /opt/hashtopolis-agent/*.pot - Cracked results (synced to server)
 * - /tmp/ - Temporary files
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CURRENT_FILE = fileURLToPath(import.meta.url);
const SKILL_DIR = dirname(dirname(CURRENT_FILE));
const ENV_PATH = resolve(dirname(SKILL_DIR), "..", ".env");

// =============================================================================
// Configuration
// =============================================================================

const DISK_WARN_THRESHOLD = 70; // percent
const DISK_CRITICAL_THRESHOLD = 85; // percent
const AWS_REGION = "us-west-2";

interface WorkerInfo {
  name: string;
  instanceId: string;
  publicIp: string;
  privateIp: string;
}

interface WorkerHealth {
  name: string;
  ip: string;
  reachable: boolean;
  diskPercent: number;
  diskUsed: string;
  diskTotal: string;
  diskAvail: string;
  hashlistSize: string;
  hashlistCount: number;
  potSize: string;
  tmpSize: string;
  status: "healthy" | "warning" | "critical" | "unreachable";
}

// =============================================================================
// Environment Loading
// =============================================================================

function loadEnv(): Record<string, string> {
  if (!existsSync(ENV_PATH)) {
    return {};
  }
  const content = readFileSync(ENV_PATH, "utf-8");
  const env: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) {
      env[match[1].trim()] = match[2].trim();
    }
  }
  return env;
}

// =============================================================================
// AWS Worker Discovery
// =============================================================================

/**
 * Get fresh worker IPs from AWS CLI
 */
function getWorkersFromAWS(): WorkerInfo[] {
  try {
    const cmd = `aws ec2 describe-instances --filters "Name=tag:Name,Values=hashcrack-gpu-worker-*" "Name=instance-state-name,Values=running" --query "Reservations[*].Instances[*].[Tags[?Key=='Name'].Value|[0],InstanceId,PublicIpAddress,PrivateIpAddress]" --output text --region ${AWS_REGION}`;

    const result = execSync(cmd, {
      encoding: "utf-8",
      timeout: 30000,
      shell: process.platform === "win32" ? "powershell.exe" : "/bin/bash",
      windowsHide: true,
    }).trim();

    if (!result) return [];

    return result.split("\n").map(line => {
      const [name, instanceId, publicIp, privateIp] = line.split("\t");
      return { name: name || "unknown", instanceId, publicIp, privateIp };
    }).filter(w => w.publicIp && w.publicIp !== "None");
  } catch (e) {
    console.error("Failed to get workers from AWS:", (e as Error).message);
    return [];
  }
}

// =============================================================================
// SSH Health Checks
// =============================================================================

/**
 * Execute SSH command on worker
 */
function sshExec(ip: string, command: string, timeout = 15000): string | null {
  try {
    const sshCmd = `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -o BatchMode=yes ubuntu@${ip} "${command}"`;
    return execSync(sshCmd, {
      encoding: "utf-8",
      timeout,
      shell: process.platform === "win32" ? "powershell.exe" : "/bin/bash",
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch (e) {
    return null;
  }
}

/**
 * Check worker health
 */
function checkWorkerHealth(worker: WorkerInfo): WorkerHealth {
  const health: WorkerHealth = {
    name: worker.name,
    ip: worker.publicIp,
    reachable: false,
    diskPercent: 0,
    diskUsed: "N/A",
    diskTotal: "N/A",
    diskAvail: "N/A",
    hashlistSize: "N/A",
    hashlistCount: 0,
    potSize: "N/A",
    tmpSize: "N/A",
    status: "unreachable",
  };

  // Get disk usage
  const dfOutput = sshExec(worker.publicIp, "df -h / | tail -1");
  if (!dfOutput) return health;

  health.reachable = true;
  const dfParts = dfOutput.split(/\s+/);
  if (dfParts.length >= 5) {
    health.diskTotal = dfParts[1];
    health.diskUsed = dfParts[2];
    health.diskAvail = dfParts[3];
    health.diskPercent = parseInt(dfParts[4].replace("%", "")) || 0;
  }

  // Get hashlist info
  const hashlistInfo = sshExec(worker.publicIp, "du -sh /opt/hashtopolis-agent/hashlists/ 2>/dev/null && ls /opt/hashtopolis-agent/hashlists/ 2>/dev/null | wc -l");
  if (hashlistInfo) {
    const lines = hashlistInfo.split("\n");
    if (lines[0]) {
      health.hashlistSize = lines[0].split("\t")[0] || "0";
    }
    if (lines[1]) {
      health.hashlistCount = parseInt(lines[1]) || 0;
    }
  }

  // Get pot file size
  const potInfo = sshExec(worker.publicIp, "du -sh /opt/hashtopolis-agent/*.pot 2>/dev/null | awk '{sum+=$1} END {print sum}' || echo '0'");
  health.potSize = potInfo || "0";

  // Get tmp size
  const tmpInfo = sshExec(worker.publicIp, "du -sh /tmp 2>/dev/null | cut -f1");
  health.tmpSize = tmpInfo || "0";

  // Determine status
  if (health.diskPercent >= DISK_CRITICAL_THRESHOLD) {
    health.status = "critical";
  } else if (health.diskPercent >= DISK_WARN_THRESHOLD) {
    health.status = "warning";
  } else {
    health.status = "healthy";
  }

  return health;
}

// =============================================================================
// Cleanup Functions
// =============================================================================

/**
 * Clean hashlists on a worker
 */
function cleanHashlists(ip: string, dryRun: boolean): { count: number; size: string } {
  const countResult = sshExec(ip, "find /opt/hashtopolis-agent/hashlists/ -type f 2>/dev/null | wc -l");
  const sizeResult = sshExec(ip, "du -sh /opt/hashtopolis-agent/hashlists/ 2>/dev/null");

  const count = parseInt(countResult || "0") || 0;
  const size = sizeResult?.split("\t")[0] || "0";

  if (!dryRun && count > 0) {
    sshExec(ip, "sudo rm -rf /opt/hashtopolis-agent/hashlists/* 2>/dev/null", 30000);
  }

  return { count, size };
}

/**
 * Clean old tmp files on a worker
 */
function cleanTmp(ip: string, dryRun: boolean): number {
  const countResult = sshExec(ip, "find /tmp -type f -mtime +1 2>/dev/null | wc -l");
  const count = parseInt(countResult || "0") || 0;

  if (!dryRun && count > 0) {
    sshExec(ip, "sudo find /tmp -type f -mtime +1 -delete 2>/dev/null", 30000);
  }

  return count;
}

// =============================================================================
// Display Functions
// =============================================================================

function statusColor(status: string): string {
  switch (status) {
    case "healthy": return "\x1b[32m";
    case "warning": return "\x1b[33m";
    case "critical": return "\x1b[31m";
    case "unreachable": return "\x1b[90m";
    default: return "\x1b[0m";
  }
}

function printWorkerTable(workers: WorkerHealth[]): void {
  console.log("\n┌─────────────────────────────────────────────────────────────────────────────────────────────┐");
  console.log("│                              WORKER DISK HEALTH                                             │");
  console.log("├─────────────────────────────┬──────────┬───────────┬───────────┬───────────┬───────────────┤");
  console.log("│ Worker                      │ Disk %   │ Used/Total│ Hashlists │ Tmp       │ Status        │");
  console.log("├─────────────────────────────┼──────────┼───────────┼───────────┼───────────┼───────────────┤");

  for (const w of workers) {
    const color = statusColor(w.status);
    const reset = "\x1b[0m";
    const name = w.name.padEnd(27);
    const disk = w.reachable ? `${w.diskPercent}%`.padEnd(8) : "N/A".padEnd(8);
    const used = w.reachable ? `${w.diskUsed}/${w.diskTotal}`.padEnd(9) : "N/A".padEnd(9);
    const hashlists = w.reachable ? `${w.hashlistSize}`.padEnd(9) : "N/A".padEnd(9);
    const tmp = w.reachable ? w.tmpSize.padEnd(9) : "N/A".padEnd(9);
    const status = `${color}${w.status.padEnd(13)}${reset}`;

    console.log(`│ ${name} │ ${disk} │ ${used} │ ${hashlists} │ ${tmp} │ ${status} │`);
  }

  console.log("└─────────────────────────────┴──────────┴───────────┴───────────┴───────────┴───────────────┘");
}

function printSummary(workers: WorkerHealth[]): void {
  const reachable = workers.filter(w => w.reachable).length;
  const healthy = workers.filter(w => w.status === "healthy").length;
  const warning = workers.filter(w => w.status === "warning").length;
  const critical = workers.filter(w => w.status === "critical").length;
  const unreachable = workers.filter(w => !w.reachable).length;

  console.log(`\nSummary: ${workers.length} workers | ${healthy} healthy | ${warning} warning | ${critical} critical | ${unreachable} unreachable`);

  if (critical > 0) {
    console.log("\n\x1b[31m⚠ CRITICAL: Some workers have disk usage above 85%!\x1b[0m");
    console.log("  Run: bun Tools/WorkerHealthCheck.ts --clean");
  } else if (warning > 0) {
    console.log("\n\x1b[33m⚠ WARNING: Some workers have disk usage above 70%\x1b[0m");
    console.log("  Consider running: bun Tools/WorkerHealthCheck.ts --clean --dry-run");
  }
}

// =============================================================================
// Main
// =============================================================================

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const doClean = args.includes("--clean");
  const cleanAll = args.includes("--all");
  const dryRun = args.includes("--dry-run");
  const showHelp = args.includes("--help") || args.includes("-h");

  if (showHelp) {
    console.log(`WorkerHealthCheck - Monitor and clean worker disk space

Usage:
  bun WorkerHealthCheck.ts              Show worker disk health
  bun WorkerHealthCheck.ts --clean      Clean high-usage workers (>70%)
  bun WorkerHealthCheck.ts --clean --all  Clean ALL workers
  bun WorkerHealthCheck.ts --dry-run    Preview cleanup

Thresholds:
  Warning:  70% disk usage
  Critical: 85% disk usage

Cleanup targets:
  /opt/hashtopolis-agent/hashlists/  Downloaded hash files
  /tmp/*                             Temp files older than 1 day

Note: Gets fresh worker IPs from AWS CLI to handle IP changes on reboot.`);
    return;
  }

  console.log("WorkerHealthCheck - Fetching worker IPs from AWS...\n");

  const workers = getWorkersFromAWS();
  if (workers.length === 0) {
    console.error("No workers found. Check AWS CLI configuration.");
    process.exit(1);
  }

  console.log(`Found ${workers.length} workers. Checking health...\n`);

  const healthResults: WorkerHealth[] = [];
  for (const worker of workers) {
    process.stdout.write(`  Checking ${worker.name}...`);
    const health = checkWorkerHealth(worker);
    healthResults.push(health);
    console.log(` ${health.status}`);
  }

  printWorkerTable(healthResults);
  printSummary(healthResults);

  // Cleanup if requested
  if (doClean) {
    console.log(`\n${dryRun ? "[DRY RUN] " : ""}Cleaning workers...\n`);

    const toClean = cleanAll
      ? healthResults.filter(w => w.reachable)
      : healthResults.filter(w => w.reachable && w.diskPercent >= DISK_WARN_THRESHOLD);

    if (toClean.length === 0) {
      console.log("No workers need cleaning.");
      return;
    }

    for (const worker of toClean) {
      console.log(`\n  ${worker.name} (${worker.ip}):`);

      const hashResult = cleanHashlists(worker.ip, dryRun);
      console.log(`    Hashlists: ${hashResult.count} files (${hashResult.size})${dryRun ? " [would remove]" : " removed"}`);

      const tmpCount = cleanTmp(worker.ip, dryRun);
      console.log(`    Tmp files: ${tmpCount} old files${dryRun ? " [would remove]" : " removed"}`);
    }

    if (!dryRun) {
      console.log("\n✓ Cleanup complete. Re-run to verify.");
    }
  }
}

main().catch(console.error);
