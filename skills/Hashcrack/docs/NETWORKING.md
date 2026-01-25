# Cloud Networking Best Practices

## ANTI-PATTERN: Paying for NAT Gateway

Azure/GCP NAT gateways cost ~$0.045/hr + per GB data charges (~$30-40/month minimum).

## BEST PRACTICE: Server as File Proxy

Workers with private IPs should download from the server, not the internet:

1. **Server downloads files during cloud-init** (has public IP)
2. **Server runs simple HTTP server** on internal IP
3. **Workers download from server** (internal network, no NAT needed)
4. **SSH to workers via server jump host** if needed

### Implementation

```bash
# On server - start file server for hashcat binary
ssh ubuntu@SERVER_IP "sudo bash -c '
cd /var/lib/docker/volumes/hashtopolis_files/_data
curl -L -o hashcat-7.1.2.7z https://hashcat.net/files/hashcat-7.1.2.7z
nohup python3 -m http.server 8888 --bind 0.0.0.0 > /tmp/fileserver.log 2>&1 &
'"

# Update Hashtopolis to use local URL
ssh ubuntu@SERVER_IP "docker exec hashtopolis-db mysql -u hashtopolis -pPASSWORD hashtopolis -e \"
UPDATE CrackerBinary SET downloadUrl='http://INTERNAL_SERVER_IP:8888/hashcat-7.1.2.7z' WHERE crackerBinaryId=1;
\""
```

### SSH to Workers via Server Jump Host

```bash
# Azure/GCP workers have private IPs only
ssh -J ubuntu@SERVER_PUBLIC_IP ubuntu@WORKER_PRIVATE_IP
```

### Cost Comparison

| Approach | Monthly Cost | Notes |
|----------|--------------|-------|
| NAT Gateway | $30-45 | Plus per-GB charges |
| Server File Proxy | $0 | Uses existing server |
