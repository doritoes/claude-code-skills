#!/usr/bin/env bun
/**
 * StateTracker.ts - Persistent state management for FoldingAtCloud workers
 *
 * Tracks worker states across context boundaries using a JSON file.
 * This ensures state is preserved even when Claude's context is compacted.
 *
 * Commands:
 *   record <ip> <state>    Record worker state with timestamp
 *   get <ip>               Get recorded state for a worker
 *   list                   List all recorded states
 *   age <ip>               Time since last update
 *   clear                  Clear all recorded states
 *   prune                  Remove entries older than 24 hours
 *
 * States: UNKNOWN | FOLDING | FINISHING | PAUSED | STOPPED | DESTROYED
 *
 * Usage:
 *   bun run StateTracker.ts record 20.120.1.100 PAUSED --provider azure --name pai-fold-1
 *   bun run StateTracker.ts list
 *   bun run StateTracker.ts age 20.120.1.100
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";

// State file location
const SCRIPT_DIR = dirname(import.meta.path);
const STATE_DIR = join(SCRIPT_DIR, "..", "state");
const STATE_FILE = join(STATE_DIR, "workers.json");

// Valid states
const VALID_STATES = ["UNKNOWN", "FOLDING", "FINISHING", "PAUSED", "STOPPED", "DESTROYED"] as const;
type WorkerState = typeof VALID_STATES[number];

interface WorkerRecord {
  ip: string;
  state: WorkerState;
  provider?: string;
  name?: string;
  updated_at: string;
  updated_by: string;
  history: Array<{
    state: WorkerState;
    timestamp: string;
  }>;
}

interface StateFile {
  version: number;
  workers: Record<string, WorkerRecord>;
}

/**
 * Ensure state directory exists
 */
function ensureStateDir(): void {
  if (!existsSync(STATE_DIR)) {
    mkdirSync(STATE_DIR, { recursive: true });
  }
}

/**
 * Load state file
 */
function loadState(): StateFile {
  ensureStateDir();
  if (!existsSync(STATE_FILE)) {
    return { version: 1, workers: {} };
  }
  try {
    const content = readFileSync(STATE_FILE, "utf-8");
    return JSON.parse(content);
  } catch (error) {
    console.error("Warning: Could not parse state file, starting fresh");
    return { version: 1, workers: {} };
  }
}

/**
 * Save state file
 */
