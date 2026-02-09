---
name: ExpandedPasswordList
description: Generate expanded password wordlists from HIBP Pwned Passwords. USE WHEN expanded wordlist, HIBP passwords, breach passwords, supplement rockyou.
---

# ExpandedPasswordList

Research pipeline to study password cracking effectiveness and improve tools.

## Purpose & Vision

**Goal:** Improve password cracking rules, wordlists, and strategies by studying what current tools miss.

**Input:** HIBP Pwned Passwords (~1B SHA-1 hashes) - the best available sample of real-world passwords.

**Method:** Measure effectiveness of current tools (Hashtopolis, rockyou.txt, OneRuleToRuleThemStill), then analyze what survives to find improvement opportunities.

### Phased Approach

| Phase | Focus | Status |
|-------|-------|--------|
| **1. Skill Building** | Run pipeline on HIBP sample, learn patterns, refine strategies | Current |
| **2. Cleartext Acquisition** | Locate fresh dumps, rainbow tables, unmask methods | Future |
| **3. Full Analysis** | Complete HIBP cleartext corpus → next-level tool improvement | Goal |

### Constraints

- **Cannot brute force all HIBP** - Too expensive ($1.8M+ for 8-char on all batches)
- **Sample-based learning** - Brute force affordable batches to gain insight
- **Alternative paths** - Fresh cleartext dumps, rainbow tables, HIBP unmask methods

### What We Learn From Each Stage

| Output | Insight |
|--------|---------|
| **PEARLS** | Validates current tools work (rockyou + OneRule) |
| **SAND** | Reveals gaps in current approach |
| **DIAMONDS** | Shows what additional attacks find (improvement opportunities) |
| **GLASS** | Either truly random OR patterns we haven't figured out |

**Actionable analysis focuses on:**
- 12+ char DIAMONDS with word roots → enhance wordlists
- Suffix/prefix patterns → enhance rules
- 8-char random → learning exercise, not scalable to all HIBP

## ⛔ MANDATORY RULES (Read First - Non-Negotiable)

**These rules exist because Claude has repeatedly caused pipeline corruption by ignoring them.**

### 1. NEVER Bypass Tools
- **NO** direct SQL queries to modify data (SELECT is OK, UPDATE/DELETE is NOT)
- **NO** direct API calls (use SafeArchiver, not curl to archive endpoint)
- **NO** manual database manipulation of chunks, tasks, or assignments
- **IF A TOOL BLOCKS YOU**: The tool is right. You are wrong. Stop.

### 2. NEVER Change Configuration
- `useNewBench = 0` - This is IMMUTABLE. Do not detect dynamically. Do not change.
- If tasks have keyspace=0, WAIT for benchmark - do not "fix" by changing useNewBench
- See `data/CONFIG.md` for configuration source of truth

### 3. ALWAYS Run Pre-Flight Checks
```bash
# MANDATORY before ANY operation:
bun Tools/PipelineMonitor.ts --quick
```
- Do NOT submit batches if previous batches are stuck (keyspace=0)
- Do NOT archive without SafeArchiver validation
- Do NOT proceed if PipelineMonitor shows errors

### 4. ALWAYS Use Tools, Not Ad-Hoc Commands
| Action | CORRECT | WRONG |
|--------|---------|-------|
| Check health | `bun Tools/PipelineMonitor.ts` | Ad-hoc SQL queries |
| Archive batch | `bun Tools/SafeArchiver.ts --batch X` | Direct SQL UPDATE |
| Submit batch | `bun Tools/CrackSubmitter.ts --batch X` | Manual hashlist creation |
| Fix agents | `bun Tools/AgentManager.ts --fix` | Manual SSH/reboot |
| Unstick chunks | `bun Tools/SafeChunkAbort.ts --detect` | Direct SQL UPDATE Chunk |

### 5. When Uncertain, ASK - Do Not Guess
- If evidence is contradictory, ask the user
- If a tool blocks an action, ask the user
- Do NOT make "definitive" decisions based on spot-checking single database rows
- "STOP AD-LIBBING" means follow procedures exactly

### 6. Task Completion Criteria (CORRECT Definition)
- **WRONG**: `keyspaceProgress >= keyspace` (task can show 100% with running chunks)
- **RIGHT**: All chunks in state 4 (FINISHED) or 9 (TRIMMED), none in state 0/2/6

