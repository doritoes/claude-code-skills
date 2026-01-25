# Provider Selection Strategy Guide

**Purpose:** Help Claude Code and users select the optimal cloud provider based on requirements, budget, and hash type.

---

## ⛔ QUICK DECISION MATRIX

| Scenario | Best Provider | Why |
|----------|--------------|-----|
| Quick test (<100 hashes) | XCP-ng/Proxmox | Free, instant |
| Budget-sensitive production | OCI | Free tier, 10TB egress |
| Standard production | AWS | Reliable spot, fast deploy |
| GPU required | AWS/GCP | Best GPU spot availability |
| Large scale (50+ workers) | AWS | Best scalability |
| Long-running (days) | On-premises | No hourly costs |

---

## Provider Comparison

### AWS

| Aspect | Rating | Details |
|--------|--------|---------|
| **Spot Availability** | ★★★★☆ | Generally good, varies by region |
| **Deploy Speed** | ★★★★★ | ~3 min to running |
| **GPU Options** | ★★★★★ | g4dn (T4), g5 (A10), p4d (A100) |
| **Cost (spot CPU)** | ★★★☆☆ | ~$0.08/hr per c5.xlarge |
| **Cost (spot GPU)** | ★★★☆☆ | ~$0.25/hr per g4dn.xlarge |
| **Free Tier** | ★★☆☆☆ | 750hr t2.micro (not useful for cracking) |
| **Egress Costs** | ★★☆☆☆ | $0.09/GB after 100GB |

**Best for:** Standard production workloads, GPU-intensive jobs, scalability

**Regions with good spot capacity:**
- us-west-2 (Oregon) - Recommended
- us-east-2 (Ohio)
- eu-west-1 (Ireland)

**Avoid:** us-east-1 (Virginia) - often capacity constrained

### Azure

| Aspect | Rating | Details |
|--------|--------|---------|
| **Spot Availability** | ★★★☆☆ | Variable, often constrained |
| **Deploy Speed** | ★★★☆☆ | ~5 min to running |
| **GPU Options** | ★★★★☆ | NC series (T4, A100) |
| **Cost (spot CPU)** | ★★★☆☆ | ~$0.08/hr per D4s_v3 |
| **Cost (spot GPU)** | ★★☆☆☆ | ~$0.30/hr per NC4as_T4 |
| **Free Tier** | ★★★☆☆ | $200 credit for 30 days |
| **Egress Costs** | ★★☆☆☆ | $0.087/GB after 100GB |

**Best for:** Organizations already on Azure, leveraging credits

**Caveats:**
- NSG cleanup can be slow (NetworkSecurityGroupOldReferences error)
- Requires `az login` (browser auth), not env vars
- Use specific SSH key: `~/.ssh/azure_hashcrack`

### GCP

| Aspect | Rating | Details |
|--------|--------|---------|
| **Spot Availability** | ★★★★☆ | Good preemptible availability |
| **Deploy Speed** | ★★★★☆ | ~4 min to running |
| **GPU Options** | ★★★★★ | T4, L4, A100, H100 |
| **Cost (preemptible CPU)** | ★★★★★ | ~$0.04/hr per n2-standard-4 |
| **Cost (preemptible GPU)** | ★★★☆☆ | ~$0.25/hr per T4 |
| **Free Tier** | ★★★☆☆ | $300 credit for 90 days |
| **Egress Costs** | ★★☆☆☆ | $0.12/GB (premium) |

**Best for:** Cost-optimized CPU workloads, GPU variety

**Caveats:**
- Benchmark format is OLD (useNewBench=0) with PoCL
- Image name requires `-amd64` suffix: `ubuntu-os-cloud/ubuntu-2404-lts-amd64`
- Cloud NAT not recommended (use server as file proxy)

### OCI (Oracle Cloud)

