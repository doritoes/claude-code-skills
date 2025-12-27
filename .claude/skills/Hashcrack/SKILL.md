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
- **Configuration**: Ansible (roles for server, agents, wordlists)

## Critical Setup Requirements

**After deploying workers, you MUST configure these settings in Hashtopolis:**

1. **Trust Agents**: In Hashtopolis UI → Agents → Set each agent to "Trusted"
   - Required for agents to receive tasks and download files
   - API v1: `{"section":"agent","request":"setTrusted","agentId":1,"trusted":true}`
   - Note: Parameter is `trusted`, NOT `isTrusted`

2. **Allow Sensitive Information**: If hashlist is marked sensitive, agents must be trusted
   - Database: `UPDATE Agent SET isTrusted = 1;`

3. **Delete Old Assignments**: When creating new tasks, clear old task assignments
   - Database: `DELETE FROM Assignment WHERE taskId = <old_task_id>;`
   - Otherwise agents may not pick up new tasks

4. **Upload Wordlists First**: Wordlists must be uploaded to Hashtopolis as Files before use
   - Local paths like `/opt/hashcrack/wordlists/rockyou.txt` don't work
   - Upload via API or UI, then reference by filename in attack command

## Known Issues & Workarounds

### API Version
- **Use API v1** (`/api/user.php`), NOT API v2
- API v2 returns 500 errors in Hashtopolis 0.14.x - routes not implemented
- API v1 uses `accessKey` in request body for authentication

### API Parameter Gotchas
| Endpoint | Required Parameter | Notes |
|----------|-------------------|-------|
| `createHashlist` | `isSecret: false` | Missing = "Invalid query!" error |
| `addFile` | `isSecret: false` | Defaults to true, blocks untrusted agents |
| `setTrusted` | `trusted: true` | NOT `isTrusted` |

### Server URL
- Use **HTTP** not HTTPS: `http://192.168.99.36:8080`
- HTTPS requires valid certificates which cloud-init doesn't set up

### Agent Registration
1. Cloud-init agent download sometimes fails (corrupt zip)
   - **Fix**: Download manually from `https://github.com/hashtopolis/agent-python/archive/refs/tags/v0.7.4.zip`
2. Agent token must be in `config.json` for systemd service
   - Voucher-only config fails with EOFError
3. Ubuntu 24.04 requires `pip install --break-system-packages`

### SSH Access
- Use `ubuntu` user, NOT `pai`
- Cloud-init creates `ubuntu` user with sudo access

### Database Access
- Password is in container env, not hardcoded
- Get password: `sudo docker exec hashtopolis-db env | grep MYSQL_PASSWORD`

### Task Dispatch Issues
If agents report "No task available!" but tasks are assigned:
1. Check agent tokens match database (`SELECT agentId, token FROM Agent`)
2. Verify agent is in correct AccessGroup
3. Ensure files used in task are not marked `isSecret=1`
4. Try mask attack first (no file dependencies) to verify basic functionality

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

## Legal Warning

This skill is for **authorized security testing only**. Before use:

1. Ensure you have written authorization to test the target systems
2. Document the scope and authorization
3. Use only on systems you own or have explicit permission to test

Unauthorized password cracking is illegal and unethical.
