# Crack Workflow

Submit password hashes for distributed cracking.

## Trigger

- "crack hashes"
- "submit job"
- "crack these passwords"

## Prerequisites

1. **Hashtopolis deployed** (run Deploy workflow first)
2. **API key configured** in `.claude/.env`
3. **Hash file** or hashes to paste

## Execution Steps

### Step 1: Validate Input

Accept hashes from:
- File path (`--input /path/to/hashes.txt`)
- Piped stdin (`cat hashes.txt | hashcrack crack`)
- Direct paste in terminal

### Step 2: Detect Hash Type

Auto-detection based on:
- Hash length (32=MD5/NTLM, 40=SHA1, 64=SHA256)
- Hash prefix ($6$=sha512crypt, $2a$=bcrypt)

Override with `--type`:
```bash
hashcrack crack --input hashes.txt --type ntlm
```

### Step 3: Connect to Hashtopolis

Verify server connectivity:
```bash
bun run tools/HashtopolisClient.ts test
```

### Step 4: Create Hashlist

Upload hashes to Hashtopolis:
```typescript
const hashlistId = await client.createHashlist({
  name: "job-2025-12-25",
  hashTypeId: 1000,  // NTLM
  hashes: hashArray
});
```

### Step 5: Configure Attack Strategy

| Strategy | Description |
|----------|-------------|
| `quick` | rockyou.txt only |
| `comprehensive` | Wordlists + best64 rules + masks |
| `thorough` | All above + heavy rules + extended masks |

### Step 6: Create Tasks

For comprehensive strategy:
```
Task 1: Wordlist - rockyou (priority 100)
Task 2: Wordlist + Rules - best64 (priority 90)
Task 3: Common Masks (priority 80)
```

### Step 7: Monitor Progress

```bash
hashcrack status
```

Output:
```
Job: job-2025-12-25
Progress: 4,521/10,000 (45.2%)
Speed: 1.2 GH/s
Active Tasks: 2
```

## CLI Usage

```bash
# From file
hashcrack crack --input /pentest/hashes.txt --type ntlm

# From stdin
cat extracted_hashes.txt | hashcrack crack --type sha512crypt

# With custom strategy
hashcrack crack --input hashes.txt --type ntlm --strategy thorough

# With job name
hashcrack crack --input hashes.txt --type md5 --name "client-audit-2025"
```

## Security

- Hashes are transmitted to server over HTTPS
- Cracked passwords are NEVER displayed in terminal
- Results saved to `.claude/.env` (base64 encoded)
- View actual passwords in Hashtopolis UI only

## Output

```
╔════════════════════════════════════════════════════════════╗
║                    JOB SUBMITTED                            ║
╚════════════════════════════════════════════════════════════╝

  Job Name:    client-audit-2025
  Hashlist ID: 42
  Hash Count:  10,000
  Hash Type:   ntlm (1000)
  Strategy:    comprehensive
  Tasks:       3
```

## Supported Hash Types

| Type | ID | Command |
|------|-----|---------|
| MD5 | 0 | `--type md5` |
| SHA1 | 100 | `--type sha1` |
| SHA256 | 1400 | `--type sha256` |
| NTLM | 1000 | `--type ntlm` |
| sha512crypt | 1800 | `--type sha512crypt` |
| bcrypt | 3200 | `--type bcrypt` |
| NetNTLMv2 | 5600 | `--type netntlmv2` |
