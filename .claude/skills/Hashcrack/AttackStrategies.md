# Attack Strategies Reference

Comprehensive guide to hash types, attack modes, and cracking strategies for the Hashcrack skill.

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
