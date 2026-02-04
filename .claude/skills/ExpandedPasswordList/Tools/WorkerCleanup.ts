#!/usr/bin/env bun
/**
 * WorkerCleanup.ts - Clean Worker Disk Space
 *
 * @deprecated Use WorkerHealthCheck.ts instead.
 * This tool uses stale terraform IPs which change on worker reboot.
 * WorkerHealthCheck.ts gets fresh IPs from AWS CLI.
 *
 * Monitors and cleans disk space on Hashcrack workers.
 * Workers accumulate hashlists and .pot files that can fill disk.
 *
 * Cleanup targets:
 * - /opt/hashtopolis-agent/hashlists/ - Downloaded hashlists
 * - /opt/hashtopolis-agent/*.pot - Cracked results (already synced to server)
 * - /tmp/ - Temporary files
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

// =============================================================================
// Configuration
// =============================================================================

const SKILL_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const ENV_PATH = resolve(dirname(SKILL_DIR), "..", ".env");
const HASHCRACK_DIR = resolve(dirname(SKILL_DIR), "Hashcrack");

// Disk usage threshold for warnings
const DISK_WARN_THRESHOLD = 80; // percent
const DISK_CRITICAL_THRESHOLD = 90; // percent

// Cleanup paths on workers
const CLEANUP_PATHS = {
  hashlists: "/opt/hashtopolis-agent/hashlists",
  potfiles: "/opt/hashtopolis-agent",
  temp: "/tmp",
};

interface WorkerInfo {
  name: string;
  ip: string;
}

interface DiskInfo {
  worker: string;
  ip: string;
  filesystem: string;
  size: string;
  used: string;
  available: string;
  usedPercent: number;
  mountpoint: string;
}

interface CleanupResult {
  worker: string;
  ip: string;
  hashlistsRemoved: number;
  potfilesRemoved: number;
  tempFilesRemoved: number;
  spaceFreed: string;
}

// =============================================================================
// Environment Loading
// =============================================================================

function loadConfig(): { serverIp: string } {
  if (!existsSync(ENV_PATH)) {
    throw new Error(`.env not found at ${ENV_PATH}`);
  }

  const envContent = readFileSync(ENV_PATH, "utf-8");
  const env: Record<string, string> = {};

  for (const line of envContent.split("\n")) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) {
      env[match[1].trim()] = match[2].trim();
    }
  }

  const serverUrl = env.HASHCRACK_SERVER_URL || "";
  const serverMatch = serverUrl.match(/https?:\/\/([^:\/]+)/);
  const serverIp = serverMatch ? serverMatch[1] : "";

  if (!serverIp) {
    throw new Error("HASHCRACK_SERVER_URL not configured in .env");
  }

  return { serverIp };
}

// =============================================================================
// Worker Discovery
// =============================================================================

/**
 * Get worker IPs from Terraform state
 */
function getWorkersFromTerraform(): WorkerInfo[] {
  const terraformDir = resolve(HASHCRACK_DIR, "terraform", "aws");

  if (!existsSync(terraformDir)) {
    return [];
  }

  try {
    const output = execSync("terraform output -json", {
      cwd: terraformDir,
      encoding: "utf-8",
      timeout: 30000,
    });

    const tfOutput = JSON.parse(output);
    const workers: WorkerInfo[] = [];

    // GPU workers
    if (tfOutput.gpu_worker_ips?.value) {
      const ips = tfOutput.gpu_worker_ips.value as string[];
      ips.forEach((ip, i) => {
        workers.push({ name: `gpu-worker-${i + 1}`, ip });
      });
    }

    // CPU workers
    if (tfOutput.cpu_worker_ips?.value) {
      const ips = tfOutput.cpu_worker_ips.value as string[];
      ips.forEach((ip, i) => {
        workers.push({ name: `cpu-worker-${i + 1}`, ip });
      });
    }

    return workers;
  } catch (e) {
    return [];
  }
}

/**
 * Get worker IPs from Hashtopolis database
 */
