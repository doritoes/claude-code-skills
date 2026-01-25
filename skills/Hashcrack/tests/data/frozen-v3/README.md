# Frozen Smoke Test Data v3

**Frozen Date:** 2026-01-19
**Purpose:** Authoritative test data for Hashcrack skill smoke tests

## Test Results Summary

All 5 providers passed with this data:

| Provider | Workers | Cracked | Time | Status |
|----------|---------|---------|------|--------|
| XCP-ng   | 2/2     | 10/10   | 352s | PASS   |
| Proxmox  | 2/2     | 10/10   | 463s | PASS   |
| AWS      | 2/2     | 10/10   | 149s | PASS   |
| Azure    | 2/2     | 10/10   | 219s | PASS   |
| GCP      | 2/2     | 10/10   | 158s | PASS   |

## Files

| File | Size | Purpose |
|------|------|---------|
| smoke-wordlist.txt | 150,000 words | Main wordlist |
| smoke-rules.rule | 561 rules | Hashcat rules |
| smoke-hashes.txt | 10 hashes | SHA256 test hashes |
| smoke-passwords.txt | 10 passwords | Plaintext answers |
| generate-expanded-wordlist.ts | - | Generator script |

## Keyspace

- **Words:** 150,000
- **Rules:** 561
- **Total Keyspace:** 84,150,000 (84.15M)

## Passwords and Distribution

Passwords are distributed across the wordlist to ensure both workers receive crackable passwords:

| Password | Position | Percentage |
|----------|----------|------------|
| 1993 | ~901 | 0.6% |
| angel04 | ~9,451 | 6.3% |
| bella27 | ~18,901 | 12.6% |
| coolsebastian | ~37,801 | 25.2% |
| felix11 | ~56,701 | 37.8% |
| jennifer2025 | ~75,451 | 50.3% |
| lovejean | ~94,351 | 62.9% |
| october2011 | ~113,251 | 75.5% |
| sexy666 | ~132,151 | 88.1% |
| virtual | ~146,251 | 97.5% |

## Hash Details

- **Algorithm:** SHA256 (hashcat mode 1400)
- **Format:** Raw SHA256 hex (64 characters)

## Why This Keyspace?

Previous tests with smaller keyspaces (8.9M, 28M) failed with SINGLE_WORKER_ONLY because:
- SHA256 on CPU achieves 2M+ H/s benchmark speeds
- With chunkTime=5s, each chunk covers ~10M keyspace
- Small keyspaces create only 1-2 chunks, so fast worker grabs all

With 84M keyspace and 5s chunkTime:
- Creates ~8 chunks at 2M H/s
- Both workers have time to benchmark and receive work
- Passwords distributed ensures both workers crack some

## Usage

These files are the authoritative source for smoke tests. Do not modify.

To regenerate (if needed):
```bash
cd .claude/skills/Hashcrack/tests/data
bun run generate-expanded-wordlist.ts
```

## Hashes ↔ Passwords Mapping

```
8e71b24534e9f3fb3a71263359fed2b7ffb008265e0d34383e319f1b6f5c08f2 : 1993
59f7c5dafe96a18dc8f65abc27a2deffedc98d65e09505cbcfcefdb0def24737 : angel04
bf0dd9ffaa602411151fef6d134dd6ac6560cf3770a9d1fc8f336e0330ac4d97 : bella27
b4958adac5b98017337fcc9c379436c452cec40edb68c38ae810abf43bfecbb7 : coolsebastian
467d8a6980dcea01917be8e1683f87c4632d91d171930b858e097cf375b7f830 : felix11
7c55870693324b02fdc1757061e36dc70dda78456d40ced5b7da667b00083394 : jennifer2025
505b972cc226e137ed7abb1cdfb110c4640c772d297ed9195fe0b51bccd62a6f : lovejean
5d68d5debdd75469c62b9dc75f48db62acf361c1d5abd49e8f95b38a8a326b52 : october2011
7a3f91c8785b7db11a08f8a385367d63b423528bd9a744d5ab34de62f63823a7 : sexy666
e2efdd7db924f31dc81b659db07e6eba303497f110acbe8dddb8c13f2e3786d7 : virtual
```
