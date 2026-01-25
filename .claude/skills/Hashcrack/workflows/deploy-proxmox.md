# Proxmox Deployment Workflow

Step-by-step deployment to Proxmox VE with GATE checkpoints.

---

## ⛔ PRE-FLIGHT (MANDATORY)

### GATE 0: Clean State Check
```bash
cd ~/.claude/skills/Hashcrack/terraform/proxmox
terraform state list | wc -l
```
**Expected:** `0`
**If not 0:** Run `terraform destroy -auto-approve` first

### GATE 1: Proxmox Credentials
Ensure `terraform.tfvars` has:
```hcl
proxmox_host     = "192.168.99.205"
proxmox_user     = "root@pam"
proxmox_password = "your-password"
proxmox_node     = "proxmox-lab"
```

Verify API access:
```bash
PVE_HOST="192.168.99.205"
PVE_PASSWORD="your-password"
TICKET_JSON=$(curl -sk -d "username=root@pam&password=$PVE_PASSWORD" https://$PVE_HOST:8006/api2/json/access/ticket)
echo "$TICKET_JSON" | grep -q "ticket" && echo "Proxmox API OK" || echo "Proxmox API FAILED"
```
**Expected:** "Proxmox API OK"

---

## DEPLOYMENT STEPS

### Step 1: Initialize Terraform

```bash
cd ~/.claude/skills/Hashcrack/terraform/proxmox
terraform init
```
**GATE 2 PASS:** "Terraform has been successfully initialized"
**GATE 2 FAIL:** Check bpg/proxmox provider configuration

### Step 2: Configure Variables

Ensure `terraform.tfvars` has:
```hcl
proxmox_host     = "192.168.99.205"
proxmox_user     = "root@pam"
proxmox_password = "your-password"
proxmox_node     = "proxmox-lab"
worker_count     = 2
use_dhcp         = true  # Recommended
ssh_public_key   = "ssh-rsa AAAA..."
```

### Step 3: Plan Deployment

```bash
terraform plan -out=tfplan
```
**GATE 3 PASS:** "Plan: X to add, 0 to change, 0 to destroy"
**GATE 3 FAIL:**
- "500 internal server error" → Check Proxmox template exists
- "permission denied" → Check user permissions

### Step 4: Apply Infrastructure (DHCP - TWO-STAGE DEPLOY)

⚠️ **Proxmox with use_dhcp=true - workers need server IP BEFORE boot!**

**Stage 1: Deploy server only**
```bash
terraform apply -target=proxmox_virtual_environment_vm.server -target=random_password.db_password -target=random_string.voucher
# Wait for server to get DHCP IP via guest agent
sleep 60
```

**Stage 2: Get actual server IP from Proxmox API**
```bash
PVE_HOST="192.168.99.205"
PVE_PASSWORD="your-password"
TICKET_JSON=$(curl -sk -d "username=root@pam&password=$PVE_PASSWORD" https://$PVE_HOST:8006/api2/json/access/ticket)
PVE_TICKET=$(echo "$TICKET_JSON" | python -c "import json,sys; print(json.load(sys.stdin)['data']['ticket'])")
SERVER_IP=$(curl -sk -b "PVEAuthCookie=$PVE_TICKET" \
  "https://$PVE_HOST:8006/api2/json/nodes/proxmox-lab/qemu/200/agent/network-get-interfaces" | \
  python -c "import json,sys; d=json.load(sys.stdin); print([ip['ip-address'] for iface in d['data']['result'] for ip in iface.get('ip-addresses',[]) if ip.get('ip-address-type')=='ipv4' and not ip['ip-address'].startswith('127.')][0])")
echo "Server IP: $SERVER_IP"
```

**Stage 3: Deploy workers (now have correct server IP)**
```bash
terraform apply tfplan
```

**GATE 4 PASS:** "Apply complete! Resources: X added"
**GATE 4 FAIL:** See Error Classification in ai-discipline.md

### Step 5: Get Server IP via Proxmox API (CRITICAL)

⚠️ **Terraform outputs show CONFIGURED IP, not DHCP-assigned IP!**

```bash
# Get API ticket
PVE_HOST="192.168.99.205"
PVE_PASSWORD="your-password"
TICKET_JSON=$(curl -sk -d "username=root@pam&password=$PVE_PASSWORD" https://$PVE_HOST:8006/api2/json/access/ticket)
PVE_TICKET=$(echo "$TICKET_JSON" | python -c "import json,sys; print(json.load(sys.stdin)['data']['ticket'])")

# Get server VM ID (usually 200)
SERVER_VMID=200

# Wait for QEMU guest agent (MAX 90 seconds)
for i in {1..6}; do
  SERVER_IP=$(curl -sk -b "PVEAuthCookie=$PVE_TICKET" \
    "https://$PVE_HOST:8006/api2/json/nodes/proxmox-lab/qemu/$SERVER_VMID/agent/network-get-interfaces" 2>/dev/null | \
    python -c "import json,sys; d=json.load(sys.stdin); print([ip['ip-address'] for iface in d['data']['result'] for ip in iface.get('ip-addresses',[]) if ip.get('ip-address-type')=='ipv4' and not ip['ip-address'].startswith('127.')][0])" 2>/dev/null) && break
  echo "Waiting for guest agent... ($i/6)"
  sleep 15
done
echo "Server IP: $SERVER_IP"
```

