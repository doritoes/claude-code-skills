#!/usr/bin/env bun
/**
 * Brute8Planner.ts — Plan and execute 8-char brute-force attacks on combined GLASS.
 *
 * Two-phase approach:
 *   Phase 1 "thin": mask-lud8 (-1 ?l?u?d ?1^8, 62^8) — catches ~88% of 8-char
 *     passwords in ~hours. Fast, high-value. Removes alphanumeric 8-char from glass.
 *   Phase 2 "brute8": full ?a^8 (95^8) — catches remaining 8-char passwords
 *     (special chars). Expensive (~7+ days). Runs on thinned glass for less overhead.
 *
 * Group sizing targets ~7M hashes per group (peak throughput from speed curve).
 * Thin and brute8 share a potfile per group so brute8 auto-skips thin's cracks.
 *
 * Usage:
 *   bun Tools/Brute8Planner.ts --plan                      # Show both phases
 *   bun Tools/Brute8Planner.ts --run --thin --group 1       # Phase 1: thin
 *   bun Tools/Brute8Planner.ts --collect --thin --group 1   # Collect thin cracks
 *   bun Tools/Brute8Planner.ts --run --group 1              # Phase 2: brute8
 *   bun Tools/Brute8Planner.ts --collect --group 1          # Collect brute8 cracks
 *   bun Tools/Brute8Planner.ts --status --group 1           # Check progress
 *
 * Speed degradation (RTX 4060 Ti, SHA-1 mask, measured 2026-03):
 *   500K-2M: 10.5 GH/s (1.00x) | 3M: 0.97x | 5M: 0.85x | 10M: 0.34x | 54M: 0.022x
 */

import { resolve } from "node:path";
import {
  existsSync, readFileSync, writeFileSync, readdirSync,
  appendFileSync, mkdirSync, renameSync, unlinkSync,
} from "node:fs";
import { DATA_DIR, GLASS_DIR, DIAMONDS_DIR, decodeHexPlain } from "./config";
import { loadConfig, sshCmd, scpUpload, scpDownload, type BigRedConfig } from "./BigRedSync";
import { SandStateManager } from "./SandStateManager";

// ── Attack Definitions ─────────────────────────────────────────

const ATTACKS = {
  thin: {
    name: "mask-lud8",
    mask: "-1 ?l?u?d ?1?1?1?1?1?1?1?1",
    keyspace: 62 ** 8,  // 218,340,105,584,896
    // After Stage 2 (mask-l8/ld8 already ran), thin catches the uppercase-containing
    // 8-char passwords. ~16,729 per batch-0001 glass (6% of glass).
    glassReductionPct: 0.06,
  },
  brute8: {
    name: "brute-8",
    mask: "?a?a?a?a?a?a?a?a",
    keyspace: 95 ** 8,  // 6,634,204,312,890,625
    glassReductionPct: 0.0, // unknown until thin runs
  },
} as const;

type AttackMode = keyof typeof ATTACKS;

// Max hashes per group — targets peak throughput in the well-measured portion
// of the speed curve (between 5M-10M). Beyond 10M, we only have one data point
// (54M) and linear interpolation may overestimate speed.
// Update when GPU changes (e.g., RTX 5060 Ti 16GB → likely higher).
const MAX_GROUP_HASHES = 7_000_000;

// ── Speed Model ────────────────────────────────────────────────

/** Measured speed degradation: [hashCount, GH/s] */
const SPEED_CURVE: [number, number][] = [
  [500_000,     10.5],
  [2_000_000,   10.5],
  [3_000_000,   10.185],
  [5_000_000,    8.925],
  [10_000_000,   3.57],
  [54_000_000,   0.231],
];

function interpolateSpeed(hashCount: number): number {
  if (hashCount <= SPEED_CURVE[0][0]) return SPEED_CURVE[0][1];
  for (let i = 1; i < SPEED_CURVE.length; i++) {
    const [h0, s0] = SPEED_CURVE[i - 1];
    const [h1, s1] = SPEED_CURVE[i];
    if (hashCount <= h1) {
      const t = (hashCount - h0) / (h1 - h0);
      return s0 + t * (s1 - s0);
    }
  }
  const [hLast, sLast] = SPEED_CURVE[SPEED_CURVE.length - 1];
  const [hPrev, sPrev] = SPEED_CURVE[SPEED_CURVE.length - 2];
  const rate = (sLast - sPrev) / (hLast - hPrev);
  return Math.max(0.01, sLast + rate * (hashCount - hLast));
}

function estimateDays(hashCount: number, keyspace: number): number {
  return keyspace / (interpolateSpeed(hashCount) * 1e9) / 86400;
}

// ── Utilities ──────────────────────────────────────────────────

function countLines(filePath: string): number {
  const buf = readFileSync(filePath);
  let count = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0A) count++;
  }
  if (buf.length > 0 && buf[buf.length - 1] !== 0x0A) count++;
  return count;
}

function fmt(n: number): string { return n.toLocaleString(); }

