# ExpandedPasswordList Architecture

## Nomenclature

| Name | Definition | Size Estimate |
|------|------------|---------------|
| **ROCKS** | Full HIBP Pwned Passwords | ~1B SHA-1 hashes |
| **GRAVEL** | ROCKS minus rockyou.txt matches | ~985M hashes |
| **SAND** | GRAVEL minus rockyou+OneRule cracked | ~700M hashes |
| **PEARLS** | Cracked cleartext passwords | Valuable output |
| **GLASS** | Base words extracted from PEARLS | Optimized wordlist |
| **UNOBTAINIUM** | Enhanced rule derived from OneRule + PEARLS analysis | Improved rule file |

## HIBP Occurrence Counts

HIBP provides occurrence counts for each hash (how many times it appeared in breaches).
This metadata is preserved throughout the pipeline for prioritization.

**Format:** `SUFFIX:COUNT` in API responses → `HASH:COUNT` in counts-index.txt

**Value:** More frequently breached passwords are:
- More likely to be reused
- More valuable for wordlist prioritization
- Better candidates for early positions in attack dictionaries

**Files:**
- `data/candidates/counts-index.txt` - HASH:COUNT for all GRAVEL
- `data/results/pearls-prioritized.txt` - PEARLS sorted by frequency
- `data/results/pearls-with-counts.txt` - PASSWORD:COUNT for analysis

**Usage:**
```bash
# Prioritize PEARLS by HIBP occurrence count
bun Tools/PearlPrioritizer.ts

# Analyze count distribution
bun Tools/PearlPrioritizer.ts --analyze

# Top 10K most common passwords
bun Tools/PearlPrioritizer.ts --top 10000
```

## Data Flow

```
       ┌─────────────────────────────────────────────────────────────┐
       │                         ROCKS                               │
       │              HIBP Pwned Passwords (~1B SHA-1)               │
       └─────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
                         ┌───────────────────┐
                         │     DOWNLOAD      │  HIBP API by prefix
                         │    1M prefixes    │  Resume-capable
                         │    --batched      │  256 archives
                         └───────────────────┘
                                    │
                                    ▼
       ┌─────────────────────────────────────────────────────────────┐
       │                        GRAVEL                               │
       │           ROCKS - rockyou.txt (~985M hashes)                │
       └─────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
                         ┌───────────────────┐
                         │   STAGE 1 CRACK   │  rockyou + OneRule
                         │   15-25% cracked  │  Hashcrack parallel
                         └───────────────────┘
                                    │
                    ┌───────────────┴───────────────┐
                    ▼                               ▼
       ┌─────────────────────┐         ┌─────────────────────┐
       │       PEARLS        │         │        SAND         │
       │  Cracked passwords  │         │  Hard passwords     │
       │  → custom wordlist  │         │  (~700M hashes)     │
       └─────────────────────┘         └─────────────────────┘
                    │                               │
                    │         ┌─────────────────────┤
                    │         ▼                     ▼
                    │  ┌─────────────┐    ┌─────────────────┐
                    │  │ Quick Wins  │    │  Rule Stacking  │
                    │  │ best64,dive │    │  combinator     │
                    │  └─────────────┘    └─────────────────┘
                    │         │                     │
                    │         ▼                     ▼
                    │  ┌─────────────┐    ┌─────────────────┐
                    │  │   Hybrid    │    │     Mask        │
                    │  │  dict+mask  │    │   patterns      │
                    │  └─────────────┘    └─────────────────┘
                    │         │                     │
                    │         ▼                     ▼
                    │  ┌─────────────┐    ┌─────────────────┐
                    │  │   PRINCE    │    │    Markov       │
                    │  │  word-combo │    │   statistical   │
                    │  └─────────────┘    └─────────────────┘
                    │         │                     │
                    │         ▼                     ▼
                    │  ┌─────────────────────────────────────┐
                    │  │          BRUTE FORCE               │
                    │  │     1-8+ chars incremental         │
                    │  └─────────────────────────────────────┘
                    │                     │
                    │◄────────────────────┘
                    │        Feedback loop
                    ▼
       ┌─────────────────────────────────────────────────────────────┐
       │                     FINAL OUTPUT                            │
       ├─────────────────────────────────────────────────────────────┤
       │  pearls.txt        All cracked passwords (→ GitHub repo)   │
       │  sand-remaining.txt  Uncracked hashes (audit-worthy)       │
       │  markov-pearls.hcstat2  Trained Markov model               │
       └─────────────────────────────────────────────────────────────┘
```

## Memory Efficiency Strategy

### Problem
1 billion hashes won't fit in memory (~20GB as strings).

### Solution
Stream by 5-character hex prefix (1,048,576 ranges: 00000-FFFFF).

