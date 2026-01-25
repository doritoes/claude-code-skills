# FoldingAtCloud Deployment Learnings

## 2026-01-25: Initial Deployment

### Issue 1: FAH Client Version
- **Requirement:** v8.5 client per user directive
- **Problem:** Initial URL used v8.5.4 which didn't exist
- **Solution:** v8.5.5 is the correct latest v8.5 release at `https://download.foldingathome.org/releases/public/fah-client/debian-10-64bit/release/fah-client_8.5.5_amd64.deb`
- **Fix:** Updated cloud-init template to use v8.5.5

### Issue 2: Azure SSH Key Type
- **Problem:** Azure doesn't support ed25519 SSH keys
- **Solution:** Use RSA key (azure_hashcrack.pub)
- **Note:** Store Azure-specific RSA key path in learnings

### Issue 3: Azure Spot Quota
- **Problem:** Azure eval has 3 core limit for low-priority (Spot) VMs
- **Solution:** Scale to 1 worker (2 cores) or use reserved instances
- **Note:** Eval/trial credits work with reserved instances too

### Issue 4: CPUs Not Configured
- **Problem:** FAH client starts but shows "No resources"
- **Solution:** Run `lufah config cpus N` after service starts
- **Fix:** Added to cloud-init runcmd section

### Issue 6: lufah cpus 0 Doesn't Work
- **Problem:** `lufah config cpus 0` sets cpus to literal 0, not "all"
- **Solution:** Must specify explicit CPU count: `lufah -a / config cpus N`
- **Note:** The `-a /` flag is required to target all resource groups
- **Fix:** Updated cloud-init to use `lufah -a / config cpus ${cpu_count}`

### Issue 5: Abandoned Work Units
- **Critical:** Abandoned WUs are BAD for FAH program
- **Impact:** User may be penalized in points
- **Solution:** ALWAYS use graceful shutdown (`lufah finish` → wait → destroy)
- **Never:** Scale down without finishing current WU

### SSH Key for Azure
```
~/.ssh/azure_hashcrack (RSA key)
```

### Working cloud-init sequence:
1. Install FAH v8.5.5 deb
2. Install lufah via pip3
3. Write config.xml with account-token
4. Enable and start fah-client service
5. Wait 15s for initialization
6. Configure CPUs with `lufah -a / config cpus N`
7. Start folding with `lufah fold`

---

## Graceful Shutdown Workflow

### The FINISH Signal
The `lufah finish` command tells the FAH client to:
1. Complete the current work unit (WU)
2. Upload results to FAH servers
3. Transition to idle/paused state (no new WU requested)

### Why This Matters
- **Abandoned WUs hurt reputation** - User points may be penalized
- **Science is lost** - Partial computation is worthless
- **Good citizenship** - FAH depends on reliable contributors

### Graceful Scale-Down Procedure
```bash
# 1. Signal all workers to finish their current WU
for ip in $WORKER_IPS; do
  ssh user@$ip "lufah finish"
done

# 2. Monitor until all workers are paused
for ip in $WORKER_IPS; do
  while true; do
    state=$(ssh user@$ip "lufah state | jq -r '.groups[\"\"].config.finish'")
    units=$(ssh user@$ip "lufah units 2>/dev/null | grep -c 'Running'")
    if [ "$units" = "0" ]; then
      echo "$ip: Ready for shutdown"
      break
    fi
    echo "$ip: Still finishing WU..."
    sleep 60
  done
done

# 3. Destroy infrastructure only after all WUs complete
terraform destroy
```

### Quick Status Check
```bash
# Check if worker is still processing
lufah units | grep -E "(Running|Finishing)"

# Check finish flag status
lufah state | jq '.groups[""].config.finish'
# true = finish mode active, will pause after WU completes
# false = normal operation, will request new WU after completion
```

### Typical WU Completion Times
- Small WU (16959, 16969): ~14 hours on 2 vCPUs
- Large WU (19229): ~14 hours on 8 vCPUs
- GPU WU: ~15-60 minutes depending on project
- **Plan ahead** - Signal finish early, destroy VMs during off-hours

---

## Anti-Patterns (DO NOT USE)

