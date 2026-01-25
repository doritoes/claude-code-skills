# Monitor Workflow

Monitor Folding@Home workers, check status, and track costs.

---

## Quick Status Check

### 1. Worker Health

```bash
cd $PAI_DIR/.claude/skills/FoldingAtCloud/terraform/azure

# Get worker IPs
WORKER_IPS=$(terraform output -json worker_public_ips | jq -r '.[]')

# Check each worker
cd $PAI_DIR/.claude/skills/FoldingAtCloud/Tools
for IP in $WORKER_IPS; do
  echo "=== Worker: $IP ==="
  bun run WorkerControl.ts status $IP
  echo ""
done
```

### 2. Budget Status

```bash
cd $PAI_DIR/.claude/skills/FoldingAtCloud/Tools
bun run BudgetTracker.ts check
```

### 3. FAH Portal

Open https://v8-4.foldingathome.org/ to see:
- Active machines
- Work units in progress
- Points earned
- Estimated completion times

---

## Detailed Monitoring

### SSH to Worker

```bash
# Get SSH commands
cd $PAI_DIR/.claude/skills/FoldingAtCloud/terraform/azure
terraform output ssh_commands

# Example
ssh foldingadmin@20.120.1.100
```

### On Worker - Check FAH Status

```bash
# Service status
systemctl status fah-client

# Logs
journalctl -u fah-client -f

# lufah status
lufah units
lufah state
lufah info
```

### lufah Commands

| Command | Purpose |
|---------|---------|
| `lufah units` | Show work unit table |
| `lufah top` | Live updating status |
| `lufah state` | JSON state dump |
| `lufah info` | Host and client info |
| `lufah log` | View client logs |
| `lufah config` | View/set configuration |

---

## Monitoring Script

Create a monitoring loop:

```bash
#!/bin/bash
# monitor-folding.sh

cd $PAI_DIR/.claude/skills/FoldingAtCloud/terraform/azure
WORKER_IPS=$(terraform output -json worker_public_ips | jq -r '.[]')

while true; do
  clear
  echo "=== Folding@Cloud Monitor - $(date) ==="
  echo ""

  # Budget
  echo "--- Budget ---"
  cd $PAI_DIR/.claude/skills/FoldingAtCloud/Tools
  bun run BudgetTracker.ts check 2>/dev/null | jq -r '.daily.percent, .monthly.percent' | xargs printf "Daily: %.1f%% | Monthly: %.1f%%\n"
  echo ""

  # Workers
  echo "--- Workers ---"
  for IP in $WORKER_IPS; do
    STATUS=$(bun run WorkerControl.ts status $IP 2>/dev/null)
    HEALTHY=$(echo "$STATUS" | jq -r '.healthy')
    PAUSED=$(echo "$STATUS" | jq -r '.paused')
    UNITS=$(echo "$STATUS" | jq -r '.units')
    echo "$IP: healthy=$HEALTHY paused=$PAUSED units=$UNITS"
  done

  sleep 60
done
```

---

## Alert Conditions

| Condition | Action |
|-----------|--------|
| Worker unhealthy | SSH to investigate, check logs |
| Budget > 80% | Consider scaling down |
| Budget > 100% | Trigger graceful teardown |
| All workers paused | Check FAH portal for issues |
| No work units | Normal during WU transitions |

---

## Cost Tracking

### Estimate Current Burn Rate

```bash
cd $PAI_DIR/.claude/skills/FoldingAtCloud/terraform/azure

WORKERS=$(terraform output -raw worker_count)
VM_SIZE=$(terraform output -raw vm_size)

# Approximate hourly cost (spot pricing varies)
HOURLY_RATE=0.02  # D2s_v3 spot estimate
DAILY_COST=$(echo "$WORKERS * $HOURLY_RATE * 24" | bc)
MONTHLY_COST=$(echo "$DAILY_COST * 30" | bc)

echo "Workers: $WORKERS"
echo "Estimated daily: \$$DAILY_COST"
echo "Estimated monthly: \$$MONTHLY_COST"
```

### Azure Cost Check

```bash
# Requires Azure CLI
az consumption usage list \
  --start-date $(date -d '7 days ago' +%Y-%m-%d) \
  --end-date $(date +%Y-%m-%d) \
  --query "[?contains(instanceName, 'foldingcloud')]" \
  -o table
```

---

## Health Check Automation

Add to cron for automated monitoring:

```bash
# Every 5 minutes - check workers
*/5 * * * * $PAI_DIR/.claude/skills/FoldingAtCloud/Tools/health-check.sh

# Every hour - check budget
0 * * * * $PAI_DIR/.claude/skills/FoldingAtCloud/Tools/budget-check.sh
```
