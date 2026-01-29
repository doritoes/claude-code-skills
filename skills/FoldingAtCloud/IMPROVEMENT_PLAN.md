# FoldingAtCloud Improvement Plan

**Date:** 2026-01-29
**Trigger:** Complete teardown failure - 5/5 Azure workers lost, all terminated mid-WU

---

## Executive Summary

The FoldingAtCloud skill failed catastrophically during a graceful teardown. All 5 Azure workers were terminated while actively folding, losing approximately 93% combined work unit progress. Root causes include: SSH failure misinterpretation, ad-hoc scripting instead of using documented tools, background command execution, and context loss during session continuation.

---

## Severity Assessment

| Issue | Severity | Impact |
|-------|----------|--------|
| SSH failure → assumed stopped | CRITICAL | 4+ workers killed |
| No provider-specific credentials | HIGH | SSH auth failures |
| Ad-hoc scripts vs documented tools | HIGH | Flawed logic |
| Background destructive commands | HIGH | Uncontrolled execution |
| Context loss state tracking | MEDIUM | pai-fold-5 killed after compaction |
| OCI CLI unreliability | MEDIUM | Forced manual workarounds |

---

## Phase 1: Immediate Safety Fixes (BLOCKING)

### 1.1 Add `can-stop` Safety Check to WorkerControl.ts ✅
**Status:** DONE (added earlier this session)

The `can-stop` command now:
- Returns `safe: false` if SSH fails (UNKNOWN state, not stopped)
- Returns `safe: false` if `paused: false`
- Returns `safe: true` ONLY if SSH succeeds AND `paused: true`

### 1.2 Add Provider-Specific SSH Config ✅
**Status:** DONE (added earlier this session)

WorkerControl.ts now supports:
- `--provider azure|oci|aws|gcp` flag
- Reads from environment: `AZURE_SSH_USER`, `AZURE_SSH_KEY`, etc.
- .env.example documents all required variables

### 1.3 Add ANTI-PATTERNS to GracefulShutdown.md ✅
**Status:** DONE (added earlier this session)

Six critical anti-patterns documented with examples.

---

## Phase 2: Separation of Concerns (Required)

### 2.1 Create MonitorWorkers.ts (READ-ONLY)

**Purpose:** Monitor worker states without any ability to take action.

```typescript
// MonitorWorkers.ts - READ ONLY, NO DESTRUCTIVE ACTIONS

Commands:
  list                  List all workers from terraform state
  status-all            Get status of all workers (SSH + lufah)
  watch                 Continuous monitoring (refresh every N seconds)

Output format:
  JSON with: ip, provider, fah_state (folding/finishing/paused/unknown),
             ssh_reachable, last_check, units_running

CRITICAL: This tool has NO stop/pause/deallocate capabilities.
```

### 2.2 Create ProviderControl.ts (Cloud API Operations)

**Purpose:** Interact with cloud provider APIs (NOT SSH).

```typescript
// ProviderControl.ts - Cloud API operations

Commands:
  vm-state <provider> <vm-name>    Get VM power state from cloud API
  vm-stop <provider> <vm-name>     Stop VM (ONLY if pre-checks pass)
  vm-list <provider>               List VMs from cloud API

Pre-flight checks for vm-stop:
  1. Verify FAH paused state via WorkerControl.ts can-stop
  2. Require explicit --confirm flag
  3. Log action to audit file
```

### 2.3 Create StateTracker.ts (Persistent State)

**Purpose:** Track worker states across context boundaries.

```typescript
// StateTracker.ts - Persistent state management

File: .claude/skills/FoldingAtCloud/state/workers.json

Operations:
  record <ip> <state>              Record worker state
  get <ip>                         Get recorded state
  list                             List all recorded states
  age <ip>                         Time since last update

States: UNKNOWN | FOLDING | FINISHING | PAUSED | STOPPED | DESTROYED
```

---

## Phase 3: Workflow Improvements (Required)

### 3.1 Update Teardown Workflow

Replace current workflow with explicit, user-confirmed steps:

```
TEARDOWN WORKFLOW (Revised)

STEP 1: FINISH SIGNAL (Claude executes)
  - Send `lufah finish` to all workers
  - Record timestamp and worker list

STEP 2: MONITORING (User-driven)
  - User monitors FAH Portal (source of truth)
  - User reports when workers show "Paused"
  - Claude MAY NOT infer state from SSH failures

STEP 3: VERIFICATION (Claude verifies, user confirms)
  For EACH worker user reports as paused:
    a. Claude runs: WorkerControl.ts can-stop $IP --provider $PROVIDER
    b. Claude reports result to user
    c. User confirms "proceed with $WORKER"
    d. Only then: Claude powers off that specific VM

STEP 4: CLEANUP (User initiates)
  - User confirms ALL workers powered off
  - User says "destroy infrastructure"
  - Claude runs terraform destroy

CRITICAL: Claude NEVER autonomously powers off a VM.
```

