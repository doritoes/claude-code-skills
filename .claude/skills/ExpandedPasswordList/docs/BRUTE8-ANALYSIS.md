# Brute-8 Password Analysis (2026-02-07) - REVISED

## Executive Summary

Analysis of 23,295 passwords cracked in SAND batch-0001. Initial conclusions about "SAND = system-generated passwords" were premature.

**Key Limitation:** We ran brute-8 and found mostly 8-char passwords. This tells us about passwords we can brute-force, NOT about what remains in GLASS.

## Statistics

| Metric | Value |
|--------|-------|
| Total DIAMONDS (batch-0001) | 23,295 |
| Total GLASS (batch-0001) | 327,829 |
| Crack rate | 6.6% |
| **Unanalyzed** | **93.4%** |

## What We Know

### Length Distribution (DIAMONDS only - what we cracked)

| Length | Count | % | Notes |
|--------|-------|---|-------|
| 5 chars | 986 | 4.2% | Short passwords |
| 6 chars | 7,312 | 31.4% | Caught by brute-6 |
| 7 chars | 8,616 | 37.0% | Caught by brute-7 |
| 8 chars | 1,830 | 7.9% | Caught by brute-8 |
| 9-11 chars | 3,627 | 15.6% | Caught by dictionary/rules |
| **12+ chars** | **907** | **3.9%** | See analysis below |
| **16+ chars** | **39** | **0.17%** | Insufficient data |

### 8-Character Passwords (1,830)

These are predominantly random alphanumeric strings (brute-8 target):
- Lowercase + digits: ~60%
- Mixed case: ~25%
- With symbols: ~15%

Examples: `7eknr2rq`, `c4w3wr72`, `p7zr3iyq`

**Interpretation:** Brute-8 finds what brute-8 can find. These are system-generated, password manager output, or truly random.

### 12+ Character Passwords (907) - STRUCTURED

Unlike 8-char, these have **dictionary word roots**:

| Pattern | Count | % | Examples |
|---------|-------|---|----------|
| lowercase + 4 digits | 583 | 64% | `controls8370`, `cooperative2264` |
| lowercase + 6 digits | 92 | 10% | `sriwahyuningsih0872` |
| lowercase + 3 digits | 90 | 10% | `morpheus356` |
| Capitalized + digits | 84 | 9% | `Littlewood6360`, `Madagascar5250` |
| Other | ~60 | 7% | `inuyasha&kagome0458` |

**Key Insight:** 12+ char passwords have word roots. Rules can target these.

### 16+ Character Passwords (39) - INSUFFICIENT DATA

Sample (all 39):
```
inuyasha&kagome0458     justification7308      arianagrande1965
sriwahyuningsih0872     jorgeantonio3246       surroundings2757
albertoromero2035       diegoarmando3126       barbaraoliveira8893
absolutezero4869        dragonmaster5262       embarrassing7026
complications2438       devilmaycry43666       investigation3558
Doppelganger_229        shewillbelove1866      longdistance3914
kristofferson2679       cutiewithabooty8212    leagueoflegends26
thoughtfully3287        jackfruitbed4757       strangerthings509
shootingfish2531        casesensitive6953      DANIELORLANDO3405
giuliocesare1481        ihatemyfamily1164      gingerspice19969
massimiliano7690        platinumkiwi6531       (+ 7 $HEX entries)
```

**Observations:**
- Pop culture: `arianagrande`, `leagueoflegends`, `strangerthings`, `devilmaycry`
- Compound words: `dragonmaster`, `absolutezero`, `longdistance`
- Foreign names: `sriwahyuningsih`, `giuliocesare`, `massimiliano`
- Phrases: `ihatemyfamily`, `shewillbelove`, `cutiewithabooty`

**Conclusion:** 39 samples is statistically meaningless. Cannot draw conclusions.

## What We DON'T Know

### GLASS (327,829 uncracked hashes)

We have NO visibility into:
- Password length distribution in GLASS
- Character class distribution in GLASS
- Whether GLASS contains word-based passwords we haven't tried to crack
- What % of GLASS is 12+ or 16+ characters

### The Circular Reasoning Problem

```
Ran brute-8 → Found 8-char passwords → Concluded "SAND = random"
                    ↑
          This is what brute-8 FINDS
```

We haven't tried:
- Targeted dictionary attacks with longer word lists
- Compound word attacks (`word+word+digits`)
- Pop culture wordlists (`arianagrande`, `strangerthings`)
- Year suffix attacks (2020, 2021, 2022, etc.)

## Cost Analysis

| Scope | Batches | Cost @ $421/batch | Notes |
|-------|---------|-------------------|-------|
| SAND (162 batches) | 162 | $68,202 | Current pipeline |
| GRAVEL (4,307 batches) | 4,307 | $1,813,247 | Full brute-8 on all |

