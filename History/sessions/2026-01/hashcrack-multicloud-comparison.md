# Hashcrack Multi-Cloud Performance Comparison
**Date:** 2026-01-10/11
**Test:** Hashtopolis distributed hash cracking

## Test Configuration

### Wordlist & Rules
- **Wordlist:** rockyou.txt (14.3M passwords)
- **Rules:** OneRuleToRuleThemStill.rule
- **Keyspace:** 14,344,384 candidates

### Hash Types Tested
| Provider | Hash Type | Count |
|----------|-----------|-------|
| AWS CPU | SHA256 | 5000 |
| AWS GPU | SHA256 | 5000 |
| GCP | SHA256 | 5000 |
| Azure | SHA256 | 5000 |
| Proxmox | MD5 | 1250 |

## Results Summary

### Cloud Provider Comparison (SHA256, 5000 hashes)

| Provider | Workers | vCPU | Runtime | Cracked | Rate |
|----------|---------|------|---------|---------|------|
| AWS CPU | 4 | 16 | 9h 1m | 2161 (43.2%) | 4.0/min |
| AWS GPU | 1 | g4dn.xlarge | 5m 6s | 2161 (43.2%) | 423/min |
| GCP | 4 | 16 | ~8h | 2161 (43.2%) | 4.5/min |
| Azure | 4 | 16 | 9h 41m | 2161 (43.2%) | 3.7/min |

### Key Findings

1. **GPU is 106x faster** than CPU for SHA256 cracking
   - AWS GPU: 5m 6s vs AWS CPU: 9h 1m

2. **CPU performance varies slightly by provider**
   - GCP: fastest CPU (~8h)
   - AWS: middle (9h 1m)
   - Azure: slowest (9h 41m)

3. **Identical crack rate across providers**
   - All achieved 43.2% (2161/5000) cracked
   - Wordlist/rule combination has consistent coverage

## Azure Specific Results

### Configuration
- **Region:** eastus2
- **Server:** Standard_D2s_v3 (2 vCPU, 8 GB RAM)
- **Workers:** 4x Standard_D4s_v3 (4 vCPU, 16 GB RAM each)
- **Total vCPU:** 16 (workers) + 2 (server) = 18

### Statistics
- **Start:** 2026-01-10 18:58:32 UTC
- **End:** 2026-01-11 04:39:35 UTC
- **Duration:** 34,863 seconds (9h 41m)
- **Chunks Processed by Worker:**
  - worker-1: 782 chunks
  - worker-2: 777 chunks
  - worker-3: 781 chunks
  - worker-4: 745 chunks
  - Total: 3,085 chunks

### Cost Estimate (on-demand)
- Server: D2s_v3 @ ~$0.096/hr × 10h = $0.96
- Workers: 4× D4s_v3 @ ~$0.192/hr × 10h = $7.68
- **Total:** ~$8.64

## Proxmox Local Results (In Progress)

### Configuration
- **Platform:** Proxmox VE (local hypervisor)
- **Server:** 2 vCPU, 4 GB RAM
- **Workers:** 2x 4 vCPU, 4 GB RAM each
- **Hash Type:** MD5 (faster than SHA256)
- **Count:** 1250 hashes

### Status
- Job running in background
- Progress: ~36% cracked at last check
- Expected completion: ~3-4 hours from start

## Recommendations

1. **Use GPU for production workloads** - 100x+ speedup justifies cost
2. **GCP has best CPU price/performance** for CPU-only workloads
3. **Azure has highest latency** for CPU workloads
4. **Local (Proxmox/XCP-ng) for testing** - no cloud costs, full control

## Files & Resources

- Terraform configs: `.claude/skills/Hashcrack/terraform/`
- Cloud-init templates: `.claude/skills/Hashcrack/terraform/cloud-init/`
- Skill documentation: `.claude/skills/Hashcrack/skill.md`
