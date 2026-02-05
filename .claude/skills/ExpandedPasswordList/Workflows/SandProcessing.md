# SAND Processing Pipeline

**Status:** Implementation Plan (THEALGORITHM PLAN Phase)

Transform SAND (hard hashes that survived Stage 1) into DIAMONDS (cracked passwords) and GLASS (uncrackable hashes) using escalating attack phases.

## Nomenclature

```
GRAVEL (Stage 1 input)
    │
    ├──► PEARLS (Stage 1 cracked - rockyou + OneRule)
    │
    └──► SAND (Stage 1 uncracked - hard passwords)
              │
              ├──► DIAMONDS (Stage 2+ cracked - escalating attacks)
              │
              └──► GLASS (Uncrackable - requires HIBP cleartext/rainbow)
```

## Architecture

### Key Design Principles

1. **Hashlist Reuse**: Create ONE hashlist per SAND batch, run MULTIPLE attacks against it
2. **Intelligent Parallelization**:
   - Rule attacks: `maxAgents=1` per task (hashcat -s limitation)
   - Brute force/mask: Can use all agents (`maxAgents=0`)
   - Small jobs (1-5 chars): `isSmall=1` for efficiency
3. **State Tracking**: Track attacks applied per batch, crack rates per attack type
4. **Strategy Evolution**: Learn from results, skip ineffective attacks

### Attack Phase Configuration

**CRITICAL**: SAND = hashes that SURVIVED `rockyou.txt + OneRuleToRuleThemStill`

DO NOT repeat attacks that are subsets of what was already tried!
- ❌ `best64.rule` - subset of OneRule (WASTED EFFORT)
- ❌ `rockyou + similar rules` - same wordlist, diminishing returns
- ✅ NEW wordlists (rizzyou, nocap) - completely new root words!
- ✅ Hybrid attacks (-a 6) - append patterns NOT covered by rules
- ✅ Combinator (-a 1) - word+word combinations
- ✅ Mask/Brute - pure pattern-based

| Phase | Attack Type | Mode | maxAgents | isSmall | Priority |
|-------|-------------|------|-----------|---------|----------|
| 1 | NEW WORDLISTS (rizzyou+OneRule) | Rule (-a 0 -r) | 1 | 0 | 100 |
| 2 | NEW WORDLISTS (nocap+GenZ.rule) | Rule (-a 0 -r) | 1 | 0 | 95 |
| 3 | Hybrid (rockyou+digits) | -a 6 | 0 | 0 | 90 |
| 4 | Hybrid (rizzyou+digits) | -a 6 | 0 | 1 | 85 |
| 5 | Combinator (words+numbers) | -a 1 | 0 | 1 | 75 |
| 6 | Mask (common patterns) | -a 3 | 0 | 0 | 60 |
| 7 | Brute 1-5 chars | -a 3 | 0 | 1 | 40 |
| 8 | Brute 6-7 chars | -a 3 | 0 | 0 | 30 |

### File Requirements (Hashtopolis)

Files must be uploaded to Hashtopolis with these IDs:

| File ID | Name | Purpose | Size |
|---------|------|---------|------|
| 1 | rockyou.txt | Base wordlist | 139MB |
| 3 | OneRuleToRuleThemStill.rule | Comprehensive rules | ~2MB |
| 4 | best64.rule | Quick rule set | 1KB |
| 5 | nocap.txt | rockyou + rizzyou | 140MB |
| 6 | nocap.rule | GenZ patterns | 2KB |
| 7 | dive.rule | Deep rule coverage | ~1MB |
| 8 | d3ad0ne.rule | Alternative rules | ~500KB |

## Data Flow

```
data/sand/batch-NNNN.txt.gz    (Input: SAND hashes from Stage 1)
         │
         ▼
┌─────────────────────────────────────────────────────────────────┐
│                    SAND PROCESSOR                                │
│                                                                  │
│  1. Load SAND batch                                             │
│  2. Check if hashlist exists (reuse) or create new             │
│  3. For each attack phase not yet applied:                      │
│     a. Create task with proper config (maxAgents, isSmall)     │
│     b. Wait for completion or move to next batch               │
│  4. After all attacks: remaining = GLASS                        │
│  5. Track statistics for strategy evolution                     │
└─────────────────────────────────────────────────────────────────┘
         │
         ├──────────────────────────────────┐
         ▼                                  ▼
data/diamonds/batch-NNNN.txt    data/glass/batch-NNNN.txt
(Cracked passwords)              (Uncrackable hashes)
```

## State Schema (sand-state.json)

