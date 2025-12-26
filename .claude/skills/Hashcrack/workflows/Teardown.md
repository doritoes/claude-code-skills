# Teardown Workflow

Destroy Hashcrack infrastructure in stages when the user is satisfied.

## Trigger

- "destroy workers"
- "destroy server"
- "teardown hashcrack"
- "cleanup"

## Two-Stage Teardown Process

**Stage 1: Destroy Workers** - When user is satisfied with cracking results
**Stage 2: Destroy Server** - When user is satisfied after viewing results in Hashtopolis UI

This allows the user to review results in the web UI before destroying everything.

---

## Stage 1: Destroy Worker VMs

### When to Execute
- All attack phases have completed
- User confirms they are satisfied with cracking results

### Pre-Destroy Checklist
- [ ] All tasks show 100% complete
- [ ] User has reviewed cracked hashes count
- [ ] User confirms: "destroy workers" or "I'm satisfied, destroy workers"

### Execution

```bash
cd ~/.claude/skills/Hashcrack/terraform

# Set worker count to 0 and apply
export TF_VAR_worker_count=0
terraform apply -auto-approve
```

### Verify
```bash
terraform output worker_count
# Should show: 0
```

**Server remains running** - User can still access Hashtopolis UI at http://<server-ip>:4200

---

## Stage 2: Destroy Hashtopolis Server

### When to Execute
- User has logged into Hashtopolis UI
- User has viewed/exported cracked passwords
- User confirms: "destroy server" or "I'm done, destroy everything"

### Pre-Destroy Checklist
- [ ] User has accessed Hashtopolis UI
- [ ] User has viewed results in Lists → Show Cracked
- [ ] User confirms they have what they need

### Execution

```bash
cd ~/.claude/skills/Hashcrack/terraform

# Full destroy
terraform destroy -auto-approve
```

### Clean Environment Variables

Remove from `.claude/.env`:
- `HASHCRACK_SERVER_URL`
- `HASHCRACK_API_KEY`
- `HASHCRACK_ADMIN_PASSWORD`
- `HASHCRACK_VOUCHER`

### Verify

```bash
terraform show
# Should show: No state
```

---

## Quick Reference

| User Says | Action |
|-----------|--------|
| "destroy workers" | Stage 1: Remove workers, keep server |
| "I'm satisfied with cracking" | Stage 1: Remove workers, keep server |
| "destroy server" | Stage 2: Remove server (full teardown) |
| "I'm done viewing results" | Stage 2: Remove server (full teardown) |
| "teardown everything" | Both stages in sequence |

---

## Recovery

If you accidentally teardown:

1. Run `hashcrack deploy` again
2. Re-submit hash jobs
3. Previous results in `.env` are preserved
