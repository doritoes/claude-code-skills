# AI Agent Operational Discipline

Guidelines for autonomous Hashcrack operations.

## Core Principles

1. **Read skill.md FIRST** before any operation
2. **Follow documented processes** - don't improvise
3. **Check existing learnings** before troubleshooting novel issues
4. **Document new learnings** in appropriate topic file

## Before Each Operation

| Operation | Files to Read |
|-----------|---------------|
| New deployment | skill.md (step-by-step), deployment.md |
| Creating tasks | api.md, optimization.md |
| Troubleshooting | anti-patterns.md, provider-specific file |
| Teardown | teardown.md |

## Context Management

- Don't waste context on troubleshooting documented issues
- If something fails, check learnings FIRST
- Document new issues immediately for future sessions

## Process Adherence

**Follow the step-by-step processes EXACTLY:**
- The steps are in specific order for a reason
- Skipping steps causes cascading failures
- If a step fails, fix it before proceeding

**Example:** Creating vouchers BEFORE workers boot prevents race conditions.

## When Things Go Wrong

1. **Check learnings/** for known issue
2. **Check skill.md** for documented process
3. **If truly novel**, investigate and document
4. **Don't repeat mistakes** - update learnings

## Session Handoff

When session ends or context compacts:
- Update test-results.md with new data
- Add new learnings to appropriate file
- Note current state in session summary

## Cost Awareness

- Recommend spot/preemptible for workers
- Suggest scale-down when idle
- Calculate feasibility before long-running tasks
- Destroy resources when done

## Reducing Manual Approvals

Common bash patterns that need pre-approval in settings.local.json:
- Variable assignments: `SERVER_IP=*`, `WORKER*=*`, `RESULT=*`, `DB_PASS=*`
- Control flow: `for:*`, `while:*`, `if:*`, `then:*`, `else:*`, `do`, `done`, `fi`
- Commands: `sleep:*`, `tail:*`, `head:*`, `cd:*`, `watch:*`, `docker:*`
- Cloud CLIs: `oci:*`, `aws:*`, `az:*`, `gcloud:*`, `terraform:*`
- Comments: `#:*` (commands starting with comments)

## Session Handoff Checklist

When session ends or context compacts:
1. Update test-results.md with new data
2. Add new learnings to appropriate file
3. Note current infrastructure state (what's deployed)
4. Document any credentials/IPs discovered
5. Commit skill updates if significant changes
