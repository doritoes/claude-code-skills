# SAND Cracking Pipeline

**Status:** Ready to Execute (after Filter completes)

Complete workflow for cracking GRAVEL hashes using rockyou + OneRuleToRuleThemStill, producing PEARLS (cracked passwords) and SAND (uncracked hard hashes).

## Prerequisites

- Filter stage completed (`state.json` filter.status = "completed")
- Hashcrack skill configured (HASHCRACK_SERVER_URL, HASHCRACK_API_KEY in .env)
- Hashtopolis server accessible with available workers
- rockyou.txt and OneRuleToRuleThemStill.rule uploaded to Hashtopolis

## Nomenclature

```
ROCKS   = Full HIBP Pwned Passwords (~1B SHA-1 hashes)
           │
           ▼ Remove rockyou.txt matches
GRAVEL  = HIBP - rockyou (~985M hashes)
           │
           ▼ Remove rockyou + OneRuleToRuleThemStill cracked
SAND    = Hard passwords that survived initial attack
           │
           ▼ Systematic escalating attacks
PEARLS  = Cracked cleartext passwords (valuable output)
```

---

## GRAVEL → SAND + PEARLS (Initial Crack)

This is the main pipeline that transforms GRAVEL candidates into PEARLS and SAND.

### Pipeline Overview

```
GRAVEL (candidates/batch-*.txt.gz)
         │
         ▼
┌─────────────────────────────────────────────────────┐
│              CRACK SUBMISSION                        │
│  CrackSubmitter.ts --all --workers 10               │
│  Split batches across N parallel hashlists          │
│  maxAgents=1 per task for rule attack               │
└─────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────┐
│              HASHCRACK EXECUTION                     │
│  rockyou.txt + OneRuleToRuleThemStill.rule           │
│  Hash type: SHA-1 (100)                             │
│  Distributed across N workers                       │
└─────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────┐
│              RESULT COLLECTION                       │
│  ResultCollector.ts --poll                          │
│  Collects HASH:PASSWORD pairs from Hashtopolis     │
└─────────────────────────────────────────────────────┘
         │
         ├────────────────────────────────┐
         ▼                                ▼
┌─────────────────────┐      ┌─────────────────────────┐
│       PEARLS        │      │         SAND            │
│  data/results/      │      │  data/results/          │
│  cracked.txt        │      │  uncracked.txt          │
│  passwords.txt      │      │  (audit-worthy hashes)  │
└─────────────────────┘      └─────────────────────────┘
```

### Execution Steps

#### Step 1: Verify Prerequisites

```bash
# Check filter completed
bun Tools/StateManager.ts

# Expected output:
# Filter: completed (XXX candidates)

# Test Hashcrack connection
bun .claude/skills/Hashcrack/tools/HashtopolisClient.ts test

# List available workers
bun .claude/skills/Hashcrack/tools/HashtopolisClient.ts agents
```

#### Step 2: Preview Submission (Dry Run)

```bash
# See what would be submitted
bun Tools/CrackSubmitter.ts --all --dry-run
```

#### Step 3: Submit to Hashcrack

```bash
# Submit all batches with parallel workers
bun Tools/CrackSubmitter.ts --all --workers 10
```

**Parallelization Strategy:**
- Rule attacks use only 1 worker per task (hashcat limitation)
- `--workers 10` splits each batch into 10 sub-batches
- Each sub-batch gets its own hashlist + task with `maxAgents=1`
- Result: 10× parallel cracking throughput

#### Step 4: Monitor Progress

```bash
# Check overall progress
bun Tools/ProgressTracker.ts

# Or directly query Hashtopolis
bun .claude/skills/Hashcrack/tools/HashtopolisClient.ts tasks
```

#### Step 5: Collect Results

```bash
# One-time collection
bun Tools/ResultCollector.ts

# Or poll until all tasks complete
bun Tools/ResultCollector.ts --poll --interval 60000
```

#### Step 6: Prioritize PEARLS (Optional)

```bash
# Sort PEARLS by HIBP occurrence count (most breached first)
bun Tools/PearlPrioritizer.ts

# Just top 10K most common
bun Tools/PearlPrioritizer.ts --top 10000

# Analyze count distribution
bun Tools/PearlPrioritizer.ts --analyze
```

