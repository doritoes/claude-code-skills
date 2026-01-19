# Hashcrack Smoke Test v3

Validates the hashcrack skill process across all 6 providers.

## Success Criteria (ALL Required)

| Criteria | Requirement |
|----------|-------------|
| Workers deployed | 2 CPU workers |
| Agent registration | Both workers register |
| Both workers crack | Verified via Chunk table |
| Crack rate | 100% (not 50%) |
| Task assignment | API only (no manual INSERT) |
| Cleanup | Infrastructure destroyed |

## Quick Start

```bash
# Test single provider
bun run tests/smoke-test-v3.ts xcp-ng

# Test all local providers
bun run tests/smoke-test-v3.ts local

# Test all cloud providers
bun run tests/smoke-test-v3.ts cloud

# Test all providers
bun run tests/smoke-test-v3.ts all
```

## Test Data

| File | Contents |
|------|----------|
| `data/smoke-passwords.txt` | 47 known plaintext passwords |
| `data/smoke-hashes.txt` | 47 MD5 hashes of passwords |
| `data/smoke-wordlist.txt` | 519 words (passwords + filler) |
| `data/smoke-rules.rule` | 561 hashcat rules |

**Keyspace:** 519 × 561 = 291,159 (ensures work distribution)

## Why This Design?

### Problem with v2

The previous smoke test (v2) had critical flaws:

1. **Only 10 hashes** - Too small, job completed before both workers engaged
2. **Simple dictionary attack** - No rules, finished instantly
3. **50% success threshold** - Too lenient, masked failures
4. **No worker verification** - Could pass with only 1 worker
5. **Last test FAILED** - "No hashes were cracked"

### v3 Improvements

1. **47 hashes + 519 words + 561 rules** - 291K keyspace ensures distribution
2. **Both workers must crack** - Verified via Chunk table query
3. **100% crack rate required** - All passwords in wordlist
4. **API task creation** - No manual Assignment manipulation
5. **Detailed worker contribution report** - Shows exactly what each worker cracked

## Test Flow

```
1.  terraform init + apply (2 workers)
2.  Wait for cloud-init
3.  Verify server ready
4.  Create vouchers (one per worker)
5.  Wait for agents to register (2 required)
6.  Trust agents, set cpuOnly=1
7.  Upload wordlist + rules to /usr/local/share/hashtopolis/files/
8.  Register files in database
9.  Create hashlist via database
10. Create task via API (createTask)
11. Monitor until keyspace exhausted
12. Verify: 100% cracked + both workers contributed
13. terraform destroy
14. Report PASS/FAIL
```

## Validation Queries

```sql
-- Check all hashes cracked
SELECT COUNT(*) FROM Hash WHERE hashlistId=X AND isCracked=0;
-- Must return 0

-- Check both workers contributed
SELECT COUNT(DISTINCT agentId) FROM Chunk WHERE taskId=X AND cracked > 0;
-- Must return 2

-- Worker contribution details
SELECT a.agentName, SUM(c.cracked) as totalCracked
FROM Chunk c JOIN Agent a ON c.agentId = a.agentId
WHERE c.taskId=X GROUP BY c.agentId;
```

## Providers

| Provider | terraform.tfvars | Wait Time |
|----------|------------------|-----------|
| XCP-ng | `terraform/` | 300s |
| Proxmox | `terraform/proxmox/` | 300s |
| AWS | `terraform/aws/` | 180s |
| Azure | `terraform/azure/` | 300s |
| GCP | `terraform/gcp/` | 180s |
| OCI | `terraform/oci/` | 300s |

## Failure Modes

| Fail Reason | Cause | Resolution |
|-------------|-------|------------|
| `INSUFFICIENT_CRACK_RATE` | Some hashes not cracked | Check wordlist contains all passwords |
| `SINGLE_WORKER_ONLY` | Only 1 worker contributed | Increase keyspace or chunkTime |
| `AGENT_REGISTRATION_FAILED` | Workers didn't register | Check vouchers, cloud-init logs |
| `UNKNOWN` | Other failure | Check error message, server logs |

## Regenerating Test Data

If you need to modify the test data:

```bash
# 1. Edit smoke-passwords.txt with your passwords
# 2. Regenerate hashes:
python -c "
import hashlib
with open('data/smoke-passwords.txt', 'r') as f:
    passwords = [line.strip() for line in f if line.strip()]
with open('data/smoke-hashes.txt', 'w') as f:
    for pw in passwords:
        f.write(hashlib.md5(pw.encode()).hexdigest() + '\n')
print(f'Generated {len(passwords)} hashes')
"

# 3. Ensure smoke-wordlist.txt contains all passwords plus filler
# 4. Verify:
python -c "
with open('data/smoke-passwords.txt') as f:
    pws = set(l.strip() for l in f if l.strip())
with open('data/smoke-wordlist.txt') as f:
    wl = set(l.strip() for l in f if l.strip())
missing = pws - wl
print(f'Missing from wordlist: {missing}' if missing else 'All passwords in wordlist')
"
```

## Results Archive

Test results are saved to `data/smoke-results-v3-{timestamp}.json`:

```json
{
  "provider": "XCP-ng",
  "status": "pass",
  "deployTime": 285,
  "crackTime": 180,
  "totalTime": 465,
  "crackedCount": 47,
  "totalHashes": 47,
  "agentCount": 2,
  "workersEngaged": 2
}
```
