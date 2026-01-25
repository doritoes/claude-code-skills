# AI Agent Operational Discipline

Guidelines for autonomous Hashcrack operations.

---

## Session Learnings (2026-01-25)

### GPU Validation Testing Session (Continued)

7. **GPU workers boot slower**: GPU instances (g4dn.xlarge) take 5-7 minutes for cloud-init due to NVIDIA driver installation. **FIX**: Use 300+ second polling timeout for GPU agent registration.

8. **GPU agent cpuOnly setting**: GPU agents MUST have `cpuOnly=0` in Agent table. Without this, they won't receive GPU-appropriate tasks.

9. **File size mismatch causes download loop**: When staging files via direct SQL INSERT, the `size` field MUST match actual file size. Mismatch causes agents to re-download infinitely. **FIX**: Verify with `stat -c %s /path/to/file` before/after INSERT.

10. **Mixed hash types in hashlist fail**: T14 accidentally included SHA512 hash in SHA256 hashlist. Hashcat ignores incompatible hashes silently. **FIX**: Validate hash format before insertion.

### CPU Validation Testing Session (Earlier)

1. **Shell escaping in SSH+Docker**: Inline MySQL with shell variables FAILS. **FIX**: Create SQL file locally, scp to server, use `docker exec -i ... < file.sql`

2. **Chunk sizing correlates with useNewBench**: T01 (MD5, useNewBench=1) had 362 chunks of ~39K. T02 (SHA256, useNewBench=0) had 1 giant chunk of 14M. Verify useNewBench setting before task creation.

3. **Hashes crack early in wordlist**: Common passwords are at the beginning of rockyou.txt. Tasks may show 1% progress but 100% cracked. Don't wait for 100% keyspace progress if all hashes are cracked.

4. **Rule attacks only use 1 worker**: T03 confirmed: massive keyspace (695B) but only 1 worker active. Archive impractical rule attacks early.

5. **Spot capacity in us-east-1**: AWS spot capacity not available. **FIX**: Use us-west-2 instead.

6. **Task priority must be > 0**: Tasks with priority=0 don't get dispatched. Completed tasks auto-set to priority=0.

---

## Session Learnings (2026-01-23 / 2026-01-24)

### Key Failures and Corrections

1. **Terraform state lock on Windows**: Orphaned `terraform-provider-*` processes hold file locks. **FIX**: Kill all terraform-provider-* with PowerShell before retry.

2. **GCP worker_public_ip**: Use `worker_public_ip = true` (simpler). Cloud NAT causes download issues.

3. **N voucher method works**: Terraform creates N vouchers automatically. DON'T manually create - wait for cloud-init to complete.

4. **Parallel rule attacks**: Split HASHES across N hashlists, create N TaskWrappers (one per hashlist), N Tasks with maxAgents=1.

5. **Taint slow workers**: If worker cloud-init is stuck, taint and recreate instead of waiting.

6. **Follow GATES strictly**: Trust the step-by-step gated process. Don't skip ahead or assume failures.

7. **GCP Ubuntu 24.04 image name**: Use `ubuntu-os-cloud/ubuntu-2404-lts-amd64` (NOT `ubuntu-2404-lts`). The `-amd64` suffix is required.

---

## ⛔ CRITICAL: Error Classification System

**BEFORE sleeping or retrying on ANY error, classify it first:**

### Immediate Errors (DO NOT SLEEP - FIX NOW)
| Error Pattern | Meaning | Action |
|---------------|---------|--------|
| "No valid credential sources" | Missing AWS/Azure/GCP credentials | Export credentials from .env |
| "AADSTS" errors | Azure auth failed | Check ARM_* variables |
| "Could not find default credentials" | GCP auth failed | Set GOOGLE_APPLICATION_CREDENTIALS |
| "Invalid query!" | Wrong API endpoint/params | Check API docs, use v1 not v2 |
| "resource not found" | Wrong resource ID | Verify resource exists |
| "crackerBinaryId=NULL" | Missing required field | Set field before proceeding |
| "useNewBench mismatch" | Wrong benchmark format | Query Assignment table, fix setting |
| "No route to host" | Wrong IP configured | Get actual IP from hypervisor API |
| "Wrong username/password" | Credential issue | Reset password with PHP script |