function getWorkersFromDB(serverIp: string, dbPassword: string): WorkerInfo[] {
  try {
    const cmd = `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 ubuntu@${serverIp} "docker exec hashtopolis-db mysql -u hashtopolis -p'${dbPassword}' -N -e 'SELECT agentName, lastIp FROM Agent WHERE isActive=1' hashtopolis 2>/dev/null"`;
    const result = execSync(cmd, { encoding: "utf-8", timeout: 30000 }).trim();

    if (!result) return [];

    return result.split("\n").map((line) => {
      const [name, ip] = line.split("\t");
      return { name, ip };
    });
  } catch (e) {
    return [];
  }
}

// =============================================================================
// Disk Monitoring
// =============================================================================

/**
 * Get disk usage for a worker
 */
function getDiskUsage(ip: string): DiskInfo | null {
  try {
    const cmd = `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 ubuntu@${ip} "df -h / | tail -1" 2>/dev/null`;
    const result = execSync(cmd, { encoding: "utf-8", timeout: 15000 }).trim();

    if (!result) return null;

    // Parse df output: Filesystem Size Used Avail Use% Mounted
    const parts = result.split(/\s+/);
    if (parts.length < 6) return null;

    const usedPercent = parseInt(parts[4].replace("%", "")) || 0;

    return {
      worker: "",
      ip,
      filesystem: parts[0],
      size: parts[1],
      used: parts[2],
      available: parts[3],
      usedPercent,
      mountpoint: parts[5],
    };
  } catch (e) {
    return null;
  }
}

/**
 * Get detailed path usage on worker
 */
function getPathUsage(ip: string, path: string): string {
  try {
    const cmd = `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 ubuntu@${ip} "sudo du -sh ${path} 2>/dev/null || echo '0 ${path}'" 2>/dev/null`;
    const result = execSync(cmd, { encoding: "utf-8", timeout: 15000 }).trim();
    return result.split("\t")[0] || "0";
  } catch (e) {
    return "N/A";
  }
}

// =============================================================================
// Cleanup Functions
// =============================================================================

/**
 * Clean hashlists directory on worker
 */
function cleanHashlists(ip: string, dryRun: boolean): number {
  try {
    const path = CLEANUP_PATHS.hashlists;

    // Count files first
    const countCmd = `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 ubuntu@${ip} "sudo find ${path} -type f 2>/dev/null | wc -l" 2>/dev/null`;
    const count = parseInt(execSync(countCmd, { encoding: "utf-8", timeout: 15000 }).trim()) || 0;

    if (count === 0 || dryRun) return count;

    // Remove files
    const rmCmd = `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 ubuntu@${ip} "sudo rm -rf ${path}/* 2>/dev/null" 2>/dev/null`;
    execSync(rmCmd, { encoding: "utf-8", timeout: 30000 });

    return count;
  } catch (e) {
    return 0;
  }
}

/**
 * Clean .pot files on worker
 */
function cleanPotfiles(ip: string, dryRun: boolean): number {
  try {
    const path = CLEANUP_PATHS.potfiles;

    // Count .pot files
    const countCmd = `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 ubuntu@${ip} "sudo find ${path} -name '*.pot' -type f 2>/dev/null | wc -l" 2>/dev/null`;
    const count = parseInt(execSync(countCmd, { encoding: "utf-8", timeout: 15000 }).trim()) || 0;

    if (count === 0 || dryRun) return count;

    // Remove .pot files
    const rmCmd = `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 ubuntu@${ip} "sudo find ${path} -name '*.pot' -type f -delete 2>/dev/null" 2>/dev/null`;
    execSync(rmCmd, { encoding: "utf-8", timeout: 30000 });

    return count;
  } catch (e) {
    return 0;
  }
}

/**
 * Clean temp files on worker
 */
function cleanTemp(ip: string, dryRun: boolean): number {
  try {
    // Count temp files older than 1 day
    const countCmd = `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 ubuntu@${ip} "sudo find /tmp -type f -mtime +1 2>/dev/null | wc -l" 2>/dev/null`;
    const count = parseInt(execSync(countCmd, { encoding: "utf-8", timeout: 15000 }).trim()) || 0;

    if (count === 0 || dryRun) return count;

    // Remove old temp files
    const rmCmd = `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 ubuntu@${ip} "sudo find /tmp -type f -mtime +1 -delete 2>/dev/null" 2>/dev/null`;
    execSync(rmCmd, { encoding: "utf-8", timeout: 30000 });

    return count;
  } catch (e) {
    return 0;
  }
}