### 3.2 Add Audit Logging

All destructive actions must be logged:

```
Location: .claude/skills/FoldingAtCloud/logs/audit.log

Format:
2026-01-29T14:32:00Z | STOP | azure | pai-fold-1 | 20.120.1.100 | CONFIRMED_PAUSED
2026-01-29T14:35:00Z | DESTROY | oci | terraform destroy | SUCCESS
```

---

## Phase 4: Documentation Updates (Required)

### 4.1 Create Workflows/SafeTeardown.md

Step-by-step teardown with checkboxes:

```markdown
# Safe Teardown Workflow

## Pre-flight
- [ ] Identify all workers: `terraform output worker_ips`
- [ ] Open FAH Portal in browser

## Step 1: Signal Finish
- [ ] Run: `for IP in $IPS; do bun WorkerControl.ts finish $IP; done`
- [ ] Timestamp: ___________

## Step 2: Monitor (USER WATCHES PORTAL)
- [ ] pai-fold-1: Paused at ___________
- [ ] pai-fold-2: Paused at ___________
... etc

## Step 3: Verify and Power Off (ONE AT A TIME)
For each paused worker:
- [ ] Run: `bun WorkerControl.ts can-stop $IP --provider $PROVIDER`
- [ ] Result: safe=true? ___
- [ ] Power off: `az vm deallocate -g $RG -n $NAME` / `oci compute instance action`
- [ ] Verify stopped via cloud API

## Step 4: Destroy Infrastructure
- [ ] All workers confirmed stopped
- [ ] Run: `terraform destroy`
```

### 4.2 Update Main README.md

Add warning banner:

```markdown
## ⚠️ Critical Safety Rules

1. **SSH failure ≠ VM stopped.** NEVER assume.
2. **Only `paused: true` is safe.** Nothing else.
3. **User confirms each worker.** Claude does not act autonomously.
4. **FAH Portal is source of truth.** Not SSH output.

See `GracefulShutdown.md` ANTI-PATTERNS section.
```

---

## Phase 5: OCI-Specific Improvements (Optional)

### 5.1 Document OCI CLI Issues

- OCI CLI (`oci.exe`) times out frequently from this environment
- Prefer terraform for state queries
- Document manual console fallback

### 5.2 Add OCI Terraform Queries

```bash
# Get worker states from terraform
cd terraform/oci
terraform refresh
terraform state show oci_core_instance.foldingcloud_worker[0] | grep state
```

---

## Implementation Priority

| Phase | Priority | Effort | Status |
|-------|----------|--------|--------|
| 1.1 can-stop | P0 | ✅ | DONE |
| 1.2 provider SSH | P0 | ✅ | DONE |
| 1.3 anti-patterns | P0 | ✅ | DONE |
| 2.1 MonitorWorkers.ts | P1 | ✅ | DONE |
| 2.2 ProviderControl.ts | P1 | ✅ | DONE |
| 2.3 StateTracker.ts | P2 | ✅ | DONE |
| 3.1 Teardown workflow | P1 | ✅ | DONE |
| 3.2 Audit logging | P2 | ✅ | DONE |
| 4.1 SafeTeardown.md | P1 | ✅ | DONE |
| 4.2 README warning | P0 | ✅ | DONE |
| 5.x OCI docs | P3 | 30 min | TODO |

---

## Success Criteria

After implementing these improvements:

1. **Zero unintended worker terminations** - No worker killed without explicit `paused: true` + user confirmation
2. **Clear audit trail** - Every stop/destroy action logged with timestamp and state
3. **Separation of read/write** - Monitoring cannot trigger destructive actions
4. **Context-safe operations** - State persisted externally, not reliant on conversation context
5. **User-driven teardown** - Claude assists but user controls each step

---

## Lessons Learned

1. **Trust the documented tools** - Ad-hoc scripts introduce bugs
2. **SSH failure is UNKNOWN, not STOPPED** - Always verify via cloud API
3. **Background commands are dangerous** - Wait for completion
4. **User instruction must be followed literally** - "power down PAUSED workers" means paused=true
5. **FAH Portal is authoritative** - Not SSH output
6. **Context boundaries require state files** - Don't trust in-memory state

---

## Sign-off

This plan addresses all failures from the 2026-01-29 session. Implementation should be completed before any future Folding@Cloud deployments.
