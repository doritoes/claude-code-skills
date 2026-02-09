# Attack Strategies Reference

Comprehensive guide to hash types, attack modes, and cracking strategies for the Hashcrack skill.

---

## ⛔ HASH SPEED TIERS (READ FIRST)

**Hash speed determines worker requirements, attack viability, and expected runtime.**

### Tier 1: FAST (CPU viable, full wordlist)

| Hash Type | Mode | CPU Speed (c5.xlarge) | GPU Speed (T4) | CPU Viable? |
|-----------|------|----------------------|----------------|-------------|
| MD5 | 0 | ~3.8 MH/s | ~2.5 GH/s | ✅ Yes |
| NTLM | 1000 | ~4.0 MH/s | ~3.0 GH/s | ✅ Yes |
| SHA1 | 100 | ~2.5 MH/s | ~1.5 GH/s | ✅ Yes |
| MD4 | 900 | ~4.2 MH/s | ~3.2 GH/s | ✅ Yes |

**Worker sizing:** 2-4 CPU workers sufficient for most jobs.
**Attack strategy:** Full rockyou.txt (~14M words) viable.

### Tier 2: MEDIUM (CPU viable, slower)

| Hash Type | Mode | CPU Speed (c5.xlarge) | GPU Speed (T4) | CPU Viable? |
|-----------|------|----------------------|----------------|-------------|
| SHA256 | 1400 | ~1.2 MH/s | ~500 MH/s | ✅ Yes (2-4x slower) |
| SHA384 | 10800 | ~1.0 MH/s | ~350 MH/s | ✅ Yes (2-4x slower) |
| SHA512 | 1700 | ~800 KH/s | ~300 MH/s | ✅ Yes (3-5x slower) |

**Worker sizing:** 4-8 CPU workers recommended.
**Attack strategy:** Full rockyou.txt viable, expect 2-4x longer runtime.

### Tier 3: SLOW (GPU REQUIRED)

| Hash Type | Mode | CPU Speed (c5.xlarge) | GPU Speed (T4) | CPU Viable? |
|-----------|------|----------------------|----------------|-------------|
| bcrypt | 3200 | ~500 H/s | ~25 KH/s | ❌ No |
| sha512crypt | 1800 | ~200 H/s | ~20 KH/s | ❌ No |
| scrypt | 8900 | ~150 H/s | ~10 KH/s | ❌ No |
| Argon2 | 13700 | ~50 H/s | ~5 KH/s | ❌ No |

**Worker sizing:** GPU REQUIRED for production.
**Attack strategy:** Use top 10K wordlist on CPU, or GPU with full wordlist.

### Tier 3 CPU Reality Check

```
sha512crypt with rockyou (14.3M) on 2 c5.xlarge:
  Time = 14,344,391 / (200 × 2) = 35,860 hours = ~1,494 DAYS

sha512crypt with top10k (10K) on 2 c5.xlarge:
  Time = 10,000 / (200 × 2) = 25 hours = ~1 DAY
```

**Recommendation:** For Tier 3 hashes, either:
1. Use GPU workers (100x+ faster)
2. Use targeted wordlist (top 10K passwords)
3. Accept impractical runtime and archive task

---

## Hash Types

### Common Hash Types

| Type | Hashcat Mode | Example | Source |
|------|--------------|---------|--------|
| MD5 | 0 | `5f4dcc3b5aa765d61d8327deb882cf99` | Web apps, legacy systems |
| SHA1 | 100 | `5baa61e4c9b93f3f0682250b6cf8331b7ee68fd8` | Legacy authentication |
| SHA256 | 1400 | `5e884898da28047d...` | Modern hashing |
| SHA512 | 1700 | `ee26b0dd4af7e749...` | Secure storage |

### Unix/Linux Hashes

| Type | Hashcat Mode | Prefix | Source |
|------|--------------|--------|--------|
| md5crypt | 500 | `$1$` | Legacy Linux |
| sha256crypt | 7400 | `$5$` | Modern Linux |
| sha512crypt | 1800 | `$6$` | Current Linux shadow |
| bcrypt | 3200 | `$2a$`, `$2b$` | Modern web apps |
| yescrypt | N/A | `$y$` | Ubuntu 22.04+ (unsupported) |

**Note**: Ubuntu 22.04+ uses yescrypt by default. Hashcat does not support yescrypt as of 2024. Use SHA512crypt format for compatibility.

### Windows Hashes

