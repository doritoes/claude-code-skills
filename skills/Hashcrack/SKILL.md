---
name: Hashcrack
description: Highly scalable distributed password hash cracking using Hashtopolis. USE WHEN user wants to crack password hashes OR user has hash dumps to process OR user needs distributed cracking OR user mentions hashtopolis. Deploys infrastructure to XCP-ng, manages workers dynamically, monitors progress, stores results securely in .env.
---

# Hashcrack Skill

Distributed password hash cracking using Hashtopolis as the orchestration layer. The core value is **scalability** - distribute work across many workers, from a handful of local VMs to hundreds of cloud instances.

---

## ⛔ MANDATORY READING ORDER (DO NOT SKIP)

**Before ANY operation, read files in this EXACT order:**

| Order | File | Why |
|-------|------|-----|
| 1 | This section | Understand narrow path constraints |
| 2 | `docs/PARALLELIZATION.md` | **CRITICAL:** How to scale with Hashtopolis |
| 3 | `learnings/ai-discipline.md` | Error classification system |
| 4 | `learnings/anti-patterns.md` | What NOT to do |
| 5 | Provider-specific workflow | `workflows/deploy-{provider}.md` |
| 6 | Attack workflow | `workflows/Crack.md` |

## ⛔ RULE ATTACK PARALLELIZATION WARNING

**READ THIS BEFORE ANY ATTACK:**

| Attack Type | Workers Active | What Happens |
|-------------|----------------|--------------|
| Straight (wordlist only) | **ALL workers** | Parallel chunking works |
| Mask (brute force) | **ALL workers** | Parallel chunking works |
| **Rule (wordlist+rules)** | **1 worker** | Only skip=0 chunk works |

**To parallelize rule attacks:** Split HASHES into multiple hashlists with separate tasks.
**See:** `docs/PARALLELIZATION.md` for detailed instructions.

**GATE SYSTEM:** Every major step has a GATE. Do not proceed until GATE passes.

---

## ⛔ THE NARROW PATH (FOLLOW EXACTLY)

### For ANY Deployment:
```
GATE 0: terraform state list | wc -l → MUST equal 0
        ↓ PASS? Continue. FAIL? Run terraform destroy first.

GATE 1: Provider credentials exported
        ↓ PASS? Continue. FAIL? Export from .env

GATE 2: terraform init → success
        ↓ PASS? Continue. FAIL? Check provider setup

GATE 3: terraform plan → no errors
        ↓ PASS? Continue. FAIL? Fix tfvars

GATE 4: terraform apply → resources created
        ↓ PASS? Continue. FAIL? Check error type (see ai-discipline.md)

GATE 5: Server SSH accessible
        ↓ PASS? Continue. FAIL? Wait MAX 2 min for boot

GATE 6: Docker containers running
        ↓ PASS? Continue. FAIL? Wait MAX 5 min for cloud-init

GATE 7: Login verified with curl test
        ↓ PASS? Continue. FAIL? Reset password with PHP script

GATE 8: Vouchers created (1 per worker)
        ↓ PASS? Continue. FAIL? Create vouchers via SQL

GATE 9: Agents registered and trusted
        ↓ PASS? Continue. FAIL? Check worker cloud-init logs
```

### For ANY Task Creation:
```
GATE T1: Agents benchmarked → check Assignment table
         ↓ PASS? Check benchmark format. FAIL? Wait MAX 3 min

GATE T2: Benchmark format identified
         → Contains ":" → useNewBench=0
         → Number only → useNewBench=1
         ↓ MUST set correctly before task creation

GATE T3: Files staged with isSecret=1
         ↓ PASS? Continue. FAIL? Update File table

GATE T4: Task created with ALL required fields
         - crackerBinaryId != NULL
         - priority > 0
         - keyspace calculated (wordlist × rules for rule attacks)
         - useNewBench set correctly
         ↓ PASS? Continue. FAIL? Fix missing fields

GATE T5: First chunks verified (after 5 min)
         SELECT SUM(length)/keyspace FROM Chunk
         ↓ > 1%? PASS. < 1%? useNewBench is WRONG - flip it
```

### For ANY Teardown:
```
GATE D1: terraform state list | wc -l → Note count
         ↓ If 0: Nothing to destroy. If >0: Continue

GATE D2: Provider credentials exported
         ↓ PASS? Continue. FAIL? Export from .env first

GATE D3: terraform destroy completes
         ↓ PASS? Continue. FAIL? Retry once (Azure NSG timing)

GATE D4: terraform state list | wc -l → MUST equal 0
         ↓ PASS? Done. FAIL? Something orphaned - investigate
```

