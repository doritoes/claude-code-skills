#!/usr/bin/env bun
/**
 * ProgressTracker.ts - Pipeline Status Display
 *
 * Shows progress across all pipeline stages with live data from Hashtopolis.
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { StateManager, type PipelineState, type StageStatus } from "./StateManager";

// =============================================================================
// Configuration
// =============================================================================

const SKILL_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const DATA_DIR = resolve(SKILL_DIR, "data");
const HIBP_DIR = resolve(DATA_DIR, "hibp");
const CANDIDATES_DIR = resolve(DATA_DIR, "candidates");
const RESULTS_DIR = resolve(DATA_DIR, "results");

const TOTAL_PREFIXES = 1048576; // 16^5

// =============================================================================
// Status Display
// =============================================================================

interface StageInfo {
  name: string;
  status: StageStatus;
  progress: number;
  details: string[];
}

/**
 * Get status icon for stage
 */
function statusIcon(status: StageStatus): string {
  switch (status) {
    case "completed":
      return "\u2713"; // checkmark
    case "in_progress":
      return "\u21BB"; // rotating arrows
    case "failed":
      return "\u2717"; // X
    default:
      return "\u25CB"; // circle
  }
}

/**
 * Get disk usage for a directory
 */
function getDirSize(dir: string): number {
  if (!existsSync(dir)) return 0;

  let total = 0;
  try {
    const files = readdirSync(dir);
    for (const file of files) {
      const path = resolve(dir, file);
      const stats = statSync(path);
      if (stats.isFile()) {
        total += stats.size;
      }
    }
  } catch {
    // Ignore errors
  }
  return total;
}

/**
 * Format bytes as human readable
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * Format number with commas
 */
function formatNumber(n: number): string {
  return n.toLocaleString();
}

/**
 * Calculate time difference
 */
