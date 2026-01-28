#!/usr/bin/env bun
/**
 * SandCracker.ts - Systematic SAND Hash Cracking Pipeline
 *
 * Orchestrates escalating attack phases against SAND (hard passwords).
 * Integrates with Hashcrack skill for distributed cracking.
 *
 * Nomenclature:
 *   ROCKS  = Full HIBP (~1B hashes)
 *   GRAVEL = ROCKS - rockyou matches
 *   SAND   = GRAVEL - rockyou+OneRule cracked (hard passwords)
 *   PEARLS = Cracked cleartext passwords
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { StateManager } from "./StateManager";

// =============================================================================
// Configuration
// =============================================================================

const CURRENT_FILE = fileURLToPath(import.meta.url);
const SKILL_DIR = dirname(dirname(CURRENT_FILE));
const DATA_DIR = resolve(SKILL_DIR, "data");
const HASHCRACK_DIR = resolve(dirname(dirname(CURRENT_FILE)), "..", "Hashcrack", "tools");

// Attack configuration
const HASH_TYPE_SHA1 = 100;

// =============================================================================
// Attack Phase Definitions
// =============================================================================

interface AttackPhase {
  id: string;
  name: string;
  description: string;
  priority: number;          // Higher = run first
  maxAgents: number;         // 0 = unlimited, 1 = single agent (for rules)
  estimatedTime: string;     // Human-readable estimate
  attackCmd: string;         // Hashcat command template
  requires?: string[];       // Prerequisite phases
}

const ATTACK_PHASES: AttackPhase[] = [
  // Phase 2.1: Quick Wins
  {
    id: "quick-best64",
    name: "Quick Wins - Best64",
    description: "Fast rule attack with best64 rules",
    priority: 100,
    maxAgents: 1,
    estimatedTime: "10-30 min",
    attackCmd: "#HL# -r best64.rule rockyou.txt",
  },
  {
    id: "quick-common",
    name: "Quick Wins - Common Lists",
    description: "Common password lists without rules",
    priority: 99,
    maxAgents: 0,
    estimatedTime: "5-15 min",
    attackCmd: "#HL# common-passwords.txt",
  },

  // Phase 2.2: Rule Stacking
  {
    id: "rules-dive",
    name: "Rule Stack - Dive",
    description: "Comprehensive dive.rule attack",
    priority: 80,
    maxAgents: 1,
    estimatedTime: "1-3 hours",
    attackCmd: "#HL# -r dive.rule rockyou.txt",
  },
  {
    id: "rules-d3ad0ne",
    name: "Rule Stack - d3ad0ne",
    description: "d3ad0ne rule attack",
    priority: 79,
    maxAgents: 1,
    estimatedTime: "1-2 hours",
    attackCmd: "#HL# -r d3ad0ne.rule rockyou.txt",
  },
  {
    id: "rules-generated2",
    name: "Rule Stack - Generated2",
    description: "Generated2 rule attack",
    priority: 78,
    maxAgents: 1,
    estimatedTime: "2-4 hours",
    attackCmd: "#HL# -r generated2.rule rockyou.txt",
  },

  // Phase 2.3: Combinator
  {
    id: "combo-rockyou",
    name: "Combinator - RockYou x RockYou",
    description: "Combine rockyou words (word+word)",
    priority: 60,
    maxAgents: 0,
    estimatedTime: "4-8 hours",
    attackCmd: "#HL# -a 1 rockyou.txt rockyou.txt",
  },

  // Phase 2.4: Hybrid Attacks
  {
    id: "hybrid-digits2",
    name: "Hybrid - Append 2 Digits",
    description: "Dictionary + 2 digits (password12)",
    priority: 50,
    maxAgents: 1,
    estimatedTime: "2-4 hours",
    attackCmd: "#HL# -a 6 rockyou.txt ?d?d",
  },
  {
    id: "hybrid-digits3",
    name: "Hybrid - Append 3 Digits",
    description: "Dictionary + 3 digits (password123)",
    priority: 49,
    maxAgents: 1,
    estimatedTime: "4-8 hours",
    attackCmd: "#HL# -a 6 rockyou.txt ?d?d?d",
  },
  {
    id: "hybrid-digits4",
    name: "Hybrid - Append 4 Digits",
    description: "Dictionary + 4 digits (password1234)",
    priority: 48,
    maxAgents: 1,
    estimatedTime: "8-16 hours",
    attackCmd: "#HL# -a 6 rockyou.txt ?d?d?d?d",
  },
  {
    id: "hybrid-year",
    name: "Hybrid - Append Year",
    description: "Dictionary + year (password2024)",
    priority: 47,
    maxAgents: 1,
    estimatedTime: "2-4 hours",
    attackCmd: "#HL# -a 6 rockyou.txt 20?d?d",
  },
  {
    id: "hybrid-special-digits",
    name: "Hybrid - Special + Digits",
    description: "Dictionary + special + 2 digits (password!23)",
    priority: 46,
    maxAgents: 1,
    estimatedTime: "8-16 hours",
    attackCmd: "#HL# -a 6 rockyou.txt ?s?d?d",
  },

  // Phase 2.5: Mask Attacks
  {
    id: "mask-6lower",
    name: "Mask - 6 Lowercase",
    description: "All 6-char lowercase combinations",
    priority: 35,
    maxAgents: 0,
    estimatedTime: "1-2 hours",
    attackCmd: "#HL# -a 3 ?l?l?l?l?l?l",
  },
  {
    id: "mask-7lower",
    name: "Mask - 7 Lowercase",
    description: "All 7-char lowercase combinations",
    priority: 34,
    maxAgents: 0,
    estimatedTime: "12-24 hours",
    attackCmd: "#HL# -a 3 ?l?l?l?l?l?l?l",
  },
  {
    id: "mask-ullllldd",
    name: "Mask - Ullllldd Pattern",
    description: "Capital + 5 lower + 2 digits",
    priority: 33,
    maxAgents: 0,
    estimatedTime: "4-8 hours",
    attackCmd: "#HL# -a 3 ?u?l?l?l?l?l?d?d",
  },

  // Phase 2.6: PRINCE (if available)
  {
    id: "prince-2elem",
    name: "PRINCE - 2 Elements",
    description: "PRINCE attack combining 2 words",
    priority: 25,
    maxAgents: 0,
    estimatedTime: "1-3 days",
    attackCmd: "#HL# --prince-elem-cnt-min=2 --prince-elem-cnt-max=2 rockyou.txt",
  },

  // Phase 2.7: Brute Force (last resort)
  {
    id: "brute-1-6",
    name: "Brute Force - 1-6 chars",
    description: "Exhaustive 1-6 character search",
    priority: 15,
    maxAgents: 0,
    estimatedTime: "1-4 hours",
    attackCmd: "#HL# -a 3 ?a?a?a?a?a?a --increment --increment-min=1",
  },
  {
    id: "brute-7",
    name: "Brute Force - 7 chars",
    description: "Exhaustive 7 character search",
    priority: 14,
    maxAgents: 0,
    estimatedTime: "1-3 days",
    attackCmd: "#HL# -a 3 ?a?a?a?a?a?a?a",
  },
  {
    id: "brute-8",
    name: "Brute Force - 8 chars",
    description: "Exhaustive 8 character search (SLOW)",
    priority: 13,
    maxAgents: 0,
    estimatedTime: "Weeks",
    attackCmd: "#HL# -a 3 ?a?a?a?a?a?a?a?a",
  },
];

// =============================================================================
// Hashcrack Client Import
// =============================================================================

async function getHashtopolisClient() {
  try {
    const clientPath = resolve(HASHCRACK_DIR, "HashtopolisClient.ts");
    if (!existsSync(clientPath)) {
      throw new Error(`HashtopolisClient not found at ${clientPath}`);
    }
    const { HashtopolisClient } = await import(clientPath);
    return { HashtopolisClient };
  } catch (e) {
    console.error("Failed to import HashtopolisClient:", e);
    throw new Error("Hashcrack skill not properly installed.");
  }
}

// =============================================================================
// Sand Cracker Implementation
// =============================================================================

interface SandState {
  currentPhase: string;
  completedPhases: string[];
  totalCracked: number;
  phaseCracked: Record<string, number>;
  hashlistIds: Record<string, number>;
  taskIds: Record<string, number>;
  startedAt: string;
  lastUpdated: string;
}

function loadSandState(): SandState {
  const statePath = resolve(DATA_DIR, "sand-state.json");
  if (existsSync(statePath)) {
    return JSON.parse(readFileSync(statePath, "utf-8"));
  }
  return {
    currentPhase: "",
    completedPhases: [],
    totalCracked: 0,
    phaseCracked: {},
    hashlistIds: {},
    taskIds: {},
    startedAt: new Date().toISOString(),
    lastUpdated: new Date().toISOString(),
  };
}

function saveSandState(state: SandState): void {
  const statePath = resolve(DATA_DIR, "sand-state.json");
  state.lastUpdated = new Date().toISOString();
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}

/**
 * Load SAND hashlist (remaining uncracked hashes)
 */
