# Cracking Optimization

Task prioritization, cross-reference strategy, and worker allocation.

## Priority Hierarchy

| Priority | Task Type | Description |
|----------|-----------|-------------|
| 150 | rockyou+OneRule | Primary large wordlist + rules |
| 140 | cracked+OneRule | Variations of cracked passwords |
| 130 | Cross-reference | Cracked passwords against other hash types |
| 110 | top100k+OneRule | Smaller wordlist + rules |
| 80 | Basic Wordlist | Simple wordlist attacks |
| 70 | Brute Force | Exhaustive search (targeted only) |
| 60 | Low-priority crossref | Background tasks |

## Cross-Reference Strategy

**Key Insight:** Password reuse catches 30-40% of additional cracks.

**Process:**
1. Start with fast hashes (MD5, NTLM)
2. Run rockyou+OneRule to build cracked passwords list
3. IMMEDIATELY apply cracked passwords to ALL hash types
4. For slow hashes (SHA512crypt), crossref is MORE effective than direct attack

**Test Results (AWS):**
| Hash Type | Direct Attack | Cross-Reference |
|-----------|---------------|-----------------|
| MD5 | 44% | N/A (fast hash) |
| SHA512crypt | 0.2% | 7% (crossref found 96% of cracks!) |

## Worker Allocation

| Config | Agents | Strategy |
|--------|--------|----------|
| 4 workers | 3+1 | 3 on large tasks, 1 on crossref |
| 8+ workers | 6+2 | 6 on large tasks, 2 on small/crossref |

**isSmall flag usage:**
- Small wordlists (<1M words): `isSmall=1` (single agent)
- Cross-reference tasks: `isSmall=1` (high value, small wordlist)
- Large wordlists: `isSmall=0` (benefit from parallelization)
- Brute force: `isSmall=0` (parallelization essential)

## Attack Feasibility Calculations

**Before creating brute force tasks, calculate time:**

| Keyspace | 4 workers @ 10 MH/s | Feasible in 24h? |
|----------|---------------------|------------------|
| 6 chars (62^6) | ~14 minutes | Yes |
| 7 chars (62^7) | ~15 hours | Yes |
| 8 chars (62^8) | ~39 days | No |

**Formula:**
```
Time (seconds) = Keyspace / (Workers × Speed)
```

## Dynamic Reprioritization

When stuck, adjust priorities:

```sql
-- Boost variation attacks
UPDATE Task SET priority = 140 WHERE taskName LIKE '%cracked-OneRule%';
UPDATE TaskWrapper SET priority = 140 WHERE taskWrapperId IN
  (SELECT taskWrapperId FROM Task WHERE taskName LIKE '%cracked-OneRule%');

-- Lower stalled tasks
UPDATE Task SET priority = 50 WHERE keyspaceProgress < keyspace * 0.01
  AND TIMESTAMPDIFF(HOUR, FROM_UNIXTIME(0), NOW()) > 1;
```

## Password Policy Awareness

Ask about policy before creating attacks:

| Platform | Typical Policy | Attack Adjustment |
|----------|----------------|-------------------|
| Unix/Linux | Often none | Include simple passwords |
| Windows AD | 8+ chars, 3 of 4 classes | Skip pure lowercase |
| Web apps | Varies | Check requirements |
