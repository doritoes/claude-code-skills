# Deep Analysis Workflow

## Purpose

Analyze pearls (Stage 1 cracks) and diamonds (Stage 2 cracks) to improve the feedback loop and longer password coverage. Read-only — never modifies data files.

## When to Run

- After every 10-15 batches to assess pipeline health
- After significant wordlist/rule changes (new UNOBTAINIUM.rule, BETA.txt growth)
- When feedback cracks plateau (flat ~400/batch despite BETA.txt growth)
- Before designing new attacks targeting uncovered password patterns

## Usage

```bash
cd .claude/skills/ExpandedPasswordList

# Individual sections (fastest)
bun Tools/DeepAnalysis.ts --length      # Pearls vs diamonds length distribution
bun Tools/DeepAnalysis.ts --suffixes    # Suffix patterns + missing rules (~1 min, loads nocap-plus)
bun Tools/DeepAnalysis.ts --roots       # Root source attribution (~1 min, loads all wordlists)
bun Tools/DeepAnalysis.ts --long        # 9+ char structural analysis
bun Tools/DeepAnalysis.ts --feedback    # Feedback loop health from sand-state.json
bun Tools/DeepAnalysis.ts --beta        # Per-root crack attribution for BETA.txt + cohort ROI

# Full analysis (all sections including --beta)
bun Tools/DeepAnalysis.ts --full        # ~5-7 min (loads wordlists, streams all diamonds)
```

## Memory Requirements

| Section     | Peak Memory | Bottleneck                     |
|-------------|-------------|--------------------------------|
| --length    | ~100MB      | Streaming pearls (sampled)     |
| --suffixes  | ~1.2GB      | nocap-plus.txt Set (14.4M)     |
| --roots     | ~1.5GB      | nocap.txt + cohort Sets        |
| --long      | ~200MB      | 9+ char password array         |
| --feedback  | ~50MB       | sand-state.json only           |
| --beta      | ~1.5GB      | BETA.txt + cohort Sets + diamond stream |
| --full      | ~1.5GB      | Root/beta analysis is the peak  |

## Sections

### 1. Length Distribution (`--length`)

Side-by-side comparison of password lengths in pearls (sampled 1:1000) vs diamonds (all). The **Delta** column shows where Stage 2 adds value over Stage 1. Negative deltas at 9+ chars = feedback loop not reaching longer passwords.

### 2. Suffix Pattern Extraction (`--suffixes`)

Decomposes each diamond into `root + suffix` using nocap-plus.txt for root matching. Outputs:
- Suffix type distribution (digits, special, alpha, mixed, none)
- Top 50 suffixes ranked by frequency
- Each suffix mapped to hashcat rule syntax
- **MISSING** flag for rules not in nocap.rule or UNOBTAINIUM.rule

**Action**: Add top MISSING rules to UNOBTAINIUM.rule.

### 3. Root Source Attribution (`--roots`)

Traces which wordlist each diamond's root came from:
- **baseline** = nocap.txt (rockyou + rizzyou)
- **beta** = BETA.txt (feedback-discovered roots)
- **cohort:name** = specific cohort file
- **unknown** = no wordlist match (brute-force only)

**Action**: Cohort ROI ranking tells where to invest research effort.

### 4. Long Password Deep Dive (`--long`)

Classifies 9+ char diamonds by structural pattern (word+digits, pure-lowercase, mixed-case, etc.) and maps each pattern to current attack coverage. Identifies **UNCOVERED** gaps.

**Action**: Design new attacks for uncovered pattern categories.

### 5. Feedback Loop Health (`--feedback`)

Tracks feedback attack effectiveness (beta-nocaprule, nocapplus-unobtainium) across all completed batches. Detects:
- **FLAT**: Cracks stable despite BETA.txt growth → root quality problem
- **IMPROVING**: Feedback loop is compounding → keep current strategy
- **DECLINING**: Investigate rule/wordlist degradation

**Action**: If FLAT, shift from root quantity to quality. If rule change caused a jump, increase deep analysis frequency.

### 6. BETA.txt Root Attribution (`--beta`)

Streams all diamonds, matches against BETA.txt roots, and attributes cracks to their source cohort. Outputs:
- **Coverage summary**: What % of BETA roots have >=1 crack (expect <10% early, grows with batches)
- **Top 50 roots by crack count**: Which roots produce the most diamonds
- **Cohort ROI table**: Cracks per root by source (discovered, cohort:name) — guides where to invest research effort
- **Concentration metrics**: How much of the value comes from top 1%/10% of roots

**Action**: Expand cohorts with highest ROI (Portuguese, Slavic > Arabic > Indian >> phrases). Prune or stop investing in cohorts with <0.1 cr/root (spanish-phrases, french-phrases, markov-phrase-roots).

## Post-Analysis Actions

Based on findings, typical follow-up:

1. **Suffix rules**: Add top MISSING suffixes to UNOBTAINIUM.rule (manual review)
2. **Cohort priorities**: Expand cohorts with highest diamond attribution
3. **New attacks**: Design combinator/mask attacks for uncovered 9+ patterns
4. **Rule analysis frequency**: If feedback plateau confirmed, run deep rule analysis every 10 batches
5. **BETA.txt curation**: Run BetaCurator to exclude dead roots from BETA.txt

## BETA.txt Curation (BetaCurator)

When `--beta` shows high dead-root counts (>30% of roots with 0 cracks), run BetaCurator to generate an exclusion list. This speeds up all BETA-based feedback attacks without modifying cohort source files.

```bash
# Dry run — shows cohort health table, exclusion breakdown, estimated speedup
bun Tools/BetaCurator.ts

# Apply — writes beta-exclusions.txt, rebuilds BETA.txt
bun Tools/BetaCurator.ts --execute

# Sync to BIGRED after executing
bun Tools/BigRedSync.ts --sync-attack-files
```

**Key design decisions:**
- **Substring match, not prefix match** — roots are found anywhere in the password, accounting for combinator (suffix), reverse hybrid (prefix digits + root), and prepend rules
- **Roots < 4 chars are exempt** — too short for substring matching to measure, kept by default
- **Cohort files untouched** — exclusions only affect BETA.txt (cohort words still in nocap-plus.txt)
- **DiamondFeedback respects exclusions** — subsequent BETA.txt rebuilds automatically subtract `beta-exclusions.txt`
- **Re-runnable** — as more batches complete, excluded roots that start producing cracks get re-included

**Typical results (215 batches, 17.3M diamonds):**
- Name cohorts: 3-6% dead (healthy, keep)
- Phrase cohorts: 53-55% dead (markov 29K, spanish 4K, french 3K)
- BETA.txt: 80K → 43K (46% reduction, ~46% faster feedback attacks)
