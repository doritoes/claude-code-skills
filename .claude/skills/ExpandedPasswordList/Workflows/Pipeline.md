# Gen2 Pipeline — End-to-End Workflow

**Last Updated:** 2026-03-03
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
                   [BigRedRunner] ... Stage 2: 35 attacks on BIGRED (v8.0)
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
| `DiamondFeedback.ts` | Analyze diamonds, classify cohorts, generate feedback (noise-filtered) | `--batch batch-NNNN`, `--full`, `--analyze <file>`, `--dry-run` |
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

### Run the Batch

BigRedRunner auto-syncs all attack files + hashlist during preflight (md5 compare, uploads only changes). No separate sync step needed.

```bash
# Run all attacks sequentially (v8.0: 35 attacks)
# Preflight auto-syncs wordlists, rules, and hashlist to BIGRED
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
cat data/nocap.txt data/cohorts/*.txt | sort -u > data/nocap-plus.txt

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

**Last run:** 2026-03-04 (full), 560K diamonds (12 Gen2 batches). 31 suffix gap rules added to UNOBTAINIUM.rule (v8.0). Only 1 MISSING rule found in v8.1 analysis ($6 $@, added).

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
# BigRedRunner auto-syncs attack files + hashlist during preflight
bun Tools/BigRedRunner.ts --batch N
```

**Note:** BigRedSync can still be used standalone for manual sync/inspection: `bun Tools/BigRedSync.ts --hashlist batch-NNNN`

---

## Current Attack List (35 attacks, v8.1 — 2026-03-04)

Defined in `SandStateManager.ts → DEFAULT_ATTACK_ORDER`. Sorted by cr/min within tiers (12-batch data):

