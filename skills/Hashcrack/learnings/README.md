# Hashcrack Learnings Index

Quick-reference index to topic-specific learnings. Read only what you need.

## Index

| File | Topic | When to Read |
|------|-------|--------------|
| [deployment.md](deployment.md) | Passwords, vouchers, API keys, SSH, cloud-init | Setting up new infrastructure |
| [api.md](api.md) | API v1 issues, workarounds, database patterns | Task/hashlist creation problems |
| [optimization.md](optimization.md) | Task prioritization, cross-reference, worker allocation | Planning attack strategies |
| [anti-patterns.md](anti-patterns.md) | Common mistakes to avoid | Before any major operation |
| [teardown.md](teardown.md) | Worker cleanup, agent cleanup, chunk recovery | Destroying/scaling infrastructure |
| [aws.md](aws.md) | AWS spot instances, GPU workers, networking | Deploying to AWS |
| [azure.md](azure.md) | Azure VMs, spot instances, NAT | Deploying to Azure |
| [gcp.md](gcp.md) | GCP Cloud NAT, quotas, preemptible | Deploying to GCP |
| [oci.md](oci.md) | OCI setup, free tier, shapes | Deploying to OCI |
| [proxmox.md](proxmox.md) | Proxmox/XCP-ng local deployment | Deploying to local hypervisors |
| [test-results.md](test-results.md) | Test session results, performance data | Comparing providers |
| [ai-discipline.md](ai-discipline.md) | AI agent operational guidelines | Before autonomous operations |

## Quick Reference

### Most Common Issues

1. **Task not dispatching** → See [anti-patterns.md](anti-patterns.md) - check agents trusted, priority > 0
2. **Files not downloading** → See [deployment.md](deployment.md) - files must be in correct path
3. **API returns "Invalid query!"** → See [api.md](api.md) - use database for task creation
4. **Workers can't register** → See [deployment.md](deployment.md) - create vouchers first
5. **Benchmark fails (exit 255)** → See [proxmox.md](proxmox.md) - add `--force` for CPU workers

### Before Each Operation

| Operation | Read First |
|-----------|------------|
| New deployment | deployment.md, anti-patterns.md |
| Creating tasks | api.md, optimization.md |
| Scaling workers | teardown.md (for scale-down) |
| Cross-platform | Provider-specific file (aws/azure/gcp/oci/proxmox) |
| Destroying infrastructure | teardown.md |
