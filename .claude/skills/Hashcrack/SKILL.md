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
| **Voucher consumed** | Create ONE VOUCHER PER WORKER before boot (race conditions cause failures) |
| **API hashlist creation fails** | ALWAYS create hashlist via database - API is unreliable |
| **Manual task assignment** | ANTI-PATTERN - use API createTask instead of DB insert |
| **CPU task not dispatching** | Set agents to `cpuOnly=1` if using CPU workers with `isCpuTask=1` tasks |
| **Files not downloading** | Files must be in `/usr/local/share/hashtopolis/files/` FLAT |
| **Trusted agents can't get files** | Set `isSecret=1` on File records for trusted agent downloads |
| **Agent recursion error** | Kill and restart agent with increased recursion limit |
| **Workers can't download hashcat** | Use server as file proxy (see `docs/NETWORKING.md`) |
| **PoCL/hashcat benchmark fails** | Add `--force` flag in attackCmd |
| **keyspace=1 (task exhausts immediately)** | Delete `/opt/hashtopolis-agent/files/*`, reset keyspace=0 |
| **Rule attack keyspace wrong** | Fix: `UPDATE Task SET keyspace = wordlist_lines × rules_lines` |
| **CRLF line endings** | Use `dos2unix` or `.trim()` each line |
| **"No task available!"** | Check isActive=1, priority>0, TaskWrapper priority>0 |
| **Deleting tasks breaks things** | Archive instead: `UPDATE Task SET isArchived=1, priority=0` |

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