| Aspect | Rating | Details |
|--------|--------|---------|
| **Spot Availability** | ★★★☆☆ | Limited preemptible |
| **Deploy Speed** | ★★★☆☆ | ~5 min to running |
| **GPU Options** | ★★★☆☆ | A10 (limited) |
| **Cost (CPU)** | ★★★★★ | Free tier: 2 VMs |
| **Cost (GPU)** | ★★★★☆ | ~$0.40/hr per A10 |
| **Free Tier** | ★★★★★ | Always Free: 2 VMs, 200GB block |
| **Egress Costs** | ★★★★★ | **10TB free/month** |

**Best for:** Budget-conscious, long-running jobs, large file transfers

**Caveats:**
- Free tier VMs are ARM (A1.Flex) - limited hashcat compatibility
- x86 VMs require paid account
- Region availability varies

### XCP-ng (Local)

| Aspect | Rating | Details |
|--------|--------|---------|
| **Availability** | ★★★★★ | Always available |
| **Deploy Speed** | ★★★★☆ | ~3 min to running |
| **GPU Options** | ★☆☆☆☆ | Passthrough only (complex) |
| **Cost** | ★★★★★ | Free (existing hardware) |
| **Egress Costs** | ★★★★★ | N/A |

**Best for:** Development, testing, learning, offline use

**Caveats:**
- DHCP-assigned IPs require discovery via hypervisor API
- Performance depends on hardware
- No remote access without VPN

### Proxmox (Local)

| Aspect | Rating | Details |
|--------|--------|---------|
| **Availability** | ★★★★★ | Always available |
| **Deploy Speed** | ★★★★☆ | ~3 min to running |
| **GPU Options** | ★★★☆☆ | PCIe passthrough supported |
| **Cost** | ★★★★★ | Free (existing hardware) |
| **Egress Costs** | ★★★★★ | N/A |

**Best for:** Home lab, development, GPU passthrough

**Caveats:**
- Uses DHCP - must query API for IP after boot
- QEMU guest agent required for IP discovery

---

## Scenario-Based Recommendations

### Quick Test (Minutes)

**Goal:** Validate a small hash set quickly

| Factor | Recommendation |
|--------|----------------|
| Provider | XCP-ng/Proxmox (if available) or AWS |
| Workers | 2 CPU |
| Instance | c5.large (AWS) or existing VM |
| Time | <10 minutes |
| Cost | $0-0.05 |

### Standard Engagement (Hours)

**Goal:** Crack 1-10K hashes efficiently

| Factor | Recommendation |
|--------|----------------|
| Provider | AWS (us-west-2) |
| Workers | 4 CPU |
| Instance | c5.xlarge (spot) |
| Time | 1-4 hours |
| Cost | $0.50-2.00 |

### Large Scale (Day)

**Goal:** Crack 10K+ hashes or use heavy rules

| Factor | Recommendation |
|--------|----------------|
| Provider | AWS or GCP |
| Workers | 8-20 CPU |
| Instance | c5.xlarge or n2-standard-4 (spot) |
| Time | 4-24 hours |
| Cost | $5-20 |

### Slow Hashes (bcrypt/sha512crypt)

**Goal:** Crack slow hashes efficiently

| Factor | Recommendation |
|--------|----------------|
| Provider | AWS (g4dn) or GCP (T4) |
| Workers | 2-4 GPU |
| Instance | g4dn.xlarge (spot) |
| Time | Varies by hash count |
| Cost | ~$0.50/hr |

### Budget Constrained

**Goal:** Minimize cost while cracking

| Factor | Recommendation |
|--------|----------------|
| Provider | OCI (free tier) or local |
| Workers | 1-2 CPU |
| Instance | Always Free A1.Flex or local VM |
| Time | Longer runtime acceptable |
| Cost | $0 |

### Long-Running (Days/Weeks)

**Goal:** Exhaustive attack over extended time

| Factor | Recommendation |
|--------|----------------|
| Provider | Local (XCP-ng/Proxmox) |
| Workers | As many as hardware allows |
| Instance | Dedicated VMs |
| Time | Days to weeks |
| Cost | Electricity only |

---

## Provider Selection Decision Tree