Get DB password:
```bash
DB_PASS=$(terraform output -raw db_password)
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
**GATE 5 FAIL after 2 min:** Verify correct IP from Proxmox API

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

### Step 9: Verify Vouchers (1 per worker)

```bash
WORKER_COUNT=$(grep worker_count terraform.tfvars | grep -oE '[0-9]+')
VOUCHER_COUNT=$(ssh ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -sNe 'SELECT COUNT(*) FROM RegVoucher;'")
echo "Vouchers: $VOUCHER_COUNT / Workers: $WORKER_COUNT"
```
**GATE 8 PASS:** VOUCHER_COUNT >= WORKER_COUNT
**GATE 8 FAIL:** Create vouchers:
```bash
for i in $(seq 1 $WORKER_COUNT); do
  ssh ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -e \"INSERT INTO RegVoucher (voucher, time) VALUES ('PROXMOX_WORKER_$i', UNIX_TIMESTAMP());\""
done
```

### Step 10: Fix Worker Config (DHCP IP Mismatch)

⚠️ **Workers may be configured with WRONG server IP!**

Get worker IPs from Proxmox API:
```bash
for VMID in 201 202 203 204; do
  WORKER_IP=$(curl -sk -b "PVEAuthCookie=$PVE_TICKET" \
    "https://$PVE_HOST:8006/api2/json/nodes/proxmox-lab/qemu/$VMID/agent/network-get-interfaces" 2>/dev/null | \
    python -c "import json,sys; d=json.load(sys.stdin); print([ip['ip-address'] for iface in d['data']['result'] for ip in iface.get('ip-addresses',[]) if ip.get('ip-address-type')=='ipv4' and not ip['ip-address'].startswith('127.')][0])" 2>/dev/null)
  [ -n "$WORKER_IP" ] && echo "Worker $VMID: $WORKER_IP"
done
```

Fix worker configs:
```bash
for WORKER_IP in <worker_ips>; do
  ssh ubuntu@$WORKER_IP "sudo sed -i 's|http://[0-9.]*:8080|http://$SERVER_IP:8080|g' /opt/hashtopolis-agent/config.json && sudo systemctl restart hashtopolis-agent"
done
```

### Step 11: Wait for Agents and Trust

```bash
# Wait MAX 3 minutes for agents
for i in {1..6}; do
  AGENT_COUNT=$(ssh ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -sNe 'SELECT COUNT(*) FROM Agent WHERE isActive=1;'")
  [ "$AGENT_COUNT" -ge "$WORKER_COUNT" ] && echo "Agents: $AGENT_COUNT" && break
  echo "Waiting for agents... ($AGENT_COUNT/$WORKER_COUNT)"
  sleep 30
done

# Trust and configure for CPU (with --force for PoCL, ignoreErrors for rule attacks)
ssh ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -e \"
UPDATE Agent SET isTrusted = 1, cpuOnly = 1, cmdPars = '--force', ignoreErrors = 1 WHERE isTrusted = 0;
\""
```
**GATE 9 PASS:** All agents registered and trusted
**GATE 9 FAIL after 3 min:** Check worker configs point to correct server IP

### Step 12: Detect Benchmark Format (CRITICAL for Tasks)

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

---

## DEPLOYMENT COMPLETE

```
Proxmox Hashtopolis Ready!

URL: http://$SERVER_IP:8080
Username: hashcrack
Password: Hashcrack2025Lab

Workers: $WORKER_COUNT agents registered and trusted
```

---

## PROXMOX-SPECIFIC NOTES

| Topic | Detail |
|-------|--------|
| **DHCP Discovery** | Use Proxmox API, NOT terraform output |
| **Worker IP Mismatch** | Workers may have wrong server IP in config |
| **QEMU Guest Agent** | Required for IP discovery via API |
| **--force flag** | Required for PoCL workers |
| **Python recursion** | May need `sys.setrecursionlimit(50000)` |

---

## TEARDOWN

```bash
# GATE D1: Check state
cd ~/.claude/skills/Hashcrack/terraform/proxmox
terraform state list | wc -l

# GATE D2: Destroy
terraform destroy -auto-approve

# GATE D3: Verify clean
terraform state list | wc -l  # Must be 0
```
