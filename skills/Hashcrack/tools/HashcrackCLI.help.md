# HashcrackCLI - Command Reference

Distributed password hash cracking using Hashtopolis.

## Installation

The CLI is a TypeScript tool that runs with Bun:

```bash
# Run directly
bun run ~/.claude/skills/Hashcrack/tools/HashcrackCLI.ts <command>

# Or create alias
alias hashcrack='bun run ~/.claude/skills/Hashcrack/tools/HashcrackCLI.ts'
```

## Commands

### setup

Check prerequisites and create Ubuntu 24.04 template if it doesn't exist.

```bash
hashcrack setup
```

**Checks:**
- XO/XCP-ng credentials in `.claude/.env`
- Terraform/OpenTofu installed
- Ubuntu 24.04 cloud-init template exists

If template is missing, it will be created automatically.

### deploy

Deploy Hashtopolis infrastructure to XCP-ng.

```bash
hashcrack deploy [options]

Options:
  --workers N         Number of worker VMs (default: 2)
  --server-cpus N     Server vCPUs (default: 2)
  --server-memory N   Server RAM in GB (default: 4)
  --worker-cpus N     Worker vCPUs (default: 4)
  --worker-memory N   Worker RAM in GB (default: 4)
```

**Example:**
```bash
hashcrack deploy --workers 5 --worker-memory 8
```

### scale

Scale workers up or down.

```bash
hashcrack scale --workers N
```

**Examples:**
```bash
hashcrack scale --workers 10   # Add workers
hashcrack scale --workers 2    # Reduce workers
hashcrack scale --workers 0    # Remove all workers
```

### crack

Submit hash job for cracking.

```bash
hashcrack crack [options]

Options:
  --input FILE        Path to hash file
  --type TYPE         Hash type (md5, ntlm, sha512crypt, etc.)
  --strategy STR      Attack strategy: quick|comprehensive|thorough
  --name NAME         Job name (default: hashcrack-<timestamp>)
```

**Examples:**
```bash
# From file
hashcrack crack --input hashes.txt --type ntlm

# From stdin
cat hashes.txt | hashcrack crack --type sha512crypt

# With options
hashcrack crack --input dump.txt --type ntlm --strategy thorough --name audit-2025
```

### status

Show current status.

```bash
hashcrack status
```

**Output:**
- Server connection status
- Worker count and health
- Current job progress
- Active task progress bars

### results

Save cracked passwords to .env file.

```bash
hashcrack results
```

**Note:** Passwords are saved as base64 in `.claude/.env`, never displayed in terminal.

### server

Show server URL and credentials.

```bash
hashcrack server
```

### teardown

Destroy all infrastructure.

```bash
hashcrack teardown
```

**Warning:** This is irreversible!

## Hash Types

| Type | Command | Hashcat Mode |
|------|---------|--------------|
| MD5 | `--type md5` | 0 |
| SHA1 | `--type sha1` | 100 |
| SHA256 | `--type sha256` | 1400 |
| SHA512 | `--type sha512` | 1700 |
| md5crypt | `--type md5crypt` | 500 |
| sha512crypt | `--type sha512crypt` | 1800 |
| bcrypt | `--type bcrypt` | 3200 |
| LM | `--type lm` | 3000 |
| NTLM | `--type ntlm` | 1000 |
| NetNTLMv1 | `--type netntlmv1` | 5500 |
| NetNTLMv2 | `--type netntlmv2` | 5600 |
| Kerberos AS-REP | `--type kerberos-asrep` | 18200 |
| Kerberos TGS | `--type kerberos-tgs` | 13100 |

## Attack Strategies

### quick
- rockyou.txt only
- Best for: Quick initial pass

### comprehensive (default)
- rockyou.txt
- rockyou.txt + best64.rule
- Common masks

### thorough
- All comprehensive attacks
- rockyou-30000.rule
- OneRuleToRuleThemAll.rule
- Extended 8-char masks

## Environment Variables

Set in `.claude/.env`:

```bash
# Required for deployment
XO_HOST=https://192.168.99.206
XO_USER=admin
XO_PASSWORD=<password>

# Auto-configured after deployment
HASHCRACK_SERVER_URL=https://192.168.99.xxx:8080
HASHCRACK_API_KEY=<generated>
HASHCRACK_ADMIN_PASSWORD=<generated>
HASHCRACK_VOUCHER=<generated>
```

## Workflow Examples

### Complete Workflow

```bash
# 1. Setup (creates template if needed)
hashcrack setup

# 2. Deploy infrastructure
hashcrack deploy --workers 5

# 3. Wait for services to start
sleep 180

# 4. Submit job
hashcrack crack --input ntlm_hashes.txt --type ntlm --strategy comprehensive

# 5. Monitor progress
hashcrack status

# 6. Scale up if needed
hashcrack scale --workers 10

# 7. Get results
hashcrack results

# 8. View results in UI
hashcrack server

# 9. Cleanup
hashcrack teardown
```

### Quick Test

```bash
# Deploy minimal
hashcrack deploy --workers 1

# Quick crack
echo "5f4dcc3b5aa765d61d8327deb882cf99" | hashcrack crack --type md5 --strategy quick

# Check
hashcrack status
```

## Troubleshooting

### "Hashtopolis not configured"
Run `hashcrack deploy` first or manually set credentials in `.claude/.env`.

### "Cannot connect to server"
- Check server is running: `curl -sk https://<server>:8080`
- Wait for cloud-init to complete (2-3 min after deploy)

### "Workers not connecting"
- Wait for cloud-init (5 min for workers)
- SSH to worker and check agent: `systemctl status hashtopolis-agent`

### "No progress on job"
- Check workers are active: `hashcrack status`
- Trust agents in Hashtopolis UI

## Security

- Cracked passwords are NEVER displayed in terminal
- Results are base64-encoded in `.env`
- View actual passwords in Hashtopolis UI only
- Infrastructure runs in isolated lab network