```json
{
  "version": 2,
  "batches": {
    "batch-0001": {
      "hashlistId": 1234,
      "hashCount": 500000,
      "attacksApplied": ["quick-wins", "rule-stack"],
      "attacksRemaining": ["combinator", "hybrid", "mask", "brute"],
      "cracked": 45000,
      "startedAt": "2026-02-05T10:00:00Z",
      "lastAttackAt": "2026-02-05T12:30:00Z",
      "status": "in_progress"
    }
  },
  "attackStats": {
    "quick-wins": { "attempted": 5, "totalCracked": 125000, "avgRate": 0.05 },
    "rule-stack": { "attempted": 5, "totalCracked": 80000, "avgRate": 0.032 }
  },
  "startedAt": "2026-02-05T10:00:00Z",
  "lastUpdated": "2026-02-05T14:00:00Z"
}
```

## Attack Presets

### Phase 1: NEW WORDLISTS (highest value!)

SAND survived `rockyou + OneRule`, so the highest value attacks use **new root words**.

```typescript
const NEW_WORDLISTS = [
  {
    name: "newwords-rizzyou-onerule",
    attackCmd: "#HL# rizzyou.txt -r OneRuleToRuleThemStill.rule",
    fileIds: [9, 3],  // rizzyou.txt, OneRuleToRuleThemStill.rule
    maxAgents: 1,     // Rule attack
    isSmall: 0,
    priority: 100,
    expectedRate: 0.02,
    description: "GenZ words (minecraft, fortnite, etc) + proven rules"
  },
  {
    name: "newwords-nocap-genz",
    attackCmd: "#HL# nocap.txt -r GenZ.rule",
    fileIds: [5, 6],  // nocap.txt, GenZ.rule
    maxAgents: 1,
    isSmall: 0,
    priority: 95,
    expectedRate: 0.015,
    description: "Combined wordlist + modern year suffixes (2015-2025)"
  }
];
```

### Phase 2: HYBRID ATTACKS (append patterns not covered by rules)

Rules TRANSFORM words. Hybrids APPEND patterns. Different keyspace!

```typescript
const HYBRID = [
  {
    name: "hybrid-rockyou-4digit",
    attackCmd: "#HL# -a 6 rockyou.txt ?d?d?d?d",
    fileIds: [1],
    maxAgents: 0,  // Hybrid can use multiple agents
    isSmall: 0,
    priority: 90,
    expectedRate: 0.03,
    description: "rockyou + 4 digit suffix (password1234)"
  },
  {
    name: "hybrid-rockyou-year",
    attackCmd: "#HL# -a 6 rockyou.txt 20?d?d",
    fileIds: [1],
    maxAgents: 0,
    isSmall: 0,
    priority: 88,
    expectedRate: 0.02,
    description: "rockyou + year suffix (password2024)"
  },
  {
    name: "hybrid-rizzyou-4digit",
    attackCmd: "#HL# -a 6 rizzyou.txt ?d?d?d?d",
    fileIds: [9],
    maxAgents: 0,
    isSmall: 1,  // Small wordlist
    priority: 85,
    expectedRate: 0.01,
    description: "GenZ words + 4 digits (minecraft1234)"
  }
];
```

### Phase 3: COMBINATOR (word+word combinations)

```typescript
const COMBINATOR = [
  {
    name: "combo-common-numbers",
    attackCmd: "#HL# -a 1 common-words.txt numbers-1000.txt",
    fileIds: [10, 11],
    maxAgents: 0,
    isSmall: 1,
    priority: 75,
    expectedRate: 0.008,
    description: "Common words + numbers (love123, happy2024)"
  }
];
```

### Phase 4: MASK ATTACKS (common password patterns)

```typescript
const MASK = [
  {
    name: "mask-Ullllldd",
    attackCmd: "#HL# -a 3 ?u?l?l?l?l?l?d?d",
    fileIds: [],
    maxAgents: 0,
    isSmall: 0,
    priority: 60,
    expectedRate: 0.01,
    description: "Uppercase + 5 lower + 2 digits (Summer23)"
  },
  {
    name: "mask-lllllldd",
    attackCmd: "#HL# -a 3 ?l?l?l?l?l?l?d?d",
    fileIds: [],
    maxAgents: 0,
    isSmall: 0,
    priority: 58,
    expectedRate: 0.015,
    description: "6 lowercase + 2 digits (summer23)"
  },
  {
    name: "mask-dddddddd",
    attackCmd: "#HL# -a 3 ?d?d?d?d?d?d?d?d",
    fileIds: [],
    maxAgents: 0,
    isSmall: 1,  // Only 100M combinations
    priority: 52,
    expectedRate: 0.005,
    description: "8 digits (phone numbers, dates)"
  }
];
```

### Phase 5: BRUTE FORCE (exhaustive short passwords)

