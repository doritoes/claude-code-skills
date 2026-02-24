#!/usr/bin/env bun
/**
 * BatchRunner.ts - Stage 2 Batch Orchestrator
 *
 * Runs 1 or more Stage 2 batches end-to-end by shelling out to existing tools:
 *   1. BigRedSync --hashlist (sync attack files + upload hashlist)
 *   2. BigRedRunner --batch (run all attacks on BIGRED)
 *   3. BigRedRunner --batch --collect (download potfile, write diamonds/glass)
 *   4. DiamondFeedback --batch (extract roots, update BETA.txt + rules)
 *   5. rebuild-nocap-plus.py (merge cohorts into nocap-plus.txt)
 *
 * This tool is a THIN WRAPPER. It never writes to sand-state.json directly.
 * All state management is handled by the existing tools it calls.
 * All attack effectiveness tracking (attackResults, attackStats, feedback metrics)
 * continues to be recorded by BigRedRunner and DiamondFeedback as before.
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const CURRENT_FILE = fileURLToPath(import.meta.url);
const TOOLS_DIR = dirname(CURRENT_FILE);
const SKILL_DIR = dirname(TOOLS_DIR);
const PROJECT_DIR = resolve(SKILL_DIR, "..", "..", "..");

// Resolve DATA_DIR the same way config.ts does
import { DATA_DIR, SAND_DIR } from "./config";

const PYTHON = "C:/Program Files/Python312/python.exe";
const REBUILD_SCRIPT = resolve(PROJECT_DIR, "scripts", "rebuild-nocap-plus.py");

// =============================================================================
// Types
// =============================================================================

interface StepResult {
  step: number;
  name: string;
  success: boolean;
  durationMs: number;
  detail?: string;
}

interface BatchSummary {
  batchName: string;
  steps: StepResult[];
  totalDurationMs: number;
  success: boolean;
}

// =============================================================================
// Helpers
// =============================================================================

function zeroPad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function banner(text: string): void {
  const line = "═".repeat(68);
  console.log(`\n${line}`);
  console.log(` ${text}`);
  console.log(line);
}

function stepLog(step: number, total: number, name: string): void {
  console.log(`\n  [${step}/${total}] ${name}`);
}

/**
 * Run a command, streaming stdout/stderr to console.
 * Returns exit code.
 */
function runCommand(cmd: string, args: string[], timeoutMs?: number): number {
  const displayCmd = [cmd, ...args].map(a => a.includes(" ") ? `"${a}"` : a).join(" ");
  console.log(`         $ ${displayCmd}`);

  const result = spawnSync(cmd, args, {
    stdio: "inherit",
    shell: false,
    timeout: timeoutMs,
    cwd: SKILL_DIR,
  });

  if (result.error) {
    console.error(`         ERROR: ${(result.error as Error).message}`);
    return 1;
  }

  return result.status ?? 1;
}

/**
 * Read sand-state.json to determine batch status.
 * Returns the batch entry or undefined if not tracked.
 */
function readBatchState(batchName: string): {
  status: string;
  attacksRemaining: string[];
  attacksApplied: string[];
  feedback?: object;
  cracked?: number;
  hashCount?: number;
} | undefined {
  const statePath = resolve(DATA_DIR, "sand-state.json");
  if (!existsSync(statePath)) return undefined;
  try {
    const state = JSON.parse(readFileSync(statePath, "utf-8"));
    return state.batches?.[batchName];
  } catch {
    return undefined;
  }
}

/**
 * Find the next unprocessed sand batch.
 * A batch is "unprocessed" if it has a sand file but either:
 *   - Not in sand-state.json at all
 *   - Status is "pending" or "in_progress"
 *   - Status is "completed" but no feedback field
 */
function getNextUnprocessedBatch(): string | null {
  if (!existsSync(SAND_DIR)) return null;

  const files = readdirSync(SAND_DIR)
    .filter(f => f.match(/^batch-\d{4}\.txt(\.gz)?$/))
    .map(f => f.replace(/\.txt(\.gz)?$/, ""))
    // Deduplicate (batch might have both .txt and .txt.gz)
    .filter((v, i, a) => a.indexOf(v) === i)
    .sort();

  for (const batchName of files) {
    const state = readBatchState(batchName);
    if (!state) return batchName;
    if (state.status === "pending") return batchName;
    if (state.status === "in_progress") return batchName;
    if (state.status === "completed" && !state.feedback) return batchName;
  }
  return null;
}

