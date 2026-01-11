# Azure-Specific Learnings

## Instance Types

| Role | Size | Specs | Cost/hr |
|------|------|-------|---------|
| Server | Standard_D2s_v3 | 2 vCPU, 8GB | $0.096 |
| CPU Worker | Standard_D4s_v3 | 4 vCPU, 16GB | $0.192 |
| GPU Worker | Standard_NC4as_T4_v3 | T4 GPU | $0.526 |

## Spot Instances

- Use `use_spot_instances = true`
- Resource group cleanup can be slow
- NSG deletion may require retry

## Destroy Timing

Azure destroy can hit errors:
```
NetworkSecurityGroupOldReferencesNotCleanedUp
```
**Solution:** Wait 60 seconds and retry `terraform destroy`.

## SSH Key Requirements

- Azure accepts RSA keys (generated during deployment)
- ed25519 may require manual testing

## Networking

- Workers get private IPs only
- Use server as jump host: `ssh -J ubuntu@SERVER ubuntu@WORKER`
- **Avoid NAT Gateway** - $30-45/month

## Performance Notes

- Slowest CPU performance of cloud providers tested
- 9h 41m vs GCP's ~8h for same workload
- GPU performance comparable to AWS
