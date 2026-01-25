# OCI (Oracle Cloud) Deployment Workflow

Step-by-step deployment to Oracle Cloud Infrastructure with GATE checkpoints.

---

## ⛔ PRE-FLIGHT (MANDATORY)

### GATE 0: Clean State Check
```bash
cd ~/.claude/skills/Hashcrack/terraform/oci
terraform state list | wc -l
```
**Expected:** `0`
**If not 0:** Run `terraform destroy -auto-approve` first

### GATE 1: OCI Credentials
```bash
# Verify OCI CLI is configured
oci iam region list --query "data[0].name" --raw-output
```
**Expected:** Returns a region name (e.g., "us-ashburn-1")
**If fails:** Configure OCI CLI:
```bash
# Install OCI CLI if not present
bash -c "$(curl -L https://raw.githubusercontent.com/oracle/oci-cli/master/scripts/install/install.sh)"

# Configure (~/.oci/config)
oci setup config
```

Required in `terraform.tfvars`:
- `tenancy_ocid`
- `user_ocid`
- `fingerprint`
- `private_key_path` (path to API key)

---

## DEPLOYMENT STEPS

### Step 1: Initialize Terraform

```bash
cd ~/.claude/skills/Hashcrack/terraform/oci
terraform init
```
**GATE 2 PASS:** "Terraform has been successfully initialized"
**GATE 2 FAIL:** Check oci provider configuration

### Step 2: Configure Variables

Ensure `terraform.tfvars` has:
```hcl
tenancy_ocid     = "ocid1.tenancy.oc1..aaaa..."
user_ocid        = "ocid1.user.oc1..aaaa..."
fingerprint      = "aa:bb:cc:..."
private_key_path = "~/.oci/oci_api_key.pem"
region           = "us-ashburn-1"
worker_count     = 2
ssh_public_key   = "ssh-rsa AAAA..."
```

### Step 3: Plan Deployment

```bash
terraform plan -out=tfplan
```
**GATE 3 PASS:** "Plan: X to add, 0 to change, 0 to destroy"
**GATE 3 FAIL:**
- "401 NotAuthenticated" → Check OCIDs and fingerprint
- "404 NotFound" → Check compartment_ocid

### Step 4: Apply Infrastructure

```bash
terraform apply tfplan
```
**GATE 4 PASS:** "Apply complete! Resources: X added"
**GATE 4 FAIL:** See Error Classification in ai-discipline.md

### Step 5: Get Server IP and DB Password

```bash
SERVER_IP=$(terraform output -raw server_public_ip)
DB_PASS=$(terraform output -raw db_password)
echo "Server: $SERVER_IP"
```

### Step 6: Wait for Server SSH

```bash
# MAX 2 minutes (OCI can have SSH timeouts)
for i in {1..8}; do
  ssh -o ConnectTimeout=30 -o ServerAliveInterval=5 -o StrictHostKeyChecking=no ubuntu@$SERVER_IP "echo SSH OK" && break
  echo "Waiting for SSH... ($i/8)"
  sleep 15
done
```
**GATE 5 PASS:** "SSH OK"
**GATE 5 FAIL after 2 min:** Check security list, instance state

### Step 7: Wait for Docker Containers

```bash
# MAX 5 minutes
for i in {1..10}; do
  ssh -o ConnectTimeout=30 ubuntu@$SERVER_IP 'sudo docker ps | grep -q hashtopolis-backend' && echo "Docker OK" && break
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
  ssh ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -e \"INSERT INTO RegVoucher (voucher, time) VALUES ('OCI_WORKER_$i', UNIX_TIMESTAMP());\""
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

---

## ⛔ CRITICAL: OCI FILE LOCATION

**Files MUST be in `/usr/local/share/hashtopolis/files/` (not `/var/www/hashtopolis/files/`)**

Verify correct location:
```bash
ssh ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -sNe \"SELECT value FROM StoredValue WHERE storedValueId='directory_files';\""
```
**Expected:** `/usr/local/share/hashtopolis/files`

If files uploaded to wrong location, copy them:
```bash
ssh ubuntu@$SERVER_IP "sudo docker exec hashtopolis-backend cp /var/www/hashtopolis/files/* /usr/local/share/hashtopolis/files/"
```

---

## DEPLOYMENT COMPLETE

```
OCI Hashtopolis Ready!

URL: http://$SERVER_IP:8080
Username: hashcrack
Password: Hashcrack2025Lab

Workers: $WORKER_COUNT agents registered and trusted

BENEFIT: 10TB free egress per month!
```

---

## OCI-SPECIFIC NOTES

| Topic | Detail |
|-------|--------|
| **Free egress** | 10TB/month (vs $0.09/GB on AWS/GCP) |
| Flex shapes | Custom OCPU/memory sizing |
| SSH timeouts | Use longer timeouts: `-o ConnectTimeout=30` |
| Files location | `/usr/local/share/hashtopolis/files/` (NOT `/var/www/...`) |
| Private IPs | Workers use VCN private IPs (10.0.1.x) |

---

## TEARDOWN

```bash
# GATE D1: Check state
cd ~/.claude/skills/Hashcrack/terraform/oci
terraform state list | wc -l

# GATE D2: Verify OCI auth
oci iam region list --query "data[0].name" --raw-output

# GATE D3: Destroy
terraform destroy -auto-approve

# GATE D4: Verify clean
terraform state list | wc -l  # Must be 0
```