/**
 * Determine which step to resume from for a batch.
 * Returns 1-5 (step number to start from).
 */
function getResumeStep(batchName: string): number {
  const state = readBatchState(batchName);

  if (!state) return 1; // Not tracked → start from sync

  if (state.status === "pending") return 1;

  if (state.status === "in_progress") {
    if (state.attacksRemaining.length > 0) return 2; // Attacks remaining → resume attacks
    return 3; // All attacks done but not collected
  }

  if (state.status === "completed") {
    if (!state.feedback) return 4; // Collected but no feedback
    return 6; // Fully done (step 6 = skip, nothing to do)
  }

  // "failed" status → start from sync
  return 1;
}

// =============================================================================
// Batch Execution
// =============================================================================

function runBatch(batchNum: number, options: {
  fullFeedback?: boolean;
  dryRun?: boolean;
  startStep?: number;
}): BatchSummary {
  const batchName = `batch-${zeroPad(batchNum, 4)}`;
  const steps: StepResult[] = [];
  const batchStart = Date.now();
  const startStep = options.startStep ?? 1;
  const TOTAL_STEPS = 5;

  banner(`BATCH ${zeroPad(batchNum, 4)} — Starting from step ${startStep}`);

  // Step 1: SYNC
  if (startStep <= 1) {
    stepLog(1, TOTAL_STEPS, "SYNC — Uploading attack files + hashlist to BIGRED");
    const t0 = Date.now();

    if (options.dryRun) {
      console.log(`         [DRY RUN] bun Tools/BigRedSync.ts --hashlist ${batchName}`);
      steps.push({ step: 1, name: "SYNC", success: true, durationMs: 0, detail: "dry-run" });
    } else {
      const exitCode = runCommand("bun", ["Tools/BigRedSync.ts", "--hashlist", batchName]);
      const dur = Date.now() - t0;
      steps.push({ step: 1, name: "SYNC", success: exitCode === 0, durationMs: dur });

      if (exitCode !== 0) {
        console.error(`\n  FATAL: Sync failed. Cannot proceed without hashlist on BIGRED.`);
        console.error(`  Fix: Check BIGRED connectivity, then re-run:`);
        console.error(`    bun Tools/BatchRunner.ts --batch ${batchNum}`);
        return { batchName, steps, totalDurationMs: Date.now() - batchStart, success: false };
      }
    }
  }

  // Step 2: RUN ATTACKS
  if (startStep <= 2) {
    stepLog(2, TOTAL_STEPS, "ATTACKS — Running 18 attacks on BIGRED (~3 hrs)");
    const t0 = Date.now();

    if (options.dryRun) {
      console.log(`         [DRY RUN] bun Tools/BigRedRunner.ts --batch ${batchNum}`);
      steps.push({ step: 2, name: "ATTACKS", success: true, durationMs: 0, detail: "dry-run" });
    } else {
      // No timeout — brute-7 alone takes ~107 min. BigRedRunner has its own 4-hour per-attack timeout.
      const exitCode = runCommand("bun", ["Tools/BigRedRunner.ts", "--batch", String(batchNum)]);
      const dur = Date.now() - t0;
      steps.push({ step: 2, name: "ATTACKS", success: exitCode === 0, durationMs: dur });

      if (exitCode !== 0) {
        console.error(`\n  FATAL: Attacks failed. Investigate BIGRED.`);
        console.error(`  Resume: bun Tools/BatchRunner.ts --batch ${batchNum} --resume`);
        return { batchName, steps, totalDurationMs: Date.now() - batchStart, success: false };
      }
    }
  }

  // Step 3: COLLECT
  if (startStep <= 3) {
    stepLog(3, TOTAL_STEPS, "COLLECT — Downloading results, writing diamonds + glass");
    const t0 = Date.now();

    if (options.dryRun) {
      console.log(`         [DRY RUN] bun Tools/BigRedRunner.ts --batch ${batchNum} --collect`);
      steps.push({ step: 3, name: "COLLECT", success: true, durationMs: 0, detail: "dry-run" });
    } else {
      const exitCode = runCommand("bun", ["Tools/BigRedRunner.ts", "--batch", String(batchNum), "--collect"]);
      const dur = Date.now() - t0;
      steps.push({ step: 3, name: "COLLECT", success: exitCode === 0, durationMs: dur });

      if (exitCode !== 0) {
        console.error(`\n  FATAL: Collect failed. Check potfile on BIGRED.`);
        console.error(`  Resume: bun Tools/BatchRunner.ts --batch ${batchNum} --resume`);
        return { batchName, steps, totalDurationMs: Date.now() - batchStart, success: false };
      }
    }
  }

  // Step 4: FEEDBACK
  if (startStep <= 4) {
    const feedbackArgs = ["Tools/DiamondFeedback.ts", "--batch", batchName];
    if (options.fullFeedback) feedbackArgs.push("--full");

    stepLog(4, TOTAL_STEPS, `FEEDBACK — Generating roots + rules${options.fullFeedback ? " (full: HIBP + cohort growth)" : ""}`);
    const t0 = Date.now();

    if (options.dryRun) {
      console.log(`         [DRY RUN] bun ${feedbackArgs.join(" ")}`);
      steps.push({ step: 4, name: "FEEDBACK", success: true, durationMs: 0, detail: "dry-run" });
    } else {
      const exitCode = runCommand("bun", feedbackArgs);
      const dur = Date.now() - t0;
      const success = exitCode === 0;
      steps.push({ step: 4, name: "FEEDBACK", success, durationMs: dur, detail: success ? undefined : "non-fatal" });

      if (!success) {
        console.warn(`\n  WARNING: Feedback failed (non-fatal). Batch cracks are safe.`);
        console.warn(`  Retry later: bun Tools/DiamondFeedback.ts --batch ${batchName}`);
      }
    }
  }

  // Step 5: REBUILD nocap-plus.txt
  if (startStep <= 5) {
    stepLog(5, TOTAL_STEPS, "REBUILD — Merging cohorts into nocap-plus.txt");
    const t0 = Date.now();

    if (options.dryRun) {
      console.log(`         [DRY RUN] python rebuild-nocap-plus.py`);
      steps.push({ step: 5, name: "REBUILD", success: true, durationMs: 0, detail: "dry-run" });
    } else {
      const exitCode = runCommand(PYTHON, [REBUILD_SCRIPT]);
      const dur = Date.now() - t0;
      const success = exitCode === 0;
      steps.push({ step: 5, name: "REBUILD", success, durationMs: dur, detail: success ? undefined : "non-fatal" });

      if (!success) {
        console.warn(`\n  WARNING: rebuild-nocap-plus failed (non-fatal). Next batch will use stale nocap-plus.txt.`);
      }
    }
  }

  const totalDurationMs = Date.now() - batchStart;
  const allSuccess = steps.every(s => s.success);

  // Print batch summary
  printBatchSummary(batchName, steps, totalDurationMs, allSuccess);

  return { batchName, steps, totalDurationMs, success: allSuccess };
}