function timeSince(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Get detailed status for all stages
 */
async function getFullStatus(state: PipelineState): Promise<StageInfo[]> {
  const stages: StageInfo[] = [];

  // Download Stage
  const downloadProgress = (state.download.completedPrefixes.length / TOTAL_PREFIXES) * 100;
  const hibpSize = getDirSize(HIBP_DIR);
  stages.push({
    name: "DOWNLOAD",
    status: state.download.status,
    progress: downloadProgress,
    details: [
      `Prefixes: ${formatNumber(state.download.completedPrefixes.length)} / ${formatNumber(TOTAL_PREFIXES)} (${downloadProgress.toFixed(1)}%)`,
      `Total hashes: ${formatNumber(state.download.totalHashes)}`,
      `Disk usage: ${formatBytes(hibpSize)}`,
      ...(state.download.startedAt ? [`Started: ${timeSince(state.download.startedAt)}`] : []),
      ...(state.download.completedAt ? [`Completed: ${timeSince(state.download.completedAt)}`] : []),
      ...(state.download.error ? [`Error: ${state.download.error}`] : []),
    ],
  });

  // Filter Stage
  const filterProgress = state.download.completedPrefixes.length > 0
    ? (state.filter.completedPrefixes.length / state.download.completedPrefixes.length) * 100
    : 0;
  const candidatesSize = getDirSize(CANDIDATES_DIR);
  stages.push({
    name: "FILTER",
    status: state.filter.status,
    progress: filterProgress,
    details: [
      `Prefixes: ${formatNumber(state.filter.completedPrefixes.length)} / ${formatNumber(state.download.completedPrefixes.length)} (${filterProgress.toFixed(1)}%)`,
      `Rockyou matches (filtered): ${formatNumber(state.filter.rockyouMatches)}`,
      `Candidates: ${formatNumber(state.filter.candidates)}`,
      `Batches written: ${state.filter.batchesWritten}`,
      `Disk usage: ${formatBytes(candidatesSize)}`,
      ...(state.filter.completedAt ? [`Completed: ${timeSince(state.filter.completedAt)}`] : []),
      ...(state.filter.error ? [`Error: ${state.filter.error}`] : []),
    ],
  });

  // Crack Stage
  const crackProgress = state.crack.totalSubmitted > 0
    ? (state.crack.totalCracked / state.crack.totalSubmitted) * 100
    : 0;
  stages.push({
    name: "CRACK",
    status: state.crack.status,
    progress: crackProgress,
    details: [
      `Hashlists: ${state.crack.hashlistIds.length}`,
      `Tasks: ${state.crack.taskIds.length}`,
      `Submitted: ${formatNumber(state.crack.totalSubmitted)}`,
      `Cracked: ${formatNumber(state.crack.totalCracked)} (${crackProgress.toFixed(1)}%)`,
      ...(state.crack.startedAt ? [`Started: ${timeSince(state.crack.startedAt)}`] : []),
      ...(state.crack.completedAt ? [`Completed: ${timeSince(state.crack.completedAt)}`] : []),
      ...(state.crack.error ? [`Error: ${state.crack.error}`] : []),
    ],
  });

  // Results Stage
  const resultsSize = getDirSize(RESULTS_DIR);
  stages.push({
    name: "RESULTS",
    status: state.results.lastCollected ? "completed" : "pending",
    progress: state.results.lastCollected ? 100 : 0,
    details: [
      `Cracked passwords: ${formatNumber(state.results.crackedPasswords)}`,
      `Hard passwords: ${formatNumber(state.results.hardPasswords)}`,
      `Disk usage: ${formatBytes(resultsSize)}`,
      ...(state.results.lastCollected ? [`Collected: ${timeSince(state.results.lastCollected)}`] : []),
    ],
  });

  // Publish Stage
  stages.push({
    name: "PUBLISH",
    status: state.results.lastPublished ? "completed" : "pending",
    progress: state.results.lastPublished ? 100 : 0,
    details: [
      ...(state.results.lastPublished ? [`Published: ${timeSince(state.results.lastPublished)}`] : ["Not published yet"]),
      ...(state.results.publishedCommit ? [`Commit: ${state.results.publishedCommit.slice(0, 8)}`] : []),
    ],
  });

  return stages;
}

/**
 * Print status to console
 */
async function printStatus(jsonOutput = false): Promise<void> {
  const state = new StateManager(DATA_DIR);
  const pipelineState = state.load();
  const stages = await getFullStatus(pipelineState);

  if (jsonOutput) {
    const output = {
      lastUpdated: pipelineState.lastUpdated,
      stages: stages.map((s) => ({
        name: s.name,
        status: s.status,
        progress: s.progress,
      })),
      raw: pipelineState,
    };
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  console.log("ExpandedPasswordList Pipeline Status");
  console.log("====================================");
  console.log("");

  for (const stage of stages) {
    const icon = statusIcon(stage.status);
    console.log(`${stage.name}: ${stage.status} ${icon}`);
    for (const detail of stage.details) {
      console.log(`  ${detail}`);
    }
    console.log("");
  }

  // Next action recommendation
  console.log("---");
  const nextAction = getNextAction(pipelineState);
  console.log(`Next action: ${nextAction}`);
}

/**
 * Determine recommended next action
 */
function getNextAction(state: PipelineState): string {
  if (state.download.status === "pending") {
    return "Run Download workflow: bun Tools/HibpDownloader.ts";
  }
  if (state.download.status === "in_progress") {
    return "Wait for download to complete, or run with --resume to continue";
  }
  if (state.download.status === "failed") {
    return "Fix download error and retry: bun Tools/HibpDownloader.ts --resume";
  }

  if (state.filter.status === "pending") {
    return "Run Filter workflow: bun Tools/SetDifference.ts";
  }
  if (state.filter.status === "in_progress") {
    return "Wait for filter to complete";
  }
  if (state.filter.status === "failed") {
    return "Fix filter error and retry: bun Tools/SetDifference.ts --resume";
  }

  if (state.crack.status === "pending") {
    return "Run Crack workflow: bun Tools/CrackSubmitter.ts --all";
  }
  if (state.crack.status === "in_progress") {
    return "Monitor cracking progress in Hashtopolis, then run Collect";
  }

  if (!state.results.lastCollected) {
    return "Run Collect workflow: bun Tools/ResultCollector.ts";
  }

  if (!state.results.lastPublished) {
    return "Run Publish workflow: bun Tools/GitHubPublisher.ts";
  }

  return "Pipeline complete! Results published to GitHub.";
}

// =============================================================================
// CLI Usage
// =============================================================================

if (import.meta.main) {
  const args = process.argv.slice(2);
  const jsonOutput = args.includes("--json");

  await printStatus(jsonOutput);
}
