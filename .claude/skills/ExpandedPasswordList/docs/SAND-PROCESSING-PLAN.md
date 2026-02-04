# SAND Processing Plan: 160 Batches → DIAMONDS + GLASS

**Generated:** 2026-02-03
**Algorithm:** THE ALGORITHM (THOROUGH)

## Executive Summary

We have **4,300 SAND batch files** (~351K hashes each, ~1.5B total hashes) from the initial rockyou+OneRule crack. Each batch needs escalating attacks to extract DIAMONDS (cracked) and leave GLASS (uncracked).

**Approach:** Process batch-0001 first as proof-of-concept to calibrate success rates, then scale to all 160+ batches.

---

## Attack Strategy: Cost-Benefit Analysis

Based on CrackingPipeline.md and SHA-1 performance (~25 GH/s on RTX 4090):

| Priority | Phase | Attack Type | Keyspace | Est. Time (351K) | Projected Success | GPU Cost |
|----------|-------|-------------|----------|------------------|-------------------|----------|
| **100** | Quick Wins | best64 + rockyou | 14.3M × 77 = 1.1B | 1-2 min | 5-8% | $ |
| **95** | GenZ Roots | rizzyou + OneRule | 203 × 14.3M = 2.9B | 2-3 min | 1-3% | $ |
| **90** | Dive Rules | rockyou + dive.rule | 14.3M × 99K = 1.4T | 15-30 min | 3-5% | $$ |
| **80** | d3ad0ne | rockyou + d3ad0ne | 14.3M × 35K = 500B | 5-10 min | 2-4% | $$ |
| **70** | Combinator | rockyou × common words | 14.3M × 10K = 143B | 1-2 min | 1-2% | $ |
| **60** | Hybrid 1-4 digits | rockyou + ?d?d?d?d | 14.3M × 10K = 143B | 1-2 min | 3-5% | $ |
| **50** | Hybrid years | rockyou + 19??/20?? | 14.3M × 200 = 2.9B | <1 min | 1-2% | $ |
| **40** | Mask Common | ?u?l?l?l?l?l?d?d | 26×26^5×10^2 = 1.2T | 10-20 min | 2-4% | $$ |
| **30** | Brute 1-6 | ?a?a?a?a?a?a inc | 95^6 = 735B | 30 sec | 0.5-1% | $ |
| **25** | Brute 7 | ?a?a?a?a?a?a?a | 95^7 = 70T | 45 min | 0.3-0.5% | $$$ |
| **20** | Brute 8 | ?a?a?a?a?a?a?a?a | 95^8 = 6.6P | 72+ hours | 0.2-0.3% | $$$$ |

**Legend:** $ = minutes, $$ = hours, $$$ = days, $$$$ = weeks

---

## Recommended Attack Order (Optimized)

Based on success-rate-per-compute-hour:

### Tier 1: High ROI (Run First)
1. **Brute 1-6** - Guaranteed complete coverage of short passwords
2. **best64 + rockyou** - Proven high-yield
3. **Hybrid 1-4 digits** - Common pattern (password1234)
4. **Hybrid years** - Birth years, account years

### Tier 2: Medium ROI
5. **rizzyou + OneRule** - GenZ roots fill rockyou gaps
6. **d3ad0ne rules** - Efficient rule set
7. **Combinator** - Word+word patterns

### Tier 3: Long-Tail
8. **dive rules** - Comprehensive but slow
9. **Mask Common** - Structural patterns
10. **Brute 7** - Include if batch size permits

### Tier 4: Expensive (Consider Skip)
11. **Brute 8** - Only if 7-char yields significant results

---

## Batch-0001 Pilot Plan

### Phase 1: Quick Attacks (Est. 10-15 min total)

```bash
# Attack sequence for batch-0001 (351,124 hashes)

# 1. Brute force 1-6 (exhaustive short passwords)
hashcat -m 100 -a 3 sand-0001.txt ?a?a?a?a?a?a --increment --increment-min=1

# 2. best64 + rockyou
hashcat -m 100 -a 0 sand-0001.txt rockyou.txt -r best64.rule

# 3. Hybrid: rockyou + 1-4 digits
hashcat -m 100 -a 6 sand-0001.txt rockyou.txt ?d
hashcat -m 100 -a 6 sand-0001.txt rockyou.txt ?d?d
hashcat -m 100 -a 6 sand-0001.txt rockyou.txt ?d?d?d
hashcat -m 100 -a 6 sand-0001.txt rockyou.txt ?d?d?d?d

# 4. Hybrid: rockyou + years
hashcat -m 100 -a 6 sand-0001.txt rockyou.txt 19?d?d
hashcat -m 100 -a 6 sand-0001.txt rockyou.txt 20?d?d
```

### Phase 2: Extended Attacks (Est. 30-60 min)

