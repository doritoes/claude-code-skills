# PACK-Style Analysis: DIAMONDS batch-0001 (2026-02-07)

## Overview

Manual PACK-style analysis of 23,295 cracked passwords from SAND batch-0001.
Goal: Identify optimal rules and compare with existing nocap.rule and unobtainium.rule.

## Top 30 Masks (Hashcat Format)

| Count | % | Mask | Pattern Description |
|-------|---|------|---------------------|
| 1,216 | 5.22% | `?l?l?l?l?l?l?d?d` | 6 lower + 2 digits |
| 987 | 4.24% | `?d?d?d?d?d?d?d?d?d?d` | 10 pure digits |
| 689 | 2.96% | `?u?l?l?l?l?l?l?l?d` | Cap + 7 lower + 1 digit |
| 655 | 2.81% | `?l?l?l?l?l?l?l` | 7 pure lowercase |
| 539 | 2.31% | `?u?l?l?l?l?l?d?d` | Cap + 5 lower + 2 digits |
| 432 | 1.85% | `?l?l?l?l?l?l?d?d?d?d` | 6 lower + 4 digits |
| 347 | 1.49% | `?l?l?l?l?l?l` | 6 pure lowercase |
| 273 | 1.17% | `?l?l?l?l?l?l?l?d?d?d?d` | 7 lower + 4 digits |
| 262 | 1.12% | `?l?l?l?l?l?l?d` | 6 lower + 1 digit |
| 259 | 1.11% | `?l?l?l?l?l?d?d?d?d` | 5 lower + 4 digits |

**Key Insight:** Top 10 masks cover only ~24% of passwords - high diversity in patterns.

## Password Pattern Categories

| Count | % | Category |
|-------|---|----------|
| 5,258 | 22.57% | Other (complex patterns) |
| 4,578 | 19.65% | Mixed case + digits |
| 3,774 | 16.20% | Lowercase + digit suffix |
| 3,423 | 14.69% | Contains symbol |
| 2,010 | 8.63% | Mixed case only |
| 1,769 | 7.59% | Capitalized + digits |
| 1,180 | 5.07% | Pure numeric |
| 1,015 | 4.36% | Pure lowercase |
| 288 | 1.24% | Pure UPPERCASE |

## Digit Suffix Analysis

### Suffix Length Distribution
| Count | Pattern |
|-------|---------|
| 3,883 | 4-digit suffix |
| 3,395 | 1-digit suffix |
| 2,803 | 2-digit suffix |
| 834 | 3-digit suffix |
| 761 | Symbol suffix |

### Top Single-Digit Suffixes
| Count | Digit |
|-------|-------|
| 876 | 1 |
| 363 | 2 |
| 298 | 8 |
| 293 | 7 |
| 273 | 9 |

### Top Double-Digit Suffixes
| Count | Digits |
|-------|--------|
| 77 | 88 |
| 75 | 12 |
| 58 | 22 |
| 55 | 11 |
| 43 | 69 |
| 42 | 33 |

## Year Suffix Analysis

**Surprisingly rare:** Only 29 passwords end with years (1950-2029)
- This contradicts common assumptions about year suffixes
- May indicate SAND passwords are more random than typical breach data

## Interleaved Digit Pattern

**Critical Finding:** 7,432 passwords (31.9%) have interleaved digits
- Pattern: letter-digit-letter (e.g., `a1b2c3d4`)
- These CANNOT be cracked with simple suffix rules
- Indicates system-generated or random passwords

### Digit Position Distribution
| Position | Count |
|----------|-------|
| End | 30,268 |
| Middle | 13,155 |
| Start | 10,624 |

## Current UNOBTAINIUM.rule (19 rules)

```
c                    # Capitalize first
l                    # Lowercase all
u                    # Uppercase all
$1 $2 $3 $5 $7       # Single digit appends
$8$8 $1$1 $2$2 ...   # Double digit appends
sa@ se3 si1 so0      # Leetspeak
```

## Recommended New Rules

### Based on Analysis

```hashcat
# HIGH PRIORITY - Based on top masks

# 2-digit suffixes (2,803 passwords)
$0 $0
$1 $2
$2 $1
$6 $9

# 4-digit suffixes (3,883 passwords)
$1 $2 $3 $4
$0 $0 $0 $0

# Capitalized patterns (1,769 passwords)
c $1
c $1 $2
c $1 $2 $3
c $1 $2 $3 $4

# MEDIUM PRIORITY - Mixed patterns

# Toggle case variants
t
T0
T1

# Reverse + append
r $1

# Duplicate + digit
d $1

# Symbol suffixes (761 passwords)
$!
$@
$#
$1 $!
$1 $@

# LOW PRIORITY - Interleaved (requires mask attack)
# Cannot be done with rules - need hybrid attacks
```

## Comparison: UNOBTAINIUM vs Optimal

| Covered by UNOBTAINIUM | Missing from UNOBTAINIUM |
|------------------------|--------------------------|
| Single digit append | 4-digit suffix patterns |
| Double same-digit | Toggle rules (t, T0, T1) |
| Basic case transforms | Capitalize + digit combos |
| Leetspeak basics | Symbol appends |

## Key Findings

1. **31.9% interleaved digits** - Rules alone can't crack these
2. **22.57% "other"** - Complex patterns need more analysis
3. **Year suffixes rare** - Only 0.12% use years (unexpected)
4. **Top 10 masks = 24%** - High diversity, no single dominant pattern
5. **4-digit suffix most common** - But UNOBTAINIUM only has 2-digit rules

## Recommendations

1. **Expand UNOBTAINIUM.rule** with 4-digit suffix patterns
2. **Add capitalized + digit combos** (c $1, c $1 $2, etc.)
3. **Add symbol suffixes** ($!, $@, $#)
4. **Consider hybrid attacks** for interleaved digit patterns
5. **Don't rely heavily on year suffixes** - data shows they're rare in SAND

## Files

- Source: `data/diamonds/batch-0001.txt`
- Current rules: `data/feedback/unobtainium.rule`
- Analysis date: 2026-02-07