### 7. Historical Failures to Avoid
- Lesson #1: Archived batch-0001 at 0% progress
- Lesson #16: Manually set keyspace, broke 120+ tasks
- Lesson #21: Direct chunk manipulation, 12 tasks permanently stuck
- Lesson #37/46: Flip-flopped useNewBench, corrupted batches 95-100
- **Read `docs/LESSONS-LEARNED.md` before operating the pipeline**

---

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
                                  └──► GLASS     →  Uncrackable with current tools
                                       │
                                       └──► Future: cleartext dumps, rainbow tables, HIBP unmask

UNOBTAINIUM →  NEW rules derived from DIAMONDS (NOT in OneRule/nocap.rule)
BETA        →  NEW root words extracted from DIAMONDS (NOT in nocap.txt)
```

**Feedback Loop Files:**
- `unobtainium.rule` - Contains ONLY rules discovered from DIAMONDS that are NOT already in:
  - OneRuleToRuleThemStill.rule
  - nocap.rule

  **Purpose:** If unobtainium cracks are ~0, the baseline rules already cover the patterns.
  If unobtainium cracks are >0, we've found genuinely NEW patterns worth investigating!

- `BETA.txt` - Contains root words from DIAMONDS NOT in nocap.txt (rockyou+rizzyou)

**Per-batch invariants:**
- `GRAVEL[N] = PEARLS[N] + SAND[N]`
- `SAND[N] = DIAMONDS[N] + GLASS[N]`

**CRITICAL - Result Collection Tools:**
- **ResultCollector.ts** - Collects Stage 1 cracks (GRAVEL → PEARLS)
- **DiamondCollector.ts** - Collects Stage 2 cracks (SAND → DIAMONDS + GLASS)
- **NEVER mix these!** SAND cracks are DIAMONDS, not PEARLS!

## Value Proposition

1. **PEARLS** - Real breach passwords NOT in rockyou (expanded wordlist)
2. **SAND** - Audit-worthy hashes that survive aggressive cracking
3. **HIBP Frequency** - Passwords sorted by occurrence count (most breached first)
4. **Self-maintaining** - Pipeline can be re-run as HIBP updates
5. **Feedback loop** - Cracked passwords enhance future attacks

---

## Plaintext Password Sources (Phase 2 Preparation)

Alternative paths to unmask HIBP hashes without brute force. These sources can be deduplicated against GLASS to recover plaintext.

### Mega-Compilations (Plaintext)

| Source | Size | Description | Legitimacy | Access |
|--------|------|-------------|------------|--------|
| **RockYou2024** | 9.9B passwords | Largest compilation (July 2024). Adds 1.5B passwords from 2021-2024 to previous compilations. | Public leak | Torrents, forums |
| **16B Credential Leak** | 16B records | June 2025 mega-compilation from 30+ datasets, heavily sourced from infostealer malware logs. | Dark web origin | Forums, markets |
| **Collection #1-5** | 2.7B+ records | 2019 compilation by Troy Hunt. 773M unique emails, 21M unique passwords. | Public leak | Archive sites |
| **BreachCompilation** | 1.4B credentials | 2017 compilation of multiple breaches. | Public leak | Archive sites |

**Value:** Cross-reference SHA-1 hashes against these to unmask GLASS entries.

### Reliable Plaintext Sources (For Rule Development)

Curated wordlists already converted to plaintext by researchers. Best for pattern analysis and Hashcat rule generation.

| Dataset | Size | Description | Access |
|---------|------|-------------|--------|
| **RockYou.txt** | 14.3M | The "OG" list from 2009 RockYou breach. Perfect for learning basic patterns. | Included with Kali, widely available |
| **RockYou2021/2024** | 8B-10B | Massive compilations of various leaks. **Note:** Contains "garbage" data (non-passwords) - requires cleaning. | Torrents, forums |
| **Probable-Wordlists** | Various | Curated lists based on real-world leaks by berzerk0. Quality over quantity. | [GitHub](https://github.com/berzerk0/Probable-Wordlists) |
| **Weakpass** | Terabytes | Massive repository specifically for Hashcat and John the Ripper. | [weakpass.com](https://weakpass.com/) |
| **SecLists** | Various | Collection of security testing lists including passwords. | [GitHub](https://github.com/danielmiessler/SecLists) |
| **CrackStation Wordlist** | 1.5B | Human-only passwords (no random strings). | [crackstation.net](https://crackstation.net/crackstation-wordlist-password-cracking-dictionary.htm) |

**Quality Note:** RockYou2021/2024 mega-compilations contain significant noise:
- Random strings from password managers
- Hashes mistakenly included as passwords
- Corrupted/truncated entries
- Non-password data (URLs, emails, etc.)

**Recommendation:** Start with curated lists (Probable-Wordlists, CrackStation) for pattern analysis, use mega-compilations for coverage testing.

### Analysis Tools (Pattern Extraction)

Tools to reverse-engineer password patterns from plaintext lists and generate Hashcat rules.

| Tool | Purpose | Output | Access |
|------|---------|--------|--------|
| **PACK (statsgen)** | Password Analysis and Cracking Kit. Analyzes wordlists to find common masks. | Mask frequency (e.g., `?u?l?l?l?d?d?d?s`) | [GitHub](https://github.com/iphelix/pack) |
| **pcfg_cracker** | Probabilistic Context-Free Grammars. Learns the "grammar" of how users build passwords from specific datasets. | PCFG training data, grammar rules | [GitHub](https://github.com/lakiw/pcfg_cracker) |
| **Hashcat-Rules (T0XIC0DER)** | Pre-optimized rules for long passwords that Best64/OneRule miss. | Ready-to-use .rule files | [GitHub](https://github.com/T0XIC0DER/Hashcat-Rules) |
| **Pipal** | Password statistics analyzer. Generates reports on length, charset, patterns. | HTML/text reports | [GitHub](https://github.com/digininja/pipal) |
| **Mentalist** | GUI for building wordlists with custom rules and chains. | Wordlists, rule chains | [GitHub](https://github.com/sc0tfree/mentalist) |

**Workflow for Rule Development:**
```bash
# 1. Analyze DIAMONDS to find common masks
python statsgen.py diamonds-batch-0001.txt -o masks.txt

