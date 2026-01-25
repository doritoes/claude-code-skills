# GCP-Specific Learnings

## Instance Types

| Role | Type | Specs | Cost/hr |
|------|------|-------|---------|
| Server | e2-medium | 2 vCPU, 4GB | $0.034 |
| CPU Worker | c2-standard-4 | 4 vCPU, 16GB | $0.188 |
| GPU Worker | n1-standard-4 + T4 | T4 GPU | ~$0.45 |

## CRITICAL: Cloud NAT Required

GCP VMs with private IPs **cannot reach internet** without Cloud NAT (unlike AWS/Azure).

The terraform config includes Cloud Router + Cloud NAT automatically.

## Quota Limits

- `CPUS_ALL_REGIONS`: Global limit overrides regional quotas
- New projects default to 32 vCPU globally
- Request increases: Console → IAM & Admin → Quotas

## Preemptible Instances

- Use `use_preemptible = true` for 60-70% savings
- Max 24-hour runtime
- Tasks auto-recover on termination

## GPU Deployment Issues

- GPU quotas are separate from CPU quotas
- Request `NVIDIA_T4_GPUS` quota increase
- Check `gcloud compute regions describe REGION` for availability

## SSH Key Requirements

- GCP supports ed25519 and RSA keys
- Use `ssh_public_key` variable

## CRITICAL: Benchmark Format and useNewBench Setting

**2026-01-22 Failure Analysis:**

GCP run failed catastrophically - only processed 0.002% of keyspace (14M of 746B) because:
1. Benchmark format mismatch caused tiny chunks (6-7K instead of ~367M)
2. 2127 tiny chunks created instead of ~2000 large chunks
3. Cracked 2204/5000 but from wrong keyspace portion (not comparable to AWS/Azure 2161)

**Root Cause:** Task created with `useNewBench=1` but GCP agents report benchmark in OLD format `time:speed` (e.g., `2672:24760.24`). Hashtopolis expected new format (speed only) and misinterpreted the benchmark value, creating tiny chunks.

**SOLUTION - Set useNewBench=0:**
```sql
-- CORRECT: Match agent benchmark format
INSERT INTO Task (... useNewBench, ...) VALUES (... 0, ...);

-- Or fix existing task:
UPDATE Task SET useNewBench=0 WHERE taskId=X;
DELETE FROM Chunk WHERE taskId=X;  -- Reset chunks
UPDATE Task SET keyspaceProgress=0 WHERE taskId=X;
```

**DO NOT USE chunkSize/staticChunks** - this is an anti-pattern that masks the real issue.

**Understanding Benchmark Formats:**
| Format | Example | useNewBench Setting |
|--------|---------|---------------------|
| OLD (time:speed) | `2672:24760.24` | `useNewBench=0` |
| NEW (speed only) | `24760.24` | `useNewBench=1` |

**Why This Happens (ALL Providers):**
- **ALL CPU workers use PoCL** (Portable Computing Language) via Ubuntu's hashcat package
- PoCL's benchmark output format varies by version/environment
- GCP was observed to report OLD format, but this could happen on ANY provider
- **ALWAYS verify benchmark format after agent registration, don't assume based on provider**
- This is NOT a GCP-specific bug - infrastructure is identical across providers

**Verification Step (MANDATORY after first chunks created):**
```sql
-- Check chunk coverage after ~5 minutes
SELECT
  COUNT(*) as chunk_count,
  SUM(length) as total_coverage,
  (SELECT keyspace FROM Task WHERE taskId=X) as target_keyspace,
  ROUND(SUM(length) / (SELECT keyspace FROM Task WHERE taskId=X) * 100, 2) as coverage_pct
FROM Chunk WHERE taskId=X;
```

**Expected Results:**
- RockYou+OneRule (746B keyspace): ~2000 chunks, each ~367M in length
- If chunks are tiny (6-7K), `useNewBench` setting is wrong - flip it

## Known Issue: Rule Attack Skip Values

**2026-01-22 Observation:**

When using rule attacks on GCP, chunks with `skip > 0` may fail with:
```
Restore value is greater than keyspace.
```

**Analysis:**
- Chunk 1 (skip=0) works correctly
- Chunks 2+ (skip > 0) fail because hashcat's internal keyspace calculation differs from Hashtopolis
- This appears to be a file synchronization timing issue - some workers may not have the rule file when hashcat calculates keyspace

**Workarounds:**
1. Set `ignoreErrors=1` on agents to keep them active
2. Ensure files are fully downloaded before task starts
3. Use smoke test patterns with smaller keyspaces for validation

**Note:** This is independent of the `useNewBench` setting - chunk SIZES are correct, but skip VALUES cause issues on some workers.

## Performance Notes

- **Fastest CPU performance** of cloud providers tested
- ~8h vs AWS 9h, Azure 9h 41m for same workload (when properly configured)