| Tier | Attack | Description | ROI (12-batch avg) |
|------|--------|-------------|-------------------|
| 0 | mask-d10 | Pure digits 10 chars (phone numbers) | 2,880 cr/batch, 4,706 cr/min |
| 0 | brute-4 | Exhaustive 4 chars | 132 cr/batch, 961 cr/min |
| 0 | mask-d11 | Pure digits 11 chars (international) | 2,306 cr/batch, 3,763 cr/min |
| 0 | mask-d9 | Pure digits 9 chars (PINs) | 256 cr/batch, 418 cr/min |
| 0 | mask-d12 | Pure digits 12 chars | 694 cr/batch, 315 cr/min |
| 0 | brute-3 | Exhaustive 3 chars | 17 cr/batch, 124 cr/min |
| 1 | brute-6 | Exhaustive 6 chars | 7,144 cr/batch, 4,278 cr/min |
| 1 | brute-7 | Exhaustive 7 chars | 8,661 cr/batch, 81 cr/min |
| 1a | mask-l8 | ?l^8 — pure lowercase 8-char | 13,035 cr/batch, 21,506 cr/min |
| 1a | mask-ld8 | -1 ?l?d ?1^8 — lowercase+digit 8-char | 12,824 cr/batch, 2,653 cr/min |
| 2 | nocapplus-unobtainium | nocap-plus.txt × UNOBTAINIUM.rule (285 rules) | 547 cr/batch, 982 cr/min |
| 2 | feedback-beta-nocaprule | BETA.txt × nocap.rule | 269 cr/batch, 443 cr/min |
| 2 | hybrid-beta-6digit | BETA.txt + ?d^6 | 302 cr/batch, 497 cr/min |
| 2 | reverse-nocapplus-4digit | -a 7 ?d^4 + nocap-plus (prefix) | 855 cr/batch, 1,093 cr/min |
| 2 | hybrid-beta-5digit | BETA.txt + ?d^5 | 111 cr/batch, 182 cr/min |
| 2 | reverse-nocapplus-3digit | -a 7 ?d^3 + nocap-plus (prefix) | 213 cr/batch, 351 cr/min |
| 2 | combo-beta-beta | -a 1 BETA × BETA (word+word) | 97 cr/batch, 188 cr/min |
| 2 | combo-beta-beta-cap | -a 1 -j c BETA × BETA (Cap+word) | 44 cr/batch, 85 cr/min |
| 2 | reverse-nocapplus-1special | -a 7 ?s + nocap-plus (prefix) | 13 cr/batch, 21 cr/min |
| 3 | hybrid-nocapplus-4digit | nocap-plus + 4 digits | 1,844 cr/batch, 3,033 cr/min |
| 3 | brute-5 | Exhaustive 5 chars | 969 cr/batch, 1,594 cr/min |
| 3 | combo-beta-nocapplus-cap | -a 1 -j c BETA × nocap-plus | 994 cr/batch, 429 cr/min |
| 3 | mask-Ullllllld | Cap + 7 lower + 1 digit | 642 cr/batch, 170 cr/min |
| 3 | mask-Ullllllldd | Cap + 7 lower + 2 digits (10-char) | 1,075 cr/batch, 33 cr/min |
| 3a | hybrid-nocapplus-3digit-1special | nocap-plus + ?d?d?d?s | 1,498 cr/batch, 1,322 cr/min |
| 3a | hybrid-nocapplus-5digit | nocap-plus + ?d^5 | 1,623 cr/batch, 499 cr/min |
| 3a | combo-beta-nocapplus | -a 1 BETA × nocap-plus | 511 cr/batch, 221 cr/min |
| 3a | hybrid-nocapplus-3any | nocap-plus + ?a^3 | 6,557 cr/batch, 278 cr/min |
| 3a | mask-l9 | ?l^9 — pure lowercase 9-char | 1,685 cr/batch, 195 cr/min |
| 3a | hybrid-nocapplus-4digit-1special | nocap-plus + ?d?d?d?d?s | 1,193 cr/batch, 128 cr/min |
| 3a | hybrid-beta-4any | BETA.txt + ?a^4 | 328 cr/batch, 22 cr/min |
| 4 | mask-Ullllldd | Cap + 5 lower + 2 digits | 518 cr/batch, 851 cr/min |
| 4 | hybrid-nocapplus-special-digits | nocap-plus + ?s?d?d?d | 337 cr/batch, 296 cr/min |
| 4 | hybrid-nocapplus-digit-1special | nocap-plus + ?d?s | 55 cr/batch, 91 cr/min |
| 4 | reverse-nocapplus-special-3digit | -a 7 ?s?d^3 + nocap-plus | 27 cr/batch, 16 cr/min |

**v8.1 (2026-03-04):** REORDER 3 swaps (12-batch cr/min). Cohort expansion (+475 Portuguese, +540 Slavic).
**v8.0 (2026-03-03):** REORDER all tiers by cr/min (AttackReview --overlap). ADD 31 suffix rules to UNOBTAINIUM.rule (285 total).
**v7.9 (2026-03-02):** 4 reverse hybrids (-a 7) + 4 combinators (-a 1). Removed brute-1/2 (0 cracks in Gen2).
**v7.6:** hybrid-nocapplus-3digit-1special, 4digit-1special. Removed: digit-2special (0 cr), digit-3special (3.2 cr/min).
**v7.4:** mask-d9/d10/d11/d12 — Tier 0 pure digit masks (<2 min combined).
**v7.3:** Removed mask-lllllldd, mask-lllldddd (0 cracks post-v7.0, subsumed by mask-l8/ld8).

**Speed note:** nocap-plus hybrids run at ~4 GH/s (0.37× mask speed). Reverse hybrids (-a 7) are faster: 1-7.5 GH/s. Combinators (-a 1): 4.8-8.4 GH/s.

**How to modify the attack list:** Edit `DEFAULT_ATTACK_ORDER` array in `Tools/SandStateManager.ts`. Use `AttackReview.ts` output to justify changes. The `ATTACK_CMDS` mapping in `BigRedRunner.ts` must also include any new attack name.

