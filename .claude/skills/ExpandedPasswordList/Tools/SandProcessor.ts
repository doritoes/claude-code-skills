#!/usr/bin/env bun
/**
 * SandProcessor.ts - Orchestrate Escalating Attacks on SAND Batches
 *
 * Processes SAND (uncracked hashes from initial rockyou+OneRule attack)
 * through escalating attacks to produce:
 * - DIAMONDS (cracked passwords)
 * - GLASS (uncracked hashes)
 * - BETA.txt (new root words discovered)
 * - UNOBTAINIUM.rule (new rules derived from patterns)
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const CURRENT_FILE = fileURLToPath(import.meta.url);
const SKILL_DIR = dirname(dirname(CURRENT_FILE));
const DATA_DIR = resolve(SKILL_DIR, "data");
const SAND_DIR = "//192.168.99.252/files/Passwords/ExpandedPasswordList/data/sand";
const OUTPUT_DIR = resolve(DATA_DIR, "processed");

// =============================================================================
// Attack Configuration
// =============================================================================

interface AttackConfig {
  name: string;
  priority: number;
  type: "rule" | "hybrid" | "mask" | "brute" | "combinator";
  command: string;
  estimatedTime: string;
  projectedSuccess: string;
  costTier: "$" | "$$" | "$$$" | "$$$$";
}

const ATTACK_SEQUENCE: AttackConfig[] = [
  // Tier 1: High ROI
  {
    name: "brute-1-6",
    priority: 100,
    type: "brute",
    command: "-a 3 '?a?a?a?a?a?a' --increment --increment-min=1",
    estimatedTime: "30 sec",
    projectedSuccess: "0.5-1%",
    costTier: "$",
  },
  {
    name: "best64-rockyou",
    priority: 95,
    type: "rule",
    command: "-a 0 rockyou.txt -r best64.rule",
    estimatedTime: "1-2 min",
    projectedSuccess: "5-8%",
    costTier: "$",
  },
  {
    name: "hybrid-1digit",
    priority: 92,
    type: "hybrid",
    command: "-a 6 rockyou.txt '?d'",
    estimatedTime: "<1 min",
    projectedSuccess: "1-2%",
    costTier: "$",
  },
  {
    name: "hybrid-2digit",
    priority: 91,
    type: "hybrid",
    command: "-a 6 rockyou.txt '?d?d'",
    estimatedTime: "<1 min",
    projectedSuccess: "1-2%",
    costTier: "$",
  },
  {
    name: "hybrid-3digit",
    priority: 90,
    type: "hybrid",
    command: "-a 6 rockyou.txt '?d?d?d'",
    estimatedTime: "<1 min",
    projectedSuccess: "1-2%",
    costTier: "$",
  },
  {
    name: "hybrid-4digit",
    priority: 89,
    type: "hybrid",
    command: "-a 6 rockyou.txt '?d?d?d?d'",
    estimatedTime: "1-2 min",
    projectedSuccess: "2-3%",
    costTier: "$",
  },
  {
    name: "hybrid-year-19xx",
    priority: 88,
    type: "hybrid",
    command: "-a 6 rockyou.txt '19?d?d'",
    estimatedTime: "<1 min",
    projectedSuccess: "0.5-1%",
    costTier: "$",
  },
  {
    name: "hybrid-year-20xx",
    priority: 87,
    type: "hybrid",
    command: "-a 6 rockyou.txt '20?d?d'",
    estimatedTime: "<1 min",
    projectedSuccess: "1-2%",
    costTier: "$",
  },

  // Tier 2: Medium ROI
  {
    name: "rizzyou-onerule",
    priority: 80,
    type: "rule",
    command: "-a 0 rizzyou.txt -r OneRuleToRuleThemStill.rule",
    estimatedTime: "2-3 min",
    projectedSuccess: "1-3%",
    costTier: "$",
  },
  {
    name: "d3ad0ne-rockyou",
    priority: 75,
    type: "rule",
    command: "-a 0 rockyou.txt -r d3ad0ne.rule",
    estimatedTime: "5-10 min",
    projectedSuccess: "2-4%",
    costTier: "$$",
  },

  // Tier 3: Long-Tail
  {
    name: "dive-rockyou",
    priority: 60,
    type: "rule",
    command: "-a 0 rockyou.txt -r dive.rule",
    estimatedTime: "15-30 min",
    projectedSuccess: "3-5%",
    costTier: "$$",
  },
  {
    name: "mask-Ullllldd",
    priority: 50,
    type: "mask",
    command: "-a 3 '?u?l?l?l?l?l?d?d'",
    estimatedTime: "5-10 min",
    projectedSuccess: "1-2%",
    costTier: "$$",
  },
  {
    name: "mask-Ullllllld",
    priority: 49,
    type: "mask",
    command: "-a 3 '?u?l?l?l?l?l?l?d'",
    estimatedTime: "5-10 min",
    projectedSuccess: "1-2%",
    costTier: "$$",
  },
  {
    name: "brute-7",
    priority: 30,
    type: "brute",
    command: "-a 3 '?a?a?a?a?a?a?a'",
    estimatedTime: "45 min",
    projectedSuccess: "0.3-0.5%",
    costTier: "$$$",
  },

  // Tier 4: Expensive (optional)
  {
    name: "brute-8",
    priority: 10,
    type: "brute",
    command: "-a 3 '?a?a?a?a?a?a?a?a'",
    estimatedTime: "72+ hours",
    projectedSuccess: "0.2-0.3%",
    costTier: "$$$$",
  },
];

// =============================================================================
// State Management
// =============================================================================

interface BatchResult {
  batchId: string;
  startTime: string;
  endTime?: string;
  attacks: AttackResult[];
  attacksApplied: string[]; // Track which attacks were applied to this batch
  totalHashes: number;
  totalCracked: number;
  crackRate: number;
  diamondsFile?: string;
  glassFile?: string;
  glassHashes?: number; // Track remaining uncracked for future attacks
  betaFile?: string;
  unobtainiumFile?: string;
}

interface AttackResult {
  attack: string;
  cracked: number;
  time: number;
  successRate: number;
}

interface ProcessorState {
  version: number;
  lastUpdated: string;
  processedBatches: string[];
  results: BatchResult[];
  attackEffectiveness: Record<string, { totalCracked: number; totalRuns: number; avgRate: number }>;
  // Track which attacks have been tried on each batch's GLASS for future processing
  glassAttackHistory: Record<string, string[]>; // batchId -> attacks already tried
}

function loadState(): ProcessorState {
  const statePath = resolve(DATA_DIR, "sand-processor-state.json");
  if (existsSync(statePath)) {
    return JSON.parse(readFileSync(statePath, "utf-8"));
  }
  return {
    version: 1,
    lastUpdated: new Date().toISOString(),
    processedBatches: [],
    results: [],
    attackEffectiveness: {},
    glassAttackHistory: {},
  };
}

function saveState(state: ProcessorState): void {
  const statePath = resolve(DATA_DIR, "sand-processor-state.json");
  state.lastUpdated = new Date().toISOString();
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}

// =============================================================================
// Attack Execution (Placeholder - actual execution via Hashcrack)
// =============================================================================

function getAttackPlan(skipBrute8 = true): AttackConfig[] {
  const attacks = ATTACK_SEQUENCE.filter(a => !skipBrute8 || a.name !== "brute-8");
  return attacks.sort((a, b) => b.priority - a.priority);
}

function formatAttackTable(attacks: AttackConfig[]): string {
  const header = "| # | Attack | Type | Est. Time | Projected % | Cost |";
  const divider = "|---|--------|------|-----------|-------------|------|";
  const rows = attacks.map((a, i) =>
    `| ${i + 1} | ${a.name} | ${a.type} | ${a.estimatedTime} | ${a.projectedSuccess} | ${a.costTier} |`
  );
  return [header, divider, ...rows].join("\n");
}

// =============================================================================
// Analysis Functions
// =============================================================================

function analyzeEffectiveness(state: ProcessorState): string {
  if (state.results.length === 0) {
    return "No batches processed yet. Run first batch to collect data.";
  }

  const sorted = Object.entries(state.attackEffectiveness)
    .sort(([, a], [, b]) => b.avgRate - a.avgRate);

  const lines = ["## Attack Effectiveness (Actual Results)", ""];
  lines.push("| Attack | Total Cracked | Runs | Avg Rate |");
  lines.push("|--------|---------------|------|----------|");

  for (const [name, stats] of sorted) {
    lines.push(`| ${name} | ${stats.totalCracked.toLocaleString()} | ${stats.totalRuns} | ${(stats.avgRate * 100).toFixed(2)}% |`);
  }

  return lines.join("\n");
}

/**
 * Get attacks NOT yet tried on a batch's GLASS
 */
