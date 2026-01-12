# OCI Hashcrack Learnings

## Critical Gaps Identified in OCI Step-by-Step Process

### Gap 1: Dynamic Limits Display is Misleading
- OCI Console shows "Dynamic: 0" but actual limits may be 83-100+
- Always check the limit value in the support request form to see true limits
- Request limit increases even if confused about current capacity

### Gap 2: Voucher Race Conditions
- Must create ONE VOUCHER PER WORKER before workers boot
- Even with `voucherDeletion=0`, shared vouchers can fail due to race conditions
- Workers configured with single voucher (from tfvars) need that voucher to exist

### Gap 3: Voucher Not Persisting
- INSERT statements sometimes don't persist (transaction issues?)
- Use INSERT IGNORE and verify with SELECT after
- Add multiple vouchers as backup

### Gap 4: Cloud-init Recursion Fix Location
- Python 3.12 RecursionError fix needed in BOTH places:
  1. Initial registration script (line ~108 in worker.yaml)
  2. Systemd service ExecStart
- Fixed in cloud-init but should verify on each deployment

### Gap 5: Resource Limit Verification Before Deploy
- ALWAYS check OCI limits before deploying
- If limits are 0 or insufficient, STOP AND ASK user
- Don't reduce resources without explicit approval
- User may want to request limit increases instead

### Gap 6: Shape Selection for Comparison Tests
- **Industry-standard vCPU** = 1 hyperthread (AWS, GCP, Azure)
- **Oracle OCPU** = 2 hyperthreads = 2 vCPU equivalent
- E4.Flex 4 OCPU = 8 vCPU (vs GCP n2-standard-4 = 4 vCPU)
- For fair comparison: OCI 2 OCPU ≈ AWS/GCP 4 vCPU
- Let user decide - cost/speed tradeoffs matter in comparison

### vCPU vs OCPU Reference Table
| Cloud | Unit | Hyperthreads | Equiv to 4 vCPU |
|-------|------|--------------|-----------------|
| AWS | vCPU | 1 | 4 vCPU |
| GCP | vCPU | 1 | 4 vCPU |
| Azure | vCPU | 1 | 4 vCPU |
| **OCI** | **OCPU** | **2** | **2 OCPU** |

## OCI-Specific Configuration

### Working Shapes (with 100 core limit)
- Server: VM.Standard.E4.Flex (2 OCPU, 8 GB)
- Workers: VM.Standard.E4.Flex (4 OCPU, 16 GB)
- Total: 18 OCPU for 4 workers + server

### OCI vs GCP Comparison
| Component | GCP | OCI |
|-----------|-----|-----|
| Server | e2-medium (2 vCPU, 4 GB) | E4.Flex 2 OCPU (4 vCPU, 8 GB) |
| Workers | n2-standard-4 (4 vCPU, 16 GB) | E4.Flex 4 OCPU (8 vCPU, 16 GB) |
| Worker CPU | 4 vCPU each | 8 vCPU each (2x) |

### GPU Shapes Requested
- GPU3 (V100): 6 units per AD
- GPU4 (A100): 6 units per AD

### Gap 7: Worker Recovery Procedure
When a worker fails to register or becomes unresponsive:
1. **Check agent logs**: `ssh ubuntu@WORKER_IP 'sudo journalctl -u hashtopolis-agent -n 20 --no-pager'`
2. **Verify voucher exists**: Check database for configured voucher
3. **Add missing voucher**: `INSERT IGNORE INTO hashtopolis.RegVoucher (voucher, time) VALUES ("VOUCHER_NAME", UNIX_TIMESTAMP()); COMMIT;`
4. **Restart agent**: `ssh ubuntu@WORKER_IP 'sudo systemctl restart hashtopolis-agent'`
5. **Trust agent**: `UPDATE hashtopolis.Agent SET isTrusted=1, cpuOnly=1;`
6. **IMPORTANT**: Voucher INSERT may not persist - always verify with SELECT after inserting

## Test Results (2026-01-12)

### Final Metrics
| Metric | OCI | GCP | Difference |
|--------|-----|-----|------------|
| **Hashes Cracked** | 2161/5000 (43.2%) | 2084/5000 (41.7%) | +77 (+3.7%) |
| **Total vCPU** | 32 vCPU (16 OCPU) | 16 vCPU | 2x |
| **Speed** | ~62 MH/s | ~40 MH/s | +55% |
| **Duration** | ~7h 21m | TBD | TBD |
| **Keyspace** | 100% exhausted | 100% exhausted | Same |

### Key Observations
1. **CPU Efficiency**: 2x vCPU yielded only ~55% more speed (not 2x)
   - OCI 32 vCPU → ~62 MH/s
   - GCP 16 vCPU → ~40 MH/s
   - Hashcat doesn't scale linearly with CPU on SHA256

2. **Worker-3 Recovery**: Required voucher fix mid-test
   - Initial voucher INSERT didn't persist
   - Had to re-add with COMMIT and restart agent
   - Lost ~5 minutes before all 4 workers active

3. **Internal Networking**: Workers use server's private IP (10.0.1.x)
   - Cloud-init correctly configured internal routing
   - No NAT Gateway needed for hashcracking traffic

### Infrastructure Details
- Server IP: 129.213.103.251
- Worker IPs: 150.136.176.149, 193.122.156.223, 193.122.158.237, 150.136.73.5
- Shapes: VM.Standard.E4.Flex (Server 2 OCPU, Workers 4 OCPU each)
- Test: SHA256 (mode 1400) + OneRule + RockYou

### Cost Estimate
| Component | OCPUs | Hours | Rate/hr | Cost |
|-----------|-------|-------|---------|------|
| Server | 2 | 8 | $0.025 | ~$0.40 |
| Worker x4 | 16 | 8 | $0.025 | ~$3.20 |
| **Total** | 18 | 8 | - | **~$3.60** |

*Note: OCI E4.Flex ~$0.025/OCPU/hr (us-ashburn-1)*
