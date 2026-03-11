# Password Length Distribution — Published Research

## Why This Matters

No published study provides a full cleartext length distribution of HIBP specifically,
because HIBP only distributes hashes. Our cracked subset (14.5M+ passwords from 175 batches)
is one of the larger HIBP plaintext datasets in existence. Published research on other
breach compilations provides baseline expectations for what the "true" distribution looks like.

## Published Studies

### Cybernews 2025 — 19 Billion Passwords (1.14B unique)
- Source: https://cybernews.com/security/password-leak-study-unveils-2025-trends-reused-and-lazy/
- Dataset: 213 GB, 19,030,305,929 passwords, 1,143,815,266 unique
- **8-10 chars: 42%** (most popular range)
- **15+ chars: 3.3%**
- 27% lowercase letters + digits only
- 20% mixed case + numbers, no special chars
- 94% reused/duplicated, only 6% unique

### Specops 2026 — 6 Billion Stolen Passwords
- Source: https://specopssoft.com/our-resources/most-common-passwords/
- PDF: https://marketing.outpost24.com/hubfs/BreachedPasswordsReport_Updated_Final_EN.pdf
- Blog: https://specopssoft.com/blog/new-research-6-billion-compromised-passwords-2026/
- Dataset: 4.4B+ passwords analyzed from malware-stolen credentials (Jan-Dec 2025)
- Absolute counts at specific lengths:
  - 9-char: 882 million
  - 10-char: 925 million
  - 11-char: 672 million
- Full percentage breakdown in PDF report (not freely summarized)

### Specops 2025 — RDP Attack Passwords
- Source: https://specopssoft.com/wp-content/uploads/2026/01/2025-Breached-Password-Report_EN.pdf
- 4.6M passwords used in live RDP attacks
- Most common length: **8 characters (24%)**

### Historical Trend (2009 → 2024)
- Source: https://www.demandsage.com/password-statistics/
- <8 chars: **33% (2009) → 10% (2024)**
- 16+ chars: **0.85% (2009) → 3% (2021) → ~7% (2024)**
- Average password: 9.6 chars (1.1 upper, 6.1 lower, 2.2 digits, 0.2 special)

### Self-Reported (US Users)
- 6 in 10 Americans: passwords 8-11 chars
- 2 in 10: passwords 12+ chars

## Our Data (HIBP Cracked Subset)

As of 2026-03-10, 175 batches processed (87.5M rocks):

| Length | Count | Share | Notes |
|--------|---------|-------|-------|
| 8 | 6,887,310 | 47.6% | Inflated by thin/brute-8 masks targeting 8-char |
| 9 | 1,220,990 | 8.4% | |
| 10 | 1,459,336 | 10.1% | |
| 11 | 1,016,205 | 7.0% | |
| 12 | 495,250 | 3.4% | |
| 13-15 | 383,069 | 2.6% | Dict+rules only |
| 16+ | 34,937 | 0.2% | Word+digits patterns |

