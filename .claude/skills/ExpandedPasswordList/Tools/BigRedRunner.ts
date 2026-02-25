#!/usr/bin/env bun
/**
 * BigRedRunner.ts - SAND Batch Attack Orchestrator for BIGRED Local GPU
 *
 * Runs SAND batch attacks directly on BIGRED via SSH + native hashcat,
 * bypassing Hashtopolis. Collects results into the DIAMOND pipeline.
 *
 * Usage:
 *   bun Tools/BigRedRunner.ts --batch 8                Run all attacks for batch-0008
 *   bun Tools/BigRedRunner.ts --batch 8 --attack brute-7  Run single attack
 *   bun Tools/BigRedRunner.ts --batch 8 --status       Check hashcat status on BIGRED
 *   bun Tools/BigRedRunner.ts --batch 8 --collect      Collect results into DIAMOND pipeline
 *   bun Tools/BigRedRunner.ts --batch 8 --dry-run      Preview commands without executing
 *
 * @author PAI (Personal AI Infrastructure)
 * @updated 2026-02-25 — v7.0 attack order (added mask-l8/ld8/l9, removed 3 dead attacks)
 * @license MIT
 */

import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { execSync } from "node:child_process";
import { SandStateManager, DEFAULT_ATTACK_ORDER, type AttackResultEntry } from "./SandStateManager";
import { DATA_DIR, SAND_DIR, DIAMONDS_DIR, GLASS_DIR, HASH_TYPE_SHA1, decodeHexPlain } from "./config";
import { loadConfig, sshCmd, scpDownload, type BigRedConfig } from "./BigRedSync";

// =============================================================================
// Constants
// =============================================================================

const SHELL = process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "/bin/bash";

/**
 * Map Hashtopolis filenames to BIGRED hashcat-work paths.
 * These match the files synced by BigRedSync.ts.
 */
const FILE_MAP: Record<string, string> = {
  "rockyou.txt":      "wordlists/rockyou.txt",
  "nocap.txt":        "wordlists/nocap.txt",
  "nocap-plus.txt":   "wordlists/nocap-plus.txt",
  "BETA.txt":         "wordlists/BETA.txt",
  "rizzyou.txt":      "wordlists/rizzyou.txt",
  "nocap.rule":       "rules/nocap.rule",
  "UNOBTAINUM.rule":  "rules/UNOBTAINIUM.rule",
  "bussin.rule":      "rules/bussin.rule",
  "OneRuleToRuleThemStill.rule": "rules/OneRuleToRuleThemStill.rule",
  "top-roots.txt":    "wordlists/top-roots.txt",
};

/**
 * Attack presets — same commands as SandProcessor.ts ATTACK_PRESETS,
 * but we only need the attackCmd string for translation.
 */
const ATTACK_CMDS: Record<string, string> = {
  "brute-1":                       "#HL# -a 3 ?a",
  "brute-2":                       "#HL# -a 3 ?a?a",
  "brute-3":                       "#HL# -a 3 ?a?a?a",
  "brute-4":                       "#HL# -a 3 ?a?a?a?a",
  "brute-5":                       "#HL# -a 3 ?a?a?a?a?a",
  "brute-6":                       "#HL# -a 3 ?a?a?a?a?a?a",
  "brute-7":                       "#HL# -a 3 ?a?a?a?a?a?a?a",
  "feedback-beta-nocaprule":       "#HL# BETA.txt -r nocap.rule",
  "nocapplus-unobtainium":        "#HL# nocap-plus.txt -r UNOBTAINUM.rule",
  "hybrid-nocapplus-4digit":      "#HL# -a 6 nocap-plus.txt ?d?d?d?d",
  "mask-lllllldd":                 "#HL# -a 3 ?l?l?l?l?l?l?d?d",
  "mask-Ullllllld":                "#HL# -a 3 ?u?l?l?l?l?l?l?l?d",
  "mask-Ullllldd":                 "#HL# -a 3 ?u?l?l?l?l?l?d?d",
  "hybrid-nocapplus-special-digits": "#HL# -a 6 nocap-plus.txt ?s?d?d?d",
  "mask-lllldddd":                 "#HL# -a 3 ?l?l?l?l?d?d?d?d",
  "hybrid-beta-4any":              "#HL# -a 6 BETA.txt ?a?a?a?a",
  "hybrid-nocapplus-3any":         "#HL# -a 6 nocap-plus.txt ?a?a?a",
  // 8/9-char funnel masks (production v7.0)
  "mask-l8":                        "#HL# -a 3 ?l?l?l?l?l?l?l?l",
  "mask-l9":                        "#HL# -a 3 ?l?l?l?l?l?l?l?l?l",
  "mask-ld8":                       "#HL# -a 3 -1 ?l?d ?1?1?1?1?1?1?1?1",
  // Removed from production v7.0 (kept for historical/one-off use)
  "hybrid-roots-4any":             "#HL# -a 6 top-roots.txt ?a?a?a?a",
  "nocapplus-nocaprule":           "#HL# nocap-plus.txt -r nocap.rule",
  "hybrid-nocapplus-3digit":       "#HL# -a 6 nocap-plus.txt ?d?d?d",
  // Experimental (manual one-off only)
  "mask-ld9":                       "#HL# -a 3 -1 ?l?d ?1?1?1?1?1?1?1?1?1",
};

