# Hashcrack Skill Testing Guide

This document describes the testing framework for the Hashcrack skill. **Run tests after every major change** to ensure nothing breaks across the 6 supported providers.

## Quick Start

```bash
# Run all validation tests (fast, safe, no cloud costs)
cd ~/.claude/skills/Hashcrack
bun test tests/hashcrack.test.ts

# Or use the test runner CLI
bun run tests/run-tests.ts
```

## Test Levels

| Level | Command | Cost | Time | When to Use |
|-------|---------|------|------|-------------|
| **Validation** | `bun test` | Free | ~10s | After every change |
| **Plan** | `--plan <provider>` | Free | ~30s/provider | Before commits |
| **Deploy** | `--deploy <provider>` | $$$ | ~15min | Integration testing only |

## Supported Providers

All 6 providers are tested:

| Provider | Terraform Dir | Type |
|----------|---------------|------|
| `xcp-ng` | `terraform/` | Local hypervisor |
| `proxmox` | `terraform/proxmox/` | Local hypervisor |
| `aws` | `terraform/aws/` | Cloud |
| `azure` | `terraform/azure/` | Cloud |
| `gcp` | `terraform/gcp/` | Cloud |
| `oci` | `terraform/oci/` | Cloud |

## Validation Tests

Validation tests run instantly and catch most issues:

### What's Tested

1. **Skill Structure**
   - Required files exist (SKILL.md, SETUP.md, .gitignore, etc.)
   - SKILL.md has valid frontmatter (name, version, description)
   - All workflows exist
   - All tools exist

2. **Terraform Structure** (per provider)
   - Directory exists
   - main.tf exists
   - variables.tf exists
   - terraform.tfvars.example exists
   - Example has no real credentials (catches accidental commits)

3. **Security**
   - Root .gitignore exists
   - .gitignore excludes sensitive patterns
   - Warns if .tfstate files are found locally

4. **TypeScript Syntax**
   - All tools compile without syntax errors

5. **SKILL.md Integrity**
   - File paths referenced in SKILL.md actually exist
   - Provider table matches actual directories

6. **Workflow Integrity**
   - All workflows have required sections

### Running Validation Tests

```bash
cd ~/.claude/skills/Hashcrack/tests
bun test hashcrack.test.ts

# Expected output:
# 58 pass
# 0 fail
```

## Plan Tests (Terraform Dry-Run)

Plan tests run `terraform plan` without creating infrastructure:

```bash
# Single provider
bun run tests/run-tests.ts --plan aws

# All providers
bun run tests/run-tests.ts --plan all
```

### Requirements

1. Terraform installed
2. Provider initialized (`terraform init`)
3. `terraform.tfvars` exists with your credentials

### What It Validates

- Terraform syntax is valid
- Variables are properly defined
- Provider configuration is correct
- Resources can be planned (no API errors)

## Deployment Tests (Integration)

⚠️ **WARNING: Creates real infrastructure and incurs costs!**

Only use for critical changes before release:

```bash
# Single provider (10-second abort window)
bun run tests/run-tests.ts --deploy aws
```

### What It Does

1. Runs `terraform init`
2. Runs `terraform plan`
3. Runs `terraform apply` (creates real infrastructure)
4. Waits 60s for infrastructure to stabilize
5. Runs basic connectivity tests
6. Runs `terraform destroy` (cleans up)

### When to Use

- Before major releases
- After changing cloud-init scripts
- After modifying provider configurations
- When validation/plan tests pass but behavior seems wrong

## Provider Status

Check which providers are configured:

```bash
bun run tests/run-tests.ts --status

# Output:
# Provider      │ Dir Exists │ Initialized │ Example │ State
# ──────────────┼────────────┼─────────────┼─────────┼──────
# xcp-ng        │ Yes        │ Yes         │ Yes     │ Clean
# proxmox       │ Yes        │ No          │ Yes     │ Clean
# aws           │ Yes        │ Yes         │ Yes     │ Active
# ...
```

## Test Workflow

### After Every Change

1. Run validation tests: `bun test tests/hashcrack.test.ts`
2. If fail: Fix the issue, don't commit
3. If pass: Continue

### Before Committing

1. Run validation tests
2. Run plan tests for affected providers: `bun run tests/run-tests.ts --plan <provider>`
3. If fail: Fix and re-test
4. If pass: Commit

### Before Release

1. Run validation tests
2. Run plan tests for all providers: `--plan all`
3. (Optional) Run deployment test for one provider: `--deploy aws`
4. If all pass: Release

## Adding New Tests

### Adding a New Provider

1. Add to `PROVIDERS` array in `hashcrack.test.ts`
2. Add to `PROVIDERS` array in `run-tests.ts`
3. Create `terraform/<provider>/terraform.tfvars.example`
4. Run tests to verify

### Adding New Tool Validation

1. Add tool filename to `TOOLS` array in `hashcrack.test.ts`
2. Run tests to verify

### Adding New Workflow Validation

1. Add workflow filename to `WORKFLOWS` array in `hashcrack.test.ts`
2. Run tests to verify

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Tests fail with "file not found" | Check file exists at expected path |
| Terraform tests skipped | Run `terraform init` in provider directory |
| Plan tests fail with auth error | Check credentials in terraform.tfvars |
| TypeScript syntax error | Fix syntax in the tool file |
| SKILL.md reference error | Update SKILL.md to match actual file paths |

## CI/CD Integration

For automated testing in CI:

```yaml
# Example GitHub Actions
- name: Run Hashcrack Tests
  run: |
    cd .claude/skills/Hashcrack
    bun test tests/hashcrack.test.ts
```

Plan tests require credentials and should only run in secure CI environments.

## Files

| File | Purpose |
|------|---------|
| `tests/hashcrack.test.ts` | Main test suite (bun test) |
| `tests/run-tests.ts` | CLI test runner |
| `TESTING.md` | This documentation |
