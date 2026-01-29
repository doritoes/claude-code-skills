# Status Workflow

Quick status overview of Folding@Cloud deployment.

---

## One-Line Status

```bash
cd $PAI_DIR/.claude/skills/FoldingAtCloud/terraform/azure

echo "Workers: $(terraform output -raw worker_count 2>/dev/null || echo 0)"
echo "IPs: $(terraform output -json worker_public_ips 2>/dev/null | jq -r '. | join(", ")' || echo 'none')"
```

---

## Full Status Report

```bash
cd $PAI_DIR/.claude/skills/FoldingAtCloud

echo "========================================"
echo "  Folding@Cloud Status Report"
echo "  $(date)"
echo "========================================"
echo ""

# Infrastructure
echo "--- Infrastructure ---"
cd terraform/azure
if terraform state list 2>/dev/null | grep -q .; then
  echo "Status: DEPLOYED"
  echo "Workers: $(terraform output -raw worker_count)"
  echo "VM Size: $(terraform output -raw vm_size)"
  echo "Spot: $(terraform output -raw spot_enabled)"
  echo "Region: $(terraform output -raw resource_group_name | cut -d- -f2)"
else
  echo "Status: NOT DEPLOYED"
fi
echo ""

# Budget
echo "--- Budget ---"
cd ../../Tools
BUDGET=$(bun run BudgetTracker.ts check 2>/dev/null)
if [ -n "$BUDGET" ]; then
  DAILY_PCT=$(echo "$BUDGET" | jq -r '.daily.percent')
  MONTHLY_PCT=$(echo "$BUDGET" | jq -r '.monthly.percent')
  DAILY_LEFT=$(echo "$BUDGET" | jq -r '.daily.remaining')
  MONTHLY_LEFT=$(echo "$BUDGET" | jq -r '.monthly.remaining')
  echo "Daily:   ${DAILY_PCT}% used (\$${DAILY_LEFT} remaining)"
  echo "Monthly: ${MONTHLY_PCT}% used (\$${MONTHLY_LEFT} remaining)"
else
  echo "No budget data"
fi
echo ""

# Worker Status
echo "--- Workers ---"
cd ../terraform/azure
WORKER_IPS=$(terraform output -json worker_public_ips 2>/dev/null | jq -r '.[]')
if [ -n "$WORKER_IPS" ]; then
  cd ../../Tools
  for IP in $WORKER_IPS; do
    STATUS=$(bun run WorkerControl.ts status $IP 2>/dev/null)
    HEALTHY=$(echo "$STATUS" | jq -r '.healthy // "unknown"')
    PAUSED=$(echo "$STATUS" | jq -r '.paused // "unknown"')
    echo "$IP: healthy=$HEALTHY paused=$PAUSED"
  done
else
  echo "No workers deployed"
fi
echo ""

# FAH Portal
echo "--- FAH Portal ---"
echo "URL: https://v8-4.foldingathome.org/"
echo "User: ${FAH_USERNAME:-SethNY}"
echo "Team: ${FAH_TEAM_ID:-245143}"
echo ""

echo "========================================"
```

---

## JSON Status (for automation)

```bash
cd $PAI_DIR/.claude/skills/FoldingAtCloud

# Generate JSON status
cat << EOF
{
  "timestamp": "$(date -Iseconds)",
  "deployed": $(cd terraform/azure && terraform state list 2>/dev/null | grep -q . && echo true || echo false),
  "workers": $(cd terraform/azure && terraform output -raw worker_count 2>/dev/null || echo 0),
  "worker_ips": $(cd terraform/azure && terraform output -json worker_public_ips 2>/dev/null || echo '[]'),
  "budget": $(cd Tools && bun run BudgetTracker.ts check 2>/dev/null || echo '{}'),
  "fah_portal": "https://v8-4.foldingathome.org/"
}
EOF
```

---

## Quick Links

| Resource | URL |
|----------|-----|
| FAH Portal | https://v8-4.foldingathome.org/ |
| Team Stats | https://stats.foldingathome.org/team/245143 |
| User Stats | https://stats.foldingathome.org/donor/SethNY |
| Azure Portal | https://portal.azure.com/ |

---

## Status Indicators

| Symbol | Meaning |
|--------|---------|
| `healthy=true` | FAH client running |
| `healthy=false` | FAH client not responding |
| `paused=true` | Finished WU, not folding |
| `paused=false` | Actively folding |