### Output Files

| File | Description | Format |
|------|-------------|--------|
| `data/results/cracked.txt` | All cracked hash:password pairs | `HASH:PASSWORD` |
| `data/results/passwords.txt` | Unique passwords only (sorted) | One per line |
| `data/results/uncracked.txt` | SAND - hard hashes | SHA-1 hashes |
| `data/results/pearls-prioritized.txt` | PEARLS sorted by frequency | Passwords |
| `data/results/pearls-with-counts.txt` | Passwords with HIBP counts | `PASSWORD:COUNT` |

### Expected Results

Based on typical HIBP statistics:

| Metric | Estimate |
|--------|----------|
| GRAVEL size | ~700-900M hashes |
| Crack rate | 15-25% |
| PEARLS | ~100-200M passwords |
| SAND (uncracked) | ~500-700M hashes |

### Troubleshooting

#### No Workers Available
```bash
# Check agent status
bun .claude/skills/Hashcrack/tools/HashtopolisClient.ts agents

# Workers need rockyou.txt and OneRuleToRuleThemStill.rule
# Verify files exist on server
bun .claude/skills/Hashcrack/tools/HashtopolisClient.ts files
```

#### Tasks Not Starting
- Check task priority (higher = earlier)
- Verify workers are idle (not assigned to other tasks)
- Check hashcat compatibility on workers

---

## Philosophy

**Efficiency Principle:** Attack in order of cost-effectiveness.
- Cheap attacks first (wordlists, rules)
- Expensive attacks last (brute force)
- Each stage produces more PEARLS and refines SAND

**Feedback Loop:** Cracked passwords become new wordlist material.

---

## Stage 0: ROCKS → GRAVEL (Already Implemented)

**Tool:** `SetDifference.ts`
**Input:** HIBP hashes (ROCKS)
**Output:** GRAVEL hashlist
**Method:** Binary search against rockyou-sha1.bin

```bash
bun Tools/SetDifference.ts --batched --compress
```

---

## Stage 1: GRAVEL → SAND (Initial Crack)

**Attack:** Dictionary + OneRuleToRuleThemStill
**Hashcat Mode:** `-a 0` (Straight) with rules
**Expected Crack Rate:** 15-25%

```bash
# Submit to Hashcrack
hashcat -m 100 -a 0 gravel.txt rockyou.txt -r OneRuleToRuleThemStill.rule
```

**Output:**
- PEARLS: Cracked passwords
- SAND: Remaining uncracked hashes

---

## Stage 2: SAND Cracking Pipeline

### Phase 2.1: Quick Wins (Minutes)

#### 2.1.1 - Common Password Lists
```bash
# SecLists common passwords
hashcat -m 100 -a 0 sand.txt common-passwords-10k.txt
hashcat -m 100 -a 0 sand.txt common-passwords-100k.txt

# Leaked password compilations
hashcat -m 100 -a 0 sand.txt linkedin.txt
hashcat -m 100 -a 0 sand.txt adobe.txt
hashcat -m 100 -a 0 sand.txt ashley-madison.txt
```

#### 2.1.2 - Best64 Rules (Fast)
```bash
hashcat -m 100 -a 0 sand.txt rockyou.txt -r best64.rule
hashcat -m 100 -a 0 sand.txt passwords.txt -r best64.rule
```

### Phase 2.2: Rule Stacking (Hours)

#### 2.2.1 - Multiple Rule Files
```bash
# Dive rule (comprehensive)
hashcat -m 100 -a 0 sand.txt rockyou.txt -r dive.rule

# d3ad0ne rule
hashcat -m 100 -a 0 sand.txt rockyou.txt -r d3ad0ne.rule

# Generated2 rule
hashcat -m 100 -a 0 sand.txt rockyou.txt -r generated2.rule

# Hob0 rule
hashcat -m 100 -a 0 sand.txt rockyou.txt -r hob0.rule
```

#### 2.2.2 - Stacked Rules (Combinatorial)
```bash
# Combine rules for exponential coverage
hashcat -m 100 -a 0 sand.txt rockyou.txt -r best64.rule -r toggles1.rule
hashcat -m 100 -a 0 sand.txt rockyou.txt -r best64.rule -r leetspeak.rule
```