```typescript
const BRUTE = [
  {
    name: "brute-1-5",
    attackCmd: "#HL# -a 3 ?a?a?a?a?a --increment --increment-min=1",
    fileIds: [],
    maxAgents: 0,
    isSmall: 1,
    priority: 40,
    expectedRate: 0.005,
    description: "Exhaustive 1-5 characters"
  },
  {
    name: "brute-6",
    attackCmd: "#HL# -a 3 ?a?a?a?a?a?a",
    fileIds: [],
    maxAgents: 0,
    isSmall: 0,
    priority: 35,
    expectedRate: 0.003
  },
  {
    name: "brute-7",
    attackCmd: "#HL# -a 3 ?a?a?a?a?a?a?a",
    fileIds: [],
    maxAgents: 0,
    isSmall: 0,
    priority: 30,
    expectedRate: 0.002
  }
];
```

## CLI Usage

```bash
# Submit SAND batch for processing (all attacks)
bun Tools/SandProcessor.ts --batch 1

# Submit specific attack phase only
bun Tools/SandProcessor.ts --batch 1 --phase quick-wins

# Check SAND processing status
bun Tools/SandProcessor.ts --status

# Show attack history for batch
bun Tools/SandProcessor.ts --history 1

# Process next pending attack for all batches
bun Tools/SandProcessor.ts --continue

# Extract GLASS (uncracked after all attacks)
bun Tools/SandProcessor.ts --extract-glass 1

# Strategy analysis (which attacks work best)
bun Tools/SandProcessor.ts --analyze
```

## UNOBTAINIUM Feedback Loop

After processing SAND batches, analyze DIAMONDS to learn new patterns:

```
SAND → [Attacks] → DIAMONDS (cracked)
                      │
                      ▼
              DiamondAnalyzer
                      │
         ┌───────────┴───────────┐
         ▼                       ▼
    BETA.txt               UNOBTAINIUM.rule
 (new root words)        (learned patterns)
         │                       │
         └───────────┬───────────┘
                     ▼
          Upload to Hashtopolis
                     │
                     ▼
         Feedback attacks on remaining SAND
```

### Workflow

1. **After each batch completes**:
   ```bash
   # Analyze DIAMONDS from this batch
   bun Tools/DiamondAnalyzer.ts --input data/diamonds/batch-0001.txt
   ```

2. **Outputs**:
   - `data/processed/beta.txt` - New root words NOT in rockyou/nocap
   - `data/rules/unobtainium.rule` - Rules extracted from password patterns

3. **Upload and test**:
   ```bash
   # Upload new files to Hashtopolis
   # Then enable feedback attacks in next batch
   bun Tools/SandProcessor.ts --batch 2 --attack feedback-beta-onerule
   ```

4. **Track effectiveness**:
   - Compare crack rates of UNOBTAINIUM vs existing rules
   - Merge effective rules into permanent rule set
   - Remove ineffective rules

## Strategy Evolution

After each batch completes all attacks:

1. **Calculate effectiveness per attack**:
   ```
   effectiveness = cracked / time_spent
   ```

2. **Reorder attacks** for next batch based on effectiveness

3. **Skip attacks** with <0.1% crack rate after 3 batches

4. **Run DiamondAnalyzer** to extract patterns → UNOBTAINIUM.rule

5. **Log learnings** to `data/sand-learnings.json`

## Integration Points

- **CrackSubmitter.ts**: Reuse database task creation logic
- **StateManager.ts**: Pattern for state persistence
- **PipelineMonitor.ts**: Health checks before submission
- **SafeArchiver.ts**: Archive completed SAND tasks
- **PasswordExporter.ts**: Export DIAMONDS to cracked-master.txt

## Expected Results

| Attack Phase | Est. Crack Rate | Cumulative |
|--------------|-----------------|------------|
| Quick Wins | 3-5% | 3-5% |
| Rule Stack | 2-4% | 5-9% |
| Hybrid | 3-5% | 8-14% |
| Mask | 1-3% | 9-17% |
| Brute 1-5 | 0.5-1% | 9.5-18% |
| Brute 6-7 | 0.2-0.5% | 9.7-18.5% |

**Final composition:**
- DIAMONDS: ~10-20% of SAND
- GLASS: ~80-90% of SAND (truly hard passwords)

## Files Created

| File | Purpose |
|------|---------|
| `Tools/SandProcessor.ts` | Main orchestrator tool |
| `Tools/SandStateManager.ts` | State persistence for SAND processing |
| `data/sand-state.json` | Processing state |
| `data/sand/batch-*.txt.gz` | Input SAND batches |
| `data/diamonds/batch-*.txt` | Cracked passwords per batch |
| `data/glass/batch-*.txt` | Uncrackable hashes per batch |
| `data/sand-learnings.json` | Strategy evolution data |
