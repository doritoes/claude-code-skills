# GCP Deployment Workflow

Step-by-step deployment to Google Cloud Platform with GATE checkpoints.

---

## ⛔ PRE-FLIGHT (MANDATORY)

### GATE 0: Clean State Check (CRITICAL SAFETY)

**⚠️ DO NOT SKIP THIS STEP - Prevents destroying active research**

```bash
cd ~/.claude/skills/Hashcrack/terraform/gcp
source <(grep -E '^GOOGLE_|^GCP_' ~/.claude/.env | sed 's/^/export /')

# Step 1: Check state count
STATE_COUNT=$(terraform state list 2>/dev/null | wc -l)
echo "Terraform state resources: $STATE_COUNT"
```

**If STATE_COUNT = 0:** Safe to proceed with new deployment.

**If STATE_COUNT > 0:** ACTIVE DEPLOYMENT EXISTS - Check for running jobs:
```bash
SERVER_IP=$(terraform output -raw server_public_ip 2>/dev/null)
DB_PASS=$(terraform output -raw db_password 2>/dev/null)
ssh -o ConnectTimeout=10 ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -e 'SELECT COUNT(*) as cracked FROM Hash WHERE isCracked=1; SELECT taskId, taskName, ROUND(keyspaceProgress/keyspace*100,2) as pct FROM Task WHERE isArchived=0;'" 2>/dev/null
```

| Cracked Count | Tasks Running? | Decision |
|---------------|----------------|----------|
| 0 | No tasks | Safe to destroy and redeploy |
| > 0 | Yes | **STOP - Active test running. Wait or use different provider.** |
| Unknown | Can't SSH | **STOP - Investigate before destroying** |

**NEVER destroy active deployments with cracked hashes > 0 without explicit user approval.**

### GATE 1: GCP Credentials
```bash
# Export from .env
source <(grep -E '^GOOGLE_|^GCP_' ~/.claude/.env | sed 's/^/export /')

# OR use gcloud default credentials
gcloud auth application-default login

# Verify
gcloud config get-value project
gcloud auth list --filter=status:ACTIVE --format="value(account)"
```
**Expected:** Returns project ID and active account
**If fails:** Set GOOGLE_APPLICATION_CREDENTIALS or run gcloud auth

---

## DEPLOYMENT STEPS

### Step 1: Initialize Terraform

```bash
cd ~/.claude/skills/Hashcrack/terraform/gcp
terraform init
```
**GATE 2 PASS:** "Terraform has been successfully initialized"
**GATE 2 FAIL:** Check google provider configuration

### Step 2: Configure Variables

Ensure `terraform.tfvars` has:
```hcl
project          = "your-gcp-project-id"
region           = "us-central1"
zone             = "us-central1-a"
worker_count     = 2
use_preemptible  = true
ssh_public_key   = "ssh-rsa AAAA..."
```

### Step 3: Plan Deployment

```bash
terraform plan -out=tfplan
```
**GATE 3 PASS:** "Plan: X to add, 0 to change, 0 to destroy"
**GATE 3 FAIL:**
- "Quota exceeded" → Request CPUS_ALL_REGIONS increase
- "Could not find default credentials" → Run gcloud auth

### Step 4: Apply Infrastructure

```bash
terraform apply tfplan
```
**GATE 4 PASS:** "Apply complete! Resources: X added"
**GATE 4 FAIL:**
- "Quota exceeded" → Request increase in Console → IAM & Admin → Quotas
- See Error Classification in ai-discipline.md

### Step 5: Get Server IP and DB Password

```bash
SERVER_IP=$(terraform output -raw server_public_ip)
DB_PASS=$(terraform output -raw db_password)
echo "Server: $SERVER_IP"
```

### Step 6: Wait for Server SSH

```bash
# MAX 2 minutes
for i in {1..8}; do
  ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no ubuntu@$SERVER_IP "echo SSH OK" && break
  echo "Waiting for SSH... ($i/8)"
  sleep 15
done
```
**GATE 5 PASS:** "SSH OK"
**GATE 5 FAIL after 2 min:** Check firewall rules, instance state

### Step 7: Wait for Docker Containers

```bash
# MAX 5 minutes
for i in {1..10}; do
  ssh ubuntu@$SERVER_IP 'sudo docker ps | grep -q hashtopolis-backend' && echo "Docker OK" && break
  echo "Waiting for cloud-init... ($i/10)"
  sleep 30
done
```
**GATE 6 PASS:** "Docker OK"
**GATE 6 FAIL after 5 min:** Check `cloud-init status` on server

### Step 8: Verify Login Works

