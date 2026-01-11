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
2. Recursion limit fix for Python 3.12: `sys.setrecursionlimit(10000)`
3. Wait 3-5 minutes for full cloud-init completion
4. Check `/var/run/cloud-init-complete` for completion signal
