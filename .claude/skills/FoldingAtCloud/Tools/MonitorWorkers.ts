#!/usr/bin/env bun
/**
 * MonitorWorkers.ts - READ-ONLY monitoring for FoldingAtCloud workers
 *
 * CRITICAL: This tool has NO destructive capabilities.
 * It cannot stop, pause, deallocate, or destroy any resources.
 * It only reads and reports state.
 *
 * Commands:
 *   list <provider>       List workers from terraform state
 *   status <provider>     Get FAH status of all workers (via SSH)
 *   status-one <ip>       Get FAH status of single worker
 *   watch <provider>      Continuous monitoring (Ctrl+C to stop)
 *
 * Usage:
 *   bun run MonitorWorkers.ts list azure
 *   bun run MonitorWorkers.ts status azure
 *   bun run MonitorWorkers.ts watch azure --interval 60
 */

import { $ } from "bun";
import { existsSync } from "fs";
import { join, dirname } from "path";

// Paths
const SCRIPT_DIR = dirname(import.meta.path);
const SKILL_DIR = join(SCRIPT_DIR, "..");
const HOME = process.env.HOME || process.env.USERPROFILE || "";

// Provider-specific SSH configuration
interface ProviderConfig {
  sshUser: string;
  sshKey: string;
  terraformDir: string;
}

const PROVIDER_CONFIGS: Record<string, ProviderConfig> = {
  azure: {
    sshUser: process.env.AZURE_SSH_USER || "foldingadmin",
    sshKey: process.env.AZURE_SSH_KEY || `${HOME}/.ssh/azure_hashcrack`,
    terraformDir: join(SKILL_DIR, "terraform", "azure"),
  },
  oci: {
    sshUser: process.env.OCI_SSH_USER || "ubuntu",
    sshKey: process.env.OCI_SSH_KEY || `${HOME}/.ssh/id_ed25519`,
    terraformDir: join(SKILL_DIR, "terraform", "oci"),
  },
  aws: {
    sshUser: process.env.AWS_SSH_USER || "ubuntu",
    sshKey: process.env.AWS_SSH_KEY || `${HOME}/.ssh/aws_hashcrack`,
    terraformDir: join(SKILL_DIR, "terraform", "aws"),
  },
  gcp: {
    sshUser: process.env.GCP_SSH_USER || "foldingadmin",
    sshKey: process.env.GCP_SSH_KEY || `${HOME}/.ssh/gcp_hashcrack`,
    terraformDir: join(SKILL_DIR, "terraform", "gcp"),
  },
};

interface WorkerInfo {
  ip: string;
  name?: string;
  provider: string;
}

interface WorkerStatus {
  ip: string;
  name?: string;
  provider: string;
  ssh_reachable: boolean;
  fah_state: "folding" | "finishing" | "paused" | "unknown" | "unreachable";
  units_running: number;
  paused: boolean;
  last_check: string;
  error?: string;
}

/**
 * Get workers from terraform state (READ-ONLY)
 */
async function listWorkersFromTerraform(provider: string): Promise<WorkerInfo[]> {
  const config = PROVIDER_CONFIGS[provider];
  if (!config) {
    throw new Error(`Unknown provider: ${provider}`);
  }

  if (!existsSync(config.terraformDir)) {
    return [];
  }

  try {
    // Get terraform output - READ ONLY
    const result = await $`cd ${config.terraformDir} && terraform output -json 2>/dev/null`.text();
    const outputs = JSON.parse(result);

    const workers: WorkerInfo[] = [];

    // Try different output formats
    if (outputs.worker_ips?.value) {
      const ips = outputs.worker_ips.value;
      if (Array.isArray(ips)) {
        ips.forEach((ip: string, i: number) => {
          workers.push({
            ip,
            name: `worker-${i + 1}`,
            provider,
          });
        });
      }
    } else if (outputs.worker_public_ips?.value) {
      const ips = outputs.worker_public_ips.value;
      if (Array.isArray(ips)) {
        ips.forEach((ip: string, i: number) => {
          workers.push({
            ip,
            name: `foldingcloud-worker-${i + 1}`,
            provider,
          });
        });
      }
    }

    return workers;
  } catch (error: any) {
    // No terraform state or parse error
    return [];
  }
}

/**
 * Get FAH status via SSH (READ-ONLY)
 */
async function getWorkerStatus(
  ip: string,
  provider: string,
  name?: string
): Promise<WorkerStatus> {
  const config = PROVIDER_CONFIGS[provider];
  if (!config) {
    return {
      ip,
      name,
      provider,
      ssh_reachable: false,
      fah_state: "unknown",
      units_running: 0,
      paused: false,
      last_check: new Date().toISOString(),
      error: `Unknown provider: ${provider}`,
    };
  }

  const baseStatus: WorkerStatus = {
    ip,
    name,
    provider,
    ssh_reachable: false,
    fah_state: "unknown",
    units_running: 0,
    paused: false,
    last_check: new Date().toISOString(),
  };

  try {
    // Test SSH connectivity first (READ-ONLY command)
    const testResult = await $`ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -o BatchMode=yes -i ${config.sshKey} ${config.sshUser}@${ip} "echo ok" 2>&1`.text();

    if (!testResult.includes("ok")) {
      return {
        ...baseStatus,
        error: "SSH connection failed",
      };
    }

    baseStatus.ssh_reachable = true;

    // Get FAH state (READ-ONLY)
    const stateOutput = await $`ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -i ${config.sshKey} ${config.sshUser}@${ip} "lufah state 2>/dev/null || echo '{}'"`.text();

    try {
      const state = JSON.parse(stateOutput.trim());
      baseStatus.paused = state.paused === true;

      if (state.paused) {
        baseStatus.fah_state = "paused";
      } else if (state.finish) {
        baseStatus.fah_state = "finishing";
      } else {
        baseStatus.fah_state = "folding";
      }
    } catch {
      // State parsing failed
    }

    // Get running units count (READ-ONLY)
    const unitsOutput = await $`ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -i ${config.sshKey} ${config.sshUser}@${ip} "lufah units 2>/dev/null | grep -c 'RUNNING\\|READY' || echo 0"`.text();
    baseStatus.units_running = parseInt(unitsOutput.trim()) || 0;

    return baseStatus;
  } catch (error: any) {
    return {
      ...baseStatus,
      error: error.message,
    };
  }
}