```bash
ssh ubuntu@$SERVER_IP 'curl -s -c /tmp/c.txt http://localhost:8080/ > /dev/null && \
  curl -s -c /tmp/c.txt -b /tmp/c.txt -L -X POST \
  -d "username=hashcrack&password=Hashcrack2025Lab&fw=" \
  http://localhost:8080/login.php | grep -qE "agents\.php" && echo "LOGIN OK" || echo "LOGIN FAILED"'
```
**GATE 7 PASS:** "LOGIN OK"
**GATE 7 FAIL:** Reset password with PHP script (see Deploy.md Step 8)

### Step 9: Verify Vouchers

```bash
WORKER_COUNT=$(grep worker_count terraform.tfvars | grep -oE '[0-9]+')
VOUCHER_COUNT=$(ssh ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -sNe 'SELECT COUNT(*) FROM RegVoucher;'")
echo "Vouchers: $VOUCHER_COUNT / Workers: $WORKER_COUNT"
```
**GATE 8 PASS:** VOUCHER_COUNT >= WORKER_COUNT
**GATE 8 FAIL:** Create vouchers:
```bash
for i in $(seq 1 $WORKER_COUNT); do
  ssh ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -e \"INSERT INTO RegVoucher (voucher, time) VALUES ('GCP_WORKER_$i', UNIX_TIMESTAMP());\""
done
```

### Step 10: Wait for Agents and Trust

```bash
# Wait MAX 3 minutes for agents
for i in {1..6}; do
  AGENT_COUNT=$(ssh ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -sNe 'SELECT COUNT(*) FROM Agent WHERE isActive=1;'")
  [ "$AGENT_COUNT" -ge "$WORKER_COUNT" ] && echo "Agents: $AGENT_COUNT" && break
  echo "Waiting for agents... ($AGENT_COUNT/$WORKER_COUNT)"
  sleep 30
done

# Trust and configure for CPU (with ignoreErrors for rule attacks)
ssh ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -e \"
UPDATE Agent SET isTrusted = 1, cpuOnly = 1, cmdPars = '--force', ignoreErrors = 1 WHERE isTrusted = 0;
\""
```
**GATE 9 PASS:** All agents registered and trusted
**GATE 9 FAIL after 3 min:** Check worker cloud-init logs

---

## ⛔ CRITICAL: GCP BENCHMARK FORMAT

**GCP with PoCL typically reports OLD benchmark format!**

After agents register, BEFORE creating any task:

```bash
# GATE T2: Check benchmark format
ssh ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -e \"
SELECT agentId, agentName,
       (SELECT benchmark FROM Assignment WHERE agentId=a.agentId LIMIT 1) as benchmark
FROM Agent a WHERE isActive=1;
\""
```

**Interpret the result:**
| Benchmark Value | Format | useNewBench Setting |
|-----------------|--------|---------------------|
| `2672:24760.24` (contains `:`) | OLD | **useNewBench=0** |
| `24760.24` (number only) | NEW | useNewBench=1 |

**GCP OBSERVED: OLD format → ALWAYS use `useNewBench=0` for GCP**

⚠️ **FAILURE MODE:** Using `useNewBench=1` with OLD format agents causes:
- Tiny chunks (6-7K instead of ~367M)
- Only 0.002% keyspace coverage
- Task appears to "finish" but most passwords never tested

---

## DEPLOYMENT COMPLETE

```
GCP Hashtopolis Ready!

URL: http://$SERVER_IP:8080
Username: hashcrack
Password: Hashcrack2025Lab

Workers: $WORKER_COUNT agents registered and trusted

⚠️ REMEMBER: Use useNewBench=0 for GCP tasks!
```

---

## GCP-SPECIFIC NOTES

| Topic | Detail |
|-------|--------|
| **worker_public_ip** | **Use `true`** - Simplest approach, workers download directly from internet |
| Cloud NAT | Alternative if private IPs required - complex, can cause download issues |
| Preemptible | 60-70% savings, max 24hr runtime |
| Quotas | CPUS_ALL_REGIONS is global limit (default 32) |
| Performance | Fastest CPU of cloud providers tested |
| Benchmark | PoCL reports OLD format → useNewBench=0 |

**RECOMMENDED terraform.tfvars settings:**
```hcl
worker_public_ip = true   # Workers can download hashcat directly
use_cloud_nat    = false  # Not needed with public IPs
```

---

## TEARDOWN

```bash
# GATE D1: Check state
cd ~/.claude/skills/Hashcrack/terraform/gcp
terraform state list | wc -l

# GATE D2: Export credentials
source <(grep -E '^GOOGLE_|^GCP_' ~/.claude/.env | sed 's/^/export /')
# OR ensure gcloud auth is active

# GATE D3: Destroy
terraform destroy -auto-approve

# GATE D4: Verify clean
terraform state list | wc -l  # Must be 0
```
