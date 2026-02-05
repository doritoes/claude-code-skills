#!/usr/bin/env bun
/**
 * SandStateManager.ts - SAND Processing State Persistence
 *
 * Tracks SAND batch processing state, attack history, and strategy evolution.
 * Pattern adapted from StateManager.ts.
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

export type BatchStatus = "pending" | "in_progress" | "completed" | "failed";

export interface BatchState {
  hashlistId: number;
  hashCount: number;
  attacksApplied: string[];
  attacksRemaining: string[];
  taskIds: Record<string, number>;  // attackName -> taskId
  cracked: number;
  startedAt: string;
  lastAttackAt?: string;
  completedAt?: string;
  status: BatchStatus;
  error?: string;
}

export interface AttackStats {
  attempted: number;
  totalCracked: number;
  totalHashes: number;
  avgRate: number;
  avgTimeSeconds: number;
}

export interface SandState {
  version: number;
  batches: Record<string, BatchState>;
  attackStats: Record<string, AttackStats>;
  attackOrder: string[];  // Dynamic ordering based on effectiveness
  startedAt: string | null;
  lastUpdated: string | null;
}

// =============================================================================
// Attack Definitions
// =============================================================================

/**
 * Default attack order for SAND processing.
 *
 * IMPORTANT: SAND = hashes that SURVIVED rockyou.txt + OneRuleToRuleThemStill
 *
 * Strategy (optimized for feedback loop):
 * 1. FEEDBACK LOOP - Rules/words learned from previous DIAMONDS (when available)
 * 2. NEW WORDLISTS - rizzyou has GenZ terms NOT in rockyou
 * 3. BRUTE FORCE - exhaustive short passwords (EARLY for guaranteed cracks!)
 *    → Provides DIAMONDS to seed the feedback loop
 *    → Reveals actual password patterns people use
 * 4. HYBRID ATTACKS - append patterns NOT covered by rule attacks
 * 5. COMBINATOR - word+word combinations
 * 6. MASK - pure pattern-based attacks (longer, less guaranteed)
 *
 * Feedback attacks are prepended when BETA.txt and unobtainium.rule exist.
 */
export const DEFAULT_ATTACK_ORDER = [
  // Phase 0: Feedback loop (added when files exist)
  // "feedback-beta-onerule",      // Enabled when BETA.txt is generated
  // "feedback-rockyou-unobtainium", // Enabled when unobtainium.rule is generated
  // Phase 1: New wordlists (highest value - new root words!)
  "newwords-rizzyou-onerule",
  "newwords-nocap-genz",
  // Phase 2: Brute force EARLY (guaranteed cracks → seeds feedback loop!)
  "brute-1-5",   // Very fast, exhaustive 1-5 chars
  "brute-6",     // 6 chars - still reasonable time
  "brute-7",     // 7 chars - longer but valuable patterns
  // Phase 3: Hybrid attacks (append patterns)
  "hybrid-rockyou-4digit",
  "hybrid-rockyou-year",
  "hybrid-rizzyou-4digit",
  "hybrid-rockyou-special-digits",
  // Phase 4: Combinator
  "combo-common-numbers",
  // Phase 5: Mask attacks (common patterns, longer keyspace)
  "mask-Ullllldd",
  "mask-lllllldd",
  "mask-Ullllllld",
  "mask-dddddddd",
];

/**
 * Feedback attacks - enabled when BETA.txt and unobtainium.rule exist
 */
export const FEEDBACK_ATTACKS = [
  "feedback-beta-onerule",
  "feedback-rockyou-unobtainium",
];

// =============================================================================
// Default State
// =============================================================================

function createDefaultState(): SandState {
  return {
    version: 2,
    batches: {},
    attackStats: {},
    attackOrder: [...DEFAULT_ATTACK_ORDER],
    startedAt: null,
    lastUpdated: null,
  };
}

// =============================================================================
// SandStateManager Class
// =============================================================================

export class SandStateManager {
  private statePath: string;
  private state: SandState | null = null;
  private saveDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingSave = false;