// =============================================================================
// Command Translation
// =============================================================================

/**
 * Translate a Hashtopolis-format attackCmd to a native hashcat command.
 *
 * Input:  "#HL# nocap-plus.txt -r nocap.rule"
 * Output: "hashcat -m 100 hashlists/batch-0008.txt wordlists/nocap-plus.txt -r rules/nocap.rule
 *          --potfile-path potfiles/batch-0008.pot -w 3 --status --status-timer 60"
 */
function translateCmd(attackCmd: string, batchName: string): string {
  // Replace #HL# with hashlist path
  let cmd = attackCmd.replace("#HL#", `hashlists/${batchName}.txt`);

  // Replace known filenames with full BIGRED paths
  for (const [filename, remotePath] of Object.entries(FILE_MAP)) {
    // Only replace standalone filenames (not already path-qualified)
    // Use word boundary matching to avoid partial replacements
    const regex = new RegExp(`(?<![/\\w])${escapeRegex(filename)}(?![/\\w])`, "g");
    cmd = cmd.replace(regex, remotePath);
  }

  // Build full hashcat command
  const potfile = `potfiles/${batchName}.pot`;
  return `hashcat -m ${HASH_TYPE_SHA1} ${cmd} --potfile-path ${potfile} -O -w 3 --status --status-timer 60`;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// =============================================================================
// Reconnect / Retry Helpers
// =============================================================================

/**
 * CPU-friendly synchronous sleep using Atomics.
 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Wait for SSH connection to BIGRED to be restored.
 * Retries with increasing backoff, up to maxWaitMs total.
 */
function waitForConnection(config: BigRedConfig, maxWaitMs = 300000): boolean {
  const startTime = Date.now();
  let attempt = 0;
  const baseInterval = 10000; // 10s initial

  while (Date.now() - startTime < maxWaitMs) {
    attempt++;
    try {
      sshCmd(config, "echo connected", 10000);
      console.log(`  Reconnected to BIGRED after ${attempt} attempt(s).`);
      return true;
    } catch {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      const waitTime = Math.min(baseInterval * attempt, 30000); // cap at 30s
      console.log(`  Retry ${attempt}: BIGRED unreachable (${elapsed}s elapsed), waiting ${waitTime / 1000}s...`);
      sleepSync(waitTime);
    }
  }
  return false;
}

/**
 * Wait for hashcat to finish on BIGRED, polling periodically.
 * Returns the final potfile count when hashcat completes, or -1 on timeout.
 */
function waitForHashcatCompletion(
  config: BigRedConfig,
  batchName: string,
  maxWaitMs = 4 * 60 * 60 * 1000,
  pollIntervalMs = 30000
): number {
  const startWait = Date.now();

  while (Date.now() - startWait < maxWaitMs) {
    try {
      if (!isHashcatRunning(config)) {
        const potCount = getPotfileCount(config, batchName);
        console.log(`  hashcat completed. Potfile: ${potCount.toLocaleString()}`);
        return potCount;
      }

      const potCount = getPotfileCount(config, batchName);
      const elapsed = formatDuration((Date.now() - startWait) / 1000);
      console.log(`  hashcat still running (potfile: ${potCount.toLocaleString()}, waited: ${elapsed})`);
    } catch {
      console.log(`  SSH check failed, waiting for reconnect...`);
      if (!waitForConnection(config, 120000)) {
        console.error(`  Lost connection during poll, aborting wait.`);
        return -1;
      }
      continue; // re-check immediately after reconnect
    }

    sleepSync(pollIntervalMs);
  }

  console.error(`  Timeout waiting for hashcat after ${formatDuration(maxWaitMs / 1000)}`);
  return -1;
}

// =============================================================================
// Attack Execution
// =============================================================================

interface AttackResult {
  attack: string;
  crackedBefore: number;
  crackedAfter: number;
  newCracks: number;
  durationSeconds: number;
  exitCode: number;
}

/**
 * Count lines in the potfile on BIGRED (= total cracked so far).
 */
function getPotfileCount(config: BigRedConfig, batchName: string): number {
  try {
    const result = sshCmd(config, `test -f ${config.workDir}/potfiles/${batchName}.pot && wc -l < ${config.workDir}/potfiles/${batchName}.pot || echo 0`);
    return parseInt(result) || 0;
  } catch {
    return 0;
  }
}

/**
 * Check if hashcat is currently running on BIGRED.
 */
function isHashcatRunning(config: BigRedConfig): boolean {
  try {
    const result = sshCmd(config, "pgrep -c hashcat 2>/dev/null || echo 0");
    return parseInt(result) > 0;
  } catch {
    return false;
  }
}

/**
 * Check if a screen session is still alive on BIGRED.
 */
function isScreenAlive(config: BigRedConfig, screenName: string): boolean {
  try {
    const result = sshCmd(config, `screen -ls 2>/dev/null | grep -c '${screenName}' || echo 0`);
    return parseInt(result) > 0;
  } catch {
    return false;
  }
}

/**
 * Check if hashcat log file indicates a completed run.
 * Returns true if log contains "Exhausted" or "Cracked" status.
 */
function isLogComplete(config: BigRedConfig, logFile: string): boolean {
  try {
    const result = sshCmd(config, `grep -c -E '^Status\\.\\.+: (Exhausted|Cracked)' ${logFile} 2>/dev/null || echo 0`, 5000);
    return parseInt(result) > 0;
  } catch {
    return false;
  }
}

/**
 * Run a single hashcat attack on BIGRED using screen for SIGHUP protection.
 *
 * Hashcat runs inside a screen session so it survives SSH disconnects.
 * We poll for completion via SSH, reconnecting as needed.
 */
function runAttack(
  config: BigRedConfig,
  attackName: string,
  batchName: string,
  dryRun: boolean
): AttackResult {
  const attackCmd = ATTACK_CMDS[attackName];
  if (!attackCmd) {
    throw new Error(`Unknown attack: ${attackName}. Available: ${Object.keys(ATTACK_CMDS).join(", ")}`);
  }

  const hashcatCmd = translateCmd(attackCmd, batchName);

  console.log(`\n${"─".repeat(60)}`);
  console.log(`Attack: ${attackName}`);
  console.log(`Command: ${hashcatCmd}`);

  if (dryRun) {
    console.log("[DRY RUN] Would execute on BIGRED");
    return { attack: attackName, crackedBefore: 0, crackedAfter: 0, newCracks: 0, durationSeconds: 0, exitCode: 0 };
  }

  // Check for running hashcat
  if (isHashcatRunning(config)) {
    console.log("WARNING: hashcat is already running on BIGRED!");
    console.log("Use --status to check progress, or wait for completion.");
    return { attack: attackName, crackedBefore: 0, crackedAfter: 0, newCracks: 0, durationSeconds: -1, exitCode: -1 };
  }

  const crackedBefore = getPotfileCount(config, batchName);
  console.log(`Potfile before: ${crackedBefore} cracked`);

  const startTime = Date.now();
  const screenName = `hc-${batchName}`;
  const logFile = `${config.workDir}/hashcat-${attackName}.log`;

  // Clean up any previous screen session and log file
  try {
    sshCmd(config, `screen -X -S ${screenName} quit 2>/dev/null; rm -f ${logFile}`, 10000);
  } catch { /* ignore */ }

  // Launch hashcat inside screen — survives SSH disconnect (SIGHUP-safe)
  const escapedCmd = hashcatCmd.replace(/'/g, "'\\''");
  const screenCmd = `screen -dmS ${screenName} bash -c 'cd ${config.workDir} && ${escapedCmd} > ${logFile} 2>&1'`;
  sshCmd(config, screenCmd, 15000);

  console.log(`Running hashcat in screen session: ${screenName}`);
  console.log(`Log file: ${logFile}\n`);

  // Give hashcat a moment to start
  sleepSync(3000);

  // Verify hashcat actually started (check both process AND screen)
  if (!isHashcatRunning(config) && !isScreenAlive(config, screenName)) {
    // Fast attacks (brute-1 through brute-5, small masks) can complete in <3 seconds.
    // Check if the log shows a completed run before declaring failure.
    if (isLogComplete(config, logFile)) {
      // hashcat already finished — this is success, not failure
      const crackedAfter = getPotfileCount(config, batchName);
      const newCracks = crackedAfter - crackedBefore;
      const durationSeconds = (Date.now() - startTime) / 1000;
      console.log(`  Completed instantly (${formatDuration(durationSeconds)})`);
      console.log(`  New cracks: ${newCracks.toLocaleString()}`);
      console.log(`  Total potfile: ${crackedAfter.toLocaleString()}`);
      try { sshCmd(config, `screen -X -S ${screenName} quit 2>/dev/null || true`, 5000); } catch { /* ignore */ }
      return { attack: attackName, crackedBefore, crackedAfter, newCracks, durationSeconds, exitCode: 0 };
    }

    // Log doesn't show completion — this is a real failure
    console.error("ERROR: hashcat failed to start. Checking log...");
    try {
      const log = sshCmd(config, `tail -20 ${logFile} 2>/dev/null || echo '(no log)'`, 10000);
      console.error(log);
    } catch { /* ignore */ }
    return { attack: attackName, crackedBefore, crackedAfter: crackedBefore, newCracks: 0, durationSeconds: 0, exitCode: -1 };
  }

  // Poll for completion — hashcat is safe in screen even if SSH drops
  // Completion requires: process dead + screen dead + log shows terminal status
  const POLL_INTERVAL = 30000; // 30 seconds
  const MAX_WAIT = 4 * 60 * 60 * 1000; // 4 hours
  let lastPotCount = crackedBefore;
  let notRunningCount = 0; // require consecutive "not running" checks to confirm

  while (Date.now() - startTime < MAX_WAIT) {
    sleepSync(POLL_INTERVAL);

    try {
      const hcRunning = isHashcatRunning(config);
      const screenUp = isScreenAlive(config, screenName);
      const logDone = isLogComplete(config, logFile);
      const potCount = getPotfileCount(config, batchName);
      const elapsed = formatDuration((Date.now() - startTime) / 1000);
      const newSince = potCount - crackedBefore;

      if (hcRunning || screenUp) {
        // Still running — show progress
        notRunningCount = 0;
        let progressInfo = "";
        try {
          const progress = sshCmd(config, `grep '^Progress' ${logFile} 2>/dev/null | tail -1`, 5000);
          if (progress.trim()) progressInfo = ` | ${progress.trim()}`;
        } catch { /* ignore */ }

        console.log(`  [${elapsed}] running — potfile: ${potCount.toLocaleString()} (+${newSince})${progressInfo}`);
        lastPotCount = potCount;
      } else if (logDone) {
        // Process dead + screen dead + log confirms completion
        notRunningCount = 0;
        try {
          const finalLines = sshCmd(config, `grep -E '^(Status|Progress|Recovered|Speed|Time)' ${logFile} 2>/dev/null | tail -6`, 5000);
          const exhausted = finalLines.includes("Exhausted");
          if (finalLines.trim()) {
            console.log(`\n  hashcat finished (${exhausted ? "keyspace exhausted" : "completed"}):`);
            for (const line of finalLines.trim().split("\n")) {
              console.log(`    ${line}`);
            }
          } else {
            console.log(`\n  hashcat finished (confirmed by log).`);
          }
        } catch { /* ignore */ }
        break;
      } else {
        // Process not running, screen gone, but log doesn't confirm completion
        // This could be a false negative — require 2 consecutive checks
        notRunningCount++;
        console.log(`  [${elapsed}] hashcat not detected (check ${notRunningCount}/2) — potfile: ${potCount.toLocaleString()} (+${newSince})`);
        if (notRunningCount >= 2) {
          console.log(`\n  hashcat appears to have stopped (no process, no screen, log incomplete).`);
          console.log(`  This may indicate a crash. Check log: ${logFile}`);
          break;
        }
      }
    } catch {
      // SSH connection lost — but hashcat is safe in screen!
      const elapsed = formatDuration((Date.now() - startTime) / 1000);
      console.log(`  [${elapsed}] SSH lost — hashcat safe in screen. Reconnecting...`);
      if (!waitForConnection(config, 300000)) {
        console.error(`  FAILED to reconnect after 5 minutes. hashcat is still running in screen on BIGRED.`);
        console.error(`  Re-run this command to resume monitoring.`);
        break;
      }
      console.log(`  Reconnected. Resuming monitoring...`);
    }
  }

  // Read potfile count with retry
  let crackedAfter = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    crackedAfter = getPotfileCount(config, batchName);
    if (crackedAfter >= crackedBefore) break;
    console.log(`  Potfile read returned ${crackedAfter} (expected >= ${crackedBefore}), retrying...`);
    sleepSync(5000);
    try { sshCmd(config, "echo ok", 10000); } catch {
      waitForConnection(config, 60000);
    }
  }

  const newCracks = crackedAfter - crackedBefore;
  const durationSeconds = (Date.now() - startTime) / 1000;

  console.log(`\nCompleted: ${attackName}`);
  console.log(`  Duration: ${formatDuration(durationSeconds)}`);
  console.log(`  New cracks: ${newCracks.toLocaleString()}`);
  console.log(`  Total potfile: ${crackedAfter.toLocaleString()}`);

  // Only clean up screen if log confirms hashcat actually finished
  if (isLogComplete(config, logFile)) {
    try { sshCmd(config, `screen -X -S ${screenName} quit 2>/dev/null || true`, 5000); } catch { /* ignore */ }
  }

  return {
    attack: attackName,
    crackedBefore,
    crackedAfter,
    newCracks,
    durationSeconds,
    exitCode: 0,
  };
}

/**
 * Run attack detached (for long-running attacks like brute-7).
 * Uses screen so we can disconnect and reconnect.
 */
function runAttackDetached(
  config: BigRedConfig,
  attackName: string,
  batchName: string
): void {
  const attackCmd = ATTACK_CMDS[attackName];
  if (!attackCmd) {
    throw new Error(`Unknown attack: ${attackName}`);
  }

  const hashcatCmd = translateCmd(attackCmd, batchName);
  const screenName = `hashcat-${batchName}-${attackName}`;

  // Kill any existing screen session with this name
  try {
    sshCmd(config, `screen -X -S ${screenName} quit 2>/dev/null || true`);
  } catch { /* ignore */ }

  // Start detached screen
  const cmd = `cd ${config.workDir} && screen -dmS ${screenName} bash -c '${hashcatCmd.replace(/'/g, "'\\''")}'`;
  sshCmd(config, cmd);

  console.log(`Attack ${attackName} started in detached screen: ${screenName}`);
  console.log(`  Check status: bun Tools/BigRedRunner.ts --batch ${batchName.replace("batch-", "")} --status`);
  console.log(`  Attach:       ssh ${config.user}@${config.host} -t "screen -r ${screenName}"`);
}

// =============================================================================
// Status Checking
// =============================================================================

function showStatus(config: BigRedConfig, batchName?: string): void {
  console.log("\nBIGRED Status");
  console.log("=============");
  console.log(`Host: ${config.host}\n`);

  // Detect which batch is actually running from screen session name
  let runningBatch: string | null = null;
  try {
    const screens = sshCmd(config, "screen -ls 2>/dev/null || echo 'No screen sessions'");
    const screenMatch = screens.match(/hc-(batch-\d+)/);
    if (screenMatch) {
      runningBatch = screenMatch[1];
    }
    console.log(`Screen sessions:\n  ${screens}`);
  } catch {
    console.log("  (no screen sessions)");
  }

  // Warn if queried batch differs from running batch
  if (batchName && runningBatch && runningBatch !== batchName) {
    console.log(`\n  ⚠ NOTE: ${runningBatch} is running, not ${batchName}`);
    console.log(`  Use --batch ${runningBatch.replace("batch-", "").replace(/^0+/, "")} --status for live stats`);
  }

  const hashcatRunning = isHashcatRunning(config);

  // Show potfile stats
  const effectiveBatch = runningBatch || batchName;
  if (batchName && runningBatch && runningBatch !== batchName && hashcatRunning) {
    // Queried a different batch than what's running — show both
    const runningPotCount = getPotfileCount(config, runningBatch);
    console.log(`\nPotfile (${runningBatch}): ${runningPotCount.toLocaleString()} cracked  ← ACTIVE`);
    const queriedPotCount = getPotfileCount(config, batchName);
    console.log(`Potfile (${batchName}): ${queriedPotCount.toLocaleString()} cracked`);
  } else if (effectiveBatch) {
    // No batch specified or matches running — show the active/requested one
    const potCount = getPotfileCount(config, effectiveBatch);
    console.log(`\nPotfile (${effectiveBatch}): ${potCount.toLocaleString()} cracked`);
  }

  // GPU stats
  try {
    const gpu = sshCmd(config, "nvidia-smi --query-gpu=name,temperature.gpu,utilization.gpu,power.draw,memory.used,memory.total --format=csv,noheader 2>/dev/null || echo 'nvidia-smi unavailable'");
    console.log(`\nGPU: ${gpu}`);
  } catch {
    console.log("\nGPU: (nvidia-smi unavailable)");
  }

  // If hashcat is running, try to get its status
  if (hashcatRunning) {
    const label = runningBatch || batchName || "unknown";
    console.log(`\nhashcat is RUNNING (${label}). Send status request...`);
    try {
      const statusOutput = sshCmd(config, `cat ${config.workDir}/hashcat.status 2>/dev/null || echo 'No status file'`, 5000);
      if (!statusOutput.includes("No status file")) {
        console.log(statusOutput);
      }
    } catch { /* ignore */ }
  } else {
    console.log("\nhashcat is NOT running.");
  }
}

// =============================================================================
// Result Collection
// =============================================================================

async function collectResults(config: BigRedConfig, batchName: string): Promise<void> {
  console.log(`\nCollecting results for ${batchName}`);
  console.log("=".repeat(40));

  // Check potfile exists
  const potCount = getPotfileCount(config, batchName);
  if (potCount === 0) {
    console.log("No results to collect (potfile empty or missing).");
    return;
  }

  console.log(`Potfile: ${potCount.toLocaleString()} entries`);

  // Ensure diamonds directory exists
  if (!existsSync(DIAMONDS_DIR)) {
    mkdirSync(DIAMONDS_DIR, { recursive: true });
  }

  // Download potfile
  const localPotPath = resolve(DIAMONDS_DIR, `${batchName}.pot`);
  console.log(`Downloading potfile...`);
  scpDownload(config, `${config.workDir}/potfiles/${batchName}.pot`, localPotPath);
  console.log(`  Saved: ${localPotPath}`);

  // Parse potfile: format is hash:plain (one per line)
  const potContent = readFileSync(localPotPath, "utf-8");
  const lines = potContent.trim().split("\n").filter(l => l.includes(":"));

  const parsedPairs: { hash: string; plain: string }[] = [];
  const passwords: string[] = [];

  for (const line of lines) {
    const colonIdx = line.indexOf(":");
    if (colonIdx < 0) continue;

    const hash = line.slice(0, colonIdx).trim();
    const plain = decodeHexPlain(line.slice(colonIdx + 1));

    // Validate SHA-1 hash format
    if (/^[a-fA-F0-9]{40}$/.test(hash)) {
      parsedPairs.push({ hash, plain });
      passwords.push(plain);
    }
  }

  console.log(`Parsed: ${parsedPairs.length.toLocaleString()} valid hash:plain pairs`);

  // Append to single JSONL file (one JSON object per line — no delimiter ambiguity)
  const jsonlPath = resolve(DIAMONDS_DIR, "hash_plaintext_pairs.jsonl");
  const jsonlContent = parsedPairs.map(p => JSON.stringify(p)).join("\n") + "\n";
  appendFileSync(jsonlPath, jsonlContent);
  console.log(`  Hash:plain → ${jsonlPath} (appended ${parsedPairs.length.toLocaleString()})`);

  // Write passwords-only file (plain text, one per line)
  const passwordsPath = resolve(DIAMONDS_DIR, `passwords-${batchName}.txt`);
  writeFileSync(passwordsPath, passwords.join("\n") + "\n");
  console.log(`  Passwords  → ${passwordsPath}`);

  // Load SAND hashlist to compute crack rate + extract GLASS
  const batch = loadSandBatch(batchName);
  const totalHashes = batch ? batch.length : 0;
  const crackRate = totalHashes > 0 ? (parsedPairs.length / totalHashes * 100).toFixed(2) : "?";

  console.log(`\nResults: ${parsedPairs.length.toLocaleString()} / ${totalHashes.toLocaleString()} (${crackRate}%)`);

  // Extract GLASS (uncracked hashes = SAND - DIAMONDS)
  if (batch && batch.length > 0) {
    const crackedHashSet = new Set<string>();
    for (const p of parsedPairs) {
      crackedHashSet.add(p.hash.toLowerCase());
    }

    const glassHashes = batch.filter(h => !crackedHashSet.has(h.toLowerCase()));
    if (!existsSync(GLASS_DIR)) mkdirSync(GLASS_DIR, { recursive: true });
    const glassPath = resolve(GLASS_DIR, `${batchName}.txt`);
    writeFileSync(glassPath, glassHashes.join("\n") + "\n");
    console.log(`  GLASS: ${glassHashes.length.toLocaleString()} uncracked hashes → ${glassPath}`);
  }

  // Update sand-state.json
  const stateManager = new SandStateManager(DATA_DIR);
  const batchState = stateManager.getBatch(batchName);
  if (batchState) {
    stateManager.updateCracked(batchName, parsedPairs.length);
    stateManager.completeBatch(batchName);
    console.log(`  Updated sand-state.json`);
  } else {
    // Initialize state if not tracked
    stateManager.initBatch(batchName, 0, totalHashes);
    stateManager.updateCracked(batchName, parsedPairs.length);
    stateManager.completeBatch(batchName);
    console.log(`  Created sand-state.json entry for ${batchName}`);
  }

  // Per-attack breakdown table (from attackResults recorded during batch run)
  const finalBatchState = stateManager.getBatch(batchName);
  if (finalBatchState?.attackResults && finalBatchState.attackResults.length > 0) {
    const ar = finalBatchState.attackResults;
    console.log(`\nPer-attack breakdown:`);
    console.log(`  ${"Attack".padEnd(38)} ${"Cracks".padStart(8)}   ${"Rate".padStart(6)}  ${"Time".padStart(8)}`);
    console.log(`  ${"─".repeat(38)} ${"─".repeat(8)}   ${"─".repeat(6)}  ${"─".repeat(8)}`);

    let feedbackCracks = 0;
    let feedbackTime = 0;
    let totalTime = 0;

    const FEEDBACK_PREFIXES = ["feedback-", "nocapplus-"];

    for (const entry of ar) {
      const rate = totalHashes > 0 ? (entry.newCracks / totalHashes * 100).toFixed(2) + "%" : "?";
      const time = formatDuration(entry.durationSeconds);
      console.log(`  ${entry.attack.padEnd(38)} ${entry.newCracks.toLocaleString().padStart(8)}   ${rate.padStart(6)}  ${time.padStart(8)}`);
      totalTime += entry.durationSeconds;

      if (FEEDBACK_PREFIXES.some(p => entry.attack.startsWith(p))) {
        feedbackCracks += entry.newCracks;
        feedbackTime += entry.durationSeconds;
      }
    }

    const totalCracksFromResults = ar.reduce((sum, e) => sum + e.newCracks, 0);
    const totalRate = totalHashes > 0 ? (totalCracksFromResults / totalHashes * 100).toFixed(2) + "%" : "?";
    console.log(`  ${"─".repeat(38)} ${"─".repeat(8)}   ${"─".repeat(6)}  ${"─".repeat(8)}`);
    console.log(`  ${"TOTAL".padEnd(38)} ${totalCracksFromResults.toLocaleString().padStart(8)}   ${totalRate.padStart(6)}  ${formatDuration(totalTime).padStart(8)}`);

    if (feedbackCracks > 0) {
      const fbRate = totalHashes > 0 ? (feedbackCracks / totalHashes * 100).toFixed(2) + "%" : "?";
      console.log(`  ${"  Feedback subtotal".padEnd(38)} ${feedbackCracks.toLocaleString().padStart(8)}   ${fbRate.padStart(6)}  ${formatDuration(feedbackTime).padStart(8)}`);
    }
  }

  // Top passwords
  const freq = new Map<string, number>();
  for (const pw of passwords) {
    freq.set(pw, (freq.get(pw) || 0) + 1);
  }
  const top = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);

  if (top.length > 0) {
    console.log("\nTop 20 passwords:");
    for (const [pw, count] of top) {
      console.log(`  ${count.toString().padStart(6)} × ${pw}`);
    }
  }

  // Clean up BIGRED worker artifacts — potfile downloaded, no longer needed
  // Prevents stale potfiles from corrupting future batch runs
  try {
    sshCmd(config, `rm -f ${config.workDir}/potfiles/${batchName}.pot ${config.workDir}/hashlists/${batchName}.txt ${config.workDir}/hashcat-*.log`, 10000);
    sshCmd(config, `screen -X -S hc-${batchName} quit 2>/dev/null; true`, 5000);
    console.log(`\nCleaned BIGRED: potfile + hashlist + logs removed`);
  } catch { /* non-fatal */ }

  console.log(`\nNext steps:`);
  console.log(`  bun Tools/DiamondFeedback.ts --batch ${batchName}`);
}

