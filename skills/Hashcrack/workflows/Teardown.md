# Teardown Workflow

Destroy Hashcrack infrastructure in stages when the user is satisfied.

## Trigger

- "destroy workers"
- "destroy server"
- "teardown hashcrack"
- "cleanup"

## Two-Stage Teardown Process

**Stage 1: Destroy Workers** - When user is satisfied with cracking results
**Stage 2: Destroy Server** - When user is satisfied after viewing results in Hashtopolis UI

This allows the user to review results in the web UI before destroying everything.

---

## Stage 1: Destroy Worker VMs

### When to Execute
- All attack phases have completed
- User confirms they are satisfied with cracking results

### Pre-Destroy Checklist
- [ ] All tasks show 100% complete (or user is satisfied with partial results)
- [ ] User has reviewed cracked hashes count
- [ ] User has had opportunity to log into Hashtopolis UI
- [ ] User confirms: "destroy workers" or "spin down workers"

### Execution

```bash
cd ~/.claude/skills/Hashcrack/terraform

# Destroy ONLY workers using targeted destroy
terraform destroy -target=xenorchestra_vm.workers -auto-approve
```

**IMPORTANT:** Use targeted destroy, NOT `terraform apply -var="worker_count=0"`. The targeted approach is more reliable and explicit.

### Agent Cleanup (CRITICAL)

After destroying workers, **clean up stale agents** from Hashtopolis database. This is REQUIRED to allow future workers to register and function properly.

```bash
# Get server IP
SERVER_IP=$(terraform output -raw server_ip)
DB_PW=$(terraform output -raw db_password)

# Get list of agent IDs to clean up (match destroyed worker hostnames)
ssh ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p$DB_PW hashtopolis -sNe \"
SELECT agentId, agentName FROM Agent WHERE agentName LIKE 'hashcrack-worker-%';
\""

# For each agent ID that no longer has a running VM, run cleanup:
# Replace AGENT_IDS with actual IDs (e.g., "1,2,3,4")
ssh ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p$DB_PW hashtopolis -e \"
-- Delete in FK constraint order (CRITICAL - do not skip any table)
DELETE FROM Speed WHERE agentId IN (AGENT_IDS);
DELETE FROM AccessGroupAgent WHERE agentId IN (AGENT_IDS);
DELETE FROM Zap WHERE agentId IN (AGENT_IDS);
UPDATE Chunk SET agentId = NULL WHERE agentId IN (AGENT_IDS);
DELETE FROM AgentZap WHERE agentId IN (AGENT_IDS);
DELETE FROM Assignment WHERE agentId IN (AGENT_IDS);
DELETE FROM AgentStat WHERE agentId IN (AGENT_IDS);
DELETE FROM AgentError WHERE agentId IN (AGENT_IDS);
DELETE FROM HealthCheckAgent WHERE agentId IN (AGENT_IDS);
DELETE FROM Agent WHERE agentId IN (AGENT_IDS);
\""
```

### Why Agent Cleanup Matters

Without cleanup:
- Stale agents remain in database with isActive=0
- Future workers may have naming conflicts
- Task assignments may reference non-existent agents
- User sees confusing "ghost" agents in UI

With cleanup:
- Database is clean for fresh worker deployment
- Tasks remain intact, ready for new workers
- User can scale back up seamlessly

### Verify Cleanup
```bash
# Confirm no stale agents remain
ssh ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p$DB_PW hashtopolis -e \"
SELECT agentId, agentName, isActive FROM Agent;
\""
# Should show empty result or only active agents

# Confirm tasks are intact and ready
ssh ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p$DB_PW hashtopolis -e \"
SELECT taskId, taskName, priority FROM Task WHERE isArchived = 0;
\""
```

**Server remains running** - User can still access Hashtopolis UI at http://<server-ip>:8080

---

## Stage 2: Destroy Hashtopolis Server

### When to Execute
- User has logged into Hashtopolis UI
- User has viewed/exported cracked passwords
- User confirms: "destroy server" or "I'm done, destroy everything"

### Pre-Destroy Checklist
- [ ] User has accessed Hashtopolis UI
- [ ] User has viewed results in Lists → Show Cracked
- [ ] User confirms they have what they need

### Execution

```bash
cd ~/.claude/skills/Hashcrack/terraform

# Full destroy
terraform destroy -auto-approve
```

---

## Cloud Provider Credentials

**CRITICAL:** For cloud deployments (AWS, Azure, GCP), you MUST set provider credentials before running terraform destroy. Credentials are stored in `~/.claude/.env`.

### AWS
```bash
# Read credentials from .env and export for terraform
source <(grep -E '^AWS_' ~/.claude/.env | sed 's/^/export /')

# Verify credentials are set
echo "AWS_ACCESS_KEY_ID: ${AWS_ACCESS_KEY_ID:0:8}..."

# Now terraform can authenticate
cd ~/.claude/skills/Hashcrack/terraform/aws
terraform destroy -auto-approve
```

### Azure
```bash
# Azure credentials in .env (ARM_* variables)
source <(grep -E '^ARM_' ~/.claude/.env | sed 's/^/export /')

cd ~/.claude/skills/Hashcrack/terraform/azure
terraform destroy -auto-approve
```

### GCP
```bash
# GCP uses service account key file or application default credentials
# Path should be in GOOGLE_APPLICATION_CREDENTIALS in .env
source <(grep -E '^GOOGLE_|^GCP_' ~/.claude/.env | sed 's/^/export /')

cd ~/.claude/skills/Hashcrack/terraform/gcp
terraform destroy -auto-approve
```

### Common Credential Issues

| Error | Solution |
|-------|----------|
| "No valid credential sources found" (AWS) | Export AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY from .env |
| "AADSTS" errors (Azure) | Export ARM_CLIENT_ID, ARM_CLIENT_SECRET, ARM_TENANT_ID, ARM_SUBSCRIPTION_ID |
| "Could not find default credentials" (GCP) | Set GOOGLE_APPLICATION_CREDENTIALS or run `gcloud auth application-default login` |

**Remember:** Credentials in `.env` are gitignored - never commit them to version control.

### Clean Environment Variables

Remove from `.claude/.env`:
- `HASHCRACK_SERVER_URL`
- `HASHCRACK_API_KEY`
- `HASHCRACK_ADMIN_PASSWORD`
- `HASHCRACK_VOUCHER`

### Verify

```bash
terraform show
# Should show: No state
```

---

## Quick Reference

| User Says | Action |
|-----------|--------|
| "destroy workers" | Stage 1: Remove workers, keep server |
| "I'm satisfied with cracking" | Stage 1: Remove workers, keep server |
| "destroy server" | Stage 2: Remove server (full teardown) |
| "I'm done viewing results" | Stage 2: Remove server (full teardown) |
| "teardown everything" | Both stages in sequence |

---

## Recovery

If you accidentally teardown:

1. Run `hashcrack deploy` again
2. Re-submit hash jobs
3. Previous results in `.env` are preserved
