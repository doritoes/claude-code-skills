# Test Results Summary

Performance data from multi-cloud testing (2026-01).

## Multi-Cloud CPU Comparison (SHA256, 5000 hashes)

| Provider | Workers | vCPU | Runtime | Cracked | Rate |
|----------|---------|------|---------|---------|------|
| AWS CPU | 4 | 16 | 9h 1m | 2161 (43.2%) | 4.0/min |
| AWS GPU | 1 | g4dn.xlarge | 5m 6s | 2161 (43.2%) | 423/min |
| GCP | 4 | 16 | ~8h | 2161 (43.2%) | 4.5/min |
| Azure | 4 | 16 | 9h 41m | 2161 (43.2%) | 3.7/min |

## Key Findings

1. **GPU is 106x faster** than CPU for SHA256
2. **GCP fastest CPU** (~8h) vs Azure slowest (9h 41m)
3. **Identical crack rate** (43.2%) - wordlist coverage is consistent

## Local Hypervisor (Proxmox) - MD5, 1250 hashes

| Workers | vCPU | Runtime | Cracked | Speed |
|---------|------|---------|---------|-------|
| 2 | 8 | ~5h | ~500 (40%) | ~40 MH/s combined |

## Cost Estimates (10-hour run)

| Provider | CPU Workers (4×4vCPU) | GPU Worker |
|----------|----------------------|------------|
| AWS | ~$1.50 | ~$5.26 |
| GCP | ~$1.50 | ~$4.50 |
| Azure | ~$6.80 | ~$5.30 |
| Proxmox | $0 (hardware only) | N/A |

## Cross-Reference Effectiveness

| Hash Type | Direct Attack | Via Cross-Reference |
|-----------|---------------|---------------------|
| MD5 | 44% | N/A (fast hash) |
| SHA512crypt | 0.2% | 7% |

**96% of SHA512crypt cracks came from password reuse, not direct attack.**

## Recommendations

1. **Use GPU for production** - 100x+ speedup justifies cost
2. **GCP for CPU workloads** - Best price/performance
3. **Local for testing** - No cloud costs, full control
4. **Always run cross-reference** - Catches 30-40% more