// =============================================================================
// Main Functions
// =============================================================================

async function showStatus(workers: WorkerInfo[]): Promise<void> {
  console.log("WorkerCleanup - Disk Status");
  console.log("===========================");
  console.log("");

  if (workers.length === 0) {
    console.log("No workers found. Deploy infrastructure first.");
    return;
  }

  console.log(`Found ${workers.length} workers:`);
  console.log("");

  const diskInfos: DiskInfo[] = [];

  for (const worker of workers) {
    process.stdout.write(`  ${worker.name} (${worker.ip})... `);

    const disk = getDiskUsage(worker.ip);
    if (!disk) {
      console.log("UNREACHABLE");
      continue;
    }

    disk.worker = worker.name;

    // Status indicator
    let status = "OK";
    if (disk.usedPercent >= DISK_CRITICAL_THRESHOLD) {
      status = "CRITICAL";
    } else if (disk.usedPercent >= DISK_WARN_THRESHOLD) {
      status = "WARNING";
    }

    console.log(`${disk.usedPercent}% used (${disk.used}/${disk.size}) [${status}]`);
    diskInfos.push(disk);
  }

  // Detailed breakdown for workers with high usage
  const highUsage = diskInfos.filter((d) => d.usedPercent >= DISK_WARN_THRESHOLD);
  if (highUsage.length > 0) {
    console.log("");
    console.log("High usage breakdown:");

    for (const disk of highUsage) {
      console.log(`\n  ${disk.worker} (${disk.ip}):`);
      console.log(`    Hashlists: ${getPathUsage(disk.ip, CLEANUP_PATHS.hashlists)}`);
      console.log(`    Potfiles:  ${getPathUsage(disk.ip, CLEANUP_PATHS.potfiles + "/*.pot")}`);
      console.log(`    Temp:      ${getPathUsage(disk.ip, CLEANUP_PATHS.temp)}`);
    }
  }

  // Summary
  console.log("");
  console.log("Summary:");
  console.log(`  Total workers: ${workers.length}`);
  console.log(`  Reachable: ${diskInfos.length}`);
  console.log(`  Warning (>${DISK_WARN_THRESHOLD}%): ${diskInfos.filter((d) => d.usedPercent >= DISK_WARN_THRESHOLD && d.usedPercent < DISK_CRITICAL_THRESHOLD).length}`);
  console.log(`  Critical (>${DISK_CRITICAL_THRESHOLD}%): ${diskInfos.filter((d) => d.usedPercent >= DISK_CRITICAL_THRESHOLD).length}`);
}

