---
name: Hashcrack
description: Highly scalable distributed password hash cracking using Hashtopolis. USE WHEN user wants to crack password hashes OR user has hash dumps to process OR user needs distributed cracking OR user mentions hashtopolis. Deploys infrastructure to XCP-ng, manages workers dynamically, monitors progress, stores results securely in .env.
---

# Hashcrack Skill

Distributed password hash cracking using Hashtopolis as the orchestration layer. The core value is **scalability** - distribute work across many workers, from a handful of local VMs to hundreds of cloud instances.

## Quick Reference for Other Claude Instances

When executing this skill, follow these critical procedures:

### Before Providing Credentials to User
1. **Always verify login works** before giving credentials (see User Verification Workflow)
2. **Use known credentials** from `terraform.tfvars` (NOT random passwords)
3. Default: `hashcrack` / `Hashcrack2025Lab`

### When Destroying Workers
1. **Clean up agents** from Hashtopolis database (see Teardown.md)
2. **Use precise WHERE clauses** with specific agent IDs
3. **Never use shotgun DELETE** statements without WHERE

### When User Wants to Scale Down
1. **Wait for chunks to complete** before destroying workers
2. **Clean up agent records** after VM destruction
3. **Keep tasks intact** for potential scale-back-up

### Key Files
- `terraform.tfvars` - Credentials and worker count
- `LEARNINGS.md` - Accumulated operational knowledge
- `workflows/` - Step-by-step procedures for each operation

### Common Pitfalls
| Pitfall | Solution |
|---------|----------|
| Password doesn't work | Cloud-init escaping - use known password without special chars |
| Agents not trusted | Run `UPDATE Agent SET isTrusted = 1` after registration |
| Tasks not dispatching | Check priority > 0, agents trusted, files accessible |
| Stale agents after teardown | Clean up FK tables in correct order |
| yescrypt hashes | Not supported by hashcat - use John the Ripper |
| **Voucher consumed** | Create ONE VOUCHER PER WORKER before boot (race conditions cause failures even with deletion disabled) |
| **API hashlist creation fails** | ALWAYS create hashlist via database - API is unreliable |
| **Manual task assignment** | ANTI-PATTERN - use API createTask instead of DB insert |
| **CPU task not dispatching** | Set agents to `cpuOnly=1` if using CPU workers with `isCpuTask=1` tasks |
| **Files not downloading** | Files must be in `/usr/local/share/hashtopolis/files/` FLAT (not in subdirectories) |
| **Agent recursion error** | If agent hits recursion error during registration, kill and restart: `sudo pkill -9 -f "__main__.py"; sudo rm -f /opt/hashtopolis-agent/lock.pid; cd /opt/hashtopolis-agent && sudo nohup python3 __main__.py &` |
| **Workers can't download hashcat** | Use server as file proxy - don't pay for NAT Gateway (see Networking Best Practices) |
| **PoCL/hashcat benchmark fails** | Cloud CPU workers need `--force` flag in attackCmd (PoCL 1.8 compatibility issue) |
| **keyspace=1 (task exhausts immediately)** | Files on worker corrupted - delete `/opt/hashtopolis-agent/files/*`, reset task keyspace=0 |
| **"No task available!" after benchmark** | Check agent isActive=1, task priority>0, TaskWrapper priority>0 |
| **Deleting tasks breaks things** | ANTI-PATTERN - archive tasks instead: `UPDATE Task SET isArchived=1, priority=0` |
| **Files show "ERR3 - file not present"** | Copy files to `/usr/local/share/hashtopolis/files/` with www-data ownership (see Step 6) |
| **Proxmox DHCP: Workers connect to wrong server** | Terraform output shows configured IP, not DHCP-assigned IP. Scan for actual server IP: `for ip in $(seq 30 60); do curl -s --connect-timeout 1 http://192.168.99.$ip:8080/ >/dev/null && echo "Server: 192.168.99.$ip"; done` |

### Cloud Networking Best Practices

**ANTI-PATTERN: Paying for NAT Gateway**
Azure/GCP NAT gateways cost ~$0.045/hr + per GB data charges (~$30-40/month minimum).

**BEST PRACTICE: Server as File Proxy**
Workers with private IPs should download from the server, not the internet:

1. **Server downloads files during cloud-init** (has public IP)
2. **Server runs simple HTTP server** on internal IP
3. **Workers download from server** (internal network, no NAT needed)
4. **SSH to workers via server jump host** if needed

**Implementation:**
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

**SSH to workers via server jump host:**
```bash
# Azure/GCP workers have private IPs only
ssh -J ubuntu@SERVER_PUBLIC_IP ubuntu@WORKER_PRIVATE_IP
```

**Cost savings:**
| Approach | Monthly Cost | Notes |
|----------|--------------|-------|
| NAT Gateway | $30-45 | Plus per-GB charges |
| Server File Proxy | $0 | Uses existing server |

### Prerequisites - Cloud Provider CLIs

**IMPORTANT: Install the CLI for your target cloud provider before deploying.**

#### AWS CLI
```powershell
# Windows (PowerShell as Admin)
msiexec.exe /i https://awscli.amazonaws.com/AWSCLIV2.msi /quiet

# Or via winget
winget install Amazon.AWSCLI

# Configure
aws configure
# Enter: Access Key ID, Secret Access Key, Region (us-east-1), Output format (json)

# Verify
aws sts get-caller-identity
```

#### Azure CLI
```powershell
# Windows (PowerShell as Admin)
winget install Microsoft.AzureCLI

# Or download MSI from: https://aka.ms/installazurecliwindows

# Login
az login

# Set subscription (if multiple)
az account set --subscription "Your Subscription Name"

# Verify
az account show
```

#### GCP CLI (gcloud)
```powershell
# Windows - Download installer from:
# https://cloud.google.com/sdk/docs/install

# Or via PowerShell
(New-Object Net.WebClient).DownloadFile("https://dl.google.com/dl/cloudsdk/channels/rapid/GoogleCloudSDKInstaller.exe", "$env:TEMP\GoogleCloudSDKInstaller.exe")
& "$env:TEMP\GoogleCloudSDKInstaller.exe"

# Initialize and login
gcloud init
gcloud auth application-default login

# Enable Compute API
gcloud services enable compute.googleapis.com

# Verify
gcloud compute regions list
```

#### OCI CLI (Oracle Cloud)
```powershell
# Windows (PowerShell as Admin)
Set-ExecutionPolicy RemoteSigned -Scope CurrentUser
Invoke-WebRequest https://raw.githubusercontent.com/oracle/oci-cli/master/scripts/install/install.ps1 -OutFile install.ps1
./install.ps1 -AcceptAllDefaults

# Restart terminal, then configure
oci setup config
# Enter: User OCID, Tenancy OCID, Region, generate new API key

# Upload public key to OCI Console → User Settings → API Keys

# Verify
oci iam region list --output table
```

#### Terraform (Required for all providers)
```powershell
# Windows (winget)
winget install Hashicorp.Terraform

# Or download from: https://www.terraform.io/downloads

# Verify
terraform version
```

### STEP-BY-STEP DEPLOYMENT PROCESS (FOLLOW EXACTLY)

**STEP 1: Deploy Infrastructure**
```bash
cd terraform/aws  # or gcp, azure
terraform init
terraform apply -auto-approve
```

**STEP 2: Wait for Server (3 minutes)**
```bash
sleep 180
curl -s http://SERVER_IP:8080/ | head -5  # Should show Hashtopolis HTML
```

**STEP 3: Configure Server (IMMEDIATELY after server is up)**

**CRITICAL: Create ONE VOUCHER PER WORKER before they boot. Even with deletion disabled, race conditions can cause registration failures.**

```bash
# For N workers, create N vouchers (replace WORKER_COUNT with actual number)
WORKER_COUNT=4
ssh ubuntu@SERVER_IP "DB_PASS=\$(sudo docker exec hashtopolis-db env | grep MYSQL_PASSWORD | cut -d= -f2) && sudo docker exec hashtopolis-db mysql -u hashtopolis -p\"\$DB_PASS\" -e \"
-- CRITICAL: Disable voucher deletion FIRST
UPDATE hashtopolis.Config SET value='0' WHERE item='voucherDeletion';

-- Create individual vouchers for each worker (one per worker to avoid race conditions)
INSERT INTO hashtopolis.RegVoucher (voucher, time) VALUES ('WORKER_VOUCHER_1', UNIX_TIMESTAMP());
INSERT INTO hashtopolis.RegVoucher (voucher, time) VALUES ('WORKER_VOUCHER_2', UNIX_TIMESTAMP());
INSERT INTO hashtopolis.RegVoucher (voucher, time) VALUES ('WORKER_VOUCHER_3', UNIX_TIMESTAMP());
INSERT INTO hashtopolis.RegVoucher (voucher, time) VALUES ('WORKER_VOUCHER_4', UNIX_TIMESTAMP());
-- Add more vouchers if deploying more workers

-- Create API key
INSERT IGNORE INTO hashtopolis.ApiKey (startValid, endValid, accessKey, accessCount, userId, apiGroupId)
VALUES (0, 9999999999, 'PAI_API_KEY', 0, 1, 1);

-- Verify
SELECT COUNT(*) as voucher_count FROM hashtopolis.RegVoucher;
\""
```

**Why multiple vouchers?** Even with `voucherDeletion=0`, race conditions during simultaneous agent registration can cause failures. Creating N vouchers for N workers ensures each agent can register successfully.

**STEP 4: Wait for Agents to Register (2-3 minutes)**
```bash
ssh ubuntu@SERVER_IP 'DB_PASS=$(sudo docker exec hashtopolis-db env | grep MYSQL_PASSWORD | cut -d= -f2) && sudo docker exec hashtopolis-db mysql -u hashtopolis -p"$DB_PASS" -e "SELECT agentId, agentName, isActive FROM hashtopolis.Agent;"'
# Wait until all workers appear
```

**STEP 5: Trust Agents and Configure CPU/GPU Mode**
```bash
# Trust all agents
ssh ubuntu@SERVER_IP 'DB_PASS=$(sudo docker exec hashtopolis-db env | grep MYSQL_PASSWORD | cut -d= -f2) && sudo docker exec hashtopolis-db mysql -u hashtopolis -p"$DB_PASS" -e "UPDATE hashtopolis.Agent SET isTrusted = 1;"'

# CRITICAL FOR CPU WORKERS: Set cpuOnly=1 so they can accept CPU tasks
# Skip this if using GPU workers
ssh ubuntu@SERVER_IP 'DB_PASS=$(sudo docker exec hashtopolis-db env | grep MYSQL_PASSWORD | cut -d= -f2) && sudo docker exec hashtopolis-db mysql -u hashtopolis -p"$DB_PASS" -e "
-- For CPU workers (c5.xlarge, etc.): set cpuOnly=1
UPDATE hashtopolis.Agent SET cpuOnly=1;
-- Verify
SELECT agentId, agentName, isTrusted, cpuOnly FROM hashtopolis.Agent;
"'
```

**STEP 6: Download Wordlists and Rules (BEFORE creating task)**

**CRITICAL: Files must be in FLAT structure, not subdirectories. The getFile.php endpoint reads from `/usr/local/share/hashtopolis/files/` as a flat directory.**

```bash
# 1. Download rockyou.txt and OneRuleToRuleThemAll to server /tmp
# CRITICAL: Use SecLists or direct download - GitHub naive-hashcat link redirects and fails
ssh ubuntu@SERVER_IP 'cd /tmp &&
curl -sL "https://github.com/danielmiessler/SecLists/raw/master/Passwords/Leaked-Databases/rockyou.txt.tar.gz" -o rockyou.txt.tar.gz &&
tar xzf rockyou.txt.tar.gz &&
curl -sL "https://raw.githubusercontent.com/NotSoSecure/password_cracking_rules/master/OneRuleToRuleThemAll.rule" -o OneRuleToRuleThemAll.rule &&
ls -lh rockyou.txt OneRuleToRuleThemAll.rule'

# 2. Copy to the CORRECT location (hashtopolis reads from /usr/local/share/hashtopolis/files/)
# Files must be FLAT - not in subdirectories like /files/1/rockyou.txt
# NOTE: docker cp creates files as root - must pipe through container to set proper ownership
ssh ubuntu@SERVER_IP 'sudo docker exec hashtopolis-backend mkdir -p /usr/local/share/hashtopolis/files

# Method that ensures www-data ownership (docker cp + chown fails due to container permissions)
sudo cat /tmp/rockyou.txt | sudo docker exec -i -u root hashtopolis-backend bash -c "cat > /usr/local/share/hashtopolis/files/rockyou.txt && chown www-data:www-data /usr/local/share/hashtopolis/files/rockyou.txt"
sudo cat /tmp/OneRuleToRuleThemAll.rule | sudo docker exec -i -u root hashtopolis-backend bash -c "cat > /usr/local/share/hashtopolis/files/OneRuleToRuleThemAll.rule && chown www-data:www-data /usr/local/share/hashtopolis/files/OneRuleToRuleThemAll.rule"

# CRITICAL: Verify files exist with CORRECT sizes - DO NOT proceed if sizes are wrong!
# rockyou.txt should be ~139MB (139921497 bytes)
# OneRuleToRuleThemAll.rule should be ~403KB (402732 bytes)
echo "Verifying file sizes..."
sudo docker exec hashtopolis-backend ls -la /usr/local/share/hashtopolis/files/
ROCKYOU_SIZE=$(sudo docker exec hashtopolis-backend stat -c%s /usr/local/share/hashtopolis/files/rockyou.txt 2>/dev/null || echo 0)
RULE_SIZE=$(sudo docker exec hashtopolis-backend stat -c%s /usr/local/share/hashtopolis/files/OneRuleToRuleThemAll.rule 2>/dev/null || echo 0)
if [ "$ROCKYOU_SIZE" -lt 100000000 ]; then echo "ERROR: rockyou.txt is corrupted ($ROCKYOU_SIZE bytes) - should be ~139MB"; exit 1; fi
if [ "$RULE_SIZE" -lt 400000 ]; then echo "ERROR: rule file is corrupted ($RULE_SIZE bytes) - should be ~403KB"; exit 1; fi
echo "Files verified: rockyou.txt=$ROCKYOU_SIZE bytes, rule=$RULE_SIZE bytes"'

# 3. Register files in database (MUST match filename exactly, no path)
ssh ubuntu@SERVER_IP 'DB_PASS=$(sudo docker exec hashtopolis-db env | grep MYSQL_PASSWORD | cut -d= -f2) && sudo docker exec hashtopolis-db mysql -u hashtopolis -p"$DB_PASS" -e "
-- fileType 0 = wordlist, fileType 1 = rules
INSERT INTO hashtopolis.File (fileId, filename, size, isSecret, fileType, accessGroupId, lineCount)
VALUES (1, \"rockyou.txt\", 139921497, 0, 0, 1, 14344391);

INSERT INTO hashtopolis.File (fileId, filename, size, isSecret, fileType, accessGroupId, lineCount)
VALUES (2, \"OneRuleToRuleThemAll.rule\", 402732, 0, 1, 1, 51995);

-- Verify registration
SELECT fileId, filename, size, fileType FROM hashtopolis.File;
"'

# 4. Test file download works (optional but recommended)
ssh ubuntu@SERVER_IP 'curl -s "http://localhost:8080/getFile.php?file=1" 2>&1 | head -1'
# Should NOT show "ERR3 - file not present" or "No access!"
```

