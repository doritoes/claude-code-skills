#!/usr/bin/env bun
/**
 * WorkerControl.ts - Control FAH workers via SSH/lufah
 *
 * Commands:
 *   status <ip>         - Get worker status
 *   finish <ip>         - Send finish command (complete WU then pause)
 *   pause <ip>          - Pause immediately
 *   fold <ip>           - Resume folding
 *   wait-paused <ip>    - Wait until worker is paused
 *   health <ip>         - Check worker health
 *
 * Usage:
 *   bun run WorkerControl.ts status 20.120.1.100
 *   bun run WorkerControl.ts finish 20.120.1.100 --timeout 1800
 */

import { $ } from "bun";
import { parseArgs } from "util";

// Configuration
const SSH_USER = process.env.SSH_USER || "foldingadmin";
const SSH_KEY = process.env.SSH_PRIVATE_KEY_PATH || `${process.env.HOME}/.ssh/id_ed25519`;
const DEFAULT_TIMEOUT = parseInt(process.env.FOLDING_GRACEFUL_TIMEOUT || "1800");

interface WorkerStatus {
  ip: string;
  healthy: boolean;
  paused: boolean;
  units: number;
  error?: string;
}

/**
 * Execute SSH command on worker
 */
async function sshCommand(ip: string, command: string): Promise<string> {
  try {
    const result = await $`ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -i ${SSH_KEY} ${SSH_USER}@${ip} ${command}`.text();
    return result.trim();
  } catch (error: any) {
    throw new Error(`SSH command failed: ${error.message}`);
  }
}

/**
 * Get worker status via lufah
 */
async function getStatus(ip: string): Promise<WorkerStatus> {
  try {
    // Check if FAH service is running
    const healthOutput = await sshCommand(ip, "systemctl is-active fah-client || echo inactive");
    const healthy = healthOutput.includes("active") && !healthOutput.includes("inactive");

    if (!healthy) {
      return { ip, healthy: false, paused: false, units: 0, error: "FAH service not running" };
    }

    // Get state from lufah
    const stateOutput = await sshCommand(ip, "lufah state 2>/dev/null || echo '{}'");
    let paused = false;
    try {
      const state = JSON.parse(stateOutput);
      paused = state.paused === true;
    } catch {
      // State parsing failed, assume not paused
    }

    // Get unit count
    const unitsOutput = await sshCommand(ip, "lufah units 2>/dev/null | grep -c 'RUNNING\\|READY' || echo 0");
    const units = parseInt(unitsOutput) || 0;

    return { ip, healthy, paused, units };
  } catch (error: any) {
    return { ip, healthy: false, paused: false, units: 0, error: error.message };
  }
}

/**
 * Send finish command to worker
 */
async function sendFinish(ip: string): Promise<boolean> {
  try {
    await sshCommand(ip, "lufah finish");
    console.log(`[${ip}] Finish command sent`);
    return true;
  } catch (error: any) {
    console.error(`[${ip}] Failed to send finish: ${error.message}`);
    return false;
  }
}

/**
 * Send pause command to worker
 */
async function sendPause(ip: string): Promise<boolean> {
  try {
    await sshCommand(ip, "lufah pause");
    console.log(`[${ip}] Pause command sent`);
    return true;
  } catch (error: any) {
    console.error(`[${ip}] Failed to send pause: ${error.message}`);
    return false;
  }
}

/**
 * Send fold command to worker
 */
async function sendFold(ip: string): Promise<boolean> {
  try {
    await sshCommand(ip, "lufah fold");
    console.log(`[${ip}] Fold command sent`);
    return true;
  } catch (error: any) {
    console.error(`[${ip}] Failed to send fold: ${error.message}`);
    return false;
  }
}

/**
 * Wait until worker is paused (WU complete)
 */
async function waitUntilPaused(ip: string, timeoutSeconds: number): Promise<boolean> {
  const startTime = Date.now();
  const interval = 30000; // 30 seconds

  console.log(`[${ip}] Waiting for work unit to complete (timeout: ${timeoutSeconds}s)...`);

  while (Date.now() - startTime < timeoutSeconds * 1000) {
    const status = await getStatus(ip);

    if (status.paused) {
      console.log(`[${ip}] Worker paused - safe to terminate`);
      return true;
    }

    if (!status.healthy) {
      console.log(`[${ip}] Worker unhealthy - proceeding with termination`);
      return true;
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`[${ip}] Still folding... (${elapsed}s / ${timeoutSeconds}s)`);

    await Bun.sleep(interval);
  }

  console.log(`[${ip}] Timeout reached - proceeding with termination`);
  return false;
}

/**
 * Health check
 */
async function healthCheck(ip: string): Promise<boolean> {
  const status = await getStatus(ip);
  return status.healthy;
}

// =============================================================================
// Main CLI
// =============================================================================

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.log(`
WorkerControl - Control FAH workers via SSH/lufah

Usage:
  bun run WorkerControl.ts <command> <ip> [options]

Commands:
  status <ip>         Get worker status (JSON output)
  finish <ip>         Send finish command
  pause <ip>          Pause immediately
  fold <ip>           Resume folding
  wait-paused <ip>    Wait until paused (for graceful shutdown)
  health <ip>         Health check (exit 0 if healthy)

Options:
  --timeout <seconds>  Timeout for wait-paused (default: ${DEFAULT_TIMEOUT})

Environment:
  SSH_USER              SSH username (default: foldingadmin)
  SSH_PRIVATE_KEY_PATH  Path to SSH private key
  FOLDING_GRACEFUL_TIMEOUT  Default timeout in seconds

Examples:
  bun run WorkerControl.ts status 20.120.1.100
  bun run WorkerControl.ts finish 20.120.1.100
  bun run WorkerControl.ts wait-paused 20.120.1.100 --timeout 1800
`);
    process.exit(1);
  }

  const command = args[0];
  const ip = args[1];

  // Parse timeout option
  let timeout = DEFAULT_TIMEOUT;
  const timeoutIdx = args.indexOf("--timeout");
  if (timeoutIdx !== -1 && args[timeoutIdx + 1]) {
    timeout = parseInt(args[timeoutIdx + 1]);
  }

  switch (command) {
    case "status": {
      const status = await getStatus(ip);
      console.log(JSON.stringify(status, null, 2));
      break;
    }

    case "finish": {
      const success = await sendFinish(ip);
      process.exit(success ? 0 : 1);
      break;
    }

    case "pause": {
      const success = await sendPause(ip);
      process.exit(success ? 0 : 1);
      break;
    }

    case "fold": {
      const success = await sendFold(ip);
      process.exit(success ? 0 : 1);
      break;
    }

    case "wait-paused": {
      const paused = await waitUntilPaused(ip, timeout);
      process.exit(paused ? 0 : 1);
      break;
    }

    case "health": {
      const healthy = await healthCheck(ip);
      console.log(healthy ? "healthy" : "unhealthy");
      process.exit(healthy ? 0 : 1);
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