function printBatchSummary(batchName: string, steps: StepResult[], totalMs: number, success: boolean): void {
  // Box inner width = 50 chars (between "│ " and " │")
  const W = 50;
  console.log(`\n  ┌${"─".repeat(W + 2)}┐`);
  for (const s of steps) {
    const icon = s.success ? "OK" : (s.detail === "non-fatal" ? "WARN" : "FAIL");
    const dur = s.detail === "dry-run" ? "dry-run" : formatDuration(s.durationMs);
    const left = `[${s.step}/5] ${s.name.padEnd(12)} ${icon.padEnd(6)}`;
    const line = `${left}${dur.padStart(W - left.length)}`;
    console.log(`  │ ${line} │`);
  }
  console.log(`  ├${"─".repeat(W + 2)}┤`);
  const status = success ? "COMPLETE" : "FAILED  ";
  const left = `${batchName}  ${status}`;
  const totalDur = formatDuration(totalMs);
  const line = `${left}${totalDur.padStart(W - left.length)}`;
  console.log(`  │ ${line} │`);
  console.log(`  └${"─".repeat(W + 2)}┘`);

  // Show batch stats from state if available
  const state = readBatchState(batchName);
  if (state?.cracked !== undefined && state?.hashCount) {
    const rate = ((state.cracked / state.hashCount) * 100).toFixed(2);
    console.log(`  Cracks: ${state.cracked.toLocaleString()} / ${state.hashCount.toLocaleString()} (${rate}%)`);
  }
}

