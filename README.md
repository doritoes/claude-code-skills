# Claude Code Skills

A collection of skills for [Claude Code](https://claude.ai/claude-code), Anthropic's official CLI for Claude.

## Available Skills

| Skill | Description | Status |
|-------|-------------|--------|
| [MSV](skills/MSV/) | Minimum Safe Version calculator - determines the lowest software version free of known-exploited vulnerabilities | Stable |
| [Hashcrack](skills/Hashcrack/) | Distributed password hash cracking using Hashtopolis across 6 cloud/hypervisor providers | Stable |

## Quick Installation

### Install a Single Skill

```bash
# Clone the repo
git clone https://github.com/doritoes/claude-code-skills.git

# Copy the skill to your Claude Code skills directory
# Windows
copy claude-code-skills\skills\MSV %USERPROFILE%\.claude\skills\MSV

# macOS/Linux
cp -r claude-code-skills/skills/MSV ~/.claude/skills/
```

### Sparse Checkout (Single Skill Only)

If you only want one skill without cloning everything:

```bash
git clone --depth 1 --filter=blob:none --sparse \
  https://github.com/doritoes/claude-code-skills.git
cd claude-code-skills
git sparse-checkout set skills/MSV
```

## Skill Structure

Each skill follows a standard structure:

```
skills/<SkillName>/
├── SKILL.md          # Skill definition (required by Claude Code)
├── SETUP.md          # Installation and setup guide
├── .env.example      # Environment variable template
├── tools/            # TypeScript/Python tools
├── data/             # Data files (catalogs, etc.)
└── docs/             # Additional documentation
```

## Requirements

Most skills require:

- **[Bun](https://bun.sh)** - Fast JavaScript/TypeScript runtime
- **Claude Code** - Anthropic's CLI tool

Individual skills may have additional requirements documented in their `SETUP.md`.

## Contributing

Contributions welcome! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

### Reporting Issues

- Use [GitHub Issues](https://github.com/doritoes/claude-code-skills/issues) for bugs and feature requests
- Include skill name in issue title (e.g., "[MSV] Feature request: ...")

## License

MIT License - see [LICENSE](LICENSE) for details.

## Author

**Seth Holcomb** ([@doritoes](https://github.com/doritoes))

- Principal Network Security Engineer
- 25+ years in cybersecurity
- Creator of [UncleNuc.com](https://unclenuc.com) homelab guides

## Acknowledgments

- [Anthropic](https://anthropic.com) for Claude Code
- [CISA](https://cisa.gov) for the KEV catalog
- [FIRST.org](https://first.org) for EPSS
- [AppThreat](https://github.com/AppThreat) for the vulnerability database
- [Hashtopolis](https://github.com/hashtopolis/server) for distributed hash cracking orchestration
