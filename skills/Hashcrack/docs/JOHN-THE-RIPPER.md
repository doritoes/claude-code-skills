# John the Ripper Integration

For hash types not supported by hashcat (like yescrypt `$y$`), use John the Ripper. This section covers both local usage and distributed cracking via Hashtopolis.

## Why JtR for Yescrypt?

| Hash Type | Hashcat Support | JtR Support | Notes |
|-----------|-----------------|-------------|-------|
| `$y$` (yescrypt) | **Not supported** | `--format=crypt` | Ubuntu 24.04+ default |
| `$7$` (scrypt) | **Not supported** | `--format=crypt` | Memory-hard |
| `$6$` (SHA512crypt) | Mode 1800 | `--format=sha512crypt` | Use hashcat for speed |
| `$5$` (SHA256crypt) | Mode 7400 | `--format=sha256crypt` | Use hashcat for speed |

**Key insight**: Yescrypt is memory-hard and CPU-bound. GPU acceleration provides minimal benefit, making distributed CPU cracking via JtR viable.

## Installation

```bash
# Ubuntu/Debian - jumbo version required for full format support
sudo apt install john

# Verify yescrypt support
john --list=formats | grep -i crypt

# macOS
brew install john-jumbo

# From source (bleeding-edge features)
git clone https://github.com/openwall/john.git
cd john/src && ./configure && make -s clean && make -sj4
```

## Local Usage (Single Machine)

```bash
# Basic wordlist attack on yescrypt
john --wordlist=rockyou.txt --format=crypt shadow.txt

# With rules (JtR equivalent of OneRuleToRuleThemAll)
john --wordlist=rockyou.txt --rules=Jumbo --format=crypt shadow.txt

# Check progress
john --status

# Show cracked passwords
john --show shadow.txt

# Using multiple CPU cores
john --wordlist=rockyou.txt --rules=Jumbo --format=crypt --fork=8 shadow.txt
```

## JtR Rules Equivalent to Hashcat Rules

| Hashcat Rule | JtR Equivalent | Description |
|--------------|----------------|-------------|
| best64.rule | `--rules=best64` | Fast common mutations |
| OneRuleToRuleThemAll.rule | `--rules=Jumbo` | Comprehensive ruleset |
| d3ad0ne.rule | `--rules=d3ad0ne` | Popular ruleset |
| rockyou-30000.rule | `--rules=rockyou-30000` | Large ruleset |
| toggles1-5.rule | `--rules=NT` | Case toggling |

## Distributed JtR via Hashtopolis

Hashtopolis is designed for hashcat, but JtR can be integrated via a **wrapper script** that translates the Generic Cracker interface.

### Architecture

```
Hashtopolis Server
       │
       ├── Worker 1 → jtr_wrapper.py → john
       ├── Worker 2 → jtr_wrapper.py → john
       └── Worker N → jtr_wrapper.py → john
```

### The Wrapper Script Approach

The wrapper (`scripts/jtr_wrapper.py`) translates Hashtopolis commands:

| Hashtopolis Command | JtR Translation |
|---------------------|-----------------|
| `keyspace --wordlist X --rules Y` | `john --wordlist=X --rules=Y --stdout \| wc -l` |
| `crack --skip N --length M` | `john --stdout \| tail -n +N \| head -n M \| john --stdin` |
| Output format | `hash:plain` → `hash\tplain` |

### Wrapper Script Usage

```bash
# Calculate keyspace for wordlist + rules
python3 jtr_wrapper.py keyspace --wordlist rockyou.txt --rules Jumbo

# Crack with skip/length (for distributed chunks)
python3 jtr_wrapper.py crack \
    --attacked-hashlist shadow.txt \
    --wordlist rockyou.txt \
    --rules Jumbo \
    --skip 1000000 \
    --length 500000 \
    --format crypt

# Benchmark
python3 jtr_wrapper.py benchmark --format crypt
```

### Registering JtR Wrapper in Hashtopolis

1. **Package the wrapper** as a zip/tar.gz with JtR binary
2. **Upload as Cracker Binary** in Hashtopolis UI:
   - Name: `john-wrapper`
   - Binary basename: `jtr_wrapper.py`
3. **Create Cracker Binary Type** for JtR
4. **Create tasks** using the JtR cracker type

```sql
-- Register JtR as cracker type in database
INSERT INTO CrackerBinaryType (typeName, isChunkingAvailable)
VALUES ('john', 1);
SET @jtr_type = LAST_INSERT_ID();

-- Add the wrapper binary
INSERT INTO CrackerBinary (crackerBinaryTypeId, version, downloadUrl, binaryName)
VALUES (@jtr_type, '1.0.0', 'http://SERVER:8080/files/jtr_wrapper.tar.gz', 'jtr_wrapper.py');
```