**Question:** Is brute-8 on all GRAVEL worth $1.8M when the goal is building wordlists?

## Revised Recommendations

### What Brute-8 IS Good For
- Finding 8-char random/system passwords
- ~6% crack rate on SAND
- Definitive: if it survives brute-8, password is 9+ chars or has special chars

### What We Should Focus On Instead

1. **PEARLS Analysis** - Analyze passwords cracked in GRAVEL Stage 1
   - These are word-based passwords that rules cracked
   - Build wordlists from these, not from brute-8 results

2. **Targeted Longer Attacks** - Before running brute-9/10/11:
   - Try compound word attacks on GLASS
   - Try pop culture wordlists
   - Try foreign language dictionaries

3. **HIBP Frequency Analysis** - For GLASS hashes:
   - Higher occurrence count = more common = more likely crackable
   - Prioritize high-frequency GLASS for targeted attacks

4. **12+ and 16+ Character Research**
   - Need more data before drawing conclusions
   - Analyze PEARLS for longer password patterns
   - Analyze other breaches for modern password trends

## Key Learnings

1. **Brute force finds what brute force finds** - don't over-generalize
2. **Limited data = limited conclusions** - 39 samples is not analysis
3. **Cost matters** - $1.8M for brute-8 on all GRAVEL is not justified
4. **The goal is wordlists** - not exhaustive cracking of HIBP

## Next Steps for Real Analysis

1. Analyze PEARLS (Stage 1 cracks) for word patterns
2. Cross-reference GLASS hashes with HIBP counts to find high-value targets
3. Build pop culture / modern wordlists from PEARLS patterns
4. Test targeted attacks on GLASS before concluding "uncrackable"

## ROI Analysis: brute-8 Now vs Post-Pipeline (2026-02-12)

### BIGRED Hardware

RTX 4060 Ti (8GB VRAM), SHA-1 mask speed ~10.9 GH/s with `-O` optimized kernels.

### Timing

| Metric | Value |
|--------|-------|
| Keyspace (95^8) | 6.63 quadrillion |
| Time per batch | ~169 hours (~7 days) |
| Standard batch time | ~3-4 hours |
| Batches per 7 days | ~42 |

### Opportunity Cost Comparison

| Metric | brute-8 (1 batch, 7 days) | Standard pipeline (42 batches, 7 days) |
|--------|---------------------------|---------------------------------------|
| Expected cracks | ~3K-33K | ~966K |
| Unique batches processed | 1 | 42 |
| Pipeline progress | 1/155 remaining | 42/155 remaining |
| Feedback loop value | See below | Full (every batch feeds DiamondAnalyzer) |

### Corrected Feedback Value Assessment

**Previous claim (WRONG):** "brute-8 discoveries are random strings with ZERO feedback value."

**Actual data from batch-0001 (48,624 eight-character passwords):**

| Category | Count | % | Feedback Value |
|----------|-------|---|----------------|
| word+digits | 6,323 | 13.0% | HIGH — word roots feed cohorts |
| capitalized+digits | 1,396 | 2.9% | HIGH — same roots, capitalization rules handle |
| digits+word | 1,905 | 3.9% | HIGH — word roots feed cohorts |
| two words | 4,492 | 9.2% | HIGH — compound roots for wordlists |
| other structured | 7,018 | 14.4% | MEDIUM — contains dictionary words in context |
| all lowercase alpha | 8,418 | 17.3% | LOW-MEDIUM — some real words, some random strings |
| leet speak | 735 | 1.5% | HIGH — leet roots already in wordlists |
| keyboard patterns | 62 | 0.1% | LOW — already covered by masks |
| **TOTAL STRUCTURED** | **30,349** | **62.4%** | **11,811 unique word roots extracted** |
| random-looking | 18,275 | 37.6% | ZERO — truly random |

**Conclusion:** brute-8 cracks are majority structured (62%) with 11,811 unique word roots that feed the DiamondAnalyzer → cohort → nocap-plus.txt feedback loop. The feedback value is real.

### Decision: DEFER (not cancel)

brute-8 is deferred to post-pipeline on **opportunity cost alone**:
- 42 standard batches in same GPU time = ~30x more cracks
- Standard pipeline cracks ALSO feed the feedback loop
- After batch-162, combine ALL GLASS (~50M+ hashes) into one hashlist → single 7-day brute-8 pass
- Unified GLASS approach: same GPU time, but brute-8 results checked against ALL remaining hashes (not just 1 batch)

## Data Files

- DIAMONDS batch-0001: 70,258 cracked (after all attacks including brute-8)
- 8-char passwords: 48,624 (69.2% of all cracks)
- GLASS batch-0001: 327,829 uncracked (93.4%)
- Original analysis date: 2026-02-07
- ROI analysis date: 2026-02-12