### Anti-Pattern 1: Spot/Preemptible Instances
**NEVER use spot/preemptible instances for Folding@Cloud**

- **Problem:** Spot instances can be terminated at any time by the cloud provider
- **Impact:** Work units are abandoned when instance is preempted
- **Consequences:**
  - FAH reputation damage - user may be penalized in points
  - Science is lost - partial computation is worthless
  - Unpredictable costs - respawning and re-downloading WUs wastes resources
- **Solution:** Always use on-demand/reserved instances

Even for one-shot GPU jobs, the risk of preemption during the WU computation outweighs the cost savings. A GPU WU takes 15-60 minutes - plenty of time for preemption.

### Anti-Pattern 2: Scaling Without Graceful Shutdown
**NEVER scale down or destroy workers without using `lufah finish`**

- **Problem:** Terraform destroy kills VMs immediately
- **Impact:** Any in-progress WU is abandoned
- **Solution:** Always signal `lufah finish`, wait for completion, then destroy

### Anti-Pattern 3: Starting FAH Before GPU Driver is Ready
**NEVER start FAH client before GPU driver is loaded**

- **Problem:** GPU driver installation requires a reboot to load
- **Impact:** FAH starts using CPUs instead of GPU, gets CPU WU
- **Solution:** Two-phase boot: install drivers → reboot → then start FAH

### Anti-Pattern 4: Running lufah Before FAH Websocket is Ready
**ALWAYS wait for FAH websocket before running lufah commands**

- **Problem:** FAH service starts but websocket (port 7396) takes additional time
- **Impact:** `lufah` commands fail silently with "Failed to connect" warnings
- **Solution:** Retry loop waiting for `lufah state` to succeed
```bash
# Wait for FAH websocket to be ready (with retries)
for i in {1..30}; do
  if lufah state >/dev/null 2>&1; then
    echo "FAH websocket ready after $i attempts"
    break
  fi
  echo "Attempt $i: FAH not ready, waiting 10s..."
  sleep 10
done
```

---

## GPU Folding Specifics

### GPU Driver Installation (Critical)
NVIDIA driver installation requires a **reboot** before the driver is usable.

**Correct sequence:**
1. Boot 1: Install NVIDIA drivers + CUDA
2. Reboot VM
3. Boot 2: Start FAH, enable GPU, configure

**Incorrect (causes CPU folding):**
1. Boot 1: Install drivers + start FAH immediately
2. FAH gets CPU WU because GPU driver not loaded yet
3. GPU WU never assigned, CPU WU takes days

### Enabling GPU in FAH v8
```bash
# Enable all detected GPUs in the resource group
lufah -a / enable-all-gpus

# Disable CPU folding (GPU-only mode)
lufah -a / config cpus 0

# Enable CUDA (usually enabled by default)
lufah -a / config cuda true

# Start folding
lufah fold
```

### Verifying GPU is Being Used
```bash
# Check FAH sees the GPU
lufah state | jq '.info.gpus'

# Check GPU is in the group config
lufah state | jq '.groups[""].config.gpus'
# Should show GPU ID, not empty {}

# Check units show GPU
lufah units
# GPUs column should show 1, not 0

# Check nvidia-smi shows utilization
nvidia-smi
# GPU-Util should be >0% when running
```

### T4 vs L4 GPUs
- **T4 (preferred):** Turing architecture, widely supported, good for FAH
- **L4:** Ada Lovelace architecture, newer, may have compatibility issues
- **Availability:** T4 often sold out; L4 has better availability

### GPU WU Completion Times
- GPU WUs typically complete in **15-60 minutes** (vs 14+ hours for CPU)
- One-shot GPU mode is practical for quick donations

### One-Shot GPU Workflow
```bash
# 1. Deploy GPU VM with proper two-phase boot
terraform apply

# 2. Wait for cloud-init phase 1 (driver install)
# 3. VM reboots automatically
# 4. Wait for cloud-init phase 2 (FAH setup)

# 5. Verify GPU is folding (not CPUs!)
ssh user@ip "lufah units"
# Should show: GPUs=1, CPUs=0

# 6. Monitor for completion marker
ssh user@ip "test -f /tmp/fah-oneshot-complete && echo DONE"

# 7. Destroy after WU completes
terraform destroy
```
