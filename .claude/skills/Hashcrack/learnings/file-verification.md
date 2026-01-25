# File Verification Learning

## Problem Discovered (2026-01-24)

CPU wordlist test failed with error: `ERR3 - file not present`

**Root Cause:** Wordlist file (rockyou.txt) showed 23 bytes on worker instead of 139MB. The file download from Hashtopolis server failed silently - HTTP 200 returned with error message in body.

## Critical Learning

**NEVER skip file download verification before starting tasks.**

The file may:
1. Exist in the database with correct metadata
2. Exist on disk in the container with correct size
3. Still fail to download to agents (wrong path, permissions, API issues)

## Mandatory Verification Gate (ALL PROVIDERS)

After staging files, execute this verification **before** creating any tasks:

```bash
# 1. Get an agent token
TOKEN=$(ssh ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -sNe 'SELECT token FROM Agent LIMIT 1;'")

# 2. Test file download through the API
EXPECTED_SIZE=$(ssh ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -sNe 'SELECT size FROM File WHERE fileId=1;'")

ACTUAL_SIZE=$(ssh ubuntu@$SERVER_IP "curl -s -o /tmp/test_dl.bin 'http://localhost:8080/getFile.php?file=1&token=$TOKEN' && stat -c%s /tmp/test_dl.bin 2>/dev/null || wc -c < /tmp/test_dl.bin")

# 3. Compare sizes
if [ "$ACTUAL_SIZE" -lt 1000 ]; then
  echo "GATE FAIL: Downloaded file is $ACTUAL_SIZE bytes (expected $EXPECTED_SIZE)"
  echo "Check file path configuration in Hashtopolis"
  exit 1
elif [ "$ACTUAL_SIZE" -ne "$EXPECTED_SIZE" ]; then
  echo "GATE WARN: Size mismatch - got $ACTUAL_SIZE, expected $EXPECTED_SIZE"
  echo "File may be truncated or corrupted"
else
  echo "GATE PASS: File download verified ($ACTUAL_SIZE bytes)"
fi
```

## Common Failure Causes

| Symptom | Cause | Fix |
|---------|-------|-----|
| `ERR3 - file not present` | Wrong directory path | Copy to `/usr/local/share/hashtopolis/files/` |
| `file size mismatch` | Partial upload or wrong file | Re-upload, verify with `md5sum` |
| HTTP 200 but <1KB response | API error in body | Check Hashtopolis logs |
| 403 Forbidden | Permission issue | `chown www-data:www-data` on files |

## Correct File Path (Docker Hashtopolis v2)

```
/usr/local/share/hashtopolis/files/     <- CORRECT (from StoredValue.directory_files)
/var/www/hashtopolis/files/             <- WRONG (volume mount, not used by API)
/var/www/html/files/                    <- WRONG
```

## Workflow Integration

This gate should be executed:
- **When:** After Step E (Stage Files) in Crack.md workflow
- **Blocking:** Do NOT proceed to create hashlists/tasks if gate fails
- **Provider:** All providers (AWS, Azure, GCP, OCI, Proxmox, XCP-ng)

## Test That Failed

```
AWS CPU wordlist-only test (6 workers)
- Server: <server-ip>:8080
- Files staged to /var/www/hashtopolis/files/ (WRONG PATH)
- API returned "ERR3 - file not present"
- All 6 agents failed with "Restore value is greater than keyspace"
- Root cause: Hashtopolis couldn't serve the file to agents
```

## Prevention

1. Always execute the file download gate
2. Never assume "file exists on server = file downloadable"
3. Test download from agent perspective (using agent token)
4. Include this in smoke tests