// =============================================================================
// Multi-Batch Loop
// =============================================================================

function runBatches(batches: number[], options: {
  fullFeedback?: boolean;
  dryRun?: boolean;
  confirm?: boolean;
}): void {
  const totalBatches = batches.length;
  const allStart = Date.now();
  let completed = 0;
  let failed = 0;

  banner(`BATCH RUNNER — ${totalBatches} batch${totalBatches > 1 ? "es" : ""} queued`);
  console.log(`  Batches: ${batches.map(n => zeroPad(n, 4)).join(", ")}`);
  if (options.dryRun) console.log(`  Mode: DRY RUN`);
  if (options.fullFeedback) console.log(`  Feedback: --full (HIBP + cohort growth)`);
  if (options.confirm) console.log(`  Confirm: pause between batches`);

  for (let i = 0; i < batches.length; i++) {
    const batchNum = batches[i];
    const batchName = `batch-${zeroPad(batchNum, 4)}`;

    banner(`BATCH ${i + 1} of ${totalBatches} — ${batchName}`);

    // Determine resume step
    const resumeStep = getResumeStep(batchName);
    if (resumeStep > 5) {
      console.log(`  SKIP — ${batchName} already fully processed (completed + feedback)`);
      completed++;
      continue;
    }

    const result = runBatch(batchNum, {
      fullFeedback: options.fullFeedback,
      dryRun: options.dryRun,
      startStep: resumeStep,
    });

    if (result.success) {
      completed++;
    } else {
      failed++;
      // Fatal failure — stop the run
      const fatalStep = result.steps.find(s => !s.success && s.detail !== "non-fatal");
      if (fatalStep) {
        console.error(`\nSTOPPING — Fatal error in ${batchName} at step ${fatalStep.step} (${fatalStep.name})`);
        console.error(`Resume: bun Tools/BatchRunner.ts --batch ${batchNum} --resume`);
        break;
      }
    }

    // Between-batch pause (if --confirm and not last batch)
    if (options.confirm && !options.dryRun && i < batches.length - 1) {
      console.log(`\nPress Enter to continue to batch ${zeroPad(batches[i + 1], 4)}, or Ctrl+C to stop...`);
      // Read a line from stdin
      const buf = Buffer.alloc(1024);
      try {
        const fd = require("fs").openSync("/dev/stdin", "r");
        require("fs").readSync(fd, buf, 0, 1024, null);
        require("fs").closeSync(fd);
      } catch {
        // If stdin read fails (non-interactive), just continue
      }
    }
  }

  // Final summary
  const totalMs = Date.now() - allStart;
  banner(`RUN COMPLETE`);
  console.log(`  Completed: ${completed} / ${totalBatches}`);
  if (failed > 0) console.log(`  Failed:    ${failed}`);
  console.log(`  Total time: ${formatDuration(totalMs)}`);

  if (completed === totalBatches) {
    console.log(`\n  All batches processed successfully.`);
  }
}

// =============================================================================
// Status Display
// =============================================================================