function getUntriedAttacks(state: ProcessorState, batchId: string): AttackConfig[] {
  const triedAttacks = state.glassAttackHistory[batchId] || [];
  return ATTACK_SEQUENCE.filter(a => !triedAttacks.includes(a.name));
}

/**
 * Suggest next attacks for GLASS processing
 */
function suggestGlassAttacks(state: ProcessorState, batchId: string): string {
  const untried = getUntriedAttacks(state, batchId);

  if (untried.length === 0) {
    return `All attacks have been tried on batch-${batchId} GLASS. Consider:\n` +
      `  • New wordlists from BETA.txt\n` +
      `  • New rules from UNOBTAINIUM.rule\n` +
      `  • Markov chain trained on DIAMONDS`;
  }

  const lines = [`Untried attacks for batch-${batchId} GLASS (${untried.length} remaining):`, ""];
  lines.push("| Attack | Type | Est. Time | Projected % | Cost |");
  lines.push("|--------|------|-----------|-------------|------|");

  for (const a of untried.slice(0, 10)) {
    lines.push(`| ${a.name} | ${a.type} | ${a.estimatedTime} | ${a.projectedSuccess} | ${a.costTier} |`);
  }

  if (untried.length > 10) {
    lines.push(`\n... and ${untried.length - 10} more attacks available`);
  }

  return lines.join("\n");
}

