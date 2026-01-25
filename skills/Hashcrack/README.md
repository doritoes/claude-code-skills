# Hashcrack

> Distributed password hash cracking using Hashtopolis, deployed across 6 cloud and hypervisor providers with Claude Code.

## Features

- **6 Providers:** AWS, Azure, GCP, OCI, Proxmox, XCP-ng
- **Auto-scaling:** Deploy 1-100+ CPU or GPU workers
- **Parallel Rule Attacks:** Split hashes across workers for true parallelization
- **Comprehensive Documentation:** GATE-based workflows prevent common failures
- **Cost-Optimized:** Spot/preemptible instance support on all cloud providers

## Quick Start

### Prerequisites

| Tool | Version | Installation |
|------|---------|--------------|
| Bun | 1.0+ | `curl -fsSL https://bun.sh/install \| bash` |
| Terraform | 1.0+ | `winget install Hashicorp.Terraform` |
| SSH Key | ed25519 | `ssh-keygen -t ed25519 -f ~/.ssh/hashcrack` |

### Installation

```bash
# 1. Copy the skill to your Claude Code skills directory
cp -r Hashcrack ~/.claude/skills/

# 2. Copy environment template
cp ~/.claude/skills/Hashcrack/.env.example ~/.claude/.env

# 3. Configure your provider credentials in .env
# Edit ~/.claude/.env with your AWS/Azure/GCP/OCI credentials

# 4. Configure terraform variables
cd ~/.claude/skills/Hashcrack/terraform/aws  # or your chosen provider
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars with your settings

# 5. Initialize terraform
terraform init
```

### Deploy

```bash
# Deploy 4 CPU workers on AWS
hashcrack deploy --provider aws --workers 4

# Or ask Claude Code:
# "Deploy a hashcrack cluster with 4 workers on AWS"
```

### Crack Hashes

```bash
# Submit hashes for cracking
hashcrack crack --input /path/to/hashes.txt --type sha256

# Monitor progress
hashcrack status

# Get results
hashcrack results
```

### Cleanup

```bash
# Destroy infrastructure when done
hashcrack teardown
```

## Supported Providers

| Provider | Type | GPU Support | Cost Model |
|----------|------|-------------|------------|
| **AWS** | Cloud | Yes (T4) | Spot instances |
| **Azure** | Cloud | Yes (T4) | Spot VMs |
| **GCP** | Cloud | Yes (T4) | Preemptible |
| **OCI** | Cloud | Yes | Preemptible |
| **Proxmox** | Local | No | Hardware only |
| **XCP-ng** | Local | No | Hardware only |

### Provider Comparison

| Aspect | AWS | Azure | GCP | OCI | Proxmox | XCP-ng |
|--------|-----|-------|-----|-----|---------|--------|
| **Setup Complexity** | Low | Medium | Low | Medium | Medium | Medium |
| **GPU Performance** | Excellent | Excellent | Excellent | Good | N/A | N/A |
| **CPU Performance** | Good | Slower | Good | Best | Good | Best |
| **Cost (4 CPU/10hr)** | ~$1.50 | ~$6.80 | ~$1.50 | ~$4.50 | $0 | $0 |
| **Free Tier** | Limited | Limited | $300 credit | Always Free | N/A | N/A |
| **Spot/Preemptible** | Yes | Yes | Yes | Yes | N/A | N/A |

**Recommendations:**
- **Fastest CPU:** XCP-ng (local) or OCI (cloud with 2x vCPU)
- **Best Value Cloud:** AWS or GCP with spot instances
- **GPU Cracking:** Any cloud provider (~100x faster than CPU)
- **Free/Lab Use:** Proxmox or XCP-ng on existing hardware

## Supported Hash Types

| Type | Hashcat Mode | Example Source |
|------|--------------|----------------|
| MD5 | 0 | Web applications |
| SHA1 | 100 | Legacy systems |
| SHA256 | 1400 | Modern hashing |
| NTLM | 1000 | Windows AD |
| sha512crypt | 1800 | Linux /etc/shadow |
| bcrypt | 3200 | Modern web apps |

## Documentation

| Document | Description |
|----------|-------------|
| [SKILL.md](SKILL.md) | Complete skill reference |
| [SETUP.md](SETUP.md) | Detailed installation guide |
| [workflows/](workflows/) | Step-by-step procedures |
| [learnings/](learnings/) | Operational knowledge base |
| [AttackStrategies.md](AttackStrategies.md) | Hash cracking techniques |

## Architecture

```
Claude Code CLI
       |
       v
Hashtopolis Server (orchestration)
       |
       +-- Worker 1 (hashcat)
       +-- Worker 2 (hashcat)
       +-- Worker N (scale to 100+)
```

## Performance Results

| Provider | Workers | Runtime (5K SHA256) | Speed |
|----------|---------|---------------------|-------|
| AWS GPU | 1x T4 | 5 min | ~25 GH/s |
| XCP-ng CPU | 4x | 6 hrs | ~40 MH/s |
| OCI CPU | 4x | 7 hrs | ~62 MH/s |
| GCP CPU | 4x | 8 hrs | ~40 MH/s |
| Azure CPU | 4x | 9.5 hrs | ~40 MH/s |

**GPU is ~100x faster than CPU** for most hash types.

## Legal Warning

This skill is for **authorized security testing only**:

- Internal red team assessments
- Penetration testing with written authorization
- Security research on owned systems
- CTF competitions

**Never use against systems without explicit permission.**

## License

MIT License - see [LICENSE](LICENSE)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## Support

- File issues at the project repository
- Check [learnings/](learnings/) for common problems
- Review [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)