function fmtDays(days: number): string {
  if (days < 1) return `${(days * 24).toFixed(1)} hours`;
  return `${days.toFixed(1)} days`;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Parse hashcat log Started/Stopped lines to get total run duration in seconds.
 *  Retries up to 3 times with 5s delay — log may not be fully flushed immediately after hashcat exits. */
function parseLogDuration(config: BigRedConfig, mode: AttackMode, groupId: number): number {
  const logFile = `${config.workDir}/hashcat-${mode}-g${groupId}.log`;
  const MAX_RETRIES = 3;
  const RETRY_DELAY_MS = 5_000;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      // grep for Started/Stopped lines — these appear in hashcat's final summary
      // Started: may not be at line start (preceded by prompt text like "=> ")
      const lines = sshCmd(config, `grep -E '(^Started|^Stopped|=> Started|=> Stopped)' ${logFile} 2>/dev/null | tail -2`, 15_000);
      const startMatch = lines.match(/Started[.:]+\s*(.+)/);
      const stopMatch = lines.match(/Stopped[.:]+\s*(.+)/);
      if (startMatch && stopMatch) {
        const started = new Date(startMatch[1].trim());
        const stopped = new Date(stopMatch[1].trim());
        if (!isNaN(started.getTime()) && !isNaN(stopped.getTime())) {
          return Math.max(1, Math.round((stopped.getTime() - started.getTime()) / 1000));
        }
      }
      // Lines found but couldn't parse — retry after delay (log may be partially flushed)
      if (attempt < MAX_RETRIES) {
        const start = Date.now();
        while (Date.now() - start < RETRY_DELAY_MS) {} // busy-wait (sync context)
      }
    } catch {
      if (attempt < MAX_RETRIES) {
        const start = Date.now();
        while (Date.now() - start < RETRY_DELAY_MS) {}
      }
    }
  }
  return 0;
}

// ── Glass Inventory ────────────────────────────────────────────

interface GlassBatch { name: string; path: string; hashes: number; }

function scanGlass(): GlassBatch[] {
  if (!existsSync(GLASS_DIR)) {
    console.error(`GLASS directory not found: ${GLASS_DIR}`);
    process.exit(1);
  }
  return readdirSync(GLASS_DIR)
    .filter(f => /^batch-\d{4}\.txt$/.test(f))
    .sort()
    .map(f => ({
      name: f.replace(".txt", ""),
      path: resolve(GLASS_DIR, f),
      hashes: countLines(resolve(GLASS_DIR, f)),
    }));
}

// ── Plan & State ───────────────────────────────────────────────

const PLAN_FILE = resolve(DATA_DIR, "brute8-plan.json");
const STATE_FILE = resolve(DATA_DIR, "brute8-state.json");

interface GroupPlan {
  id: number;
  batches: string[];
  totalHashes: number;
}

interface PhasePlan {
  attack: AttackMode;
  keyspace: number;
  groups: (GroupPlan & { speedGHs: number; estimatedDays: number })[];
  totalDays: number;
  optimalGroupSize: number;
}

interface Brute8Plan {
  created: string;
  totalBatches: number;
  totalHashes: number;
  avgPerBatch: number;
  thin: PhasePlan;
  brute8: PhasePlan;
  combinedDays: number;
}

interface GroupState {
  thin: "pending" | "running" | "completed";
  brute8: "pending" | "running" | "completed";
  collectedLines: number; // potfile lines already collected
}

interface Brute8State {
  groups: Record<string, GroupState>;
}

function loadState(): Brute8State {
  if (existsSync(STATE_FILE)) {
    return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
  }
  return { groups: {} };
}

function saveState(state: Brute8State): void {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
}

function getGroupState(state: Brute8State, groupId: number): GroupState {
  const key = String(groupId);
  if (!state.groups[key]) {
    state.groups[key] = { thin: "pending", brute8: "pending", collectedLines: 0 };
  }
  return state.groups[key];
}

/** Find optimal group size (maximizes batches/day, capped at MAX_GROUP_HASHES). */
function findOptimalGroupSize(totalBatches: number, avgPerBatch: number, keyspace: number): number {
  const maxSize = Math.min(totalBatches, Math.floor(MAX_GROUP_HASHES / avgPerBatch));
  let bestSize = 1;
  let bestBpd = 0;
  for (let size = 1; size <= Math.max(maxSize, 1); size++) {
    const hashes = Math.round(avgPerBatch * size);
    const days = estimateDays(hashes, keyspace);
    const bpd = size / days;
    if (bpd > bestBpd) {
      bestBpd = bpd;
      bestSize = size;
    }
  }
  return bestSize;
}

/** Build phase plan with groups of optimal size. Preserves existing groups and appends new ones. */
function buildPhase(
  attack: AttackMode,
  newBatches: GlassBatch[],
  avgPerBatch: number,
  existingGroups: PhasePlan["groups"] = [],
): PhasePlan {
  const keyspace = ATTACKS[attack].keyspace;
  const nextId = existingGroups.length > 0
    ? Math.max(...existingGroups.map(g => g.id)) + 1
    : 1;

  const groups: PhasePlan["groups"] = [...existingGroups];

  if (newBatches.length > 0) {
    const optSize = findOptimalGroupSize(newBatches.length, avgPerBatch, keyspace);
    for (let i = 0; i < newBatches.length; i += optSize) {
      const slice = newBatches.slice(i, i + optSize);
      const h = slice.reduce((s, b) => s + b.hashes, 0);
      groups.push({
        id: nextId + Math.floor(i / optSize),
        batches: slice.map(b => b.name),
        totalHashes: h,
        speedGHs: interpolateSpeed(h),
        estimatedDays: estimateDays(h, keyspace),
      });
    }
  }

  return {
    attack,
    keyspace,
    groups,
    totalDays: groups.reduce((s, g) => s + g.estimatedDays, 0),
    optimalGroupSize: newBatches.length > 0
      ? findOptimalGroupSize(newBatches.length, avgPerBatch, keyspace)
      : (existingGroups.length > 0 ? existingGroups[0].batches.length : 1),
  };
}

