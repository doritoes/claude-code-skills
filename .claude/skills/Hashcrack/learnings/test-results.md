# Test Results Summary

Performance data from multi-cloud testing (2026-01).

## Multi-Cloud CPU Comparison (SHA256, 5000 hashes)

| Provider | Workers | vCPU | Runtime | Cracked | Rate | Speed |
|----------|---------|------|---------|---------|------|-------|
| AWS CPU | 4 | 16 | 9h 1m | 2161 (43.2%) | 4.0/min | ~40 MH/s |
| AWS GPU | 1 | g4dn.xlarge | 5m 6s | 2161 (43.2%) | 423/min | ~25 GH/s |
| GCP | 4 | 16 | ~8h | 2161 (43.2%) | 4.5/min | ~40 MH/s |
| Azure | 4 | 16 | 9h 41m | 2161 (43.2%) | 3.7/min | ~40 MH/s |
| **OCI** | 4 | 32 (16 OCPU) | 7h 21m | 2161 (43.2%) | 4.9/min | ~62 MH/s |
| **XCP-ng** | 4 | 16 | 6h 5m | 2163 (43.3%) | 5.9/min | ~40 MH/s |

## Key Findings

1. **GPU is 106x faster** than CPU for SHA256
2. **XCP-ng fastest CPU** (5h 58m) - local hypervisor with dedicated resources
3. **OCI 2nd fastest** (7h 21m) - 2x vCPU (32 vs 16) yielded +55% speed, not 2x
4. **Azure slowest cloud** (9h 41m) - consistent with pricing being higher
5. **Identical crack rate** (43.2%) across all providers - wordlist coverage is consistent

## Local Hypervisor (Proxmox) - MD5

### Test 1: MD5, 1250 hashes (rockyou wordlist)

| Workers | vCPU | Runtime | Cracked | Speed |
|---------|------|---------|---------|-------|
| 2 | 8 | ~5h | ~500 (40%) | ~40 MH/s combined |

### Test 2: MD5, 50 hashes (6-char brute force)

| Workers | vCPU | Runtime | Cracked | Keyspace |
|---------|------|---------|---------|----------|
| 2 | 8 | ~5 min | 41/50 (82%) | 14.7M |

**Notes:**
- CPU utilization was only ~40% due to small keyspace
- MD5 is very fast to crack - overhead of chunk distribution exceeded compute time
- For heavier workloads (bcrypt, SHA512crypt), CPU would be fully utilized

## Cost Estimates (10-hour run)

| Provider | CPU Workers (4×4vCPU) | GPU Worker |
|----------|----------------------|------------|
| AWS | ~$1.50 | ~$5.26 |
| GCP | ~$1.50 | ~$4.50 |
| Azure | ~$6.80 | ~$5.30 |
| **OCI** | ~$4.50 (16 OCPU) | N/A |
| **XCP-ng** | $0 (hardware only) | N/A |
| Proxmox | $0 (hardware only) | N/A |

## Cross-Reference Effectiveness

| Hash Type | Direct Attack | Via Cross-Reference |
|-----------|---------------|---------------------|
| MD5 | 44% | N/A (fast hash) |
| SHA512crypt | 0.2% | 7% |

**96% of SHA512crypt cracks came from password reuse, not direct attack.**

## Recommendations

1. **Use GPU for production** - 100x+ speedup justifies cost
2. **XCP-ng/local for CPU workloads** - Fastest runtime, zero cloud cost
3. **GCP for cloud CPU workloads** - Best cloud price/performance
4. **OCI for high vCPU needs** - 2x vCPU but diminishing returns on SHA256
5. **Always run cross-reference** - Catches 30-40% more