### Timing Errors (SLEEP with MAX 3 RETRIES)
| Error Pattern | Meaning | Sleep | Max Wait |
|---------------|---------|-------|----------|
| "Connection refused" port 8080 | Server not ready | 30s | 3 min |
| "Connection refused" SSH | VM booting | 15s | 2 min |
| "cloud-init not complete" | Packages installing | 30s | 7 min |
| "Agent not registered" | Agent starting | 15s | 2 min |
| "NetworkSecurityGroupOldReferences" | Azure cleanup | 60s | 3 min |

### Resource Errors (VERIFY THEN RE-RUN)
| Error Pattern | Meaning | Action |
|---------------|---------|--------|
| "TOO_MANY_STORAGE_MIGRATES" | XCP-ng limit | Re-run terraform apply |
| "Quota exceeded" | Cloud limit | Request quota increase |
| "Spot capacity not available" | No spot instances | Try different zone or on-demand |

### ⚠️ THE ANTI-PATTERN TO AVOID
```
❌ WRONG: Error occurred → sleep 60s → retry → same error → sleep 60s → ...
✅ RIGHT: Error occurred → classify error → if immediate: fix now, if timing: sleep with limit
```

---

## ⛔ CRITICAL: Terraform State Safety Check (2026-01-24)

**NEAR-MISS INCIDENT:** Almost destroyed active AWS CPU test (2160 cracked hashes) while attempting to deploy GPU test.

### The Rule
**BEFORE any terraform plan/apply/destroy on a provider, ALWAYS:**

```bash
# Step 1: Check state count
STATE_COUNT=$(terraform state list 2>/dev/null | wc -l)
echo "Terraform state resources: $STATE_COUNT"

# Step 2: If state > 0, CHECK FOR ACTIVE WORK
if [ "$STATE_COUNT" -gt 0 ]; then
  echo "⚠️ ACTIVE DEPLOYMENT DETECTED - Checking for running jobs..."
  SERVER_IP=$(terraform output -raw server_public_ip 2>/dev/null)
  # Check for active cracking
  ssh ubuntu@$SERVER_IP "docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -sNe 'SELECT COUNT(*) FROM Hash WHERE isCracked=1;'"
fi
```

### Decision Matrix