function createPlan(glassBatches: GlassBatch[]): Brute8Plan {
  // Load existing plan to preserve completed/running groups
  let existingPlan: Brute8Plan | null = null;
  if (existsSync(PLAN_FILE)) {
    existingPlan = JSON.parse(readFileSync(PLAN_FILE, "utf-8"));
  }

  // Find batches already assigned to existing groups
  const assignedBatches = new Set<string>();
  const existingThinGroups: PhasePlan["groups"] = [];
  const existingBrute8Groups: PhasePlan["groups"] = [];
  if (existingPlan) {
    for (const g of existingPlan.thin.groups) {
      for (const b of g.batches) assignedBatches.add(b);
      existingThinGroups.push(g);
    }
    for (const g of existingPlan.brute8.groups) {
      existingBrute8Groups.push(g);
    }
  }

  // Only plan for NEW batches not in any existing group
  const newBatches = glassBatches.filter(b => !assignedBatches.has(b.name));

  const totalHashes = glassBatches.reduce((s, b) => s + b.hashes, 0);
  const avgPerBatch = totalHashes / glassBatches.length;
  const newAvg = newBatches.length > 0
    ? newBatches.reduce((s, b) => s + b.hashes, 0) / newBatches.length
    : avgPerBatch;

  const thin = buildPhase("thin", newBatches, newAvg, existingThinGroups);

  // For brute8 estimate, assume thin reduces glass by ~6%
  const postThinAvg = newAvg * (1 - ATTACKS.thin.glassReductionPct);
  const brute8 = buildPhase("brute8", newBatches, postThinAvg, existingBrute8Groups);

  if (existingPlan && newBatches.length > 0) {
    console.log(`  Existing groups preserved: ${existingThinGroups.length} thin, ${existingBrute8Groups.length} brute8`);
    console.log(`  New batches to plan: ${newBatches.length} (${newBatches[0].name} → ${newBatches[newBatches.length - 1].name})`);
  } else if (existingPlan && newBatches.length === 0) {
    console.log(`  No new batches — all ${glassBatches.length} already assigned to groups.`);
  }

  return {
    created: new Date().toISOString(),
    totalBatches: glassBatches.length,
    totalHashes,
    avgPerBatch: Math.round(avgPerBatch),
    thin,
    brute8,
    combinedDays: thin.totalDays + brute8.totalDays,
  };
}

// ── Print Plan ─────────────────────────────────────────────────

function printGroupTable(avgH: number, keyspace: number, totalBatches: number, optSize: number): void {
  const sizes = [1, 5, 10, 18, 25, 36, 50, totalBatches]
    .filter((s, i, a) => s <= totalBatches && a.indexOf(s) === i)
    .sort((a, b) => a - b);

  console.log(`    ${"Group".padStart(6)}  ${"Hashes".padStart(9)}  ${"Speed".padStart(9)}  ${"Time".padStart(10)}  ${"Batch/Day".padStart(10)}`);
  console.log(`    ${"─".repeat(6)}  ${"─".repeat(9)}  ${"─".repeat(9)}  ${"─".repeat(10)}  ${"─".repeat(10)}`);

  for (const size of sizes) {
    const hashes = Math.round(avgH * size);
    const speed = interpolateSpeed(hashes);
    const days = estimateDays(hashes, keyspace);
    const bpd = size / days;
    const marker = size === optSize ? " ◀ BEST" : "";
    console.log(
      `    ${String(size).padStart(6)}  ${fmt(hashes).padStart(9)}  ` +
      `${speed.toFixed(1).padStart(6)} GH  ${fmtDays(days).padStart(10)}  ` +
      `${bpd.toFixed(2).padStart(10)}${marker}`
    );
  }
}

function printPlan(plan: Brute8Plan): void {
  const state = loadState();
  const line = "═".repeat(66);
  console.log(`\n${line}`);
  console.log(` GLASS BRUTE PLANNER — RTX 4060 Ti`);
  console.log(line);

  console.log(`\n  Glass Inventory:`);
  console.log(`    Batches:      ${plan.totalBatches}`);
  console.log(`    Total hashes: ${fmt(plan.totalHashes)}`);
  console.log(`    Avg/batch:    ${fmt(plan.avgPerBatch)}`);

  // Phase 1: Thin
  const t = plan.thin;
  console.log(`\n${"─".repeat(66)}`);
  console.log(`  Phase 1: THIN (mask-lud8, 62^8 = ${(t.keyspace / 1e12).toFixed(1)}T)`);
  console.log(`  Catches alphanumeric 8-char passwords not found by mask-l8/ld8`);
  console.log(`  Expected: ~6% glass reduction per group\n`);

  printGroupTable(plan.avgPerBatch, t.keyspace, plan.totalBatches, t.optimalGroupSize);

  console.log(`\n    Optimal group: ${t.optimalGroupSize} batches | Groups: ${t.groups.length} | Total: ${fmtDays(t.totalDays)}`);
  for (const g of t.groups) {
    const gs = getGroupState(state, g.id);
    const status = gs.thin !== "pending" ? ` [${gs.thin.toUpperCase()}]` : "";
    const range = g.batches.length === 1 ? g.batches[0] : `${g.batches[0]} → ${g.batches[g.batches.length - 1]}`;
    console.log(`    Group ${g.id}: ${range} (${fmt(g.totalHashes)} hashes, ~${fmtDays(g.estimatedDays)})${status}`);
  }

  // Phase 2: Brute-8
  const b = plan.brute8;
  console.log(`\n${"─".repeat(66)}`);
  console.log(`  Phase 2: BRUTE-8 (95^8 = ${(b.keyspace / 1e15).toFixed(2)} × 10^15)`);
  console.log(`  After thin removes ~6% of glass hashes\n`);

  const postThinAvg = plan.avgPerBatch * (1 - ATTACKS.thin.glassReductionPct);
  printGroupTable(postThinAvg, b.keyspace, plan.totalBatches, b.optimalGroupSize);

  console.log(`\n    Optimal group: ${b.optimalGroupSize} batches | Groups: ${b.groups.length} | Total: ${fmtDays(b.totalDays)}`);
  for (const g of b.groups) {
    const gs = getGroupState(state, g.id);
    const status = gs.brute8 !== "pending" ? ` [${gs.brute8.toUpperCase()}]` : "";
    const range = g.batches.length === 1 ? g.batches[0] : `${g.batches[0]} → ${g.batches[g.batches.length - 1]}`;
    console.log(`    Group ${g.id}: ${range} (~${fmtDays(g.estimatedDays)})${status}`);
  }

  // Summary
  console.log(`\n${"─".repeat(66)}`);
  console.log(`  Combined: ${fmtDays(plan.combinedDays)} (thin ${fmtDays(t.totalDays)} + brute8 ${fmtDays(b.totalDays)})`);
  console.log(`  Throughput: ${(plan.totalBatches / plan.combinedDays).toFixed(2)} batches/day`);

  console.log(`\n  Workflow:`);
  for (const g of t.groups) {
    console.log(`    bun Tools/Brute8Planner.ts --run --thin --group ${g.id}`);
    console.log(`    bun Tools/Brute8Planner.ts --collect --thin --group ${g.id}`);
  }
  for (const g of b.groups) {
    console.log(`    bun Tools/Brute8Planner.ts --run --group ${g.id}`);
    console.log(`    bun Tools/Brute8Planner.ts --collect --group ${g.id}`);
  }
  console.log();
}