| Type | Hashcat Mode | Format | Source |
|------|--------------|--------|--------|
| LM | 3000 | `aad3b435b51404ee` | Legacy Windows (pre-Vista) |
| NTLM | 1000 | `31d6cfe0d16ae931` | Windows SAM, Active Directory |
| NetNTLMv1 | 5500 | `u::d:challenge:response` | Network capture |
| NetNTLMv2 | 5600 | `u::d:challenge:response` | Network capture |

### Network Protocol Hashes

| Type | Hashcat Mode | Source |
|------|--------------|--------|
| Kerberos 5 AS-REP | 18200 | Kerberoasting |
| Kerberos 5 TGS-REP | 13100 | Kerberoasting |
| MSSQL | 131, 132, 1731 | SQL Server |
| MySQL | 300, 7401 | MySQL database |
| PostgreSQL | 12 | PostgreSQL database |

### Application Hashes

| Type | Hashcat Mode | Source |
|------|--------------|--------|
| Cisco IOS | 500, 5700, 9200 | Network devices |
| Juniper | 501 | Juniper devices |
| Office 2016 | 9600 | MS Office encryption |
| PDF | 10400, 10500 | PDF encryption |
| ZIP | 13600 | ZIP archives |
| 7z | 11600 | 7-Zip archives |

## Auto-Detection

The CLI attempts to auto-detect hash types:

```typescript
function detectHashType(hash: string): number | null {
  // Length-based detection
  if (hash.length === 32 && /^[a-f0-9]+$/i.test(hash)) return 0;  // MD5
  if (hash.length === 40 && /^[a-f0-9]+$/i.test(hash)) return 100; // SHA1
  if (hash.length === 64 && /^[a-f0-9]+$/i.test(hash)) return 1400; // SHA256

  // Prefix-based detection
  if (hash.startsWith('$1$')) return 500;   // md5crypt
  if (hash.startsWith('$5$')) return 7400;  // sha256crypt
  if (hash.startsWith('$6$')) return 1800;  // sha512crypt
  if (hash.startsWith('$2a$') || hash.startsWith('$2b$')) return 3200; // bcrypt

  return null; // Require manual specification
}
```

## Attack Modes

### Mode 0: Dictionary Attack

Straight wordlist attack.

```bash
hashcat -a 0 -m 1000 hashes.txt rockyou.txt
```

**Hashtopolis Command**:
```
#HL# -a 0 rockyou.txt
```

### Mode 0 + Rules

Dictionary with rule-based mutations.

```bash
hashcat -a 0 -m 1000 hashes.txt rockyou.txt -r best64.rule
```

**Hashtopolis Command**:
```
#HL# -a 0 -r best64.rule rockyou.txt
```

### Mode 3: Mask Attack

Brute-force with character masks.

```bash
hashcat -a 3 -m 1000 hashes.txt ?u?l?l?l?d?d?d?d
```

**Mask Characters**:
| Mask | Characters |
|------|------------|
| `?l` | a-z (lowercase) |
| `?u` | A-Z (uppercase) |
| `?d` | 0-9 (digits) |
| `?s` | Special characters |
| `?a` | All printable ASCII |

**Hashtopolis Command**:
```
#HL# -a 3 ?u?l?l?l?d?d?d?d
```

### Mode 6: Hybrid Wordlist + Mask

Wordlist with appended mask.

```bash
hashcat -a 6 -m 1000 hashes.txt rockyou.txt ?d?d?d
```

### Mode 7: Hybrid Mask + Wordlist

Mask prepended to wordlist.

```bash
hashcat -a 7 -m 1000 hashes.txt ?d?d?d rockyou.txt
```

## Attack Strategy Phases

The Hashcrack skill runs attacks in phases. **All phases run automatically in sequence.**

### Phase 1: Dictionary Attack

Straight rockyou.txt wordlist - catches common passwords.

```
#HL# -a 0 rockyou.txt
```

**Catches**: `P@$$w0rd`, `password123`, common leaked passwords

---

### Phase 2: Rules Attacks

Comprehensive rule-based mutations to catch variations.

```
# Best66 rules - fast, effective mutations
#HL# -a 0 -r rules/best66.rule rockyou.txt

# Dive rules - deep comprehensive mutations
#HL# -a 0 -r rules/dive.rule rockyou.txt

# Leetspeak rules - character substitutions
#HL# -a 0 -r rules/leetspeak.rule rockyou.txt

# d3ad0ne rules - aggressive mutations
#HL# -a 0 -r rules/d3ad0ne.rule rockyou.txt
```

