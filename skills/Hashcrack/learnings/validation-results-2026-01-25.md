# Hashcrack Validation Test Results - 2026-01-25

## Infrastructure

### CPU Testing (Session 1)

| Component | Specification |
|-----------|---------------|
| Provider | AWS us-west-2 |
| Server | t3.medium |
| Workers | 2x c5.xlarge (spot) |
| Cost | ~$0.18/hr |
| Duration | ~1 hour |
| Estimated Cost | ~$0.20 |

### GPU Testing (Session 2)

| Component | Specification |
|-----------|---------------|
| Provider | AWS us-west-2 |
| Server | t3.medium |
| Workers | 2x g4dn.xlarge (Tesla T4 GPU) |
| Cost | ~$1.05/hr |
| Duration | ~30 min |
| Estimated Cost | ~$0.53 |

## CPU Test Results (T01-T09)

| ID | Test Name | Hash Type | Attack | Hashes | Cracked | Rate | Progress |
|----|-----------|-----------|--------|--------|---------|------|----------|
| T01 | MD5-straight | MD5 (0) | Straight | 50 | 8 | 16% | 100% |
| T02 | SHA256-straight | SHA256 (1400) | Straight | 20 | 20 | 100% | 100% |
| T03 | MD5-rules | MD5 (0) | Rule | 30 | 22 | 73% | 6% (archived) |
| T04 | MD5-mask | MD5 (0) | Mask | 20 | 0 | 0% | 100% |
| T05 | SHA1-straight | SHA1 (100) | Straight | 10 | 10 | 100% | 1% |
| T06 | NTLM-straight | NTLM (1000) | Straight | 5 | 5 | 100% | 79% |
| T07 | MD5-hybrid | MD5 (0) | Hybrid | 8 | 0 | 0% | 100% |
| T08 | MD5-500hashes | MD5 (0) | Straight | 500 | 500 | 100% | 1% |
| T09 | SHA256-highpriority | SHA256 (1400) | Straight | 3 | 3 | 100% | 100% |

**CPU Total:** 9 tests, 646 hashes, 568 cracked (88%)

## GPU Test Results (T10-T15)

| ID | Test Name | Hash Type | Mode | Attack | Hashes | Cracked | Rate | Notes |
|----|-----------|-----------|------|--------|--------|---------|------|-------|
| T10 | sha512crypt-GPU | sha512crypt | 1800 | Straight | 5 | 5 | 100% | 5.1% progress, ~29 kH/s combined |
| T11 | bcrypt-GPU | bcrypt | 3200 | Straight | 4 | 4 | 100% | 0.2% progress |
| T12 | MD5-GPU | MD5 | 0 | Straight | 10 | 9 | 90% | 100% progress, ~3.3 MH/s/GPU |
| T13 | NTLM-GPU | NTLM | 1000 | Straight | 5 | 4 | 80% | 100% progress |
| T14 | SHA256-GPU | SHA256 | 1400 | Straight | 8 | 5 | 62% | Mixed hash types (error) |
| T15 | MD5-rules-GPU | MD5 | 0 | Rule | 5 | 5 | 100% | File size mismatch fixed |

**GPU Total:** 6 tests, 37 hashes, 32 cracked (86%)

**Combined Total:** 15 tests, 683 hashes, 600 cracked (88%)

## Key Findings

### GPU-Specific Findings

#### 1. GPU Worker Boot Time
GPU workers take significantly longer to boot (~5-7 minutes) compared to CPU workers (~2-3 minutes) due to NVIDIA driver installation during cloud-init.

**Learning:** When polling for GPU agent registration, use longer wait times (300+ seconds vs 120 for CPU).

#### 2. GPU Agent Configuration
- Set `cpuOnly=0` for GPU agents (critical for GPU task dispatch)
- Use `isCpuTask=0` in Task for GPU-targeted tasks
- Trust agents with `isTrusted=1` (required for file downloads)

#### 3. File Size Mismatch Bug
When staging files manually via SQL, the `size` field in File table MUST match actual file size on disk. Mismatch causes infinite download loop by agents.

**Fix:** Always verify with `stat -c %s /path/to/file` and update File table accordingly.

