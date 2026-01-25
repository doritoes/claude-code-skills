# Azure-Specific Learnings

## Instance Types

| Role | Size | Specs | Cost/hr |
|------|------|-------|---------|
| Server | Standard_D2s_v3 | 2 vCPU, 8GB | $0.096 |
| CPU Worker | Standard_D4s_v3 | 4 vCPU, 16GB | $0.192 |
| GPU Worker | Standard_NC4as_T4_v3 | T4 GPU | $0.526 |

## Spot Instances

- Use `use_spot_instances = true`
- Resource group cleanup can be slow
- NSG deletion may require retry

## Destroy Timing

Azure destroy can hit errors:
```
NetworkSecurityGroupOldReferencesNotCleanedUp
```
**Solution:** Wait 60 seconds and retry `terraform destroy`.

## SSH Key Requirements

- Azure accepts RSA keys (generated during deployment)
- ed25519 may require manual testing
- **CRITICAL:** Always specify the SSH key explicitly with `-i ~/.ssh/azure_hashcrack`
- The default SSH key agent may not have the Azure key loaded
- All SSH commands must include `-i $AZURE_SSH_KEY` where `AZURE_SSH_KEY="$HOME/.ssh/azure_hashcrack"`

## Networking

- Workers now have public IPs (like AWS) for cloud-init internet access
- Workers need public IPs to download packages, Hashtopolis agent, and hashcat binary
- Can SSH directly to workers: `ssh -i ~/.ssh/azure_hashcrack ubuntu@WORKER_PUBLIC_IP`
- Workers communicate with server via private IPs internally

## Performance Notes

- Slowest CPU performance of cloud providers tested
- 9h 41m vs GCP's ~8h for same workload
- GPU performance comparable to AWS

---

## CRITICAL: File Staging (2026-01 Discovery)

### Correct File Path
**MUST use:** `/usr/local/share/hashtopolis/files/`

**WRONG paths (cause ERR3 "file not present"):**
- `/var/www/hashtopolis/files/` - Looks correct but WRONG
- `/var/lib/docker/volumes/hashtopolis_files/_data/` - Docker volume path, WRONG

### isSecret Setting
**`isSecret=1` is REQUIRED** for trusted agents to download files!

```sql
INSERT INTO File (filename, size, isSecret, fileType, accessGroupId, lineCount)
VALUES ('rockyou.txt', 139921497, 1, 0, 1, 14344391);
                              ↑
                       MUST be 1!
```

### File Ownership
Use explicit filenames - glob expansion fails in SSH:
```bash
# WRONG - glob fails
ssh ubuntu@$IP "docker exec container chown www-data:www-data /path/*"

# CORRECT - explicit names
ssh ubuntu@$IP "docker exec container chown www-data:www-data /path/rockyou.txt /path/rule.rule"
```

---

## CRITICAL: Rule Attack Parallelization (2026-01 Discovery)

### The Problem
For rule attacks, hashcat's `-s` (skip) parameter skips **WORDS**, not keyspace positions.
Result: Only chunk 0 works. Other chunks skip more words than the wordlist has.

**Symptom:** 4 workers but only 1 active for rule attacks.

### The Solution
Split HASHES into N hashlists, create N tasks with `maxAgents=1`:

| Setup | Workers Active | Why |
|-------|----------------|-----|
| 1 hashlist, 1 task, maxAgents=0 | **1 worker** | All agents pile on same task, only chunk 0 works |
| 4 hashlists, 4 tasks, maxAgents=1 | **4 workers** | Each agent forced to different task |

### Critical Settings

```sql
-- TaskWrapper: maxAgents=0 (default, task-level overrides)
INSERT INTO TaskWrapper (..., maxAgents) VALUES (..., 0);

-- Task: maxAgents=1 (CRITICAL!)
INSERT INTO Task (..., maxAgents, ...) VALUES (..., 1, ...);
```

Without `maxAgents=1`, all agents go to the first task (same priority = same choice).

---

## crackerBinaryId (2026-01 Discovery)

**MUST NOT be NULL** or agents get "Invalid cracker binary type id!" error.

Always verify before task creation:
```bash
CRACKER_ID=$(ssh ubuntu@$IP "docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -sNe 'SELECT crackerBinaryId FROM CrackerBinary LIMIT 1;'")
# Use $CRACKER_ID in Task INSERT, NOT hardcoded 1
```

---

## Voucher Creation (2026-01 Discovery)

**Cloud-init does NOT reliably create vouchers.** Always check and create manually.

```bash
# Check voucher count
VOUCHER_COUNT=$(ssh ubuntu@$IP "docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -sNe 'SELECT COUNT(*) FROM RegVoucher;'")

# If 0, create vouchers manually
for i in $(seq 1 $WORKER_COUNT); do
  ssh ubuntu@$IP "docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -e \"INSERT INTO RegVoucher (voucher, time) VALUES ('AZURE_WORKER_$i', UNIX_TIMESTAMP());\""
done
```

---

## Docker exec -u root (2026-01 Discovery)

**chown inside container requires `-u root` flag:**

```bash
# WRONG - fails with "Operation not permitted"
docker exec hashtopolis-backend chown www-data:www-data /path/file

# CORRECT
docker exec -u root hashtopolis-backend chown www-data:www-data /path/file
```

---

## 2>/dev/null for MySQL Commands

Always append `2>/dev/null` to suppress MySQL password warnings:
```bash
ssh ubuntu@$IP "docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -sNe 'SELECT ...' " 2>/dev/null
```

---

## 2026-01-24 Full Test Results

**Parallel Rule Attack SUCCESS:**
- 4 workers, 4 hashlists (1250 hashes each), 4 tasks with maxAgents=1
- All 4 workers active simultaneously (confirmed via Assignment table)
- 859 hashes cracked in first 60 seconds
- Keyspace: 695 billion (14M words x 48K rules)

**Time Metrics:**
- Deployment start to agents ready: ~13 minutes
- First hash cracked: ~2 minutes after task creation
- True 4x parallelization achieved for rule attacks