async function cleanWorkers(workers: WorkerInfo[], options: { dryRun?: boolean; all?: boolean }): Promise<CleanupResult[]> {
  const { dryRun = false, all = false } = options;

  console.log("WorkerCleanup - Clean Workers");
  console.log("=============================");
  console.log(`Dry run: ${dryRun}`);
  console.log(`Target: ${all ? "ALL workers" : "High usage workers only"}`);
  console.log("");

  if (workers.length === 0) {
    console.log("No workers found.");
    return [];
  }

  // Determine which workers to clean
  let targetWorkers = workers;
  if (!all) {
    // Only clean workers with high disk usage
    targetWorkers = workers.filter((w) => {
      const disk = getDiskUsage(w.ip);
      return disk && disk.usedPercent >= DISK_WARN_THRESHOLD;
    });

    if (targetWorkers.length === 0) {
      console.log("No workers need cleanup (all below warning threshold).");
      return [];
    }
  }

  console.log(`Cleaning ${targetWorkers.length} workers:`);
  const results: CleanupResult[] = [];

  for (const worker of targetWorkers) {
    console.log(`\n  ${worker.name} (${worker.ip}):`);

    // Get disk usage before
    const diskBefore = getDiskUsage(worker.ip);
    if (!diskBefore) {
      console.log("    UNREACHABLE - skipping");
      continue;
    }

    // Clean each category
    const hashlistsRemoved = cleanHashlists(worker.ip, dryRun);
    console.log(`    Hashlists: ${hashlistsRemoved} files ${dryRun ? "(would remove)" : "removed"}`);

    const potfilesRemoved = cleanPotfiles(worker.ip, dryRun);
    console.log(`    Potfiles: ${potfilesRemoved} files ${dryRun ? "(would remove)" : "removed"}`);

    const tempFilesRemoved = cleanTemp(worker.ip, dryRun);
    console.log(`    Temp files: ${tempFilesRemoved} files ${dryRun ? "(would remove)" : "removed"}`);

    // Get disk usage after
    let spaceFreed = "N/A";
    if (!dryRun) {
      const diskAfter = getDiskUsage(worker.ip);
      if (diskAfter) {
        const freedPct = diskBefore.usedPercent - diskAfter.usedPercent;
        spaceFreed = `${freedPct}% freed (now ${diskAfter.usedPercent}% used)`;
      }
    }

    results.push({
      worker: worker.name,
      ip: worker.ip,
      hashlistsRemoved,
      potfilesRemoved,
      tempFilesRemoved,
      spaceFreed,
    });
  }

  // Summary
  console.log("");
  console.log("Cleanup Summary");
  console.log("===============");
  console.log(`Workers cleaned: ${results.length}`);
  console.log(`Total hashlists removed: ${results.reduce((sum, r) => sum + r.hashlistsRemoved, 0)}`);
  console.log(`Total potfiles removed: ${results.reduce((sum, r) => sum + r.potfilesRemoved, 0)}`);
  console.log(`Total temp files removed: ${results.reduce((sum, r) => sum + r.tempFilesRemoved, 0)}`);

  return results;
}

// =============================================================================
// CLI
// =============================================================================

if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args[0] === "--help" || args[0] === "-h") {
    console.log(`
WorkerCleanup - Monitor and clean Hashcrack worker disk space

Workers accumulate hashlists and .pot files that can fill disk.
This tool monitors usage and cleans up when needed.

Usage:
  bun WorkerCleanup.ts                   Show disk status
  bun WorkerCleanup.ts --clean           Clean high-usage workers
  bun WorkerCleanup.ts --clean --all     Clean ALL workers
  bun WorkerCleanup.ts --dry-run         Preview cleanup

Options:
  --clean            Clean worker disk space
  --all              Clean all workers (not just high usage)
  --dry-run          Preview without making changes

Cleanup targets:
  /opt/hashtopolis-agent/hashlists/  Downloaded hashlists
  /opt/hashtopolis-agent/*.pot       Cracked results (synced to server)
  /tmp/                              Temp files older than 1 day

Thresholds:
  Warning:  ${DISK_WARN_THRESHOLD}% disk usage
  Critical: ${DISK_CRITICAL_THRESHOLD}% disk usage

Examples:
  bun WorkerCleanup.ts                    # Show status
  bun WorkerCleanup.ts --clean            # Clean high-usage workers
  bun WorkerCleanup.ts --clean --all      # Clean all workers
  bun WorkerCleanup.ts --clean --dry-run  # Preview cleanup
`);
    process.exit(0);
  }

  // Parse arguments
  let clean = false;
  let all = false;
  let dryRun = false;

  for (const arg of args) {
    switch (arg) {
      case "--clean":
        clean = true;
        break;
      case "--all":
        all = true;
        break;
      case "--dry-run":
        dryRun = true;
        break;
    }
  }

  try {
    // Discover workers
    let workers = getWorkersFromTerraform();

    if (workers.length === 0) {
      // Fall back to DB lookup
      const config = loadConfig();
      const envContent = readFileSync(ENV_PATH, "utf-8");
      const dbPasswordMatch = envContent.match(/HASHCRACK_DB_PASSWORD=(.+)/);
      const dbPassword = dbPasswordMatch ? dbPasswordMatch[1].trim() : "";

      if (dbPassword) {
        workers = getWorkersFromDB(config.serverIp, dbPassword);
      }
    }

    if (clean) {
      await cleanWorkers(workers, { dryRun, all });
    } else {
      await showStatus(workers);
    }
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
  }
}