```
START: Need to crack hashes
       |
       +-- Have local hypervisor available?
       |   |
       |   +-- YES: Quick test or long-running?
       |   |   |
       |   |   +-- Quick test: Use local
       |   |   +-- Long-running: Use local
       |   |   +-- Need GPU: Use cloud
       |   |
       |   +-- NO: Continue to cloud selection
       |
       +-- Budget constraint?
       |   |
       |   +-- YES: OCI Free Tier (if x86 available)
       |   +-- NO: Continue to workload type
       |
       +-- Need GPU?
       |   |
       |   +-- YES: AWS (g4dn) or GCP (T4)
       |   +-- NO: Continue to scale
       |
       +-- Scale requirement?
           |
           +-- <10 workers: GCP (cheapest spot)
           +-- 10-50 workers: AWS (best spot)
           +-- >50 workers: AWS (only option)
```

---

## Multi-Provider Strategy

### Parallel Testing (80% AWS / 20% Other)

When validating across providers:

1. **Primary (AWS):** Run main workload
2. **Secondary (GCP/Azure):** Validate benchmark format, provider-specific issues
3. **Local:** Development and pre-validation

### Sequential Testing

1. Start on local for initial validation
2. Scale to cloud when local proves insufficient
3. Return results to local storage

---

## Cost Optimization Tips

### 1. Use Spot/Preemptible Instances

- AWS spot: 60-90% savings
- GCP preemptible: 60-80% savings
- Azure spot: 60-90% savings

### 2. Right-Size Instances

- Don't over-provision memory (hashcat is CPU/GPU-bound)
- c5.large sufficient for light testing
- GPU only for slow hashes

### 3. Destroy When Done

```bash
# ALWAYS destroy after completion
terraform destroy -auto-approve

# Verify clean state
terraform state list | wc -l  # Must be 0
```

### 4. Use Free Tiers

- OCI: 2 VMs, 200GB storage, 10TB egress FREE
- AWS: 750hr t2.micro (limited use)
- GCP/Azure: Credit-based (time-limited)

---

## Provider-Specific Notes

### AWS

**Credential Setup:**
```bash
export AWS_ACCESS_KEY_ID="..."
export AWS_SECRET_ACCESS_KEY="..."
# Or use .env file
```

**Terraform Outputs:**
```bash
SERVER_IP=$(terraform output -raw server_public_ip)
DB_PASS=$(terraform output -raw db_password)
```

### Azure

**Credential Setup:**
```bash
az login  # Browser-based auth
# NOT ARM_* environment variables
```

**SSH Key:**
```bash
ssh -i ~/.ssh/azure_hashcrack ubuntu@$SERVER_IP
```

### GCP

**Credential Setup:**
```bash
gcloud auth application-default login
export GOOGLE_APPLICATION_CREDENTIALS="..."
```

**Image Name (CRITICAL):**
```hcl
source_image = "ubuntu-os-cloud/ubuntu-2404-lts-amd64"
# NOT "ubuntu-2404-lts" (missing -amd64)
```

**Benchmark Format:**
- PoCL reports OLD format (time:speed)
- Set `useNewBench=0` for GCP tasks

### OCI

**Credential Setup:**
```bash
# OCI CLI config at ~/.oci/config
# Or environment variables:
export TF_VAR_tenancy_ocid="..."
export TF_VAR_user_ocid="..."
export TF_VAR_fingerprint="..."
export TF_VAR_private_key_path="..."
export TF_VAR_region="..."
```

**Free Tier Limitations:**
- ARM-based A1.Flex (may need x86 for hashcat)
- Limited to specific regions

---

## Summary

| Provider | Best Use Case | Avoid When |
|----------|--------------|------------|
| AWS | Standard production, GPU, scale | Budget-constrained |
| Azure | Azure-native orgs | Complex setups, spot unreliable |
| GCP | Cost-optimized CPU | Need latest features |
| OCI | Free tier, egress-heavy | Need GPU, ARM incompatible |
| XCP-ng | Development, long-running | Need GPU, remote access |
| Proxmox | Home lab, GPU passthrough | Large scale |
