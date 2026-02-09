# SAND Batch-0005 Attack Strategy — FINAL

**Generated:** 2026-02-09 | **Method:** THEALGORITHM (DETERMINED)
**Success Criteria:** Crack rate > 6.45% (batch-0004's rate)
**Constraint:** AWS budget $150/mo. Every compute-hour counts.

---

## What's New in Batch-0005

| Asset | Description | Status |
|-------|-------------|--------|
| **nocap-plus.txt** | nocap.txt + 3,509 new cohort roots (14.35M lines, 147MB) | Ready to upload |
| **nocap.rule** | OneRule + bussin combined (replaces OneRule everywhere) | File ID 10 on Hashtopolis |
| **BETA.txt** | 55 high-signal roots from DIAMOND analysis | File ID 12 on Hashtopolis |
| **UNOBTAINIUM.rule** | 115 rules learned from DIAMONDS | File ID 8/13 on Hashtopolis |
| **Cohort wordlists** | 10,436 names across 6 files (merged into nocap-plus.txt) | Merged |

### Cohort Roots Breakdown (3,509 truly new words)
- Indian names: 3,347 curated (1,802 net new)
- Chinese Pinyin: 2,494 names+combos (687 net new)
- Arabic names: 2,204 curated (518 net new)
- Slavic names: 965 diminutives (234 net new)
- Turkish names: 906 curated (178 net new)
- Culture/Sports/Music: 520 terms (90 net new)

---

## Attack Order (19 attacks, 5 tiers)

### TIER 0: INSTANT (<1 sec)
| # | Attack | Keyspace | Time |
|---|--------|----------|------|
| 1 | brute-1 | 95 | instant |
| 2 | brute-2 | 9K | instant |
| 3 | brute-3 | 857K | <1s |
| 4 | brute-4 | 81M | ~2s |

### TIER 1: HIGH ROI (70.6% of historical cracks)
| # | Attack | Historical | Time |
|---|--------|-----------|------|
| 5 | brute-6 | 32.1% | ~10 min |
| 6 | brute-7 | 38.5% | ~4-6 hrs |

**GATE 1:** If <4% after Tier 1 → STOP (infrastructure problem)

### TIER 2: COHORT + FEEDBACK (NEW — the experiment)
| # | Attack | Wordlist | Rules | Expected |
|---|--------|----------|-------|----------|
| 7 | feedback-beta-nocaprule | BETA.txt (55 roots) | nocap.rule | 0.5-1% |
| 8 | **nocapplus-nocaprule** | nocap-plus.txt (14.35M) | nocap.rule | **1-3%** |
| 9 | nocapplus-unobtainium | nocap-plus.txt | UNOBTAINIUM.rule | 0.2-0.5% |
| 10 | feedback-nocapplus-unobtainium | nocap-plus.txt | unobtainium.rule | 0.1-0.3% |

**GATE 2:** Evaluate Tier 2 yields:
- If nocapplus-nocaprule > 1%: **Lock in for all 157 remaining batches**
- If nocapplus-nocaprule > 0.5%: Keep, but investigate further optimization
- If nocapplus-nocaprule < 0.5%: Cohort roots not effective for SAND; deprioritize

### TIER 3: PROVEN MEDIUM ROI (21.3% of cracks)
| # | Attack | Historical | Notes |
|---|--------|-----------|-------|
| 11 | **hybrid-nocapplus-4digit** | NEW | nocap-plus + ?d?d?d?d (oguz1234) |
| 12 | hybrid-rockyou-4digit | 13.6% | word + 4 digits (proven) |
| 13 | mask-lllllldd | 5.3% | 6 lowercase + 2 digits |
| 14 | brute-5 | 4.1% | 5-char exhaustive |
| 15 | mask-Ullllllld | 2.8% | Capital + 7 lower + 1 digit |

**GATE 3:** ~95% of achievable cracks done. Stop if batch spend > $30.

### TIER 4: LOW ROI (3.4%)
| # | Attack | Historical |
|---|--------|-----------|
| 16 | mask-Ullllldd | 2.4% |
| 17 | hybrid-rockyou-special-digits | 1.0% |

### TIER 5: FEEDBACK MEASUREMENT
| # | Attack | Purpose |
|---|--------|---------|
| 18 | test-unobtainium | Validates feedback loop (expected ~0 cracks) |

---

## Pre-Launch Checklist

### Before VM Power-On
- [x] Upload nocap-plus.txt to Hashtopolis → **file ID 11** (SCP + DB insert)
- [x] Update `SandProcessor.ts` file IDs for nocap-plus (14 → 11)
- [x] Verify nocap.rule is file ID 10 on Hashtopolis
- [x] Verify BETA.txt is file ID 12 on Hashtopolis
- [x] Verify UNOBTAINIUM.rule is file ID 8 on Hashtopolis
- [x] Confirm `useNewBench = 0` (IMMUTABLE — hardcoded in SandProcessor.ts line 628)
- [x] Updated .env with new server IP: 34.221.96.207

### Server File Inventory (verified 2026-02-09)
| File ID | Filename | Size | Type |
|---------|----------|------|------|
| 1 | rockyou.txt | 140MB | wordlist |
| 4 | rizzyou.txt | 1.7KB | wordlist |
| 8 | UNOBTAINUM.rule | 3.7KB | rule |
| 10 | nocap.rule | 487KB | rule |
| 11 | **nocap-plus.txt** | **147MB** | wordlist |
| 12 | **BETA.txt** | **312B** | wordlist |

### On VM Power-On
```bash
# GPU workers are STOPPED — start them when ready to run batch-0005
# Submit batch-0005
bun .claude/skills/ExpandedPasswordList/Tools/SandProcessor.ts --batch 5
```

---

## Expected Outcomes

| Scenario | Cracks | Rate | vs batch-0004 |
|----------|--------|------|---------------|
| **Baseline** (brute + proven only) | ~22,750 | 6.5% | +0.05% |
| **Conservative** (cohort roots marginal) | ~24,500 | 7.0% | **+0.55%** |
| **Target** (cohort roots work) | ~26,600 | 7.6% | **+1.15%** |
| **Optimistic** (full pipeline clicks) | ~31,500 | 9.0% | **+2.55%** |

### Why batch-0005 should beat batch-0004:
1. **3,509 genuinely new roots** not in nocap.txt — names like oguz, kohli, jungkook, wembanyama
2. **nocap.rule > OneRule** — includes bussin.rule patterns (modern years 2015-2026, 3-digit suffixes)
3. **Hybrid nocapplus-4digit** — Turkish/Indian/Arabic names + digit suffixes match real password patterns
4. **UNOBTAINIUM.rule** — 115 rules learned from actual DIAMOND analysis

---

## Feedback Loop (Post-Completion)

After batch-0005 completes:
1. **Collect DIAMONDS** → `DiamondCollector` → `data/diamonds/batch-0005.txt`
2. **Analyze** → `DiamondAnalyzer --full` → updated BETA.txt, cohort-report.md, UNOBTAINIUM.rule
3. **Evaluate** → Compare crack rate vs 6.45% target
4. **Improve** → New cohort discoveries → update nocap-plus.txt
5. **Archive** → `SandArchiver` → mark batch complete in sand-state.json
6. **Feed forward** → batch-0006 inherits all improvements