**Important**: Our distribution is NOT representative of HIBP's true distribution.
It reflects what our attack pipeline can crack. The 8-char dominance (47.6% vs
Cybernews' 42% for 8-10 combined) is an artifact of dedicated 8-char mask attacks
(mask-l8, mask-ld8, mask-lud8 thin, brute-8). Longer passwords are underrepresented
because we lack dedicated attacks for 9+ char patterns.

## Long Numeric Password Analysis (2026-03-11)

### Overview

1,332,116 pure-digit passwords at 9+ chars recovered from 215 batches.
These are overwhelmingly phone numbers, with some ID numbers and digit sequences.

### Length Distribution

| Length | Count | Share | Dominant pattern |
|--------|---------|-------|-----------------|
| 9 | 55,544 | 4.2% | Short phone numbers |
| 10 | 620,827 | 46.6% | Phone numbers (10-digit national format) |
| 11 | 499,860 | 37.5% | Phone numbers with country code |
| 12 | 150,505 | 11.3% | Extended phone/ID numbers |
| 13+ | 5,380 | 0.4% | IDs, repeated digits, counting sequences |

### Phone Number Patterns (10-11 char)

Top country/region indicators by first 2 digits:

| Prefix | Count | Share | Region |
|--------|---------|-------|--------|
| 13x | 94,034 | 8.4% | China mobile |
| 89x | 80,641 | 7.2% | Russia mobile |
| 01x | 52,488 | 4.7% | Japan/UK landline |
| 09x | 47,459 | 4.2% | Philippines/Taiwan/Iran mobile |
| 98x | 40,821 | 3.6% | Iran (+98) |
| 15x | 33,520 | 3.0% | China mobile |
| 79x | 29,110 | 2.6% | Russia mobile |
| 05x | 29,495 | 2.6% | Italy/Turkey mobile |
| 07x | 22,858 | 2.0% | UK mobile |
| 90x | 23,380 | 2.1% | Turkey (+90) |

Phone-as-password is a **global** phenomenon — not limited to any region.

### Digit Sequence Patterns

Counting sequences that look random at a glance but have trivial entropy:

| Pattern | Example | How it works |
|---------|---------|-------------|
| Sequential pairs | `70717273747576` | Count: 70, 71, 72, 73, 74, 75, 76 |
| Counting from 1 | `12345678910111213` | Concatenated integers 1-13 |
| Zero-padded counting | `010203040506070809` | 01, 02, 03, ... 09 |
| Repeated digit runs | `77777777777777777` | Single key held down |
| Repeated groups | `123456789123456789` | Pattern repeated |
| Near-sequential | `13579111315171921` | Odd numbers concatenated |

These bypass blacklists (no dictionary word) and complexity checkers (all-digit is
valid under many policies), but entropy is just start_number + length.

### Predicted Patterns Under Modern Policies (12+ char, 3-of-4 classes)

When forced to use 12+ chars with complexity, users adapt numeric patterns minimally:

**Phone number + complexity suffix/prefix:**
```
09848140001!       # phone + special
My09848140001      # word + phone (satisfies upper + lower + digit)
07850918120!       # UK mobile + bang
Call07850918120    # prefix + phone
1338575400Aa!      # China mobile + complexity chars
```

**Sequential pairs + complexity:**
```
Aa70717273747576   # upper + lower prefix + counting
70717273747576!    # counting + special
A7071727374!       # truncated counting + complexity
Count123456789!    # word + counting
```

**Counting sequences + complexity:**
```
Abc12345678910     # word prefix + counting (12+ chars easy)
12345678910!Ab     # counting + complexity suffix
One2three4five6    # mixed word-number counting
0102030405!Aa      # zero-padded + complexity
```

**Phone number as base + corporate patterns:**
```
Phone5551234!      # "Phone" + number + special
5551234@Work       # number + special + word
MyNumber5551234    # compound word + digits
555-1234-Pass!     # formatted phone + word (if hyphens allowed)
```

**Repeated/simple + compliance dressing:**
```
Aaaaaaaaaaaa1!     # repeated char + digit + special (12 chars)
111111111111Aa!    # digit run + complexity (15 chars)
Qqqqqqqqqq1!       # repeated + digit + special (12 chars)
99999999999!Ab     # digit run + complexity
```

**Date-based numeric extensions:**
```
19851225Merry!     # birthdate + word + special
01Jan1990Pass!     # formatted date + word
20260311Today!     # today's date + word
199019901990Ab!    # repeated year + complexity
```

### Implications for Attack Strategy

1. **mask-d10 through mask-d12 already catch** raw phone numbers (2 seconds each).
   These are cheap and high-yield.

2. **Hybrid attacks catch phone+suffix** — `hybrid-nocapplus-3any` and similar
   already cover patterns like `phone + !Ab`. These are productive.

3. **UNCOVERED: prefix + phone** — reverse hybrids (`-a 7`) with digit masks
   would catch `Call0785091812` or `My1338575400`. Currently only
   `reverse-nocapplus-4digit` and `reverse-nocapplus-3digit` exist — no
   reverse with 10+ digit suffixes (too large for mask, need combinator approach).

4. **UNCOVERED: counting sequences** — `70717273747576` cannot be generated by
   any current attack. Would need a custom generator (trivial to write) piped
   into hashcat. Low priority given small count (~5K at 13+ chars), but
   demonstrates the pattern humans use to create "random-looking" long passwords.

5. **For corporate audits** — phone numbers as passwords should be in every
   audit playbook. A 10-digit phone number has ~10B keyspace = 1 second on
   any modern GPU. Even with prefix/suffix, `word + 10 digits` is viable
   with combinator attacks. Recommend: always run mask-d10/d11/d12 early.

## Implications for Research

1. **8-char is over-indexed in our data** — we attack it hardest, so we find the most.
   The "true" HIBP 8-char share is likely closer to 24-30% (Specops RDP data).

2. **9-12 char is the gap** — Cybernews shows 42% of passwords are 8-10 chars.
   Our 9-10 char yield (18.5%) suggests significant uncracked 9-10 char passwords
   remain in GLASS.

3. **13+ char is growing** — from 0.85% (2009) to 7% (2024) at 16+ chars alone.
   Our 2.8% at 13+ is low, likely because we lack phrase/compound attacks at length.

4. **PRINCE processor** would target the 12-16 char passphrase space specifically,
   which published data shows is the fastest-growing segment.

5. **For corporate audit modeling** — real-world policies (12+ min, 3-of-4 classes)
   mean the target population is entirely in the 12+ zone where we have weakest coverage.
