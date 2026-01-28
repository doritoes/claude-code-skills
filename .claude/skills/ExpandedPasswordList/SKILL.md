---
name: ExpandedPasswordList
description: Generate expanded password wordlists from HIBP Pwned Passwords. USE WHEN expanded wordlist, HIBP passwords, breach passwords, supplement rockyou.
---

# ExpandedPasswordList

Automated pipeline to extract real breach passwords from HIBP Pwned Passwords that supplement rockyou.txt.

## Nomenclature

```
ROCKS       →  Full HIBP Pwned Passwords (~1B SHA-1 hashes)
GRAVEL      →  ROCKS minus rockyou.txt matches (~985M hashes)
SAND        →  GRAVEL minus rockyou+OneRule cracked (hard passwords)
PEARLS      →  Cracked cleartext passwords (valuable output)
GLASS       →  Base words extracted from PEARLS (future: optimized wordlist)
UNOBTAINIUM →  Enhanced rule derived from PEARLS analysis (future: improved rule)
```

## Value Proposition

1. **PEARLS** - Real breach passwords NOT in rockyou (expanded wordlist)
2. **SAND** - Audit-worthy hashes that survive aggressive cracking
3. **HIBP Frequency** - Passwords sorted by occurrence count (most breached first)
4. **Self-maintaining** - Pipeline can be re-run as HIBP updates
5. **Feedback loop** - Cracked passwords enhance future attacks

## Workflow Routing

| Trigger | Workflow |
|---------|----------|
| "download HIBP", "fetch ROCKS" | `Workflows/Download.md` |
| "filter rockyou", "create GRAVEL" | `Workflows/Filter.md` |
| "initial crack", "rockyou+rule" | `Workflows/Crack.md` |
| "crack SAND", "systematic attack" | `Workflows/CrackingPipeline.md` |
| "collect PEARLS", "get cracked" | `Workflows/Collect.md` |
| "publish passwords", "push to github" | `Workflows/Publish.md` |
| "pipeline status", "check progress" | `Workflows/Status.md` |
| "create GLASS", "build UNOBTAINIUM", "optimize rules" | `Workflows/Optimize.md` |

## Quick Commands

```bash
# Download HIBP (ROCKS) - batched storage recommended
bun Tools/HibpDownloader.ts --batched --parallel 10

# Filter to GRAVEL (preserves HIBP occurrence counts)
bun Tools/SetDifference.ts --batched --compress

# Initial crack (GRAVEL → SAND + PEARLS)
bun Tools/CrackSubmitter.ts --all --workers 10

# Systematic SAND cracking
bun Tools/SandCracker.ts --list        # Show attack phases
bun Tools/SandCracker.ts --all         # Run all phases
bun Tools/SandCracker.ts --status      # Check progress

# Collect results
bun Tools/ResultCollector.ts

# Prioritize PEARLS by HIBP frequency (most breached first)
bun Tools/PearlPrioritizer.ts          # Full prioritized list
bun Tools/PearlPrioritizer.ts --top 10000   # Top 10K most common
bun Tools/PearlPrioritizer.ts --analyze     # Count distribution

# Future: Optimization pipeline (GLASS + UNOBTAINIUM)
bun Tools/GlassExtractor.ts            # Extract base words from PEARLS
bun Tools/RuleAnalyzer.ts              # Analyze OneRule effectiveness
bun Tools/UnobtainiumBuilder.ts        # Generate optimized rule file
bun Tools/BenchmarkRunner.ts           # Compare baseline vs enhanced
```

## Cracking Pipeline (SAND → PEARLS)

| Priority | Phase | Method | Est. Time |
|----------|-------|--------|-----------|
| 100 | Quick Wins | best64, common lists | 10-30 min |
| 80 | Rule Stack | dive, d3ad0ne, generated2 | 2-6 hours |
| 60 | Combinator | word+word combinations | 4-8 hours |
| 50 | Hybrid | dict+mask (password123) | 12-48 hours |
| 35 | Mask | common patterns | 2-7 days |
| 25 | PRINCE | probabilistic word combo | 3-10 days |
| 15 | Brute Force | 1-8 char exhaustive | weeks |

## Storage Requirements

| Data | Size |
|------|------|
| ROCKS (batched) | ~2GB |
| GRAVEL | ~35GB |
| SAND | ~25GB |
| PEARLS | ~1-5GB |
| **Total** | **~65GB** |

## Key Files

- State: `data/state.json`
- SAND state: `data/sand-state.json`
- rockyou SHA-1: `data/rockyou-sha1.bin`
- GRAVEL batches: `data/candidates/batch-*.txt`
- Counts index: `data/candidates/counts-index.txt` (HASH:COUNT)
- PEARLS: `data/results/cracked.txt`
- Prioritized: `data/results/pearls-prioritized.txt` (sorted by frequency)
- With counts: `data/results/pearls-with-counts.txt` (PASSWORD:COUNT)
- GLASS (future): `data/wordlists/glass.txt`
- UNOBTAINIUM (future): `data/rules/unobtainium.rule`

## Full Documentation

- Architecture: `Architecture.md`
- Cracking Pipeline: `Workflows/CrackingPipeline.md`
- Setup: `SETUP.md`
