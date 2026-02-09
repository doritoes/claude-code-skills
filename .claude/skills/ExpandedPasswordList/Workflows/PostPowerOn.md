# Post-Power-On Workflow

## Purpose
Restore full cluster functionality after AWS GPU VMs are powered on.

## Quick Start (Recommended)

```bash
cd .claude/skills/ExpandedPasswordList

# Step 1: Run WarmStart (DO NOT power on workers yet!)
# WarmStart checks DB health — if bloated, it will BLOCK and tell you to clean up
bun Tools/WarmStart.ts

# Step 2: If WarmStart says "DATABASE CLEANUP REQUIRED":
bun Tools/PasswordExporter.ts export      # Export cracked passwords
bun Tools/HashlistArchiver.ts             # Archive old hashlists, reclaim DB space
bun Tools/WarmStart.ts                    # Re-run to confirm DB is clean

# Step 3: NOW power on GPU workers (not before DB is clean!)

# Step 4: Verify pipeline health
bun Tools/PipelineMonitor.ts --quick
```

**CRITICAL: Do NOT power on GPU workers before WarmStart passes DB health check.**
Workers at $0.526/hr each = $4.21/hr for 8 workers. If getHashlist.php hangs because
the Hash table is bloated, all workers sit idle burning money.

The WarmStart tool handles (8 steps):
1. Refreshing terraform state with new public IPs
2. Updating `.claude/.env` with the new server URL
3. Validating SSH connectivity to the server
4. Checking Docker containers are running
5. **Checking database health** (Hash table bloat → getHashlist timeout)
6. Copying attack files to expected locations
7. Worker health reference
8. Verifying agents are online

## Manual Workflow (If WarmStart Fails)

### Prerequisites
- Hashtopolis server is running (not powered off)
- GPU VMs have been powered on via AWS console/CLI
- SSH access to workers from local machine

### Step 1: Get Current Worker IPs (IPs change on power cycle)
```bash
cd .claude/skills/Hashcrack/terraform/aws
terraform apply -refresh-only -auto-approve
terraform output gpu_worker_ips
terraform output server_ip
```
Save these IPs - you'll need them for SSH.

### Step 2: Update .claude/.env
Edit `.claude/.env` and update:
```
HASHCRACK_SERVER_URL=http://<NEW_SERVER_IP>:8080
```

### Step 3: Check Agent Status in Hashtopolis
```bash
cd .claude/skills/ExpandedPasswordList
bun run Tools/AgentManager.ts --status
```
**Expected:** All agents show "idle" or "healthy"
**Problem indicators:** "stale" (>120s) or "critical" (>300s)

### Step 4: For Each Problem Agent

#### 4a. SSH to the worker
```bash
ssh ubuntu@WORKER_IP
```

#### 4b. Check agent service status
```bash
sudo systemctl status hashtopolis-agent
```

#### 4c. Common Issues and Fixes

**Issue: "There is already a hashtopolis agent running" (stale lock.pid)**
```bash
cd /opt/hashtopolis-agent
sudo rm -f lock.pid
sudo systemctl restart hashtopolis-agent
```

**Issue: Agent can't connect to server (wrong server IP)**
```bash
cat /opt/hashtopolis-agent/config.json
# If URL is wrong, update it:
sudo sed -i 's/OLD_IP/NEW_IP/g' /opt/hashtopolis-agent/config.json
sudo systemctl restart hashtopolis-agent
```

**Issue: Service not running at all**
```bash
sudo systemctl start hashtopolis-agent
sudo systemctl enable hashtopolis-agent
```

#### 4d. Verify agent is working
```bash
sudo journalctl -u hashtopolis-agent -n 10 --no-pager
```
**Expected:** "Login successful!" and "No task available!" or "Got task"

### Step 5: Verify All Agents Online
```bash
bun run Tools/AgentManager.ts --status
```
**Expected:** All 8 agents showing "idle" with lastTime < 30s

### Step 6: Run Pre-Flight Checks
```bash
ssh ubuntu@SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'DB_PASSWORD' hashtopolis -sNe \"
SELECT 'Agent Trust:', SUM(isTrusted) FROM Agent WHERE isActive=1;
SELECT 'Agent IgnoreErrors:', SUM(ignoreErrors) FROM Agent WHERE isActive=1;
SELECT 'Files Secret:', SUM(isSecret) FROM File WHERE fileId IN (1,3);
SELECT 'Orphaned Chunks:', COUNT(*) FROM Chunk WHERE state=2;
\""
```
**Expected:**
- Agent Trust: 8
- Agent IgnoreErrors: 8
- Files Secret: 2
- Orphaned Chunks: 0

### Step 7: Ready for Work
If submitting new batches:
```bash
bun run Tools/CrackSubmitter.ts --batch N --workers 8
```

## Troubleshooting

### WarmStart shows "instance may be stopped"
1. Check AWS console - ensure instances are in "running" state
2. Wait 2-3 minutes after power-on for public IPs to be assigned
3. Run `aws ec2 describe-instances --query 'Reservations[*].Instances[*].[InstanceId,State.Name,PublicIpAddress]'`

### Agent shows critical but VM is running
1. SSH to worker and check service logs
2. Most common: stale lock.pid - remove and restart

### Multiple agents down
1. Check if server is reachable from workers: `curl -s http://SERVER_IP:8080`
2. Check if server IP changed (agents use private IP 10.0.1.x by default)
3. Update config.json on each worker if needed

### Agent keeps crashing
1. Check recursion limit: service should use `sys.setrecursionlimit(10000)`
2. Check disk space: `df -h`
3. Check memory: `free -h`

## DO NOT
- Restart agents that are working (idle is fine, not a problem)
- Restart ALL agents when only one is down
- Manipulate the database directly
- Skip checking service logs before taking action