// ── Run ────────────────────────────────────────────────────────

function runGroup(groupId: number, mode: AttackMode): void {
  if (!existsSync(PLAN_FILE)) {
    console.error("No plan found. Run --plan first.");
    process.exit(1);
  }

  const plan: Brute8Plan = JSON.parse(readFileSync(PLAN_FILE, "utf-8"));
  const phase = plan[mode];
  const group = phase.groups.find((g: any) => g.id === groupId);
  if (!group) {
    console.error(`Group ${groupId} not found in ${mode} phase (1-${phase.groups.length}).`);
    process.exit(1);
  }

  // Update state
  const state = loadState();
  const gs = getGroupState(state, groupId);

  if (mode === "brute8" && gs.thin === "pending") {
    console.log("WARNING: Thin phase not yet completed for this group.");
    console.log("  Run thin first for ~6% glass reduction, or proceed anyway.");
    console.log("  Proceeding with brute8...\n");
  }

  const config = loadConfig();
  const atk = ATTACKS[mode];
  const groupName = `group-${groupId}`;

  console.log(`BIGRED: ${config.user}@${config.host}`);
  console.log(`\n${atk.name} — Group ${groupId}: ${group.batches.length} batches, ${fmt(group.totalHashes)} hashes`);
  console.log(`Estimated: ${fmtDays(group.estimatedDays)}`);

  // Combine glass files
  console.log(`\nCombining ${group.batches.length} glass files...`);
  const hashSet = new Set<string>();
  for (const batchName of group.batches) {
    const glassPath = resolve(GLASS_DIR, `${batchName}.txt`);
    if (!existsSync(glassPath)) {
      console.error(`Glass file missing: ${glassPath}`);
      process.exit(1);
    }
    for (const line of readFileSync(glassPath, "utf-8").split("\n")) {
      const h = line.trim();
      if (h && /^[a-fA-F0-9]{40}$/.test(h)) hashSet.add(h.toLowerCase());
    }
  }
  console.log(`  Unique hashes: ${fmt(hashSet.size)}`);

  const localCombined = resolve(DATA_DIR, `${groupName}.txt`);
  writeFileSync(localCombined, [...hashSet].sort().join("\n") + "\n");

  // Upload
  console.log(`\nUploading to BIGRED...`);
  scpUpload(config, localCombined, `${config.workDir}/hashlists/${groupName}.txt`, 300_000);
  console.log(`  Done.`);

  // Shared potfile per group (thin + brute8 accumulate into same potfile)
  const potfile = `potfiles/${groupName}.pot`;
  const hashcatCmd =
    `hashcat -m 100 hashlists/${groupName}.txt -a 3 ` +
    `${atk.mask} ` +
    `--potfile-path ${potfile} -O -w 3 --status --status-timer 300`;

  const screenName = `hc-${mode === "thin" ? "thin" : "brute8"}-g${groupId}`;
  const logFile = `${config.workDir}/hashcat-${mode}-g${groupId}.log`;

  console.log(`\nLaunching ${atk.name}...`);
  console.log(`  Screen:   ${screenName}`);
  console.log(`  Keyspace: ${atk.keyspace > 1e15 ? (atk.keyspace / 1e15).toFixed(2) + " × 10^15" : (atk.keyspace / 1e12).toFixed(1) + "T"}`);
  console.log(`  Est:      ${fmtDays(group.estimatedDays)}`);

  // Kill stale session
  try { sshCmd(config, `screen -X -S ${screenName} quit 2>/dev/null`, 10_000); } catch {}
  try { sshCmd(config, `rm -f ${logFile}`, 10_000); } catch {}

  // Launch
  const escaped = hashcatCmd.replace(/'/g, "'\\''");
  sshCmd(config, `screen -dmS ${screenName} bash -c 'cd ${config.workDir} && ${escaped} > ${logFile} 2>&1'`, 15_000);

  sleepSync(3000);
  const alive = parseInt(sshCmd(config, `screen -ls 2>/dev/null | grep -c '${screenName}' || echo 0`, 10_000));

  if (alive > 0) {
    gs[mode] = "running";
    saveState(state);

    console.log(`\n  hashcat running in screen '${screenName}'`);
    console.log(`\n  Monitor:  ssh -i ~/.ssh/bigred_pai pai@192.168.99.204 'screen -r ${screenName}'`);
    console.log(`  Status:   bun Tools/Brute8Planner.ts --status --group ${groupId}`);
    console.log(`  Collect:  bun Tools/Brute8Planner.ts --collect ${mode === "thin" ? "--thin " : ""}--group ${groupId}`);
  } else {
    console.error(`  FAILED to start. Check: ${logFile}`);
    process.exit(1);
  }
}

// ── Status ─────────────────────────────────────────────────────

/** Find the active group (running or most recent non-completed). */
function findActiveGroup(): { groupId: number; mode: AttackMode } | null {
  const state = loadState();
  // Check for running groups first
  for (const [key, gs] of Object.entries(state.groups)) {
    if (gs.thin === "running") return { groupId: parseInt(key), mode: "thin" };
    if (gs.brute8 === "running") return { groupId: parseInt(key), mode: "brute8" };
  }
  // Fall back to first group with pending work
  if (!existsSync(PLAN_FILE)) return null;
  const plan: Brute8Plan = JSON.parse(readFileSync(PLAN_FILE, "utf-8"));
  for (const g of plan.thin.groups) {
    const gs = state.groups[String(g.id)];
    if (!gs || gs.thin !== "completed") return { groupId: g.id, mode: "thin" };
  }
  for (const g of plan.brute8.groups) {
    const gs = state.groups[String(g.id)];
    if (!gs || gs.brute8 !== "completed") return { groupId: g.id, mode: "brute8" };
  }
  return null;
}

/** Parse hashcat progress from log: returns { pct, speed, eta } or null. */
function parseProgress(config: BigRedConfig, logFile: string): { pct: string; speed: string; eta: string; recovered: string } | null {
  try {
    // Grab last status block — grep for key fields, take last occurrence of each
    const raw = sshCmd(config, `grep -E 'Progress|Speed\\.#1|Time\\.Estimated|^Recovered' ${logFile} 2>/dev/null | tail -8`, 15_000);
    const lines = raw.split("\n");

    let pct = "", speed = "", eta = "", recovered = "";
    for (const line of lines) {
      const l = line.trim();
      if (l.startsWith("Progress")) {
        const m = l.match(/\((\d+\.\d+)%\)/);
        if (m) pct = m[1] + "%";
      }
      if (l.startsWith("Speed.#1")) {
        const m = l.match(/:\s*(.+?)\s*@/);
        if (m) speed = m[1].trim();
      }
      if (l.startsWith("Time.Estimated")) {
        const m = l.match(/\((.+?)\)/);
        if (m) eta = m[1];
      }
      if (l.startsWith("Recovered") && !l.startsWith("Recovered/")) {
        const m = l.match(/(\d+\/\d+)\s*\((\d+\.\d+)%\)/);
        if (m) recovered = `${m[1]} (${m[2]}%)`;
      }
    }
    if (pct || speed || eta || recovered) return { pct, speed, eta, recovered };
  } catch {}
  return null;
}

function fmtElapsed(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

async function checkStatus(targetGroupId?: number): Promise<void> {
  const config = loadConfig();
  const POLL_INTERVAL = 30_000;

  // Auto-detect group if not specified
  let groupId: number;
  let activeMode: AttackMode;
  if (targetGroupId) {
    groupId = targetGroupId;
    const state = loadState();
    const gs = getGroupState(state, groupId);
    activeMode = gs.thin === "running" || gs.thin === "pending" ? "thin" : "brute8";
  } else {
    const active = findActiveGroup();
    if (!active) {
      console.log("No active or pending groups found. Run --plan and --run first.");
      process.exit(0);
    }
    groupId = active.groupId;
    activeMode = active.mode;
  }

  const groupName = `group-${groupId}`;
  const logFile = `${config.workDir}/hashcat-${activeMode}-g${groupId}.log`;
  const plan: Brute8Plan | null = existsSync(PLAN_FILE) ? JSON.parse(readFileSync(PLAN_FILE, "utf-8")) : null;
  const phase = plan?.[activeMode];
  const group = phase?.groups.find((g: any) => g.id === groupId);
  const startTime = Date.now();

  let prevPotCount = 0;
  let prevPollTime = 0;
  let crackRate = 0; // cracks per minute, smoothed

  // Render one status screen
  function render(potCount: number, isRunning: boolean, progress: ReturnType<typeof parseProgress>, error?: string): string {
    const now = Date.now();
    const elapsed = fmtElapsed((now - startTime) / 1000);

    // Calculate crack rate from potfile delta
    if (prevPollTime > 0 && potCount > prevPotCount) {
      const deltaCracks = potCount - prevPotCount;
      const deltaMin = (now - prevPollTime) / 60_000;
      if (deltaMin > 0) crackRate = deltaCracks / deltaMin;
    }
    prevPotCount = potCount;
    prevPollTime = now;
    const state = loadState();
    const gs = getGroupState(state, groupId);
    const line = "═".repeat(60);
    const batchRange = group ? `${group.batches[0]} → ${group.batches[group.batches.length - 1]}` : "unknown";
    const hashes = group ? fmt(group.totalHashes) : "?";

    const rows: string[] = [];
    rows.push(`\x1b[2J\x1b[H`); // clear screen + cursor home
    rows.push(line);
    rows.push(` BRUTE8 STATUS — Group ${groupId} (${ATTACKS[activeMode].name})`);
    rows.push(line);
    rows.push(``);
    rows.push(`  Batches:    ${batchRange} (${group?.batches.length ?? "?"})`);
    rows.push(`  Hashes:     ${hashes}`);
    rows.push(`  Phase:      ${activeMode === "thin" ? "Phase 1: THIN (62^8)" : "Phase 2: BRUTE-8 (95^8)"}`);
    rows.push(`  State:      thin=${gs.thin}  brute8=${gs.brute8}`);
    rows.push(``);
    rows.push(`  ── Progress ──────────────────────────────────────`);

    if (progress?.pct) {
      rows.push(`  Completion: ${progress.pct}`);
    }
    if (progress?.speed) {
      rows.push(`  Speed:      ${progress.speed}`);
    }
    if (progress?.eta) {
      rows.push(`  ETA:        ${progress.eta}`);
    }
    if (progress?.recovered) {
      rows.push(`  Recovered:  ${progress.recovered}`);
    }
    rows.push(`  Potfile:    ${fmt(potCount)} cracks`);
    if (crackRate > 0) {
      rows.push(`  Crack rate: ${fmt(Math.round(crackRate))}/min (${fmt(Math.round(crackRate * 60))}/hr)`);
    }
    rows.push(`  Status:     ${isRunning ? "RUNNING" : "IDLE"}`);
    rows.push(`  Watching:   ${elapsed} (refresh every ${POLL_INTERVAL / 1000}s)`);
    rows.push(``);

    if (error) {
      rows.push(`  WARNING:    ${error}`);
      rows.push(``);
    }
    if (!isRunning) {
      rows.push(`  hashcat not running.`);
      rows.push(`  Next: bun Tools/Brute8Planner.ts --collect ${activeMode === "thin" ? "--thin " : ""}--group ${groupId}`);
    } else {
      rows.push(`  Ctrl+C to stop watching.`);
    }
    rows.push(line);
    return rows.join("\n");
  }

  // First render
  let potCount = parseInt(sshCmd(config, `wc -l < ${config.workDir}/potfiles/${groupName}.pot 2>/dev/null || echo 0`, 15_000).trim());
  const running = parseInt(sshCmd(config, `pgrep -c hashcat 2>/dev/null || echo 0`, 10_000));
  const progress = parseProgress(config, logFile);
  process.stdout.write(render(potCount, running > 0, progress));

  if (running <= 0) return;

  // SSH with one retry (first call after Bun.sleep often fails on Windows)
  function sshRetry(cmd: string, timeout = 15_000): string {
    try {
      return sshCmd(config, cmd, timeout);
    } catch {
      // Brief pause then retry once
      const start = Date.now();
      while (Date.now() - start < 2000) {} // busy-wait 2s (can't await here)
      return sshCmd(config, cmd, timeout);
    }
  }

  // Poll loop
  let notRunningCount = 0;
  let sshErrors = 0;
  const MAX_SSH_ERRORS = 5;
  let lastProgress = progress;
  while (true) {
    await Bun.sleep(POLL_INTERVAL);
    try {
      const hcRunning = parseInt(sshRetry(`pgrep -c hashcat 2>/dev/null || echo 0`));
      potCount = parseInt(sshRetry(`wc -l < ${config.workDir}/potfiles/${groupName}.pot 2>/dev/null || echo 0`).trim());
      const prog = parseProgress(config, logFile);
      lastProgress = prog ?? lastProgress;
      sshErrors = 0; // reset on success

      if (hcRunning > 0) {
        notRunningCount = 0;
        process.stdout.write(render(potCount, true, prog));
      } else {
        notRunningCount++;
        if (notRunningCount >= 2) {
          process.stdout.write(render(potCount, false, prog));
          break;
        }
      }
    } catch (e) {
      sshErrors++;
      const msg = (e as Error).message?.split("\n")[0]?.slice(0, 120) ?? "unknown";
      process.stdout.write(render(potCount, true, lastProgress, `SSH error (${sshErrors}/${MAX_SSH_ERRORS}): ${msg}`));
      if (sshErrors >= MAX_SSH_ERRORS) {
        console.log(`\n  ${MAX_SSH_ERRORS} consecutive SSH failures. Exiting.`);
        break;
      }
    }
  }
}

// ── Collect ────────────────────────────────────────────────────

function collectGroup(groupId: number, mode: AttackMode): void {
  if (!existsSync(PLAN_FILE)) {
    console.error("No plan found. Run --plan first.");
    process.exit(1);
  }

  const plan: Brute8Plan = JSON.parse(readFileSync(PLAN_FILE, "utf-8"));
  const phase = plan[mode];
  const group = phase.groups.find((g: any) => g.id === groupId);
  if (!group) {
    console.error(`Group ${groupId} not found.`);
    process.exit(1);
  }

  const config = loadConfig();
  const groupName = `group-${groupId}`;
  const potRemote = `${config.workDir}/potfiles/${groupName}.pot`;

  console.log(`\nCollecting ${ATTACKS[mode].name} results for group ${groupId}`);

  // Safety check
  const running = parseInt(sshCmd(config, `pgrep -c hashcat 2>/dev/null || echo 0`, 10_000));
  if (running > 0) {
    console.error("hashcat still running. Wait for completion.");
    process.exit(1);
  }

  // Get potfile line count
  const totalPotLines = parseInt(sshCmd(config, `wc -l < ${potRemote} 2>/dev/null || echo 0`, 10_000).trim());
  if (totalPotLines === 0) {
    console.log("No results (potfile empty or missing).");
    return;
  }

  // Load state to find how many lines already collected
  const state = loadState();
  const gs = getGroupState(state, groupId);
  const newLines = totalPotLines - gs.collectedLines;

  console.log(`  Potfile: ${fmt(totalPotLines)} total, ${fmt(gs.collectedLines)} already collected, ${fmt(newLines)} new`);

  if (newLines <= 0) {
    console.log("  No new cracks to collect.");
    gs[mode] = "completed";
    saveState(state);
    return;
  }

  // Download potfile
  if (!existsSync(DIAMONDS_DIR)) mkdirSync(DIAMONDS_DIR, { recursive: true });
  const localPotPath = resolve(DIAMONDS_DIR, `${groupName}.pot`);
  scpDownload(config, potRemote, localPotPath, 600_000);
  console.log(`  Downloaded.`);

  // Parse only NEW lines (skip already-collected)
  const allLines = readFileSync(localPotPath, "utf-8").split("\n").filter(l => l.includes(":"));
  const newEntries = allLines.slice(gs.collectedLines);

  const crackedMap = new Map<string, string>();
  for (const line of newEntries) {
    const idx = line.indexOf(":");
    const hash = line.slice(0, idx).trim().toLowerCase();
    const plain = decodeHexPlain(line.slice(idx + 1).replace(/\r$/, ""));
    if (/^[a-f0-9]{40}$/.test(hash)) crackedMap.set(hash, plain);
  }
  console.log(`  New cracks: ${fmt(crackedMap.size)}`);

  // Attribute to batches and update glass
  let totalAttributed = 0;
  const batchCrackCounts = new Map<string, number>();

  for (const batchName of group.batches) {
    const glassPath = resolve(GLASS_DIR, `${batchName}.txt`);
    if (!existsSync(glassPath)) {
      console.log(`  ${batchName}: glass missing, skip`);
      continue;
    }

    const glassHashes = readFileSync(glassPath, "utf-8")
      .split("\n").map(l => l.trim().toLowerCase()).filter(h => h);

    const batchCracks: { hash: string; plain: string }[] = [];
    const newGlass: string[] = [];

    for (const hash of glassHashes) {
      const plain = crackedMap.get(hash);
      if (plain !== undefined) {
        batchCracks.push({ hash, plain });
      } else {
        newGlass.push(hash);
      }
    }

    totalAttributed += batchCracks.length;
    batchCrackCounts.set(batchName, batchCracks.length);

    if (batchCracks.length > 0) {
      const jsonlPath = resolve(DIAMONDS_DIR, "hash_plaintext_pairs.jsonl");
      appendFileSync(jsonlPath, batchCracks.map(p => JSON.stringify(p)).join("\n") + "\n");

      const pwPath = resolve(DIAMONDS_DIR, `passwords-${batchName}.txt`);
      appendFileSync(pwPath, batchCracks.map(p => p.plain).join("\n") + "\n");
    }

    // Safe-write glass
    const tmpGlass = glassPath + ".new";
    writeFileSync(tmpGlass, newGlass.join("\n") + "\n");
    const written = countLines(tmpGlass);
    if (written !== newGlass.length) {
      console.error(`  ${batchName}: VERIFY FAILED (${written} vs ${newGlass.length}). Kept old glass.`);
      try { unlinkSync(tmpGlass); } catch {}
      continue;
    }
    renameSync(tmpGlass, glassPath);

    console.log(
      `  ${batchName}: +${fmt(batchCracks.length)} diamonds, ` +
      `glass ${fmt(glassHashes.length)} → ${fmt(newGlass.length)}`
    );
  }

  console.log(`\n  Attributed: ${fmt(totalAttributed)} / ${fmt(crackedMap.size)}`);

  // ── Update sand-state.json (makes thin/brute8 visible in AttackReview.ts) ──
  const attackName = ATTACKS[mode].name;
  const totalDuration = parseLogDuration(config, mode, groupId);
  const perBatchDuration = group.batches.length > 0 ? Math.round(totalDuration / group.batches.length) : 0;

  console.log(`\n  Updating sand-state.json...`);
  if (totalDuration > 0) {
    const hrs = Math.floor(totalDuration / 3600);
    const mins = Math.floor((totalDuration % 3600) / 60);
    console.log(`  Log duration: ${hrs}h ${mins}m total, ~${perBatchDuration}s per batch`);
  } else {
    console.log(`  Duration: unknown (log unavailable, using 0)`);
  }

  const sandMgr = new SandStateManager();
  sandMgr.load();
  let sandUpdated = 0;

  for (const batchName of group.batches) {
    const batch = sandMgr.getBatch(batchName);
    if (!batch) {
      console.log(`  ${batchName}: not in sand-state, skipped`);
      continue;
    }
    const cracksForBatch = batchCrackCounts.get(batchName) ?? 0;
    sandMgr.completeAttack(batchName, attackName, cracksForBatch, perBatchDuration);
    sandUpdated++;
  }

  console.log(`  sand-state: ${sandUpdated} batches updated with ${attackName}`);

  // Update brute8 state
  gs.collectedLines = totalPotLines;
  gs[mode] = "completed";
  saveState(state);
  console.log(`  State updated: ${mode} = completed`);

  // Cleanup local combined hashlist (not potfile — keep for potential re-collect)
  const localCombined = resolve(DATA_DIR, `${groupName}.txt`);
  if (existsSync(localCombined)) unlinkSync(localCombined);

  // If both phases done, cleanup BIGRED
  if (gs.thin === "completed" && gs.brute8 === "completed") {
    try {
      sshCmd(config, `rm -f ${config.workDir}/hashlists/${groupName}.txt`, 10_000);
      sshCmd(config, `rm -f ${potRemote}`, 10_000);
      sshCmd(config, `rm -f ${config.workDir}/hashcat-thin-g${groupId}.log`, 10_000);
      sshCmd(config, `rm -f ${config.workDir}/hashcat-brute8-g${groupId}.log`, 10_000);
      console.log(`  Cleaned BIGRED (both phases done).`);
    } catch {}
  }

  console.log(`\n  Done. Glass updated for ${group.batches.length} batches.`);
}

// ── Main ───────────────────────────────────────────────────────

const args = process.argv.slice(2);
const isPlan = args.includes("--plan");
const isRun = args.includes("--run");
const isStatus = args.includes("--status");
const isCollect = args.includes("--collect");
const isThin = args.includes("--thin");
const groupIdx = args.indexOf("--group");
const groupId = groupIdx >= 0 ? parseInt(args[groupIdx + 1]) : 0;
const throughIdx = args.indexOf("--through");
const throughId = throughIdx >= 0 ? parseInt(args[throughIdx + 1]) : 0;
const mode: AttackMode = isThin ? "thin" : "brute8";

/** Wait for hashcat to finish on BIGRED, polling every 30s. Returns potfile line count. */
async function waitForCompletion(config: BigRedConfig, groupId: number, mode: AttackMode): Promise<number> {
  const groupName = `group-${groupId}`;
  const logFile = `${config.workDir}/hashcat-${mode}-g${groupId}.log`;
  const POLL_INTERVAL = 30_000;
  let notRunningCount = 0;
  let sshErrors = 0;
  const MAX_SSH_ERRORS = 10;

  const plan: Brute8Plan | null = existsSync(PLAN_FILE) ? JSON.parse(readFileSync(PLAN_FILE, "utf-8")) : null;
  const group = plan?.[mode]?.groups.find((g: any) => g.id === groupId);
  const startTime = Date.now();
  let prevPotCount = 0;
  let prevPollTime = 0;
  let crackRate = 0;

  console.log(`\n  Waiting for group ${groupId} ${ATTACKS[mode].name} to complete...`);

  while (true) {
    await Bun.sleep(POLL_INTERVAL);
    try {
      const hcRunning = parseInt(sshCmd(config, `pgrep -c hashcat 2>/dev/null || echo 0`, 15_000));
      const potCount = parseInt(sshCmd(config, `wc -l < ${config.workDir}/potfiles/${groupName}.pot 2>/dev/null || echo 0`, 15_000).trim());
      const progress = parseProgress(config, logFile);
      sshErrors = 0;

      // Crack rate
      const now = Date.now();
      if (prevPollTime > 0 && potCount > prevPotCount) {
        const deltaMin = (now - prevPollTime) / 60_000;
        if (deltaMin > 0) crackRate = (potCount - prevPotCount) / deltaMin;
      }
      prevPotCount = potCount;
      prevPollTime = now;

      const elapsed = fmtElapsed((now - startTime) / 1000);
      const pctStr = progress?.pct ? ` ${progress.pct}` : "";
      const speedStr = progress?.speed ? ` @ ${progress.speed}` : "";
      const etaStr = progress?.eta ? ` ETA ${progress.eta}` : "";
      const rateStr = crackRate > 0 ? ` ${fmt(Math.round(crackRate))}/min` : "";

      if (hcRunning > 0) {
        notRunningCount = 0;
        process.stdout.write(`\r  [${elapsed}] Group ${groupId}:${pctStr}${speedStr}${etaStr} | ${fmt(potCount)} cracks${rateStr}     `);
      } else {
        notRunningCount++;
        if (notRunningCount >= 2) {
          console.log(`\n  Group ${groupId} ${ATTACKS[mode].name} completed. ${fmt(potCount)} cracks.`);
          return potCount;
        }
        process.stdout.write(`\r  [${elapsed}] Group ${groupId}: hashcat not running (confirming ${notRunningCount}/2)...     `);
      }
    } catch (e) {
      sshErrors++;
      const msg = (e as Error).message?.split("\n")[0]?.slice(0, 80) ?? "unknown";
      process.stdout.write(`\r  SSH error (${sshErrors}/${MAX_SSH_ERRORS}): ${msg}     `);
      if (sshErrors >= MAX_SSH_ERRORS) {
        console.log(`\n  ${MAX_SSH_ERRORS} consecutive SSH failures. Aborting wait.`);
        process.exit(1);
      }
    }
  }
}

if (isPlan) {
  console.log("Scanning glass directory...");
  const batches = scanGlass();
  if (batches.length === 0) {
    console.log("No glass batches found.");
    process.exit(0);
  }
  console.log(`  Found ${batches.length} batches.`);

  const plan = createPlan(batches);
  printPlan(plan);

  writeFileSync(PLAN_FILE, JSON.stringify(plan, null, 2) + "\n");
  console.log(`Plan saved: ${PLAN_FILE}\n`);
} else if (isRun) {
  if (!groupId) { console.error("Usage: --run [--thin] --group N [--through M]"); process.exit(1); }
  const lastGroup = throughId > groupId ? throughId : groupId;

  for (let gid = groupId; gid <= lastGroup; gid++) {
    console.log(`\n${"═".repeat(60)}`);
    console.log(` GROUP ${gid} / ${lastGroup} — ${ATTACKS[mode].name}`);
    console.log("═".repeat(60));

    // Skip groups that are already completed
    const state = loadState();
    const gs = getGroupState(state, gid);
    if (gs[mode] === "completed") {
      console.log(`  Group ${gid} ${mode} already completed. Skipping.`);
      continue;
    }

    // If group is already running, skip launch but still wait+collect
    if (gs[mode] === "running") {
      console.log(`  Group ${gid} ${mode} already running. Waiting for completion...`);
    } else {
      runGroup(gid, mode);
    }

    // Wait for completion then auto-collect (for --through or single group with --through)
    if (gid < lastGroup || throughId > 0) {
      const config = loadConfig();
      await waitForCompletion(config, gid, mode);
      console.log(`\n  Auto-collecting group ${gid}...`);
      collectGroup(gid, mode);
      console.log();
    }
  }

  if (lastGroup > groupId) {
    console.log(`\n${"═".repeat(60)}`);
    console.log(` ALL GROUPS ${groupId}-${lastGroup} COMPLETE`);
    console.log("═".repeat(60));
  }
} else if (isStatus) {
  await checkStatus(groupId || undefined);
} else if (isCollect) {
  if (!groupId) { console.error("Usage: --collect [--thin] --group N"); process.exit(1); }
  collectGroup(groupId, mode);
} else {
  console.log("Brute8Planner — Two-phase 8-char brute force on combined GLASS\n");
  console.log("Usage:");
  console.log("  --plan                              Calculate optimal grouping for both phases");
  console.log("  --run --thin --group N               Phase 1: mask-lud8 (62^8, ~hours)");
  console.log("  --run --thin --group N --through M   Phase 1: groups N through M (auto-collect)");
  console.log("  --collect --thin --group N           Collect thin cracks, update glass");
  console.log("  --run --group N                     Phase 2: brute-8 (95^8, ~days)");
  console.log("  --run --group N --through M          Phase 2: groups N through M (auto-collect)");
  console.log("  --collect --group N                 Collect brute8 cracks, update glass");
  console.log("  --status [--group N]                 Live progress dashboard (auto-detects group)");
}
