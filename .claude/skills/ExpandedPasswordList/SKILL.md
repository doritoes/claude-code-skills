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
                │
                ├──► PEARLS   →  Stage 1 cracked (rockyou+OneRule)
                │
                └──► SAND     →  Stage 1 uncracked (hard passwords)
                                  │
                                  ├──► DIAMONDS  →  Stage 2+ cracked (escalating attacks)
                                  │
                                  └──► GLASS     →  Uncrackable (requires HIBP cleartext/rainbow)

UNOBTAINIUM →  Enhanced rule derived from PEARLS+DIAMONDS analysis
```

**Per-batch invariants:**
- `GRAVEL[N] = PEARLS[N] + SAND[N]`
- `SAND[N] = DIAMONDS[N] + GLASS[N]`

## Value Proposition

1. **PEARLS** - Real breach passwords NOT in rockyou (expanded wordlist)
2. **SAND** - Audit-worthy hashes that survive aggressive cracking
3. **HIBP Frequency** - Passwords sorted by occurrence count (most breached first)
4. **Self-maintaining** - Pipeline can be re-run as HIBP updates
5. **Feedback loop** - Cracked passwords enhance future attacks

## Workflow Routing

| Trigger | Workflow |
|---------|----------|
| "monitor pipeline", "check health", "pipeline status" | `bun Tools/PipelineMonitor.ts` |
| "archive batch", "archive task", "safe archive" | `bun Tools/SafeArchiver.ts --check` |
| "submit batch", "start cracking" | `bun Tools/CrackSubmitter.ts --batch N` |
| "download HIBP", "fetch ROCKS" | `Workflows/Download.md` |
| "filter rockyou", "create GRAVEL" | `Workflows/Filter.md` |
| "initial crack", "rockyou+rule" | `Workflows/Crack.md` |
| "crack SAND", "systematic attack" | `Workflows/CrackingPipeline.md` |
| "collect PEARLS", "get cracked" | `Workflows/Collect.md` |
| "publish passwords", "push to github" | `Workflows/Publish.md` |
| "create GLASS", "build UNOBTAINIUM", "optimize rules" | `Workflows/Optimize.md` |

## Quick Commands

```bash
# ============================================================================
# MONITORING & OPERATIONS (Use these FIRST for ongoing batches)
# ============================================================================

# Comprehensive pipeline health check (PREFERRED - reduces manual SQL)
bun Tools/PipelineMonitor.ts              # Full health checks (20s wait for chunk check)
bun Tools/PipelineMonitor.ts --quick      # Quick status only
bun Tools/PipelineMonitor.ts --fix        # Auto-fix simple issues
bun Tools/PipelineMonitor.ts --watch      # Continuous monitoring (60s interval)

# Safe task archiving with full validation
bun Tools/SafeArchiver.ts --check batch-0020     # Check batch before archiving
bun Tools/SafeArchiver.ts --batch batch-0020 --dry-run  # Preview archive
bun Tools/SafeArchiver.ts --batch batch-0020     # Archive batch
bun Tools/SafeArchiver.ts --task 150             # Archive single task

# ============================================================================
# BATCH SUBMISSION
# ============================================================================

# Submit new batches for cracking
bun Tools/CrackSubmitter.ts --batch 17 --workers 8   # Submit batch 17 with 8 workers
bun Tools/CrackSubmitter.ts --batch 17 --workers 8 --priority 90  # Override priority

# ============================================================================
# INITIAL SETUP (Run once)
# ============================================================================

# Download HIBP (ROCKS) - batched storage recommended
bun Tools/HibpDownloader.ts --batched --parallel 10

# Filter to GRAVEL (preserves HIBP occurrence counts)
bun Tools/SetDifference.ts --batched --compress

# ============================================================================
# RESULTS
# ============================================================================

# Collect results
bun Tools/ResultCollector.ts

# Prioritize PEARLS by HIBP frequency (most breached first)
bun Tools/PearlPrioritizer.ts          # Full prioritized list
bun Tools/PearlPrioritizer.ts --top 10000   # Top 10K most common
bun Tools/PearlPrioritizer.ts --analyze     # Count distribution
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

## Generational Password Analysis

### The Rockyou Time Capsule Problem

Rockyou was leaked in **December 2009**, creating a 15+ year blind spot for modern passwords.

| Generation | Birth Years | Password Creation | Rockyou Coverage |
|------------|-------------|-------------------|------------------|
| **Boomers** | 1946-1964 | 1990s-2000s | ✓ Good |
| **GenX** | 1965-1980 | 1990s-2000s | ✓ Good |
| **Millennials** | 1981-1996 | 2000s-2010s | ⚠ Partial |
| **GenZ** | 1997-2012 | 2010s-2020s | ✗ **Critical Gap** |
| **GenAlpha** | 2013+ | 2020s+ | ✗ None |

### What's Missing from Rockyou

| Category | Examples NOT in Rockyou |
|----------|------------------------|
| **Gaming (2010+)** | minecraft, fortnite, roblox, valorant, genshin, amongus |
| **Streaming** | netflix, tiktok, twitch, discord, spotify |
| **2010s Movies** | thanos, endgame, wakanda, mandalorian, grogu, squidgame |
| **2010s Music** | billie eilish, bts, olivia rodrigo, doja cat |
| **GenZ Slang** | yeet, bussin, slay, goated, nocap, frfr, deadass |
| **Memes** | stonks, poggers, based, ratio, sheesh |
| **Crypto/Tech** | bitcoin, ethereum, hodl, nft, metaverse |
| **COVID Era** | quarantine, lockdown, zoom, vaccine |

### Supplementary Attack Files

| File | Purpose | Size |
|------|---------|------|
| `data/GenZ.rule` | Modern password patterns (year suffixes, emphasis, symbols) | ~150 rules |
| `data/genz-wordlist.txt` | Cultural references missing from rockyou | ~1,400 words |

### Recommended Attack Strategy for Recent Hashes

```bash
# Phase 1: Standard (existing)
rockyou.txt + OneRuleToRuleThemAll.rule

# Phase 2: New words, proven rules
genz-wordlist.txt + OneRuleToRuleThemAll.rule

# Phase 3: Old words, new patterns
rockyou.txt + GenZ.rule

# Phase 4: New words, new patterns
genz-wordlist.txt + GenZ.rule
```

### Key GenZ Password Patterns

1. **Modern year suffixes**: `2020`, `2021`, `2022`, `2023`, `2024`, `2025`
2. **Birth years**: `1997`-`2012` (GenZ birth range)
3. **Emphasis stretching**: `yesss`, `nooo`, `bruhhhh`
4. **All lowercase + numbers**: `fortnite123`, `minecraft420`
5. **Text emoticons**: `:)`, `<3`, `:3`, `uwu`, `owo`
6. **Slang suffixes**: `-z` plurals (boyz), dropped `g` (vibin)

## Full Documentation

- Architecture: `Architecture.md`
- Cracking Pipeline: `Workflows/CrackingPipeline.md`
- Generational Analysis: See above + `data/GenZ.rule` comments
- Setup: `SETUP.md`
