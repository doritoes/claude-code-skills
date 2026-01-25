# Results Workflow

Retrieve and securely store cracked passwords.

## Trigger

- "get results"
- "cracked passwords"
- "what did we crack"

## Security Protocol

**CRITICAL**: Cracked passwords are NEVER displayed in the terminal.

Instead:
1. Results are retrieved from Hashtopolis API
2. Encoded as base64 JSON
3. Saved to `.claude/.env`
4. User views actual passwords in Hashtopolis UI

## Execution

```bash
hashcrack results
```

## Output

```
╔════════════════════════════════════════════════════════════╗
║                    RESULTS SAVED                            ║
╚════════════════════════════════════════════════════════════╝

  Cracked: 6,847 passwords
  Saved to: .claude/.env (HASHCRACK_RESULTS_2025-12-25T10-30-00)

  For security, passwords are NOT displayed here.
  Log in to Hashtopolis UI to view: https://192.168.99.101:8080
```

## Storage Format

Results are stored in `.claude/.env` as:

```bash
HASHCRACK_RESULTS_2025-12-25T10-30-00=eyJoYXNoIjoiYWFkM2I0MzViNTE0...
```

To decode (for authorized access only):
```bash
echo "$HASHCRACK_RESULTS_2025-12-25T10-30-00" | base64 -d | jq
```

## API Query

```typescript
const cracked = await client.getCrackedHashes(hashlistId);
// Returns: Array<{ hash: string, plain: string }>
```

## Viewing Results

### Option 1: Hashtopolis UI (Recommended)

1. Open server URL in browser
2. Login with admin credentials
3. Navigate to Hashlists
4. Click on hashlist
5. View cracked hashes

### Option 2: Export from Hashtopolis

In Hashtopolis UI:
1. Go to Hashlists
2. Select hashlist
3. Click "Export Cracked"
4. Download file

### Option 3: Decode from .env (CLI)

```bash
# Extract and decode
grep "HASHCRACK_RESULTS" ~/.claude/.env | \
  cut -d'=' -f2 | \
  base64 -d | \
  jq -r '.[] | "\(.hash):\(.plain)"' > cracked.txt
```

## Audit Trail

All results retrievals are logged to `History/`:
- Timestamp
- Hashlist ID
- Number of cracked hashes
- User who retrieved

## Cleanup

After audit is complete and results are documented:

```bash
# Remove results from .env
sed -i '/HASHCRACK_RESULTS/d' ~/.claude/.env
```
