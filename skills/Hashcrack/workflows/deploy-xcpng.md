# XCP-ng Deployment Workflow

Step-by-step deployment to XCP-ng via Xen Orchestra with GATE checkpoints.

---

## ⛔ PRE-FLIGHT (MANDATORY)

### GATE 0: Clean State Check
```bash
cd ~/.claude/skills/Hashcrack/terraform
terraform state list | wc -l
```
**Expected:** `0`
**If not 0:** Run `terraform destroy -auto-approve` first

### GATE 1: XenOrchestra Credentials
Ensure `terraform.tfvars` has:
```hcl
xo_url       = "wss://192.168.99.200"
xo_username  = "admin@admin.net"
xo_password  = "your-password"
worker_count = 4
```

Verify in `.claude/.env`:
```bash
grep -E '^XO_' ~/.claude/.env
```
**Expected:** XO_URL, XO_USER, XO_PASSWORD defined

---

## DEPLOYMENT STEPS

### Step 1: Initialize Terraform

```bash
cd ~/.claude/skills/Hashcrack/terraform
terraform init
```
**GATE 2 PASS:** "Terraform has been successfully initialized"
**GATE 2 FAIL:** Check xenorchestra provider configuration

### Step 2: Configure Variables

Ensure `terraform.tfvars` has:
```hcl
xo_url           = "wss://192.168.99.200"
xo_username      = "admin@admin.net"
xo_password      = "your-password"
worker_count     = 4
template_name    = "Ubuntu 24.04 Cloud-Init"
sr_name          = "Local storage"
network_name     = "Pool-wide network"
ssh_public_key   = "ssh-rsa AAAA..."
```

### Step 3: Plan Deployment

```bash
terraform plan -out=tfplan
```
**GATE 3 PASS:** "Plan: X to add, 0 to change, 0 to destroy"
**GATE 3 FAIL:**
- "template not found" → Check template_name matches XO
- "TOO_MANY_STORAGE_MIGRATES" → XCP-ng limit, see below

### Step 4: Apply Infrastructure (DHCP - TWO-STAGE DEPLOY)

⚠️ **XCP-ng uses DHCP - workers need server IP BEFORE boot!**

**Stage 1: Deploy server only**
```bash
terraform apply -target=xenorchestra_vm.hashtopolis_server -target=random_password.db_password -target=random_string.voucher
# Wait for server to get DHCP IP
sleep 30
SERVER_IP=$(terraform output -raw server_ip)
echo "Server IP: $SERVER_IP"
```

**Stage 2: Deploy workers (now have correct server IP)**
```bash
terraform apply tfplan
```

⚠️ **XCP-ng also has 3-concurrent-storage-migrate limit!**

**If "TOO_MANY_STORAGE_MIGRATES" error with 4+ workers:**
```bash
# This is EXPECTED - just re-run
terraform apply -auto-approve  # 4th worker creates on retry
```

**GATE 4 PASS:** "Apply complete! Resources: X added"

### Step 5: Get Server IP

```bash
# XO terraform provider returns DHCP IP directly
SERVER_IP=$(terraform output -raw server_ip)
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
**GATE 5 FAIL after 2 min:** Check VM status in XO

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

### Step 9: Verify Vouchers (1 PER WORKER - CRITICAL)

⚠️ **XCP-ng workers race for vouchers - MUST have 1 per worker!**

```bash
WORKER_COUNT=$(grep worker_count terraform.tfvars | grep -oE '[0-9]+')
VOUCHER_COUNT=$(ssh ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -sNe 'SELECT COUNT(*) FROM RegVoucher;'")
echo "Vouchers: $VOUCHER_COUNT / Workers: $WORKER_COUNT"
```
**GATE 8 PASS:** VOUCHER_COUNT >= WORKER_COUNT
**GATE 8 FAIL:** Create vouchers:
```bash
for i in $(seq 1 $WORKER_COUNT); do
  ssh ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -e \"INSERT INTO RegVoucher (voucher, time) VALUES ('XCPNG_WORKER_$i', UNIX_TIMESTAMP());\""
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

### Step 11: Detect Benchmark Format (CRITICAL for Tasks)

**Wait 2-3 minutes after trust, then check:**

```bash
ssh ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -e \"
SELECT agentId, benchmark FROM Assignment LIMIT 1;
\""
```

**Interpret the result:**
| Benchmark Value | Format | useNewBench Setting |
|-----------------|--------|---------------------|
| `2672:24760.24` (contains `:`) | OLD | `useNewBench=0` |
| `24760.24` (number only) | NEW | `useNewBench=1` |

**GATE 10 PASS:** Benchmark format identified, save for task creation
**GATE 10 FAIL:** Wait longer for benchmark, or check agent is running task

### Step 12: Fix Python Recursion (if needed)

**Check for RecursionError in agent logs:**
```bash
for WORKER_IP in $(terraform output -json worker_ips | jq -r '.[]'); do
  ssh ubuntu@$WORKER_IP 'journalctl -u hashtopolis-agent --no-pager | tail -5' 2>/dev/null | grep -q "RecursionError" && echo "RecursionError on $WORKER_IP"
done
```

**If RecursionError, increase limit:**
```bash
ssh ubuntu@$WORKER_IP 'sudo sed -i "s/10000/50000/" /etc/systemd/system/hashtopolis-agent.service && sudo systemctl daemon-reload && sudo systemctl restart hashtopolis-agent'
```

---

## DEPLOYMENT COMPLETE

```
XCP-ng Hashtopolis Ready!

URL: http://$SERVER_IP:8080
Username: hashcrack
Password: Hashcrack2025Lab

Workers: $WORKER_COUNT agents registered and trusted

FASTEST LOCAL OPTION - dedicated resources, no cloud latency!
```

---

## XCP-NG-SPECIFIC NOTES

| Topic | Detail |
|-------|--------|
| **Storage migrate limit** | Max 3 concurrent - 4th worker needs re-apply |
| **Voucher races** | MUST create 1 voucher per worker before boot |
| **Python 3.12 recursion** | May need 50000 limit (not 10000) |
| **Performance** | Fastest CPU option - local hypervisor |
| **IP Discovery** | terraform output works (XO provider) |

---

## TEARDOWN

```bash
# GATE D1: Check state
cd ~/.claude/skills/Hashcrack/terraform
terraform state list | wc -l

# GATE D2: Destroy
terraform destroy -auto-approve

# GATE D3: Verify clean
terraform state list | wc -l  # Must be 0
```