function saveState(state: StateFile): void {
  ensureStateDir();
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

/**
 * Record worker state
 */
function recordState(
  ip: string,
  newState: WorkerState,
  provider?: string,
  name?: string
): WorkerRecord {
  const state = loadState();
  const now = new Date().toISOString();

  const existing = state.workers[ip];
  const history = existing?.history || [];

  // Add previous state to history if different
  if (existing && existing.state !== newState) {
    history.push({
      state: existing.state,
      timestamp: existing.updated_at,
    });
  }

  const record: WorkerRecord = {
    ip,
    state: newState,
    provider: provider || existing?.provider,
    name: name || existing?.name,
    updated_at: now,
    updated_by: "StateTracker",
    history: history.slice(-10), // Keep last 10 state changes
  };

  state.workers[ip] = record;
  saveState(state);

  return record;
}

/**
 * Get worker state
 */
function getState(ip: string): WorkerRecord | null {
  const state = loadState();
  return state.workers[ip] || null;
}

/**
 * List all workers
 */
function listWorkers(): WorkerRecord[] {
  const state = loadState();
  return Object.values(state.workers);
}

/**
 * Get age of worker state in seconds
 */
function getAge(ip: string): { ip: string; age_seconds: number; age_human: string } | null {
  const record = getState(ip);
  if (!record) return null;

  const updated = new Date(record.updated_at);
  const now = new Date();
  const ageMs = now.getTime() - updated.getTime();
  const ageSec = Math.floor(ageMs / 1000);

  // Human readable
  const hours = Math.floor(ageSec / 3600);
  const minutes = Math.floor((ageSec % 3600) / 60);
  const seconds = ageSec % 60;

  let human = "";
  if (hours > 0) human += `${hours}h `;
  if (minutes > 0) human += `${minutes}m `;
  human += `${seconds}s`;

  return {
    ip,
    age_seconds: ageSec,
    age_human: human.trim(),
  };
}

/**
 * Clear all state
 */
function clearState(): void {
  saveState({ version: 1, workers: {} });
}

/**
 * Prune entries older than specified hours
 */
function pruneState(maxAgeHours: number = 24): number {
  const state = loadState();
  const now = new Date();
  let pruned = 0;

  for (const [ip, record] of Object.entries(state.workers)) {
    const updated = new Date(record.updated_at);
    const ageHours = (now.getTime() - updated.getTime()) / (1000 * 60 * 60);

    if (ageHours > maxAgeHours) {
      delete state.workers[ip];
      pruned++;
    }
  }

  saveState(state);
  return pruned;
}

// =============================================================================
// Main CLI
// =============================================================================

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 1) {
    console.log(`
StateTracker - Persistent state management for FoldingAtCloud workers

Usage:
  bun run StateTracker.ts <command> [args] [options]

Commands:
  record <ip> <state>    Record worker state
  get <ip>               Get recorded state
  list                   List all recorded states
  age <ip>               Time since last update
  clear                  Clear all recorded states
  prune [hours]          Remove entries older than N hours (default: 24)

States: ${VALID_STATES.join(" | ")}

Options:
  --provider <name>      Cloud provider (azure, oci, aws, gcp)
  --name <vm-name>       VM name for reference

Examples:
  bun run StateTracker.ts record 20.120.1.100 PAUSED --provider azure --name pai-fold-1
  bun run StateTracker.ts list
  bun run StateTracker.ts age 20.120.1.100
  bun run StateTracker.ts prune 12
`);
    process.exit(1);
  }

  const command = args[0];

  // Parse options
  let provider: string | undefined;
  let name: string | undefined;

  const providerIdx = args.indexOf("--provider");
  if (providerIdx !== -1 && args[providerIdx + 1]) {
    provider = args[providerIdx + 1];
  }

  const nameIdx = args.indexOf("--name");
  if (nameIdx !== -1 && args[nameIdx + 1]) {
    name = args[nameIdx + 1];
  }

  switch (command) {
    case "record": {
      const ip = args[1];
      const state = args[2]?.toUpperCase() as WorkerState;

      if (!ip || !state) {
        console.error("Usage: record <ip> <state>");
        process.exit(1);
      }

      if (!VALID_STATES.includes(state)) {
        console.error(`Invalid state: ${state}. Valid: ${VALID_STATES.join(", ")}`);
        process.exit(1);
      }

      const record = recordState(ip, state, provider, name);
      console.log(JSON.stringify(record, null, 2));
      break;
    }

    case "get": {
      const ip = args[1];
      if (!ip) {
        console.error("Usage: get <ip>");
        process.exit(1);
      }

      const record = getState(ip);
      if (record) {
        console.log(JSON.stringify(record, null, 2));
      } else {
        console.log(JSON.stringify({ ip, state: "NOT_FOUND" }));
        process.exit(1);
      }
      break;
    }

    case "list": {
      const workers = listWorkers();
      console.log(JSON.stringify(workers, null, 2));
      break;
    }

    case "age": {
      const ip = args[1];
      if (!ip) {
        console.error("Usage: age <ip>");
        process.exit(1);
      }

      const age = getAge(ip);
      if (age) {
        console.log(JSON.stringify(age, null, 2));
      } else {
        console.log(JSON.stringify({ ip, error: "NOT_FOUND" }));
        process.exit(1);
      }
      break;
    }

    case "clear": {
      clearState();
      console.log("State cleared");
      break;
    }

    case "prune": {
      const hours = parseInt(args[1]) || 24;
      const pruned = pruneState(hours);
      console.log(`Pruned ${pruned} entries older than ${hours} hours`);
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
