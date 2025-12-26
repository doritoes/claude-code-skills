# Scale Workflow

Dynamically adjust worker count during operation.

## Trigger

- "add workers"
- "scale up"
- "scale down"
- "need more workers"

## Use Cases

### Scale Up
- Job taking too long
- More resources available
- Urgent deadline

### Scale Down
- Job nearly complete
- Save costs
- Workers sitting idle

## Execution

```bash
# Scale to specific count
hashcrack scale --workers 10

# Double current workers
hashcrack scale --workers $(( $(hashcrack status | grep "Workers:" | grep -o '[0-9]*' | head -1) * 2 ))
```

## How It Works

1. Update `worker_count` in Terraform variables
2. Run `terraform apply`
3. New workers boot with cloud-init
4. Workers auto-register with server via voucher
5. Hashtopolis distributes work to new workers

## Timing

| Action | Time |
|--------|------|
| Terraform apply | 1-2 min |
| VM boot | 2-3 min |
| Cloud-init | 3-5 min |
| Agent registration | 1 min |
| **Total scale-up** | **7-11 min** |

Scale-down is faster (VM deletion): 1-2 min

## Hashtopolis Behavior

When workers are added:
- New agents appear in "Agents" list
- Trust new agents to assign work
- Work is automatically distributed
- No job restart required

When workers are removed:
- Active chunks are redistributed
- No data loss
- Remaining workers continue

## CLI Usage

```bash
# Scale to 5 workers
hashcrack scale --workers 5

# Scale to 20 workers
hashcrack scale --workers 20

# Scale down to 2 workers
hashcrack scale --workers 2

# Remove all workers (keep server)
hashcrack scale --workers 0
```

## Cost Optimization

### During Attack Phases

| Phase | Recommended Workers |
|-------|---------------------|
| Quick wordlist | 2-3 |
| Rules + wordlist | 5-10 |
| Mask attacks | 10-20 |
| Extended brute | Maximum available |

### By Hash Type

| Hash Type | Complexity | Workers |
|-----------|------------|---------|
| MD5, NTLM | Fast | 3-5 |
| SHA256 | Medium | 5-10 |
| sha512crypt | Slow | 10-20 |
| bcrypt | Very slow | Maximum |

## Monitoring After Scale

```bash
# Watch workers come online
watch -n 5 'hashcrack status'
```

## Limitations

- Maximum workers depend on XCP-ng resources
- Cloud providers may have instance limits
- Network bandwidth may bottleneck at high scale
- Hashtopolis server may need more resources for 50+ workers