**Per-prefix processing:**
1. Download one prefix (~1000 hashes)
2. Check each hash against sorted rockyou-sha1.bin (binary search)
3. Write non-matches to candidates file
4. Move to next prefix

**Peak memory:** ~100MB (one prefix + binary search buffer)

## Storage Requirements

| Data | Size | Notes |
|------|------|-------|
| HIBP via API | ~1-2GB | 1M prefixes × ~1KB each (uncompressed text) |
| rockyou-sha1.bin | ~286MB | Binary index for fast lookup |
| Candidates (filtered) | ~35GB | ~985M hashes × 40 bytes + newlines |
| Cracked results | ~1-5GB | Depends on crack rate |
| **Total** | **~40GB** |

**Note:** The 17GB figure often cited is for the HIBP downloadable torrent (SHA-1 ordered by hash).
Using the API downloads uncompressed text which is larger per-hash but avoids torrent setup.

## Storage Modes

### Individual Files (Default)
- One file per prefix: `data/hibp/00000.txt` through `data/hibp/FFFFF.txt`
- Simple to inspect and debug
- **Drawback:** 1,048,576 files causes filesystem issues on many systems

### Batched Storage (Recommended)
- 256 compressed archives: `data/hibp-batched/hibp-00.json.gz` through `data/hibp-batched/hibp-FF.json.gz`
- Each batch contains ~4,096 prefixes grouped by first 2 hex chars
- Includes metadata: ETags for incremental updates, timestamps
- Checksums stored in state.json for integrity verification

```
# Enable with:
bun Tools/HibpDownloader.ts --batched
bun Tools/SetDifference.ts --batched
```

### Incremental Updates (with ETags)
- HTTP ETag headers track content changes
- `If-None-Match` header returns 304 Not Modified for unchanged prefixes
- Saves bandwidth when re-running download after HIBP updates

```
# Enable with:
bun Tools/HibpDownloader.ts --batched --incremental
```

### Compressed Candidates
- Filter output can be gzip compressed: `data/candidates/batch-001.txt.gz`
- Reduces candidate storage by ~60%
- CrackSubmitter auto-detects and decompresses

```
# Enable with:
bun Tools/SetDifference.ts --batched --compress
```

## rockyou-sha1.bin Format

Binary file optimized for binary search:
- Each SHA-1 hash stored as 20 bytes (raw binary)
- Sorted in ascending order
- Total: 14,344,391 hashes × 20 bytes = 286MB

**Lookup complexity:** O(log n) = ~24 comparisons max

## Parallel Cracking Strategy

Per Hashcrack PARALLELIZATION.md, rule attacks use only 1 worker per task.

**Solution:** Split hashes into N hashlists for N workers.

```
10M candidate hashes
        │
        ▼
┌───────────────┐
│   SPLIT       │  1M hashes per batch
│   10 batches  │
└───────────────┘
        │
        ▼
┌─────────────────────────────────────┐
│  HASHCRACK SUBMISSION               │
│  10 hashlists × 10 tasks            │
│  maxAgents=1 per task               │
│  = 10 parallel workers              │
└─────────────────────────────────────┘
```

## State Persistence

```typescript
interface PipelineState {
  version: number;
  lastUpdated: string;

  download: {
    status: "pending" | "in_progress" | "completed";
    completedPrefixes: string[];  // ["00000", "00001", ...]
    totalHashes: number;
    startedAt?: string;
    completedAt?: string;
    // Batched storage support
    hibpVersion?: string;           // HIBP dataset version tracking
    etags?: Record<string, string>; // prefix -> ETag for incremental updates
    checksums?: Record<string, string>; // batchId -> SHA-256 for integrity
    useBatchedStorage?: boolean;    // true if using batched mode
  };

  filter: {
    status: "pending" | "in_progress" | "completed";
    completedPrefixes: string[];
    rockyouMatches: number;
    candidates: number;
    batchesWritten: number;
    useCompression?: boolean;       // true if writing .txt.gz files
  };

  crack: {
    status: "pending" | "in_progress" | "completed";
    hashlistIds: number[];
    taskIds: number[];
    totalSubmitted: number;
    totalCracked: number;
  };

  results: {
    crackedPasswords: number;
    hardPasswords: number;           // Uncracked (audit-worthy) hashes
    lastCollected?: string;
    lastPublished?: string;
    publishedCommit?: string;
  };
}
```

## HIBP API

**Endpoint:** `https://api.pwnedpasswords.com/range/{prefix}`

**Format:**
```
SUFFIX:COUNT
0018A45C4D1DEF81644B54AB7F969B88D65:3
00D4F6E8FA6EECAD2A3AA415EEC418D38EC:2
```

**Rate limits:**
- No authentication required
- ~1500 requests/minute recommended
- Add-Padding: true header for k-anonymity

## Feedback Optimization Pipeline (Future Work)

