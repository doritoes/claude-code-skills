# Changelog

All notable changes to the Hashcrack skill will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-01-24

### Added
- Initial public release
- Support for 6 providers: AWS, Azure, GCP, OCI, Proxmox, XCP-ng
- GPU worker support on cloud providers (AWS, Azure, GCP, OCI)
- Parallel rule attack support via hash splitting
- Comprehensive workflow documentation with GATE checkpoints
- Smoke test framework (smoke-test-v3.ts)
- Provider-specific learnings documentation
- Anti-patterns documentation to prevent common failures

### Infrastructure
- Terraform configurations for all 6 providers
- Cloud-init scripts for automated Hashtopolis deployment
- Auto-generated vouchers (N per N workers)
- Spot/preemptible instance support

### Documentation
- SKILL.md with complete reference
- SETUP.md installation guide
- Provider-specific deployment workflows
- PARALLELIZATION.md for scaling guidance
- TROUBLESHOOTING.md for common issues

### Performance Benchmarks
- AWS GPU: ~25 GH/s (T4)
- XCP-ng CPU: ~40 MH/s (4 workers)
- OCI CPU: ~62 MH/s (4 workers, 32 vCPU)
- GCP CPU: ~40 MH/s (4 workers)
- Azure CPU: ~40 MH/s (4 workers)

## [0.9.0] - 2026-01-19

### Added
- Multi-provider parallel testing
- useNewBench detection for benchmark format
- ignoreErrors=1 for rule attack stability

### Fixed
- File staging path: `/usr/local/share/hashtopolis/files/`
- isSecret=1 required for trusted agent downloads
- maxAgents=1 for parallel rule attack distribution

## [0.8.0] - 2026-01-14

### Added
- OCI provider support
- Proxmox provider support
- Benchmark format detection

### Fixed
- Cloud-init password escaping issues
- Voucher race conditions (N vouchers for N workers)

## [0.7.0] - 2026-01-10

### Added
- GCP provider with Cloud NAT support
- Azure provider with spot instances
- AWS provider with spot instances

### Changed
- Switched from API to database for hashlist creation (API unreliable)

## [0.6.0] - 2026-01-05

### Added
- XCP-ng provider (initial)
- HashcrackCLI.ts orchestrator
- HashtopolisClient.ts API client
- InputParsers.ts format detection

### Documentation
- Initial SKILL.md
- Workflow documentation
