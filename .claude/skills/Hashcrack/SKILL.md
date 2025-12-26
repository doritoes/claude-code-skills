---
name: Hashcrack
description: Highly scalable distributed password hash cracking using Hashtopolis. USE WHEN user wants to crack password hashes OR user has hash dumps to process OR user needs distributed cracking OR user mentions hashtopolis. Deploys infrastructure to XCP-ng, manages workers dynamically, monitors progress, stores results securely in .env.
---

# Hashcrack Skill

Distributed password hash cracking using Hashtopolis as the orchestration layer. The core value is **scalability** - distribute work across many workers, from a handful of local VMs to hundreds of cloud instances.

## Architecture

```
PAI Hashcrack CLI
       │
       ▼
Hashtopolis Server (orchestration)
       │
       ├── Worker 1 (XCP-ng)
       ├── Worker 2 (XCP-ng)
       ├── Worker N (cloud)
       └── ...scale to hundreds
```

## Quick Start

```bash
# Check prerequisites and create Ubuntu template (if needed)
hashcrack setup

# Deploy infrastructure
hashcrack deploy --workers 3

# Submit hash job
hashcrack crack --input /path/to/hashes.txt --type ntlm

# Or pipe directly
cat hashes.txt | hashcrack crack --type ntlm

# Monitor progress
hashcrack status

# Scale workers mid-job
hashcrack scale --workers 10

# View results in Hashtopolis UI
hashcrack server

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

## Supported Hash Types

| Type | Hashcat Mode | Common Source |
|------|--------------|---------------|
| MD5 | 0 | Web applications |
| SHA1 | 100 | Legacy systems |
| SHA256 | 1400 | Modern hashing |
| SHA512crypt | 1800 | Linux /etc/shadow |
| NTLM | 1000 | Windows SAM/AD |
| LM | 3000 | Legacy Windows |
| bcrypt | 3200 | Modern web apps |
| NetNTLMv2 | 5600 | Network captures |
| Kerberos TGS | 13100 | AD attacks |

## Attack Strategy

The skill runs attacks in phases, from quick wins to comprehensive:

1. **Quick Wins** - rockyou.txt + best64.rule
2. **Expanded Wordlist** - SecLists common passwords
3. **Heavy Rules** - OneRuleToRuleThemAll
4. **Mask Attacks** - Common patterns (?u?l?l?l?d?d?d?d)
5. **Extended Masks** - Up to 8-10 characters mixed

**Important**: True 24-character brute-force is computationally infeasible. Strategy focuses on intelligent wordlist/rule combinations.

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

# Hashtopolis (set after deployment)
HASHCRACK_SERVER_URL=
HASHCRACK_API_KEY=
HASHCRACK_VOUCHER=
```

## Reference Documentation

- `HashtopolisAPI.md` - REST API endpoints and authentication
- `AttackStrategies.md` - Detailed attack configurations and hash types

## CLI Tools

| Tool | Purpose |
|------|---------|
| `HashcrackCLI.ts` | Main orchestrator - deploy, crack, status, teardown |
| `HashtopolisClient.ts` | Hashtopolis REST API client library |
| `InfraProvision.ts` | Terraform wrapper for infrastructure |
| `JobMonitor.ts` | Real-time progress display |

## Infrastructure

- **Server**: Ubuntu 24.04 LTS, Docker Compose (Hashtopolis containers)
- **Workers**: Ubuntu 24.04 LTS, hashcat + Hashtopolis agent
- **Provisioning**: Terraform (XenOrchestra provider)
- **Configuration**: Ansible (roles for server, agents, wordlists)

## Critical Setup Requirements

**After deploying workers, you MUST configure these settings in Hashtopolis:**

1. **Trust Agents**: In Hashtopolis UI → Agents → Set each agent to "Trusted"
   - Required for agents to receive tasks and download files

2. **Allow Sensitive Information**: If hashlist is marked sensitive, agents must be trusted
   - Database: `UPDATE Agent SET isTrusted = 1;`
   - API: Use `/api/v2/ui/agents/{id}` with `{"isTrusted": true}`

3. **Delete Old Assignments**: When creating new tasks, clear old task assignments
   - Database: `DELETE FROM Assignment WHERE taskId = <old_task_id>;`
   - Otherwise agents may not pick up new tasks

## Examples

### Crack NTLM hashes from a file
```bash
hashcrack crack --input /pentest/ntlm_dump.txt --type ntlm --workers 5
```

### Crack Linux shadow hashes (piped)
```bash
cat /extracted/shadow | hashcrack crack --type sha512crypt
```

### Scale up workers for faster cracking
```bash
hashcrack scale --workers 20
```

### Check job progress
```bash
hashcrack status
# Output: Job 42% complete | 12,847/30,000 cracked | Speed: 1.2 GH/s | ETA: 2h 15m
```

### View Hashtopolis UI
```bash
hashcrack server
# Output: Hashtopolis server: https://192.168.99.xxx:8080
#         Login with admin credentials in .claude/.env
```

## Legal Warning

This skill is for **authorized security testing only**. Before use:

1. Ensure you have written authorization to test the target systems
2. Document the scope and authorization
3. Use only on systems you own or have explicit permission to test

Unauthorized password cracking is illegal and unethical.
