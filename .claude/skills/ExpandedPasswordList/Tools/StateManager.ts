#!/usr/bin/env bun
/**
 * StateManager.ts - Pipeline State Persistence
 *
 * Tracks progress across all pipeline stages with crash-safe persistence.
 * Pattern adapted from MSV's MsvCache.ts.
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// =============================================================================
// Types
// =============================================================================

export type StageStatus = "pending" | "in_progress" | "completed" | "failed";

export interface DownloadState {
  status: StageStatus;
  completedPrefixes: string[];
  totalHashes: number;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  hibpVersion?: string;  // Track HIBP dataset version for incremental updates
  // Incremental update support
  etags?: Record<string, string>;  // prefix -> ETag for change detection
  checksums?: Record<string, string>;  // batch -> SHA-256 for integrity
  useBatchedStorage?: boolean;  // Flag for new batched storage format
}

export interface FilterState {
  status: StageStatus;
  completedPrefixes: string[];
  rockyouMatches: number;
  candidates: number;
  batchesWritten: number;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  useCompression?: boolean;  // Flag for gzip compressed output
}

export interface CrackState {
  status: StageStatus;
  hashlistIds: number[];
  taskIds: number[];
  totalSubmitted: number;
  totalCracked: number;
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

export interface ResultsState {
  crackedPasswords: number;
  hardPasswords: number;
  lastCollected?: string;
  lastPublished?: string;
  publishedCommit?: string;
}

export interface PipelineState {
  version: number;
  lastUpdated: string;
  download: DownloadState;
  filter: FilterState;
  crack: CrackState;
  results: ResultsState;
}

// =============================================================================
// Default State
// =============================================================================

function createDefaultState(): PipelineState {
  return {
    version: 1,
    lastUpdated: new Date().toISOString(),
    download: {
      status: "pending",
      completedPrefixes: [],
      totalHashes: 0,
    },
    filter: {
      status: "pending",
      completedPrefixes: [],
      rockyouMatches: 0,
      candidates: 0,
      batchesWritten: 0,
    },
    crack: {
      status: "pending",
      hashlistIds: [],
      taskIds: [],
      totalSubmitted: 0,
      totalCracked: 0,
    },
    results: {
      crackedPasswords: 0,
      hardPasswords: 0,
    },
  };
}

// =============================================================================
// State Manager Class
// =============================================================================

export class StateManager {
  private statePath: string;
  private state: PipelineState | null = null;
  private saveDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingSave = false;

  constructor(dataDir?: string) {
    const currentFile = fileURLToPath(import.meta.url);
    const skillDir = dirname(dirname(currentFile));
    const dir = dataDir || resolve(skillDir, "data");
    this.statePath = resolve(dir, "state.json");

    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * Load state from disk (lazy load, cached)
   */
  load(): PipelineState {
    if (this.state) return this.state;

    if (existsSync(this.statePath)) {
      try {
        const raw = readFileSync(this.statePath, "utf-8");
        this.state = JSON.parse(raw);

        // Migration: ensure all fields exist
        const defaults = createDefaultState();
        this.state = {
          ...defaults,
          ...this.state,
          download: { ...defaults.download, ...this.state!.download },
          filter: { ...defaults.filter, ...this.state!.filter },
          crack: { ...defaults.crack, ...this.state!.crack },
          results: { ...defaults.results, ...this.state!.results },
        };

        return this.state!;
      } catch (e) {
        console.error(`Warning: Could not parse state file, creating new: ${e}`);
      }
    }

    this.state = createDefaultState();
    return this.state;
  }

  /**
   * Save state to disk (immediate)
   */
  save(): void {
    if (!this.state) return;
    this.state.lastUpdated = new Date().toISOString();
    writeFileSync(this.statePath, JSON.stringify(this.state, null, 2));
  }

  /**
   * Save state with debouncing (for frequent updates)
   */
  saveDebounced(delayMs = 1000): void {
    this.pendingSave = true;

    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
    }

    this.saveDebounceTimer = setTimeout(() => {
      if (this.pendingSave) {
        this.save();
        this.pendingSave = false;
      }
    }, delayMs);
  }

  /**
   * Flush any pending debounced saves
   */
  flush(): void {
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
      this.saveDebounceTimer = null;
    }
    if (this.pendingSave) {
      this.save();
      this.pendingSave = false;
    }
  }

  // ===========================================================================
  // Download Stage
  // ===========================================================================

  startDownload(): void {
    const state = this.load();
    state.download.status = "in_progress";
    state.download.startedAt = new Date().toISOString();
    this.save();
  }

  addCompletedDownloadPrefix(prefix: string, hashCount: number): void {
    const state = this.load();
    if (!state.download.completedPrefixes.includes(prefix)) {
      state.download.completedPrefixes.push(prefix);
      state.download.totalHashes += hashCount;
    }
    this.saveDebounced();
  }

  completeDownload(): void {
    const state = this.load();
    state.download.status = "completed";
    state.download.completedAt = new Date().toISOString();
    this.flush();
  }

  failDownload(error: string): void {
    const state = this.load();
    state.download.status = "failed";
    state.download.error = error;
    this.flush();
  }

  // ===========================================================================
  // Filter Stage
  // ===========================================================================

  startFilter(): void {
    const state = this.load();
    state.filter.status = "in_progress";
    state.filter.startedAt = new Date().toISOString();
    this.save();
  }

  addFilteredPrefix(prefix: string, rockyouMatches: number, candidates: number): void {
    const state = this.load();
    if (!state.filter.completedPrefixes.includes(prefix)) {
      state.filter.completedPrefixes.push(prefix);
      state.filter.rockyouMatches += rockyouMatches;
      state.filter.candidates += candidates;
    }
    this.saveDebounced();
  }

  incrementBatchesWritten(): void {
    const state = this.load();
    state.filter.batchesWritten++;
    this.saveDebounced();
  }

  completeFilter(): void {
    const state = this.load();
    state.filter.status = "completed";
    state.filter.completedAt = new Date().toISOString();
    this.flush();
  }

  failFilter(error: string): void {
    const state = this.load();
    state.filter.status = "failed";
    state.filter.error = error;
    this.flush();
  }

  // ===========================================================================
  // Crack Stage
  // ===========================================================================

  startCrack(): void {
    const state = this.load();
    state.crack.status = "in_progress";
    state.crack.startedAt = new Date().toISOString();
    this.save();
  }

  addHashlist(hashlistId: number, taskId: number, hashCount: number): void {
    const state = this.load();
    state.crack.hashlistIds.push(hashlistId);
    state.crack.taskIds.push(taskId);
    state.crack.totalSubmitted += hashCount;
    this.saveDebounced();
  }

  updateCrackProgress(totalCracked: number): void {
    const state = this.load();
    state.crack.totalCracked = totalCracked;
    this.saveDebounced();
  }

  completeCrack(): void {
    const state = this.load();
    state.crack.status = "completed";
    state.crack.completedAt = new Date().toISOString();
    this.flush();
  }

  failCrack(error: string): void {
    const state = this.load();
    state.crack.status = "failed";
    state.crack.error = error;
    this.flush();
  }

  // ===========================================================================
  // Results Stage
  // ===========================================================================

  updateResults(crackedPasswords: number, hardPasswords: number): void {
    const state = this.load();
    state.results.crackedPasswords = crackedPasswords;
    state.results.hardPasswords = hardPasswords;
    state.results.lastCollected = new Date().toISOString();
    this.save();
  }

  recordPublish(commit: string): void {
    const state = this.load();
    state.results.lastPublished = new Date().toISOString();
    state.results.publishedCommit = commit;
    this.save();
  }

  // ===========================================================================
  // Utilities
  // ===========================================================================

  /**
   * Get overall pipeline status
   */
  getStatus(): {
    stage: "download" | "filter" | "crack" | "results" | "complete";
    progress: number;
  } {
    const state = this.load();

    if (state.download.status !== "completed") {
      const total = 1048576; // 16^5 prefixes
      const done = state.download.completedPrefixes.length;
      return { stage: "download", progress: (done / total) * 100 };
    }

    if (state.filter.status !== "completed") {
      const total = state.download.completedPrefixes.length;
      const done = state.filter.completedPrefixes.length;
      return { stage: "filter", progress: total > 0 ? (done / total) * 100 : 0 };
    }

    if (state.crack.status !== "completed") {
      const total = state.crack.totalSubmitted;
      const done = state.crack.totalCracked;
      return { stage: "crack", progress: total > 0 ? (done / total) * 100 : 0 };
    }

    if (!state.results.lastPublished) {
      return { stage: "results", progress: 0 };
    }

    return { stage: "complete", progress: 100 };
  }

  /**
   * Reset state (for testing or restart)
   */
  reset(): void {
    this.state = createDefaultState();
    this.save();
  }

  /**
   * Get path to state file
   */
  getStatePath(): string {
    return this.statePath;
  }
}

// =============================================================================
// CLI Usage
// =============================================================================

if (import.meta.main) {
  const args = process.argv.slice(2);
  const mgr = new StateManager();

  if (args[0] === "--reset") {
    mgr.reset();
    console.log("State reset to defaults");
  } else if (args[0] === "--json") {
    console.log(JSON.stringify(mgr.load(), null, 2));
  } else {
    const state = mgr.load();
    const status = mgr.getStatus();

    console.log("Pipeline State");
    console.log("==============");
    console.log(`Current stage: ${status.stage}`);
    console.log(`Progress: ${status.progress.toFixed(1)}%`);
    console.log(`Last updated: ${state.lastUpdated}`);
    console.log("");
    console.log(`Download: ${state.download.status} (${state.download.completedPrefixes.length} prefixes)`);
    console.log(`Filter: ${state.filter.status} (${state.filter.candidates} candidates)`);
    console.log(`Crack: ${state.crack.status} (${state.crack.totalCracked}/${state.crack.totalSubmitted})`);
    console.log(`Results: ${state.results.crackedPasswords} cracked, ${state.results.hardPasswords} hard`);
  }
}
