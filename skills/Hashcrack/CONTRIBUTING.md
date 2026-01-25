# Contributing to Hashcrack

Thank you for your interest in contributing to the Hashcrack skill!

## How to Contribute

### Reporting Issues

1. Check existing issues first to avoid duplicates
2. Include provider name (AWS, Azure, GCP, OCI, Proxmox, XCP-ng)
3. Include relevant error messages and logs
4. Describe steps to reproduce

### Submitting Changes

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Make your changes
4. Run validation tests: `bun test tests/hashcrack.test.ts`
5. Commit with descriptive message
6. Submit a pull request

### Code Style

- **TypeScript** for tools (Bun runtime)
- **HCL** for Terraform configurations
- **Markdown** for documentation

### Testing Requirements

Before submitting:

```bash
# Run validation tests (free, fast)
cd ~/.claude/skills/Hashcrack
bun test tests/hashcrack.test.ts

# Run terraform validate for affected providers
cd terraform/aws  # or your provider
terraform validate
```

### Documentation Standards

- Update relevant workflow files in `workflows/`
- Add learnings to `learnings/` for new discoveries
- Keep SKILL.md in sync with changes
- Update CHANGELOG.md

### Provider-Specific Guidelines

When adding or modifying providers:

1. Follow existing variable naming conventions
2. Include `terraform.tfvars.example` with no real credentials
3. Add provider-specific workflow in `workflows/deploy-{provider}.md`
4. Add provider learnings in `learnings/{provider}.md`
5. Ensure outputs include: `server_public_ip`, `db_password`, `voucher_code`

### Consistency Checklist

- [ ] Variable names match other providers where applicable
- [ ] Output variables follow standard naming
- [ ] terraform.tfvars.example has no credentials
- [ ] .gitignore excludes sensitive files
- [ ] Workflow has GATE checkpoints
- [ ] Tests pass

## Questions?

Open an issue for discussion before starting major changes.