### Overview

Use PEARLS to create better wordlists and rules, then measure improvement.

```
       ┌─────────────────────────────────────────────────────────────┐
       │                        PEARLS                               │
       │              Cracked passwords from SAND                    │
       └─────────────────────────────────────────────────────────────┘
                                   │
                    ┌──────────────┴──────────────┐
                    ▼                             ▼
       ┌─────────────────────┐       ┌─────────────────────┐
       │   GLASS WORDLIST    │       │  RULE ANALYSIS      │
       │   Extract base      │       │  Which OneRule      │
       │   words from PEARLS │       │  rules cracked      │
       └─────────────────────┘       │  which passwords?   │
                    │                └─────────────────────┘
                    │                             │
                    │                             ▼
                    │                ┌─────────────────────┐
                    │                │    UNOBTAINIUM      │
                    │                │  Enhanced rule:     │
                    │                │  - Keep high-yield  │
                    │                │  - Add new patterns │
                    │                │  - Remove duds      │
                    │                └─────────────────────┘
                    │                             │
                    └──────────────┬──────────────┘
                                   ▼
       ┌─────────────────────────────────────────────────────────────┐
       │                    BENCHMARK TEST                           │
       ├─────────────────────────────────────────────────────────────┤
       │  Baseline:  rockyou.txt + OneRule                          │
       │  Enhanced:  rockyou.txt + GLASS + UNOBTAINIUM              │
       │  Measure:   Crack rate improvement on GRAVEL sample        │
       └─────────────────────────────────────────────────────────────┘
```

### Phase 1: GLASS Wordlist Generation

Analyze PEARLS to extract base words that, when combined with rules, produce the cracked passwords.

**Techniques:**
1. **Reverse rule analysis** - For each PEARL, identify which rockyou word + rule produced it
2. **Common substring extraction** - Find recurring patterns across PEARLS
3. **Lemmatization** - Reduce passwords to root words (e.g., "P@ssw0rd123!" → "password")
4. **Frequency weighting** - Prioritize by HIBP occurrence count

**Output:** `data/wordlists/glass.txt` - Deduplicated base words sorted by frequency

### Phase 2: UNOBTAINIUM Rule Development

Analyze which OneRule transformations are most effective and identify gaps.

**Analysis:**
1. **Rule yield tracking** - Which rules cracked most passwords?
2. **Gap analysis** - What patterns in SAND aren't covered by OneRule?
3. **Rule deduplication** - Remove redundant rules that produce same outputs
4. **New pattern discovery** - Statistical analysis of PEARL patterns

**Metrics:**
- Rules per crack (efficiency)
- Coverage gaps (patterns not handled)
- Redundancy rate (duplicate outputs)

**Output:** `data/rules/unobtainium.rule` - Optimized rule file

### Phase 3: Benchmark Testing

Compare baseline vs enhanced on a GRAVEL sample.

**Test Setup:**
```bash
# Sample 10M hashes from GRAVEL for reproducible testing
head -n 10000000 data/candidates/gravel.txt > data/benchmark/sample-10m.txt

# Baseline: rockyou + OneRule
hashcat -m 100 -a 0 -r OneRuleToRuleThemAll.rule sample-10m.txt rockyou.txt

# Enhanced: rockyou + GLASS + UNOBTAINIUM
hashcat -m 100 -a 0 -r unobtainium.rule sample-10m.txt rockyou.txt glass.txt
```

**Metrics to Track:**
| Metric | Baseline | Enhanced | Improvement |
|--------|----------|----------|-------------|
| Crack rate | X% | Y% | +Z% |
| Time to 50% | Xh | Yh | -Zh |
| Unique cracks | X | Y | +Z |

### Files (Future)

| File | Purpose |
|------|---------|
| `Tools/GlassExtractor.ts` | Extract base words from PEARLS |
| `Tools/RuleAnalyzer.ts` | Analyze OneRule effectiveness |
| `Tools/UnobtainiumBuilder.ts` | Generate optimized rule file |
| `Tools/BenchmarkRunner.ts` | Run comparison tests |
| `Workflows/Optimize.md` | Optimization workflow |
| `data/wordlists/glass.txt` | GLASS wordlist |
| `data/rules/unobtainium.rule` | UNOBTAINIUM rule file |
| `data/benchmark/` | Benchmark results |

## GitHub Repository Structure

```
github.com/doritoes/expanded-passwords/
├── README.md                     # Documentation + live stats
├── passwords/
│   ├── batch-001.txt             # Cracked passwords by batch
│   ├── combined.txt              # All passwords (sorted, deduped)
│   └── combined.txt.gz           # Compressed
├── statistics/
│   └── stats.json                # Machine-readable metrics
└── hard-passwords/
    └── uncracked-sha1.txt        # "Audit-worthy" hashes
```
