# Deployment Learnings

Issues and solutions for deploying Hashtopolis infrastructure.

## Password Hashing

**Format:** `bcrypt($PEPPER[1] + password + salt)`
- PEPPER: Server secret in `/var/www/html/src/inc/config.json`
- salt: Per-user from `User.passwordSalt`
- Cannot set via plain SQL - must use bcrypt with PEPPER

**Best Practice:** Set via environment variable:
```yaml
HASHTOPOLIS_ADMIN_USER: hashcrack
HASHTOPOLIS_ADMIN_PASSWORD: <secure-password>
```

**CRITICAL:** Avoid special characters (`!@#$%^&*`) in cloud-init passwords.

**Default Credentials:** `hashcrack` / `Hashcrack2025Lab`

## Voucher Management

**Problem:** Vouchers not created, agents can't register.

**Solution:** Create ONE VOUCHER PER WORKER before boot:
```sql
INSERT INTO RegVoucher (voucher, time) VALUES ('WORKER_1', UNIX_TIMESTAMP());
INSERT INTO RegVoucher (voucher, time) VALUES ('WORKER_2', UNIX_TIMESTAMP());
```

**Why per worker?** Race conditions cause registration failures even with deletion disabled.

**Disable voucher deletion:**
```sql
UPDATE Config SET value='0' WHERE item='voucherDeletion';
```

## API Key Creation

**Problem:** Keys with `startValid=0, endValid=0` are expired.

**Solution:**
```sql
INSERT INTO ApiKey (startValid, endValid, accessKey, accessCount, userId, apiGroupId)
VALUES (1, 2000000000, 'PAI_API_KEY', 0, 1, 1);
```

## Agent Trust

**Problem:** Agents register but aren't trusted.

**Solution:**
```sql
UPDATE Agent SET isTrusted=1 WHERE isTrusted=0;
```

## SSH Host Keys

**Problem:** Key changes when VMs recreated at same IPs.

**Solution:**
```bash
ssh-keygen -R 192.168.99.X
```

## File Placement

**CRITICAL:** Files must be in `/usr/local/share/hashtopolis/files/` FLAT (not subdirectories).

**With correct ownership:**
```bash
cat /tmp/rockyou.txt | docker exec -i -u root hashtopolis-backend bash -c "cat > /usr/local/share/hashtopolis/files/rockyou.txt && chown www-data:www-data /usr/local/share/hashtopolis/files/rockyou.txt"
```

## Database Credentials

**Get auto-generated password:**
```bash
docker exec hashtopolis-db env | grep MYSQL_PASSWORD
```

**User is `hashtopolis` (not `hashuser`).**

## Cloud-Init Tips

1. Use `package_upgrade: false` for faster boot (add later if needed)
2. Recursion limit fix for Python 3.12: `sys.setrecursionlimit(10000)` - some workers may need `50000`
3. Wait 3-5 minutes for full cloud-init completion
4. Check `/var/run/cloud-init-complete` for completion signal

## XCP-ng Specific (2026-01-15 Test)

### DHCP Timing Issue
**Problem:** Terraform creates server VM, but DHCP IP not available in time for worker cloud-init.

**Symptom:** `ipv4_addresses is empty list` error during terraform apply.

**Solution:** Terraform has `time_sleep` resource to wait 90s, but may need to re-run apply:
```bash
terraform apply  # Creates server, may fail on workers
terraform apply  # Re-run picks up server IP, creates workers
```

### Voucher Mismatch
**Problem:** Terraform generates voucher (e.g., `e6yY7IGFMhyd`) in `random_string.voucher`, but database doesn't have it.

**Symptom:** Agents fail with "Provided voucher does not exist."

**Solution:** Add terraform voucher to database after server starts:
```sql
INSERT INTO RegVoucher (voucher, time) VALUES ('e6yY7IGFMhyd', UNIX_TIMESTAMP());
```

**Best Practice:** Check `terraform.tfvars` or `terraform output voucher_code` for the actual voucher value.

### Python Recursion Errors (Workers 3 & 4)
**Problem:** Some workers hit `RecursionError: maximum recursion depth exceeded` even with 10000 limit.

**Solution:** Increase to 50000 and restart agent:
```bash
ssh ubuntu@WORKER_IP 'sudo sed -i "s/10000/50000/" /etc/systemd/system/hashtopolis-agent.service && sudo systemctl daemon-reload && sudo systemctl restart hashtopolis-agent'
```

### SSH Host Key Cleanup
**Problem:** Recreated VMs at same IPs cause host key verification failures.

**Solution:** Clear keys before connecting:
```bash
for ip in 35 37 38 39 41; do ssh-keygen -R 192.168.99.$ip 2>/dev/null; done
```

### XCP-ng Performance Baseline (2026-01-15)
| Metric | Value |
|--------|-------|
| Setup time (test start → task created) | 25 min 48 sec |
| Time to first hash | 2 min 5 sec |
| Total cracking time | 6 hr 5 min |
| Efficiency | 93.4% cracking / 6.6% setup |
