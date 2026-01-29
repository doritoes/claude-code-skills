# Safe Teardown Workflow

This workflow ensures graceful shutdown of Folding@Home workers without losing research.

---

## CRITICAL RULES

1. **SSH failure does NOT mean VM stopped** - NEVER assume
2. **Only `paused: true` is safe to stop** - Nothing else
3. **User confirms EACH worker** - Claude does not act autonomously
4. **FAH Portal is source of truth** - Not SSH output

---

## Pre-Flight Checklist

- [ ] **Open FAH Portal** in browser: https://v8-4.foldingathome.org/
- [ ] **Identify provider(s):** Azure / OCI / AWS / GCP
- [ ] **Identify terraform directory:**
  ```bash
  cd .claude/skills/FoldingAtCloud/terraform/<provider>
  ```
- [ ] **List workers:**
  ```bash
  bun run ../Tools/MonitorWorkers.ts list <provider>
  ```

| # | Worker Name | IP Address | Provider |
|---|-------------|------------|----------|
| 1 | ____________ | __________ | ________ |
| 2 | ____________ | __________ | ________ |
| 3 | ____________ | __________ | ________ |
| 4 | ____________ | __________ | ________ |
| 5 | ____________ | __________ | ________ |

---

## Step 1: Send FINISH Signal

Send `lufah finish` to all workers. This tells FAH to complete current work unit then pause.

```bash
# For each worker:
bun run Tools/WorkerControl.ts finish <IP> --provider <provider>
```

**Log the timestamp:**
- [ ] Finish signals sent at: ___________

**Expected behavior:**
- Workers continue processing current WU
- Workers will NOT request new work
- Workers transition to PAUSED when WU completes

---

## Step 2: Monitor Progress (USER WATCHES PORTAL)

**Claude MAY NOT infer state from SSH failures.**

User monitors FAH Portal and reports when workers show "Paused":

| Worker | FAH Portal Status | Paused Time |
|--------|-------------------|-------------|
| _______ | Folding / Finishing / **Paused** | _________ |
| _______ | Folding / Finishing / **Paused** | _________ |
| _______ | Folding / Finishing / **Paused** | _________ |
| _______ | Folding / Finishing / **Paused** | _________ |
| _______ | Folding / Finishing / **Paused** | _________ |

**Optional: Automated monitoring (read-only)**
```bash
bun run Tools/MonitorWorkers.ts watch <provider> --interval 60
```

**Timeout guidance:**
- CPU work units: 10-30 minutes typical
- Some WUs: Up to 1-2 hours
- Default timeout: 30 minutes (`FOLDING_GRACEFUL_TIMEOUT=1800`)

---

## Step 3: Verify and Power Off (ONE AT A TIME)

For EACH worker that user reports as paused:

### 3a. Verify FAH state
```bash
bun run Tools/WorkerControl.ts can-stop <IP> --provider <provider>
```

**Expected output:**
```json
{
  "safe": true,
  "reason": "Worker confirmed paused - safe to stop"
}
```

**If `safe: false`:** DO NOT PROCEED. Wait or investigate.

### 3b. Record state
```bash
bun run Tools/StateTracker.ts record <IP> PAUSED --provider <provider> --name <vm-name>
```

### 3c. User confirms
- [ ] User says: "Proceed with <worker-name>"

### 3d. Power off VM
```bash
# Azure
bun run Tools/ProviderControl.ts vm-stop azure <vm-name> --confirm --ip <IP>

# Or manually:
az vm deallocate --resource-group foldingcloud-rg --name <vm-name>
```

### 3e. Verify stopped
```bash
bun run Tools/ProviderControl.ts vm-state <provider> <vm-name>
```

**Expected:** `power_state: "VM deallocated"` or `"STOPPED"`

### 3f. Update state tracker
```bash
bun run Tools/StateTracker.ts record <IP> STOPPED --provider <provider>
```

---

## Step 4: Destroy Infrastructure

**Only proceed when ALL workers are confirmed STOPPED.**

### 4a. Final verification
```bash
bun run Tools/ProviderControl.ts vm-list <provider>
bun run Tools/StateTracker.ts list
```

### 4b. User confirms
- [ ] User says: "All workers stopped, proceed with destroy"

### 4c. Terraform destroy
```bash
cd terraform/<provider>
terraform destroy -auto-approve
```

### 4d. Log completion
```bash
bun run Tools/AuditLog.ts log DESTROY_SUCCESS <provider> "terraform" "All workers" "Infrastructure destroyed"
bun run Tools/StateTracker.ts clear
```

---

## Completion Checklist

- [ ] All workers sent FINISH signal
- [ ] All workers confirmed PAUSED in FAH Portal
- [ ] All workers verified via `can-stop` command
- [ ] All workers powered off via cloud API
- [ ] All workers verified STOPPED state
- [ ] terraform destroy completed
- [ ] Audit log entries created
- [ ] State tracker cleared

---

## Emergency Override

If graceful shutdown is impossible (runaway costs, security incident):

```bash
# Force destroy - ACCEPTS WU LOSS
cd terraform/<provider>
terraform destroy -auto-approve

# Document reason
bun run Tools/AuditLog.ts log EMERGENCY_DESTROY <provider> "all" "<reason>" "FORCED"
```

**Always document the reason for emergency override.**

---

## Troubleshooting

### SSH connection fails
- **DO NOT** assume VM is stopped
- Verify via cloud provider API:
  ```bash
  bun run Tools/ProviderControl.ts vm-state <provider> <vm-name>
  ```

### Worker stuck in FINISHING
- Check FAH Portal for actual progress
- Some WUs take 1-2 hours
- Consider timeout after 30+ minutes

### OCI CLI timeouts
- OCI CLI is unreliable from this environment
- Use terraform state or OCI Console instead:
  ```bash
  cd terraform/oci
  terraform show | grep state
  ```

### Context compaction during teardown
- State is preserved in `state/workers.json`
- Check with: `bun run Tools/StateTracker.ts list`
- Resume from last confirmed state

---

## Audit Trail

All actions are logged to: `logs/audit.log`

View recent entries:
```bash
bun run Tools/AuditLog.ts show 20
```

Search for specific actions:
```bash
bun run Tools/AuditLog.ts search "STOP"
```