async function loadSandHashes(): Promise<string[]> {
  const sandPath = resolve(DATA_DIR, "sand.txt");
  const sandGzPath = resolve(DATA_DIR, "sand.txt.gz");

  let content: string;
  if (existsSync(sandGzPath)) {
    content = gunzipSync(readFileSync(sandGzPath)).toString("utf-8");
  } else if (existsSync(sandPath)) {
    content = readFileSync(sandPath, "utf-8");
  } else {
    throw new Error("SAND hashlist not found. Run initial crack first.");
  }

  return content.trim().split("\n").filter((h) => h.length === 40);
}

/**
 * Submit a phase to Hashcrack
 */
async function submitPhase(
  phase: AttackPhase,
  hashes: string[],
  client: any,
  dryRun: boolean
): Promise<{ hashlistId: number; taskId: number }> {
  console.log(`\nSubmitting phase: ${phase.name}`);
  console.log(`  Attack: ${phase.attackCmd}`);
  console.log(`  Hashes: ${hashes.length.toLocaleString()}`);
  console.log(`  Est. time: ${phase.estimatedTime}`);

  if (dryRun) {
    console.log("  [DRY RUN - not submitted]");
    return { hashlistId: 0, taskId: 0 };
  }

  // Create hashlist
  const hashlistName = `SAND-${phase.id}`;
  const hashlistId = await client.createHashlist({
    name: hashlistName,
    hashTypeId: HASH_TYPE_SHA1,
    hashes,
  });
  console.log(`  Created hashlist: ${hashlistId}`);

  // Create task
  const taskId = await client.createTask({
    name: `Crack-${hashlistName}`,
    hashlistId,
    attackCmd: phase.attackCmd,
    maxAgents: phase.maxAgents,
    priority: phase.priority,
  });
  console.log(`  Created task: ${taskId}`);

  return { hashlistId, taskId };
}

