#!/usr/bin/env bun
/**
 * SandStateManager.ts - SAND Processing State Persistence
 *
 * Tracks SAND batch processing state, attack history, and strategy evolution.
 * Pattern adapted from StateManager.ts.
 *
 * @author PAI (Personal AI Infrastructure)
 * @updated 2026-02-25 — v7.2 attack order (23 attacks, added 10-char masks + 5/6-digit hybrids)
 * @license MIT
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DATA_DIR as CONFIG_DATA_DIR } from "./config";

// =============================================================================
// Types
// =============================================================================

export type BatchStatus = "pending" | "in_progress" | "completed" | "failed";

export interface AttackResultEntry {
  attack: string;
  newCracks: number;
  durationSeconds: number;
  crackRate: number;  // newCracks / hashCount
}

export interface BatchState {
  hashlistId: number;
  hashCount: number;
  attacksApplied: string[];
  attacksRemaining: string[];
  taskIds: Record<string, number>;  // attackName -> taskId
  cracked: number;
  attackResults: AttackResultEntry[];
  startedAt: string;
  lastAttackAt?: string;
  completedAt?: string;
  status: BatchStatus;
  error?: string;
  // Feedback metrics (populated by DiamondFeedback after post-processing)
  feedback?: {
    newRootsDiscovered: number;    // new roots found by DiamondAnalyzer
    hibpPromoted: number;          // roots promoted via HIBP validation
    totalDiscoveredRoots: number;  // cumulative discovered-roots.txt size
    betaSize: number;              // BETA.txt word count after feedback
    nocapPlusSize: number;         // nocap-plus.txt word count
    feedbackCracks: number;        // cracks from feedback-* attacks specifically
  };
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
 * Strategy (budget-aware tiering, batch-0005+):
 * 1. BRUTE FORCE 1-4 - instant, trivial keyspace
 * 2. BRUTE FORCE 6+7 - 70% of historical cracks, guaranteed ROI
 * 3. NEW ASSET TESTS - BETA.txt, nocap+nocap.rule, nocap+unobtainium (EXPERIMENT)
 * 4. PROVEN MEDIUM ROI - hybrid, mask, brute-5
 * 5. LOW ROI - remaining mask/hybrid (run if budget allows)
 * 6. FEEDBACK VALIDATION - test-unobtainium (measures feedback loop effectiveness)
 *
 * Decision gates after each tier: stop if AWS spend exceeds budget.
 * Feedback attacks (BETA+OneRule) promoted to Tier 2 when BETA.txt exists.
 */
