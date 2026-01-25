# Proxmox Hashcrack Deployment

## Prerequisites

- Proxmox VE with API access
- Storage configured (local-lvm recommended)
- Network bridge (vmbr0 default)

## Resource Planning (Example: i7-10710U, 32GB RAM)

| Config | Server | Workers | Total vCPU | Total RAM |
|--------|--------|---------|------------|-----------|
| Conservative | 2 vCPU, 4GB | 2 × 4 vCPU, 4GB | 10 vCPU | 12 GB |
| Moderate | 2 vCPU, 4GB | 4 × 4 vCPU, 4GB | 18 vCPU | 20 GB |
| Maximum | 2 vCPU, 4GB | 4 × 4 vCPU, 6GB | 18 vCPU | 28 GB |

## Deployment

```bash
cd terraform/proxmox
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars with your Proxmox config

terraform init
terraform plan
terraform apply
```

## terraform.tfvars Example

```hcl
proxmox_url      = "https://192.168.99.205:8006"
proxmox_user     = "root@pam"
proxmox_password = "your-password"
proxmox_insecure = true  # Allow self-signed certs (lab)

worker_count     = 2
server_cores     = 2
server_memory    = 4096
worker_cores     = 4
worker_memory    = 4096
```

## Notes

- Template auto-created with `create_template = true`
- Cloud-init configures VMs automatically
- DHCP used by default (check Proxmox GUI for IPs)

## DHCP Discovery

If using DHCP, find server IP:
```bash
for ip in $(seq 30 60); do
  curl -s --connect-timeout 1 http://192.168.99.$ip:8080/ >/dev/null && echo "Server: 192.168.99.$ip"
done
```

## Cleanup

```bash
terraform destroy
```