### Phase 2.3: Combinator Attacks (Hours)

#### 2.3.1 - Word + Word Combinations
```bash
# Combinator mode (-a 1)
hashcat -m 100 -a 1 sand.txt rockyou.txt rockyou.txt

# With small focused lists
hashcat -m 100 -a 1 sand.txt common-words.txt numbers-1000.txt
hashcat -m 100 -a 1 sand.txt names.txt years.txt
```

#### 2.3.2 - Combinator with Rules
```bash
# Left rule: capitalize first letter
hashcat -m 100 -a 1 sand.txt words.txt numbers.txt -j 'c' -k '$!'
```

### Phase 2.4: Hybrid Attacks (Hours-Days)

#### 2.4.1 - Dictionary + Mask (Mode 6)
```bash
# Append 1-4 digits
hashcat -m 100 -a 6 sand.txt rockyou.txt '?d'
hashcat -m 100 -a 6 sand.txt rockyou.txt '?d?d'
hashcat -m 100 -a 6 sand.txt rockyou.txt '?d?d?d'
hashcat -m 100 -a 6 sand.txt rockyou.txt '?d?d?d?d'

# Append year patterns
hashcat -m 100 -a 6 sand.txt rockyou.txt '19?d?d'
hashcat -m 100 -a 6 sand.txt rockyou.txt '20?d?d'

# Append special + digits
hashcat -m 100 -a 6 sand.txt rockyou.txt '?s?d?d'
hashcat -m 100 -a 6 sand.txt rockyou.txt '!?d?d?d'
```

#### 2.4.2 - Mask + Dictionary (Mode 7)
```bash
# Prepend digits
hashcat -m 100 -a 7 sand.txt '?d?d?d' rockyou.txt
hashcat -m 100 -a 7 sand.txt '?d?d?d?d' rockyou.txt
```

### Phase 2.5: Mask Attacks (Days)

#### 2.5.1 - Common Patterns
```bash
# 6-8 character lowercase
hashcat -m 100 -a 3 sand.txt '?l?l?l?l?l?l' --increment

# Ullllldd pattern (Capital + lower + digits)
hashcat -m 100 -a 3 sand.txt '?u?l?l?l?l?l?d?d'

# Common 8-char pattern
hashcat -m 100 -a 3 sand.txt '?u?l?l?l?l?l?l?d'
```

#### 2.5.2 - Custom Charsets
```bash
# Define custom charsets
# -1 = lowercase + digits
# -2 = uppercase + lowercase
hashcat -m 100 -a 3 sand.txt -1 '?l?d' '?1?1?1?1?1?1?1?1'
```

### Phase 2.6: PRINCE Attack (Days)

```bash
# PRINCE mode generates word combinations probabilistically
# Use princeprocessor or hashcat's -a 8 (if available)

# With princeprocessor
pp64.bin --pw-min=8 --pw-max=16 < rockyou.txt | hashcat -m 100 sand.txt

# Limit element count for speed
pp64.bin --elem-cnt-min=2 --elem-cnt-max=3 < words.txt | hashcat -m 100 sand.txt
```

### Phase 2.7: Markov Chain Attacks (Days)

```bash
# Generate Markov statistics from cracked passwords
hcstat2gen.bin cracked-passwords.txt markov.hcstat2

# Use Markov mode for intelligent guessing
hashcat -m 100 -a 3 sand.txt '?a?a?a?a?a?a?a?a' --markov-hcstat2=markov.hcstat2
```

### Phase 2.8: Incremental Brute Force (Weeks)

#### 2.8.1 - Short Passwords First
```bash
# Exhaustive 1-6 characters (fast for SHA-1)
hashcat -m 100 -a 3 sand.txt '?a?a?a?a?a?a' --increment --increment-min=1

# 7 characters (hours)
hashcat -m 100 -a 3 sand.txt '?a?a?a?a?a?a?a'

# 8 characters (days on consumer GPU)
hashcat -m 100 -a 3 sand.txt '?a?a?a?a?a?a?a?a'
```

#### 2.8.2 - Constrained Brute Force
```bash
# Only lowercase+digits (faster)
hashcat -m 100 -a 3 sand.txt '?h?h?h?h?h?h?h?h?h' --increment

# Only printable ASCII
hashcat -m 100 -a 3 sand.txt '?a?a?a?a?a?a?a?a?a?a' --increment
```