function loadSandBatch(batchName: string): string[] | null {
  const gzPath = resolve(SAND_DIR, `${batchName}.txt.gz`);
  const txtPath = resolve(SAND_DIR, `${batchName}.txt`);

  if (existsSync(gzPath)) {
    const compressed = readFileSync(gzPath);
    const content = gunzipSync(compressed).toString("utf-8");
    return content.trim().split(/\r?\n/).filter(h => h.length === 40);
  } else if (existsSync(txtPath)) {
    const content = readFileSync(txtPath, "utf-8");
    return content.trim().split(/\r?\n/).filter(h => h.length === 40);
  }

  return null;
}

// =============================================================================
// Pre-flight Checks
// =============================================================================

function preflight(config: BigRedConfig, batchName: string, attacks: string[], batchState?: import("./SandStateManager").BatchState): boolean {
  console.log("\n--- PRE-FLIGHT CHECKS ---");

  // 0. Clean stale worker state for fresh batches
  //    BIGRED is just a worker — potfiles, logs, and screen sessions are ephemeral.
  //    If no attacks have been applied yet, wipe everything for a clean start.
  const isFreshBatch = !batchState || batchState.attacksApplied.length === 0;
  const potfilePath = `${config.workDir}/potfiles/${batchName}.pot`;

  try {
    const potSize = sshCmd(config, `stat -c %s ${potfilePath} 2>/dev/null || echo 0`);
    if (parseInt(potSize) > 0) {
      if (isFreshBatch) {
        // Fresh batch but stale potfile exists — clean it
        sshCmd(config, `rm -f ${potfilePath}`, 10000);
        sshCmd(config, `rm -f ${config.workDir}/hashcat-*.log`, 10000);
        sshCmd(config, `screen -X -S hc-${batchName} quit 2>/dev/null; true`, 5000);
        console.log(`  Cleaned stale potfile + logs (fresh batch)`);
      } else {
        // Resuming — potfile has our prior work, keep it
        const potLines = sshCmd(config, `wc -l < ${potfilePath}`);
        console.log(`  Potfile: ${parseInt(potLines).toLocaleString()} entries (resuming)`);
      }
    }
  } catch { /* non-fatal */ }

  // 1. Check hashlist exists on BIGRED
  const hashlistPath = `${config.workDir}/hashlists/${batchName}.txt`;
  try {
    const size = sshCmd(config, `stat -c %s ${hashlistPath} 2>/dev/null || echo 0`);
    if (parseInt(size) === 0) {
      console.error(`FAIL: Hashlist not found on BIGRED: ${hashlistPath}`);
      console.error(`  Fix: bun Tools/BigRedSync.ts --hashlist ${batchName}`);
      return false;
    }
    const lines = sshCmd(config, `wc -l < ${hashlistPath}`);
    console.log(`  Hashlist: ${parseInt(lines).toLocaleString()} hashes (${formatSize(parseInt(size))})`);
  } catch (e) {
    console.error(`FAIL: Cannot check hashlist: ${(e as Error).message}`);
    return false;
  }

  // 2. Check required files exist for each attack
  const missingFiles = new Set<string>();
  for (const attack of attacks) {
    const cmd = ATTACK_CMDS[attack];
    if (!cmd) continue;

    // Find filenames in the command
    for (const filename of Object.keys(FILE_MAP)) {
      if (cmd.includes(filename)) {
        const remotePath = `${config.workDir}/${FILE_MAP[filename]}`;
        try {
          const size = sshCmd(config, `stat -c %s ${remotePath} 2>/dev/null || echo 0`);
          if (parseInt(size) === 0) {
            missingFiles.add(filename);
          }
        } catch {
          missingFiles.add(filename);
        }
      }
    }
  }

  if (missingFiles.size > 0) {
    console.error(`FAIL: Missing files on BIGRED:`);
    for (const f of missingFiles) {
      console.error(`  - ${f}`);
    }
    console.error(`  Fix: bun Tools/BigRedSync.ts --force`);
    return false;
  }
  console.log(`  Attack files: All present`);

  // 3. Check no hashcat already running
  if (isHashcatRunning(config)) {
    console.log(`  WARNING: hashcat is already running on BIGRED`);
  } else {
    console.log(`  hashcat: Not running (ready)`);
  }

  // 4. Check disk space
  try {
    const df = sshCmd(config, `df -h ${config.workDir} | tail -1 | awk '{print $4}'`);
    console.log(`  Disk free: ${df}`);
  } catch { /* ignore */ }

  console.log("--- PRE-FLIGHT PASSED ---\n");
  return true;
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)}GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${bytes}B`;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(0)}s`;
  if (seconds < 3600) return `${(seconds / 60).toFixed(1)}m`;
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  return `${hrs}h ${mins}m`;
}

