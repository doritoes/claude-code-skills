# Anti-Patterns to Avoid

Common mistakes that cause failures or wasted time.

## Task/Agent Anti-Patterns

| Anti-Pattern | Why It Fails | Correct Approach |
|--------------|--------------|------------------|
| Manual Assignment table insert | Bypasses task initialization | Use API createTask or database TaskWrapper+Task |
| Deleting tasks | Breaks references | Archive instead: `SET isArchived=1, priority=0` |
| Trusting agents after file upload | Files default to secret | Trust agents FIRST, then upload |
| Single voucher for all workers | Race conditions | One voucher per worker |
| Priority = 0 tasks | Won't dispatch | Use priority >= 10 |

## Infrastructure Anti-Patterns

| Anti-Pattern | Why It Fails | Correct Approach |
|--------------|--------------|------------------|
| Destroying working workers to fix broken ones | Loses progress | Taint broken workers only |
| NAT Gateway for file downloads | Expensive ($30-45/month) | Server as file proxy |
| HTTPS for Hashtopolis | No cert setup | Use HTTP on port 8080 |
| Static IPs with DHCP enabled | Wrong IP in config | Use actual DHCP-assigned IP |

## Code/Automation Anti-Patterns

| Anti-Pattern | Why It Fails | Correct Approach |
|--------------|--------------|------------------|
| Waiting fixed time for cloud-init | May finish earlier or later | Check completion signal |
| Hardcoded DB password | Auto-generated | Get from container env |
| API v2 endpoints | Broken in 0.14.x | Use API v1 |
| Special chars in cloud-init passwords | YAML/shell escaping | Alphanumeric only |

## Attack Strategy Anti-Patterns

| Anti-Pattern | Why It Fails | Correct Approach |
|--------------|--------------|------------------|
| Overfitted masks (from cracked passwords) | Wastes compute on unlikely matches | Generic patterns only |
| Brute force 8+ chars without estimate | Takes too long | Calculate feasibility first |
| Single wordlist for all hash types | Misses cross-reference | Run cracked passwords against all types |
| Ignoring password policy | Attacks impossible passwords | Ask about policy first |

## Recovery from Anti-Patterns

**Task stuck (wrong Assignment):**
```sql
DELETE FROM Assignment WHERE agentId = X;
UPDATE Chunk SET state = 0, agentId = NULL WHERE agentId = X;
```

**Workers destroyed with chunks in progress:**
```sql
UPDATE Chunk SET state = 0, agentId = NULL WHERE state IN (2, 4);
```

**Stale agents after worker rebuild:**
```sql
DELETE FROM Assignment WHERE agentId = OLD_ID;
UPDATE Agent SET isActive = 0 WHERE agentId = OLD_ID;
```
