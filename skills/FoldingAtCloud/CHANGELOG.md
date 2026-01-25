# Changelog

All notable changes to FoldingAtCloud will be documented in this file.

## [1.0.0] - 2026-01-25

### Added
- Initial public release
- Multi-cloud support: Azure, AWS, GCP, OCI
- GPU one-shot mode for AWS and GCP (NVIDIA T4/L4)
- CPU multi-worker mode for Azure and OCI
- Two-phase boot for GPU driver installation
- Graceful shutdown via `lufah finish`
- One-shot completion monitor
- Budget tracking tool
- Worker control tool
- Comprehensive learnings documentation

### Features
- FAH v8.5.5 client deployment
- Ubuntu 24.04 LTS base image
- lufah CLI integration
- Websocket retry logic for reliable configuration
- Terraform infrastructure as code

### Anti-Patterns Documented
- Never use spot/preemptible instances
- Never start FAH before GPU driver loaded
- Never scale down without graceful shutdown
- Always wait for FAH websocket before lufah commands

### Cloud Providers
| Provider | Mode | GPU Support |
|----------|------|-------------|
| Azure | Multi-worker CPU | No |
| AWS | One-shot GPU | Yes (T4) |
| GCP | One-shot GPU | Yes (T4/L4) |
| OCI | Multi-worker CPU | No |

---

## Future Roadmap

### Planned
- [ ] ARM-based OCI A1.Flex support
- [ ] Azure GPU instances
- [ ] Budget-triggered auto scale-down
- [ ] Cloud provider cost monitoring integration
- [ ] Multi-GPU instance support