function generateRecommendations(state: ProcessorState): string[] {
  const recommendations: string[] = [];

  if (state.results.length === 0) {
    return ["Process batch-0001 first to establish baseline metrics"];
  }

  const lastBatch = state.results[state.results.length - 1];

  // Check for underperforming attacks
  for (const attack of lastBatch.attacks) {
    if (attack.successRate < 0.001) { // Less than 0.1%
      recommendations.push(`Consider removing '${attack.attack}' - yielded only ${(attack.successRate * 100).toFixed(3)}%`);
    }
  }

  // Check for high-performing attacks that could be expanded
  const topAttacks = Object.entries(state.attackEffectiveness)
    .sort(([, a], [, b]) => b.avgRate - a.avgRate)
    .slice(0, 3);

  for (const [name, stats] of topAttacks) {
    if (stats.avgRate > 0.03) { // More than 3%
      recommendations.push(`'${name}' is highly effective (${(stats.avgRate * 100).toFixed(2)}%) - consider rule stacking variants`);
    }
  }

  // Brute force analysis
  const brute7 = state.attackEffectiveness["brute-7"];
  if (brute7 && brute7.avgRate > 0.003) {
    recommendations.push(`brute-7 yielded ${(brute7.avgRate * 100).toFixed(2)}% - consider adding brute-8 for next batch`);
  }

  return recommendations.length > 0 ? recommendations : ["No changes recommended - continue with current strategy"];
}

// =============================================================================
// CLI
// =============================================================================