export const DEFAULT_ATTACK_ORDER = [
  // ══════════════════════════════════════════════════════════════════════
  // CONTINUOUS IMPROVEMENT ATTACK ORDER — v7.2 (2026-02-25)
  // Applies to: batch-0020+ | 22 attacks
  // Assets: nocap-plus.txt (14.4M), nocap.rule (48K), BETA.txt (77.9K), UNOBTAINIUM.rule (266)
  // Based on: Gen2 batches 0001-0014 (421,562 cracks / 4.87M hashes)
  // Changes from v6.2:
  //   ADD hybrid-beta-5digit, hybrid-beta-6digit (Tier 2, <8 sec combined)
  //   ADD mask-Ullllllldd (Tier 3, ~74 sec, 10-char structured)
  //   ADD hybrid-nocapplus-5digit (Tier 3a, ~3 min)
  //   REMOVED mask-Ullllllllld (keyspace miscalculation: 1,411T not 54T — ~36 hrs, not 3.2 min)
  // v7.1: ADD mask-l8/ld8/l9, DROP hybrid-roots-4any/nocapplus-nocaprule/hybrid-nocapplus-3digit
  // ══════════════════════════════════════════════════════════════════════
  //
  // TIER 0: INSTANT (trivial keyspace, <1 second total)
  "brute-4",     // 133 cracks/batch avg — ~0.1 min
  "brute-3",     // 17 cracks/batch avg — ~0.2 min
  //
  // TIER 1: HIGH ROI — 52.6% of cracks, dominates batch time
  "brute-6",     // 7,154 cracks/batch avg — ~1.7 min (3,778 cr/min)
  "brute-7",     // 8,662 cracks/batch avg — ~107 min (79 cr/min)
  //
  // ── GATE 1: If <4% after Tier 1, STOP — something is broken ──────
  //
  // TIER 1a: CHEAP MASKS — 8/9-char lowercase funnel (NEW v7.0)
  "mask-l8",     // ?l^8, 26^8 = 209B — 19 seconds. Strips pure lowercase 8-char from pipeline.
  "mask-ld8",    // -1 ?l?d ?1^8, 36^8 = 2.8T — ~4.3 min. Lowercase+digit 8-char.
  //
  // TIER 2: FEEDBACK ATTACKS
  "feedback-beta-nocaprule",       // 394 cracks/batch — BETA.txt × nocap.rule
  "nocapplus-unobtainium",         // 51 cracks/batch — nocap-plus.txt × UNOBTAINIUM.rule
  "hybrid-beta-5digit",            // BETA × ?d^5 — <1 sec (v7.2)
  "hybrid-beta-6digit",            // BETA × ?d^6 — ~7 sec (v7.2)
  //
  // TIER 3: PROVEN MEDIUM ROI
  "hybrid-nocapplus-4digit",  // 3,168 cracks/batch — top hybrid (5,204 cr/min)
  "mask-lllllldd",            // 1,168 cracks/batch — 6 lower + 2 digits
  "brute-5",                  // 976 cracks/batch — 5-char exhaustive
  "mask-Ullllllld",           // 640 cracks/batch — Capital + 7 lower + 1 digit
  "mask-Ullllllldd",          // ?u?l^7?d^2, 10-char — ~74 sec (v7.2)
  //
  // TIER 3a: LONG-PASSWORD DISCOVERY — ?a suffix + 9-char masks (ordered by cr/min)
  "hybrid-nocapplus-3any",         // nocap-plus × ?a^3 — ~23 min, 8,281 cr/batch (353 cr/min) ★ TOP DISCOVERY
  "hybrid-nocapplus-5digit",       // nocap-plus × ?d^5 — ~3 min (v7.2)
  "mask-l9",                       // ?l^9, 26^9 — ~17 min, pure lowercase 9-char (157 cr/min)
  "hybrid-beta-4any",              // BETA.txt × ?a^4 — ~18 min, 1,061 cr/batch (59 cr/min)
  //
  // ── GATE 3: ~95% of achievable cracks done ───────────────────────
  //
  // TIER 4: LOW ROI
  "mask-Ullllldd",                  // 522 cracks/batch
  "mask-lllldddd",                  // 664 cracks/batch
  "hybrid-nocapplus-special-digits",  // 402 cracks/batch
  //
  // ══════════════════════════════════════════════════════════════════════
  // REMOVED: ZERO/MINIMAL VALUE
  // ══════════════════════════════════════════════════════════════════════
  // ✗ hybrid-roots-4any        - 0 cracks across 3 batches (0012-0014). top-roots.txt too niche. REMOVED v7.0.
  // ✗ nocapplus-nocaprule      - 1.6 cracks/batch across 14 batches. Redundant with other combos. REMOVED v7.0.
  // ✗ hybrid-nocapplus-3digit  - 0.7 cracks/batch. Subsumed by hybrid-nocapplus-3any (?a^3 > ?d^3). REMOVED v7.0.
  // ✗ brute-1                  - 0 cracks across 4 Gen2 batches. 1-char passwords can't survive Stage 1.
  // ✗ brute-2                  - 0 cracks across 4 Gen2 batches. 2-char passwords can't survive Stage 1.
  // ✗ mask-dddddddd            - Redundant (covered by brute-7)
  // ✗ newwords-rizzyou-*       - GenZ words ineffective on SAND (<0.2%)
  // ✗ newwords-nocap-genz      - Superseded by nocapplus-nocaprule
  // ✗ newwords-nocap-nocaprule - Superseded by nocapplus-nocaprule (same rules, fewer words)
  // ✗ newwords-nocap-unobtainium - Superseded by nocapplus-unobtainium
  // ✗ hybrid-rizzyou-4digit    - Minimal ROI (<0.1%)
  // ✗ hybrid-rockyou-year      - Minimal ROI (<0.1%)
  // ✗ brute-8                  - 169 hrs on BIGRED (7 days). DEFERRED to post-pipeline.
  //     Opportunity cost: 7 days = ~42 standard batches = ~966K cracks vs ~3K-33K from brute-8 on 1 batch.
  //     PLAN: After all gravel batches processed, combine ALL GLASS → single brute-8 pass.
  // ✗ rizzyou-bussin            - 0 cracks in b6; 203 candidates total (small×small)
  // ✗ feedback-beta-unobtainium - 0 cracks in b6; small×small pairing wastes a slot
  //     BETA.txt is incremental words → needs big rules (nocap.rule), not small rules
  //     UNOBTAINIUM.rule is incremental rules → needs big wordlist (nocap-plus.txt), not small wordlist
  // ✗ feedback-beta-onerule    - Renamed: feedback-beta-nocaprule (OneRule replaced)
  // ✗ feedback-rockyou-unobtainium - Replaced: feedback-nocapplus-unobtainium
  //
  // CONTINUOUS IMPROVEMENT: After each batch completes:
  // 1. Collect DIAMONDS → DiamondAnalyzer → new roots + UNOBTAINIUM rules
  // 2. Update nocap-plus.txt with new cohort discoveries
  // 3. Regenerate UNOBTAINIUM.rule from cumulative feedback
  // 4. Prune attacks below 0.1% threshold after 3+ attempts
  // 5. Next batch benefits from all prior discoveries
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
    const dir = dataDir || CONFIG_DATA_DIR;
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

        // Migration: add attackResults to existing batches that lack it
        for (const batch of Object.values(this.state.batches)) {
          if (!batch.attackResults) {
            batch.attackResults = [];
          }
        }

        return this.state!;
      } catch (e) {
        console.error(`Warning: Could not parse sand-state file, creating new: ${e}`);
      }
    }

    this.state = createDefaultState();
    return this.state;
  }

  /**
   * Save state to disk (immediate).
   * Creates a .bak backup before writing, validates state integrity,
   * and strips stale computed fields (summary, unobtainium).
   */
  save(): void {
    if (!this.state) return;
    this.state.lastUpdated = new Date().toISOString();

    // Strip stale static fields — these should be computed, not stored
    const stateAny = this.state as any;
    delete stateAny.summary;
    delete stateAny.unobtainium;

    // Validate before writing
    const warnings = this.validate();
    if (warnings.length > 0) {
      console.error(`[SandState] Validation warnings on save:`);
      for (const w of warnings) console.error(`  - ${w}`);
    }

    // Backup before write
    if (existsSync(this.statePath)) {
      try {
        copyFileSync(this.statePath, this.statePath + ".bak");
      } catch { /* non-fatal */ }
    }

    writeFileSync(this.statePath, JSON.stringify(this.state, null, 2));
  }

  /**
   * Validate state integrity. Returns list of warnings (empty = healthy).
   */
  validate(): string[] {
    if (!this.state) return ["State not loaded"];
    const warnings: string[] = [];

    for (const [name, batch] of Object.entries(this.state.batches)) {
      // Completed batch should have cracked > 0 (unless all attacks found 0)
      if (batch.status === "completed" && batch.cracked === 0 && batch.attacksApplied.length > 0) {
        warnings.push(`${name}: completed with 0 cracks and ${batch.attacksApplied.length} attacks — suspicious`);
      }

      // Completed batch should have completedAt
      if (batch.status === "completed" && !batch.completedAt) {
        warnings.push(`${name}: completed but missing completedAt timestamp`);
      }

      // attacksApplied + attacksRemaining should not have duplicates
      const overlap = batch.attacksApplied.filter(a => batch.attacksRemaining.includes(a));
      if (overlap.length > 0) {
        warnings.push(`${name}: attacks in BOTH applied and remaining: ${overlap.join(", ")}`);
      }

      // cracked should not exceed hashCount
      if (batch.cracked > batch.hashCount) {
        warnings.push(`${name}: cracked (${batch.cracked}) > hashCount (${batch.hashCount})`);
      }
    }

    return warnings;
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

    // Always use the latest DEFAULT_ATTACK_ORDER from code, not the persisted
    // state.attackOrder which may be stale from older batches.
    // Also sync state.attackOrder so it stays current.
    const currentOrder = [...DEFAULT_ATTACK_ORDER];
    state.attackOrder = currentOrder;

    state.batches[batchName] = {
      hashlistId,
      hashCount,
      attacksApplied: [],
      attacksRemaining: [...currentOrder],
      taskIds: {},
      cracked: 0,
      attackResults: [],
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

    // Guard: skip if already applied (prevents double-counting on retry)
    if (batch.attacksApplied.includes(attackName)) {
      console.warn(`[SandState] ${batchName}/${attackName} already applied — skipping duplicate completeAttack`);
      return;
    }

    // Move from remaining to applied
    batch.attacksRemaining = batch.attacksRemaining.filter((a) => a !== attackName);
    batch.attacksApplied.push(attackName);
    batch.cracked += crackedCount;
    batch.lastAttackAt = new Date().toISOString();

    // Record per-attack result (primary record for ROI analysis)
    batch.attackResults.push({
      attack: attackName,
      newCracks: crackedCount,
      durationSeconds,
      crackRate: batch.hashCount > 0 ? crackedCount / batch.hashCount : 0,
    });

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
   * Update cracked count for a batch (from DiamondCollector)
   */
  updateCracked(batchName: string, crackedCount: number): void {
    const state = this.load();
    const batch = state.batches[batchName];

    if (batch) {
      batch.cracked = crackedCount;
    }

    this.save();
  }

  /**
   * Mark batch as complete (all attacks done, GLASS extracted)
   */
  completeBatch(batchName: string): void {
    const state = this.load();
    const batch = state.batches[batchName];

    if (batch) {
      batch.status = "completed";
      batch.completedAt = new Date().toISOString();
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
  } else if (args[0] === "--validate") {
    mgr.load();
    const warnings = mgr.validate();
    if (warnings.length === 0) {
      console.log("State validation: HEALTHY (no issues found)");
    } else {
      console.log(`State validation: ${warnings.length} issue(s) found`);
      for (const w of warnings) {
        console.log(`  WARNING: ${w}`);
      }
    }

    // Also show computed summary for comparison
    const summary = mgr.getSummary();
    console.log(`\nComputed summary:`);
    console.log(`  Batches tracked: ${summary.totalBatches}`);
    console.log(`  Completed: ${summary.completed}`);
    console.log(`  In Progress: ${summary.inProgress}`);
    console.log(`  Pending: ${summary.pending}`);
    console.log(`  Failed: ${summary.failed}`);
    console.log(`  Total cracked: ${summary.totalCracked.toLocaleString()} / ${summary.totalHashes.toLocaleString()}`);
    if (summary.totalHashes > 0) {
      console.log(`  Rate: ${((summary.totalCracked / summary.totalHashes) * 100).toFixed(2)}%`);
    }
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
