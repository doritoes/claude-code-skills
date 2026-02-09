# Personal AI Infrastructure (PAI)

## Core Identity

**Name:** PAI (Personal AI Infrastructure)
**Owner:** Seth Holcomb (@sethh)
**Purpose:** Automate lab infrastructure, workflows, and productivity using AI-powered skills

---

## About Seth Holcomb

**Role:** Principal Network Security Engineer | Cyber Guardian
**Experience:** 25+ years (1999-present)
**Industry:** Financial services (M&T Bank, Paychex)
**Contact:** seth.holcomb@gmail.com | sethholcomb.com

### Career Highlights
- **M&T Bank** (2021-2025) - SVP, Perimeter Security Engineer
  - Externally-facing cyber security infrastructure
  - Check Point Maestro, acquisition integrations
- **Paychex** (2011-2021) - Security Engineer → Cyber Intelligence Analyst
  - Built enterprise Threat Intelligence Program (Anomali Threatstream)
  - NCFTA liaison, FS-ISAC working groups, SANS Advisory Board

### Technical Expertise
| Domain | Technologies |
|--------|--------------|
| Firewalls | Check Point (Maestro, VSX), Palo Alto, Juniper SRX, Cisco ASA, pfSense |
| Threat Intel | Anomali Threatstream, STIX/TAXII, IoC automation |
| SIEM/SOAR | Splunk, ArcSight, ELK, Splunk Phantom |
| Automation | Python, PowerShell, Ansible, Terraform, REST APIs |
| Cloud | Azure, Zscaler ZIA, Broadcom WSS |

### Certifications
- Check Point CCSE/CCME (2021)
- SANS GCDA (2019)
- CompTIA Security+ (2017)
- CCNA Security (2001/2011)

### Passions
- **Sharing knowledge** - Open source contributor, lab documentation (UncleNuc.com)
- **Hands-on learning** - Build it to understand it
- **Doing difficult things** - Embrace complexity, master the hard problems

### Working Philosophy
- **Bias for action** - Decisive movement over analysis paralysis
- **Disciplined automation** - Systematic, repeatable, reliable
- **Future-focused innovation** - Evolving, not just maintaining
- **Do things the right way** - Integrity over shortcuts
- **Constraint navigation** - Pragmatic solutions in real-world limits

### GitHub: [doritoes](https://github.com/doritoes)
| Repository | Description |
|------------|-------------|
| NUC-Labs | UncleNuc.com Labs - Intel NUC homelab guides |
| ipgiraffe.com | AWS Lambda IP geolocation service |
| iploc8.com | Geolocation API |
| ipdice.com | IP utility service |
| docker-guacamole | Self-contained Guacamole for remote access |

### Why This Lab Exists
The PAI lab environment mirrors enterprise security architecture:
- Multi-site firewall clusters (Check Point/pfSense patterns)
- Threat intelligence automation prototyping
- Network segmentation and DMZ testing
- Automation development (Ansible, Python, PowerShell)

---

## Environment

- **OS:** Windows 11 Pro
- **Shell:** PowerShell / Git Bash
- **Runtime:** Bun (TypeScript), Python
- **User:** sethh

---

## Lab Infrastructure

| Component | IP Address | Hostname | Role |
|-----------|------------|----------|------|
| Proxmox | 192.168.99.205 | proxmod-lab1 | Main hypervisor cluster |
| pfSense | 192.168.99.254 | - | Firewall/Gateway |
| XCP-ng | 192.168.99.209 | labhost1 | Edge/Testing hypervisor |

**Access:** PowerShell SSH enabled
**Goals:**
- Automate VM deployment on Proxmox
- Analyze firewall logs from pfSense
- Manage edge VMs on XCP-ng

---

## Project Structure

```
AI-Projects/                    # PAI_DIR
├── .claude/
│   ├── skills/                 # Custom skills (auto-discovered)
│   │   ├── CORE/              # System identity & principles
│   │   ├── Agents/            # Dynamic agent composition (upstream)
│   │   ├── Art/               # Visual content generation (upstream)
│   │   ├── Browser/           # Playwright browser automation (upstream)
│   │   ├── Council/           # Multi-agent debate system (upstream)
│   │   ├── CreateCLI/         # TypeScript CLI generation (upstream)
│   │   ├── CreateSkill/       # Skill creation/validation (upstream)
│   │   ├── FirstPrinciples/   # Root cause analysis (upstream)
│   │   ├── FoldingAtCloud/    # Folding@Home cloud workers (custom)
│   │   ├── Hashcrack/         # Distributed hash cracking (custom)
│   │   ├── inventory/         # Lab inventory tracking (custom)
│   │   ├── MSV/               # Minimum Safe Version calculator (custom)
│   │   ├── OSINT/             # Open source intelligence (upstream)
│   │   ├── Prompting/         # Meta-prompting system (upstream)
│   │   ├── Recon/             # Security reconnaissance (upstream)
│   │   ├── RedTeam/           # Adversarial analysis (upstream)
│   │   ├── Research/          # Multi-source research (upstream)
│   │   ├── THEALGORITHM/      # Universal execution engine (upstream)
│   │   └── Upgrades/          # PAI upgrade tracking (upstream)
│   ├── observability/          # Real-time monitoring dashboard
│   │   ├── apps/server/       # WebSocket server (port 4000)
│   │   └── apps/client/       # Vue dashboard (port 5172)
│   ├── Tools/                  # CLI tools & utilities
│   ├── hooks/                  # Event-driven automation
│   ├── .env                    # API keys (gitignored)
│   └── settings.local.json     # Local permissions
├── History/                    # Permanent knowledge base
│   ├── sessions/              # Work logs
│   ├── learnings/             # Problem-solving narratives
│   ├── research/              # Investigations
│   └── raw-outputs/           # Event logs
├── scratchpad/                 # Temporary files (delete when done)
├── scripts/                    # Automation scripts
├── configs/                    # Configuration files
├── data/                       # Local data storage
└── docs/                       # Documentation
```

