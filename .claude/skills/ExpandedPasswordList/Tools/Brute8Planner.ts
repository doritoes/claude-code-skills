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

/** Parse hashcat log Started/Stopped lines to get total run duration in seconds. */
function parseLogDuration(config: BigRedConfig, mode: AttackMode, groupId: number): number {
  const logFile = `${config.workDir}/hashcat-${mode}-g${groupId}.log`;
  try {
    const logTail = sshCmd(config, `tail -5 ${logFile} 2>/dev/null`, 15_000);
    const startMatch = logTail.match(/Started[.:]+\s*(.+)/);
    const stopMatch = logTail.match(/Stopped[.:]+\s*(.+)/);
    if (startMatch && stopMatch) {
      const started = new Date(startMatch[1].trim());
      const stopped = new Date(stopMatch[1].trim());
      if (!isNaN(started.getTime()) && !isNaN(stopped.getTime())) {
        return Math.max(1, Math.round((stopped.getTime() - started.getTime()) / 1000));
      }
    }
  } catch {}
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

/** Build phase plan with groups of optimal size. */
function buildPhase(
  attack: AttackMode,
  glassBatches: GlassBatch[],
  avgPerBatch: number,
): PhasePlan {
  const keyspace = ATTACKS[attack].keyspace;
  const optSize = findOptimalGroupSize(glassBatches.length, avgPerBatch, keyspace);

  const groups: PhasePlan["groups"] = [];
  for (let i = 0; i < glassBatches.length; i += optSize) {
    const slice = glassBatches.slice(i, i + optSize);
    const h = slice.reduce((s, b) => s + b.hashes, 0);
    groups.push({
      id: groups.length + 1,
      batches: slice.map(b => b.name),
      totalHashes: h,
      speedGHs: interpolateSpeed(h),
      estimatedDays: estimateDays(h, keyspace),
    });
  }

  return {
    attack,
    keyspace,
    groups,
    totalDays: groups.reduce((s, g) => s + g.estimatedDays, 0),
    optimalGroupSize: optSize,
  };
}

function createPlan(glassBatches: GlassBatch[]): Brute8Plan {
  const totalHashes = glassBatches.reduce((s, b) => s + b.hashes, 0);
  const avgPerBatch = totalHashes / glassBatches.length;

  const thin = buildPhase("thin", glassBatches, avgPerBatch);

  // For brute8 estimate, assume thin reduces glass by ~6%
  const postThinAvg = avgPerBatch * (1 - ATTACKS.thin.glassReductionPct);
  const brute8 = buildPhase("brute8", glassBatches, postThinAvg);

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

function checkStatus(groupId: number): void {
  const config = loadConfig();
  const groupName = `group-${groupId}`;
  const state = loadState();
  const gs = getGroupState(state, groupId);

  // Check both screen names
  const thinAlive = parseInt(sshCmd(config, `screen -ls 2>/dev/null | grep -c 'hc-thin-g${groupId}' || echo 0`, 10_000));
  const bruteAlive = parseInt(sshCmd(config, `screen -ls 2>/dev/null | grep -c 'hc-brute8-g${groupId}' || echo 0`, 10_000));
  const running = parseInt(sshCmd(config, `pgrep -c hashcat 2>/dev/null || echo 0`, 10_000));

  console.log(`\nGroup ${groupId} Status:`);
  console.log(`  Thin:    ${gs.thin.padEnd(10)} ${thinAlive > 0 ? "(screen alive)" : ""}`);
  console.log(`  Brute-8: ${gs.brute8.padEnd(10)} ${bruteAlive > 0 ? "(screen alive)" : ""}`);
  console.log(`  hashcat: ${running > 0 ? "RUNNING" : "idle"}`);

  const potCount = sshCmd(config, `wc -l < ${config.workDir}/potfiles/${groupName}.pot 2>/dev/null || echo 0`, 10_000);
  console.log(`  Cracked: ${fmt(parseInt(potCount.trim()))} (collected: ${gs.collectedLines})`);

  // Show most recent log
  const activeMode = thinAlive > 0 ? "thin" : "brute8";
  const logFile = `${config.workDir}/hashcat-${activeMode}-g${groupId}.log`;
  console.log(`\n  Log (${activeMode}, last 15 lines):`);
  const logTail = sshCmd(config, `tail -15 ${logFile} 2>/dev/null || echo '(no log)'`, 15_000);
  for (const line of logTail.split("\n")) {
    console.log(`    ${line}`);
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
const mode: AttackMode = isThin ? "thin" : "brute8";

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
  if (!groupId) { console.error("Usage: --run [--thin] --group N"); process.exit(1); }
  runGroup(groupId, mode);
} else if (isStatus) {
  if (!groupId) { console.error("Usage: --status --group N"); process.exit(1); }
  checkStatus(groupId);
} else if (isCollect) {
  if (!groupId) { console.error("Usage: --collect [--thin] --group N"); process.exit(1); }
  collectGroup(groupId, mode);
} else {
  console.log("Brute8Planner — Two-phase 8-char brute force on combined GLASS\n");
  console.log("Usage:");
  console.log("  --plan                        Calculate optimal grouping for both phases");
  console.log("  --run --thin --group N         Phase 1: mask-lud8 (62^8, ~hours)");
  console.log("  --collect --thin --group N     Collect thin cracks, update glass");
  console.log("  --run --group N               Phase 2: brute-8 (95^8, ~days)");
  console.log("  --collect --group N           Collect brute8 cracks, update glass");
  console.log("  --status --group N            Check progress");
}