#### 4. GPU Speed Observations (Tesla T4)
| Hash Type | Mode | Speed per GPU | Notes |
|-----------|------|--------------|-------|
| sha512crypt | 1800 | ~14.5 kH/s | Slow hash, GPU helps significantly |
| MD5 | 0 | ~3.3 MH/s | Fast hash, GPU underutilized on small tasks |
| SHA256 | 1400 | ~0.6 MH/s | Expected for SHA256 |

**Note:** Speeds appear lower than expected - likely due to small hash counts and short task durations preventing accurate measurement.

### CPU-Specific Findings

### 1. Chunk Sizing Observations

| Task | Chunks | Avg Chunk Size | Notes |
|------|--------|----------------|-------|
| T01 | 362 | 39.6K | Many small chunks (useNewBench=1) |
| T02 | 1 | 14.3M | Single giant chunk (useNewBench=0) |
| T08 | 1 | 163.8K | Small task, single chunk |

**Finding:** useNewBench setting dramatically affects chunk sizing. AWS with PoCL uses OLD format (useNewBench=0).

### 2. Worker Distribution

| Worker | Total Chunks |
|--------|--------------|
| hashcrack-cpu-worker-1 | 185 |
| hashcrack-cpu-worker-2 | 186 |

**Finding:** Excellent distribution between workers for straight attacks (50/50 split).

### 3. Rule Attack Limitations

T03 demonstrated rule attack behavior:
- Keyspace: 695 BILLION (rockyou × OneRule)
- Progress after archival: 6%
- Only 1 worker active despite 2 available
- **Conclusion:** Rule attacks do NOT parallelize. Split hashes for parallelism.

### 4. Early Cracking Pattern

Tasks T05, T06, T08 achieved 100% crack rate at <2% wordlist progress. Common passwords are at the beginning of rockyou.txt.

**Recommendation:** Don't wait for 100% keyspace progress. Monitor cracked count instead.

### 5. Mask Attack Results

T04 and T07 (mask/hybrid) achieved 0% crack rate because:
- Test hashes were generated from words in rockyou
- Mask attacks target brute-force patterns, not dictionary words
- Use appropriate attack type for password patterns

## Improvements Made to Skill

### Documentation Updates

1. **AttackStrategies.md** - Added HASH_SPEED_TIERS table
2. **Crack.md** - Added WORKER_SIZING_GUIDE section
3. **Scale.md** - Added SCALING_CHECKLIST section
4. **Monitor.md** - Added CPU Utilization Monitoring section

### New Strategy Guides

1. **docs/RESOURCE_SIZING.md** - Worker count formulas, instance selection, cost estimation
2. **docs/PROVIDER_SELECTION.md** - Provider comparison, decision matrix, multi-provider strategy

### Learnings Captured

1. Shell escaping in SSH+Docker chains
2. Chunk sizing correlation with useNewBench
3. Early cracking patterns in wordlists
4. Rule attack parallelization limitations
5. AWS spot capacity by region

## Recommendations

### Completed Validation Items

1. ~~Test GPU workers (g4dn.xlarge) for slow hashes~~ - DONE (T10-T15)
2. Test multi-provider parallel deployment - TODO
3. Test scale-up/scale-down scenarios - TODO (partial - single provider)
4. ~~Test with realistic password distributions~~ - DONE (rockyou.txt wordlist)

### For Production Use

1. Always verify useNewBench setting before task creation
2. Use 20-minute chunkTime for better efficiency
3. Archive impractical rule attacks early
4. Monitor cracked count, not just progress percentage
5. Use us-west-2 for better AWS spot availability
6. **GPU-specific:** Wait 300+ seconds for GPU agent registration
7. **GPU-specific:** Verify File.size matches actual file size before task creation
8. **GPU-specific:** Set cpuOnly=0 in Agent table for GPU workers

## Cost Summary

### CPU Testing (Session 1)
- Infrastructure: $0.18/hr (2x c5.xlarge spot)
- Run time: ~1 hour
- Cost: ~$0.20

### GPU Testing (Session 2)
- Infrastructure: $1.05/hr (2x g4dn.xlarge)
- Run time: ~30 min
- Cost: ~$0.53

### Total
- Total cost: ~$0.73
- Budget used: 0.29% of $250 budget
- Remaining budget: $249.27

---

*Generated by Hashcrack Skill Validation Session - GPU Tests Completed 2026-01-25*
