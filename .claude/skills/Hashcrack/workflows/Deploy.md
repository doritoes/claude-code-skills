# Deploy Workflow

Deploy Hashtopolis infrastructure to XCP-ng for distributed password cracking.

## Trigger

- "deploy hashcrack"
- "spin up workers"
- "create cracking infrastructure"

## Prerequisites

1. **XenOrchestra credentials** in `.claude/.env`:
   ```bash
   XO_HOST=https://192.168.99.206
   XO_USER=admin
   XO_PASSWORD=<password>
   ```

2. **Terraform or OpenTofu** installed

3. **Ubuntu 24.04 cloud-init template** available in XCP-ng

4. **SSH public key** (optional, for direct VM access)

## Execution Steps

### Step 1: Validate Prerequisites

```bash
# Check XO credentials exist
grep -q "XO_HOST" ~/.claude/.env || echo "Missing XO_HOST"

# Check Terraform
terraform version || tofu version
```

### Step 2: Initialize Terraform

```bash
cd ~/.claude/skills/Hashcrack/terraform
terraform init
```

### Step 3: Configure Variables

Create `terraform.tfvars` with deployment settings:

```hcl
xo_url       = "https://192.168.99.206"
xo_username  = "admin"
xo_password  = "<password>"
worker_count = 3
```

### Step 4: Plan Infrastructure

```bash
terraform plan -out=tfplan
```

Review the plan:
- 1 Hashtopolis server VM
- N worker VMs
- Network and storage attachments

### Step 5: Apply Infrastructure

```bash
terraform apply tfplan
```

Wait for:
- VMs to boot
- Cloud-init to complete
- Docker containers to start

### Step 6: Retrieve Outputs

```bash
terraform output -json
```

Save to `.claude/.env`:
- `HASHCRACK_SERVER_URL`
- `HASHCRACK_ADMIN_PASSWORD`
- `HASHCRACK_VOUCHER`

### Step 6.5: Verify Vouchers Created (CRITICAL)

**One voucher per worker is REQUIRED to prevent race conditions.**

```bash
SERVER_IP=$(terraform output -raw server_ip)
DB_PASS=$(terraform output -raw db_password)
WORKER_COUNT=$(grep worker_count terraform.tfvars | grep -oE '[0-9]+')

# Verify voucher count matches worker count
VOUCHER_COUNT=$(ssh ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -sNe 'SELECT COUNT(*) FROM RegVoucher;'")
echo "Vouchers: $VOUCHER_COUNT / Workers: $WORKER_COUNT"

if [ "$VOUCHER_COUNT" -lt "$WORKER_COUNT" ]; then
  echo "ERROR: Not enough vouchers! Create more vouchers manually:"
  echo "  ssh ubuntu@$SERVER_IP \"sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -e \\\"INSERT INTO RegVoucher (voucher, time) VALUES ('$(openssl rand -hex 6)', UNIX_TIMESTAMP());\\\"\""
fi
```

### Step 7: Wait for Infrastructure Ready

Wait for cloud-init to complete on all VMs (~5-7 minutes):
```bash
# Monitor server readiness
SERVER_IP=$(terraform output -raw server_ip)
until ssh -o ConnectTimeout=5 ubuntu@$SERVER_IP 'sudo docker ps | grep -q hashtopolis-backend'; do
  echo "Waiting for Hashtopolis containers..."
  sleep 15
done
echo "Server ready!"
```

### Step 8: Verify Credentials Work (CRITICAL)

**Before providing credentials to user, VERIFY THEY WORK:**

```bash
# Test login - must see "agents.php" NOT "Wrong username/password"
ssh ubuntu@$SERVER_IP 'curl -s -c /tmp/c.txt http://localhost:8080/ > /dev/null && \
  curl -s -c /tmp/c.txt -b /tmp/c.txt -L -X POST \
  -d "username=hashcrack&password=Hashcrack2025Lab&fw=" \
  http://localhost:8080/login.php | grep -qE "agents\.php" && echo "LOGIN OK" || echo "LOGIN FAILED"'
```

**If login fails**, the password was not set correctly during cloud-init. Reset it:
```bash
# See LEARNINGS.md for full password reset procedure using PHP
ssh ubuntu@$SERVER_IP 'cat > /tmp/set_password.php << '\''EOF'\''
<?php
$config = json_decode(file_get_contents("/usr/local/share/hashtopolis/config/config.json"), true);
$PEPPER = $config["PEPPER"];
$pdo = new PDO("mysql:host=hashtopolis-db;dbname=hashtopolis", "hashtopolis", "DB_PASSWORD");
$stmt = $pdo->query("SELECT passwordSalt FROM User WHERE userId = 1");
$salt = $stmt->fetch()["passwordSalt"];
$hash = password_hash($PEPPER[1] . "Hashcrack2025Lab" . $salt, PASSWORD_BCRYPT, ["cost" => 12]);
$pdo->prepare("UPDATE User SET passwordHash = ? WHERE userId = 1")->execute([$hash]);
echo "Password reset!\n";
EOF
sudo docker cp /tmp/set_password.php hashtopolis-backend:/tmp/set_password.php
sudo docker exec hashtopolis-backend php /tmp/set_password.php'
```

### Step 9: Trust Agents

Wait for agents to register, then trust them:
```bash
# Wait for agents to appear
until ssh ubuntu@$SERVER_IP 'sudo docker exec hashtopolis-db mysql -u hashtopolis -p<db_pw> hashtopolis -sNe "SELECT COUNT(*) FROM Agent;" | grep -v "^0$"'; do
  echo "Waiting for agents to register..."
  sleep 15
done

# Trust all agents
ssh ubuntu@$SERVER_IP 'sudo docker exec hashtopolis-db mysql -u hashtopolis -p<db_pw> hashtopolis -e "UPDATE Agent SET isTrusted = 1 WHERE isTrusted = 0;"'
```

### Step 10: Verify Deployment

```bash
# Check server UI is accessible
curl -sk http://$SERVER_IP:8080 | grep -q "Hashtopolis" && echo "UI accessible"

# Check worker count
ssh ubuntu@$SERVER_IP 'sudo docker exec hashtopolis-db mysql -u hashtopolis -p<db_pw> hashtopolis -sNe "SELECT COUNT(*) FROM Agent WHERE isActive = 1;"'
```

## CLI Usage

```bash
# Deploy with default settings (2 workers)
hashcrack deploy

# Deploy with specific worker count
hashcrack deploy --workers 5

# Deploy with custom resources
hashcrack deploy --workers 3 --server-memory 8 --worker-cpus 8
```

## Output

On success:
- Server URL saved to env
- Admin credentials saved to env
- Worker voucher saved to env

## Credential Delivery to User

When deployment is complete and verified, provide credentials to user:

```
Hashtopolis is ready!

URL: http://<SERVER_IP>:8080
Username: hashcrack
Password: Hashcrack2025Lab

Workers: X/X agents registered and trusted
```

**IMPORTANT:** Always use the credentials from `terraform.tfvars`, NOT randomly generated passwords. Random passwords with special characters often fail due to cloud-init YAML/shell escaping issues.

## Troubleshooting

| Issue | Solution |
|-------|----------|
| VM creation fails | Check XO template exists |
| Workers don't connect | Wait 2-3 min for cloud-init |
| API key missing | Generate in Hashtopolis UI |

## Rollback

If deployment fails:

```bash
terraform destroy -auto-approve
```