```bash
# 5. GenZ roots + OneRule
hashcat -m 100 -a 0 sand-0001.txt rizzyou.txt -r OneRuleToRuleThemStill.rule

# 6. d3ad0ne rules
hashcat -m 100 -a 0 sand-0001.txt rockyou.txt -r d3ad0ne.rule

# 7. Combinator: rockyou × short words
hashcat -m 100 -a 1 sand-0001.txt rockyou.txt common-short.txt
```

### Phase 3: Deep Attacks (Est. 2-4 hours)

```bash
# 8. dive rules (comprehensive)
hashcat -m 100 -a 0 sand-0001.txt rockyou.txt -r dive.rule

# 9. Common masks
hashcat -m 100 -a 3 sand-0001.txt ?u?l?l?l?l?l?d?d
hashcat -m 100 -a 3 sand-0001.txt ?u?l?l?l?l?l?l?d
```

### Phase 4: Brute Force 7 (Est. 45 min)

```bash
# 10. 7-character exhaustive
hashcat -m 100 -a 3 sand-0001.txt ?a?a?a?a?a?a?a
```

---

## Output Processing

### DIAMONDS Extraction
```bash
# Extract cracked passwords
hashcat -m 100 sand-0001.txt --show | cut -d: -f2 > diamonds-0001.txt
```

### GLASS Creation
```bash
# Get uncracked hashes
hashcat -m 100 sand-0001.txt --left > glass-0001.txt
```

### BETA.txt Generation (New Root Words)

Analyze DIAMONDS to find patterns not in rockyou:

```bash
# 1. Extract base words (remove numbers, specials, case normalize)
cat diamonds-0001.txt | sed 's/[0-9]*$//' | sed 's/^[0-9]*//' | \
  sed 's/[!@#$%^&*()]*$//' | tr '[:upper:]' '[:lower:]' | \
  sort -u > candidates.txt

# 2. Filter out words already in rockyou
comm -23 candidates.txt <(tr '[:upper:]' '[:lower:]' < rockyou.txt | sort -u) > beta-candidates.txt

# 3. Filter to words that appear 3+ times in diamonds
cat diamonds-0001.txt | tr '[:upper:]' '[:lower:]' | \
  grep -oE '[a-z]{4,}' | sort | uniq -c | sort -rn | \
  awk '$1 >= 3 {print $2}' > beta-frequency.txt

# 4. Intersection = BETA.txt
comm -12 beta-candidates.txt beta-frequency.txt > BETA.txt
```

### UNOBTAINIUM.rule Generation (New Rules)

Analyze DIAMONDS transformation patterns:

```bash
# 1. Compare diamonds to base words to infer rules
# Pattern: if "password123!" cracked, the transformation is:
#   password -> password123! = $1$2$3$!

# 2. Common patterns to extract:
#   - Suffix patterns (digits, specials, years)
#   - Prefix patterns
#   - Case transformations
#   - Character substitutions (leetspeak)
#   - Repetition patterns
```

---

## Tool Requirements

Need to create/update:

1. **SandProcessor.ts** - Orchestrate attacks on SAND batches
2. **DiamondAnalyzer.ts** - Extract patterns from cracked passwords
3. **RuleGenerator.ts** - Generate rules from password patterns
4. **BetaExtractor.ts** - Find new root words

---

## Success Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| Crack Rate per Batch | 20-35% | diamonds / (diamonds + glass) |
| New Root Words | 50-200 per batch | BETA.txt unique entries |
| New Rules | 10-50 per batch | UNOBTAINIUM.rule lines |
| Time per Batch | 2-4 hours | Wall clock time |
| Cost Efficiency | >5% per $$ | Crack rate per GPU-hour |

---

## Continuous Improvement Loop

**After EACH batch:**

1. **Measure** - Record actual crack rates per attack
2. **Compare** - Check against projected rates
3. **Analyze** - Run `bun SandProcessor.ts --effectiveness`
4. **Recommend** - Run `bun SandProcessor.ts --recommend`
5. **Propose** - Present changes to user before applying
6. **Dedupe** - Ensure no duplicate entries in BETA.txt or UNOBTAINIUM.rule

### Deduplication Strategy

```bash
# Dedupe BETA.txt against rockyou AND previous BETA entries
sort -u BETA.txt | comm -23 - <(sort rockyou.txt) > BETA-clean.txt

# Dedupe UNOBTAINIUM.rule
sort -u UNOBTAINIUM.rule > UNOBTAINIUM-clean.rule

# Dedupe DIAMONDS against previous cracks
sort -u diamonds-new.txt | comm -23 - <(sort diamonds-master.txt) > diamonds-unique.txt
```

---

## Next Steps

1. ✅ Plan documented
2. ✅ Create SandProcessor.ts tool
3. ✅ Create DiamondAnalyzer.ts tool
4. ⬜ Process batch-0001 as pilot
5. ⬜ Measure actual success rates
6. ⬜ Present findings and recommendations to user
7. ⬜ Adjust attack order based on results
8. ⬜ Scale to remaining batches
