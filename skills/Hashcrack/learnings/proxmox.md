# Proxmox/XCP-ng Local Deployment

Learnings specific to local hypervisor deployments.

## Proxmox vs Cloud Differences

| Aspect | Proxmox | Cloud (AWS/Azure/GCP) |
|--------|---------|----------------------|
| IP Assignment | DHCP or static via Proxmox | Cloud VPC assigns |
| Template | Auto-created by terraform | AMI/Image |
| Networking | vmbr0 bridge | VPC/subnet |
| Cost | Hardware only | Per-hour billing |

## DHCP IP Discovery

**Problem:** Terraform outputs show configured IP, not DHCP-assigned IP.

**Best Method - Proxmox QEMU Guest Agent API:**
```bash
# Authenticate with Proxmox API
PVE_PASSWORD="proxmox123"  # From terraform.tfvars or .env
TICKET_JSON=$(curl -sk -d "username=root@pam&password=$PVE_PASSWORD" \
  https://192.168.99.205:8006/api2/json/access/ticket)
PVE_TICKET=$(echo "$TICKET_JSON" | python -c "import json,sys; print(json.load(sys.stdin)['data']['ticket'])")

# Get server IP from VM 200
SERVER_IP=$(curl -sk -b "PVEAuthCookie=$PVE_TICKET" \
  "https://192.168.99.205:8006/api2/json/nodes/proxmox-lab/qemu/200/agent/network-get-interfaces" | \
  python -c "import json,sys; d=json.load(sys.stdin); print([ip['ip-address'] for iface in d['data']['result'] for ip in iface.get('ip-addresses',[]) if ip.get('ip-address-type')=='ipv4' and not ip['ip-address'].startswith('127.')][0])")

echo "Server IP: $SERVER_IP"
```

**Alternative - Port Scanning:
```bash
# Find server (port 8080)
for ip in $(seq 30 60); do
  curl -s --connect-timeout 1 http://192.168.99.$ip:8080/ >/dev/null 2>&1 && echo "Server: 192.168.99.$ip"
done

# Find workers (SSH with hostname check)
for ip in $(seq 30 60); do
  ssh -o StrictHostKeyChecking=no -o ConnectTimeout=1 -o BatchMode=yes ubuntu@192.168.99.$ip "hostname" 2>/dev/null | grep -q worker && echo "Worker: 192.168.99.$ip"
done
```

**Alternative Methods:**
1. Proxmox GUI → VM → Summary → IP Address
2. DHCP server lease table
3. `qm guest exec <vmid> ip addr`

## Key Differences from Cloud

1. **Vouchers must be created manually** - Cloud-init doesn't auto-create
2. **Workers may connect to wrong server IP** - Fix config.json
3. **QEMU guest agent required** - For IP reporting in Proxmox
4. **Template auto-creation** - Set `create_template = true`

## DHCP Worker Config Bug (CRITICAL)

**Problem:** When using DHCP (`use_dhcp=true`), workers are configured with the **static IP** from `terraform.tfvars` (e.g., 192.168.99.220) instead of the **actual DHCP IP** (e.g., 192.168.99.67).

**Symptom:**
```
Error occurred: HTTPConnectionPool(host='192.168.99.220', port=8080):
Max retries exceeded... [Errno 113] No route to host
```

**Root Cause:** Terraform passes `server_ip` from tfvars to worker cloud-init, but server gets different IP via DHCP.

**Fix:** After getting actual server IP, update all worker configs:
```bash
ACTUAL_SERVER="192.168.99.67"  # Get from Proxmox API
for worker in 192.168.99.{68,69,70,71}; do
  ssh ubuntu@$worker "sudo sed -i 's/192.168.99.220/$ACTUAL_SERVER/g' /opt/hashtopolis-agent/config.json && \
                      sudo systemctl restart hashtopolis-agent"
done
```

**Permanent Fix Needed:** Terraform should:
1. Deploy server first
2. Query actual DHCP IP via Proxmox API
3. Pass actual IP to worker cloud-init

**Workaround:** Use static IPs is NOT recommended - risks breaking network.

## CPU Worker Requirements

**CRITICAL: Add `--force` to attackCmd for CPU workers.**