/**
 * List available phases
 */
function listPhases(): void {
  console.log("SAND Cracking Pipeline - Available Phases\n");
  console.log("=" .repeat(80));

  const sortedPhases = [...ATTACK_PHASES].sort((a, b) => b.priority - a.priority);

  for (const phase of sortedPhases) {
    console.log(`\n[${phase.id}] ${phase.name}`);
    console.log(`  Priority: ${phase.priority} | Agents: ${phase.maxAgents || "unlimited"}`);
    console.log(`  Est. time: ${phase.estimatedTime}`);
    console.log(`  Command: ${phase.attackCmd}`);
  }
}

/**
 * Show pipeline status
 */
async function showStatus(): Promise<void> {
  const state = loadSandState();

  console.log("SAND Cracking Pipeline - Status\n");
  console.log("=" .repeat(60));
  console.log(`Started: ${state.startedAt}`);
  console.log(`Last updated: ${state.lastUpdated}`);
  console.log(`Total cracked: ${state.totalCracked.toLocaleString()}`);
  console.log(`\nCompleted phases (${state.completedPhases.length}):`);

  for (const phaseId of state.completedPhases) {
    const cracked = state.phaseCracked[phaseId] || 0;
    console.log(`  - ${phaseId}: ${cracked.toLocaleString()} cracked`);
  }

  if (state.currentPhase) {
    console.log(`\nCurrent phase: ${state.currentPhase}`);
  }

  const remaining = ATTACK_PHASES.filter(
    (p) => !state.completedPhases.includes(p.id)
  );
  console.log(`\nRemaining phases: ${remaining.length}`);
}

/**
 * Run the cracking pipeline
 */
