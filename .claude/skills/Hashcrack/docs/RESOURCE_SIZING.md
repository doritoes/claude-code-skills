# Resource Sizing Strategy Guide

**Purpose:** Provide actionable guidance for predicting worker counts, instance types, and expected runtimes before deployment.

---

## ⛔ QUICK DECISION MATRIX

| Hash Type | Count | Attack | Workers | Instance | Expected Time |
|-----------|-------|--------|---------|----------|---------------|
| Fast (MD5/SHA1/NTLM) | <100 | Straight | 2 CPU | c5.xlarge | <5 min |
| Fast (MD5/SHA1/NTLM) | 100-1K | Straight | 2-4 CPU | c5.xlarge | 5-30 min |
| Fast (MD5/SHA1/NTLM) | 1K-10K | Straight | 4-8 CPU | c5.xlarge | 30-120 min |
| Medium (SHA256) | Any | Straight | 2-4x above | c5.xlarge | 2-4x above |
| Slow (bcrypt/sha512crypt) | Any | Straight | GPU REQUIRED | g4dn.xlarge | See GPU section |
| Any | Any | Rule | N/A | N/A | See Rule Attack section |

---

## Hash Type Speed Tiers

### Tier 1: FAST (Full wordlist viable)

| Hash Type | Hashcat Mode | CPU Speed (c5.xlarge) | GPU Speed (T4) | Multiplier |
|-----------|--------------|----------------------|----------------|------------|
| MD5 | 0 | ~3.8 MH/s | ~2.5 GH/s | 650x |
| SHA1 | 100 | ~2.5 MH/s | ~1.5 GH/s | 600x |
| NTLM | 1000 | ~4.0 MH/s | ~3.0 GH/s | 750x |
| MD4 | 900 | ~4.2 MH/s | ~3.2 GH/s | 760x |

**Recommendation:** CPU workers are viable for up to 10K hashes with rockyou.txt (~14M words).

### Tier 2: MEDIUM (Full wordlist viable, slower)

| Hash Type | Hashcat Mode | CPU Speed (c5.xlarge) | GPU Speed (T4) | Multiplier |
|-----------|--------------|----------------------|----------------|------------|
| SHA256 | 1400 | ~1.2 MH/s | ~500 MH/s | 420x |
| SHA384 | 10800 | ~1.0 MH/s | ~350 MH/s | 350x |
| SHA512 | 1700 | ~800 KH/s | ~300 MH/s | 375x |

**Recommendation:** CPU workers viable, but expect 2-4x longer runtimes than Tier 1.

### Tier 3: SLOW (GPU required or small wordlists only)

| Hash Type | Hashcat Mode | CPU Speed (c5.xlarge) | GPU Speed (T4) | Multiplier |
|-----------|--------------|----------------------|----------------|------------|
| bcrypt | 3200 | ~500 H/s | ~25 KH/s | 50x |
| sha512crypt | 1800 | ~200 H/s | ~20 KH/s | 100x |
| scrypt | 8900 | ~150 H/s | ~10 KH/s | 67x |
| Argon2 | 13700 | ~50 H/s | ~5 KH/s | 100x |

**Recommendation:** GPU REQUIRED for production use. CPU only for <1000 password wordlists.

### Tier 3 CPU Feasibility Calculator

For slow hashes on CPU:
```
Time (hours) = wordlist_lines / (cpu_speed_per_worker × worker_count)

Example: sha512crypt with rockyou (14.3M) on 2 c5.xlarge:
  Time = 14,344,391 / (200 × 2) = 35,860 hours = 1,494 days

With top 10K wordlist:
  Time = 10,000 / (200 × 2) = 25 hours = ~1 day
```

---

## Rule Attack Sizing (CRITICAL)

### ⛔ Rule attacks DO NOT parallelize via chunking

| Attack Type | Workers Active | Why |
|-------------|----------------|-----|
| Straight | ALL workers | Hashtopolis chunks wordlist |
| Mask | ALL workers | Hashtopolis chunks keyspace |
| **Rule** | **1 worker** | hashcat -s skips WORDS not keyspace |

### Rule Attack Keyspace Formula

