# SAND Batch-0006 Strategy — Continuous Improvement Framework

**Generated:** 2026-02-09 | **Method:** THEALGORITHM (DETERMINED)
**Success Criteria:** Crack rate > batch-0005's rate
**Principle:** Each batch feeds the next. Continuous improvement, never plateau.

---

## The Continuous Improvement Loop

```
batch-N completes
    │
    ├─ 1. COLLECT: DiamondCollector → data/diamonds/batch-NNNN.txt
    │
    ├─ 2. ANALYZE: DiamondAnalyzer --full → cohort-report.md, BETA.txt, UNOBTAINIUM.rule
    │      └─ New cohort roots discovered? → Add to cohort wordlists
    │      └─ New suffix patterns? → Add to UNOBTAINIUM.rule
    │      └─ New cohort categories? → Create new wordlist in data/cohorts/
    │
    ├─ 3. REBUILD: build_nocap_plus.py → nocap-plus.txt (always growing)
    │      └─ nocap.txt (IMMUTABLE without user approval)
    │      └─ + data/cohorts/*.txt (growing with each batch)
    │      └─ + BETA.txt (growing with each batch)
    │
    ├─ 4. EVALUATE: Compare batch-N crack rate vs batch-(N-1)
    │      └─ Which attacks contributed most?
    │      └─ Which attacks yielded zero? (candidates for removal)
    │      └─ Did new assets (cohort roots) produce cracks?
    │
    ├─ 5. PRUNE: Remove attacks below 0.1% after 3+ attempts
    │      └─ SandStateManager.getIneffectiveAttacks(3, 0.001)
    │      └─ Move to "REMOVED" section in DEFAULT_ATTACK_ORDER
    │
    ├─ 6. UPLOAD: Push updated nocap-plus.txt + UNOBTAINIUM.rule to Hashtopolis
    │
    └─ 7. SUBMIT: batch-(N+1) with improved strategy
         └─ Success = crack rate > batch-N
```

---

## Batch-0006 Specific Strategy

### Inputs from Batch-0005
Batch-0006 will be informed by batch-0005 results:

| If batch-0005 shows... | Then batch-0006... |
|---|---|
| nocapplus-nocaprule > 1% | Keep as primary attack, prioritize higher |
| nocapplus-nocaprule < 0.5% | Deprioritize, focus on brute + proven hybrids |
| hybrid-nocapplus-4digit > 0.5% | Expand: add -3digit, -year, -special variants |
| UNOBTAINIUM yields > 0 | Investigate new patterns, merge proven into nocap.rule |
| New cohort roots discovered | Add to cohort files, rebuild nocap-plus.txt |
| Total rate > 7.5% | Strategy is working, accelerate remaining batches |
| Total rate < 6.5% | Something wrong, investigate before batch-0007 |

### Attack Order (inherits v3.0 + batch-0005 learnings)

Same DEFAULT_ATTACK_ORDER as batch-0005, with these potential adjustments:

1. **If nocapplus-nocaprule proves effective:** Promote to Tier 1.5 (right after brute-7)
2. **If new UNOBTAINIUM rules found:** Upload updated rule file
3. **If new cohort categories emerge:** Add dedicated cohort attack (e.g., `cohort-kpop-nocaprule`)
4. **If any Tier 2 attack yields zero:** Move to REMOVED section

### Updated Assets for Batch-0006

| Asset | Update Process |
|-------|---------------|
| **nocap-plus.txt** | Rebuild with `build_nocap_plus.py` after batch-0005 analysis |
| **BETA.txt** | Regenerate from cumulative diamonds (batches 1-5) |
| **UNOBTAINIUM.rule** | Regenerate from cumulative diamonds (batches 1-5) |
| **Cohort wordlists** | Expand with any new discoveries from batch-0005 |
| **nocap.txt** | UNCHANGED (requires user approval to modify) |
| **nocap.rule** | UNCHANGED (OneRule + bussin, proven stable) |

---

## Continuous Improvement Metrics

### Track Per-Batch
```
batch_id | total_hashes | cracked | rate | vs_prev | delta | trend
---------|-------------|---------|------|---------|-------|------
0001     | 351,124     | 70,258  | 20.0%| -       | -     | -
0002     | 349,620     | 22,907  | 6.55%| -       | -     | baseline
0003     | 350,385     | 20,537  | 5.86%| 6.55%   | -0.69 | ↓
0004     | 350,638     | 22,635  | 6.45%| 5.86%   | +0.59 | ↑
0005     | ~350K       | ???     | ???  | 6.45%   | ???   | target: ↑
0006     | ~350K       | ???     | ???  | 0005    | ???   | target: ↑
```

