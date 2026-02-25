# Gen2 Pipeline — End-to-End Workflow

**Last Updated:** 2026-02-25
**Platform:** BIGRED (local RTX 4060 Ti, 192.168.99.204)

---

## Overview

```
hibp-batched/ (raw HIBP data)
      |
      v
  [RocksExtractor] ........... HIBP JSON → plain text SHA-1 batches
      |
      v
  rocks/ (500K hashes per file, ~4,340 files)
      |
      v
  [GravelFilter] ............. Subtract rockyou.txt matches
      |
      v
  gravel/ (1:1 batch correspondence with rocks/)
      |
      v
  [GravelProcessor] .......... Stage 1: rockyou + OneRule on BIGRED
      |                |
      v                v
  pearls/           sand/ (survivors)
                       |
                       v
                   [BigRedRunner] ... Stage 2: 18 attacks on BIGRED (v7.0)
                       |                |
                       v                v
                   diamonds/         glass/ (uncrackable)
                       |
                       v
                   [DiamondFeedback] . Entropy classification, cohort analysis, feedback generation
                       |
                       v
                   [rebuild-nocap-plus] . Merge cohorts into nocap-plus.txt
                       |
                       v
                   [AttackReview] .... ROI analysis, overlap testing, recommendations
                       |
                       v
                   [BigRedSync] ..... Sync updated assets to BIGRED
                       |
                       v
                   [next batch] ..... Loop
```

---

## Tools Reference

| Tool | Purpose | Key Flags |
|------|---------|-----------|
| `RocksExtractor.ts` | HIBP batched JSON → `rocks/batch-NNNN.txt` | `--resume` |
| `GravelFilter.ts` | rocks - rockyou = gravel (1:1 batch mapping) | `--verify` |
| `GravelProcessor.ts` | Stage 1 cracking (gravel → pearls + sand) | `--next`, `--batch N`, `--collect`, `--status`, `--dry-run` |
| `BatchRunner.ts` | **Stage 2 orchestrator** (sync → attacks → collect → feedback → rebuild) | `--batch N`, `--through M`, `--next`, `--count N`, `--resume`, `--status` |
| `BigRedSync.ts` | Sync wordlists/rules/hashlists to BIGRED | `--hashlist batch-NNNN` |
| `BigRedRunner.ts` | Stage 2 cracking (sand → diamonds + glass) | `--batch N`, `--collect`, `--status`, `--attack NAME`, `--dry-run` |
| `DiamondFeedback.ts` | Analyze diamonds, classify cohorts, generate feedback | `--batch batch-NNNN`, `--full`, `--analyze <file>` |
| `AttackReview.ts` | Attack ROI analysis + recommendations | `--batch batch-NNNN`, `--overlap`, `--json` |
| `SandStateManager.ts` | State inspection/validation | `--stats`, `--validate`, `--json` |
| `config.ts` | Shared paths (DATA_DIR, DIAMONDS_DIR, etc.) | — |

---

## Phase 1: Initial Setup (One-Time)

These steps have already been completed. Listed for reference only.

```bash
cd .claude/skills/ExpandedPasswordList

# 1. Download HIBP Pwned Passwords (~2.17B hashes)
bun Tools/HibpDownloader.ts --resume

# 2. Extract raw hashes from HIBP JSON batches
bun Tools/RocksExtractor.ts --resume
# Output: data/rocks/batch-0001.txt through batch-~4340.txt (500K each)

# 3. Filter out rockyou.txt matches
bun Tools/GravelFilter.ts
# Output: data/gravel/batch-NNNN.txt (1:1 with rocks, minus rockyou matches)
# Invariant: rocks[N] - rockyou = gravel[N]
```

---

## Phase 2: Stage 1 Cracking (Gravel → Pearls + Sand)

Cracks gravel batches with `rockyou.txt + OneRuleToRuleThemStill.rule` on BIGRED.

```bash
# Check what's next in the gravel queue
bun Tools/GravelProcessor.ts --status

# Process next pending batch
bun Tools/GravelProcessor.ts --next

# Or process a specific batch
bun Tools/GravelProcessor.ts --batch N

# Monitor progress
bun Tools/GravelProcessor.ts --batch N --status

# Collect results when done
bun Tools/GravelProcessor.ts --batch N --collect
```

**Output:**
- `data/pearls/hash_plaintext_pairs.jsonl` — cracked hash:password pairs (JSONL, append-only)
- `data/sand/batch-NNNN.txt.gz` — survivors (input for Stage 2)
- **Invariant:** PEARLS + SAND = GRAVEL

