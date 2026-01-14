# Contributing to Claude Code Skills

Thank you for your interest in contributing! This document provides guidelines for contributing to this skill collection.

## Ways to Contribute

1. **Report Bugs** - Open an issue describing the problem
2. **Suggest Features** - Open an issue with your idea
3. **Improve Documentation** - Fix typos, clarify instructions
4. **Add Software Entries** - Expand the MSV software catalog
5. **Create New Skills** - Submit a new skill via pull request

## Reporting Issues

When reporting bugs, please include:

- Skill name and version
- Operating system
- Steps to reproduce
- Expected vs actual behavior
- Error messages (if any)

## Pull Request Process

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Make your changes
4. Run tests if available (`bun test`)
5. Commit with clear messages
6. Push to your fork
7. Open a Pull Request

### Commit Message Format

```
[SkillName] Brief description

Longer explanation if needed.
```

Examples:
- `[MSV] Add support for Zoom client`
- `[MSV] Fix Chrome version parsing for beta builds`
- `[Docs] Update installation instructions for Windows`

## Adding New Software to MSV

To add a new software entry to MSV:

1. Find the correct vendor/product in NVD (https://nvd.nist.gov)
2. Add entry to `skills/MSV/data/SoftwareCatalog.json`
3. Test with `bun run tools/msv.ts query "your-software"`
4. Submit PR with test results

See `skills/MSV/docs/AddingSoftware.md` for detailed instructions.

## Creating a New Skill

New skills should follow this structure:

```
skills/YourSkill/
├── SKILL.md          # Required - skill definition with frontmatter
├── SETUP.md          # Recommended - installation guide
├── .env.example      # If environment variables needed
├── .gitignore        # Ignore cache/temp files
├── tools/
│   └── main.ts       # Main entrypoint
└── docs/             # Additional documentation
```

### SKILL.md Requirements

```yaml
---
name: YourSkillName
version: 1.0.0
description: Brief description. USE WHEN triggers for Claude Code.
---

# Skill Name

Full documentation...
```

## Code Style

- **TypeScript** preferred over JavaScript
- **Bun** as the runtime
- Use meaningful variable names
- Add comments for complex logic
- Handle errors gracefully

## Testing

- Add tests in `*.test.ts` files
- Run with `bun test`
- Ensure existing tests pass before submitting

## Questions?

Open an issue with the `question` label or reach out to [@doritoes](https://github.com/doritoes).