**Catches**: `Butterfly123!`, `J@sonHouse`, `mi$tyHelp55`, `January2022`

---

### Phase 3: Brute Force (up to 12 characters)

Incremental mask attacks from 1 to 12 characters.

```
# Incremental lowercase (1-12 chars)
#HL# -a 3 --increment --increment-min=1 --increment-max=12 ?l?l?l?l?l?l?l?l?l?l?l?l

# Common patterns
#HL# -a 3 ?u?l?l?l?l?l?l?d?d?d?d      # Ullllldddd (Summer2024)
#HL# -a 3 ?l?l?l?l?l?l?l?l?d?d        # lllllllldd (password99)
#HL# -a 3 ?u?l?l?l?l?l?l?l?l?d        # Ulllllllld (Password1)

# Mixed alphanumeric incremental
#HL# -a 3 --increment --increment-min=1 --increment-max=8 ?a?a?a?a?a?a?a?a
```

**Catches**: `Ewug4`, `ieMuth6`, `covidsucks`, `returnofthejedi`, `sillywombat11`

---

### Phase 4: Hybrid Attacks (Optional)

Combine wordlists with masks for compound passwords.

```
# Wordlist + 2-4 digits appended
#HL# -a 6 rockyou.txt ?d?d
#HL# -a 6 rockyou.txt ?d?d?d?d

# Digits + wordlist prepended
#HL# -a 7 ?d?d?d?d rockyou.txt
```

**Catches**: Passwords like `password2024`, `1234monkey`

## Keyspace Reality Check

Understanding computational limits:

| Length | Charset | Keyspace | Time @ 1 GH/s |
|--------|---------|----------|---------------|
| 6 | lowercase | 308M | 0.3 seconds |
| 8 | lowercase | 208B | 3.5 minutes |
| 8 | mixed case | 53T | 14.8 hours |
| 8 | all printable | 6.6Q | 77 days |
| 10 | lowercase | 141T | 39 hours |
| 10 | all printable | 59Q | 1,900 years |
| 12 | lowercase | 95Q | 3,000 years |

**Conclusion**: Beyond 10-12 characters, brute-force is impractical. Focus on wordlists and intelligent rules.

## Wordlists

### Required Wordlists

Downloaded during Ansible setup:

| Wordlist | Size | Purpose |
|----------|------|---------|
| rockyou.txt | 14M | Primary wordlist |
| 10-million-password-list-top-1000000.txt | 8.5M | Top million passwords |
| xato-net-10-million-passwords.txt | 77M | Large password list |
| darkweb2017-top10000.txt | 100K | Darkweb leaks |

### Rule Files

| Rule File | Rules | Purpose |
|-----------|-------|---------|
| best64.rule | 64 | Fast, high-yield mutations |
| rockyou-30000.rule | 30,000 | Comprehensive mutations |
| OneRuleToRuleThemAll.rule | 52,000 | Most thorough |
| d3ad0ne.rule | 34,000 | Alternative comprehensive |

## Performance Estimates

### By Hash Type (per GPU)

| Hash Type | RTX 3080 | RTX 4090 | CPU (8-core) |
|-----------|----------|----------|--------------|
| MD5 | 64 GH/s | 120 GH/s | 2 GH/s |
| NTLM | 72 GH/s | 135 GH/s | 2.5 GH/s |
| SHA256 | 8 GH/s | 15 GH/s | 400 MH/s |
| SHA512 | 2.5 GH/s | 4.5 GH/s | 100 MH/s |
| sha512crypt | 500 KH/s | 1 MH/s | 20 KH/s |
| bcrypt | 50 KH/s | 100 KH/s | 5 KH/s |

### Scaling with Workers

Linear scaling with worker count:

- 1 worker: 1x speed
- 5 workers: ~4.8x speed (slight overhead)
- 10 workers: ~9.5x speed
- 100 workers: ~95x speed

## Task Configuration

### Chunk Time

Default 600 seconds (10 minutes).

- **Shorter chunks** (300s): Better load balancing, more overhead
- **Longer chunks** (1200s): Less overhead, potential idle workers

### Priority System

Higher values run first.

| Priority | Use Case |
|----------|----------|
| 100+ | Urgent, time-sensitive |
| 50 | Normal tasks |
| 10 | Background, low priority |
| 0 | Paused |

### Max Agents