| State Count | Active Job? | Action |
|-------------|-------------|--------|
| 0 | N/A | Safe to deploy |
| > 0 | No (0 cracked, no tasks) | Safe to destroy and redeploy |
| > 0 | Yes (cracked > 0, tasks running) | **STOP - DO NOT DESTROY** |
| > 0 | Unknown (can't SSH) | **STOP - Investigate first** |

### Why This Matters
- Each terraform state is tied to ONE configuration
- Cannot run multiple tests on same provider simultaneously
- Destroying active deployment = **LOSING RESEARCH DATA**
- Provider-level parallelism requires separate workspaces or waiting

### Multi-Provider Parallel Testing
When running tests across providers:
1. Check EACH provider's state before starting new work
2. Track which providers have active tests
3. Queue GPU tests for after CPU tests complete
4. Consider terraform workspaces for same-provider parallelism (advanced)

---

## Core Principles

1. **Check terraform state FIRST** before any terraform operation
2. **Read SKILL.md FIRST** before any operation
3. **Follow documented processes** - don't improvise
4. **Check existing learnings** before troubleshooting novel issues
5. **Document new learnings** in appropriate topic file
6. **Classify errors before sleeping** - see Error Classification above

## Handling Large SKILL.md Files

**Problem:** SKILL.md may exceed token limits (e.g., 32794 tokens > 25000 limit).

**CRITICAL RULE:** Never skip sections of SKILL.md - read entire file sequentially.

**Solution:** Read in chunks using offset/limit parameters:
```
Read(file_path, offset=1, limit=300)    # Lines 1-300
Read(file_path, offset=301, limit=300)  # Lines 301-600
Read(file_path, offset=601, limit=300)  # Lines 601-900
... continue until entire file read
```

**Why this matters:**
- SKILL.md contains critical operational procedures
- Missing sections causes cascading failures
- Steps are ordered specifically - skipping breaks the process
- Troubleshooting sections prevent repeated mistakes

## Before Each Operation

| Operation | Files to Read |
|-----------|---------------|
| New deployment | skill.md (step-by-step), deployment.md |
| Creating tasks | api.md, optimization.md |
| Troubleshooting | anti-patterns.md, provider-specific file |
| Teardown | teardown.md |

## Context Management

- Don't waste context on troubleshooting documented issues
- If something fails, check learnings FIRST
- Document new issues immediately for future sessions

## Process Adherence

**Follow the step-by-step processes EXACTLY:**
- The steps are in specific order for a reason
- Skipping steps causes cascading failures
- If a step fails, fix it before proceeding

**Example:** Creating vouchers BEFORE workers boot prevents race conditions.

## When Things Go Wrong

1. **Check learnings/** for known issue
2. **Check skill.md** for documented process
3. **If truly novel**, investigate and document
4. **Don't repeat mistakes** - update learnings

## Session Handoff

When session ends or context compacts:
- Update test-results.md with new data
- Add new learnings to appropriate file
- Note current state in session summary

## Cost Awareness

- Recommend spot/preemptible for workers
- Suggest scale-down when idle
- Calculate feasibility before long-running tasks
- Destroy resources when done

## Reducing Manual Approvals

**PREFER PRE-APPROVED PATTERNS:** Before constructing commands, check settings.local.json for existing approved patterns. Use approved patterns instead of bespoke alternatives.

**Example:** Instead of `TOTAL=5000`, use `HASH_COUNT=5000` if `HASH_COUNT=*` is already approved.

Common bash patterns that need pre-approval in settings.local.json:
- Variable assignments: `SERVER_IP=*`, `WORKER*=*`, `RESULT=*`, `DB_PASS=*`, `HASH_COUNT=*`
- Metric variables: `FIRST_HASH_TIME=*`, `CRACKED=*`, `SPEED=*`, `PROGRESS=*`, `PERCENT=*`
- Timing variables: `DEPLOY_START=*`, `INFRA_READY=*`, `SERVER_READY=*`, `TASK_CREATE=*`
- Control flow: `for:*`, `while:*`, `if:*`, `then:*`, `else:*`, `do`, `done`, `fi`, `wait`, `break`
- Loop bodies: `do echo*`, `do count=*`, `for IP in *`, `for ip in *`
- Commands: `sleep:*`, `tail:*`, `head:*`, `cd:*`, `watch:*`, `docker:*`
- Cloud CLIs: `oci:*`, `aws:*`, `az:*`, `gcloud:*`, `terraform:*`
- Comments: `#:*` (commands starting with comments)

## Session Handoff Checklist

When session ends or context compacts:
1. Update test-results.md with new data
2. Add new learnings to appropriate file
3. Note current infrastructure state (what's deployed)
4. Document any credentials/IPs discovered
5. Commit skill updates if significant changes

## Making Skills "Claude-Proof" (2026-01-19 Learning)

**Problem:** Claude tends to "summarize" or "improvise" instead of following step-by-step procedures, causing cascading failures.

**Root Cause Analysis:**
- Pitfalls tables are **conceptual** (describe the issue) not **procedural** (how to fix)
- Workflows have gaps that smoke tests fill with explicit code
- Claude sees "check priority > 0" and thinks "I'll handle that" instead of running verification SQL

**Solution: Pre-Flight Checklists**

Every workflow that touches the database MUST have a Pre-Flight Checklist with:

1. **Explicit copy-paste SQL** - Not descriptions, actual commands
2. **Expected output** - What success looks like
3. **Verification after each step** - Confirm before proceeding
4. **CRITICAL markers** - Highlight fields that MUST be set correctly

**Example Pattern:**
```markdown
### Step X: Verify Thing

```bash
ssh ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -sNe 'SELECT field FROM Table;'"
```
**Expected:** `value`
**If wrong:** Run `UPDATE Table SET field = value WHERE condition;`
```

**Key Learnings from Failed XCP-ng Test:**

| Issue | Root Cause | Fix Implemented |
|-------|------------|-----------------|
| Single voucher for 4 workers | Terraform created 1 voucher | `count = var.worker_count` in main.tf |
| Agents can't download files | `isSecret=0` on File records | Added to pitfalls: `isSecret=1` required |
| Task never dispatches | `priority=0`, `crackerBinaryId=NULL` | Added Pre-Flight Checklist to Crack.md |
| Keyspace wrong for rule attack | Not calculated: wordlist × rules | Added explicit formula to Crack.md |

**The smoke test works because it's CODE, not prose.** Workflows must be equally explicit.