---

## Phase 3: Stage 2 — Automated (BatchRunner)

**Preferred method.** `BatchRunner.ts` orchestrates the full Stage 2 pipeline for 1 or more batches.

```bash
cd .claude/skills/ExpandedPasswordList

# Run a single batch end-to-end (sync → attacks → collect → feedback → rebuild)
bun Tools/BatchRunner.ts --batch N

# Run batches 1 through 10
bun Tools/BatchRunner.ts --batch 1 --through 10

# Run next 5 unprocessed batches (auto-discovers from sand-state.json)
bun Tools/BatchRunner.ts --next --count 5

# Resume an interrupted batch
bun Tools/BatchRunner.ts --batch N --resume

# Check progress
bun Tools/BatchRunner.ts --status

# Preview without executing
bun Tools/BatchRunner.ts --next --dry-run

# With HIBP validation + cohort growth on each batch
bun Tools/BatchRunner.ts --next --count 5 --full-feedback

# Pause between batches for confirmation
bun Tools/BatchRunner.ts --batch 1 --through 10 --confirm
```

**`--full-feedback` applies to EVERY batch in the run**, not just the last one. Each batch gets HIBP queries, cohort growth, and cohort-report.md generation.

**When to use `--full-feedback`:**
- **Early batches (first ~10-20):** Always use `--full-feedback`. The feedback loop is climbing — cohort files, BETA.txt, and unobtainium.rule are still growing rapidly. Each batch's diamonds contain new roots and patterns worth promoting immediately.
- **Steady-state (after ~20+ batches):** Optional. The feedback loop stabilizes as cohort files saturate. Standard feedback (without `--full`) still generates BETA.txt and rules but skips HIBP validation and cohort growth, saving ~2-5 minutes per batch.

**How it works:** Calls existing tools as child processes in sequence. Never writes to sand-state.json directly — all state management (attack effectiveness, per-attack cracks/duration/rate, feedback metrics) continues to be recorded by BigRedRunner and DiamondFeedback exactly as before.

**Error handling:**
- Steps 1-3 (sync, attacks, collect) are FATAL — stops and prints resume command
- Steps 4-5 (feedback, rebuild) are NON-FATAL — warns and continues to next batch
- Resume with `--resume` to pick up from the last completed step

---

## Phase 3a: Stage 2 — Manual (Individual Tools)

Use these when you need fine-grained control or debugging.

### Pre-Submission (one command)

```bash
# Syncs all attack files (md5 compare, uploads only changes) + uploads hashlist
bun Tools/BigRedSync.ts --hashlist batch-NNNN
```

### Run the Batch

```bash
# Run all attacks sequentially (v7.0: 18 attacks)
bun Tools/BigRedRunner.ts --batch N

# Monitor while running
bun Tools/BigRedRunner.ts --batch N --status

# Preview commands without executing
bun Tools/BigRedRunner.ts --batch N --dry-run
```

**NEVER add extra flags** (no `--workers`, no flags not used in the previous successful run).

### Collect Results

```bash
# After all attacks complete, collect diamonds + glass
bun Tools/BigRedRunner.ts --batch N --collect
```

**Output:**
- `data/diamonds/hash_plaintext_pairs.jsonl` — hash:plaintext pairs (JSONL, append-only)
- `data/diamonds/passwords-batch-NNNN.txt` — plaintexts only
- `data/glass/batch-NNNN.txt` — uncracked survivors

---

## Phase 4: Post-Batch Feedback Loop (Manual)

**Note:** If using BatchRunner, steps 1-3 below are handled automatically. This section is for manual operation only.

After `--collect` completes, run these steps **in order**. Each step depends on the previous.

```bash
cd .claude/skills/ExpandedPasswordList

# Step 1: Generate feedback — classify, extract roots, BETA.txt, unobtainium.rule
bun Tools/DiamondFeedback.ts --batch batch-NNNN
# Add --full for HIBP validation, cohort growth, and cohort-report.md

# Step 3: Rebuild nocap-plus.txt (cohort files may have changed)
"C:/Program Files/Python312/python.exe" scripts/rebuild-nocap-plus.py

# Step 4: Review attack effectiveness
bun Tools/AttackReview.ts
```

### Why This Order