# 2. Train PCFG on cracked passwords
python pcfg_trainer.py --input diamonds-batch-0001.txt --output training/

# 3. Generate candidate rules from patterns
# Manual: Convert top masks to Hashcat rules
# Or use T0XIC0DER rules for long password coverage

# 4. Test new rules against GLASS
hashcat -m 100 glass.txt wordlist.txt -r new_rules.rule --potfile-disable
```

**Key Insight:** PACK's `statsgen` reveals which character class patterns dominate your cracked passwords. If 64% are `?l?l?l?l?l?l?d?d` (6 lower + 2 digits), that's a mask worth targeting.

### Long Passphrase Templates (12+ Characters)

Users creating long passphrases follow predictable linguistic/structural patterns. Target these with specific rules:

| Pattern | Example | Hashcat Strategy |
|---------|---------|------------------|
| **CamelCase Join** | `GreenAppleBlueSky` | Wordlist + Rule: `TN` (capitalize every word) |
| **Separator Swap** | `green-apple-blue-sky` | Wordlist + Rule: `s- ` (replace spaces with hyphens) |
| **NIST Special** | `GreenAppleBlueSky1!` | Wordlist + Rule: `$1 $!` (append digit + symbol) |
| **Title Strings** | `TheLastOfUs` | Scraped media lists (IMDb, Spotify, Wikipedia) |
| **Leetspeak Phrasing** | `gr33n4ppl3` | Combinator + Leet Rule |
| **Keyboard Walks** | `qwertyuiop123` | Keyboard walk wordlists |
| **Year Suffix** | `MyDogBuster2024` | Wordlist + Rule: `$2 $0 $2 $4` |

**Combinator Attack for Multi-Word:**
```bash
# Combine two wordlists to create phrases
hashcat -a 1 -m 100 hashes.txt words1.txt words2.txt

# With rules on each side
hashcat -a 1 -m 100 hashes.txt words1.txt words2.txt -j 'c' -k '$1'
# Left: capitalize, Right: append "1"
```

**Media/Pop Culture Wordlists:**
- IMDb movie/TV titles
- Spotify playlist names, song titles
- Video game titles (Steam, IGN lists)
- Sports teams, player names
- Book titles, character names

**Rule Examples for Passphrases:**
```
# CamelCase: capitalize each word boundary
TN

# Common separators
s -    # space to hyphen
s _    # space to underscore
s .    # space to period

# NIST suffix patterns (digit + symbol)
$1 $!
$1 $@
$2 $0 $2 $4 $!

