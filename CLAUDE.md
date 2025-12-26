# Personal AI Infrastructure

## Overview

This project is a Personal AI Infrastructure designed to automate workflows using custom skills and AI-powered tooling.

## Environment

- **OS**: Windows 11 Pro
- **Shell**: PowerShell / Git Bash
- **User**: sethh

## Project Goals

1. Build a modular AI infrastructure for personal productivity
2. Automate repetitive workflows using custom skills
3. Create reusable components and scripts for AI-assisted tasks
4. Integrate with local and cloud-based AI services

## Project Structure

```
AI-Projects/
├── skills/          # Custom Claude Code skills
├── scripts/         # Automation scripts (PowerShell, Python, etc.)
├── configs/         # Configuration files
├── data/            # Local data storage
└── docs/            # Documentation
```

## Custom Skills

Skills are stored in `skills/` and can be invoked with `/skill-name`. Each skill should:
- Have a clear, single purpose
- Include a `skill.md` file with instructions
- Be tested before deployment

## Development Guidelines

- Prefer PowerShell for Windows-native automation
- Use Python for cross-platform or AI/ML tasks
- Keep scripts modular and well-documented
- Store sensitive data in environment variables, never in code

## Commands

Common operations:
- `claude` - Start Claude Code CLI
- Scripts should be executable from the project root

## Notes

- This infrastructure is designed for personal use and experimentation
- Focus on practical automation over theoretical complexity
