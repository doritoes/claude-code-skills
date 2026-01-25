# Graceful Shutdown - Standard Operating Procedure

This document defines the graceful shutdown procedure for Folding@Cloud workers.

---

## Core Principle

**Never terminate a worker mid-work-unit.**

Reasons:
1. Wasted compute (partial WU results are discarded)
2. Bad F@H citizenship (incomplete WUs hurt project)
3. Lost points (no credit for partial work)

---

## The Finish Command

FAH v8 provides a `finish` command that:
1. Completes the current work unit
2. Uploads results to F@H servers
3. Transitions to paused state
4. Does NOT request new work

---

## Control Methods

### Method 1: lufah via SSH (Recommended)

```bash
# Send finish command
ssh foldingadmin@$WORKER_IP "lufah finish"

# Check state
ssh foldingadmin@$WORKER_IP "lufah state"
```

### Method 2: WebSocket API (Advanced)

Connect to `ws://$WORKER_IP:7396/api/websocket` and send:
```json
{"cmd": "state", "state": "finish"}
```

### Method 3: On-Worker Script

The cloud-init installs `/usr/local/bin/fah-graceful-stop`:
```bash
ssh foldingadmin@$WORKER_IP "/usr/local/bin/fah-graceful-stop"
```

---

## State Transition

```
FOLDING -> [finish command] -> FINISHING -> [WU complete] -> PAUSED
```

Check with:
```bash
lufah state | jq '.paused'
# true = safe to terminate
# false = still working
```

---

## Timeout Handling

Work units have variable completion times:
- CPU WUs: Usually 10-30 minutes
- Long WUs: Occasionally 1-2 hours

Default timeout: 30 minutes (`FOLDING_GRACEFUL_TIMEOUT=1800`)

If timeout reached:
1. Log warning
2. Proceed with termination
3. Lost WU is acceptable trade-off vs. indefinite waiting

---

## Parallel Graceful Shutdown

For multiple workers, run finish commands in parallel:

```bash
# Send finish to all (parallel)
for IP in $WORKER_IPS; do
  ssh foldingadmin@$IP "lufah finish" &
done
wait

# Wait for all to pause (parallel)
for IP in $WORKER_IPS; do
  (
    TIMEOUT=1800
    ELAPSED=0
    while [ $ELAPSED -lt $TIMEOUT ]; do
      PAUSED=$(ssh foldingadmin@$IP "lufah state 2>/dev/null | jq -r '.paused'" || echo "false")
      if [ "$PAUSED" = "true" ]; then
        echo "$IP: paused"
        exit 0
      fi
      sleep 30
      ELAPSED=$((ELAPSED + 30))
    done
    echo "$IP: timeout"
  ) &
done
wait
```

---

## Integration with Terraform

Before `terraform destroy` or `terraform apply -var="worker_count=N"` (where N < current):

1. Identify workers to remove
2. Send finish commands
3. Wait for paused state
4. Then run terraform

---

## Emergency Override

If graceful shutdown is impossible (e.g., runaway costs, security incident):

```bash
# Force destroy - accepts WU loss
terraform destroy -auto-approve
```

Document the reason for emergency override.

---

## Verification Checklist

Before terminating any worker:

- [ ] Finish command sent
- [ ] State shows `paused: true` OR timeout reached
- [ ] Worker IP logged for audit trail

---

## Monitoring During Shutdown

Watch the shutdown progress:

```bash
# Terminal 1: Monitor state
watch -n 10 'ssh foldingadmin@$IP "lufah state | jq .paused"'

# Terminal 2: Watch logs
ssh foldingadmin@$IP "journalctl -u fah-client -f"
```