```
Keyspace = wordlist_lines × rules_lines

Examples:
- rockyou (14.3M) × best64.rule (77) = 1.1 BILLION
- rockyou (14.3M) × OneRuleToRuleThemStill (48K) = 695 BILLION
- top10k (10K) × OneRuleToRuleThemStill (48K) = 483 MILLION
```

### Rule Attack Time Estimation (Single Worker)

```
Time = Keyspace / Speed

MD5 with rockyou + OneRule on c5.xlarge:
  Time = 695,000,000,000 / 3,800,000 = 183,000,000 seconds = 5,800 years

MD5 with top10k + OneRule on c5.xlarge:
  Time = 483,000,000 / 3,800,000 = 127 seconds = ~2 minutes
```

### Parallel Rule Attack Strategy

To parallelize rule attacks, split HASHES (not wordlists):

```
Workers: 4
Hashes: 2000
Split: 500 hashes per hashlist → 4 hashlists → 4 tasks

Result: 4 workers, each attacking different 500 hashes = 4x throughput
```

**Critical setting:** `maxAgents=1` on each task to force worker distribution.

---

## Worker Count Calculator

### Straight Attack Formula

```
Optimal Workers = CEIL(Keyspace / (Speed × Target_Runtime_Seconds))

Example: MD5, rockyou (14.3M), 30-minute target:
  Workers = CEIL(14,344,391 / (3,800,000 × 1800))
  Workers = CEIL(14,344,391 / 6,840,000,000)
  Workers = 1 (single worker sufficient for 30 min target)

Example: SHA256, rockyou (14.3M), 30-minute target:
  Workers = CEIL(14,344,391 / (1,200,000 × 1800))
  Workers = CEIL(14,344,391 / 2,160,000,000)
  Workers = 1 (single worker sufficient)
```

### Minimum Worker Recommendations

| Scenario | Workers | Rationale |
|----------|---------|-----------|
| Development/testing | 2 | Redundancy, validate parallel distribution |
| Production <1K hashes | 2 | Cost-effective |
| Production 1K-10K hashes | 4 | Balance of speed and cost |
| Production >10K hashes | 8+ | Scale for throughput |
| Rule attacks | N = hash_count / 500 | Split hashes for parallelism |

---

## Instance Type Selection

### AWS

| Instance | vCPU | RAM | Speed (MD5) | Cost (spot) | Use Case |
|----------|------|-----|-------------|-------------|----------|
| c5.large | 2 | 4GB | ~1.9 MH/s | $0.04/hr | Budget testing |
| c5.xlarge | 4 | 8GB | ~3.8 MH/s | $0.08/hr | **Standard CPU** |
| c5.2xlarge | 8 | 16GB | ~7.5 MH/s | $0.16/hr | High throughput |
| g4dn.xlarge | 4+T4 | 16GB | ~2.5 GH/s | $0.25/hr | **GPU (slow hashes)** |

### Azure

| Instance | vCPU | RAM | Speed (MD5) | Cost (spot) | Use Case |
|----------|------|-----|-------------|-------------|----------|
| Standard_D4s_v3 | 4 | 16GB | ~3.5 MH/s | $0.08/hr | **Standard CPU** |
| Standard_NC4as_T4_v3 | 4+T4 | 28GB | ~2.5 GH/s | $0.30/hr | **GPU** |

### GCP

| Instance | vCPU | RAM | Speed (MD5) | Cost (preemptible) | Use Case |
|----------|------|-----|-------------|---------------------|----------|
| n2-standard-4 | 4 | 16GB | ~3.6 MH/s | $0.04/hr | **Standard CPU** |
| n1-standard-4 + T4 | 4+T4 | 15GB | ~2.5 GH/s | $0.25/hr | **GPU** |

### Local (XCP-ng/Proxmox)

| Config | vCPU | RAM | Speed (MD5) | Cost | Use Case |
|--------|------|-----|-------------|------|----------|
| 4 vCPU | 4 | 8GB | ~3.5 MH/s | Free | Testing, development |
| 8 vCPU | 8 | 16GB | ~7.0 MH/s | Free | Production-like |

---

## Cost Estimation

### Hourly Rates (Spot/Preemptible)