function showStatus(): void {
  const statePath = resolve(DATA_DIR, "sand-state.json");
  if (!existsSync(statePath)) {
    console.log("No sand-state.json found. No batches processed yet.");
    return;
  }

  const state = JSON.parse(readFileSync(statePath, "utf-8"));
  const batches = state.batches || {};
  const batchNames = Object.keys(batches).sort();

  let completed = 0, withFeedback = 0, inProgress = 0, pending = 0, failed = 0;
  let totalCracked = 0, totalHashes = 0;

  for (const name of batchNames) {
    const b = batches[name];
    totalCracked += b.cracked || 0;
    totalHashes += b.hashCount || 0;

    switch (b.status) {
      case "completed":
        completed++;
        if (b.feedback) withFeedback++;
        break;
      case "in_progress": inProgress++; break;
      case "pending": pending++; break;
      case "failed": failed++; break;
    }
  }

  // Count sand files to determine total remaining
  let sandFileCount = 0;
  if (existsSync(SAND_DIR)) {
    sandFileCount = readdirSync(SAND_DIR)
      .filter(f => f.match(/^batch-\d{4}\.txt(\.gz)?$/))
      .map(f => f.replace(/\.txt(\.gz)?$/, ""))
      .filter((v, i, a) => a.indexOf(v) === i)
      .length;
  }

  const remaining = sandFileCount - withFeedback;
  const rate = totalHashes > 0 ? ((totalCracked / totalHashes) * 100).toFixed(2) : "0";

  banner("BATCH RUNNER STATUS");
  console.log(`  Sand batches available:  ${sandFileCount.toLocaleString()}`);
  console.log(`  Fully processed:         ${withFeedback} (completed + feedback)`);
  console.log(`  Completed (no feedback): ${completed - withFeedback}`);
  console.log(`  In progress:             ${inProgress}`);
  console.log(`  Pending:                 ${pending}`);
  if (failed > 0) console.log(`  Failed:                  ${failed}`);
  console.log(`  Remaining:               ${remaining.toLocaleString()}`);
  console.log();
  console.log(`  Total cracked: ${totalCracked.toLocaleString()} / ${totalHashes.toLocaleString()} (${rate}%)`);

  if (withFeedback > 0) {
    // Estimate time remaining based on average batch duration
    // We can't know exact time per batch, but ~2.5 hrs is typical
    const estHours = remaining * 2.5;
    const estDays = estHours / 24;
    console.log(`\n  Estimated remaining: ~${Math.round(estHours).toLocaleString()} GPU hours (~${Math.round(estDays)} days)`);
  }

  // Show next unprocessed batch
  const next = getNextUnprocessedBatch();
  if (next) {
    const resumeStep = getResumeStep(next);
    console.log(`\n  Next batch: ${next} (resume from step ${resumeStep})`);
    console.log(`  Run: bun Tools/BatchRunner.ts --next`);
  }
}

// =============================================================================
// CLI
// =============================================================================

function printHelp(): void {
  console.log(`
BatchRunner.ts — Stage 2 Batch Orchestrator

Runs 1 or more batches through the full Stage 2 pipeline:
  SYNC → ATTACKS → COLLECT → FEEDBACK → REBUILD

Usage:
  bun Tools/BatchRunner.ts --batch <N>                Run batch N
  bun Tools/BatchRunner.ts --batch <N> --through <M>  Run batches N through M
  bun Tools/BatchRunner.ts --next                     Run next unprocessed batch
  bun Tools/BatchRunner.ts --next --count <N>         Run next N unprocessed batches
  bun Tools/BatchRunner.ts --batch <N> --resume       Resume interrupted batch
  bun Tools/BatchRunner.ts --status                   Show progress
  bun Tools/BatchRunner.ts --dry-run --next           Preview without executing

Options:
  --batch <N>        Start from batch N (1-based)
  --through <M>      Process through batch M (requires --batch)
  --next             Process next unprocessed batch
  --count <N>        Number of batches to process (with --next, default: 1)
  --resume           Resume interrupted batch from last completed step
  --confirm          Pause between batches for confirmation
  --full-feedback    Run DiamondFeedback with --full (HIBP + cohort growth)
  --dry-run          Show what would be done without executing
  --status           Show orchestrator progress
  --help, -h         Show this help

Examples:
  bun Tools/BatchRunner.ts --batch 1                  # Run batch-0001
  bun Tools/BatchRunner.ts --batch 1 --through 10     # Run batches 1-10
  bun Tools/BatchRunner.ts --next --count 5            # Run next 5 unprocessed
  bun Tools/BatchRunner.ts --batch 5 --resume          # Resume batch-0005
  bun Tools/BatchRunner.ts --status                    # Check progress
  bun Tools/BatchRunner.ts --next --dry-run            # Preview next batch

State: All attack effectiveness data is recorded by BigRedRunner and
DiamondFeedback into sand-state.json. This tool reads state for resume
logic but never writes to it directly.
`.trim());
}

