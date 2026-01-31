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

Rockyou was leaked in **December 2009** (MD5: `9076652d8ae75ce713e23ab09e10d9ee`, 14,344,391 lines).

**Key Insight:** Rockyou's user base was predominantly **Millennials** (ages 13-28 in 2009), the prime demographic for a social gaming widget site. GenZ was literally too young to have accounts.

### Evidence-Based Coverage Analysis

| Generation | Birth Years | Age in 2009 | Cultural Refs | Evidence | Rockyou Coverage |
|------------|-------------|-------------|---------------|----------|------------------|
| **Boomers** | 1946-1964 | 45-63 | elvis(1019), beatles(158), woodstock(75) | 49,821 birth year refs | ⚠ Moderate |
| **GenX** | 1965-1980 | 29-44 | nirvana(442), metallica(356), nintendo(206) | 102,957 birth year refs | ✓ Good |
| **Millennials** | 1981-1996 | 13-28 | eminem(1117), pokemon(745), myspace(1040) | 291,242 birth year refs | ✓ **Excellent** |
| **GenZ** | 1997-2012 | 0-12 | minecraft(0), fortnite(0), instagram(0) | Too young for accounts | ✗ **Critical Gap** |
| **GenAlpha** | 2013+ | N/A | N/A | Did not exist | ✗ None |

### False Positives: Terms IN Rockyou with Pre-2009 Meanings

Many "modern" terms exist in rockyou but with their **original meanings**:

| Term | Rockyou Count | Pre-2009 Meaning | NOT About |
|------|---------------|------------------|-----------|
| `discord` | 22 | English word (disagreement) | Discord app (2015) |
| `thanos` | 44 | Greek name (Θάνος) | MCU villain (2018) |
| `tiktok` | 18 | Ke$ha song (Aug 2009), clock sound | TikTok app (2016) |
| `zoom` | 679 | English verb (move fast) | Zoom app (2011) |
| `netflix` | 15 | DVD rental service (1997) | Streaming era |
| `wakanda` | 1 | Marvel comics (1966) | Black Panther movie (2018) |
| `mandalorian` | 1 | Star Wars EU lore | Disney+ show (2019) |
| `savage` | 1 | English word (fierce) | Modern slang |
| `goat` | 1 | The animal | "Greatest Of All Time" slang |

### What's ACTUALLY Missing from Rockyou

| Category | Confirmed Missing (0 exact matches) |
|----------|-------------------------------------|
| **Gaming (2010+)** | minecraft, fortnite, valorant, genshin, overwatch, pubg, leagueoflegends |
| **Platforms (2010+)** | instagram, snapchat, whatsapp, spotify (US) |
| **Streaming/Content** | pewdiepie, mrbeast, twitch (as platform) |
| **2010s+ Movies** | grogu, squidgame (wakanda/mandalorian existed in comics/EU) |
| **GenZ Slang** | goated, nocap, frfr, sus, simp (as slang, not words) |
| **Crypto** | bitcoin, ethereum, hodl, nft, metaverse |

### Year Suffix Coverage Gap

Rockyou has strong coverage for years 2005-2009 but drops off sharply after:

| Year Suffix | Count | Coverage |
|-------------|-------|----------|
| 2007 | 26,181 | Excellent |
| 2008 | 21,387 | Excellent |
| 2009 | 10,176 | Good |
| 2015 | 749 | **Low** |
| 2020 | 2,173 | Moderate (mostly patterns like "202020") |
| 2024 | 615 | **Low** |

**GenZ.rule addresses this gap** by adding year suffix rules for 2015-2025.

### Supplementary Attack Files

| File | Purpose | Size |
|------|---------|------|
| `data/rizzyou.txt` | **Verified** GenZ roots (0 in rockyou, 1K+ in HIBP) | 203 words |
| `data/GenZ.rule` | Modern password patterns (year suffixes 2015-2025) | ~150 rules |
| `nocap.txt` | rockyou.txt + rizzyou.txt combined (output) | ~14.3M words |

**Nomenclature:**
- **rizzyou.txt** - GenZ supplement wordlist (rizz + rockyou)
- **nocap.txt** - The updated rockyou replacement (no cap = truth)

### Top 10 rizzyou.txt Terms by HIBP Breach Count

| Rank | Term | Breaches | Category |
|------|------|----------|----------|
| 1 | minecraft | 1,799,404 | Gaming |
| 2 | onedirection | 545,456 | Music |
| 3 | fortnite | 529,408 | Gaming |
| 4 | jungkook | 182,037 | K-pop |
| 5 | harrystyles | 130,571 | Music |
| 6 | pewdiepie | 129,445 | Streamers |
| 7 | blackpink | 89,507 | K-pop |
| 8 | skyrim | 79,995 | Gaming |
| 9 | instagram | 79,288 | Social |
| 10 | arianagrande | 59,088 | Music |

**Key Insight:** Music (boy bands, pop artists) and K-pop dominate breach appearances, suggesting strong fandom-based password patterns.

### Recommended Attack Strategy for Recent Hashes

```bash
# Phase 1: Standard (existing)
rockyou.txt + OneRuleToRuleThemStill.rule

# Phase 2: New roots, proven rules
rizzyou.txt + OneRuleToRuleThemStill.rule

# Phase 3: Old words, new patterns
rockyou.txt + GenZ.rule

# Phase 4: New roots, new patterns
rizzyou.txt + GenZ.rule

# Phase 5: Combined list (nocap.txt = rockyou + rizzyou)
cat rockyou.txt rizzyou.txt | sort -u > nocap.txt
nocap.txt + OneRuleToRuleThemStill.rule
```

### Key GenZ Password Patterns (Validated)

1. **Modern year suffixes**: `2015`-`2025` (low coverage in rockyou)
2. **Account creation years**: `2020`, `2021`, `2022`, `2023`, `2024` as suffixes
3. **Emphasis stretching**: `yesss`, `nooo`, `bruhhhh`
4. **All lowercase + numbers**: `fortnite123`, `minecraft420`
5. **Text emoticons**: `:)`, `<3`, `:3`, `uwu`, `owo`
6. **Slang as password**: `goated`, `bussin`, `nocap`, `frfr` (zero matches in rockyou)

## Full Documentation

- Architecture: `Architecture.md`
- Cracking Pipeline: `Workflows/CrackingPipeline.md`
- Generational Analysis: See above + `data/GenZ.rule` comments
- Setup: `SETUP.md`