**Why this matters:** Workers download files from the server via getFile.php. If files are in wrong location (subdirectories, docker volumes not mapped), workers get empty/corrupt files and cracking fails silently with keyspace=1.

**STEP 7: Create Hashlist (DATABASE - NOT API)**
```bash
ssh ubuntu@SERVER_IP 'DB_PASS=$(sudo docker exec hashtopolis-db env | grep MYSQL_PASSWORD | cut -d= -f2) && sudo docker exec hashtopolis-db mysql -u hashtopolis -p"$DB_PASS" -e "
INSERT INTO hashtopolis.Hashlist (hashlistName, format, hashTypeId, hashCount, saltSeparator, cracked, isSecret, hexSalt, isSalted, accessGroupId, notes, brainId, brainFeatures, isArchived)
VALUES (\"MyHashlist\", 0, 0, 3, \":\", 0, 0, 0, 0, 1, \"\", 0, 0, 0);
SET @hl = LAST_INSERT_ID();

INSERT INTO hashtopolis.Hash (hashlistId, hash, salt, plaintext, timeCracked, chunkId, isCracked, crackPos)
VALUES
  (@hl, \"5d41402abc4b2a76b9719d911017c592\", \"\", \"\", NULL, NULL, 0, 0),
  (@hl, \"098f6bcd4621d373cade4e832627b4f6\", \"\", \"\", NULL, NULL, 0, 0),
  (@hl, \"d8578edf8458ce06fbc5bb76a58c5ca4\", \"\", \"\", NULL, NULL, 0, 0);

SELECT hashlistId, hashlistName, hashCount FROM hashtopolis.Hashlist ORDER BY hashlistId DESC LIMIT 1;
"'
```

**STEP 8: Create Task**

**CRITICAL FOR CPU WORKERS: Add `--force` to attackCmd**
PoCL 1.8 on cloud instances has compatibility issues with hashcat 7.x benchmark. Without `--force`, benchmark fails with "Outdated PoCL OpenCL runtime detected!" and task gets keyspace=1.

**TRY API FIRST** (preferred - handles keyspace automatically):
```bash
HASHLIST_ID=1
curl -X POST http://SERVER_IP:8080/api/user.php \
  -H 'Content-Type: application/json' \
  -d "{
    \"section\":\"task\",
    \"request\":\"createTask\",
    \"accessKey\":\"PAI_API_KEY\",
    \"name\":\"SHA256-OneRule-Rockyou\",
    \"hashlistId\":$HASHLIST_ID,
    \"attackCmd\":\"--force #HL# rockyou.txt -r OneRuleToRuleThemAll.rule\",
    \"chunkTime\":600,
    \"statusTimer\":5,
    \"priority\":100,
    \"maxAgents\":0,
    \"isCpuTask\":true,
    \"isSmall\":false,
    \"crackerBinaryId\":1,
    \"crackerBinaryTypeId\":1,
    \"files\":[1,2]
  }"
```

**IF API RETURNS "Invalid query!" - USE DATABASE WITH KEYSPACE FIX:**

Database task insert skips keyspace calculation, causing keyspace=1 and immediate task exhaustion. You MUST set keyspace=0 and priority correctly:

```bash
ssh ubuntu@SERVER_IP 'DB_PASS=$(sudo docker exec hashtopolis-db env | grep MYSQL_PASSWORD | cut -d= -f2) && sudo docker exec hashtopolis-db mysql -u hashtopolis -p"$DB_PASS" -e "
-- Create TaskWrapper (links task to hashlist)
INSERT INTO hashtopolis.TaskWrapper (priority, maxAgents, taskType, hashlistId, accessGroupId, taskWrapperName, isArchived, cracked)
VALUES (100, 0, 0, 1, 1, \"SHA256-OneRule-Rockyou\", 0, 0);
SET @tw = LAST_INSERT_ID();

-- Create Task with keyspace=0 (forces recalculation by agents)
-- CRITICAL: Use --force for CPU workers (PoCL compatibility)
INSERT INTO hashtopolis.Task (taskName, attackCmd, chunkTime, statusTimer, keyspace, keyspaceProgress, priority, maxAgents, color, isSmall, isCpuTask, useNewBench, skipKeyspace, crackerBinaryId, crackerBinaryTypeId, taskWrapperId, isArchived, notes, staticChunks, chunkSize, forcePipe, usePreprocessor, preprocessorCommand)
VALUES (\"SHA256-OneRule-Rockyou\", \"--force #HL# rockyou.txt -r OneRuleToRuleThemAll.rule\", 600, 5, 0, 0, 100, 0, \"\", 0, 1, 1, 0, 1, 1, @tw, 0, \"\", 0, 0, 0, 0, \"\");
SET @t = LAST_INSERT_ID();

-- Link files to task
INSERT INTO hashtopolis.FileTask (fileId, taskId) VALUES (1, @t);
INSERT INTO hashtopolis.FileTask (fileId, taskId) VALUES (2, @t);

-- CRITICAL: Verify keyspace=0 (will be calculated by first agent)
SELECT taskId, taskName, keyspace, priority FROM hashtopolis.Task;
"'
```

**IMPORTANT:** If you see keyspace=1 instead of 0, the task will exhaust immediately. Fix with:
```bash
ssh ubuntu@SERVER_IP 'DB_PASS=$(sudo docker exec hashtopolis-db env | grep MYSQL_PASSWORD | cut -d= -f2) && sudo docker exec hashtopolis-db mysql -u hashtopolis -p"$DB_PASS" -e "
UPDATE hashtopolis.Task SET keyspace=0, keyspaceProgress=0, priority=100;
UPDATE hashtopolis.TaskWrapper SET priority=100;
"'
```

**STEP 9: Monitor Progress**
```bash
ssh ubuntu@SERVER_IP 'DB_PASS=$(sudo docker exec hashtopolis-db env | grep MYSQL_PASSWORD | cut -d= -f2) && sudo docker exec hashtopolis-db mysql -u hashtopolis -p"$DB_PASS" -e "
SELECT taskId, keyspace, keyspaceProgress FROM hashtopolis.Task;
SELECT cracked, hashCount FROM hashtopolis.Hashlist WHERE hashlistId=1;
"'
```

### WHY THIS ORDER MATTERS

1. **Vouchers must exist BEFORE workers boot** - Create N vouchers for N workers to avoid race conditions
2. **Download wordlists/rules BEFORE creating task** - Files must exist for task to work
3. **Hashlist via database** - API createHashlist is unreliable, returns "Invalid query!"
4. **Task via API** - Database insert skips initialization, causes "No task available!"
5. **NEVER manually insert into Assignment table** - This is an anti-pattern, use API createTask instead

## Architecture

```
PAI Hashcrack CLI
       │
       ▼
Hashtopolis Server (orchestration)
       │
       ├── Worker 1 (XCP-ng / AWS / Azure / GCP / OCI)
       ├── Worker 2 (XCP-ng / AWS / Azure / GCP / OCI)
       ├── Worker N (cloud)
       └── ...scale to hundreds
```

### Supported Platforms
| Platform | Terraform Dir | Status | Notes |
|----------|---------------|--------|-------|
| XCP-ng (local) | `terraform/` | Production | Local hypervisor |
| **Proxmox** | `terraform/proxmox/` | **New** | Local hypervisor, cloud-init |
| AWS | `terraform/aws/` | **Production** | Spot instances, T4 GPU |
| GCP | `terraform/gcp/` | **Production** | Preemptible, T4 GPU |
| Azure | `terraform/azure/` | Tested | Spot instances |
| **OCI** | `terraform/oci/` | **New** | Preemptible, 10TB free egress |

### GCP-Specific Requirements

**CRITICAL: Cloud NAT Required**
GCP VMs with private IPs cannot reach internet without Cloud NAT (unlike AWS/Azure).
The terraform config includes Cloud Router + Cloud NAT automatically.

**Quota Limits:**
- `CPUS_ALL_REGIONS`: Global limit overrides regional quotas
- New projects default to 32 vCPU globally
- Request increases via Console → IAM & Admin → Quotas

**GCP Authentication:**
```bash
gcloud auth login
gcloud auth application-default login
gcloud config set project YOUR_PROJECT
gcloud services enable compute.googleapis.com
```

### OCI-Specific Requirements

**Benefits:**
- 10TB free egress per month (vs ~$0.09/GB on AWS/GCP)
- Preemptible instances up to 50% cheaper
- Flex shapes allow custom OCPU/memory configuration
- No minimum commitment

**OCI Authentication:**
1. Create API Key in OCI Console → User Settings → API Keys
2. Download the private key and config file
3. Set up `~/.oci/config` or use terraform.tfvars

```bash
# Install OCI CLI (optional but helpful)
bash -c "$(curl -L https://raw.githubusercontent.com/oracle/oci-cli/master/scripts/install/install.sh)"

# Verify authentication
oci iam region list
```

**Required OCIDs for terraform.tfvars:**
- `tenancy_ocid` - Your tenancy identifier
- `user_ocid` - Your user identifier
- `compartment_ocid` - (Optional) Compartment for resources
- `fingerprint` - API key fingerprint

**GPU Shapes:**
| Shape | GPU | Memory | Use Case |
|-------|-----|--------|----------|
| VM.GPU2.1 | 1x P100 | 16GB | Good for hashcracking |
| VM.GPU3.1 | 1x V100 | 16GB | Better performance |
| BM.GPU4.8 | 8x A100 | 40GB | Maximum throughput |

### Proxmox-Specific Requirements

**Prerequisites:**
1. Proxmox VE with API access (default with root@pam)
2. Storage configured (local-lvm recommended)
3. Network bridge (vmbr0 default)

**IMPORTANT: The terraform config (`create_template = true`) automatically creates the Ubuntu cloud-init template. No manual template creation needed.**

**Terraform Authentication:**
```hcl
proxmox_url      = "https://192.168.99.205:8006"
proxmox_user     = "root@pam"
proxmox_password = "your-password"
proxmox_insecure = true  # Allow self-signed certs (lab)
```

**Resource Planning (i7-10710U with 12 cores, 32GB RAM):**
| Config | Server | Workers | Total vCPU | Total RAM |
|--------|--------|---------|------------|-----------|
| Conservative | 2 vCPU, 4GB | 2 × 4 vCPU, 4GB | 10 vCPU | 12 GB |
| Moderate | 2 vCPU, 4GB | 4 × 4 vCPU, 4GB | 18 vCPU | 20 GB |
| Maximum | 2 vCPU, 4GB | 4 × 4 vCPU, 6GB | 18 vCPU | 28 GB |

### PROXMOX STEP-BY-STEP DEPLOYMENT (FOLLOW EXACTLY)

**CRITICAL: Follow this sequence EXACTLY. Skipping steps or changing order causes failures.**

#### STEP 1: Deploy Infrastructure

```bash
cd terraform/proxmox
terraform init
terraform apply -auto-approve
```

This creates:
- Ubuntu cloud-init template (if `create_template = true`)
- Hashtopolis server VM
- Worker VMs (configured count)

#### STEP 2: Wait for VMs to Boot and Discover DHCP IPs (3-5 minutes)