### JtR-Specific Task Creation

```sql
-- Create task for yescrypt with JtR
INSERT INTO TaskWrapper (priority, maxAgents, taskType, hashlistId, accessGroupId, taskWrapperName, isArchived, cracked)
VALUES (100, 0, 0, @hashlist_id, 1, 'Yescrypt-JtR-Rockyou', 0, 0);
SET @tw = LAST_INSERT_ID();

INSERT INTO Task (
    taskName, attackCmd, chunkTime, statusTimer, keyspace, keyspaceProgress,
    priority, maxAgents, color, isSmall, isCpuTask, useNewBench, skipKeyspace,
    crackerBinaryId, crackerBinaryTypeId, taskWrapperId, isArchived, notes,
    staticChunks, chunkSize, forcePipe, usePreprocessor, preprocessorCommand
)
VALUES (
    'Yescrypt-JtR-Rockyou',
    '--attacked-hashlist #HL# --wordlist rockyou.txt --rules Jumbo --format crypt',
    1800,  -- Longer chunk time for slow yescrypt
    30,
    0, 0,
    100, 0, '#9933FF', 0, 1, 0, 0,
    @jtr_binary_id, @jtr_type, @tw, 0, 'JtR yescrypt attack',
    0, 0, 0, 0, ''
);
```

## JtR Native Distribution (Without Hashtopolis)

JtR has built-in distribution via `--node` and `--fork`:

```bash
# Single machine, 8 cores
john --wordlist=rockyou.txt --rules=Jumbo --format=crypt --fork=8 shadow.txt

# Multi-machine: Machine 1 of 4
john --wordlist=rockyou.txt --rules=Jumbo --format=crypt --node=1/4 shadow.txt

# Multi-machine: Machine 2 of 4
john --wordlist=rockyou.txt --rules=Jumbo --format=crypt --node=2/4 shadow.txt

# Combine fork + node (8 cores each, 4 machines = 32 total cores)
# Machine 1:
john --wordlist=rockyou.txt --rules=Jumbo --format=crypt --fork=8 --node=1-8/32 shadow.txt
# Machine 2:
john --wordlist=rockyou.txt --rules=Jumbo --format=crypt --fork=8 --node=9-16/32 shadow.txt
```

**Limitations of native distribution:**
- No automatic work coordination
- No centralized progress tracking
- Cracked passwords duplicated across nodes
- Manual hash file synchronization required

## Yescrypt Performance Expectations

Yescrypt is intentionally slow (memory-hard design):

| Hardware | Speed (H/s) | Notes |
|----------|-------------|-------|
| Single CPU core | ~50-100 | Baseline |
| 8-core CPU | ~400-800 | Near-linear scaling |
| Modern GPU | ~500-1000 | Minimal GPU benefit |
| 4 workers (8 cores each) | ~1600-3200 | Distributed |

**Time estimates for rockyou + Jumbo rules (~745M candidates):**

| Workers | Cores | Estimated Time |
|---------|-------|----------------|
| 1 | 8 | ~260 hours |
| 4 | 32 | ~65 hours |
| 10 | 80 | ~26 hours |
| 20 | 160 | ~13 hours |

**Recommendation**: For yescrypt, use targeted wordlists first (company-specific, previous cracks), then short rules. Full rockyou + Jumbo is expensive.

## Quick Yescrypt Attack Strategy

1. **Custom wordlist first** - previously cracked passwords
2. **Short targeted wordlist** - common passwords, company-specific
3. **Rockyou without rules** - fast baseline
4. **Rockyou + best64** - efficient mutations
5. **Rockyou + Jumbo** - only if time permits (expensive)

```bash
# Quick wins first
john --wordlist=custom_passwords.txt --format=crypt shadow.txt
john --wordlist=top10000.txt --format=crypt shadow.txt
john --wordlist=rockyou.txt --format=crypt shadow.txt

# Then rules
john --wordlist=rockyou.txt --rules=best64 --format=crypt shadow.txt

# Full attack only if needed
john --wordlist=rockyou.txt --rules=Jumbo --format=crypt --fork=8 shadow.txt
```

## Test Hashes

Sample yescrypt hashes for testing:
```
alpha:$y$j9T$LePQwAJfRJ9UyVre3dlic0$ocu5a/jwj9MPPr1ZrsBfX/0LV5XIA/H8LQu1L9CU1VC:...
bravo:$y$j9T$jnEpW13qBZ9udxUnM4ADI/$ayY9bMxMpi3P68BGnsY0enC/a8TAM9oQ3zK5HXWaQ31:...
```

## Automatic Routing

When processing a shadow file with mixed hash types:
```
ubuntu:$6$...:...   → Hashtopolis (hashcat, distributed)
alpha:$y$...:...    → JtR (local or JtR-Hashtopolis)
```