PoCL 1.8 compatibility issue causes benchmark failures without it:
```sql
VALUES ('TaskName', '#HL# rockyou.txt -r OneRule.rule --force', ...);
```

## Permission Fixes

If benchmark/cracking fails with permission errors:
```bash
docker exec -u root hashtopolis-backend chmod -R 777 /var/lib/hashcat
docker exec -u root hashtopolis-backend chmod -R 777 /usr/local/share/hashtopolis/crackers
docker exec -u root hashtopolis-backend chmod -R 777 /usr/local/share/hashtopolis/files
```

## XCP-ng Specific

### TOO_MANY_STORAGE_MIGRATES Error

**Cause:** XCP-ng has a hard limit of 3 concurrent VM storage migrations.

**Solution:**
- Cannot be changed easily (requires XCP-ng tuning)
- Run `terraform apply` multiple times if creating 4+ workers
- 4th worker will fail on first apply, succeed on second
- Expected behavior for 4-worker deployments

### Python 3.12 RecursionError (CRITICAL)

**Symptom:** Agent fails during registration with:
```
RecursionError: maximum recursion depth exceeded
File "/usr/lib/python3.12/http/cookiejar.py", line 642, in eff_request_host
```

**Cause:** Python 3.12 cookiejar bug with Hashtopolis agent during HTTP requests.

**Fix - Update systemd service:**
```bash
ssh ubuntu@WORKER_IP 'sudo bash -c "cat > /etc/systemd/system/hashtopolis-agent.service << EOF
[Unit]
Description=Hashtopolis Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/hashtopolis-agent
ExecStart=/usr/bin/python3 -c \"import sys; sys.setrecursionlimit(10000); exec(open(chr(95)+chr(95)+chr(109)+chr(97)+chr(105)+chr(110)+chr(95)+chr(95)+chr(46)+chr(112)+chr(121)).read())\"
Restart=always
RestartSec=30

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl restart hashtopolis-agent"'
```

**Note:** This fix should be included in cloud-init for all providers using Python 3.12+.

### DHCP IP Discovery on XCP-ng

**Problem:** Terraform doesn't know the DHCP-assigned IP.

**Best Method - Use XO CLI:**
```bash
# List VMs and IPs
xo-cli VM.get --server https://192.168.99.206 | grep -E "(name_label|mainIpAddress)"
```

**Alternative - Port scan:**
```bash
# Find server via port 8080
for ip in $(seq 10 50); do
  curl -s --connect-timeout 1 http://192.168.99.$ip:8080/ >/dev/null && echo "Server: 192.168.99.$ip"
done
```

### Voucher Persistence Issues

**Symptom:** Worker fails to register even with voucher created.

**Cause:**
- Terraform voucher may be deleted by Hashtopolis even with voucherDeletion=0
- Race conditions when multiple workers register simultaneously

**Solution:**
1. Create ONE VOUCHER PER WORKER before terraform apply
2. Use database INSERT with COMMIT:
```sql
INSERT INTO hashtopolis.RegVoucher (voucher, time)
VALUES ('XCP_WORKER_1', UNIX_TIMESTAMP());
INSERT INTO hashtopolis.RegVoucher (voucher, time)
VALUES ('XCP_WORKER_2', UNIX_TIMESTAMP());
COMMIT;
```
3. Verify with `SELECT voucher FROM hashtopolis.RegVoucher;`

### XCP-ng SHA256 Test Results (2026-01-12)

| Metric | Value |
|--------|-------|
| Workers | 4 × 4 vCPU = 16 vCPU |
| Runtime | 5h 58m |
| Cracked | 2161/5000 (43.2%) |
| Speed | ~40 MH/s combined |
| Rate | 6.0/min |

**Fastest CPU test** - local hypervisor with dedicated resources outperforms all cloud providers.

## Resource Planning

For i7-10710U (12 cores, 32GB RAM):

| Config | Server | Workers | Total |
|--------|--------|---------|-------|
| Conservative | 2 vCPU, 4GB | 2 × 4 vCPU, 4GB | 10 vCPU, 12GB |
| Maximum | 2 vCPU, 4GB | 4 × 4 vCPU, 6GB | 18 vCPU, 28GB |

## Complete Step-by-Step

See skill.md section: **PROXMOX STEP-BY-STEP DEPLOYMENT (FOLLOW EXACTLY)**