```bash
# Wait for cloud-init and QEMU guest agent
sleep 180

# BEST METHOD: Scan for Hashtopolis server on port 8080
echo "Scanning for Hashtopolis server..." && for ip in $(seq 30 60); do
  curl -s --connect-timeout 1 http://192.168.99.$ip:8080/ >/dev/null 2>&1 && echo "Found server: 192.168.99.$ip"
done

# Then scan for worker VMs via SSH
echo "Scanning for workers..." && for ip in $(seq 30 60); do
  ssh -o StrictHostKeyChecking=no -o ConnectTimeout=1 -o BatchMode=yes ubuntu@192.168.99.$ip "hostname 2>/dev/null" 2>/dev/null | grep -q "worker" && echo "Found worker: 192.168.99.$ip"
done
```

**CRITICAL (DHCP Mode):** The terraform outputs show the *configured* IP from `var.server_ip`, NOT the actual DHCP-assigned IP. You MUST discover the real IPs using one of these methods:
- **Port scan** (recommended): Scan for port 8080 (server) and SSH (workers)
- Proxmox GUI → VM → Summary → IP Address
- DHCP server lease table
- `qm guest exec <vmid> ip addr`

#### STEP 3: Verify Server is Running

```bash
SERVER_IP=<actual-dhcp-ip>  # e.g., 192.168.99.30
curl -s http://$SERVER_IP:8080/ | head -5
# Should show HTML (Hashtopolis login page)
```

#### STEP 4: Get Database Password

**The DB password is auto-generated and stored in the container environment:**

```bash
ssh ubuntu@$SERVER_IP "docker exec hashtopolis-db env | grep MYSQL_PASSWORD"
# Save this password - you'll need it for all DB operations
DB_PASS="<password-from-above>"
```

#### STEP 5: Create Vouchers (ONE PER WORKER)

**CRITICAL: Create vouchers BEFORE workers try to register. Race conditions cause failures even with deletion disabled.**

```bash
WORKER_COUNT=2  # Match your worker_count
ssh ubuntu@$SERVER_IP "docker exec hashtopolis-db mysql -uhashtopolis -p$DB_PASS -e \"
-- Disable voucher deletion
UPDATE hashtopolis.Config SET value='0' WHERE item='voucherDeletion';

-- Create one voucher per worker (avoid race conditions)
INSERT INTO hashtopolis.RegVoucher (voucher, time) VALUES ('PAI_PROXMOX_WORKER1', UNIX_TIMESTAMP());
INSERT INTO hashtopolis.RegVoucher (voucher, time) VALUES ('PAI_PROXMOX_WORKER2', UNIX_TIMESTAMP());
-- Add more if worker_count > 2

-- Verify
SELECT voucher FROM hashtopolis.RegVoucher;
\" hashtopolis"
```

#### STEP 6: Fix Worker Config (If DHCP)

**If workers connected to wrong server IP, fix their config:**

```bash
# Get worker IPs from Proxmox GUI or DHCP leases
WORKER1_IP=192.168.99.33
WORKER2_IP=192.168.99.31

# Update worker 1 config
ssh ubuntu@$WORKER1_IP "cat > /tmp/config.json << 'EOF'
{\"url\": \"http://$SERVER_IP:8080/api/server.php\", \"voucher\": \"PAI_PROXMOX_WORKER1\"}
EOF
sudo cp /tmp/config.json /opt/hashtopolis-agent/config.json
sudo systemctl restart hashtopolis-agent"

# Update worker 2 config
ssh ubuntu@$WORKER2_IP "cat > /tmp/config.json << 'EOF'
{\"url\": \"http://$SERVER_IP:8080/api/server.php\", \"voucher\": \"PAI_PROXMOX_WORKER2\"}
EOF
sudo cp /tmp/config.json /opt/hashtopolis-agent/config.json
sudo systemctl restart hashtopolis-agent"
```

#### STEP 7: Wait for Agents to Register (2-3 minutes)

```bash
ssh ubuntu@$SERVER_IP "docker exec hashtopolis-db mysql -uhashtopolis -p$DB_PASS -N -e '
SELECT agentId, agentName, isActive, isTrusted FROM hashtopolis.Agent;
' hashtopolis"
# Wait until all workers appear
```

#### STEP 8: Trust Agents and Set CPU Mode

```bash
ssh ubuntu@$SERVER_IP "docker exec hashtopolis-db mysql -uhashtopolis -p$DB_PASS -e '
-- Trust all agents
UPDATE hashtopolis.Agent SET isTrusted = 1;

-- CRITICAL for CPU workers: set cpuOnly=1
UPDATE hashtopolis.Agent SET cpuOnly = 1;

-- Verify
SELECT agentId, agentName, isTrusted, cpuOnly FROM hashtopolis.Agent;
' hashtopolis"
```

#### STEP 9: Download Files to Server

```bash
ssh ubuntu@$SERVER_IP 'cd /tmp &&
curl -sL "https://github.com/danielmiessler/SecLists/raw/master/Passwords/Leaked-Databases/rockyou.txt.tar.gz" -o rockyou.txt.tar.gz &&
tar xzf rockyou.txt.tar.gz &&
curl -sL "https://raw.githubusercontent.com/NotSoSecure/password_cracking_rules/master/OneRuleToRuleThemAll.rule" -o OneRuleToRuleThemAll.rule &&
ls -lh rockyou.txt OneRuleToRuleThemAll.rule'
```

#### STEP 10: Copy Files to Correct Location

**CRITICAL: Files MUST be in `/usr/local/share/hashtopolis/files/` with www-data ownership**

```bash
ssh ubuntu@$SERVER_IP '
sudo docker exec hashtopolis-backend mkdir -p /usr/local/share/hashtopolis/files

# Copy files with correct ownership
sudo cat /tmp/rockyou.txt | sudo docker exec -i -u root hashtopolis-backend bash -c "cat > /usr/local/share/hashtopolis/files/rockyou.txt && chown www-data:www-data /usr/local/share/hashtopolis/files/rockyou.txt"
sudo cat /tmp/OneRuleToRuleThemAll.rule | sudo docker exec -i -u root hashtopolis-backend bash -c "cat > /usr/local/share/hashtopolis/files/OneRuleToRuleThemAll.rule && chown www-data:www-data /usr/local/share/hashtopolis/files/OneRuleToRuleThemAll.rule"

# Verify
sudo docker exec hashtopolis-backend ls -la /usr/local/share/hashtopolis/files/'
```

#### STEP 11: Register Files in Database

```bash
ssh ubuntu@$SERVER_IP "docker exec hashtopolis-db mysql -uhashtopolis -p$DB_PASS -e \"
INSERT INTO hashtopolis.File (fileId, filename, size, isSecret, fileType, accessGroupId, lineCount)
VALUES (1, 'rockyou.txt', 139921497, 0, 0, 1, 14344391);

INSERT INTO hashtopolis.File (fileId, filename, size, isSecret, fileType, accessGroupId, lineCount)
VALUES (2, 'OneRuleToRuleThemAll.rule', 402732, 0, 1, 1, 51995);

SELECT fileId, filename, size FROM hashtopolis.File;
\" hashtopolis"
```

#### STEP 12: Create Hashlist via Database

```bash
# Upload your hashes to server first
scp sample_md5.txt ubuntu@$SERVER_IP:/tmp/

# Create hashlist and load hashes
ssh ubuntu@$SERVER_IP "
HASH_COUNT=\$(wc -l < /tmp/sample_md5.txt)
docker exec hashtopolis-db mysql -uhashtopolis -p$DB_PASS -e \"
INSERT INTO hashtopolis.Hashlist (hashlistName, format, hashTypeId, hashCount, saltSeparator, cracked, isSecret, hexSalt, isSalted, accessGroupId, notes, brainId, brainFeatures, isArchived)
VALUES ('Proxmox-MD5-Test', 0, 0, \$HASH_COUNT, ':', 0, 0, 0, 0, 1, '', 0, 0, 0);
\" hashtopolis

# Load individual hashes
docker exec hashtopolis-db mysql -uhashtopolis -p$DB_PASS hashtopolis << 'SQLEOF'
LOAD DATA LOCAL INFILE '/tmp/sample_md5.txt' INTO TABLE Hash
FIELDS TERMINATED BY '\n'
(hash)
SET hashlistId = 1, salt = '', plaintext = '', timeCracked = NULL, chunkId = NULL, isCracked = 0, crackPos = 0;
SQLEOF
"
```

#### STEP 13: Create Task with --force Flag

**CRITICAL: CPU workers need `--force` in attackCmd (PoCL compatibility)**

```bash
ssh ubuntu@$SERVER_IP "docker exec hashtopolis-db mysql -uhashtopolis -p$DB_PASS -e \"
-- Create TaskWrapper
INSERT INTO hashtopolis.TaskWrapper (priority, maxAgents, taskType, hashlistId, accessGroupId, taskWrapperName, isArchived, cracked)
VALUES (100, 0, 0, 1, 1, 'Proxmox MD5 + OneRule', 0, 0);
SET @tw = LAST_INSERT_ID();

-- Create Task with --force for CPU workers
INSERT INTO hashtopolis.Task (taskName, attackCmd, chunkTime, statusTimer, keyspace, keyspaceProgress, priority, maxAgents, color, isSmall, isCpuTask, useNewBench, skipKeyspace, crackerBinaryId, crackerBinaryTypeId, taskWrapperId, isArchived, notes, staticChunks, chunkSize, forcePipe, usePreprocessor, preprocessorCommand)
VALUES ('MD5-OneRule-Rockyou', '#HL# rockyou.txt -r OneRuleToRuleThemAll.rule --force', 600, 5, 0, 0, 100, 0, '', 0, 1, 1, 0, 1, 1, @tw, 0, '', 0, 0, 0, 0, '');
SET @t = LAST_INSERT_ID();

-- Link files to task
INSERT INTO hashtopolis.FileTask (fileId, taskId) VALUES (1, @t);
INSERT INTO hashtopolis.FileTask (fileId, taskId) VALUES (2, @t);

-- Verify
SELECT taskId, taskName, keyspace, priority, isCpuTask FROM hashtopolis.Task;
\" hashtopolis"
```

#### STEP 14: Fix Permissions (If Needed)

If benchmark or cracking fails with permission errors:

```bash
ssh ubuntu@$SERVER_IP "
docker exec -u root hashtopolis-backend chmod -R 777 /var/lib/hashcat
docker exec -u root hashtopolis-backend mkdir -p /usr/local/share/hashtopolis/crackers
docker exec -u root hashtopolis-backend chmod -R 777 /usr/local/share/hashtopolis/crackers
docker exec -u root hashtopolis-backend chmod -R 777 /usr/local/share/hashtopolis/files
"
```

#### STEP 15: Monitor Progress

```bash
# One-time check
ssh ubuntu@$SERVER_IP "docker exec hashtopolis-db mysql -uhashtopolis -p$DB_PASS -N -e '
SELECT h.cracked, h.hashCount, t.keyspace, t.keyspaceProgress FROM hashtopolis.Hashlist h, hashtopolis.Task t WHERE h.hashlistId=1 AND t.taskId=1;
' hashtopolis"

# Continuous monitoring
watch -n 60 "ssh ubuntu@$SERVER_IP \"docker exec hashtopolis-db mysql -uhashtopolis -p\$DB_PASS -N -e 'SELECT cracked, hashCount FROM hashtopolis.Hashlist WHERE hashlistId=1' hashtopolis\""
```

### Proxmox Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Workers connect to wrong IP | DHCP IP differs from terraform output | Update worker config.json with actual server IP |
| Voucher not found | Voucher not created in DB | Create voucher via database INSERT |
| Second worker fails to register | Voucher already consumed | Create unique voucher per worker |
| Benchmark fails (exit 255) | PoCL compatibility | Add `--force` to attackCmd |
| Files not downloading | Wrong path or permissions | Copy to `/usr/local/share/hashtopolis/files/`, set www-data ownership |
| Permission denied on benchmark.pid | hashcat directory permissions | `chmod -R 777` on crackers directory |
| Task has keyspace=1 | Files corrupted on workers | Delete worker files, reset task keyspace=0 |
| Table not found (lowercase) | MySQL case sensitivity | Use exact table names: `Hashlist`, `Task`, `Agent` (not lowercase) |

## Quick Start

```bash
# Check prerequisites and create Ubuntu template (if needed)
hashcrack setup

# Deploy infrastructure
hashcrack deploy --workers 3

# Submit hash job (auto-detects format!)
hashcrack crack --input /etc/shadow
hashcrack crack --input ntds.dit.ntds
hashcrack crack --input pwdump.txt
hashcrack crack --input hashes.txt --type ntlm

# Or pipe directly
cat shadow | hashcrack crack
cat pwdump.txt | hashcrack crack

# Monitor progress
hashcrack status

# Scale workers mid-job
hashcrack scale --workers 10

# View results (automatically builds custom wordlist)
hashcrack results

# View Hashtopolis UI
hashcrack server

# Manage custom wordlist
hashcrack wordlist stats

# Cleanup
hashcrack teardown
```

## Workflow Routing

**When executing a workflow, do BOTH of these:**

1. **Call the notification script** (for observability tracking):
   ```bash
   ~/.claude/Tools/SkillWorkflowNotification WORKFLOWNAME Hashcrack
   ```

2. **Output the text notification** (for user visibility):
   ```
   Running the **WorkflowName** workflow from the **Hashcrack** skill...
   ```