  constructor(dataDir?: string) {
    const currentFile = fileURLToPath(import.meta.url);
    const skillDir = dirname(dirname(currentFile));
    const dir = dataDir || resolve(skillDir, "data");
    this.statePath = resolve(dir, "sand-state.json");

    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * Load state from disk (lazy load, cached)
   */
  load(): SandState {
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
          batches: this.state!.batches || {},
          attackStats: this.state!.attackStats || {},
          attackOrder: this.state!.attackOrder || [...DEFAULT_ATTACK_ORDER],
        };

        return this.state!;
      } catch (e) {
        console.error(`Warning: Could not parse sand-state file, creating new: ${e}`);
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
  // Batch Management
  // ===========================================================================

  /**
   * Initialize a new batch for processing
   */
  initBatch(batchName: string, hashlistId: number, hashCount: number): void {
    const state = this.load();

    if (!state.startedAt) {
      state.startedAt = new Date().toISOString();
    }

    state.batches[batchName] = {
      hashlistId,
      hashCount,
      attacksApplied: [],
      attacksRemaining: [...state.attackOrder],
      taskIds: {},
      cracked: 0,
      startedAt: new Date().toISOString(),
      status: "pending",
    };

    this.save();
  }

  /**
   * Get batch state
   */
  getBatch(batchName: string): BatchState | undefined {
    const state = this.load();
    return state.batches[batchName];
  }

  /**
   * Check if batch has hashlist already
   */
  getHashlistId(batchName: string): number | undefined {
    const batch = this.getBatch(batchName);
    return batch?.hashlistId;
  }

  /**
   * Start an attack on a batch
   */
  startAttack(batchName: string, attackName: string, taskId: number): void {
    const state = this.load();
    const batch = state.batches[batchName];

    if (!batch) {
      throw new Error(`Batch ${batchName} not found in state`);
    }

    batch.status = "in_progress";
    batch.taskIds[attackName] = taskId;
    batch.lastAttackAt = new Date().toISOString();

    this.save();
  }

  /**
   * Complete an attack on a batch
   */
  completeAttack(batchName: string, attackName: string, crackedCount: number, durationSeconds: number): void {
    const state = this.load();
    const batch = state.batches[batchName];

    if (!batch) {
      throw new Error(`Batch ${batchName} not found in state`);
    }

    // Move from remaining to applied
    batch.attacksRemaining = batch.attacksRemaining.filter((a) => a !== attackName);
    if (!batch.attacksApplied.includes(attackName)) {
      batch.attacksApplied.push(attackName);
    }
    batch.cracked += crackedCount;
    batch.lastAttackAt = new Date().toISOString();

    // Check if batch is complete
    if (batch.attacksRemaining.length === 0) {
      batch.status = "completed";
      batch.completedAt = new Date().toISOString();
    }

    // Update attack statistics
    if (!state.attackStats[attackName]) {
      state.attackStats[attackName] = {
        attempted: 0,
        totalCracked: 0,
        totalHashes: 0,
        avgRate: 0,
        avgTimeSeconds: 0,
      };
    }

    const stats = state.attackStats[attackName];
    stats.attempted++;
    stats.totalCracked += crackedCount;
    stats.totalHashes += batch.hashCount;
    stats.avgRate = stats.totalCracked / stats.totalHashes;
    stats.avgTimeSeconds = (stats.avgTimeSeconds * (stats.attempted - 1) + durationSeconds) / stats.attempted;

    this.save();
  }

  /**
   * Mark batch as failed
   */
  failBatch(batchName: string, error: string): void {
    const state = this.load();
    const batch = state.batches[batchName];

    if (batch) {
      batch.status = "failed";
      batch.error = error;
    }

    this.save();
  }

  /**
   * Get next pending attack for a batch
   */
  getNextAttack(batchName: string): string | null {
    const batch = this.getBatch(batchName);
    if (!batch || batch.attacksRemaining.length === 0) {
      return null;
    }
    return batch.attacksRemaining[0];
  }

  /**
   * Check if attack already applied to batch
   */
  isAttackApplied(batchName: string, attackName: string): boolean {
    const batch = this.getBatch(batchName);
    return batch?.attacksApplied.includes(attackName) ?? false;
  }

  // ===========================================================================
  // Strategy Evolution
  // ===========================================================================

  /**
   * Reorder attacks based on effectiveness (crack rate / time)
   */
  reorderAttacks(): void {
    const state = this.load();

    // Calculate effectiveness score for each attack
    const scores: { name: string; score: number }[] = [];

    for (const [name, stats] of Object.entries(state.attackStats)) {
      if (stats.attempted >= 2) {  // Need at least 2 attempts to have meaningful data
        // Effectiveness = crack rate / time (normalized)
        const timeNormalized = Math.max(stats.avgTimeSeconds, 60) / 3600;  // Normalize to hours
        const score = stats.avgRate / timeNormalized;
        scores.push({ name, score });
      }
    }

    // Sort by score descending
    scores.sort((a, b) => b.score - a.score);

    // Rebuild attack order: scored attacks first, then unscored in default order
    const scoredNames = new Set(scores.map((s) => s.name));
    const newOrder = [
      ...scores.map((s) => s.name),
      ...DEFAULT_ATTACK_ORDER.filter((n) => !scoredNames.has(n)),
    ];

    state.attackOrder = newOrder;
    this.save();

    console.log("Attack order updated based on effectiveness:");
    for (const { name, score } of scores) {
      console.log(`  ${name}: ${(score * 100).toFixed(3)} effectiveness`);
    }
  }

  /**
   * Get attacks that are ineffective (< threshold after N attempts)
   */
  getIneffectiveAttacks(minAttempts = 3, minRate = 0.001): string[] {
    const state = this.load();
    const ineffective: string[] = [];

    for (const [name, stats] of Object.entries(state.attackStats)) {
      if (stats.attempted >= minAttempts && stats.avgRate < minRate) {
        ineffective.push(name);
      }
    }

    return ineffective;
  }

  // ===========================================================================
  // Reporting
  // ===========================================================================

  /**
   * Get summary of all batch progress
   */
  getSummary(): {
    totalBatches: number;
    pending: number;
    inProgress: number;
    completed: number;
    failed: number;
    totalCracked: number;
    totalHashes: number;
  } {
    const state = this.load();
    const summary = {
      totalBatches: 0,
      pending: 0,
      inProgress: 0,
      completed: 0,
      failed: 0,
      totalCracked: 0,
      totalHashes: 0,
    };

    for (const batch of Object.values(state.batches)) {
      summary.totalBatches++;
      summary.totalCracked += batch.cracked;
      summary.totalHashes += batch.hashCount;

      switch (batch.status) {
        case "pending":
          summary.pending++;
          break;
        case "in_progress":
          summary.inProgress++;
          break;
        case "completed":
          summary.completed++;
          break;
        case "failed":
          summary.failed++;
          break;
      }
    }

    return summary;
  }

  /**
   * Get attack statistics
   */
  getAttackStats(): Record<string, AttackStats> {
    const state = this.load();
    return state.attackStats;
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
  const mgr = new SandStateManager();

  if (args[0] === "--reset") {
    mgr.reset();
    console.log("SAND state reset to defaults");
  } else if (args[0] === "--json") {
    console.log(JSON.stringify(mgr.load(), null, 2));
  } else if (args[0] === "--stats") {
    const stats = mgr.getAttackStats();
    console.log("Attack Statistics");
    console.log("=================");
    for (const [name, s] of Object.entries(stats)) {
      console.log(`\n${name}:`);
      console.log(`  Attempted: ${s.attempted}`);
      console.log(`  Total Cracked: ${s.totalCracked.toLocaleString()}`);
      console.log(`  Avg Rate: ${(s.avgRate * 100).toFixed(2)}%`);
      console.log(`  Avg Time: ${(s.avgTimeSeconds / 60).toFixed(1)} min`);
    }
  } else if (args[0] === "--reorder") {
    mgr.reorderAttacks();
  } else {
    const state = mgr.load();
    const summary = mgr.getSummary();

    console.log("SAND Processing State");
    console.log("=====================");
    console.log(`Started: ${state.startedAt || "Not started"}`);
    console.log(`Last updated: ${state.lastUpdated || "Never"}`);
    console.log("");
    console.log(`Total batches: ${summary.totalBatches}`);
    console.log(`  Pending: ${summary.pending}`);
    console.log(`  In Progress: ${summary.inProgress}`);
    console.log(`  Completed: ${summary.completed}`);
    console.log(`  Failed: ${summary.failed}`);
    console.log("");
    console.log(`Total cracked: ${summary.totalCracked.toLocaleString()} / ${summary.totalHashes.toLocaleString()}`);
    if (summary.totalHashes > 0) {
      console.log(`Overall rate: ${((summary.totalCracked / summary.totalHashes) * 100).toFixed(2)}%`);
    }
    console.log("");
    console.log(`Attack order: ${state.attackOrder.join(" → ")}`);
  }
}