Note: Batch-0001 is an outlier (included brute-8 at 52 hrs). Baseline starts at batch-0002.

### Track Per-Attack (Cumulative)
```
attack_name              | attempts | avg_rate | trend | action
-------------------------|----------|----------|-------|--------
brute-6                  | 4        | 2.10%    | ═     | KEEP
brute-7                  | 4        | 2.47%    | ═     | KEEP
hybrid-rockyou-4digit    | 4        | 0.87%    | ═     | KEEP
nocapplus-nocaprule      | 0        | -        | NEW   | TEST
hybrid-nocapplus-4digit  | 0        | -        | NEW   | TEST
feedback-beta-nocaprule  | 0        | -        | NEW   | TEST
```

### Decision Thresholds
| Metric | Action |
|--------|--------|
| Attack avg_rate > 1% after 2 batches | PROMOTE to higher tier |
| Attack avg_rate < 0.1% after 3 batches | REMOVE from pipeline |
| Batch rate declining 3 batches in a row | INVESTIGATE root cause |
| New cohort discovered with 5+ roots | CREATE dedicated wordlist |
| nocap-plus.txt grows > 20M lines | Consider splitting into focused wordlists |

---

## How to Execute Batch-0006

### Pre-requisite: Batch-0005 Must Complete

```bash
# 1. After batch-0005 completes, collect diamonds
bun .claude/skills/ExpandedPasswordList/Tools/DiamondCollector.ts --batch 5

# 2. Combine all diamonds for cumulative analysis
cat data/diamonds/passwords-batch-*.txt | sort -u > data/diamonds/all-diamonds-combined.txt

# 3. Run analysis on ALL diamonds (cumulative)
bun .claude/skills/ExpandedPasswordList/Tools/DiamondAnalyzer.ts --full data/diamonds/all-diamonds-combined.txt

# 4. Review cohort report for new discoveries
cat data/processed/cohort-report.md

# 5. Rebuild nocap-plus.txt with any new cohort additions
python build_nocap_plus.py

# 6. Upload updated assets to Hashtopolis
bun .claude/skills/Hashcrack/tools/HashtopolisClient.ts upload-wordlist nocap-plus.txt
bun .claude/skills/Hashcrack/tools/HashtopolisClient.ts upload-rule UNOBTAINIUM.rule

# 7. Update file IDs in SandProcessor.ts if they changed

# 8. Submit batch-0006
bun .claude/skills/ExpandedPasswordList/Tools/SandProcessor.ts --batch 6
```

---

## Long-Term Vision (batches 0005-0162)

### Phase 1: Validate (batches 0005-0007)
- Test new assets, measure impact
- Stabilize nocap-plus.txt composition
- Establish per-attack effectiveness baselines

### Phase 2: Optimize (batches 0008-0020)
- Prune zero-value attacks
- Expand high-value cohort wordlists
- Tune UNOBTAINIUM.rule from cumulative feedback
- Target: consistent 7%+ crack rate

### Phase 3: Scale (batches 0021-0162)
- Automated pipeline: submit → monitor → collect → analyze → improve → repeat
- Minimal human intervention
- nocap-plus.txt grows organically from discoveries
- Track cumulative diamonds collected across all batches

### Key Constraint: nocap.txt is IMMUTABLE
- Only modified with explicit user approval
- nocap-plus.txt is the working copy that grows
- If nocap-plus.txt proves dramatically better, propose merging into nocap.txt

---

## File Reference

| File | Purpose | Mutable? |
|------|---------|----------|
| `data/nocap.txt` | Baseline wordlist (14.3M) | NO — user approval required |
| `data/nocap-plus.txt` | Working wordlist (14.35M+) | YES — rebuilt each batch |
| `data/nocap.rule` | Rule file (OneRule+bussin) | NO — proven stable |
| `data/processed/BETA.txt` | DIAMOND-discovered roots | YES — regenerated each batch |
| `data/processed/UNOBTAINIUM.rule` | DIAMOND-learned rules | YES — regenerated each batch |
| `data/cohorts/*.txt` | Cohort wordlists (6 files) | YES — expanded with discoveries |
| `data/sand-state.json` | Batch tracking state | YES — updated by pipeline |
| `Tools/SandProcessor.ts` | Attack presets + orchestrator | YES — tuned per phase |
| `Tools/SandStateManager.ts` | State management + attack order | YES — updated per phase |
| `Tools/DiamondAnalyzer.ts` | Feedback extraction | Stable |
| `Tools/DiamondFeedback.ts` | Feedback integration | Stable |
| `scratchpad/build_nocap_plus.py` | nocap-plus.txt builder | Stable |