| Workflow | Trigger | File |
|----------|---------|------|
| **Setup** | "setup hashcrack", "create template" | `workflows/CreateTemplate.md` |
| **Deploy** | "deploy hashcrack", "spin up workers" | `workflows/Deploy.md` |
| **Crack** | "crack hashes", "submit job" | `workflows/Crack.md` |
| **Monitor** | "check status", "progress" | `workflows/Monitor.md` |
| **Scale** | "add workers", "scale up/down" | `workflows/Scale.md` |
| **Results** | "get results", "cracked passwords" | `workflows/Results.md` |
| **Teardown** | "destroy", "cleanup", "teardown" | `workflows/Teardown.md` |

## Supported Input Formats

The skill automatically detects and parses various credential dump formats:

| Format | Example | Auto-Detection |
|--------|---------|----------------|
| **Linux Shadow** | `root:$6$salt$hash:...` | Detects `$N$` prefix |
| **Windows SAM (pwdump)** | `user:500:aad3b435:31d6cfe0:::` | RID + LM:NTLM pattern |
| **NTDS.dit (secretsdump)** | `DOMAIN\user:500:aad3b435:31d6cfe0:::` | Domain\\ prefix |
| **Plain Hashes** | `31d6cfe0d16ae931...` | Hex patterns |
| **Hashcat Potfile** | `hash:plaintext` | hash:value format |

### Shadow File Hash Types

| Prefix | Algorithm | Cracker |
|--------|-----------|---------|
| `$1$` | MD5crypt | hashcat (Hashtopolis) |
| `$2a$`/`$2b$` | bcrypt | hashcat (Hashtopolis) |
| `$5$` | SHA-256crypt | hashcat (Hashtopolis) |
| `$6$` | SHA-512crypt | hashcat (Hashtopolis) |
| `$y$` | yescrypt | **John the Ripper** (local) |
| `$7$` | scrypt | **John the Ripper** (local) |

**Note**: Ubuntu 24.04+ uses yescrypt (`$y$`) by default. These hashes are automatically routed to John the Ripper when available.

## Supported Hash Types

| Type | Hashcat Mode | Common Source |
|------|--------------|---------------|
| MD5 | 0 | Web applications |
| SHA1 | 100 | Legacy systems |
| SHA256 | 1400 | Modern hashing |
| MD5crypt | 500 | Legacy Linux |
| SHA256crypt | 7400 | Modern Linux |
| SHA512crypt | 1800 | Current Linux /etc/shadow |
| NTLM | 1000 | Windows SAM/AD |
| LM | 3000 | Legacy Windows |
| bcrypt | 3200 | Modern web apps |
| NetNTLMv1 | 5500 | Network captures |
| NetNTLMv2 | 5600 | Network captures |
| Kerberos AS-REP | 18200 | AD attacks |
| Kerberos TGS | 13100 | AD attacks |

## Custom Wordlist

The skill maintains a custom wordlist of cracked passwords that weren't found using standard dictionary attacks (like rockyou). This provides **significant time savings** when auditing local accounts that may reuse passwords.

### How It Works

1. When you run `hashcrack results`, novel passwords are automatically extracted
2. Passwords already in rockyou are skipped (no value in duplicating)
3. Novel passwords are saved to `.claude/skills/Hashcrack/data/custom_passwords.txt`
4. On subsequent cracks, custom wordlist is used **first** (priority 110)

### Managing Custom Wordlist

```bash
# View statistics
hashcrack wordlist stats

# Import from existing potfile
hashcrack wordlist import /path/to/hashcat.potfile

# Export for external use
hashcrack wordlist export /path/to/output.txt

# Upload to Hashtopolis server
hashcrack wordlist upload

# Clear all entries
hashcrack wordlist clear
```

### Why This Matters

- Local accounts often reuse passwords across systems
- Passwords cracked via rules/masks won't be in standard wordlists
- Custom wordlist catches these in seconds on future audits
- Builds organizational password intelligence over time

## Passphrase Wordlist Sources

Long passphrases (10+ chars) require specialized wordlists. As NIST 2025 guidelines push organizations toward 15+ character passphrases, predictable patterns are emerging in clusters. Users follow predictable patterns: song lyrics, movie quotes, memes, and initialisms.

### Tier 1: Essential Passphrase Wordlists