---

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
| **Voucher consumed** | Create ONE VOUCHER PER WORKER before boot (race conditions cause failures) |
| **API hashlist creation fails** | ALWAYS create hashlist via database - API is unreliable |
| **Manual task assignment** | ANTI-PATTERN - use API createTask instead of DB insert |
| **CPU task not dispatching** | Set agents to `cpuOnly=1` if using CPU workers with `isCpuTask=1` tasks |
| **Files not downloading** | Files must be in `/usr/local/share/hashtopolis/files/` FLAT |
| **Trusted agents can't get files** | Set `isSecret=1` on File records for trusted agent downloads |
| **Agent recursion error** | Kill and restart agent with increased recursion limit |
| **Workers can't download hashcat** | Use server as file proxy (see `docs/NETWORKING.md`) |
| **PoCL/hashcat benchmark fails** | Set `cmdPars='--force'` on Agent record (NOT just attackCmd) |
| **Worker idle (rule attacks)** | Set `ignoreErrors=1` on ALL agents at trust time, not after failure |
| **keyspace=1 (task exhausts immediately)** | Delete `/opt/hashtopolis-agent/files/*`, reset keyspace=0 |
| **Rule attack keyspace wrong** | Fix: `UPDATE Task SET keyspace = wordlist_lines × rules_lines` |
| **CRLF line endings** | Use `dos2unix` or `.trim()` each line |
| **"No task available!"** | Check isActive=1, priority>0, TaskWrapper priority>0 |
| **Deleting tasks breaks things** | Archive instead: `UPDATE Task SET isArchived=1, priority=0` |
| **Tiny chunks (6-7K instead of ~367M)** | `useNewBench` mismatch - check agent benchmark format and set 0 (old) or 1 (new) |
| **Using chunkSize/staticChunks** | ANTI-PATTERN - fix `useNewBench` instead, don't mask the problem |

### Benchmark Format Detection (CRITICAL)

**ALL CPU workers use PoCL (Portable Computing Language)** via Ubuntu's hashcat package.
PoCL may report OLD or NEW benchmark format depending on version/environment.

**ALWAYS verify before task creation - never assume based on provider:**
```sql
-- After agents register and benchmark, check format:
SELECT agentId, benchmark FROM Assignment LIMIT 1;
-- Contains ":" (e.g., "2672:24760.24") → useNewBench=0 (OLD format)
-- Number only (e.g., "24760.24") → useNewBench=1 (NEW format)
```

| Benchmark Value | Format | useNewBench |
|-----------------|--------|-------------|
| `2672:24760.24` | OLD (time:speed) | `0` |
| `24760.24` | NEW (speed only) | `1` |

**Known Observations:**
- GCP with PoCL: Observed OLD format → `useNewBench=0`
- AWS/Azure: Verify each deployment
- Local (Proxmox/XCP-ng): Verify each deployment

## Recommended Permissions

Add to `.claude/settings.local.json` for faster workflow:

```json
{
  "permissions": {
    "allow": [
      "Bash(terraform:*)",
      "Bash(ssh:*)",
      "Bash(scp:*)",
      "Bash(gcloud:*)",
      "Bash(aws:*)",
      "Bash(az:*)",
      "Bash(oci:*)",
      "Bash(for:*)",
      "Bash(while:*)",
      "Bash(sleep:*)",
      "Bash(SERVER_IP=*)",
      "Bash(DB_PASS=*)",
      "Bash(TASK_ID=*)",
      "Bash(result=*)",
      "Bash(echo:*)",
      "Bash(cat > /tmp/*)"
    ]
  }
}
```

## ⛔ SCALE MASSIVELY WITH HASHTOPOLIS

**The core value of this skill is SCALABILITY.** Use Hashtopolis to distribute work across 10, 50, 100+ workers.

### Parallelization Quick Reference

| Workers | Straight Attack | Rule Attack |
|---------|-----------------|-------------|
| 4 | 4 active | 1 active (3 waiting) |
| 10 | 10 active | 1 active (9 waiting) |
| 50 | 50 active | 1 active (49 waiting) |

**To parallelize rule attacks:** Split HASHES into N hashlists, create N tasks, N workers each attack different hashes.

### Scale Commands

```bash
# Scale to 20 workers
terraform apply -var="worker_count=20" -auto-approve

# After new workers register, trust them
ssh ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -e \"
UPDATE Agent SET isTrusted = 1, cpuOnly = 1, cmdPars = '--force', ignoreErrors = 1 WHERE isTrusted = 0;
\""
```

**Full scaling documentation:** `workflows/Scale.md` and `docs/PARALLELIZATION.md`

---

## Architecture

```
PAI Hashcrack CLI
       │
       ▼
Hashtopolis Server (orchestration)
       │
       ├── Worker 1 (XCP-ng / Proxmox / AWS / Azure / GCP / OCI)
       ├── Worker 2
       └── Worker N (scale to hundreds)
```

## Supported Platforms