// =============================================================================
// CLI Entry Point
// =============================================================================

if (import.meta.main) {
  const args = process.argv.slice(2);

  let batchNumber: number | undefined;
  let attackName: string | undefined;
  let statusFlag = false;
  let collectFlag = false;
  let dryRun = false;
  let detached = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--batch":
        batchNumber = parseInt(args[++i]);
        break;
      case "--attack":
        attackName = args[++i];
        break;
      case "--status":
        statusFlag = true;
        break;
      case "--collect":
        collectFlag = true;
        break;
      case "--dry-run":
        dryRun = true;
        break;
      case "--detached":
        detached = true;
        break;
      case "--help":
      case "-h":
        console.log(`
BigRedRunner - SAND Batch Attack Orchestrator for BIGRED GPU

Usage:
  bun Tools/BigRedRunner.ts --batch 8                 Run all 18 attacks for batch-0008
  bun Tools/BigRedRunner.ts --batch 8 --attack brute-7  Run single attack
  bun Tools/BigRedRunner.ts --batch 8 --attack brute-7 --detached  Run detached (screen)
  bun Tools/BigRedRunner.ts --status                   Check hashcat status (auto-detects batch)
  bun Tools/BigRedRunner.ts --batch 8 --status        Check status for specific batch
  bun Tools/BigRedRunner.ts --batch 8 --collect       Collect results into DIAMOND pipeline
  bun Tools/BigRedRunner.ts --batch 8 --dry-run       Preview commands

Available attacks:
${Object.entries(ATTACK_CMDS).map(([n, c]) => `  ${n.padEnd(35)} ${c}`).join("\n")}

Attack order: ${DEFAULT_ATTACK_ORDER.join(" → ")}
`);
        process.exit(0);
    }
  }

  // --status works without --batch (auto-detects running batch)
  if (batchNumber === undefined && !statusFlag) {
    console.error("ERROR: --batch <n> is required");
    process.exit(1);
  }

  const paddedNum = batchNumber !== undefined ? String(batchNumber).padStart(4, "0") : undefined;
  const batchName = paddedNum ? `batch-${paddedNum}` : undefined;

  try {
    const config = loadConfig();
    console.log(`BIGRED: ${config.user}@${config.host}`);
    if (batchName) console.log(`Batch: ${batchName}`);

    // Test connectivity
    try {
      sshCmd(config, "echo connected", 10000);
    } catch {
      console.error("ERROR: Cannot connect to BIGRED. Check network and SSH key.");
      process.exit(1);
    }

    if (statusFlag) {
      showStatus(config, batchName);
      process.exit(0);
    }

    if (collectFlag) {
      await collectResults(config, batchName);
      process.exit(0);
    }

    // Determine attacks to run
    const stateManager = new SandStateManager(DATA_DIR);
    let batchState = stateManager.getBatch(batchName);

    let attacksToRun: string[];
    if (attackName) {
      attacksToRun = [attackName];
    } else {
      // Use remaining attacks from state, or full default order
      // IMPORTANT: empty array [] is truthy in JS — must check .length explicitly
      const remaining = batchState?.attacksRemaining;
      attacksToRun = (remaining && remaining.length > 0) ? remaining : [...DEFAULT_ATTACK_ORDER];
    }

    // Pre-flight (pass batchState so preflight can detect fresh vs resume)
    if (!dryRun) {
      if (!preflight(config, batchName, attacksToRun, batchState ?? undefined)) {
        process.exit(1);
      }
    }

    // Initialize batch state if not exists
    if (!batchState) {
      const hashes = loadSandBatch(batchName);
      const hashCount = hashes?.length || 0;
      stateManager.initBatch(batchName, 0, hashCount); // hashlistId=0 for BIGRED (no Hashtopolis)
      batchState = stateManager.getBatch(batchName)!;
    }

    console.log(`Attacks to run: ${attacksToRun.length}`);
    for (const a of attacksToRun) {
      const applied = stateManager.isAttackApplied(batchName, a);
      console.log(`  ${applied ? "[DONE]" : "[    ]"} ${a}`);
    }

    // Detached mode — only for single attack
    if (detached && attackName) {
      runAttackDetached(config, attackName, batchName);
      process.exit(0);
    }

    // Run attacks
    const results: AttackResult[] = [];
    const batchStartTime = Date.now();

    for (const attack of attacksToRun) {
      // Skip completed attacks
      if (stateManager.isAttackApplied(batchName, attack)) {
        console.log(`\n[SKIP] ${attack} — already completed`);
        continue;
      }

      // Mark attack as started (taskId=0 for BIGRED)
      stateManager.startAttack(batchName, attack, 0);

      const result = runAttack(config, attack, batchName, dryRun);
      results.push(result);

      if (!dryRun && result.durationSeconds >= 0) {
        // Mark attack as completed in state
        stateManager.completeAttack(batchName, attack, result.newCracks, result.durationSeconds);
      }
    }

    // Summary
    const totalDuration = (Date.now() - batchStartTime) / 1000;
    const totalNewCracks = results.reduce((sum, r) => sum + r.newCracks, 0);
    const finalPotCount = dryRun ? 0 : getPotfileCount(config, batchName);

    console.log(`\n${"=".repeat(60)}`);
    console.log(`BATCH COMPLETE: ${batchName}`);
    console.log("=".repeat(60));
    console.log(`Total time: ${formatDuration(totalDuration)}`);
    console.log(`New cracks this run: ${totalNewCracks.toLocaleString()}`);
    console.log(`Total potfile: ${finalPotCount.toLocaleString()}`);
    console.log("");

    if (results.length > 0 && !dryRun) {
      console.log("Per-attack results:");
      for (const r of results) {
        if (r.durationSeconds < 0) continue; // skipped
        console.log(`  ${r.attack.padEnd(35)} ${r.newCracks.toString().padStart(8)} cracks  ${formatDuration(r.durationSeconds).padStart(8)}`);
      }
    }

    if (!dryRun && totalNewCracks > 0) {
      console.log(`\nNext: bun Tools/BigRedRunner.ts --batch ${batchNumber} --collect`);
    }
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
  }
}