if (import.meta.main) {
  const args = process.argv.slice(2);

  let batchNum: number | undefined;
  let throughNum: number | undefined;
  let countNum = 1;
  let nextFlag = false;
  let resumeFlag = false;
  let confirmFlag = false;
  let fullFeedback = false;
  let dryRun = false;
  let statusFlag = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--batch":
      case "-b":
        batchNum = parseInt(args[++i]);
        break;
      case "--through":
      case "-t":
        throughNum = parseInt(args[++i]);
        break;
      case "--count":
      case "-n":
        countNum = parseInt(args[++i]);
        break;
      case "--next":
        nextFlag = true;
        break;
      case "--resume":
        resumeFlag = true;
        break;
      case "--confirm":
        confirmFlag = true;
        break;
      case "--full-feedback":
        fullFeedback = true;
        break;
      case "--dry-run":
        dryRun = true;
        break;
      case "--status":
        statusFlag = true;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
    }
  }

  // --status
  if (statusFlag) {
    showStatus();
    process.exit(0);
  }

  // --help if no args
  if (args.length === 0) {
    printHelp();
    process.exit(0);
  }

  // --next mode
  if (nextFlag) {
    const batches: number[] = [];
    for (let i = 0; i < countNum; i++) {
      // For multi-batch --next, find next unprocessed sequentially
      // (We can't pre-resolve all N because processing batch K may affect K+1's status)
      // Instead, resolve the first one now. For count > 1, the loop will re-resolve.
      if (i === 0) {
        const next = getNextUnprocessedBatch();
        if (!next) {
          console.log("No unprocessed sand batches found.");
          process.exit(0);
        }
        const num = parseInt(next.replace("batch-", ""));
        batches.push(num);
      }
    }

    if (countNum === 1) {
      // Single batch — run directly
      const resumeStep = resumeFlag ? getResumeStep(`batch-${zeroPad(batches[0], 4)}`) : undefined;
      const result = runBatch(batches[0], {
        fullFeedback,
        dryRun,
        startStep: resumeStep ?? getResumeStep(`batch-${zeroPad(batches[0], 4)}`),
      });
      process.exit(result.success ? 0 : 1);
    } else {
      // Multi-batch --next --count N: run in a loop, resolving next each time
      let completed = 0;
      const allStart = Date.now();

      banner(`BATCH RUNNER — ${countNum} batches queued (auto-discover)`);
      if (dryRun) console.log(`  Mode: DRY RUN`);

      for (let i = 0; i < countNum; i++) {
        const next = getNextUnprocessedBatch();
        if (!next) {
          console.log(`\nNo more unprocessed batches. Stopping after ${completed} batches.`);
          break;
        }

        const num = parseInt(next.replace("batch-", ""));
        banner(`BATCH ${i + 1} of ${countNum} — ${next}`);

        const resumeStep = getResumeStep(next);
        const result = runBatch(num, { fullFeedback, dryRun, startStep: resumeStep });

        if (result.success) {
          completed++;
        } else {
          const fatalStep = result.steps.find(s => !s.success && s.detail !== "non-fatal");
          if (fatalStep) {
            console.error(`\nSTOPPING — Fatal error. Resume: bun Tools/BatchRunner.ts --batch ${num} --resume`);
            break;
          }
          completed++; // Non-fatal failures still count as "processed"
        }

        if (confirmFlag && !dryRun && i < countNum - 1) {
          console.log(`\nPress Enter to continue, or Ctrl+C to stop...`);
          try {
            const fd = require("fs").openSync("/dev/stdin", "r");
            const buf = Buffer.alloc(1024);
            require("fs").readSync(fd, buf, 0, 1024, null);
            require("fs").closeSync(fd);
          } catch { /* continue */ }
        }
      }

      banner(`RUN COMPLETE`);
      console.log(`  Completed: ${completed} / ${countNum}`);
      console.log(`  Total time: ${formatDuration(Date.now() - allStart)}`);
      process.exit(0);
    }
  }

  // --batch mode
  if (batchNum !== undefined) {
    if (isNaN(batchNum) || batchNum < 1) {
      console.error("ERROR: --batch must be a positive integer");
      process.exit(1);
    }

    if (throughNum !== undefined) {
      // Range mode: --batch N --through M
      if (isNaN(throughNum) || throughNum < batchNum) {
        console.error("ERROR: --through must be >= --batch");
        process.exit(1);
      }
      const batches: number[] = [];
      for (let i = batchNum; i <= throughNum; i++) {
        batches.push(i);
      }
      runBatches(batches, { fullFeedback, dryRun, confirm: confirmFlag });
    } else {
      // Single batch mode
      const batchName = `batch-${zeroPad(batchNum, 4)}`;
      const startStep = resumeFlag ? getResumeStep(batchName) : getResumeStep(batchName);
      const result = runBatch(batchNum, { fullFeedback, dryRun, startStep });
      process.exit(result.success ? 0 : 1);
    }
  } else {
    console.error("ERROR: --batch <N> or --next is required");
    printHelp();
    process.exit(1);
  }
}