/**
 * Get status of all workers for a provider
 */
async function getAllWorkerStatus(provider: string): Promise<WorkerStatus[]> {
  const workers = await listWorkersFromTerraform(provider);

  if (workers.length === 0) {
    console.error(`No workers found for provider: ${provider}`);
    return [];
  }

  // Check status in parallel
  const statuses = await Promise.all(
    workers.map((w) => getWorkerStatus(w.ip, w.provider, w.name))
  );

  return statuses;
}

/**
 * Watch workers continuously
 */
async function watchWorkers(provider: string, intervalSec: number): Promise<void> {
  console.log(`Watching ${provider} workers every ${intervalSec}s (Ctrl+C to stop)\n`);

  const formatStatus = (s: WorkerStatus): string => {
    const state = s.ssh_reachable ? s.fah_state.toUpperCase() : "UNREACHABLE";
    const icon = s.paused ? "||" : s.fah_state === "finishing" ? ">>" : ">>";
    return `${s.name || s.ip} | ${state} ${icon} | Units: ${s.units_running}`;
  };

  while (true) {
    const now = new Date().toISOString();
    console.log(`\n--- ${now} ---`);

    const statuses = await getAllWorkerStatus(provider);

    for (const status of statuses) {
      console.log(formatStatus(status));
    }

    // Summary
    const paused = statuses.filter((s) => s.paused).length;
    const folding = statuses.filter((s) => s.fah_state === "folding").length;
    const finishing = statuses.filter((s) => s.fah_state === "finishing").length;
    const unreachable = statuses.filter((s) => !s.ssh_reachable).length;

    console.log(`\nSummary: ${paused} paused, ${folding} folding, ${finishing} finishing, ${unreachable} unreachable`);

    await Bun.sleep(intervalSec * 1000);
  }
}

// =============================================================================
// Main CLI
// =============================================================================

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 1) {
    console.log(`
MonitorWorkers - READ-ONLY monitoring for FoldingAtCloud workers

*** THIS TOOL CANNOT STOP, PAUSE, OR DESTROY ANYTHING ***

Usage:
  bun run MonitorWorkers.ts <command> [args] [options]

Commands:
  list <provider>        List workers from terraform state
  status <provider>      Get FAH status of all workers
  status-one <ip>        Get FAH status of single worker
  watch <provider>       Continuous monitoring (Ctrl+C to stop)

Providers: azure, oci, aws, gcp

Options:
  --interval <seconds>   Watch interval (default: 60)
  --provider <name>      Provider for status-one command

Examples:
  bun run MonitorWorkers.ts list azure
  bun run MonitorWorkers.ts status azure
  bun run MonitorWorkers.ts status-one 20.120.1.100 --provider azure
  bun run MonitorWorkers.ts watch azure --interval 30
`);
    process.exit(1);
  }

  const command = args[0];

  // Parse options
  let interval = 60;
  const intervalIdx = args.indexOf("--interval");
  if (intervalIdx !== -1 && args[intervalIdx + 1]) {
    interval = parseInt(args[intervalIdx + 1]);
  }

  let provider: string | undefined;
  const providerIdx = args.indexOf("--provider");
  if (providerIdx !== -1 && args[providerIdx + 1]) {
    provider = args[providerIdx + 1];
  }

  switch (command) {
    case "list": {
      const prov = args[1];
      if (!prov) {
        console.error("Usage: list <provider>");
        process.exit(1);
      }

      const workers = await listWorkersFromTerraform(prov);
      console.log(JSON.stringify(workers, null, 2));
      break;
    }

    case "status": {
      const prov = args[1];
      if (!prov) {
        console.error("Usage: status <provider>");
        process.exit(1);
      }

      const statuses = await getAllWorkerStatus(prov);
      console.log(JSON.stringify(statuses, null, 2));
      break;
    }

    case "status-one": {
      const ip = args[1];
      const prov = provider || args[2];

      if (!ip || !prov) {
        console.error("Usage: status-one <ip> --provider <provider>");
        process.exit(1);
      }

      const status = await getWorkerStatus(ip, prov);
      console.log(JSON.stringify(status, null, 2));
      break;
    }

    case "watch": {
      const prov = args[1];
      if (!prov) {
        console.error("Usage: watch <provider>");
        process.exit(1);
      }

      await watchWorkers(prov, interval);
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      process.exit(1);
  }
}

main().catch((error) => {
  console.error("Error:", error.message);
  process.exit(1);
});
