# Optimize Workflow

**Status:** Future Work (requires PEARLS from completed cracking runs)

Generate optimized wordlists (GLASS) and rules (UNOBTAINIUM) from cracked passwords.

## Prerequisites

- PEARLS collected from SAND cracking (`data/results/cracked.txt`)
- Minimum ~100K cracked passwords for meaningful analysis
- OneRuleToRuleThemStill.rule for baseline comparison

## GLASS Wordlist Generation

### Goal
Extract the base words from PEARLS that, when transformed by rules, produced the cracked passwords.

### Approach

1. **Reverse Engineering**
   - For each PEARL, attempt to identify the source word + rule
   - If `password123` was cracked, base word might be `password`
   - Track which rules transformed it

2. **Pattern Extraction**
   - Strip common suffixes: numbers, special chars, years
   - Identify l33t-speak reversals: `P@ssw0rd` → `password`
   - Extract keyboard patterns: `qwerty`, `123456`

3. **Frequency Weighting**
   - Use HIBP occurrence counts to prioritize
   - More frequently breached = higher value in wordlist

### Commands (Future)

```bash
# Generate GLASS from PEARLS
bun Tools/GlassExtractor.ts

# Options
bun Tools/GlassExtractor.ts --min-count 10     # Only words from high-frequency PEARLS
bun Tools/GlassExtractor.ts --max-words 100000 # Limit output size
bun Tools/GlassExtractor.ts --analyze          # Show extraction statistics
```

### Output
- `data/wordlists/glass.txt` - Base words sorted by frequency
- `data/wordlists/glass-stats.json` - Extraction statistics

## UNOBTAINIUM Rule Development

### Goal
Create an enhanced rule file that improves on OneRule based on actual crack data.

### Analysis Steps

1. **Rule Yield Analysis**
   - For each OneRule rule, count how many PEARLS it cracked
   - Identify high-yield rules (keep)
   - Identify zero-yield rules (candidates for removal)

2. **Gap Analysis**
   - Find PEARLS that weren't cracked by OneRule + rockyou
   - These were cracked by other methods (combinator, hybrid, etc.)
   - Extract patterns for new rules

3. **Pattern Discovery**
   - Statistical analysis of PEARL structure
   - Common prefix/suffix patterns not in OneRule
   - Regional/language-specific patterns

4. **Rule Optimization**
   - Remove duplicate rules (same output, different path)
   - Merge similar rules
   - Order by yield (most effective first)

### Commands (Future)

```bash
# Analyze OneRule effectiveness against PEARLS
bun Tools/RuleAnalyzer.ts --rule OneRuleToRuleThemStill.rule

# Generate UNOBTAINIUM
bun Tools/UnobtainiumBuilder.ts

# Options
bun Tools/UnobtainiumBuilder.ts --keep-threshold 10   # Keep rules with 10+ cracks
bun Tools/UnobtainiumBuilder.ts --add-patterns        # Add discovered patterns
bun Tools/UnobtainiumBuilder.ts --deduplicate         # Remove redundant rules
```

### Output
- `data/rules/unobtainium.rule` - Optimized rule file
- `data/rules/analysis.json` - Rule effectiveness metrics

## Benchmark Testing

### Goal
Measure improvement of enhanced wordlist + rules vs baseline.

### Test Methodology

1. **Sample Selection**
   - Random 10M hashes from GRAVEL (before any cracking)
   - Same sample for both tests

2. **Baseline Test**
   ```bash
   hashcat -m 100 -a 0 -r OneRuleToRuleThemStill.rule \
     data/benchmark/sample-10m.txt rockyou.txt
   ```

3. **Enhanced Test**
   ```bash
   hashcat -m 100 -a 0 -r data/rules/unobtainium.rule \
     data/benchmark/sample-10m.txt rockyou.txt data/wordlists/glass.txt
   ```

### Metrics

| Metric | Definition |
|--------|------------|
| **Crack Rate** | % of sample cracked |
| **Time to 50%** | Time to crack half of crackable hashes |
| **Unique Cracks** | Passwords cracked by enhanced but not baseline |
| **Rule Efficiency** | Cracks per rule |
| **Keyspace Reduction** | Rules removed without losing cracks |

### Commands (Future)

```bash
# Run full benchmark
bun Tools/BenchmarkRunner.ts

# Options
bun Tools/BenchmarkRunner.ts --sample-size 1000000  # 1M sample
bun Tools/BenchmarkRunner.ts --baseline-only        # Just baseline test
bun Tools/BenchmarkRunner.ts --report               # Generate comparison report
```

### Output
- `data/benchmark/baseline-results.txt` - Baseline cracked passwords
- `data/benchmark/enhanced-results.txt` - Enhanced cracked passwords
- `data/benchmark/comparison.md` - Side-by-side analysis

## Expected Improvements

Based on similar research:

| Metric | Estimated Improvement |
|--------|----------------------|
| Crack rate | +5-15% |
| Time to 50% | -20-40% |
| Rule file size | -30-50% (removing duds) |

## Dependencies

- Hashcat or Hashcrack skill for cracking tests
- PEARLS data from completed SAND cracking
- Original rockyou.txt and OneRule for baseline

## Related Workflows

- `Crack.md` - Initial GRAVEL cracking
- `CrackingPipeline.md` - SAND cracking phases
- `Collect.md` - Collecting PEARLS