# Leet substitutions
sa@ se3 si1 so0
```

**Key Insight:** 12+ char passwords in DIAMONDS show word roots (see BRUTE8-ANALYSIS.md). Focus rule development here, not on random 8-char strings.

### Rainbow Tables

| Source | Coverage | Hash Type | Size | Access |
|--------|----------|-----------|------|--------|
| **CrackStation** | 15B entries | MD5, SHA1 | 190GB | [crackstation.net](https://crackstation.net/) |
| **FreeRainbowTables** | Various | Multiple | Large | [freerainbowtables.com](https://freerainbowtables.com/) (offline) |
| **RainbowCrackalack** | 93% of 8-char NTLM | NTLM | - | [GitHub](https://github.com/jtesta/rainbowcrackalack) |
| **Project RainbowCrack** | Configurable | Multiple | Varies | [project-rainbowcrack.com](http://project-rainbowcrack.com/) |

**Limitation:** HIBP uses unsalted SHA-1, so rainbow tables ARE applicable (no salt defense).

### Hash Lookup Services (Online)

| Service | Database Size | API | Notes |
|---------|--------------|-----|-------|
| **CrackStation** | 190GB / 15B | Web only | Free, rate-limited |
| **Hashes.org** | Large | Web + API | Community-sourced |
| **NTLM.PW** | Focused | Web | NTLM-focused |
| **Weakpass** | Curated | API available | [weakpass.com](https://zzzteph.github.io/weakpass/) |

**Use case:** Batch lookup of high-value GLASS hashes before committing GPU time.

### Academic/Research Datasets

| Dataset | Size | Source | Access |
|---------|------|--------|--------|
| **70M Yahoo Corpus** | 70M passwords | Cambridge research | Academic request |
| **220M Multi-site Study** | 220M passwords | 12 leaked sites | Research papers |
| **1.4B TensorFlow Analysis** | 1.4B passwords | [GitHub](https://github.com/philipperemy/tensorflow-1.4-billion-password-analysis) | Public |
| **Pwdb-Public** | 1B+ credentials | [GitHub](https://github.com/ignis-sec/Pwdb-Public) | Public |

**Value:** Cleaned, deduplicated datasets for pattern analysis.

### HIBP Direct Access

| Method | Description | Effort |
|--------|-------------|--------|
| **K-Anonymity API** | Query by SHA-1 prefix, get all matching hashes + counts | Free, no key |
| **Bulk Download** | Download all 1B+ hashes via [hibp-downloader](https://github.com/threatpatrols/hibp-downloader) | ~35GB |
| **Pwned Passwords Downloader** | Official .NET tool from Troy Hunt | [GitHub](https://github.com/HaveIBeenPwned/PwnedPasswordsDownloader) |

**Note:** HIBP provides HASHES only, not plaintext. But occurrence counts help prioritize high-value targets.

### Deduplication Strategy

```
1. Download mega-compilation (RockYou2024, Collection#1-5)
2. Hash each plaintext password to SHA-1
3. Compare against GLASS hashes
4. Matches = unmasked passwords → add to DIAMONDS
5. Remaining GLASS = truly uncrackable or not in any leak
```

**Estimated coverage:** Mega-compilations may unmask 30-60% of GLASS depending on overlap.

### Ethical & Legal Considerations

| Consideration | Guidance |
|---------------|----------|
| **Data origin** | Compilations are from unauthorized breaches - handle appropriately |
| **Storage** | Store hashes, not plaintext where possible |
| **Sharing** | Do not redistribute raw breach data |
| **Purpose** | Security research, password strength analysis, tool improvement |
| **HIBP model** | Troy Hunt's approach: hashes only, k-anonymity, no PII exposure |

**This skill's purpose:** Improve cracking tools, not exploit credentials. Plaintext is intermediate data for rule/wordlist development, not an end product.

---

## Workflow Routing

**⚠️ ALWAYS run `bun Tools/PipelineMonitor.ts --quick` FIRST before any other operation.**

| Trigger | Workflow |
|---------|----------|
| **START OF SESSION** | `bun Tools/PipelineMonitor.ts --quick` (MANDATORY) |
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
| "power on", "warm start", "instances started" | `bun Tools/WarmStart.ts` |
| "agents down", "fix agents" | `Workflows/PostPowerOn.md` |
| "worker disk", "worker health", "clean workers" | `bun Tools/WorkerHealthCheck.ts` |
| "hashlist coverage", "multi-task coverage", "combined coverage" | `bun Tools/HashlistCoverageAnalyzer.ts` |
| "process sand", "sand attack plan", "escalating attacks" | `bun Tools/SandProcessor.ts` |
| "collect diamonds", "get sand cracks", "harvest diamonds" | `bun Tools/DiamondCollector.ts` |
| "feedback loop", "analyze diamonds", "improve next batch" | `bun Tools/DiamondFeedback.ts` |
| "extract patterns", "BETA words", "unobtainium" | `bun Tools/DiamondFeedback.ts` |
| "extract glass", "uncrackable hashes", "finalize batch" | `bun Tools/DiamondCollector.ts --glass` |
| "archive sand tasks", "archive completed", "sand archiver" | `bun Tools/SandArchiver.ts` |
| "glass attacks", "untried attacks", "what attacks for glass" | `bun Tools/SandProcessor.ts --glass <batch>` |
| "attack history", "which attacks tried" | `bun Tools/SandProcessor.ts --history <batch>` |

## Quick Commands

```bash
# ============================================================================
# ⛔ MANDATORY PRE-FLIGHT (Run this FIRST - EVERY session, EVERY time)
# ============================================================================

bun Tools/WarmStart.ts                    # Run after AWS instances power on (updates IPs)
bun Tools/WarmStart.ts --check            # Check if warm start is needed
bun Tools/PipelineMonitor.ts --quick      # Check pipeline state before ANY operation
# If this shows errors: STOP and fix them before proceeding
# If tasks have keyspace=0: WAIT - do not "fix" them

# ============================================================================
# MONITORING & OPERATIONS (Use these FIRST for ongoing batches)
# ============================================================================

# Comprehensive pipeline health check (PREFERRED - reduces manual SQL)
bun Tools/PipelineMonitor.ts              # Full health checks (20s wait for chunk check)
bun Tools/PipelineMonitor.ts --quick      # Quick status only
bun Tools/PipelineMonitor.ts --fix        # Auto-fix simple issues (ONLY priority alignment)
bun Tools/PipelineMonitor.ts --watch      # Continuous monitoring (30s interval)

# Safe task archiving with full validation
bun Tools/SafeArchiver.ts --check batch-0020     # Check batch before archiving
bun Tools/SafeArchiver.ts --batch batch-0020 --dry-run  # Preview archive
bun Tools/SafeArchiver.ts --batch batch-0020     # Archive batch
bun Tools/SafeArchiver.ts --task 150             # Archive single task

# Safe chunk abort (for stuck chunks with crackPos errors)
bun Tools/SafeChunkAbort.ts --detect             # Find stuck chunks (dry-run)
bun Tools/SafeChunkAbort.ts --detect --abort     # Resolve stuck chunks (agent restart + fallback)
bun Tools/SafeChunkAbort.ts --chunk 2399 --abort # Resolve specific chunk
bun Tools/SafeChunkAbort.ts --chunk 2399 --abort --direct  # Direct abort (skip agent restart)

# Worker disk health monitoring (gets fresh IPs from AWS CLI)
bun Tools/WorkerHealthCheck.ts                   # Show all worker disk health
bun Tools/WorkerHealthCheck.ts --clean --dry-run # Preview cleanup
bun Tools/WorkerHealthCheck.ts --clean           # Clean workers >70% disk
bun Tools/WorkerHealthCheck.ts --clean --all     # Clean ALL workers

# Hashlist coverage analysis (multiple tasks on same hashlist)
bun Tools/HashlistCoverageAnalyzer.ts --tasks 1207,1208,1209  # Analyze specific tasks
bun Tools/HashlistCoverageAnalyzer.ts --batch batch-0125      # Analyze batch by pattern
bun Tools/HashlistCoverageAnalyzer.ts --tasks 1207,1208 --archive --dry-run  # Preview archive
bun Tools/HashlistCoverageAnalyzer.ts --batch batch-0125 --archive  # Archive complete groups

# ============================================================================
# BATCH SUBMISSION (Stage 1: GRAVEL → PEARLS + SAND)
# ============================================================================

# Submit new batches for cracking
bun Tools/CrackSubmitter.ts --batch 17 --workers 8   # Submit batch 17 with 8 workers
bun Tools/CrackSubmitter.ts --batch 17 --workers 8 --priority 90  # Override priority

# ============================================================================
# SAND PROCESSING (Stage 2: SAND → DIAMONDS + GLASS)
# ============================================================================

# Process SAND batches with escalating attacks
bun Tools/SandProcessor.ts --batch 1                 # Process SAND batch 1 (all attacks)
bun Tools/SandProcessor.ts --batch 1 --attack rule-dive  # Run specific attack only
bun Tools/SandProcessor.ts --batch 1 --dry-run       # Preview without submitting
bun Tools/SandProcessor.ts --status                  # Show processing status
bun Tools/SandProcessor.ts --history 1               # Show attack history for batch
bun Tools/SandProcessor.ts --analyze                 # Analyze attack effectiveness
bun Tools/SandProcessor.ts --attacks                 # List all available attacks
bun Tools/SandProcessor.ts --list                    # List available SAND batches

# SAND state management
bun Tools/SandStateManager.ts                        # Show SAND processing state
bun Tools/SandStateManager.ts --stats                # Show attack statistics
bun Tools/SandStateManager.ts --reorder              # Reorder attacks by effectiveness
bun Tools/SandStateManager.ts --reset                # Reset SAND state (careful!)

# Collect DIAMONDS (Stage 2 cracks from SAND)
bun Tools/DiamondCollector.ts                        # Collect DIAMONDS from all batches
bun Tools/DiamondCollector.ts --batch batch-0001     # Collect specific batch
bun Tools/DiamondCollector.ts --glass                # Also extract GLASS if complete
bun Tools/DiamondCollector.ts --status               # Show collection status

# Feedback Loop (analyze DIAMONDS → improve next batch)
bun Tools/DiamondFeedback.ts                         # Analyze all DIAMONDS
bun Tools/DiamondFeedback.ts --batch batch-0001      # Analyze specific batch
bun Tools/DiamondFeedback.ts --upload                # Upload feedback to Hashtopolis
bun Tools/DiamondFeedback.ts --dry-run               # Preview without writing

# Archive completed SAND tasks (updates state + collects DIAMONDS)
bun Tools/SandArchiver.ts                            # Archive all completed tasks
bun Tools/SandArchiver.ts --batch batch-0001         # Archive specific batch
bun Tools/SandArchiver.ts --dry-run                  # Preview without archiving
bun Tools/SandArchiver.ts --no-collect               # Skip DiamondCollector

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

## SAND Processing Feedback Loop

The SAND processing pipeline includes a feedback loop that improves crack rates over time:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        SAND PROCESSING FEEDBACK LOOP                     │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  SAND batch-0001 ─────► SandProcessor ─────► Hashtopolis Tasks           │
│        │                                            │                    │
│        │                                            ▼                    │
│        │                                     Workers crack               │
│        │                                            │                    │
│        │         ┌──────────────────────────────────┘                    │
│        │         ▼                                                       │
│        │    DiamondCollector ─────► DIAMONDS (cracked passwords)         │
│        │                                  │                              │
│        │                                  ▼                              │
│        │                         DiamondFeedback                         │
│        │                                  │                              │
│        │              ┌───────────────────┴───────────────────┐          │
│        │              ▼                                       ▼          │
│        │         BETA.txt                            unobtainium.rule    │
│        │      (new roots)                           (new patterns)       │
│        │              │                                       │          │
│        │              └───────────────────┬───────────────────┘          │
│        │                                  ▼                              │
│        │                         Upload to Hashtopolis                   │
│        │                                  │                              │
│        │                                  ▼                              │
│        └──────────────────────►  SAND batch-0002 (uses feedback!)        │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

## ⚠️ SAND State Maintenance (CRITICAL)

**The sand-state.json is maintained across THREE tools - you MUST use all of them:**

| Step | Tool | State Updates | When to Run |
|------|------|---------------|-------------|
| 1 | `SandProcessor` | `initBatch`, `startAttack` | When submitting new attacks |
| 2 | `DiamondCollector` | `updateCracked`, `completeBatch` | After attacks finish, to harvest results |
| 3 | `SandArchiver` | `completeAttack` | After collecting, to archive and update stats |

**⛔ SandProcessor alone does NOT complete the state!** You must run the full cycle:

```bash
# COMPLETE SAND PROCESSING CYCLE (all 3 steps required!)

# Step 1: Submit attacks (updates: initBatch, startAttack)
bun Tools/SandProcessor.ts --batch 5

# ... wait for Hashtopolis workers to finish ...

# Step 2: Collect DIAMONDS (updates: updateCracked, completeBatch)
bun Tools/DiamondCollector.ts --batch batch-0005

# Step 3: Archive completed tasks (updates: completeAttack, attack stats)
bun Tools/SandArchiver.ts --batch batch-0005
```

**If you skip steps 2-3:**
- `sand-state.json` will show attacks as "in_progress" forever
- Cracked counts will be wrong
- Attack statistics won't be recorded for optimization

**Workflow Commands:**
```bash
# 1. Submit SAND batch for cracking
bun Tools/SandProcessor.ts --batch 1

# 2. Periodically collect DIAMONDS (while attacks run)
bun Tools/DiamondCollector.ts --batch batch-0001

# 3. Archive completed tasks (updates state with completion stats)
bun Tools/SandArchiver.ts --batch batch-0001

# 4. Analyze DIAMONDS and generate feedback
bun Tools/DiamondFeedback.ts --batch batch-0001

# 5. Upload feedback files to Hashtopolis
bun Tools/DiamondFeedback.ts --upload

# 6. Register files in Hashtopolis UI and update SandProcessor file IDs

# 7. Next batch automatically uses feedback attacks!
bun Tools/SandProcessor.ts --batch 2
```

**Feedback Files:**
- `data/feedback/BETA.txt` - New root words not in baseline wordlists
- `data/feedback/unobtainium.rule` - Rules extracted from cracked patterns
- `data/feedback/feedback-report.json` - Analysis report

### How Feedback Uniqueness is Verified

**For BETA.txt (new root words):**

1. Extract root from each cracked password by stripping:
   - Trailing digits (`password123` → `password`)
   - Trailing specials (`password!@#` → `password`)
   - Leading digits (`123password` → `password`)
   - Convert to lowercase

2. Load baseline wordlist roots (nocap.txt preferred, rockyou.txt fallback):
   - Apply same root extraction to baseline
   - Store in Set for O(1) lookup

3. Filter DIAMOND roots:
   - Only include roots that appear 2+ times (configurable via `--min-freq`)
   - Only include roots NOT in baseline Set
   - Result = genuinely NEW roots discovered from SAND cracking

**For unobtainium.rule (new patterns):**

Rules are generated from observed patterns, NOT from checking uniqueness against existing rules:
- Detect patterns: suffixes, prefixes, leetspeak, case transformations
- Generate hashcat rules from frequently-observed patterns (5+ occurrences)
- Extract actual suffix values from data (top 100 most common)
- Add year suffix rules for 2015-2026

The rule file complements (not replaces) existing rules like OneRuleToRuleThemStill.

**Baseline Wordlist Location:**
```
data/nocap.txt   (preferred - rockyou + rizzyou combined)
data/rockyou.txt (fallback)
```

If no baseline exists, the tool warns and all roots appear as "new" - which defeats the purpose. Ensure a baseline wordlist is present before running feedback analysis.

## Cracking Pipeline (SAND → DIAMONDS + GLASS)

| Priority | Phase | Method | Est. Time |
|----------|-------|--------|-----------|
| 100 | Quick Wins | best64, common lists | 10-30 min |
| 80 | Rule Stack | dive, d3ad0ne, generated2 | 2-6 hours |
| 60 | Combinator | word+word combinations | 4-8 hours |
| 50 | Hybrid | dict+mask (password123) | 12-48 hours |
| 35 | Mask | common patterns | 2-7 days |
| 25 | PRINCE | probabilistic word combo | 3-10 days |
| 15 | Brute Force | 1-7 char exhaustive | days |

### Brute Force Notes

**Separate tasks per length (NOT --increment):**
- Hashtopolis cannot calculate keyspace for `--increment` flag masks
- Use separate brute-1, brute-2, brute-3, ..., brute-7 attacks instead
- Each attack has fixed keyspace that workers can benchmark

**brute-8 excluded from standard pipeline:**
- 8-character brute force takes ~51 hours per batch
- Too expensive for routine processing
- Use `QuickAttack.ts` for one-off experiments on specific batches

### Task ETA Calculation

**Use remaining keyspace for ETA, NOT chunk count.** Hashtopolis creates chunks dynamically so active chunk count is always ~equal to worker count. Counting active chunks gives a wrong ETA.

**⚠️ NEVER declare a task complete based on keyspaceProgress alone.**
`keyspaceProgress = keyspace` means all work is DISPATCHED, not FINISHED.
Always check chunk states before declaring completion.

```sql
-- CORRECT: ETA from remaining keyspace
SELECT
  t.keyspaceProgress,
  t.keyspace,
  t.keyspace - t.keyspaceProgress as remaining,
  ROUND((UNIX_TIMESTAMP() - MIN(c.dispatchTime)) / 3600, 2) as hours_elapsed
FROM Task t JOIN Chunk c ON c.taskId = t.taskId
WHERE t.taskId = <TASK_ID>;

-- Then calculate:
-- rate = keyspaceProgress / hours_elapsed
-- eta_hours = remaining / rate

-- COMPLETION CHECK: Task is ONLY done when ALL chunks are finished
SELECT
  SUM(CASE WHEN state IN (4,9) THEN 1 ELSE 0 END) as finished,
  SUM(CASE WHEN state = 2 THEN 1 ELSE 0 END) as still_running,
  COUNT(*) as total
FROM Chunk WHERE taskId = <TASK_ID>;
-- Task is complete ONLY when still_running = 0
```

**WRONG:**
- `remaining_chunks / chunks_per_hour` (chunks are created on the fly, active count is always ~8)
- `keyspaceProgress = keyspace` → "task is done" (dispatched ≠ finished)

## Storage Requirements

| Data | Size |
|------|------|
| ROCKS (batched) | ~2GB |
| GRAVEL | ~35GB |
| SAND | ~25GB |
| PEARLS | ~1-5GB |
| **Total** | **~65GB** |

## Data Directory Configuration

The skill uses a **network share** for large data files. The `data` directory is a symlink to the network share:

```
.claude/skills/ExpandedPasswordList/data -> \\192.168.99.252\files\Passwords\ExpandedPasswordList\data
```

**How it works:**
1. `data/` is a Windows directory symlink to the network share
2. All tools import paths from `Tools/config.ts` (DATA_DIR, SAND_DIR, etc.)
3. Tools access `data/sand/`, `data/diamonds/`, etc. directly through the symlink

**Config resolution order:**
1. `EPL_DATA_PATH` environment variable (if set)
2. `data` directory/symlink (preferred)
3. `data` file containing a path (legacy fallback)

**To set up on a new machine (run as Administrator):**
```powershell
cmd /c mklink /D "C:\Users\sethh\AI-Projects\.claude\skills\ExpandedPasswordList\data" "\\your-server\share\path\to\data"
```

## Key Files

- **CONFIG (IMMUTABLE)**: `data/CONFIG.md` - useNewBench and other settings (NEVER CHANGE)
- State: `data/state.json`
- SAND state: `data/sand-state.json`
- rockyou SHA-1: `data/rockyou-sha1.bin`
- GRAVEL batches: `data/candidates/batch-*.txt`
- Counts index: `data/candidates/counts-index.txt` (HASH:COUNT)
- PEARLS: `data/results/cracked.txt`
- Prioritized: `data/results/pearls-prioritized.txt` (sorted by frequency)
- With counts: `data/results/pearls-with-counts.txt` (PASSWORD:COUNT)
- SAND batches: `data/sand/batch-*.txt.gz` (uncracked from Stage 1)
- DIAMONDS: `data/diamonds/batch-*.txt` (Stage 2+ cracked)
- GLASS: `data/glass/batch-*.txt` (uncrackable hashes)
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

- **Configuration (READ FIRST)**: `data/CONFIG.md` - Immutable settings (useNewBench=0)
- **Lessons Learned (READ SECOND)**: `docs/LESSONS-LEARNED.md` - 49 critical lessons from failures
- **Cohort Analysis**: `docs/COHORT-ANALYSIS.md` - Predicting unseen password roots by cohort
- Architecture: `Architecture.md`
- Cracking Pipeline: `Workflows/CrackingPipeline.md`
- Generational Analysis: See above + `data/GenZ.rule` comments
- Setup: `SETUP.md`
- Permissions: `docs/PERMISSIONS.md` (reduce manual approvals)
- Post-Power-On: `Workflows/PostPowerOn.md` (agent recovery after VM restart)

## Cohort Discovery Strategy

**Key Insight:** Brute force attacks reveal COHORTS, not just individual passwords.

When we crack `oguz1234`, we're not just finding one password - we're discovering that **Turkish names** are a cohort missing from our wordlists. This predicts THOUSANDS of unseen passwords.

### Discovered Cohorts (Feb 2026)

| Cohort | Evidence | Est. Gap | Priority |
|--------|----------|----------|----------|
| Indian names | abhi, anuj, anup, arif, ashu | 2000-5000 | HIGH |
| Turkish names | oguz, elif, yekta | 500-2000 | HIGH |
| Arabic names | umer, ehab, afroz | 1000-3000 | MEDIUM |
| Slavic diminutives | olia, maks | 500-1500 | MEDIUM |
| Chinese Pinyin | xiao, zhou | 1000-3000 | MEDIUM |

**See `docs/COHORT-ANALYSIS.md` for full analysis and recommended wordlists.**

## Reducing Manual Intervention

Pre-approve these bash prompt patterns in Claude Code settings for autonomous operation:

1. **"Run ExpandedPasswordList tools"** - CrackSubmitter, AgentManager, PipelineMonitor, SafeArchiver
2. **"Check Hashtopolis server status"** - SSH read-only database queries
3. **"Get terraform outputs"** - server_ip, db_password
4. **"Check AWS EC2 instance status"** - describe-instances queries
5. **"SSH to workers for agent management"** - systemctl, journalctl, lock.pid removal

See `docs/PERMISSIONS.md` for full details and configuration examples.
