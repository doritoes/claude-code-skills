# Teardown Procedures

Safe infrastructure destruction and cleanup.

## Before Destroying Workers

1. **Check for active chunks:**
   ```sql
   SELECT agentId, state, progress FROM Chunk WHERE state = 2;
   ```

2. **Wait for chunks to complete or reset them:**
   ```sql
   UPDATE Chunk SET state = 0, agentId = NULL WHERE state = 2;
   ```

3. **Clean up agent records:**
   ```sql
   DELETE FROM Assignment WHERE agentId IN (SELECT agentId FROM Agent WHERE agentName LIKE 'hashcrack-worker%');
   UPDATE Agent SET isActive = 0 WHERE agentName LIKE 'hashcrack-worker%';
   ```

## Graceful Scale-Down

```bash
AGENT_ID=5

# 1. Stop agent from taking new work
docker exec hashtopolis-db mysql -uhashtopolis -p$DB_PASS -e "
  UPDATE Agent SET isActive = 0 WHERE agentId = $AGENT_ID;"

# 2. Wait for current work to finish
while true; do
  CHUNKS=$(docker exec hashtopolis-db mysql -uhashtopolis -p$DB_PASS -sN -e "
    SELECT COUNT(*) FROM Chunk WHERE agentId = $AGENT_ID AND state = 2;")
  [ "$CHUNKS" -eq 0 ] && break
  echo "Waiting for $CHUNKS chunks..."
  sleep 30
done

# 3. Clean up
docker exec hashtopolis-db mysql -uhashtopolis -p$DB_PASS -e "
  DELETE FROM Assignment WHERE agentId = $AGENT_ID;"

# 4. Now safe to destroy worker
```

## Chunk States Reference

| State | Meaning | Can Destroy Worker? |
|-------|---------|---------------------|
| 0 | PENDING | Yes |
| 2 | DISPATCHED | No - work in progress |
| 4 | ABORTED | Yes - already failed |
| 5 | FINISHED | Yes |
| 6 | SKIPPED | Yes |

## Terraform Destroy Patterns

**Workers only (keep server):**
```bash
terraform apply -var="worker_count=0" -auto-approve
```

**Everything:**
```bash
terraform destroy -auto-approve
```

**Specific workers (taint first):**
```bash
terraform taint 'proxmox_virtual_environment_vm.workers[1]'
terraform apply -auto-approve
```

## Post-Destruction Cleanup

After destroying workers, clean database:

```sql
-- Remove stale agents
DELETE FROM Assignment WHERE agentId IN (
  SELECT agentId FROM Agent WHERE lastTime < UNIX_TIMESTAMP() - 3600
);

-- Reset orphaned chunks
UPDATE Chunk SET state = 0, agentId = NULL WHERE state IN (2, 4);

-- Deactivate gone agents
UPDATE Agent SET isActive = 0 WHERE lastTime < UNIX_TIMESTAMP() - 3600;
```

## Cloud Provider Cleanup

**AWS:**
```bash
cd terraform/aws && terraform destroy -auto-approve
```

**Azure:**
```bash
cd terraform/azure && terraform destroy -auto-approve
# May need retry if NSG deletion fails
```

**GCP:**
```bash
cd terraform/gcp && terraform destroy -auto-approve
```

**Proxmox:**
```bash
cd terraform/proxmox && terraform destroy -auto-approve
```
