# Brute-8 Password Analysis (2026-02-07)

## Executive Summary

Analysis of 65,758 passwords cracked by brute-8 attack on SAND batch-0001 reveals that **SAND passwords are fundamentally different from dictionary-based passwords**. They are high-entropy random strings that cannot be cracked by rules.

**Key Finding:** Lowercase + digits accounts for **52.7%** of all cracks - these are random alphanumeric strings, not word+number patterns.

## Statistics

| Metric | Value |
|--------|-------|
| Total cracked (hashlist 1575) | 65,758 |
| Previous DIAMONDS (attacks 1-7) | 23,295 |
| **New from brute-8** | **42,515** |
| Progress at analysis | 46.1% |
| Projected total when complete | ~90,000 |

## Length Distribution

| Length | Count | % | Notes |
|--------|-------|---|-------|
| **8 chars** | **44,137** | **67.1%** | Brute-8 target |
| 7 chars | 8,636 | 13.1% | Caught by brute-7 |
| 6 chars | 7,307 | 11.1% | Caught by brute-6 |
| 5 chars | 980 | 1.5% | Caught by brute-5 |
| 4 chars | 142 | 0.2% | Caught by brute-4 |
| 9+ chars | 2,556 | 3.9% | Overflow from other attacks |

## Character Class Analysis

| Type | Count | % | Example |
|------|-------|---|---------|
| **Lowercase + digits** | **34,684** | **52.7%** | `7eknr2rq`, `c4w3wr72` |
| Pure lowercase | 13,997 | 21.3% | `gyledyzy`, `motnufrj` |
| With symbols | 8,434 | 12.8% | `Zi_Zi120`, `pr0$pero` |
| Mixed case (no digits) | 4,299 | 6.5% | `gTyJoWct`, `rIrNhRVV` |
| Pure numeric | 1,170 | 1.8% | `12345678` |
| Pure uppercase | 596 | 0.9% | `AHANEKOM`, `RBKTH123` |

### The 52.7% Lowercase+Digits Finding

This is the most significant insight. Over half of SAND passwords are:
- 8 characters
- Only lowercase letters and digits
- **Random distribution** (not word+suffix patterns)

Examples from the dataset:
```
7eknr2rq    c4w3wr72    p7zr3iyq    6t3s0u7i
zhcuv7f8    kx5ct96k    cg28279p    lq9024fv
d28173ae    f6231af2    9v3mj3ao    7jixnylg
```

These are NOT dictionary words with numbers appended. They are:
1. System-generated passwords
2. Random password generator output
3. Hex/base36 encoded values
4. Foreign transliterations that look random to English analysis

## Why Rules Cannot Crack These

### No Dictionary Roots

Word root analysis found almost no recognizable words:
- Only 5 instances of "dan"
- Only 4 instances of "get"
- 99%+ have no recognizable English root

### Mixed Entropy Throughout

Unlike `password123` (word + suffix), these have digits interleaved:
```
p7zr3iyq   (digit at position 2, 5)
c4w3wr72   (digits at 2, 4, 7, 8)
6t3s0u7i   (digits at 1, 3, 5, 7)
```

No rule can transform a dictionary word into these patterns.

### Comparison: What Rules CAN Crack

Rules work on structured passwords:
```
Password1    → "password" + capitalize + append "1"
Summer2023   → "summer" + capitalize + append "2023"
monkey!@#    → "monkey" + append "!@#"
```

But SAND passwords have no base word to transform.

## Structured Patterns (Minor)

Some passwords DO have structure, but they're a small minority:

| Pattern | Count | % of New | Hashcat Mask |
|---------|-------|----------|--------------|
| Cap + 7 lower | 1,049 | 2.5% | `?u?l?l?l?l?l?l?l` |
| 6 lower + 2 digits | 1,216 | 2.9% | `?l?l?l?l?l?l?d?d` |
| 5 lower + 3 digits | 417 | 1.0% | `?l?l?l?l?l?d?d?d` |
| 4 lower + 4 digits | 779 | 1.8% | `?l?l?l?l?d?d?d?d` |
| Cap + 5 lower + 2 digits | 539 | 1.3% | `?u?l?l?l?l?l?d?d` |
| **Total structured** | **~4,000** | **~9%** | - |

We already have masks for most of these (`mask-lllllldd`, `mask-Ullllldd`).

## Symbol Analysis

| Symbol | Count | Position |
|--------|-------|----------|
| @ | 2,370 | Often middle |
| _ | 1,648 | Often separator |
| - | 1,557 | Often separator |
| ! | 1,459 | Often end |
| . | 1,200 | Often separator |
| $ | 1,099 | Often end |

Symbol at end: 3,027 (36% of symbol passwords)
Symbol at start: 952 (11% of symbol passwords)

## Recommendations

### For SAND Processing

1. **Keep brute-8 in pipeline** - it's the only way to crack 50%+ of SAND
2. **Brute-7 + Brute-8 = 70%+ of SAND cracks** - these are essential
3. **Consider brute-9 for GLASS** - if budget allows, extends the winning strategy

### For Rule Development

1. **No new rules needed for SAND** - the passwords are fundamentally random
2. **Focus rule development on GRAVEL (Stage 1)** - that's where words live
3. **The feedback loop (unobtainium.rule) should focus on PEARL analysis**, not DIAMOND

### New Masks (Minor Gains)

If adding masks, these would help slightly:
```bash
# 5 lower + 3 digits (417 potential hits per batch)
?l?l?l?l?l?d?d?d

# 4 lower + 4 digits (779 potential hits per batch)
?l?l?l?l?d?d?d?d

# But these only find ~1,200 passwords vs brute-8's 42,000+
```

## Key Insight for Future Work

**SAND = System-Generated Passwords**

The passwords that survive rockyou + OneRule + all dictionary attacks are NOT human-created passwords. They are:

1. **Password manager output** (random generators)
2. **System-assigned credentials** (auto-generated)
3. **API keys / tokens** (hex, base64, etc.)
4. **Foreign language passwords** (transliterated, look random)

This explains why:
- Brute force dominates SAND (70%+ of cracks)
- Dictionary attacks fail (<1% ROI on SAND)
- Rules are ineffective (no word roots to transform)

## Data Files

Analysis performed on:
- Hashlist ID: 1575
- Batch: SAND-batch-0001
- Attack: brute-8 (8-character exhaustive)
- Date: 2026-02-07
- Progress: 46.1% at time of analysis
