# ExpandedPasswordList Permission Consolidation

## Purpose

This document defines bash command patterns that are safe to pre-approve for the ExpandedPasswordList pipeline. Pre-approving these reduces human intervention while maintaining security.

---

## Recommended Bash Prompts

Add these to your Claude Code settings (`~/.claude/settings.json`) under `allowedPrompts`:

```json
{
  "allowedPrompts": [
    {
      "tool": "Bash",
      "prompt": "Run ExpandedPasswordList tools (CrackSubmitter, AgentManager, PipelineMonitor, SafeArchiver, ResultCollector)"
    },
    {
      "tool": "Bash",
      "prompt": "Check Hashtopolis server status and database queries"
    },
    {
      "tool": "Bash",
      "prompt": "Get Hashcrack terraform outputs (server_ip, db_password)"
    },
    {
      "tool": "Bash",
      "prompt": "Check AWS EC2 instance status"
    },
    {
      "tool": "Bash",
      "prompt": "SSH to workers for agent service management"
    }
  ]
}
```

---

## Command Pattern Categories

### Category 1: Skill Tools (SAFE - Always Approve)

These are the primary tools for pipeline operation:

```bash
# Pipeline monitoring
bun Tools/PipelineMonitor.ts
bun Tools/PipelineMonitor.ts --quick
bun Tools/PipelineMonitor.ts --fix

# Agent management
bun Tools/AgentManager.ts
bun Tools/AgentManager.ts --status
bun Tools/AgentManager.ts --fix

# Batch submission
bun Tools/CrackSubmitter.ts --batch N --workers 8

# Safe archiving
bun Tools/SafeArchiver.ts --check batch-XXXX
bun Tools/SafeArchiver.ts --batch batch-XXXX

# Result collection
bun Tools/ResultCollector.ts
```

**Why safe:** These tools have built-in validation and safeguards.

### Category 2: Terraform Queries (SAFE - Always Approve)

```bash
# Get server IP
terraform output -raw server_ip

# Get database password (for SSH tunneling)
terraform output -raw db_password
```

**Why safe:** Read-only queries that don't modify infrastructure.

### Category 3: Server Health Checks (SAFE - Always Approve)

```bash
# Disk space
ssh ubuntu@SERVER "df -h /"

# Memory usage
ssh ubuntu@SERVER "free -h"

# Docker status
ssh ubuntu@SERVER "sudo docker ps"

# Database queries (read-only)
ssh ubuntu@SERVER "sudo docker exec hashtopolis-db mysql ... -sNe 'SELECT ...'"
```

**Why safe:** Read-only monitoring commands.

### Category 4: Agent Service Management (SAFE - Always Approve)

```bash
# Check agent service status
ssh ubuntu@WORKER "sudo systemctl status hashtopolis-agent"

# Restart agent (after lock.pid removal)
ssh ubuntu@WORKER "sudo systemctl restart hashtopolis-agent"

# View agent logs
ssh ubuntu@WORKER "sudo journalctl -u hashtopolis-agent -n 20"

# Remove stale lock file
ssh ubuntu@WORKER "sudo rm -f /opt/hashtopolis-agent/lock.pid"
```

**Why safe:** Standard service management for known agents.

### Category 5: AWS Read-Only Queries (SAFE - Always Approve)

```bash
# Get instance info
aws ec2 describe-instances --filters "Name=tag:Name,Values=*gpu*"

# Get worker IPs
aws ec2 describe-instances --query "Reservations[*].Instances[*].[InstanceId,PublicIpAddress]"
```

**Why safe:** Read-only AWS queries.

---

## Commands Requiring Approval (DO NOT Pre-Approve)

These commands have side effects and should require explicit approval:

### Infrastructure Changes
```bash
# DO NOT pre-approve
terraform apply
terraform destroy
aws ec2 start-instances
aws ec2 stop-instances
aws ec2 reboot-instances
```

### Database Modifications
```bash
# DO NOT pre-approve
ssh ubuntu@SERVER "... mysql ... -e 'UPDATE ...'"
ssh ubuntu@SERVER "... mysql ... -e 'DELETE ...'"
ssh ubuntu@SERVER "... mysql ... -e 'INSERT ...'"
```

### File Deletions
```bash
# DO NOT pre-approve (except lock.pid)
rm -rf
rm -f (except lock.pid pattern)
```

---

## Session Workflow Permissions

For a typical session, approve these at session start:

1. **"Run ExpandedPasswordList tools"** - Covers all bun commands in Tools/
2. **"Check Hashtopolis server status"** - Covers SSH read-only queries
3. **"Get terraform outputs"** - Covers terraform output commands

This reduces ~50+ approval prompts to ~3 session-level approvals.

---

## Implementation in Claude Code

### Option 1: Settings File

Edit `~/.claude/settings.json`:

```json
{
  "permissions": {
    "bash": {
      "autoApprove": [
        "bun Tools/*.ts",
        "terraform output",
        "ssh ubuntu@* systemctl status",
        "ssh ubuntu@* journalctl",
        "aws ec2 describe-instances"
      ]
    }
  }
}
```

### Option 2: Skill-Level Permissions

Add to the skill's `settings.local.json`:

```json
{
  "skillPermissions": {
    "ExpandedPasswordList": {
      "bashPatterns": [
        "bun Tools/*.ts*",
        "terraform output*",
        "ssh ubuntu@* sudo docker exec hashtopolis-db mysql*SELECT*"
      ]
    }
  }
}
```

---

## Approval Audit Log

Commands approved in session 2026-02-01:

| Count | Pattern | Purpose |
|-------|---------|---------|
| 12 | `bun Tools/CrackSubmitter.ts --batch N` | Batch submission |
| 8 | `bun Tools/AgentManager.ts` | Agent status checks |
| 6 | `ssh ubuntu@SERVER "... mysql ... SELECT ..."` | Database queries |
| 4 | `terraform output -raw server_ip` | Get server IP |
| 4 | `terraform output -raw db_password` | Get credentials |
| 3 | `ssh ubuntu@WORKER "systemctl status"` | Agent service checks |
| 2 | `aws ec2 describe-instances` | Instance mapping |

**Total unique patterns: 7**
**Total prompts: 39**

Pre-approving these 7 patterns would reduce interruptions by ~95%.

---

## Maintenance

Update this document when:
1. New tools are added to the skill
2. New safe command patterns are identified
3. Security requirements change
