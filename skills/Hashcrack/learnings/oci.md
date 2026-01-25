# OCI (Oracle Cloud) Learnings

## Benefits

- **10TB free egress** per month (vs ~$0.09/GB on AWS/GCP)
- Preemptible instances up to 50% cheaper
- Flex shapes allow custom OCPU/memory
- No minimum commitment
- **Free tier includes:** 2 AMD VMs (1 OCPU, 1GB RAM each) - always free

## Pre-Run Checklist

Before first OCI run:
1. [ ] Create OCI account at cloud.oracle.com
2. [ ] Generate API Key in Console → User Settings → API Keys
3. [ ] Download private key to `~/.oci/oci_api_key.pem`
4. [ ] Copy terraform.tfvars.example to terraform.tfvars
5. [ ] Fill in: tenancy_ocid, user_ocid, fingerprint, private_key_path
6. [ ] Update ssh_public_key with your key
7. [ ] Run `oci iam region list` to verify auth works

## Authentication Setup

1. Create API Key: OCI Console → User Settings → API Keys
2. Download private key and config
3. Set up `~/.oci/config` or use terraform.tfvars

```bash
# Install OCI CLI (optional but helpful)
bash -c "$(curl -L https://raw.githubusercontent.com/oracle/oci-cli/master/scripts/install/install.sh)"

# Verify authentication
oci iam region list
```

## Required OCIDs for terraform.tfvars

- `tenancy_ocid` - Your tenancy identifier
- `user_ocid` - Your user identifier
- `compartment_ocid` - (Optional) Compartment for resources
- `fingerprint` - API key fingerprint

## GPU Shapes

| Shape | GPU | Memory | Use Case |
|-------|-----|--------|----------|
| VM.GPU2.1 | 1x P100 | 16GB | Good for hashcracking |
| VM.GPU3.1 | 1x V100 | 16GB | Better performance |
| BM.GPU4.8 | 8x A100 | 40GB | Maximum throughput |

## CPU Shapes

| Shape | OCPUs | Memory | Notes |
|-------|-------|--------|-------|
| VM.Standard.E4.Flex | 1-64 | 1-1024GB | Custom sizing |
| VM.Standard3.Flex | 1-32 | 1-512GB | Intel Ice Lake |

## Cost Comparison

| Resource | OCI | AWS |
|----------|-----|-----|
| 4 vCPU VM | ~$0.10/hr | ~$0.17/hr |
| Egress (10TB) | $0 | ~$900 |

## Known Issues & Fixes

### Files Directory Mismatch (CRITICAL)
**Problem:** Files uploaded to `/var/www/hashtopolis/files/` but Hashtopolis looks in `/usr/local/share/hashtopolis/files/`
**Symptom:** Workers download "ERR3 - file not present" (23 byte files)
**Fix:**
```bash
# Check where Hashtopolis expects files
docker exec hashtopolis-db mysql -N -e "SELECT * FROM hashtopolis.StoredValue WHERE storedValueId='directory_files';"
# Output: directory_files	/usr/local/share/hashtopolis/files

# Copy files to correct location
docker exec hashtopolis-backend cp /var/www/hashtopolis/files/* /usr/local/share/hashtopolis/files/
```

### CrackerBinaryId Must Be Set (CRITICAL)
**Problem:** Task created with `crackerBinaryId=NULL` causes "Invalid cracker binary type id!"
**Fix:** Always set crackerBinaryId when creating tasks via DB:
```sql
-- Check available binaries
SELECT * FROM CrackerBinary;
-- Set on task
UPDATE Task SET crackerBinaryId=1 WHERE taskId=1;
```

### Agents Deactivated After Issues
**Problem:** Agents show "No task available!" despite valid task
**Cause:** isActive flag reset to 0
**Fix:**
```sql
UPDATE Agent SET isActive=1;
```

### Intermittent SSH Connectivity
**Problem:** SSH connections timeout intermittently
**Fix:** Use longer timeouts:
```bash
ssh -o ConnectTimeout=30 -o ServerAliveInterval=5 ubuntu@IP
```

### Private IP for Worker-Server Communication
Workers use VCN private IPs (10.0.1.x) to communicate with server, not public IPs.

## Performance Results (2026-01-21)

| Metric | Value |
|--------|-------|
| Workers | 4 x VM.Standard.E4.Flex (4 OCPU, 16GB) |
| Speed per Worker | ~15.5 MH/s |
| Combined Speed | ~62 MH/s |
| SHA256 Cracked | 1920/5000 (38.4%) |
| Duration | ~43 minutes |
