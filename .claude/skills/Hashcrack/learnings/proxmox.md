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

**Best Method - Port Scanning:**
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

**TOO_MANY_STORAGE_MIGRATES error:**
- XCP-ng limits concurrent disk operations
- Wait and retry `terraform apply`
- Create workers in batches of 3-4

## Resource Planning

For i7-10710U (12 cores, 32GB RAM):

| Config | Server | Workers | Total |
|--------|--------|---------|-------|
| Conservative | 2 vCPU, 4GB | 2 × 4 vCPU, 4GB | 10 vCPU, 12GB |
| Maximum | 2 vCPU, 4GB | 4 × 4 vCPU, 6GB | 18 vCPU, 28GB |

## Complete Step-by-Step

See skill.md section: **PROXMOX STEP-BY-STEP DEPLOYMENT (FOLLOW EXACTLY)**