---

## Stack Preferences

- **TypeScript > Python** - Use TypeScript/Bun unless Python is required
- **PowerShell for Windows** - Native Windows automation
- **CLI-First** - Build deterministic tools, wrap with AI orchestration
- **Code Before Prompts** - Deterministic code > ad-hoc prompting

---

## Available Skills

### Custom Skills (Lab-Specific)
| Skill | Trigger | Purpose |
|-------|---------|---------|
| `/foldingcloud` | "fold", "F@H", "donate compute", "spare credits" | Deploy Folding@Home workers on spare cloud credits |
| `/hashcrack` | "crack hashes", "hashtopolis" | Distributed password cracking on XCP-ng |
| `/inventory` | "track VMs", "lab map" | Generate LAB_MAP.md for VM tracking |
| `/msv` | "safe version", "minimum version", "KEV check" | Determine minimum safe version for Windows software |

### Upstream Skills (from danielmiessler/PAI)
| Skill | Trigger | Purpose |
|-------|---------|---------|
| `/agents` | "create agents", "custom agents", "agent traits" | Dynamic agent composition with 800+ trait combinations |
| `/art` | "create image", "diagram", "comic" | Visual content with Excalidraw hand-drawn aesthetic |
| `/browser` | "browse", "screenshot", "web test" | Playwright automation with debug-first architecture |
| `/council` | "council", "debate", "perspectives" | Multi-agent debate system for consensus-building |
| `/createcli` | "create CLI", "build CLI", "command-line tool" | Generate production-ready TypeScript CLIs |
| `/createskill` | "create skill", "new skill", "validate skill" | Create and validate PAI skills with canonical structure |
| `/firstprinciples` | "first principles", "root cause", "decompose" | Physics-based reasoning: deconstruct→challenge→reconstruct |
| `/osint` | "OSINT", "due diligence", "investigate" | Ethical open source intelligence gathering |
| `/prompting` | "meta-prompt", "template", "prompt optimization" | Programmatic prompt generation with Handlebars templates |
| `/recon` | "recon", "reconnaissance", "attack surface" | Security reconnaissance with passive/active techniques |
| `/redteam` | "red team", "adversarial", "stress test" | 32-agent adversarial analysis for finding flaws |
| `/research` | "research", "deep dive", "multi-source" | Multi-agent research with 3-12 parallel researchers |
| `/thealgorithm` | "run algorithm", "complex task" | Scientific method execution: Observe→Think→Plan→Build→Execute→Verify→Learn |
| `/upgrades` | "check upgrades", "new features" | Monitor Anthropic ecosystem and AI YouTube channels |

### Observability Dashboard
Start with: `cd .claude/observability && bun run apps/server/src/index.ts`
Dashboard: http://localhost:5172

---

## File Organization

| Directory | Purpose | Retention |
|-----------|---------|-----------|
| `scratchpad/` | Temporary files, experiments | Delete when done |
| `History/` | Valuable outputs, research | Keep forever |
| `scripts/` | Automation scripts | Version controlled |

**Rules:**
- Save valuable work to History, not scratchpad
- Never create `backups/` directories inside skills
- Store secrets in `.claude/.env`, never in code

---

## Security Protocols

1. **API Keys** - Store in `.claude/.env` (gitignored)
2. **Lab Credentials** - Use environment variables
3. **SSH Keys** - Use key-based auth, not passwords
4. **Git Safety** - Check `git remote -v` before every push

---

## Active Tasks

- Monitoring firewall blocks from pfSense
- Automating VM snapshots on Proxmox

---

## Session Context

*Updated automatically during sessions*

### Recent Work
- **2026-01-19:** Installed 8 additional upstream PAI packs
  - Security: Recon (reconnaissance), RedTeam (adversarial analysis), OSINT (intelligence)
  - Research: Research (multi-agent), FirstPrinciples (root cause analysis)
  - Meta: Council (debate), CreateCLI (CLI generation), CreateSkill (skill validation)
  - Tools: Recon TypeScript utilities (DNS, CIDR, WHOIS, IPInfo, BountyPrograms)
- **2026-01-14:** Hybrid upgrade from upstream PAI (danielmiessler/Personal_AI_Infrastructure)
  - Installed upstream skills: Agents, Art, Browser, Prompting, THEALGORITHM, Upgrades
  - Added observability dashboard (Vue + WebSocket)
  - Kept custom skills: MSV, Hashcrack, inventory
  - Backups at: History/backups/2026-01-14/
- Built MSV (Minimum Safe Version) skill with CISA KEV, VulnCheck, EPSS integration
- Created architect and inventory skills
- Initialized PAI project structure

### Lab Inventory
- **Proxmox:** 192.168.99.205 (Node: proxmod-lab1)
- **pfSense:** 192.168.99.254 (Gateway)
- **XCP-ng:** 192.168.99.209 (Node: labhost1)