- `0` = Unlimited (recommended)
- `N` = Limit to N workers (for CPU-only tasks)

## Tiered Attack Escalation Plan (Empirical)

**Based on real-world password strength testing (2026-01-28):**

Testing 3,581 passwords (pre-filtered to remove exact rockyou matches):
- **rockyou+OneRuleToRuleThemStill**: 67% cracked (2,406/3,581)
- **Diminishing returns**: 95%+ of cracks occurred in first 5 minutes
- **Remaining 8-char passwords**: Still vulnerable to mask brute-force

### Escalation Decision Tree

```
START: Hash file received
    │
    ├─► PHASE 1: Straight Wordlist (rockyou)
    │   └─► Expected: 20-30% of weak passwords
    │   └─► Time: ~4 seconds per worker (MD5)
    │   └─► GATE: Continue if uncracked > 0
    │
    ├─► PHASE 2: Rules Attack (rockyou + best64 or OneRule)
    │   └─► Expected: Additional 40-50% (cumulative 60-70%)
    │   └─► Time: Variable (monitor diminishing returns)
    │   └─► GATE: Stop when <10 new cracks per 2 minutes
    │
    ├─► PHASE 3: Short Password Brute Force (≤8 chars)
    │   └─► Extract uncracked hashes
    │   └─► Run targeted masks on remaining short passwords
    │   └─► Expected: Catches weak short passwords missed by rules
    │   └─► Time: ~35 min for 62^8 keyspace (4x T4 GPU, MD5)
    │
    └─► PHASE 4: Extended Attacks (optional)
        └─► Hybrid attacks, larger wordlists, custom masks
        └─► Only if high-value target justifies compute cost
```

### Diminishing Returns Monitoring

**CRITICAL:** Most cracks happen early due to:
1. Common passwords appear at start of rockyou
2. Popular rule transformations fire early in rule files
3. Keyspace coverage increases linearly but crack rate drops exponentially

**Monitoring Query:**
```sql
-- Run every 2 minutes during attack
SELECT
  COUNT(*) as total_cracked,
  (SELECT COUNT(*) FROM Hash WHERE isCracked=1 AND
   crackPos > (SELECT MAX(crackPos) - 1000 FROM Hash WHERE isCracked=1)) as recent_cracks
FROM Hash WHERE isCracked=1;
```

**Decision Gates:**
| Recent Cracks (2 min) | Action |
|-----------------------|--------|
| > 100 | Continue current phase |
| 10-100 | Continue, but prepare next phase |
| < 10 | Move to next phase |
| 0 | Stop or escalate to targeted attacks |

### Post-Rule 8-Character Brute Force Strategy

After rule attacks complete, remaining 8-char passwords are high-value targets:

**Step 1: Extract remaining short passwords**
```sql
SELECT hash FROM Hash WHERE isCracked=0
AND hashlistId IN (SELECT hashlistId FROM Hashlist WHERE hashTypeId = 0);
-- Then filter locally by original password length if known
```

**Step 2: Targeted Masks for 8-char passwords**

| Pattern | Mask | Keyspace | Time (4x T4, MD5) |
|---------|------|----------|-------------------|
| CamelCase | `?u?l?l?l?l?l?l?l` | 8B | ~0.3 sec |
| Mixed + digits | `?u?l?l?l?l?l?d?d` | 2.6B | ~0.1 sec |
| Full alphanumeric | `?1?1?1?1?1?1?1?1` (-1 ?l?u?d) | 218T | ~35 min |
| With special | `?a?a?a?a?a?a?a?a` | 6.6Q | ~18 hours |

**Recommended 8-char attack sequence:**
```
#HL# -a 3 ?u?l?l?l?l?l?l?l                    # CamelCase (most common)
#HL# -a 3 ?l?l?l?l?l?l?l?l                    # All lowercase
#HL# -a 3 ?u?l?l?l?l?l?l?d                    # CamelCase + digit
#HL# -a 3 ?u?l?l?l?l?l?d?d                    # CamelCase + 2 digits
#HL# -a 3 -1 ?l?u?d ?1?1?1?1?1?1?1?1          # Full mixed (longer)
```

### Password Strength Tiers (Post-Analysis)

Use this classification for password audit reports:

| Tier | Definition | Attack Survived |
|------|------------|-----------------|
| **WEAK** | In rockyou.txt | None |
| **LOW** | Cracked by straight wordlist | - |
| **MEDIUM** | Cracked by wordlist+rules | Straight wordlist |
| **STRONG** | 8 chars, survived rules | Rules (but brute-forceable) |
| **HARD** | 9+ chars, survived rules | Rules + practical brute force |
| **RESISTANT** | 12+ chars, complex, survived all | All practical attacks |

**Empirical Distribution (from 4,836 test passwords):**
- WEAK: 26% (1,255) - exact rockyou matches
- MEDIUM: 50% (2,406) - cracked by rules
- STRONG: 0.7% (35) - 8 chars, survived rules
- HARD: 24% (1,140) - 9+ chars, survived rules

---

## Sample Attack Plans

### NTLM from Domain Dump

```javascript
const tasks = [
  { name: "NTLM-rockyou", cmd: "#HL# -a 0 rockyou.txt", priority: 100 },
  { name: "NTLM-rockyou+rules", cmd: "#HL# -a 0 -r best64.rule rockyou.txt", priority: 90 },
  { name: "NTLM-masks", cmd: "#HL# -a 3 ?u?l?l?l?l?l?d?d?d?d", priority: 80 },
  { name: "NTLM-heavy", cmd: "#HL# -a 0 -r OneRuleToRuleThemAll.rule rockyou.txt", priority: 50 }
];
```

### Linux Shadow File

```javascript
const tasks = [
  { name: "SHA512-rockyou", cmd: "#HL# -a 0 rockyou.txt", priority: 100 },
  { name: "SHA512-top1m", cmd: "#HL# -a 0 10-million-password-list-top-1000000.txt", priority: 90 },
  { name: "SHA512-rules", cmd: "#HL# -a 0 -r rockyou-30000.rule rockyou.txt", priority: 50 }
];
```

### bcrypt (Slow Hash)

Focus on small wordlists - bcrypt is intentionally slow.

```javascript
const tasks = [
  { name: "bcrypt-top10k", cmd: "#HL# -a 0 darkweb2017-top10000.txt", priority: 100, isCpuTask: false },
  { name: "bcrypt-common", cmd: "#HL# -a 0 10-million-password-list-top-100000.txt", priority: 90 }
];
```

### Password Strength Audit (Tiered Escalation)

Comprehensive audit with diminishing returns monitoring. Uses parallel hash splitting for rule attacks.

```javascript
// Phase 1: Straight wordlist (parallel, all workers)
const phase1 = [
  { name: "P1-rockyou", cmd: "#HL# -a 0 rockyou.txt", priority: 100 }
];

// Phase 2: Rules attack (split hashes for parallelism, maxAgents=1 per task)
// For 4 workers: split hashes into 4 hashlists, create 4 tasks
const phase2 = [
  { name: "P2-rules-chunk0", cmd: "#HL# rockyou.txt -r OneRuleToRuleThemStill.rule", priority: 90, maxAgents: 1 },
  { name: "P2-rules-chunk1", cmd: "#HL# rockyou.txt -r OneRuleToRuleThemStill.rule", priority: 90, maxAgents: 1 },
  { name: "P2-rules-chunk2", cmd: "#HL# rockyou.txt -r OneRuleToRuleThemStill.rule", priority: 90, maxAgents: 1 },
  { name: "P2-rules-chunk3", cmd: "#HL# rockyou.txt -r OneRuleToRuleThemStill.rule", priority: 90, maxAgents: 1 }
];

// Phase 3: 8-char brute force (run AFTER extracting uncracked 8-char passwords)
const phase3 = [
  { name: "P3-8char-camel", cmd: "#HL# -a 3 ?u?l?l?l?l?l?l?l", priority: 80 },
  { name: "P3-8char-lower", cmd: "#HL# -a 3 ?l?l?l?l?l?l?l?l", priority: 79 },
  { name: "P3-8char-mixed", cmd: "#HL# -a 3 -1 ?l?u?d ?1?1?1?1?1?1?1?1", priority: 70 }
];
```

**Monitoring Script (run during Phase 2):**
```bash
# Check every 2 minutes, stop when <10 new cracks
PREV=0
while true; do
  sleep 120
  CRACKED=$(mysql ... -sNe "SELECT COUNT(*) FROM Hash WHERE isCracked=1;")
  DELTA=$((CRACKED - PREV))
  echo "[$(date)] Cracked: $CRACKED (+$DELTA)"
  [ "$DELTA" -lt 10 ] && echo "Diminishing returns - move to Phase 3" && break
  PREV=$CRACKED
done
```
