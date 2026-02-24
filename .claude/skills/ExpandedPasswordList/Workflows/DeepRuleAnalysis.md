# Deep Rule Analysis — Regenerating UNOBTAINIUM.rule

## What It Does

Reverse-engineers hashcat rules from the accumulated DIAMOND corpus by:
1. Loading all `passwords-batch-NNNN.txt` files from `data/diamonds/`
2. Decomposing each password into `{prefix, root, suffix, casePattern}`
3. Checking if the root exists in `nocap.txt` (13.8M baseline words)
4. Converting the transformation (prefix/suffix/case/leet) into hashcat rule syntax
5. Diffing discovered rules against `nocap.rule` (48K existing rules)
6. Outputting only NEW rules sorted by frequency

## When to Run

**Every 50 batches** — or whenever the diamond corpus roughly doubles since the last run.

| Milestone | Diamonds | Action |
|-----------|----------|--------|
| Batch 11 | ~309K | First Gen2 deep analysis (done 2026-02-24) |
| Batch 50 | ~1.2M | Regenerate — expect new suffix/prefix patterns |
| Batch 100 | ~2.4M | Regenerate — rarer rules will reach threshold |
| Batch 200+ | ~4.8M+ | Regenerate — long tail patterns emerge |

**Why not every batch?** The analysis loads 13.8M baseline words into memory (~3GB) and processes all diamonds. It takes ~30 seconds and produces nearly identical output for small increments. The threshold (30+ occurrences) needs volume to surface new rules.

## How to Run

```bash
cd .claude/skills/ExpandedPasswordList

# Run the analysis (prints all results to stdout)
bun ../../scratchpad/deep-rule-analysis.ts

# Output is large (~2MB). Redirect to file for review:
bun ../../scratchpad/deep-rule-analysis.ts > ../../scratchpad/deep-analysis-output.txt 2>&1
```

## Reading the Output

The script produces 7 ranked sections:

| Section | What It Shows | Min Count |
|---------|---------------|-----------|
| SUFFIX PATTERNS | Standalone append rules (`$1`, `$8 $8`) | 10 |
| PREFIX PATTERNS | Standalone prepend rules (`^1`, `^2 ^1`) | 10 |
| CASE-ONLY RULES | Pure case transforms (`c`, `u`, `l`) | 5 |
| CASE + SUFFIX | Most valuable — capitalize+digits etc. | 5 |
| CASE + PREFIX | Prefix with case changes | 5 |
| PREFIX + SUFFIX | Complex multi-transform | 5 |
| LEET PATTERNS | Character substitutions (`sa@`, `se3`) | 5 |

Each rule is marked `** NEW **` if not in nocap.rule.

The final summary shows ALL new rules sorted by frequency descending.

## Updating UNOBTAINIUM.rule

After reviewing the output:

1. **Choose a threshold** — rules with N+ occurrences (recommended: 30+ for <250 rules)
2. **Extract the rules** from the final summary section
3. **Write them into** `data/feedback/unobtainium.rule` under the `# Deep analysis` comment marker
4. **DiamondFeedback.ts preserves** everything after `# Deep analysis` when it rewrites the auto-generated section

### Threshold Guide

| Threshold | Rules (at 309K diamonds) | Keyspace with nocap-plus | GPU Time |
|-----------|--------------------------|--------------------------|----------|
| 50+ | ~120 | ~1.7B | ~0.2s |
| 30+ | ~230 | ~3.3B | ~0.5s |
| 20+ | ~650 | ~9.4B | ~1.4s |
| 10+ | ~1,300 | ~18.7B | ~2.7s |

All thresholds are fast on BIGRED. Use 30+ for a good balance of coverage and noise filtering. As the corpus grows, lower the threshold.

## File Structure

The `# Deep analysis` comment is the preservation marker. DiamondFeedback.ts:
- **Overwrites** everything ABOVE the marker (auto-generated rules from latest batch)
- **Preserves** everything FROM the marker onward (deep-analysis rules)

```
# Auto-generated header (rewritten each batch)
c
l
u
$1
...

# Deep analysis Gen2 batches 0001-0011: ...    ← PRESERVED FROM HERE
# Rules: 230 | Keyspace: ...
^1
^8
...
```

## History

| Date | Corpus | Rules | Threshold | Notes |
|------|--------|-------|-----------|-------|
| 2026-02-14 | 371K (Gen1, 14 batches) | 174 | ~30 | First deep analysis, lost in DiamondFeedback overwrite |
| 2026-02-24 | 309K (Gen2, 11 batches) | 230 | 30 | Regenerated from Gen2 corpus |