| Config | AWS | Azure | GCP | OCI |
|--------|-----|-------|-----|-----|
| Server (t3.medium) | $0.02 | $0.02 | $0.02 | Free* |
| 2 CPU workers | $0.16 | $0.16 | $0.08 | Free* |
| 4 CPU workers | $0.32 | $0.32 | $0.16 | Free* |
| 2 GPU workers | $0.50 | $0.60 | $0.50 | ~$0.40 |

*OCI Always Free tier includes 2 VMs with 1 OCPU each

### Total Cost Examples

| Scenario | Workers | Runtime | Provider | Est. Cost |
|----------|---------|---------|----------|-----------|
| Quick test (50 MD5 hashes) | 2 CPU | 5 min | AWS | ~$0.02 |
| Standard job (1K NTLM) | 2 CPU | 30 min | AWS | ~$0.10 |
| Large job (10K SHA256) | 4 CPU | 2 hours | AWS | ~$0.70 |
| Slow hash (500 bcrypt) | 2 GPU | 8 hours | AWS | ~$4.00 |

---

## Chunk Size Optimization

### Default Settings

```hcl
chunkTime = 600  # 10-minute target chunks
```

### Optimal Chunk Size Guidelines

| Hash Speed | Recommended chunkTime | Rationale |
|------------|----------------------|-----------|
| Fast (MD5/NTLM) | 1200 (20 min) | Reduce coordination overhead |
| Medium (SHA256) | 900 (15 min) | Balance overhead and visibility |
| Slow (bcrypt) | 600 (10 min) | More frequent progress updates |

### Chunk Overhead Analysis

Each chunk incurs:
- API call to get chunk assignment
- hashcat startup time (~1-2 seconds)
- Result upload and verification

For fast hashes with tiny chunks (~6 seconds), overhead can be 30%+ of runtime.

**Larger chunks (20 min) reduce overhead to <1%.**

---

## Benchmark Format (useNewBench)

### Detection

```sql
SELECT benchmark FROM Assignment LIMIT 1;
-- OLD format: "192:3010.28" (contains :) → useNewBench=0
-- NEW format: "3010.28" (number only) → useNewBench=1
```

### Impact on Chunk Sizing

| useNewBench Setting | Benchmark Format | Chunk Behavior |
|---------------------|-----------------|----------------|
| Correct match | Either | Optimal chunks (~10 min) |
| useNewBench=1 with OLD | OLD (time:speed) | Tiny chunks (~seconds) |
| useNewBench=0 with NEW | NEW (speed only) | Giant chunks (may overflow) |

### Best Practice

1. Create probe task first to trigger benchmarking
2. Query Assignment table for benchmark format
3. Set useNewBench correctly BEFORE creating production tasks

---

## Quick Reference Commands

### Calculate Workers Needed

```bash
# For straight attack
KEYSPACE=14344391  # rockyou
SPEED=3800000      # MD5 on c5.xlarge
TARGET_SECONDS=1800  # 30 minutes
WORKERS=$(echo "scale=0; $KEYSPACE / ($SPEED * $TARGET_SECONDS) + 1" | bc)
echo "Recommended workers: $WORKERS"
```

### Estimate Runtime

```bash
# Current task runtime estimate
KEYSPACE=14344391
SPEED=3800000
WORKERS=2
TIME_SECONDS=$(echo "scale=0; $KEYSPACE / ($SPEED * $WORKERS)" | bc)
echo "Estimated runtime: $TIME_SECONDS seconds = $((TIME_SECONDS/60)) minutes"
```

---

## Summary Decision Tree

```
START: Need to crack hashes
       |
       +-- What hash type?
           |
           +-- FAST (MD5/SHA1/NTLM)
           |   |
           |   +-- How many hashes?
           |       |
           |       +-- <1K: 2 CPU workers
           |       +-- 1K-10K: 4 CPU workers
           |       +-- >10K: 8 CPU workers
           |
           +-- MEDIUM (SHA256)
           |   |
           |   +-- Same as FAST but expect 2-4x longer
           |
           +-- SLOW (bcrypt/sha512crypt)
               |
               +-- MUST use GPU workers
               +-- Or limit to top 10K wordlist on CPU
       |
       +-- What attack type?
           |
           +-- Straight/Mask: Single task, all workers parallel
           |
           +-- Rule: Split HASHES into N hashlists for N workers
```
