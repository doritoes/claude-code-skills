# GPU Cracking Learnings

Best practices and insights from GPU hashcracking tests.

## Key Differences: GPU vs CPU

| Aspect | CPU | GPU |
|--------|-----|-----|
| Speed | ~40 MH/s (4 workers) | ~25 GH/s per T4 (625x faster) |
| Agent Setting | `cpuOnly = 1` | `cpuOnly = 0` |
| Command Args | `--force` | `--force -O` (optimized kernels) |
| Benchmark Format | Check Assignment table | Same - detect via `:` separator |
| Rule Attacks | Split hashlist for parallelization | Same - split hashlist |
| Time to Crack | Hours | Minutes |

## GPU-Specific Configuration

### Trust GPU Agents
```sql
UPDATE Agent SET isTrusted = 1, cpuOnly = 0, cmdPars = '--force -O', ignoreErrors = 1
WHERE isTrusted = 0;
```

### Benchmark Format Detection
Wait 2-3 minutes after trust, then:
```sql
SELECT agentId, benchmark FROM Assignment LIMIT 1;
```

| Benchmark Value | Format | useNewBench |
|-----------------|--------|-------------|
| `81920:6710.5` (contains `:`) | OLD | `useNewBench=0` |
| `24760.24` (number only) | NEW | `useNewBench=1` |

## Parallelization Strategy for GPU

### When to Split Hashlists
**Rule attacks with large keyspace** - Split the hashlist, not the wordlist:
1. RockYou (14.3M) × OneRule (52K rules) = 746B keyspace
2. Single GPU takes ~37 days for full keyspace
3. Most cracks happen in first 0.01% of keyspace (5 minutes)

### How to Split
```bash
# Split 5000 hashes across 6 GPUs
split -n l/6 hashes.txt chunk_

# Create separate hashlists per GPU
for i in 1..6; do
  INSERT INTO Hashlist (hashlistName, ...) VALUES ('gpu-chunk-$i', ...);
  INSERT INTO TaskWrapper (..., maxAgents=1) VALUES (...);  # Force 1 agent per task
  INSERT INTO Task (..., taskWrapperId=$i) VALUES (...);
done
```

### When NOT to Split
**Brute force attacks** - Let Hashtopolis manage keyspace distribution naturally:
- Keyspace is divided into chunks
- Workers request chunks as they complete
- No need to split hashlist

## Performance Results

### AWS 6x T4 GPU Test (2026-01-24)
| Metric | Value |
|--------|-------|
| Hashes | 5000 SHA256 |
| Cracked | 2160 (43.2%) |
| Workers | 6x g4dn.xlarge |
| Deploy Time | 192s |
| Setup Time | 1245s |
| Crack Time | ~5 min |
| Speed | ~150 GH/s combined |

### Comparison: 1x vs 6x GPU
| Config | Time | Cracked | Notes |
|--------|------|---------|-------|
| 1x T4 | 5m 6s | 2161 | Baseline |
| 6x T4 | ~5m | 2160 | No significant speedup |

**Why?** GPU is so fast that wordlist position matters more than parallelization.
All crackable passwords are at the beginning of RockYou.

## GPU Cost Analysis

| Provider | Instance | GPU | Hourly Cost |
|----------|----------|-----|-------------|
| AWS | g4dn.xlarge | T4 | ~$0.53 |
| Azure | NC4as_T4_v3 | T4 | ~$0.53 |
| GCP | n1-standard-4 + T4 | T4 | ~$0.45 |

**10-hour GPU run:** ~$5 (vs ~$1.50 for CPU spot instances)
**Speedup:** 100x faster
**Cost efficiency:** GPU is 20x more cost-effective for SHA256

## Recommendations

1. **Use 1-2 GPUs** for standard wordlist+rule attacks
   - Additional GPUs don't help due to wordlist ordering

2. **Use multiple GPUs** for:
   - Brute force attacks (keyspace-limited)
   - Very large hashlists (millions)
   - Slow hash types (bcrypt, scrypt)

3. **Run GPU for 15 minutes max** on wordlist attacks
   - 99% of cracks happen in first 0.01% of keyspace

4. **Verify benchmark format** before creating tasks
   - `useNewBench` mismatch causes "0.0%" progress forever

5. **Set `cpuOnly = 0`** for GPU workers
   - Obvious but easy to forget when copying CPU commands