| Source | Size | Update Freq | Best For | URL |
|--------|------|-------------|----------|-----|
| **initstring/passphrase-wordlist** | 20M+ phrases | Periodic | Movie quotes, lyrics, book titles | [GitHub](https://github.com/initstring/passphrase-wordlist) |
| **Have I Been Pwned** | 900M+ | Monthly | Real breach passwords (SHA1/NTLM) | [HIBP Passwords](https://haveibeenpwned.com/Passwords) |
| **Kaonashi** | 2.35GB | Stable | Sorted by occurrence frequency | [GitHub](https://github.com/kaonashi-passwords/Kaonashi) |
| **WeakPass** | Various | Active | Large wordlist collection | [weakpass.com](https://weakpass.com/) |
| **CrackStation** | 15GB | Stable | Wikipedia + breaches + books | [crackstation.net](https://crackstation.net/crackstation-wordlist-password-cracking-dictionary.htm) |

### Tier 2: Dynamic/Trending Sources

These sources update frequently and capture current cultural trends:

| Source | Update Freq | Content Type | Access |
|--------|-------------|--------------|--------|
| **Know Your Meme** | Daily | Meme phrases, catchphrases | [knowyourmeme.com](https://knowyourmeme.com/) |
| **Urban Dictionary** | Daily | Slang, trending phrases | [urbandictionary.com](https://www.urbandictionary.com/) |
| **Google Trends** | Real-time | Trending searches | [pytrends](https://github.com/GeneralMills/pytrends) |
| **Billboard Charts** | Weekly | Song titles, artist names | [billboard.com](https://www.billboard.com/charts/) |
| **IMDB** | Weekly | Movie/TV titles, character names | [imdb.com/interfaces](https://www.imdb.com/interfaces/) |

### Tier 3: Specialized Tools

| Tool | Purpose | URL |
|------|---------|-----|
| **LyricPass** | Generate wordlists from song lyrics | [GitHub](https://github.com/initstring/lyricpass) |
| **Phraser** | N-gram/Markov chain phrase generation | [GitHub](https://github.com/Sparell/Phraser) |
| **Mentalist** | GUI for custom wordlist creation | [GitHub](https://github.com/sc0tfree/mentalist) |
| **PACK** | Analyze passwords for pattern masks | [GitHub](https://github.com/iphelix/pack) |
| **Wordlust** | Combined dictionary (movies, lyrics, phrases) | [GitHub](https://github.com/frizb/Wordlust) |

### initstring/passphrase-wordlist Details

**20M+ phrases** compiled from dynamic and static sources (last updated July 2025):

**Dynamic Sources (Updated Periodically):**
- Wikipedia/Wiktionary article titles
- Urban Dictionary entries
- Know Your Meme database
- IMDB movie/TV dataset
- Billboard music charts
- Global points of interest

**Static Sources:**
- Cornell Movie-Dialogs corpus
- Book titles (Kaggle)
- Famous quotes databases
- Common English phrases

**Hashcat Rules Included:**
- `passphrase-rule1.rule` - Capitalization, spacing variations
- `passphrase-rule2.rule` - Character substitutions, mutations
- Together generate **1000+ permutations per phrase**

### Initialism/Acronym Patterns

Users often create passwords from **first letters of phrases**:

| Phrase | Initialism Password |
|--------|---------------------|
| "To be or not to be" | `tbontb` or `Tbontb1!` |
| "Live laugh love" | `lll` or `LLL2024` |
| "Make America Great Again" | `maga` or `MAGA!` |
| "You only live once" | `yolo` or `Yolo123` |
| "What would Jesus do" | `wwjd` or `WWJD!` |

**Detection Strategy:**
1. Generate initialisms from known phrase lists
2. Apply standard mutation rules (capitalize, add numbers/symbols)
3. Run as high-priority pretask before brute force

### 2025-2026 Trending Passphrase Patterns

Based on NIST guidance pushing 15+ char passwords, these patterns are emerging:

| Pattern | Example | Prevalence |
|---------|---------|------------|
| **Season+Year+Symbol** | `Winter2025!` | Very High |
| **Phrase+Numbers** | `letmein123456` | High |
| **Movie/Song Titles** | `MayTheForceBeWithYou` | Medium |
| **Meme References** | `itsgivingmaincharacter` | Growing |
| **Sports+Year** | `GoPackGo2025!` | Regional |
| **3-4 Word Combos** | `correct horse battery` | Emerging |

### Quick Download Commands

```bash
# Essential passphrase wordlist (20M+ phrases)
wget https://github.com/initstring/passphrase-wordlist/releases/latest/download/passphrases.txt.gz
gunzip passphrases.txt.gz

# Kaonashi (sorted by frequency - most effective first)
wget https://github.com/kaonashi-passwords/Kaonashi/releases/download/v1.0/kaonashi.txt.7z

# HIBP Pwned Passwords (NTLM format for AD audits)
# Use the downloader tool for full 900M+ dataset
git clone https://github.com/HaveIBeenPwned/PwnedPasswordsDownloader
dotnet run -- -n -o pwned-passwords-ntlm

# SecLists common credentials
wget https://raw.githubusercontent.com/danielmiessler/SecLists/master/Passwords/Common-Credentials/10k-most-common.txt

# Generate lyrics-based wordlist for specific artist
pip install lyricpass
lyricpass -a "Taylor Swift" -o taylor_swift_lyrics.txt
```

### Recommended Attack Order for Passphrases

| Priority | Attack | Wordlist | Expected Hits |
|----------|--------|----------|---------------|
| 1 | Direct passphrase | passphrases.txt | 5-10% |
| 2 | Passphrase + rules | passphrases.txt + passphrase-rule1/2 | 10-20% |
| 3 | Kaonashi top 10M | kaonashi-top10m.txt | 15-25% |
| 4 | HIBP common | pwned-passwords-top1m.txt | 20-30% |
| 5 | Initialism generation | Custom from phrases | 2-5% |
| 6 | Trending + mutations | Urban Dict + rules | 1-3% |

### Building Custom Trending Wordlists

```python
# Example: Generate wordlist from Google Trends
from pytrends.request import TrendReq

pytrends = TrendReq()
# Get daily trending searches
trending = pytrends.trending_searches(pn='united_states')

# Save as wordlist
with open('trending_phrases.txt', 'w') as f:
    for phrase in trending[0]:
        # Original
        f.write(f"{phrase}\n")
        # No spaces
        f.write(f"{phrase.replace(' ', '')}\n")
        # Lowercase no spaces
        f.write(f"{phrase.replace(' ', '').lower()}\n")
```

### API Resources for Dynamic Wordlists

| API | Data Type | Update Frequency |
|-----|-----------|------------------|
| [Google Trends API](https://developers.google.com/search/blog/2025/07/trends-api) | Search trends | Real-time |
| [pytrends](https://github.com/GeneralMills/pytrends) | Google Trends (unofficial) | Real-time |
| [Know Your Meme](https://knowyourmeme.com/) | Meme database | Daily |
| [memes.com API](https://api.memes.com/trending) | Trending memes | Hourly |

### Pattern-Based Learning

After cracking passwords, analyze patterns to improve future attacks:

| Cracked Password | Pattern | Rule to Create |
|-----------------|---------|----------------|
| `returnofthejedi` | Movie title (no spaces) | Pop culture wordlist |
| `January2022` | Month + Year | Date patterns wordlist |
| `P@$$w0rd` | L33t speak | `sa@ ss$ so0` rules |
| `sillywombat11` | 2 words + 2 digits | Combinator + `$11` |
| `Butterfly123!` | Word + 3 digits + special | `c $123 $!` |

### Cross-Hash Type Password Reuse Detection

When auditing mixed hash types (MD5, SHA512crypt, NTLM), immediately reuse cracked passwords:

```bash
# After cracking MD5 hashes, extract plaintext passwords
awk -F: '{print $2}' cracked_md5.txt > reuse_wordlist.txt

# Run against other hash types with highest priority
hashcat -m 1800 linux_shadow.txt reuse_wordlist.txt  # SHA512crypt
hashcat -m 1000 ntlm_hashes.txt reuse_wordlist.txt   # NTLM
```

**Multi-Hash Audit Workflow:**
1. Load ALL hash types as separate hashlists (MD5, SHA512, NTLM, etc.)
2. Run initial wordlist attacks on the fastest hash type first (MD5/NTLM)
3. After any crack, IMMEDIATELY add password to `reuse_wordlist.txt`
4. Run `reuse_wordlist.txt` against ALL other hashlists
5. Password reuse is extremely common - this catches ~30% of additional cracks

**Hashtopolis Integration:**
- Create a shared "cracked passwords" wordlist file
- Set up a high-priority pretask using this wordlist
- Run against all hashlists after any successful crack

### Building Custom Passphrase Lists

```bash
# Extract long passwords from potfile
awk -F: 'length($2) >= 10 {print $2}' hashcat.potfile > long_passwords.txt

# Find most common patterns
sort long_passwords.txt | uniq -c | sort -rn | head -100
```

## Password Policy Intelligence

**CRITICAL: Always ask for the client's password policy before starting an audit.**

The password policy dramatically affects attack strategy. Key questions to ask:

| Question | Why It Matters |
|----------|----------------|
| Minimum length? | Sets brute force boundaries (8 vs 10 vs 15 char) |
| Complexity requirements? | "3 of 4 classes" = predictable patterns |
| Rotation period? | <90 days = increment/append behaviors |
| Passphrase policy? | Changes entire attack strategy |
| Account lockout? | N/A for offline cracking, but indicates security maturity |

### Rotation-Based Attack Patterns

**Short rotation (<90 days) creates predictable mutations:**

| Pattern | Example | Rule |
|---------|---------|------|
| Incrementing numbers | `Password1` → `Password2` → `Password3` | `$0-9` sequence |
| Appending same char | `Summer2024!` → `Summer2024!!` | `$!$!` |
| Season cycling | `Winter2024` → `Spring2024` → `Summer2024` | Seasonal wordlist |
| Month/Year increment | `January2024` → `February2024` | Date wordlist |
| Adding special at end | `Password1` → `Password1!` → `Password1!!` | `$! $!! $!!!` |

**Attack strategy for short rotation environments:**
```bash
# Generate increment rules
for i in {1..99}; do echo "\$${i}"; done > increment.rule

# Generate double-append rules
echo '$!' > append.rule
echo '$!$!' >> append.rule
echo '$@' >> append.rule
echo '$@$@' >> append.rule
```

### Passphrase Attack Variants

**Passphrases appear in multiple forms - attack ALL variants:**

| Form | Example | Hashcat Treatment |
|------|---------|-------------------|
| Spaces between words | `correct horse battery staple` | Direct wordlist entry |
| No spaces | `correcthorsebatterystaple` | Direct wordlist entry |
| Symbol separators | `correct-horse-battery-staple` | Rule: `ss- ss_ ss.` |
| CamelCase | `CorrectHorseBatteryStaple` | Rule: `c` or titlecase |
| First letter caps | `Correct Horse Battery Staple` | Each word capitalized |
| L33t variants | `c0rr3ct h0rs3 b4tt3ry st4pl3` | L33t rules |

**Passphrase rules file:**
```bash
# passphrase_variants.rule
:                    # Original (with spaces)
ss                   # Remove all spaces
ss-                  # Replace space with dash
ss_                  # Replace space with underscore
ss.                  # Replace space with period
c                    # Capitalize first letter
C                    # Lowercase first, upper rest
T0 T1 T2 T3         # Toggle case at positions
sa@ se3 si1 so0     # L33t substitutions
```

**Quick passphrase attack setup:**
```bash
# Create passphrase variants from wordlist
hashcat -m HASH_MODE hashes.txt passphrases.txt -r passphrase_variants.rule

# Combine with common appends
hashcat -m HASH_MODE hashes.txt passphrases.txt -r passphrase_variants.rule -r append.rule
```

### Policy-Driven Attack Priority

| Policy Type | Priority Attacks |
|-------------|------------------|
| 8 char + complexity | Wordlist + best64, then `?u?l?l?l?l?l?d?s` masks |
| 10 char + 3 of 4 | Heavy rules (OneRule), targeted wordlists |
| 12+ char passphrase | Passphrase wordlists, phrase mutations, hybrid attacks |
| 90-day rotation | Standard attacks, no increment focus |
| 30-day rotation | Increment rules HIGH PRIORITY, append patterns |
| AD with history | Previous passwords + increment (if available) |

### Audit Kickoff Checklist

Before starting ANY password audit, confirm:

- [ ] Password policy document received
- [ ] Minimum length requirement
- [ ] Complexity requirements (which classes required)
- [ ] Rotation period (30/60/90/365 days)
- [ ] Passphrase allowed/encouraged?
- [ ] Previous breach data available for this org?
- [ ] Any known password patterns from prior audits?

**If policy unknown:** Start with comprehensive strategy, but ASK - policy knowledge can 10x efficiency.

## Attack Strategy

The skill runs attacks in phases automatically with priority-based scheduling:

### Quick Strategy
| Priority | Attack | Description |
|----------|--------|-------------|
| 110 | Custom Wordlist | Previously cracked passwords (if available) |
| 105 | Custom + Rules | Custom with best64 mutations |
| 100 | rockyou.txt | Standard wordlist attack |

### Comprehensive Strategy (default)
| Priority | Attack | Description |
|----------|--------|-------------|
| 110 | Custom Wordlist | Previously cracked passwords |
| 105 | Custom + Rules | Custom with best64 mutations |
| 100 | rockyou.txt | Standard wordlist |
| 90 | rockyou + best64 | Wordlist with rule mutations |
| 80 | Common Masks | `?u?l?l?l?l?l?d?d?d?d` pattern |
| 75 | Season+Year | `Winter2024!` style patterns |

### Thorough Strategy
Adds combinator attacks, heavy rules (rockyou-30000, OneRule), and extended brute force.

**Note**: Custom wordlist is automatically used first when available, providing fast wins on password reuse.

### Attack Escalation Philosophy

For realistic password audits (24-hour window typical), escalate attacks in order of cost-effectiveness:

| Phase | Attack Type | Target | Worker Scaling |
|-------|-------------|--------|----------------|
| 1 | Wordlists | Common passwords, leaked lists | 1-2 workers |
| 2 | Wordlist + Rules | Mutations of common passwords | 2-4 workers |
| 3 | Targeted Wordlists | Pop culture, company names, seasonal | 2-4 workers |
| 4 | Heavy Rules | OneRuleToRuleThemAll, rockyou-30000 | 4+ workers |
| 5 | Short Brute Force | 6-7 character exhaustive search | 4+ workers |
| 6 | Hybrid Attacks | Wordlist + mask combinations | 4+ workers |
| 7 | Long Brute Force | 8+ characters (time permitting) | Scale as needed |

**Realistic Password Complexity:**
- 6-7 char mixed case + digits: Crackable with brute force in hours with enough workers
- 8-10 char with patterns: Crackable with smart rules (l33t speak, common substitutions)
- 11+ char passphrases: Require targeted wordlists (movies, phrases) or hybrid attacks
- Random 12+ char: Likely not crackable in 24 hours

**Key Insight:** Most real passwords follow patterns. After cracking the easy ones, analyze patterns to create targeted attacks for the remaining hashes.

### Proactive Worker Scaling Recommendations

During an audit, suggest worker scaling when it will meaningfully impact the 24-hour window:

**When to recommend more workers:**
| Scenario | Current Workers | Recommendation |
|----------|-----------------|----------------|
| 6-7 char brute force running | 2-4 | "Scale to 8 workers - will cut remaining time in half" |
| Heavy rules on large hashlist | 4 | "Add 4 more workers - rules benefit from parallelization" |
| Multiple hash types pending | 4 | "Scale to 8+ workers to process hash types in parallel" |
| Wordlist attacks only | 4+ | No benefit - I/O bound, not CPU bound |
| 8+ char brute force | Any | Diminishing returns - focus on rules instead |

**Calculation guidance:**
- MD5/NTLM brute force: Each worker adds ~1B hashes/sec (CPU)
- SHA512crypt: Much slower (~10K/sec) - more workers help significantly
- 7-char keyspace (62^7): ~3.5 trillion - with 4 workers at 4B/sec = ~15 min
- 8-char keyspace (62^8): ~218 trillion - 4 workers = ~15 hours

**Example recommendation:**
> "We have 2 remaining hashes. One is 7-char brute forceable - with current 4 workers this will complete in ~20 minutes. The 11-char password needs rules. **Recommend: Stay at 4 workers** - scaling won't significantly help the rules attack, and the brute force will finish soon."

### Intelligent Task Prioritization (PAI Enhancement)

Hashtopolis uses static priority numbers. PAI should dynamically evaluate and reprioritize tasks based on value proposition:

**Task Value Formula:**
```
Value = (Probability of Success × Hashes Remaining) / Time to Complete
```

**Priority Guidelines:**
| Task Type | Value Proposition | Recommended Priority |
|-----------|-------------------|---------------------|
| Exhaustive BF (6-7 char) | Guaranteed success if password is that length | HIGH - will definitively crack or eliminate |
| Wordlist (rockyou) | High probability, fast | HIGH - quick wins |
| Wordlist + common rules | Good probability, moderate time | MEDIUM-HIGH |
| Targeted masks (from hints) | Overfitted, narrow applicability | LOW - don't chase single passwords |
| Long BF (8+ char) | Very low probability in 24h | LOW - only if time permits |

**Avoid Overfitting:**
- Don't create masks based on known/cracked passwords (that's cheating)
- Generic patterns (word+digits, l33t speak) are OK
- Specific patterns (J@son-style) waste compute on unlikely matches

**Reprioritization During Audit:**
```bash
# Lower priority of overfitted tasks
sudo docker exec hashtopolis-db mysql -u hashtopolis -p<password> -e "
UPDATE hashtopolis.Task SET priority = 50 WHERE taskName LIKE '%pattern%';
UPDATE hashtopolis.TaskWrapper SET priority = 50 WHERE taskWrapperId IN
  (SELECT taskWrapperId FROM Task WHERE taskName LIKE '%pattern%');
"
```

**PAI should proactively:**
1. Review running tasks every 30 min
2. Identify overfitted/low-value tasks consuming agents
3. Suggest reprioritization to user
4. Focus compute on exhaustive searches that eliminate possibilities

## User Verification Workflow (MANDATORY)

**Before destroying workers**, the user MUST have an opportunity to inspect results in the Hashtopolis UI. Follow this sequence:

### Step 1: Provide Login Credentials
After cracking completes, provide the user with:
```
Hashtopolis UI: http://<SERVER_IP>:8080
Username: hashcrack
Password: Hashcrack2025Lab
```

**IMPORTANT:** Credentials are defined in `terraform.tfvars`. Always use these known values, NOT randomly generated passwords that may fail due to cloud-init escaping issues.

### Step 2: Pre-Login Password Verification (MANDATORY)
Before giving credentials to the user, **verify they work**:

```bash
# Test login - must see "agents.php" NOT "Wrong username/password"
ssh ubuntu@<SERVER_IP> 'curl -s -c /tmp/c.txt http://localhost:8080/ > /dev/null && \
  curl -s -c /tmp/c.txt -b /tmp/c.txt -L -X POST \
  -d "username=hashcrack&password=Hashcrack2025Lab&fw=" \
  http://localhost:8080/login.php | grep -qE "agents\.php" && echo "LOGIN OK" || echo "LOGIN FAILED"'
```

If login fails, reset the password via PHP script (see LEARNINGS.md for the procedure).

### Step 3: User Inspection
Wait for user confirmation that they:
- Logged into Hashtopolis UI
- Viewed cracked passwords (Lists → Show Cracked)
- Saved/exported any results they need

### Step 4: Staged Teardown
Only after user confirms satisfaction:
1. First destroy workers (user approves)
2. Then destroy server (user approves)

**Never skip user verification.** The user may want to download potfiles, run additional attacks, or examine specific hashes.

## Security

- **NEVER display cracked passwords in terminal**
- Results written to `.claude/.env` as `HASHCRACK_RESULTS_<timestamp>`
- User must log into Hashtopolis UI to view actual passwords
- All jobs logged to `History/` for audit compliance
- Display authorization warning before processing

## Environment Variables

```bash
# XenOrchestra credentials
XO_HOST=192.168.99.206
XO_USER=admin
XO_PASSWORD=<password>
SSH_PUBLIC_KEY=ssh-ed25519 AAAA... user@host

# Hashtopolis (set after deployment)
# IMPORTANT: Use HTTP, not HTTPS
HASHCRACK_SERVER_URL=http://<server_ip>:8080
HASHCRACK_ADMIN_USER=hashcrack
HASHCRACK_ADMIN_PASSWORD=<generated>
HASHCRACK_API_KEY=<create via DB or UI>
HASHCRACK_VOUCHER=<from terraform output>
```

### Creating API Key
API keys must be created manually after deployment:
```sql
-- Via database
INSERT INTO ApiKey (startValid, endValid, accessKey, accessCount, userId, apiGroupId)
VALUES (0, 9999999999, 'PAI_<random_hex>', 0, 1, 1);
```

## Reference Documentation

- **Official Docs**: https://docs.hashtopolis.org/
- **GitHub Wiki**: https://github.com/hashtopolis/server/wiki
- `HashtopolisAPI.md` - REST API endpoints and authentication
- `AttackStrategies.md` - Detailed attack configurations and hash types

## John the Ripper Integration

For hash types not supported by hashcat (like yescrypt), the skill automatically routes to John the Ripper.

### Automatic Routing

When processing a shadow file with mixed hash types:
```
ubuntu:$6$...:...   → Hashtopolis (distributed)
alpha:$y$...:...    → John the Ripper (local)
```

### Installation

```bash
# Ubuntu/Debian
sudo apt install john

# macOS
brew install john

# Windows
# Download from https://www.openwall.com/john/
```

### Manual Usage

```bash
# Check if John is available
bun JohnClient.ts check

# Crack yescrypt hashes
bun JohnClient.ts crack shadow.txt --format crypt

# Show results
bun JohnClient.ts show shadow.txt
```

**Limitation**: John runs locally, not distributed. For large yescrypt hash lists, consider dedicated GPU hardware.

## CLI Tools

| Tool | Purpose |
|------|---------|
| `HashcrackCLI.ts` | Main orchestrator - deploy, crack, status, wordlist, teardown |
| `HashtopolisClient.ts` | Hashtopolis REST API client library |
| `InputParsers.ts` | Credential format parsers (shadow, SAM, NTDS, pwdump) |
| `CustomWordlist.ts` | Custom password list manager |
| `JohnClient.ts` | John the Ripper integration for yescrypt/scrypt |
| `CreateTemplate.ts` | Ubuntu template creation for XCP-ng |

## Infrastructure

- **Server**: Ubuntu 24.04 LTS, Docker Compose (Hashtopolis containers)
- **Workers**: Ubuntu 24.04 LTS, hashcat + Hashtopolis agent
- **Provisioning**: Terraform (XenOrchestra provider)
- **Configuration**: Cloud-init (embedded in terraform)

## Deployment Timing Metrics

Key SLAs for password audit planning:

| Milestone | Target Time | Notes |
|-----------|-------------|-------|
| Server VM created | ~1 min | Terraform provision |
| Server up + Hashtopolis ready | ~5-7 min | Docker pull + compose up |
| First worker VM created | ~1 min | Parallel with server |
| First agent registered | ~3-5 min | Cloud-init + agent install |
| All agents ready (4 workers) | ~5-8 min | Parallel cloud-init |
| First task dispatched | Immediate | After agent trusted |

**Bottlenecks:**
- Cloud-init `package_upgrade: true` adds 2-3 minutes
- Docker image pulls on server add 2-3 minutes
- Agent registration depends on server being ready

**Optimization opportunities:**
- Pre-bake Ubuntu template with hashcat installed
- Use local Docker registry for Hashtopolis images
- Reduce cloud-init to minimal configuration

## Cloud-Init Best Practices

### Worker Cloud-Init Optimization

**Current approach** (slower but reliable):
```yaml
package_update: true
package_upgrade: true
packages:
  - hashcat
  - python3-requests
  ...
```

**Faster approach** (pre-bake template):
1. Create Ubuntu template with hashcat pre-installed
2. Cloud-init only configures agent + registers
3. Reduces boot-to-ready time to ~2 minutes

### Agent Configuration Pitfalls

**Common cloud-init variable issues:**
| Symptom | Cause | Fix |
|---------|-------|-----|
| `HASHTOPOLIS_SERVER` in config | Variable not interpolated | Use terraform `templatefile()` |
| `http://https://...` | Double protocol | Pass just IP, add protocol in template |
| Agent fails silently | Wrong server URL | Check `/opt/hashtopolis-agent/config.json` |

**Correct terraform → cloud-init flow:**
```hcl
# workers.tf
server_url = xenorchestra_vm.hashtopolis_server.ipv4_addresses[0]  # Just IP

# worker.yaml
"url": "http://${server_url}:8080/api/server.php"  # Add protocol + port
```

## Critical Setup Requirements

### Correct Order of Operations for Secret Data

**The secure approach**: Keep files and hashlists as secret (default), and trust agents to access them.

```
1. Deploy infrastructure (server + workers)
2. Wait for agents to register with server
3. TRUST AGENTS FIRST (before creating tasks!)
4. Upload wordlists/rules (they will be secret by default - this is OK)
5. Create hashlists (they will be secret by default - this is OK)
6. Create tasks with PRIORITY >= 10 (not 0!)
7. Agents will now receive and process tasks
```

### Step-by-Step Configuration

**1. Wait for Agents to Register** (2-5 minutes after deploy)
```bash
# Check agents via API
curl -X POST http://SERVER:8080/api/user.php \
  -H 'Content-Type: application/json' \
  -d '{"section":"agent","request":"listAgents","accessKey":"YOUR_KEY"}'
```

**2. Trust All Agents** (CRITICAL - do this BEFORE uploading files!)
```bash
# Via API (for each agent)
curl -X POST http://SERVER:8080/api/user.php \
  -H 'Content-Type: application/json' \
  -d '{"section":"agent","request":"setTrusted","accessKey":"YOUR_KEY","agentId":1,"trusted":true}'

# Or via database (trust all at once)
sudo docker exec hashtopolis-db mysql -u hashtopolis -p<password> \
  -e "UPDATE hashtopolis.Agent SET isTrusted = 1;"
```

**3. Upload Wordlists** (they will be secret - trusted agents can access)
```bash
# Via API - file will be secret by default, which is correct
curl -X POST http://SERVER:8080/api/user.php \
  -H 'Content-Type: application/json' \
  -d '{"section":"file","request":"addFile","accessKey":"YOUR_KEY",...}'

# Verify file was written to disk
sudo docker exec hashtopolis-backend ls -la /var/www/hashtopolis/files/
```

**4. Create Hashlist** (will be secret by default - trusted agents can access)

**5. Create Task with Priority >= 10**
```bash
# IMPORTANT: Set priority to 10 or higher, NOT 0
curl -X POST http://SERVER:8080/api/user.php \
  -H 'Content-Type: application/json' \
  -d '{
    "section":"task",
    "request":"createTask",
    "accessKey":"YOUR_KEY",
    "name":"Wordlist Attack",
    "hashlistId":1,
    "attackCmd":"#HL# -a 0 rockyou.txt",
    "priority":10,
    ...
  }'
```

### Why This Order Matters

- **Files/hashlists default to secret** - this is the secure design
- **Agents default to untrusted** - they cannot access secrets
- **If you upload files BEFORE trusting agents**, tasks won't dispatch
- **If task priority is 0**, tasks may not be picked up
- **Trust agents FIRST**, then everything else works automatically

## Known Issues & Workarounds

### Docker Images (IMPORTANT)
- **Use `hashtopolis/backend` + `hashtopolis/frontend`** (NOT `hashtopolis/server`)
- The old `hashtopolis/server` image does not exist
- Environment variables for backend:
  - `HASHTOPOLIS_DB_HOST`, `HASHTOPOLIS_DB_USER`, `HASHTOPOLIS_DB_PASS`, `HASHTOPOLIS_DB_DATABASE`
  - `HASHTOPOLIS_ADMIN_USER`, `HASHTOPOLIS_ADMIN_PASSWORD`
  - `HASHTOPOLIS_APIV2_ENABLE: 0` (disable broken API v2)

### API Version
- **Use API v1** (`/api/user.php`), NOT API v2
- API v2 returns 500 errors in Hashtopolis 0.14.x - routes not implemented
- API v1 uses `accessKey` in request body for authentication

### API Parameter Gotchas
| Endpoint | Required Parameter | Notes |
|----------|-------------------|-------|
| `createHashlist` | `isSecret` | Required field. Let it be `true` (secret) - trust agents instead |
| `addFile` | - | Defaults to secret. Trust agents rather than trying to set `isSecret:false` |
| `setTrusted` | `trusted: true` | NOT `isTrusted`. Request is `setTrusted`, NOT `setAgentTrusted` |
| `createTask` | `priority: 10` | Must be >= 10, NOT 0. Priority 0 may prevent task dispatch |

**Best Practice**: Don't fight the secret defaults. Trust your agents first, then secrets work automatically.

### Server URL
- Use **HTTP** not HTTPS: `http://SERVER_IP:8080`
- HTTPS requires valid certificates which cloud-init doesn't set up
- **Always use port 8080** (classic PHP UI) - the Angular frontend on 4200 requires API v2 which is broken
- When user asks to "log in to Hashtopolis", provide: `http://SERVER_IP:8080`

### Agent Setup
1. **Download**: Use tar.gz from GitHub, not zip
   - URL: `https://github.com/hashtopolis/agent-python/archive/refs/tags/v0.7.4.tar.gz`
   - Extract with `tar xzf agent.tar.gz --strip-components=1`
2. **Entry point**: `python3 __main__.py` (NOT `hashtopolis.zip`)
3. **Dependencies**: `requests`, `psutil` - install system-wide for root service
   - `pip3 install requests psutil --break-system-packages`
4. **Config**: Use HTTP in URL, e.g., `http://SERVER_IP:8080/api/server.php`

### Agent Stability
- Use systemd service with `Restart=always` and `RestartSec=30`
- WorkingDirectory must be `/opt/hashtopolis-agent`
- Run as root to avoid permission issues with hashcat

### Python RecursionError Fix (Ubuntu 24.04 / Python 3.12) - MUST ADD TO CLOUD-INIT

The Hashtopolis Python agent can hit `RecursionError: maximum recursion depth exceeded` during HTTP requests on Python 3.12. This is a cookiejar bug triggered during agent registration.

**Symptoms:**
```
File "/usr/lib/python3.12/http/cookiejar.py", line 642, in eff_request_host
    erhn = req_host = request_host(request)
RecursionError: maximum recursion depth exceeded
```

**CRITICAL: Include this in cloud-init for ALL providers to prevent this issue during build!**

**Fix:** Increase Python recursion limit in systemd service (add to worker cloud-init):
```bash
# Update /etc/systemd/system/hashtopolis-agent.service
[Service]
Type=simple
User=root
WorkingDirectory=/opt/hashtopolis-agent
ExecStart=/usr/bin/python3 -c "import sys; sys.setrecursionlimit(5000); exec(open('__main__.py').read())"
Restart=always
RestartSec=30
```

**Or manually apply fix:**
```bash
ssh ubuntu@WORKER_IP 'sudo bash -c "
cat > /etc/systemd/system/hashtopolis-agent.service << EOF
[Unit]
Description=Hashtopolis Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/hashtopolis-agent
ExecStart=/usr/bin/python3 -c \"import sys; sys.setrecursionlimit(5000); exec(open(chr(95)+chr(95)+chr(109)+chr(97)+chr(105)+chr(110)+chr(95)+chr(95)+chr(46)+chr(112)+chr(121)).read())\"
Restart=always
RestartSec=30

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl restart hashtopolis-agent
"'
```

**Why this works:** Python's default recursion limit (1000) is too low for the complex call stack in cookiejar.py when processing certain HTTP requests. Setting it to 5000 provides sufficient headroom.

### SSH Access
- Use `ubuntu` user, NOT `pai`
- Cloud-init creates `ubuntu` user with sudo access

### Password Authentication (IMPORTANT)

Hashtopolis uses **PEPPER + password + salt** for password hashing, NOT plain bcrypt. When setting passwords:

**Wrong approach (fails login):**
```php
$hash = password_hash("mypassword", PASSWORD_BCRYPT);  // WRONG!
```

**Correct approach:**
```bash
# Create a PHP script on the server
ssh ubuntu@SERVER 'cat > /tmp/set_password.php << '\''PHPEOF'\''
<?php
$config = json_decode(file_get_contents("/usr/local/share/hashtopolis/config/config.json"), true);
$PEPPER = $config["PEPPER"];

$pdo = new PDO("mysql:host=hashtopolis-db;dbname=hashtopolis", "hashtopolis", "DB_PASSWORD");
$stmt = $pdo->query("SELECT passwordSalt FROM User WHERE userId = 1");
$salt = $stmt->fetch()["passwordSalt"];

$password = "newpassword123";
$CIPHER = $PEPPER[1] . $password . $salt;
$hash = password_hash($CIPHER, PASSWORD_BCRYPT, ["cost" => 12]);

$stmt = $pdo->prepare("UPDATE User SET passwordHash = ? WHERE userId = 1");
$stmt->execute([$hash]);
echo "Password updated!\n";
PHPEOF
sudo docker cp /tmp/set_password.php hashtopolis-backend:/tmp/set_password.php
sudo docker exec hashtopolis-backend php /tmp/set_password.php'
```

**Where PEPPER is stored:** `/usr/local/share/hashtopolis/config/config.json`

**Password structure:**
- `PEPPER[1]` (32 char random string) + `password` + `passwordSalt` (from User table)
- Hashed with bcrypt cost 12

**ALWAYS test credentials before providing to user:**
```bash
# Test login via curl - must see "agents.php" in response, NOT "Wrong username/password"
curl -s -c /tmp/cookies.txt http://SERVER:8080/index.php > /dev/null
curl -s -c /tmp/cookies.txt -b /tmp/cookies.txt -L -X POST \
  -d "username=hashcrack&password=mypassword&fw=" \
  http://SERVER:8080/login.php | grep -E "(agents\.php|Wrong)"
```

### Database Access
- Password is in container env, not hardcoded
- Get password: `sudo docker exec hashtopolis-db env | grep MYSQL_PASSWORD`

### Task Creation
- **Do NOT insert tasks directly into database** - bypasses proper initialization
- Use API for task creation (agents won't pick up DB-inserted tasks)
- TaskWrapper connects tasks to hashlists in Hashtopolis 0.14.x
- Keyspace must be calculated before chunks can be dispatched

### Task Dispatch Issues
If agents report "No task available!" but tasks exist:

1. **Trust agents first** - most common issue
   ```bash
   sudo docker exec hashtopolis-db mysql -u hashtopolis -p<password> \
     -e "UPDATE hashtopolis.Agent SET isTrusted = 1;"
   ```

2. **Check task priority** - must be >= 10, not 0
   ```sql
   SELECT taskId, taskName, priority FROM Task;
   -- If priority is 0, tasks won't dispatch
   ```

3. **Check TaskWrapper priority** - also must be > 0
   ```sql
   UPDATE TaskWrapper SET priority=100 WHERE priority=0;
   ```

4. **Verify agent is in correct AccessGroup** (usually auto-assigned to group 1)

5. **Do NOT manually insert into Assignment table** - this is an anti-pattern

6. **Check for stale agents after worker deletion** - CRITICAL

   When workers are destroyed/rebuilt, their old agent entries remain in the database. These stale agents:
   - Get assigned chunks but can't complete them
   - Show `speed: 0` in task details
   - Cause `workPossible: false` on tasks
   - Block real workers from getting work

   **Detection:**
   ```bash
   # Check for duplicate agent names or agents with 0 speed
   sudo docker exec hashtopolis-db mysql -u hashtopolis -p<password> -e "
   SELECT agentId, agentName, isActive, lastTime FROM hashtopolis.Agent;
   "
   # Look for: duplicate names, old lastTime, or agents that don't match running workers
   ```

   **Fix:**
   ```bash
   # Deactivate stale agent, reset chunks, AND remove task assignments
   sudo docker exec hashtopolis-db mysql -u hashtopolis -p<password> -e "
   -- Reset chunks assigned to stale agent
   UPDATE hashtopolis.Chunk SET state = 0, agentId = NULL WHERE agentId = STALE_ID AND state IN (2, 4);
   -- Remove task assignments (this clears the agent count in UI)
   DELETE FROM hashtopolis.Assignment WHERE agentId = STALE_ID;
   -- Deactivate stale agent
   UPDATE hashtopolis.Agent SET isActive = 0 WHERE agentId = STALE_ID;
   "
   ```

   **Best practice:** After destroying workers, ALWAYS check for and deactivate stale agents before continuing.

### File Upload - CRITICAL DISCOVERY

**Files MUST be uploaded via API with `source: inline`**. Manually placing files in the container does NOT work - the server returns "ERR3 - file not present" even though files exist on disk.

**Working approach:**
```python
import base64
import requests

# Read file and base64 encode
with open('wordlist.txt', 'rb') as f:
    data = base64.b64encode(f.read()).decode('utf-8')

# Upload via API
payload = {
    'section': 'file',
    'request': 'addFile',
    'accessKey': 'YOUR_KEY',
    'filename': 'wordlist.txt',
    'fileType': 0,  # 0=wordlist, 1=rule
    'source': 'inline',
    'accessGroupId': 1,
    'data': data,
    'isSecret': False
}
resp = requests.post('http://SERVER:8080/api/user.php', json=payload)
```

**For large files (>50MB):** Split into chunks and upload separately:
```bash
# Split rockyou.txt into 500k line chunks
head -500000 rockyou.txt > rockyou_chunk1.txt
tail -n +500001 rockyou.txt | head -500000 > rockyou_chunk2.txt
# Upload each chunk via API, then create separate tasks for each
```

**Why manual file placement fails:**
- Hashtopolis stores files by internal metadata, not just filesystem path
- API upload triggers proper registration with database
- Files placed via `docker cp` don't have required metadata

### CPU-Only Workers

Workers without GPU support need special configuration:

```sql
-- Workers auto-detect as cpuOnly=1 when no GPU found
-- Tasks must have isCpuTask=1 to be dispatched to CPU-only workers
UPDATE Task SET isCpuTask = 1 WHERE taskId IN (1, 2, 3);
```

**Cloud-init installs PoCL (Portable OpenCL)** for CPU-based hashcat:
- `ocl-icd-libopencl1` and `opencl-headers` packages
- Hashcat uses CPU cores via OpenCL backend
- Typical speed: ~35 MH/s for MD5 on modern CPU

### Agent Activation Issues

Agents may become inactive during operation. Check and fix:

```sql
-- Check agent status
SELECT agentId, agentName, isActive, isTrusted FROM Agent;

-- Reactivate inactive agents
UPDATE Agent SET isActive = 1 WHERE isActive = 0;
```

**Signs of inactive agent:**
- "No task available!" in agent logs despite pending tasks
- Agent's `lastAct` timestamp not updating
- Tasks with high priority not being picked up

### Task Queue Management (CRITICAL for Cloud)

**Keep tasks queued** - agents become inactive when no valid tasks available. In cloud environments, idle workers = wasted cost.

**Why agents report "No task available!" despite pending tasks:**
1. **Agent inactive** - Check and reactivate: `UPDATE Agent SET isActive = 1`
2. **Agent untrusted** - Trust the agent: `UPDATE Agent SET isTrusted = 1`
3. **Task files broken** - File references created via `import` don't work
4. **Task priority = 0** - Tasks must have priority > 0
5. **crackerBinaryId NULL** - Must be set to valid cracker binary ID

**Database task creation with all required fields:**
```sql
INSERT INTO TaskWrapper (priority, maxAgents, taskType, hashlistId, accessGroupId, taskWrapperName, isArchived, cracked)
VALUES (80, 0, 0, 1, 1, 'TaskName', 0, 0);
SET @tw = LAST_INSERT_ID();

INSERT INTO Task (
  taskName, attackCmd, chunkTime, statusTimer, keyspace, keyspaceProgress,
  priority, maxAgents, color, isSmall, isCpuTask, useNewBench, skipKeyspace,
  crackerBinaryId, crackerBinaryTypeId, taskWrapperId, isArchived, notes,
  staticChunks, chunkSize, forcePipe, usePreprocessor, preprocessorCommand
)
VALUES (
  'TaskName', '#HL# -a 3 ?l?l?l?l?l?l', 600, 5, 0, 0,
  80, 0, '#FF6600', 1, 1, 0, 0,
  1, 1, @tw, 0, '',
  0, 0, 0, 0, ''
);
```

**Key fields that cause "Invalid query!" if missing:**
- `useNewBench` - Set to 0
- `crackerBinaryId` - Set to 1 (hashcat)
- `notes`, `preprocessorCommand` - Empty string, not NULL

**Monitoring worker utilization:**
- Check CPU usage on worker VM (should be maxed during cracking)
- Check via XCP-ng/hypervisor for host-level stats
- Idle workers = wasted resources in cloud environments

### Start Simple - Avoid Supertasks Initially
**Recommendation**: Use basic tasks until the workflow is reliable, then introduce advanced features.

| Feature | Complexity | Recommendation |
|---------|------------|----------------|
| Basic Task | Simple | ✅ Start here |
| Pretask | Medium | Add after basics work |
| Supertask | Advanced | Only after pretasks work |

**Simple task creation pattern:**
```bash
# Create task directly linked to hashlist
curl -X POST http://SERVER:8080/api/user.php \
  -H 'Content-Type: application/json' \
  -d '{
    "section":"task",
    "request":"createTask",
    "accessKey":"YOUR_KEY",
    "name":"MD5-Wordlist",
    "hashlistId":1,
    "attackCmd":"#HL# -a 0 rockyou.txt",
    "chunkTime":600,
    "statusTimer":5,
    "priority":10,
    "maxAgents":0,
    "isCpuTask":false,
    "isSmall":true,
    "crackerBinaryId":1,
    "crackerBinaryTypeId":1
  }'
```

### API Limitations Discovered
1. **`runPretask`** - Does NOT exist as an API endpoint
2. **`importSupertask`** - Requires many undocumented params (isCpuOnly, isSmall, masks)
3. **File references** - Stored by fileId (integer), not filename on disk
4. **Keyspace calculation** - Must happen via agent benchmark before task dispatch

### Why Direct Database Access is Sometimes Needed

The Hashtopolis API v1 doesn't support all operations. Database access is required for:

| Operation | API Support | Database Alternative |
|-----------|-------------|---------------------|
| Create API key | ❌ No | `INSERT INTO ApiKey (...)` |
| Create voucher | Limited | `INSERT INTO RegVoucher (voucher, time)` |
| Bulk trust agents | ❌ No | `UPDATE Agent SET isTrusted = 1` |
| Create tasks with files | ❌ Error | Insert TaskWrapper + Task + FileTask |
| Check detailed status | Limited | Query Task, TaskWrapper, Chunk tables |
| Fix stuck tasks | ❌ No | Update Chunk states, reset keyspaceProgress |

**Pattern for task creation via database:**
```sql
-- 1. Create TaskWrapper (links to hashlist)
INSERT INTO TaskWrapper (priority, maxAgents, taskType, hashlistId, accessGroupId, taskWrapperName, isArchived, cracked)
VALUES (100, 0, 0, 1, 1, 'MyTask', 0, 0);
SET @wrapper = LAST_INSERT_ID();

-- 2. Create Task (the actual job)
INSERT INTO Task (taskName, attackCmd, ..., taskWrapperId, isCpuTask, ...)
VALUES ('MyTask', '#HL# wordlist.txt', ..., @wrapper, 1, ...);
SET @task = LAST_INSERT_ID();

-- 3. Link files to task
INSERT INTO FileTask (fileId, taskId) VALUES (5, @task);
```

**When to use API vs Database:**
- ✅ **API**: File uploads, hashlist creation, status queries
- ✅ **Database**: Task creation with file links, bulk operations, recovery

### Database Patterns for Recovery
```sql
-- Check all file references
SELECT f.fileId, f.filename, f.isSecret, ft.taskId
FROM File f LEFT JOIN FileTask ft ON f.fileId = ft.fileId;

-- Check task wrapper to task mapping
SELECT tw.taskWrapperId, tw.hashlistId, tw.priority, t.taskId, t.taskName
FROM TaskWrapper tw LEFT JOIN Task t ON tw.taskWrapperId = t.taskWrapperId;

-- Check chunk states (0=NEW, 4=ABORTED, 5=FINISHED)
SELECT chunkId, taskId, state, agentId, progress
FROM Chunk ORDER BY chunkId DESC LIMIT 10;

-- Find stuck/orphaned tasks
SELECT taskId, taskName, keyspace, keyspaceProgress, priority
FROM Task WHERE keyspaceProgress < keyspace AND keyspace > 0;
```

## Examples

### Crack Linux shadow file (auto-detected)
```bash
hashcrack crack --input /etc/shadow
# Detected format: shadow
# Hash type: sha512crypt (1800)
# Parsed 42 valid hashes, skipped 3 disabled accounts
```

### Crack Windows domain dump (secretsdump output)
```bash
hashcrack crack --input ntds.dit.ntds
# Detected format: secretsdump
# Hash type: ntlm (1000)
# Parsed 15,847 valid hashes
```

### Crack SAM dump (pwdump format)
```bash
hashcrack crack --input sam_dump.txt
# Detected format: pwdump
# Hash type: ntlm (1000)
```

### Pipe credentials directly
```bash
cat /extracted/shadow | hashcrack crack
cat pwdump.txt | hashcrack crack
```

### Custom wordlist management
```bash
# View stats
hashcrack wordlist stats

# Import from potfile
hashcrack wordlist import /path/to/hashcat.potfile

# Skip custom wordlist for this job
hashcrack crack --input hashes.txt --skip-custom
```

### Scale up workers for faster cracking
```bash
hashcrack scale --workers 20
```

### Check job progress
```bash
hashcrack status
# Output: Job 42% complete | 12,847/30,000 cracked | Speed: 1.2 GH/s
```

### View and save results
```bash
hashcrack results
# Cracked: 847 passwords
# Custom Wordlist: 234 novel passwords added
```

## Operational Lessons Learned

### Scaling Workers Safely

**NEVER destroy working workers when fixing broken ones.**

```bash
# BAD: Destroys ALL workers including working ones
terraform apply -var="worker_count=0" -auto-approve  # DON'T DO THIS

# GOOD: Taint only the broken workers, then apply
terraform taint 'xenorchestra_vm.workers[1]'  # Broken worker
terraform taint 'xenorchestra_vm.workers[2]'  # Broken worker
terraform apply -var="worker_count=4" -auto-approve  # Recreates only tainted

# ALTERNATIVE: SSH and fix the agent directly
ssh ubuntu@BROKEN_WORKER_IP 'sudo systemctl restart hashtopolis-agent'
```

### Agent Troubleshooting Checklist

When an agent stops working or reports "No task available!":

1. **Check agent is registered and trusted**
   ```bash
   curl -X POST http://SERVER:8080/api/user.php \
     -H 'Content-Type: application/json' \
     -d '{"section":"agent","request":"listAgents","accessKey":"YOUR_KEY"}'
   ```

2. **Check agent service on worker**
   ```bash
   ssh ubuntu@WORKER_IP 'systemctl status hashtopolis-agent'
   ssh ubuntu@WORKER_IP 'journalctl -u hashtopolis-agent -n 50'
   ```

3. **Common agent issues and fixes**:
   | Symptom | Cause | Fix |
   |---------|-------|-----|
   | RecursionError in logs | Python logging recursion bug | Known Hashtopolis agent issue - agent may still work despite errors. Clear log: `rm /opt/hashtopolis-agent/client.log && systemctl restart hashtopolis-agent` |
   | "HASHTOPOLIS_SERVER" in config | Cloud-init variable not replaced | Fix config.json with correct URL |
   | Agent registered but inactive | No tasks with priority > 0 | Create tasks with high priority |
   | Agent not picking up tasks | Agent untrusted | Trust agent via API or database |

4. **Fix agent config directly**
   ```bash
   ssh ubuntu@WORKER_IP 'echo "{\"url\": \"http://SERVER:8080/api/server.php\", \"voucher\": \"VOUCHER\"}" | sudo tee /opt/hashtopolis-agent/config.json && sudo systemctl restart hashtopolis-agent'
   ```

### Voucher Management

When workers are destroyed and recreated, vouchers may be invalidated.

**Best practice: Pre-create reusable backup vouchers**
```sql
-- Create backup vouchers
INSERT INTO RegVoucher (voucher, time) VALUES
  ('PAI_BACKUP_1', UNIX_TIMESTAMP()),
  ('PAI_BACKUP_2', UNIX_TIMESTAMP()),
  ('PAI_BACKUP_3', UNIX_TIMESTAMP());

-- Disable voucher deletion (make them reusable)
UPDATE Config SET value = '0' WHERE item = 'voucherDeletion';
```

**Pros of reusable vouchers:**
- No need to create new ones when rebuilding workers
- Simpler recovery from failures
- Pre-created backups available for emergencies

**Cons of reusable vouchers:**
- Security risk if voucher is leaked
- Anyone with voucher can register agents
- Less audit trail

**Recovery when voucher is missing:**
```bash
# 1. Create new voucher in database
ssh ubuntu@SERVER 'sudo docker exec hashtopolis-db mysql -u hashtopolis -p<password> \
  -e "INSERT INTO RegVoucher (voucher, time) VALUES (\"NEW_VOUCHER\", UNIX_TIMESTAMP());"'

# 2. Update all workers with new voucher
for ip in WORKER_IPS; do
  ssh ubuntu@$ip 'echo "{\"url\": \"http://SERVER:8080/api/server.php\", \"voucher\": \"NEW_VOUCHER\"}" | sudo tee /opt/hashtopolis-agent/config.json && sudo systemctl restart hashtopolis-agent'
done
```

### Recovering from Destroyed Workers

When a worker is destroyed while tasks are running, chunks become orphaned:

**Chunk states:**
- 0 = PENDING (ready to dispatch)
- 2 = DISPATCHED (running on agent)
- 4 = ABORTED (agent died mid-task)
- 5 = FINISHED (completed)
- 6 = SKIPPED

**Recovery procedure:**
```sql
-- Reset stuck/dispatched chunks (were running on destroyed worker)
UPDATE Chunk SET state = 0, agentId = NULL WHERE state = 2;

-- Reset aborted chunks (agent died before completing)
UPDATE Chunk SET state = 0, agentId = NULL WHERE state = 4;

-- Verify all chunks can be re-dispatched
SELECT state, COUNT(*) as count FROM Chunk GROUP BY state;
```

**Why this happens:**
- Worker destruction doesn't gracefully disconnect agent
- Chunks assigned to agent remain in DISPATCHED state
- New agents won't pick up chunks assigned to old agent
- Must manually reset to PENDING for re-dispatch

### XCP-ng Scaling Errors

When creating multiple VMs simultaneously, XCP-ng may throw errors:

| Error | Meaning | Solution |
|-------|---------|----------|
| `TOO_MANY_STORAGE_MIGRATES(3)` | Too many concurrent disk operations | Wait and retry `terraform apply` |
| VM creation timeout | Host overloaded | Reduce parallel creates, retry |

**Best practice**: Create workers in batches of 3-4, wait for completion, then add more.

### Keeping Workers Productive

**24-hour password audit workflow:**

1. Deploy initial workers (4-8)
2. Submit hashlist and first wave of tasks
3. Monitor progress every 15-30 minutes
4. When tasks complete, add new attack strategies
5. Scale workers based on remaining keyspace
6. **Never let workers idle** - queue multiple task types

**Task priority strategy:**
- Quick wins first (wordlists, common masks): Priority 100+
- Medium effort (rules, combinator): Priority 80-99
- Long running (brute force): Priority 60-79
- Background (exhaustive): Priority 40-59

## Cloud Provider Roadmap

### Current: XCP-ng (Local)
- Terraform with XenOrchestra provider
- Cloud-init for VM configuration
- Learned: recursion limits, voucher management, stale agents

### Next: AWS
**Prerequisites:**
- AWS account with programmatic access
- IAM user/role with EC2, VPC permissions
- Terraform AWS provider configuration

**Expected changes:**
- Replace XenOrchestra provider with AWS provider
- Use EC2 instances (t3.medium for server, c5.large+ for workers)
- VPC + security groups instead of XCP-ng network
- Consider Spot instances for workers (cost savings)
- S3 for wordlist storage (optional)

**Authentication setup needed:**
```bash
# Option 1: Environment variables
export AWS_ACCESS_KEY_ID="..."
export AWS_SECRET_ACCESS_KEY="..."
export AWS_DEFAULT_REGION="us-east-1"

# Option 2: AWS credentials file
aws configure

# Option 3: IAM role (if running on EC2)
# Automatic via instance metadata
```

### Azure (Ready)
**Terraform:** `terraform/azure/`

**Instance Types:**
| Role | VM Size | Specs | Cost/hr (approx) |
|------|---------|-------|------------------|
| Server | Standard_B2s | 2 vCPU, 4 GB | $0.042 |
| CPU Worker | Standard_F4s_v2 | 4 vCPU, 8 GB | $0.17 |
| GPU Worker | Standard_NC4as_T4_v3 | 4 vCPU, Tesla T4 | $0.53 |

**Deployment:**
```bash
cd terraform/azure
# Edit terraform.tfvars with your config
terraform init
terraform plan
terraform apply
```

**Authentication:**
```bash
# Option 1: Azure CLI
az login

# Option 2: Service Principal
export ARM_CLIENT_ID="..."
export ARM_CLIENT_SECRET="..."
export ARM_TENANT_ID="..."
export ARM_SUBSCRIPTION_ID="..."
```

**Azure-Specific Notes:**
- Use `Standard_NC4as_T4_v3` for Tesla T4 GPU (similar to AWS g4dn.xlarge)
- Spot VMs available via `use_spot_instances = true`
- Resource group auto-created with project name

### GCP (Ready)
**Terraform:** `terraform/gcp/`

**Instance Types:**
| Role | Machine Type | Specs | Cost/hr (approx) |
|------|--------------|-------|------------------|
| Server | e2-medium | 2 vCPU, 4 GB | $0.034 |
| CPU Worker | c2-standard-4 | 4 vCPU, 16 GB | $0.188 |
| GPU Worker | n1-standard-4 + T4 | 4 vCPU, Tesla T4 | ~$0.45 |

**Deployment:**
```bash
cd terraform/gcp
# Edit terraform.tfvars with your GCP project ID and SSH key
terraform init
terraform plan
terraform apply
```

**Authentication:**
```bash
# Option 1: User credentials (development)
gcloud auth application-default login

# Option 2: Service account (production)
export GOOGLE_APPLICATION_CREDENTIALS="/path/to/service-account-key.json"
```

**GCP-Specific Notes:**
- Use `n1-standard-4` + `nvidia-tesla-t4` for GPU workers (GPU quota required)
- Preemptible VMs available via `use_preemptible = true` (~60-70% savings)
- GCP supports both ed25519 and RSA SSH keys
- Workers deploy with private IPs only (access via server as jump host)

### Cross-Cloud Considerations
| Concern | Solution |
|---------|----------|
| Cost control | Use spot/preemptible instances, auto-shutdown |
| Wordlist distribution | Pre-bake into AMI/image, or use object storage |
| Network latency | Workers and server in same region/zone |
| Authentication | Per-provider credentials in .env or terraform vars |

### Graceful Worker Scale-Down

**Never just destroy workers.** Proper scale-down sequence:

1. **Identify worker to remove** (lowest priority tasks, idle, or oldest)
2. **Stop dispatching new chunks** - Set agent inactive via API/DB
3. **Wait for current chunk to complete** - Monitor agent's assigned chunks
4. **Confirm chunk completion** - Verify state=5 (FINISHED) or state=0 (returned)
5. **Remove agent from assignments** - `DELETE FROM Assignment WHERE agentId = X`
6. **Deactivate agent** - `UPDATE Agent SET isActive = 0 WHERE agentId = X`
7. **Destroy worker VM** - Terraform or cloud API

```bash
# Graceful scale-down script pattern
AGENT_ID=5
WORKER_IP=192.168.99.X

# 1. Stop agent from taking new work
sudo docker exec hashtopolis-db mysql -u hashtopolis -p<pw> -e "
  UPDATE Agent SET isActive = 0 WHERE agentId = $AGENT_ID;"

# 2. Wait for current work to finish (check every 30s)
while true; do
  CHUNKS=$(sudo docker exec hashtopolis-db mysql -u hashtopolis -p<pw> -sN -e "
    SELECT COUNT(*) FROM Chunk WHERE agentId = $AGENT_ID AND state = 2;")
  [ "$CHUNKS" -eq 0 ] && break
  echo "Waiting for $CHUNKS chunks to complete..."
  sleep 30
done

# 3. Clean up
sudo docker exec hashtopolis-db mysql -u hashtopolis -p<pw> -e "
  DELETE FROM Assignment WHERE agentId = $AGENT_ID;"

# 4. Now safe to destroy worker
terraform destroy -target=xenorchestra_vm.workers[$INDEX]
```

### GPU vs CPU Worker Management

**Cloud unlocks GPU acceleration.** Manage mixed fleets intelligently:

| Hash Type | CPU Speed | GPU Speed | Recommendation |
|-----------|-----------|-----------|----------------|
| MD5 | ~35 MH/s | ~25 GH/s | GPU (700x faster) |
| NTLM | ~30 MH/s | ~20 GH/s | GPU (600x faster) |
| SHA512crypt | ~10 KH/s | ~500 KH/s | GPU (50x faster) |
| bcrypt | ~500 H/s | ~25 KH/s | GPU (50x faster) |

**Fleet transition strategy:**
1. Start with CPU workers (cheaper, faster to provision)
2. Run initial wordlist attacks (I/O bound, CPU fine)
3. When moving to brute force/rules, spin up GPU workers
4. Spin down CPU workers as GPU workers come online
5. Keep 1-2 CPU workers for light tasks (wordlist preprocessing)

**GPU instance types by provider:**
| Provider | Instance | GPU | Cost/hr (approx) |
|----------|----------|-----|------------------|
| AWS | g4dn.xlarge | T4 | $0.526 |
| AWS | p3.2xlarge | V100 | $3.06 |
| Azure | NC4as_T4_v3 | T4 | $0.526 |
| GCP | n1-standard-4 + T4 | T4 | $0.35 + $0.35 |

### Optimal Worker VM Sizing

**CPU Workers (wordlists, light rules):**
| Workload | vCPUs | RAM | Notes |
|----------|-------|-----|-------|
| Light | 2 | 4 GB | Wordlist attacks |
| Medium | 4 | 8 GB | Rules, combinator |
| Heavy | 8 | 16 GB | Heavy rules |

**GPU Workers (brute force, heavy rules):**
| Workload | vCPUs | RAM | GPU RAM | Notes |
|----------|-------|-----|---------|-------|
| Standard | 4 | 16 GB | 16 GB | T4, good balance |
| High-end | 8 | 32 GB | 32 GB | V100/A100, max speed |

**Key sizing insights:**
- Hashcat is GPU-bound, not CPU-bound (4 vCPUs sufficient for GPU worker)
- RAM needed for large wordlists (16GB minimum for rockyou + rules)
- GPU RAM limits mask complexity (longer masks need more VRAM)
- Network bandwidth matters for large file distribution

### Region Selection Strategy

**Cost optimization factors:**
| Factor | Impact | Strategy |
|--------|--------|----------|
| Spot pricing | 60-90% savings | Use spot for workers, on-demand for server |
| Regional pricing | 10-30% variance | Compare us-east-1, us-west-2, eu-west-1 |
| Data transfer | $0.01-0.09/GB | Keep workers in same region as server |
| GPU availability | Varies by region | Check spot capacity before selecting |

**Recommended regions by provider:**
| Provider | Primary | Backup | Notes |
|----------|---------|--------|-------|
| AWS | us-east-1 | us-west-2 | Best spot availability |
| Azure | eastus | westus2 | Lowest GPU pricing |
| GCP | us-central1 | us-east1 | Best preemptible capacity |

**Region selection checklist:**
1. Check spot/preemptible pricing for desired instance type
2. Verify GPU instance availability
3. Consider compliance (data residency requirements)
4. Check current spot capacity (AWS Spot Advisor)
5. Factor in your location (latency to manage infrastructure)

## Session Learnings Summary

Quick reference for operational knowledge gained:

### Infrastructure
- **Python 3.12 RecursionError**: Set `sys.setrecursionlimit(5000)` in systemd
- **Cloud-init variables**: Use terraform `templatefile()`, not string interpolation
- **Voucher management**: Disable deletion, create backups, track usage

### Agent Management
- **Stale agents after worker deletion**: Delete from Assignment table, reset Chunk table, deactivate Agent
- **Trust agents FIRST**: Before uploading files or creating tasks
- **Check duplicate names**: Old agents retain names after worker rebuild

### Task Prioritization
- **Exhaustive BF > targeted masks**: Guaranteed elimination is more valuable
- **Don't overfit**: Generic patterns OK, specific patterns waste compute
- **Task value = (Probability × Hashes) / Time**

### Chunk Recovery
```sql
-- Reset orphaned chunks
UPDATE Chunk SET state = 0, agentId = NULL WHERE state IN (2, 4);
-- Remove stale assignments
DELETE FROM Assignment WHERE agentId = STALE_ID;
```

### Multi-Hash Audits
- Load all hash types as separate hashlists
- After any crack, run cracked passwords against ALL hash types
- Password reuse catches ~30% additional cracks

## Legal Warning

This skill is for **authorized security testing only**. Before use:

1. Ensure you have written authorization to test the target systems
2. Document the scope and authorization
3. Use only on systems you own or have explicit permission to test

Unauthorized password cracking is illegal and unethical.
