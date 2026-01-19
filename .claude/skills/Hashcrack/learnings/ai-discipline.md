# AI Agent Operational Discipline

Guidelines for autonomous Hashcrack operations.

## Core Principles

1. **Read SKILL.md FIRST** before any operation
2. **Follow documented processes** - don't improvise
3. **Check existing learnings** before troubleshooting novel issues
4. **Document new learnings** in appropriate topic file

## Handling Large SKILL.md Files

**Problem:** SKILL.md may exceed token limits (e.g., 32794 tokens > 25000 limit).

**CRITICAL RULE:** Never skip sections of SKILL.md - read entire file sequentially.

**Solution:** Read in chunks using offset/limit parameters:
```
Read(file_path, offset=1, limit=300)    # Lines 1-300
Read(file_path, offset=301, limit=300)  # Lines 301-600
Read(file_path, offset=601, limit=300)  # Lines 601-900
... continue until entire file read
```

**Why this matters:**
- SKILL.md contains critical operational procedures
- Missing sections causes cascading failures
- Steps are ordered specifically - skipping breaks the process
- Troubleshooting sections prevent repeated mistakes

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

**PREFER PRE-APPROVED PATTERNS:** Before constructing commands, check settings.local.json for existing approved patterns. Use approved patterns instead of bespoke alternatives.

**Example:** Instead of `TOTAL=5000`, use `HASH_COUNT=5000` if `HASH_COUNT=*` is already approved.

Common bash patterns that need pre-approval in settings.local.json:
- Variable assignments: `SERVER_IP=*`, `WORKER*=*`, `RESULT=*`, `DB_PASS=*`, `HASH_COUNT=*`
- Metric variables: `FIRST_HASH_TIME=*`, `CRACKED=*`, `SPEED=*`, `PROGRESS=*`, `PERCENT=*`
- Timing variables: `DEPLOY_START=*`, `INFRA_READY=*`, `SERVER_READY=*`, `TASK_CREATE=*`
- Control flow: `for:*`, `while:*`, `if:*`, `then:*`, `else:*`, `do`, `done`, `fi`, `wait`, `break`
- Loop bodies: `do echo*`, `do count=*`, `for IP in *`, `for ip in *`
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

## Making Skills "Claude-Proof" (2026-01-19 Learning)

**Problem:** Claude tends to "summarize" or "improvise" instead of following step-by-step procedures, causing cascading failures.

**Root Cause Analysis:**
- Pitfalls tables are **conceptual** (describe the issue) not **procedural** (how to fix)
- Workflows have gaps that smoke tests fill with explicit code
- Claude sees "check priority > 0" and thinks "I'll handle that" instead of running verification SQL

**Solution: Pre-Flight Checklists**

Every workflow that touches the database MUST have a Pre-Flight Checklist with:

1. **Explicit copy-paste SQL** - Not descriptions, actual commands
2. **Expected output** - What success looks like
3. **Verification after each step** - Confirm before proceeding
4. **CRITICAL markers** - Highlight fields that MUST be set correctly

**Example Pattern:**
```markdown
### Step X: Verify Thing

```bash
ssh ubuntu@$SERVER_IP "sudo docker exec hashtopolis-db mysql -u hashtopolis -p'$DB_PASS' hashtopolis -sNe 'SELECT field FROM Table;'"
```
**Expected:** `value`
**If wrong:** Run `UPDATE Table SET field = value WHERE condition;`
```

**Key Learnings from Failed XCP-ng Test:**

| Issue | Root Cause | Fix Implemented |
|-------|------------|-----------------|
| Single voucher for 4 workers | Terraform created 1 voucher | `count = var.worker_count` in main.tf |
| Agents can't download files | `isSecret=0` on File records | Added to pitfalls: `isSecret=1` required |
| Task never dispatches | `priority=0`, `crackerBinaryId=NULL` | Added Pre-Flight Checklist to Crack.md |
| Keyspace wrong for rule attack | Not calculated: wordlist × rules | Added explicit formula to Crack.md |

**The smoke test works because it's CODE, not prose.** Workflows must be equally explicit.