| Step | Reads | Produces |
|------|-------|----------|
| DiamondFeedback | Diamond files, cohort files | `feedback/BETA.txt`, `feedback/unobtainium.rule`, `feedback/cohort-report.md` (--full), sand-state feedback metrics |
| rebuild-nocap-plus | `data/cohorts/*.txt` | `nocap-plus.txt` (14.4M words) |
| AttackReview | `sand-state.json`, optionally `passwords-batch-NNNN.txt` + wordlists | ROI table, recommendations |

---

## Phase 4a: Deep Rule Analysis (Periodic)

Regenerate UNOBTAINIUM.rule from the full diamond corpus. Run **every ~50 batches** or when diamonds roughly double since last run. See [`DeepRuleAnalysis.md`](DeepRuleAnalysis.md) for full documentation.

```bash
cd .claude/skills/ExpandedPasswordList

# Run analysis (output is large, redirect recommended)
bun ../../scratchpad/deep-rule-analysis.ts > ../../scratchpad/deep-analysis-output.txt 2>&1

# Review output, then update data/feedback/unobtainium.rule with new rules
# under the "# Deep analysis" marker (DiamondFeedback preserves this section)
```

**Last run:** 2026-02-24, 309K diamonds (11 batches), 230 rules at 30+ threshold.

---

## Phase 5: Attack Review

AttackReview evaluates attack effectiveness and recommends changes.

### Quick Review (state-only, instant)

```bash
bun Tools/AttackReview.ts
```

Shows:
- **ROI Table** — per-attack: cracks, rate, duration, cracks/min, cost%, marginal ROI
- **Tier Summary** — Tier 0-4 subtotals
- **Feedback Trend** — batch-over-batch feedback cracks + BETA.txt growth (needs 3+ batches for trend)
- **Recommendations** — DROP, REORDER, KEEP ON TRIAL, INVESTIGATE, BUDGET ALERT

### Single Batch Analysis

```bash
bun Tools/AttackReview.ts --batch batch-NNNN
```

### Overlap Analysis (~30s, loads wordlists)

```bash
bun Tools/AttackReview.ts --overlap
```

Adds:
- **Password Classification** — which attacks COULD have found each cracked password
- **Exclusive Value** — passwords only reachable by one specific attack
- **Uncovered Patterns** — password structures not matched by any current attack (candidates for new attacks)

### JSON Output (for scripting)

```bash
bun Tools/AttackReview.ts --json
```

### Interpreting Results

| Recommendation | What It Means | Action |
|----------------|---------------|--------|
| `[DROP]` | <0.01% rate after 3+ batches, <10 cracks | Remove from DEFAULT_ATTACK_ORDER |
| `[REORDER]` | Attack X has higher throughput than the one above it | Swap positions in DEFAULT_ATTACK_ORDER |
| `[TRIAL]` | <3 batches of data | Keep running, evaluate later |
| `[INVESTIGATE]` | Feedback attacks not improving after 5+ batches | Review BETA.txt quality, cohort diversity |
| `[BUDGET]` | >50% of time for <30% of cracks | Expected for brute-7; flag for others |
| `[ADD]` | Uncovered password patterns (--overlap only) | Design new attack to cover the gap |

**Note on stolen cracks:** Earlier attacks steal credit from later ones. If brute-6 cracks a password that mask-lllllldd would also find, brute-6 gets the credit. The `--overlap` analysis quantifies this by showing which attacks COULD cover each password regardless of execution order.

**brute-8 special handling:** Duration recorded as 0 (manual entry). Excluded from time-based metrics. Shows cracks but "n/a" for cracks/min, cost%, ROI.

---

## Phase 6: Prep for Next Batch

```bash
# 1. Sync attack files + upload hashlist (one command)
bun Tools/BigRedSync.ts --hashlist batch-NNNN

# 2. Submit next batch
bun Tools/BigRedRunner.ts --batch N
```

---

## Current Attack List (18 attacks, v7.0 — 2026-02-25)

Defined in `SandStateManager.ts → DEFAULT_ATTACK_ORDER`:

| Tier | Attack | Description | Gen2 ROI (14 batches) |
|------|--------|-------------|----------------------|
| 0 | brute-4, brute-3 | Exhaustive 3-4 chars | <1s, ~150 cracks/batch |
| 1 | brute-6 | Exhaustive 6 chars | 7,154 cr/batch, ~1.7 min |
| 1 | brute-7 | Exhaustive 7 chars | 8,662 cr/batch, ~107 min |
| 1a | mask-l8 | ?l^8 — pure lowercase 8-char | ~19s (NEW v7.0) |
| 1a | mask-ld8 | -1 ?l?d ?1^8 — lowercase+digit 8-char | ~4.3 min (NEW v7.0) |
| 2 | feedback-beta-nocaprule | BETA.txt + nocap.rule | 394 cr/batch, feedback loop |
| 2 | nocapplus-unobtainium | nocap-plus.txt + UNOBTAINIUM.rule | 51 cr/batch |
| 3 | hybrid-nocapplus-4digit | nocap-plus + 4 digits | 3,168 cr/batch, top hybrid |
| 3 | mask-lllllldd | 6 lower + 2 digits | 1,168 cr/batch |
| 3 | brute-5 | Exhaustive 5 chars | 976 cr/batch |
| 3 | mask-Ullllllld | Cap + 7 lower + 1 digit | 640 cr/batch |
| 3a | hybrid-nocapplus-3any | nocap-plus + ?a^3 | 8,281 cr/batch, ~23 min (353 cr/min) |
| 3a | mask-l9 | ?l^9 — pure lowercase 9-char | ~17 min (157 cr/min) |
| 3a | hybrid-beta-4any | BETA.txt + ?a^4 | 1,061 cr/batch, ~18 min (59 cr/min) |
| 4 | mask-Ullllldd | Cap + 5 lower + 2 digits | 522 cr/batch |
| 4 | mask-lllldddd | 4 lower + 4 digits | 664 cr/batch |
| 4 | hybrid-nocapplus-special-digits | nocap-plus + special + 3 digits | 402 cr/batch |

**Removed in v7.0:** hybrid-roots-4any (0 cracks/3 batches), nocapplus-nocaprule (1.6 cr/batch, redundant), hybrid-nocapplus-3digit (0.7 cr/batch, subsumed by ?a^3).

**How to modify the attack list:** Edit `DEFAULT_ATTACK_ORDER` array in `Tools/SandStateManager.ts`. Use `AttackReview.ts` output to justify changes. The `ATTACK_CMDS` mapping in `BigRedRunner.ts` must also include any new attack name.

---

## Key Assets

| File | Location | Description |
|------|----------|-------------|
| `nocap.txt` | `data/nocap.txt` | rockyou + rizzyou baseline (13.8M words) |
| `nocap-plus.txt` | `data/nocap-plus.txt` | nocap + all cohort files (14.4M words) |
| `nocap.rule` | `data/nocap.rule` | 48K rules (OneRuleToRuleThemStill equivalent) |
| `BETA.txt` | `data/feedback/BETA.txt` | Discovered roots from diamonds (~77K words) |
| `unobtainium.rule` | `data/feedback/unobtainium.rule` | Learned rules from diamond patterns (234 rules) |
| `top-roots.txt` | `data/feedback/top-roots.txt` | Curated top 1K roots for long-password discovery |
| `sand-state.json` | `data/sand-state.json` | Stage 2 state (batches, attack results, feedback metrics) |
| `gravel-state.json` | `data/gravel-state.json` | Stage 1 state |
| Cohort files | `data/cohorts/*.txt` | 12 language/cultural wordlists (52.8K+ words) |

---

## Material Classification

| Material | Stage | Contents | Format |
|----------|-------|----------|--------|
| **ROCKS** | Raw | Full HIBP SHA-1 hashes (500K per batch) | `batch-NNNN.txt` |
| **GRAVEL** | Filtered | ROCKS minus rockyou.txt matches | `batch-NNNN.txt` |
| **PEARLS** | Stage 1 output | Cracked by rockyou + OneRule | `hash_plaintext_pairs.jsonl` (append-only JSONL) |
| **SAND** | Stage 1 survivors | Input for Stage 2 | `batch-NNNN.txt.gz` |
| **DIAMONDS** | Stage 2 output | Cracked by escalating attacks | `hash_plaintext_pairs.jsonl` (append-only JSONL) + `passwords-batch-NNNN.txt` |
| **GLASS** | Stage 2 survivors | Uncrackable (deferred to post-pipeline brute-8) | `batch-NNNN.txt` |

---

## Troubleshooting

### SSH disconnects during long attacks
BigRedRunner launches hashcat in `screen` sessions. Triple completion check: process + screen + log status.

### brute-8
Deferred to post-pipeline. 169 hours on BIGRED (7 days). Plan: after all gravel batches processed, combine ALL GLASS into single brute-8 pass.

### File sync issues
Always run `bun Tools/BigRedSync.ts --status` before submitting. Verify all wordlists/rules show correct sizes.

### sand-state.json corruption
Backup at `sand-state.json.bak`. Use `bun Tools/SandStateManager.ts --validate` to check integrity.
