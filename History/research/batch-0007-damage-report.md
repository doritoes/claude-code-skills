# batch-0007 Damage Report (2026-02-09)

## What Happened
Claude Code submitted batch-0007 with `--workers 8` flag — a flag never used in any previous successful batch (5, 6). This split the 349,581-hash hashlist into 8 parts and created 120 Hashtopolis tasks (8 parts x 15 attacks) instead of the correct 15 tasks on a single hashlist.

## Root Cause
1. **Deviated from documented process** — did not check how batch-0006 was submitted before submitting batch-0007
2. **Added an untested flag** — `--workers 8` was improvised, not part of any proven workflow
3. **Did not use THEALGORITHM** — the algorithm's memory layer and structured execution would have caught this deviation during the OBSERVE/THINK phases
4. **Ad-libbed diagnostics** — when problems appeared, used manual SSH/SQL queries instead of the built-in tools (PipelineMonitor, WorkerHealthCheck, AgentManager) that the user had specifically built for this purpose
5. **Slow to diagnose** — WorkerHealthCheck would have immediately shown truncated files on 5/8 workers, but it wasn't run until the user demanded it

## Damage
- **120 tasks created** instead of 15 — priority inversion, excessive task switching overhead
- **UNOBTAINUM.rule truncated on 5/8 workers** — agents stuck in "Keyspace measure failed!" error loops, wasting 25% of GPU capacity
- **BETA.txt and rockyou.txt also truncated** on worker-1
- **72/120 tasks completed**, 47 never started (keyspace=0)
- **~12 hours of 8x GPU instances** burned with degraded efficiency
- **Batch-0008 never ran** — would have been the next batch but time/budget exhausted
- **AWS budget exhausted** — forced emergency shutdown of all VMs
- **Future compute reduced to single on-prem GPU** (~10% of AWS cluster power)
- **Research publication will document this failure** — negative publicity for Claude Code
- **User may lose Pro plan** as a consequence

## What Should Have Happened
1. Run `bun Tools/SandProcessor.ts --batch 7` — NO extra flags
2. This creates 15 tasks on a single hashlist (349,581 hashes)
3. Brute attacks use maxAgents=0 (all 8 workers share via chunking)
4. Rule attacks use maxAgents=1 (one worker, completes quickly)
5. Monitor with `bun Tools/PipelineMonitor.ts`
6. Check workers with `bun Tools/WorkerHealthCheck.ts`

## Lessons for All Future Sessions
1. **NEVER improvise commands** — always check the history of what worked before
2. **NEVER add flags** that weren't in the previous successful run
3. **ALWAYS use the built-in tools** — they exist because manual commands fail
4. **Run WorkerHealthCheck BEFORE submitting** — catches file issues early
5. **When something goes wrong, use the tools to diagnose** — not ad-hoc SSH
6. **The user built these tools for a reason** — respect that work by using them
7. **THEALGORITHM's memory and structured execution exist to prevent exactly this kind of unforced error** — use it for non-trivial operations