---

## Key Assets

| File | Location | Description |
|------|----------|-------------|
| `nocap.txt` | `data/nocap.txt` | rockyou + rizzyou baseline (13.8M words) |
| `nocap-plus.txt` | `data/nocap-plus.txt` | nocap + all cohort files (14.4M words) |
| `nocap.rule` | `data/nocap.rule` | 48,428 rules (OneRuleToRuleThemStill + 14 bussin.rule). Rebuild: `bun scripts/build-nocap-rule.ts` |
| `bussin.rule` | `data/feedback/bussin.rule` | 14 rules NOT in OneRule (source for nocap.rule build) |
| `BETA.txt` | `data/feedback/BETA.txt` | Discovered roots from diamonds (rebuilds each batch via DiamondFeedback) |
| `unobtainium.rule` | `data/feedback/unobtainium.rule` | 285 rules: auto-generated + deep analysis + manual v7.2 + v8.0/v8.1 suffix gaps |
| `sand-state.json` | `data/sand-state.json` | Stage 2 state (batches, attack results, feedback metrics) |
| `gravel-state.json` | `data/gravel-state.json` | Stage 1 state |
| Cohort files | `data/cohorts/*.txt` | 12 language/cultural wordlists (79K words) |
| `build-nocap-rule.ts` | `scripts/build-nocap-rule.ts` | Builds nocap.rule from OneRule + bussin at performance-correct positions |

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

---

## Post-Pipeline Deferred Attacks

Attacks too expensive for per-batch execution. Run as single passes on combined GLASS after pipeline completes.

### brute-8
`?a?a?a?a?a?a?a?a` (95^8). ~169 hours (7 days). Combine ALL GLASS → single pass.

### 9+ Char Mask Candidates (deep analysis 2026-03-04, 560K diamonds)

69.2% of 9+ char diamonds (141,599) have weak/no attack coverage:

| Candidate | Mask | Keyspace | Est. Time | Target Gap |
|-----------|------|----------|-----------|------------|
| mask-ld9 | `-1 ?l?d ?1?1?1?1?1?1?1?1?1` | 36^9 = 101T | ~2.6 hrs | 9-char lowercase+digit (9.6% of 9+ gap) |
| mask-l10 | `?l?l?l?l?l?l?l?l?l?l` | 26^10 = 141T | ~3.6 hrs | 10-char pure lowercase (10.6% of 9+ gap) |

**Gap breakdown (9+ chars, 204,706 diamonds):**
- pure-digits (49,346, 24.1%) — covered by mask-d9/d10/d11/d12
- complex-with-special (35,768, 17.5%) — mostly hybrid coverage, hard to mask
- pure-lowercase (21,773, 10.6%) — mask-l8/l9 cover 8-9 only
- pure-alnum (19,612, 9.6%) — mask-ld8 covers 8 only
- mixed-case+digits (6,197, 3.0%) — no dedicated attack
- mixed-case-alpha (1,020, 0.5%) — no dedicated attack

**Decision:** Add to per-batch attack order only if batch duration budget allows (~6 hrs combined). Otherwise run as post-pipeline passes on combined GLASS.

### Phrase + Leet Substitution Experiment (planned)

Phrase cohorts (markov 52.9K, spanish 7.5K, french 5.8K) show 0.09-0.15 cr/root with current suffix/append rules. Hypothesis: phrases paired with leet substitution rules (`sa@ se3 si1 so0`, `$a4 $e3 $i1 $o0`) may unlock cracks invisible to current attacks (e.g., `iloveyou` → `1l0v3y0u`). Current low ROI could be rule mismatch, not bad roots.

**Test design:** Single-batch experiment — phrase cohort × leet-focused ruleset — measure cr/min. Compare against same phrases × current nocap.rule to isolate leet contribution. Data-driven: if cr/min justifies, add leet rules to UNOBTAINIUM.rule or create dedicated phrase+leet attack.
