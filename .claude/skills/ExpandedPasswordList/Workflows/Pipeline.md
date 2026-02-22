# Gen2 Pipeline — End-to-End Workflow

**Last Updated:** 2026-02-21
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
                   [BigRedRunner] ... Stage 2: 17 escalating attacks on BIGRED
                       |                |
                       v                v
                   diamonds/         glass/ (uncrackable)
                       |
                       v
                   [DiamondAnalyzer] . Entropy classification, pattern extraction
                       |
                       v
                   [DiamondFeedback] . BETA.txt + unobtainium.rule generation
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
| `BigRedSync.ts` | Sync wordlists/rules/hashlists to BIGRED | `--hashlist batch-NNNN` |
| `BigRedRunner.ts` | Stage 2 cracking (sand → diamonds + glass) | `--batch N`, `--collect`, `--status`, `--attack NAME`, `--dry-run` |
| `DiamondAnalyzer.ts` | Analyze cracked passwords, classify patterns | `--full data/diamonds/passwords-batch-NNNN.txt` |
| `DiamondFeedback.ts` | Generate BETA.txt + unobtainium.rule | `--batch batch-NNNN` |
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

## Phase 3: Stage 2 Cracking (Sand → Diamonds + Glass)

Runs 17 escalating attacks against SAND on BIGRED.

### Pre-Submission (one command)

```bash
# Syncs all attack files (md5 compare, uploads only changes) + uploads hashlist
bun Tools/BigRedSync.ts --hashlist batch-NNNN
```

### Run the Batch

```bash
# Run all 17 attacks sequentially
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

## Phase 4: Post-Batch Feedback Loop

After `--collect` completes, run these steps **in order**. Each step depends on the previous.

```bash
cd .claude/skills/ExpandedPasswordList

# Step 1: Analyze diamonds — classify patterns, extract roots
bun Tools/DiamondAnalyzer.ts --full data/diamonds/passwords-batch-NNNN.txt

# Step 2: Generate feedback — BETA.txt, unobtainium.rule, update sand-state
bun Tools/DiamondFeedback.ts --batch batch-NNNN

# Step 3: Rebuild nocap-plus.txt (cohort files may have changed)
"C:/Program Files/Python312/python.exe" scripts/rebuild-nocap-plus.py

# Step 4: Review attack effectiveness
bun Tools/AttackReview.ts
```

### Why This Order

| Step | Reads | Produces |
|------|-------|----------|
| DiamondAnalyzer | `passwords-batch-NNNN.txt` | Cohort reports, pattern analysis |
| DiamondFeedback | Diamond files, cohort files | `feedback/BETA.txt`, `feedback/unobtainium.rule`, sand-state feedback metrics |
| rebuild-nocap-plus | `data/cohorts/*.txt` | `nocap-plus.txt` (14.4M words) |
| AttackReview | `sand-state.json`, optionally `passwords-batch-NNNN.txt` + wordlists | ROI table, recommendations |

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

## Current Attack List (17 attacks, v5.1)

Defined in `SandStateManager.ts → DEFAULT_ATTACK_ORDER`:

| Tier | Attack | Description | Historical ROI |
|------|--------|-------------|----------------|
| 0 | brute-1 through brute-4 | Exhaustive 1-4 chars | <1s, trivial |
| 1 | brute-6 | Exhaustive 6 chars | 31.1% of cracks, ~1.2 min |
| 1 | brute-7 | Exhaustive 7 chars | 37.5% of cracks, ~55 min |
| 2 | feedback-beta-nocaprule | BETA.txt + nocap.rule | Feedback loop |
| 2 | nocapplus-nocaprule | nocap-plus.txt + nocap.rule | Feedback loop |
| 2 | nocapplus-unobtainium | nocap-plus.txt + UNOBTAINIUM.rule | Feedback loop |
| 3 | hybrid-nocapplus-4digit | nocap-plus + 4 digits | 13.5% of cracks |
| 3 | mask-lllllldd | 6 lower + 2 digits | 4.9% |
| 3 | brute-5 | Exhaustive 5 chars | 4.3% |
| 3 | mask-Ullllllld | Cap + 7 lower + 1 digit | 2.9% |
| 4 | mask-Ullllldd | Cap + 5 lower + 2 digits | 2.4% |
| 4 | hybrid-rockyou-special-digits | rockyou + special + 3 digits | 1.8% |
| 4 | hybrid-nocapplus-3digit | nocap-plus + 3 digits | Needs data |
| 4 | mask-lllldddd | 4 lower + 4 digits | Needs data |

**How to modify the attack list:** Edit `DEFAULT_ATTACK_ORDER` array in `Tools/SandStateManager.ts`. Use `AttackReview.ts` output to justify changes. The `ATTACK_CMDS` mapping in `BigRedRunner.ts` must also include any new attack name.

---

## Key Assets

| File | Location | Description |
|------|----------|-------------|
| `nocap.txt` | `data/nocap.txt` | rockyou + rizzyou baseline (13.8M words) |
| `nocap-plus.txt` | `data/nocap-plus.txt` | nocap + all cohort files (14.4M words) |
| `nocap.rule` | `data/nocap.rule` | 48K rules (OneRuleToRuleThemStill equivalent) |
| `BETA.txt` | `data/feedback/BETA.txt` | Discovered roots from diamonds (~77K words) |
| `unobtainium.rule` | `data/feedback/unobtainium.rule` | Learned rules from diamond patterns (194 rules) |
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