async function runPipeline(options: {
  phase?: string;
  all?: boolean;
  dryRun?: boolean;
  workers?: number;
}): Promise<void> {
  const { dryRun = false, workers = 1 } = options;

  // Load SAND hashes
  let sandHashes: string[];
  try {
    sandHashes = await loadSandHashes();
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }

  console.log("SAND Cracking Pipeline\n");
  console.log("=" .repeat(60));
  console.log(`SAND hashes: ${sandHashes.length.toLocaleString()}`);
  console.log(`Dry run: ${dryRun}`);
  console.log(`Workers: ${workers}`);

  if (!dryRun) {
    // Initialize Hashcrack client
    const { HashtopolisClient } = await getHashtopolisClient();
    const client = HashtopolisClient.fromEnv();

    console.log("\nTesting Hashcrack connection...");
    const connected = await client.testConnection();
    if (!connected) {
      console.error("Failed to connect to Hashtopolis server");
      process.exit(1);
    }
    console.log("Connected successfully");
  }

  const state = loadSandState();

  // Determine which phases to run
  let phasesToRun: AttackPhase[];
  if (options.phase) {
    const phase = ATTACK_PHASES.find((p) => p.id === options.phase);
    if (!phase) {
      console.error(`Unknown phase: ${options.phase}`);
      console.error("Use --list to see available phases");
      process.exit(1);
    }
    phasesToRun = [phase];
  } else if (options.all) {
    phasesToRun = ATTACK_PHASES
      .filter((p) => !state.completedPhases.includes(p.id))
      .sort((a, b) => b.priority - a.priority);
  } else {
    // Default: run next incomplete phase
    phasesToRun = ATTACK_PHASES
      .filter((p) => !state.completedPhases.includes(p.id))
      .sort((a, b) => b.priority - a.priority)
      .slice(0, 1);
  }

  if (phasesToRun.length === 0) {
    console.log("\nAll phases complete!");
    return;
  }

  console.log(`\nPhases to run: ${phasesToRun.length}`);
  for (const phase of phasesToRun) {
    console.log(`  - [${phase.id}] ${phase.name}`);
  }

  if (!dryRun) {
    const { HashtopolisClient } = await getHashtopolisClient();
    const client = HashtopolisClient.fromEnv();

    for (const phase of phasesToRun) {
      state.currentPhase = phase.id;
      saveSandState(state);

      const { hashlistId, taskId } = await submitPhase(phase, sandHashes, client, dryRun);

      state.hashlistIds[phase.id] = hashlistId;
      state.taskIds[phase.id] = taskId;
      saveSandState(state);
    }
  } else {
    for (const phase of phasesToRun) {
      await submitPhase(phase, sandHashes, null, dryRun);
    }
  }

  console.log("\nPipeline submission complete");
  console.log("Monitor progress with: bun Tools/SandCracker.ts --status");
}

// =============================================================================
// CLI Usage
// =============================================================================

if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args[0] === "--help" || args[0] === "-h") {
    console.log(`
SandCracker - Systematic SAND Hash Cracking Pipeline

Usage:
  bun SandCracker.ts                    Run next incomplete phase
  bun SandCracker.ts --all              Run all remaining phases
  bun SandCracker.ts --phase <id>       Run specific phase
  bun SandCracker.ts --list             List available phases
  bun SandCracker.ts --status           Show pipeline status
  bun SandCracker.ts --dry-run          Preview without submitting

Nomenclature:
  ROCKS  = Full HIBP (~1B hashes)
  GRAVEL = ROCKS - rockyou matches
  SAND   = GRAVEL - initial crack (hard passwords)
  PEARLS = Cracked cleartext passwords

Phases run in priority order (highest first):
  100: Quick wins (best64, common lists)
   80: Rule stacking (dive, d3ad0ne)
   60: Combinator attacks
   50: Hybrid attacks (dict+mask)
   35: Mask attacks (patterns)
   25: PRINCE attacks
   15: Brute force (last resort)
`);
    process.exit(0);
  }

  // Parse arguments
  let phase: string | undefined;
  let all = false;
  let dryRun = false;
  let workers = 1;
  let list = false;
  let status = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--phase":
        phase = args[++i];
        break;
      case "--all":
        all = true;
        break;
      case "--dry-run":
        dryRun = true;
        break;
      case "--workers":
        workers = parseInt(args[++i]) || 1;
        break;
      case "--list":
        list = true;
        break;
      case "--status":
        status = true;
        break;
    }
  }

  try {
    if (list) {
      listPhases();
    } else if (status) {
      await showStatus();
    } else {
      await runPipeline({ phase, all, dryRun, workers });
    }
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
  }
}