---

## Feedback Loop: PEARLS → New Wordlists

After each phase, cracked passwords enhance future attacks:

```bash
# 1. Extract cracked passwords
hashcat -m 100 sand.txt --show | cut -d: -f2 > new-pearls.txt

# 2. Add to custom wordlist
cat new-pearls.txt >> custom-wordlist.txt
sort -u custom-wordlist.txt -o custom-wordlist.txt

# 3. Generate Markov stats from all cracked
cat all-pearls.txt | hcstat2gen.bin markov-pearls.hcstat2

# 4. Use for next iteration
hashcat -m 100 -a 0 remaining-sand.txt custom-wordlist.txt -r OneRuleToRuleThemStill.rule
```

---

## Cost-Benefit Analysis

| Phase | Time (10M hashes, RTX 4090) | Expected Crack % | Cumulative |
|-------|----------------------------|------------------|------------|
| 2.1 Quick Wins | 5-30 min | 5-10% | 5-10% |
| 2.2 Rule Stacking | 2-6 hours | 5-10% | 10-20% |
| 2.3 Combinator | 4-12 hours | 2-5% | 12-25% |
| 2.4 Hybrid | 12-48 hours | 5-10% | 17-35% |
| 2.5 Mask | 2-7 days | 3-8% | 20-43% |
| 2.6 PRINCE | 3-10 days | 2-5% | 22-48% |
| 2.7 Markov | 5-14 days | 3-7% | 25-55% |
| 2.8 Brute Force | Weeks-Months | Variable | 30-70% |

**Note:** SHA-1 is fast (~25 GH/s on RTX 4090), so attacks complete quickly.

---

## Automation: SandCracker.ts

```typescript
// Stages to implement in Tools/SandCracker.ts
const CRACKING_STAGES = [
  { name: "quick-wins", attacks: ["common-lists", "best64"] },
  { name: "rule-stack", attacks: ["dive", "d3ad0ne", "stacked"] },
  { name: "combinator", attacks: ["word-word", "word-num"] },
  { name: "hybrid", attacks: ["dict-mask", "mask-dict"] },
  { name: "mask", attacks: ["common-patterns", "custom-charset"] },
  { name: "prince", attacks: ["prince-2elem", "prince-3elem"] },
  { name: "markov", attacks: ["markov-trained"] },
  { name: "bruteforce", attacks: ["1-6char", "7char", "8char"] },
];
```

---

## Files Produced

| File | Description |
|------|-------------|
| `data/rocks/` | Full HIBP download (batched) |
| `data/gravel.txt` | HIBP minus rockyou |
| `data/sand.txt` | Uncracked after Stage 1 |
| `data/pearls.txt` | All cracked passwords |
| `data/sand-remaining.txt` | Still uncracked (audit-worthy) |
| `data/markov-pearls.hcstat2` | Markov stats from cracked |

---

## Hashcrack Integration

Each stage submits to Hashtopolis with appropriate settings:

```typescript
// CrackSubmitter.ts enhancement
const STAGE_CONFIGS = {
  "quick-wins": { priority: 100, maxAgents: 0 },      // Use all agents
  "rule-stack": { priority: 80, maxAgents: 1 },       // Rule = 1 agent/task
  "combinator": { priority: 60, maxAgents: 0 },
  "hybrid": { priority: 40, maxAgents: 1 },
  "mask": { priority: 30, maxAgents: 0 },
  "bruteforce": { priority: 10, maxAgents: 0 },
};
```

---

## References

- [Hashcat Wiki - Attack Modes](https://hashcat.net/wiki/)
- [Hashcat Rule-Based Attack](https://hashcat.net/wiki/doku.php?id=rule_based_attack)
- [Hashcat Mask Attack](https://hashcat.net/wiki/doku.php?id=mask_attack)
- [Hashcat Hybrid Attack](https://hashcat.net/wiki/doku.php?id=hybrid_attack)
- [TrustedSec hate_crack](https://github.com/trustedsec/hate_crack)
- [ProSec Password Cracking Guide](https://www.prosec-networks.com/en/blog/password-cracking/)