| Platform | Directory | Status | Notes |
|----------|-----------|--------|-------|
| XCP-ng | `terraform/` | Production | Local hypervisor |
| Proxmox | `terraform/proxmox/` | Production | Local, cloud-init |
| AWS | `terraform/aws/` | Production | Spot instances, T4 GPU |
| Azure | `terraform/azure/` | Production | Spot VMs |
| GCP | `terraform/gcp/` | Production | Preemptible, Cloud NAT |
| OCI | `terraform/oci/` | Production | 10TB free egress |

See `terraform/*/README.md` for provider-specific setup.

## Workflow Routing

**When executing a workflow:**
1. Call notification: `~/.claude/Tools/SkillWorkflowNotification WORKFLOWNAME Hashcrack`
2. Output: `Running the **WorkflowName** workflow from the **Hashcrack** skill...`

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

| Format | Example | Auto-Detection |
|--------|---------|----------------|
| **Linux Shadow** | `root:$6$salt$hash:...` | Detects `$N$` prefix |
| **Windows SAM (pwdump)** | `user:500:aad3b435:31d6cfe0:::` | RID + LM:NTLM |
| **NTDS.dit (secretsdump)** | `DOMAIN\user:500:aad3b435:31d6cfe0:::` | Domain\\ prefix |
| **Plain Hashes** | `31d6cfe0d16ae931...` | Hex patterns |

## Supported Hash Types

| Type | Hashcat Mode | Common Source |
|------|--------------|---------------|
| MD5 | 0 | Web applications |
| SHA1 | 100 | Legacy systems |
| SHA256 | 1400 | Modern hashing |
| SHA512crypt | 1800 | Linux /etc/shadow |
| NTLM | 1000 | Windows SAM/AD |
| bcrypt | 3200 | Modern web apps |
| yescrypt (`$y$`) | N/A | Ubuntu 24.04+ (use JtR) |

### Shadow File Routing

| Prefix | Algorithm | Cracker |
|--------|-----------|---------|
| `$1$` | MD5crypt | Hashtopolis |
| `$5$` | SHA-256crypt | Hashtopolis |
| `$6$` | SHA-512crypt | Hashtopolis |
| `$y$` | yescrypt | **John the Ripper** |
| `$7$` | scrypt | **John the Ripper** |

## Environment Variables

```bash
# XenOrchestra (XCP-ng)
XO_URL="wss://192.168.99.200"
XO_USER="admin@admin.net"
XO_PASSWORD="..."

# Hashtopolis (set after deployment)
HASHTOPOLIS_URL="http://SERVER_IP:8080"  # Use HTTP, not HTTPS
HASHTOPOLIS_API_KEY="PAI_API_KEY"
HASHTOPOLIS_USER="hashcrack"
HASHTOPOLIS_PASSWORD="Hashcrack2025Lab"
```

## Quick Start

```bash
# Deploy infrastructure
hashcrack deploy --provider aws --workers 2

# Submit hash job (auto-detects format)
hashcrack crack /path/to/hashes.txt
cat /etc/shadow | hashcrack crack -

# Monitor progress
hashcrack status

# Scale workers
hashcrack scale --workers 4

# Get results
hashcrack results

# Cleanup
hashcrack teardown
```

## Reference Documentation

| Document | Content |
|----------|---------|
| `workflows/Deploy.md` | Step-by-step deployment |
| `workflows/Crack.md` | Submitting crack jobs |
| `workflows/Scale.md` | Worker scaling |
| `workflows/Teardown.md` | Cleanup procedures |
| `AttackStrategies.md` | Attack prioritization |
| `HashtopolisAPI.md` | API reference |
| `LEARNINGS.md` | Operational knowledge |
| `docs/CLI-SETUP.md` | Cloud CLI installation |
| `docs/NETWORKING.md` | NAT alternatives |
| `docs/WORDLISTS.md` | Passphrase sources |
| `docs/JOHN-THE-RIPPER.md` | JtR for yescrypt |
| `docs/TROUBLESHOOTING.md` | Known issues |

## CLI Tools

| Tool | Purpose |
|------|---------|
| `HashcrackCLI.ts` | Main orchestrator |
| `HashtopolisClient.ts` | API client |
| `InputParsers.ts` | Format detection |
| `CustomWordlist.ts` | Password list manager |
| `JohnClient.ts` | JtR integration |

## Security

- **Never commit** `.env` or `terraform.tfvars` with credentials
- **Use environment variables** for sensitive config
- **API keys** stored in Hashtopolis database, not plain text
- **SSH keys** managed via cloud-init, not stored locally

## Legal Warning

This skill is for **authorized security testing only**:
- Internal red team assessments
- Penetration testing with written authorization
- Security research on owned systems
- CTF competitions

**Never use against systems without explicit permission.**