function printHelp(): void {
  console.log(`
SandProcessor - Orchestrate escalating attacks on SAND batches

Usage:
  bun SandProcessor.ts --plan                    Show attack plan
  bun SandProcessor.ts --plan --include-brute8   Include brute-8 in plan
  bun SandProcessor.ts --process <batch>         Process a batch (e.g., 0001)
  bun SandProcessor.ts --status                  Show processing status
  bun SandProcessor.ts --effectiveness           Show attack effectiveness
  bun SandProcessor.ts --recommend               Generate recommendations
  bun SandProcessor.ts --glass <batch>           Show untried attacks for GLASS
  bun SandProcessor.ts --history <batch>         Show attack history for batch

Output Files:
  data/processed/batch-XXXX-diamonds.txt   Cracked passwords
  data/processed/batch-XXXX-glass.txt      Uncracked hashes
  data/processed/BETA.txt                  New root words (cumulative)
  data/processed/UNOBTAINIUM.rule          New rules (cumulative)

Strategy Tracking:
  Each batch tracks which attacks have been applied, so GLASS can be
  processed later with new/untried attacks to extract more DIAMONDS.
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h") || args.length === 0) {
    printHelp();
    return;
  }

  // Ensure output directory exists
  if (!existsSync(OUTPUT_DIR)) {
    mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const state = loadState();

  if (args.includes("--plan")) {
    const skipBrute8 = !args.includes("--include-brute8");
    const attacks = getAttackPlan(skipBrute8);
    console.log("\n## SAND Processing Attack Plan\n");
    console.log(formatAttackTable(attacks));
    console.log(`\nTotal attacks: ${attacks.length}`);
    console.log(`Brute-8 (72+ hours): ${skipBrute8 ? "EXCLUDED" : "INCLUDED"}`);
    return;
  }

  if (args.includes("--status")) {
    console.log("\n## SAND Processor Status\n");
    console.log(`Batches processed: ${state.processedBatches.length}`);
    console.log(`Last updated: ${state.lastUpdated}`);

    if (state.results.length > 0) {
      const last = state.results[state.results.length - 1];
      console.log(`\nLast batch: ${last.batchId}`);
      console.log(`  Cracked: ${last.totalCracked.toLocaleString()} / ${last.totalHashes.toLocaleString()} (${(last.crackRate * 100).toFixed(2)}%)`);
    }
    return;
  }

  if (args.includes("--effectiveness")) {
    console.log(analyzeEffectiveness(state));
    return;
  }

  if (args.includes("--recommend")) {
    console.log("\n## Recommendations for Next Batch\n");
    const recs = generateRecommendations(state);
    for (const rec of recs) {
      console.log(`• ${rec}`);
    }
    return;
  }

  const processIdx = args.indexOf("--process");
  if (processIdx !== -1 && args[processIdx + 1]) {
    const batchId = args[processIdx + 1].padStart(4, "0");
    console.log(`\n⚠️ Batch processing not yet implemented.`);
    console.log(`\nTo process batch-${batchId}:`);
    console.log(`1. Submit attacks via Hashcrack skill`);
    console.log(`2. Collect results with ResultCollector`);
    console.log(`3. Run DiamondAnalyzer on cracked passwords`);
    console.log(`4. Run BetaExtractor to find new root words`);
    console.log(`5. Run RuleGenerator to derive new rules`);
    return;
  }

  const glassIdx = args.indexOf("--glass");
  if (glassIdx !== -1 && args[glassIdx + 1]) {
    const batchId = args[glassIdx + 1].padStart(4, "0");
    console.log(suggestGlassAttacks(state, batchId));
    return;
  }

  const historyIdx = args.indexOf("--history");
  if (historyIdx !== -1 && args[historyIdx + 1]) {
    const batchId = args[historyIdx + 1].padStart(4, "0");
    const history = state.glassAttackHistory[batchId] || [];

    if (history.length === 0) {
      console.log(`\nNo attacks recorded for batch-${batchId}`);
    } else {
      console.log(`\n## Attack History for batch-${batchId}\n`);
      console.log(`Attacks applied (${history.length}):`);
      for (const attack of history) {
        console.log(`  • ${attack}`);
      }
    }

    // Also show batch result if available
    const result = state.results.find(r => r.batchId === batchId);
    if (result) {
      console.log(`\nBatch Results:`);
      console.log(`  Total hashes: ${result.totalHashes.toLocaleString()}`);
      console.log(`  Total cracked: ${result.totalCracked.toLocaleString()}`);
      console.log(`  Crack rate: ${(result.crackRate * 100).toFixed(2)}%`);
      console.log(`  GLASS remaining: ${(result.glassHashes || (result.totalHashes - result.totalCracked)).toLocaleString()}`);
    }
    return;
  }

  console.error("Unknown command. Use --help for usage.");
  process.exit(1);
}

main().catch(console.error);
