# Teardown Session Failures - 2026-01-29

## Summary

During a graceful teardown of Azure (5 workers) and OCI (4 workers), multiple workers were incorrectly terminated while still processing work units, resulting in lost FAH research.

## Workers Lost

| Provider | Worker | Progress When Killed | Research Lost |
|----------|--------|---------------------|---------------|
| Azure | pai-fold-1 | ~24% | Yes |
| Azure | pai-fold-2 | ~24% | Yes |
| Azure | pai-fold-3 | ~12% | Yes |
| Azure | pai-fold-4 | ~16% | Yes |
| Azure | pai-fold-5 | ~17% | Yes |

**Total: 5 Azure workers lost, ~93% combined progress wasted**

## Root Causes

### 1. SSH Failure Misinterpreted as VM Stopped

**Pattern:** When SSH connection failed, Claude assumed the VM was stopped.

**Reality:** SSH failure can mean:
- Network timeout
- SSH daemon issue
- VM in transitional state
- Firewall blocking
- VM actually stopped (only 1 of many possibilities)

**Fix:** SSH failure = UNKNOWN state. Must verify via cloud provider API.

### 2. Ad-libbing Monitor Scripts

**Pattern:** Instead of using documented `WorkerControl.ts`, created 3 different bash scripts that all had critical flaws.

**Flaw in scripts:**
```bash
# WRONG - assumed SSH failure meant stopped
if [[ -z "$output" ]]; then
    POWERED_DOWN[$ip]="true"  # DANGEROUS ASSUMPTION
fi
```

**Fix:** Use the documented tools. They exist for a reason.

### 3. Background Commands Executed Unexpectedly

**Pattern:** Sent `az vm deallocate` commands, thought they were stopped, but they continued executing.

**Fix:**
- Never run destructive commands in background
- Wait for confirmation before proceeding
- Check command actually completed

### 4. Summarizing Instructions Incorrectly

**User said:** "monitor every 15 minutes, power down PAUSED workers"

**What Claude did:** Powered down workers on SSH timeout, not on confirmed PAUSED state.

**Fix:**
- Re-read instructions before acting
- Only act on EXPLICIT criteria (`paused: true`)
- When in doubt, ask

### 5. OCI CLI Repeated Failures

**Pattern:** OCI CLI timed out on every attempt, yet kept trying the same approach 5+ times.

**Fix:**
- After 1-2 failures of same method, try alternative
- Ask user for guidance
- Document that OCI CLI is unreliable from this environment

### 6. Context Loss During Session Continuation

**Pattern:** After context compaction, Claude lost track of which workers were still active. pai-fold-5 was killed despite being actively folding at ~17% progress.

**Reality:**
- Session context compacted while monitoring was in progress
- State of which workers were safe to stop was lost
- Destructive commands may have continued executing in background

**Fix:**
- Never run destructive monitoring loops that span context boundaries
- Use external state file to track worker status
- Require explicit user confirmation for each worker before any stop action

## Anti-Patterns Discovered

### NEVER DO:
1. Assume SSH failure = VM stopped
2. Run destructive commands in background
3. Batch-process stop commands without individual verification
4. Act on "empty output" as a signal
5. Retry same failing approach repeatedly
6. Run long-running destructive monitoring across context boundaries
7. Trust state from before context compaction

### ALWAYS DO:
1. Verify `paused: true` from `lufah state` before any stop action
2. Use cloud provider API to confirm VM state
3. Wait for explicit confirmation
4. Log all destructive actions
5. Ask user when uncertain
6. Re-verify state after any context interruption
7. Use external state file for cross-context operations
8. Require explicit user confirmation for EACH worker before stop

## Skill Improvements Needed

1. **Documentation:**
   - Add ANTI-PATTERNS section to GracefulShutdown.md
   - Document OCI-specific workflows
   - Document provider-specific SSH credentials

2. **Tools:**
   - Add `--provider` flag to WorkerControl.ts
   - Add `poweroff` command (cloud API, not SSH)
   - Create read-only MonitorWorkers.ts
   - Add pre-flight safety checks

3. **Process:**
   - Mandatory confirmation before destructive actions
   - Separation of monitoring from action-taking
   - Audit trail for all stop/destroy operations

## Correct Teardown Procedure

```bash
# 1. Send finish (already done earlier in session)
for IP in $WORKER_IPS; do
  bun run WorkerControl.ts finish $IP
done

# 2. Monitor via FAH Portal (source of truth)
# User watches dashboard, reports when workers show "Paused"

# 3. For each CONFIRMED paused worker:
#    a. Verify via WorkerControl.ts status shows paused: true
#    b. Then and only then, power off via cloud API

# 4. After ALL workers powered off (verified via cloud API):
terraform destroy -auto-approve
```

## Key Lesson

**The FAH Portal is the source of truth, not SSH connectivity.**

When user says "pai-fold-oci-4 is paused" - that's authoritative.
When SSH times out - that's inconclusive.
