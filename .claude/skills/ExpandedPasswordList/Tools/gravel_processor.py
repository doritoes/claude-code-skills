#!/usr/bin/env python3
"""
gravel_processor.py - Stage 1: GRAVEL -> PEARLS + SAND on BIGRED

Processes all GRAVEL batches through nocap.txt + nocap.rule on BIGRED GPU.

Output:
  data/pearls/batch-NNNN.txt            Cracked plaintexts
  data/pearls/hash_plaintext_pairs.txt   hash:plaintext (append-only)
  data/sand/batch-NNNN.txt               Uncracked hashes

Usage:
  python Tools/gravel_processor.py              Run all pending batches
  python Tools/gravel_processor.py --status     Show progress
  python Tools/gravel_processor.py --no-resume  Restart from batch-0001
  python Tools/gravel_processor.py --dry-run    Preview without executing
"""

import os
import sys
import json
import time
import re
import subprocess
from pathlib import Path
from datetime import datetime

# =============================================================================
# Paths
# =============================================================================

SCRIPT_DIR = Path(__file__).resolve().parent
SKILL_DIR = SCRIPT_DIR.parent
PROJECT_ROOT = SKILL_DIR.parent.parent.parent  # .claude/skills/ExpandedPasswordList -> AI-Projects

DATA_DIR = SKILL_DIR / "data"
GRAVEL_DIR = DATA_DIR / "gravel"
PEARLS_DIR = DATA_DIR / "pearls"
SAND_DIR = DATA_DIR / "sand"
STATE_FILE = DATA_DIR / "gravel-state.json"
ENV_FILE = PROJECT_ROOT / ".claude" / ".env"

SHELL = r"C:\Program Files\Git\bin\bash.exe" if os.name == "nt" else "/bin/bash"

# Hashcat
HASH_TYPE = 100  # SHA-1
HASHCAT_TEMPLATE = (
    "hashcat -m {ht} hashlists/{batch}.txt "
    "wordlists/nocap.txt -r rules/nocap.rule "
    "--potfile-path potfiles/{batch}.pot -O -w 3 --status --status-timer 60"
)

# Timing
POLL_INTERVAL = 30       # seconds between status checks
MAX_WAIT = 4 * 3600      # 4 hours max per batch
SSH_TIMEOUT = 30          # seconds
RECONNECT_MAX = 300       # 5 min max reconnect wait


# =============================================================================
# Config
# =============================================================================

class BigRedConfig:
    def __init__(self):
        if not ENV_FILE.exists():
            raise FileNotFoundError(f".env not found: {ENV_FILE}")

        env = {}
        for line in ENV_FILE.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            eq = line.find("=")
            if eq > 0:
                env[line[:eq]] = line[eq + 1:]

        self.host = env.get("BIGRED_HOST", "")
        self.user = env.get("BIGRED_USER", "")
        ssh_key = env.get("BIGRED_SSH_KEY", "")
        self.work_dir = env.get("BIGRED_WORK_DIR", f"/home/{self.user}/hashcat-work")

        if not all([self.host, self.user, ssh_key]):
            raise ValueError("Missing BIGRED_HOST, BIGRED_USER, or BIGRED_SSH_KEY in .env")

        home = os.environ.get("HOME") or os.environ.get("USERPROFILE") or "~"
        self.ssh_key = ssh_key.replace("~", home)


# =============================================================================
# SSH / SCP
# =============================================================================

def ssh_cmd(config, cmd, timeout=SSH_TIMEOUT):
    escaped = cmd.replace('"', '\\"')
    full = (
        f'ssh -i "{config.ssh_key}" -o StrictHostKeyChecking=no '
        f'-o ConnectTimeout=10 {config.user}@{config.host} "{escaped}"'
    )
    r = subprocess.run(
        [SHELL, "-c", full],
        capture_output=True, text=True, timeout=timeout
    )
    if r.returncode != 0:
        raise RuntimeError(f"SSH failed: {cmd}\n{r.stderr.strip()}")
    return r.stdout.strip()


def scp_upload(config, local_path, remote_path, timeout=600):
    msys = str(local_path).replace("\\", "/")
    if os.name == "nt":
        msys = re.sub(r'^([A-Z]):', lambda m: f'/{m.group(1).lower()}', msys)
    cmd = (
        f'scp -i "{config.ssh_key}" -o StrictHostKeyChecking=no '
        f'"{msys}" {config.user}@{config.host}:{remote_path}'
    )
    r = subprocess.run(
        [SHELL, "-c", cmd],
        capture_output=True, text=True, timeout=timeout
    )
    if r.returncode != 0:
        raise RuntimeError(f"SCP upload failed: {local_path}\n{r.stderr.strip()}")


def scp_download(config, remote_path, local_path, timeout=600):
    msys = str(local_path).replace("\\", "/")
    if os.name == "nt":
        msys = re.sub(r'^([A-Z]):', lambda m: f'/{m.group(1).lower()}', msys)
    cmd = (
        f'scp -i "{config.ssh_key}" -o StrictHostKeyChecking=no '
        f'{config.user}@{config.host}:{remote_path} "{msys}"'
    )
    r = subprocess.run(
        [SHELL, "-c", cmd],
        capture_output=True, text=True, timeout=timeout
    )
    if r.returncode != 0:
        raise RuntimeError(f"SCP download failed: {remote_path}\n{r.stderr.strip()}")


def wait_for_connection(config, max_wait=RECONNECT_MAX):
    start = time.time()
    attempt = 0
    while time.time() - start < max_wait:
        attempt += 1
        try:
            ssh_cmd(config, "echo connected", timeout=15)
            print(f"  Reconnected after {attempt} attempt(s)")
            return True
        except Exception:
            elapsed = int(time.time() - start)
            wait = min(10 * attempt, 30)
            print(f"  Retry {attempt}: unreachable ({elapsed}s), waiting {wait}s...")
            time.sleep(wait)
    return False


# =============================================================================
# BIGRED Helpers
# =============================================================================

def get_potfile_count(config, batch):
    try:
        r = ssh_cmd(config, (
            f"test -f {config.work_dir}/potfiles/{batch}.pot && "
            f"wc -l < {config.work_dir}/potfiles/{batch}.pot || echo 0"
        ))
        return int(r) or 0
    except Exception:
        return 0


def is_hashcat_running(config):
    try:
        return int(ssh_cmd(config, "pgrep -c hashcat 2>/dev/null || echo 0")) > 0
    except Exception:
        return False


def is_screen_alive(config, name):
    try:
        return int(ssh_cmd(config, f"screen -ls 2>/dev/null | grep -c '{name}' || echo 0")) > 0
    except Exception:
        return False


def is_log_complete(config, log_file):
    try:
        r = ssh_cmd(config, (
            f"grep -c -E '^Status\\.\\.\\.+: (Exhausted|Cracked)' "
            f"{log_file} 2>/dev/null || echo 0"
        ), timeout=10)
        return int(r) > 0
    except Exception:
        return False


# =============================================================================
# State
# =============================================================================

def load_state():
    if STATE_FILE.exists():
        return json.loads(STATE_FILE.read_text())
    return {
        "version": "2.0",
        "attack": "nocap-nocaprule",
        "batches": {},
        "totalProcessed": 0,
        "totalPearls": 0,
        "totalSand": 0,
        "lastUpdated": None,
    }


def save_state(state):
    state["lastUpdated"] = datetime.now().isoformat()
    if STATE_FILE.exists():
        STATE_FILE.with_suffix(".json.bak").write_text(STATE_FILE.read_text())
    STATE_FILE.write_text(json.dumps(state, indent=2))


# =============================================================================
# Batch Processing
# =============================================================================

def get_gravel_batches():
    if not GRAVEL_DIR.exists():
        return []
    batches = []
    for f in sorted(GRAVEL_DIR.iterdir()):
        m = re.match(r'^(batch-\d{4})\.txt$', f.name)
        if m:
            batches.append(m.group(1))
    return batches


def count_hashes(path):
    count = 0
    with open(path, "r") as f:
        for line in f:
            if len(line.strip()) == 40:
                count += 1
    return count


def upload_batch(config, batch):
    local = GRAVEL_DIR / f"{batch}.txt"
    if not local.exists():
        raise FileNotFoundError(f"Gravel not found: {local}")

    local_size = local.stat().st_size
    try:
        remote_size = int(ssh_cmd(
            config,
            f"stat -c %s {config.work_dir}/hashlists/{batch}.txt 2>/dev/null || echo 0"
        ))
        if remote_size == local_size:
            return  # already uploaded
    except Exception:
        pass

    print(f"  Uploading {batch}.txt...")
    scp_upload(config, local, f"{config.work_dir}/hashlists/{batch}.txt")


def run_hashcat(config, batch):
    cmd = HASHCAT_TEMPLATE.format(ht=HASH_TYPE, batch=batch)
    screen_name = f"gp-{batch}"
    log_file = f"{config.work_dir}/hashcat-gravel.log"

    # If hashcat already running in our screen, just wait for it
    if is_hashcat_running(config) and is_screen_alive(config, screen_name):
        print(f"  hashcat already running in screen '{screen_name}' - waiting...")
    elif is_hashcat_running(config):
        # Another hashcat running - wait for it to finish
        print(f"  hashcat busy (another job). Waiting...")
        while is_hashcat_running(config):
            time.sleep(POLL_INTERVAL)
        print(f"  hashcat free. Proceeding.")
        _launch_hashcat(config, cmd, screen_name, log_file)
    else:
        _launch_hashcat(config, cmd, screen_name, log_file)

    # Poll for completion
    _poll_completion(config, batch, screen_name, log_file)


def _launch_hashcat(config, cmd, screen_name, log_file):
    # Clean up previous session
    try:
        ssh_cmd(config, f"screen -X -S {screen_name} quit 2>/dev/null; rm -f {log_file}", timeout=10)
    except Exception:
        pass

    escaped = cmd.replace("'", "'\\''")
    screen_cmd = (
        f"screen -dmS {screen_name} bash -c "
        f"'cd {config.work_dir} && {escaped} > {log_file} 2>&1'"
    )
    ssh_cmd(config, screen_cmd, timeout=15)
    print(f"  Running in screen: {screen_name}")
    time.sleep(3)

    # Verify it started
    if not is_hashcat_running(config) and not is_screen_alive(config, screen_name):
        try:
            log = ssh_cmd(config, f"tail -20 {log_file} 2>/dev/null || echo '(no log)'", timeout=10)
            print(f"  Log: {log}")
        except Exception:
            pass
        raise RuntimeError(f"hashcat failed to start for {screen_name}")


def _poll_completion(config, batch, screen_name, log_file):
    start = time.time()
    not_running = 0
    pot_before = get_potfile_count(config, batch)

    while time.time() - start < MAX_WAIT:
        time.sleep(POLL_INTERVAL)
        try:
            hc = is_hashcat_running(config)
            sc = is_screen_alive(config, screen_name)
            done = is_log_complete(config, log_file)
            pot = get_potfile_count(config, batch)
            el = fmt_dur(time.time() - start)
            new = pot - pot_before

            if hc or sc:
                not_running = 0
                progress = ""
                try:
                    p = ssh_cmd(config, f"grep '^Progress' {log_file} 2>/dev/null | tail -1", timeout=10)
                    if p.strip():
                        progress = f" | {p.strip()}"
                except Exception:
                    pass
                print(f"  [{el}] running - potfile: {pot:,} (+{new}){progress}")
            elif done:
                print(f"  hashcat finished (log confirmed)")
                break
            else:
                not_running += 1
                print(f"  [{el}] not detected ({not_running}/2) - potfile: {pot:,}")
                if not_running >= 2:
                    print(f"  hashcat stopped")
                    break
        except Exception:
            el = fmt_dur(time.time() - start)
            print(f"  [{el}] SSH lost - hashcat safe in screen. Reconnecting...")
            if not wait_for_connection(config):
                raise RuntimeError("Failed to reconnect to BIGRED")

    # Clean up screen
    try:
        ssh_cmd(config, f"screen -X -S {screen_name} quit 2>/dev/null || true", timeout=10)
    except Exception:
        pass


def collect_results(config, batch, gravel_count):
    """Download potfile, write PEARLS and SAND. Returns (pearl_count, sand_count)."""
    PEARLS_DIR.mkdir(parents=True, exist_ok=True)
    SAND_DIR.mkdir(parents=True, exist_ok=True)

    pot_count = get_potfile_count(config, batch)

    if pot_count == 0:
        # No cracks - entire gravel becomes sand
        print(f"  No cracks. All {gravel_count:,} hashes -> SAND")
        gravel_path = GRAVEL_DIR / f"{batch}.txt"
        (SAND_DIR / f"{batch}.txt").write_text(gravel_path.read_text())
        (PEARLS_DIR / f"{batch}.txt").write_text("")
        return 0, gravel_count

    # Download potfile to temp location
    tmp_pot = PEARLS_DIR / f"{batch}.pot.tmp"
    print(f"  Downloading potfile ({pot_count:,} entries)...")
    scp_download(config, f"{config.work_dir}/potfiles/{batch}.pot", tmp_pot)

    # Parse potfile
    cracked = set()
    pairs = []
    plaintexts = []

    for line in tmp_pot.read_text(encoding="utf-8", errors="replace").splitlines():
        colon = line.find(":")
        if colon < 0:
            continue
        h = line[:colon].strip().lower()
        pw = line[colon + 1:]
        if re.match(r'^[a-f0-9]{40}$', h):
            cracked.add(h)
            pairs.append(f"{h}:{pw}")
            plaintexts.append(pw)

    pearl_count = len(plaintexts)
    print(f"  PEARLS: {pearl_count:,} cracked")

    # Write PEARLS batch file (plaintexts)
    (PEARLS_DIR / f"{batch}.txt").write_text(
        "\n".join(plaintexts) + "\n" if plaintexts else ""
    )

    # Append to hash_plaintext_pairs.txt
    with open(PEARLS_DIR / "hash_plaintext_pairs.txt", "a", encoding="utf-8") as f:
        for pair in pairs:
            f.write(pair + "\n")

    # Compute SAND = GRAVEL - PEARLS
    gravel_path = GRAVEL_DIR / f"{batch}.txt"
    sand_hashes = []
    with open(gravel_path, "r") as f:
        for line in f:
            h = line.strip()
            if len(h) == 40 and h.lower() not in cracked:
                sand_hashes.append(h)

    sand_count = len(sand_hashes)
    print(f"  SAND: {sand_count:,} uncracked")

    # Write SAND batch file
    (SAND_DIR / f"{batch}.txt").write_text(
        "\n".join(sand_hashes) + "\n" if sand_hashes else ""
    )

    # Verify invariant: PEARLS + SAND = GRAVEL
    total = pearl_count + sand_count
    if total != gravel_count:
        print(f"  WARNING: PEARLS({pearl_count}) + SAND({sand_count}) = {total} != GRAVEL({gravel_count})")
    else:
        print(f"  Invariant OK: PEARLS({pearl_count}) + SAND({sand_count}) = GRAVEL({gravel_count})")

    # Clean up
    tmp_pot.unlink(missing_ok=True)
    try:
        ssh_cmd(config, (
            f"rm -f {config.work_dir}/hashlists/{batch}.txt "
            f"{config.work_dir}/potfiles/{batch}.pot"
        ), timeout=10)
    except Exception:
        print(f"  WARNING: Could not clean BIGRED files")

    return pearl_count, sand_count


def process_batch(config, batch, dry_run=False):
    """Process one gravel batch end-to-end. Returns (gravel_count, pearl_count, sand_count)."""
    gravel_path = GRAVEL_DIR / f"{batch}.txt"
    gravel_count = count_hashes(gravel_path)

    print(f"\n{'=' * 60}")
    print(f"  {batch} ({gravel_count:,} hashes)")
    print(f"{'=' * 60}")

    if dry_run:
        cmd = HASHCAT_TEMPLATE.format(ht=HASH_TYPE, batch=batch)
        print(f"  [DRY RUN] {cmd}")
        return gravel_count, 0, 0

    # Upload hashlist
    upload_batch(config, batch)

    # Check for completed-but-uncollected run (crash recovery)
    pot_count = get_potfile_count(config, batch)
    if pot_count > 0 and not is_hashcat_running(config):
        print(f"  Found existing potfile ({pot_count:,} entries) - collecting...")
    else:
        # Clear old potfile and run fresh
        try:
            ssh_cmd(config, f"rm -f {config.work_dir}/potfiles/{batch}.pot", timeout=10)
        except Exception:
            pass
        run_hashcat(config, batch)

    # Collect results
    pearl_count, sand_count = collect_results(config, batch, gravel_count)

    rate = (pearl_count / gravel_count * 100) if gravel_count > 0 else 0
    print(f"  Result: {pearl_count:,} / {gravel_count:,} ({rate:.1f}%)")

    return gravel_count, pearl_count, sand_count


# =============================================================================
# Preflight
# =============================================================================

def preflight(config):
    print("\n--- PRE-FLIGHT CHECKS ---")

    # SSH
    try:
        ssh_cmd(config, "echo connected", timeout=15)
        print(f"  SSH: {config.user}@{config.host} OK")
    except Exception:
        print(f"  FAIL: Cannot connect to BIGRED")
        return False

    # nocap.txt
    try:
        size = int(ssh_cmd(config, f"stat -c %s {config.work_dir}/wordlists/nocap.txt 2>/dev/null || echo 0"))
        if size == 0:
            print(f"  FAIL: nocap.txt missing. Run: bun Tools/BigRedSync.ts")
            return False
        print(f"  nocap.txt: {size:,} bytes")
    except Exception as e:
        print(f"  FAIL: {e}")
        return False

    # nocap.rule
    try:
        size = int(ssh_cmd(config, f"stat -c %s {config.work_dir}/rules/nocap.rule 2>/dev/null || echo 0"))
        if size == 0:
            print(f"  FAIL: nocap.rule missing. Run: bun Tools/BigRedSync.ts")
            return False
        print(f"  nocap.rule: {size:,} bytes")
    except Exception as e:
        print(f"  FAIL: {e}")
        return False

    # hashcat
    if is_hashcat_running(config):
        print(f"  WARNING: hashcat already running")
    else:
        print(f"  hashcat: ready")

    # Disk
    try:
        df = ssh_cmd(config, f"df -h {config.work_dir} | tail -1 | awk '{{print $4}}'")
        print(f"  Disk free: {df}")
    except Exception:
        pass

    # Gravel
    batches = get_gravel_batches()
    print(f"  Gravel batches: {len(batches):,}")

    print("--- PRE-FLIGHT PASSED ---")
    return True


# =============================================================================
# Helpers
# =============================================================================

def fmt_dur(s):
    if s < 60:
        return f"{s:.0f}s"
    if s < 3600:
        return f"{s / 60:.1f}m"
    return f"{int(s // 3600)}h {int((s % 3600) // 60)}m"


def show_status():
    state = load_state()
    batches = get_gravel_batches()
    done = state.get("totalProcessed", 0)
    tp = state.get("totalPearls", 0)
    ts = state.get("totalSand", 0)

    print("\n=== Gravel Processor Status ===\n")
    print(f"Attack:     nocap.txt x nocap.rule")
    print(f"Batches:    {len(batches):,} total, {done:,} done, {len(batches) - done:,} pending")
    print(f"PEARLS:     {tp:,}")
    print(f"SAND:       {ts:,}")
    if tp + ts > 0:
        print(f"Crack rate: {tp / (tp + ts) * 100:.2f}%")
    if state.get("lastUpdated"):
        print(f"Updated:    {state['lastUpdated']}")

    # Last 5 completed
    bs = state.get("batches", {})
    recent = sorted(
        [(k, v) for k, v in bs.items() if v.get("status") == "completed"],
        key=lambda x: x[0]
    )[-5:]
    if recent:
        print(f"\nRecent:")
        for name, b in recent:
            gc = b.get("gravelCount", 1)
            pc = b.get("pearlCount", 0)
            print(f"  {name}: {pc:,} / {gc:,} ({pc / gc * 100:.1f}%)")


# =============================================================================
# Main
# =============================================================================

def main():
    args = sys.argv[1:]

    if "--status" in args:
        show_status()
        return

    no_resume = "--no-resume" in args
    dry_run = "--dry-run" in args

    state = load_state()
    if no_resume:
        state = {
            "version": "2.0",
            "attack": "nocap-nocaprule",
            "batches": {},
            "totalProcessed": 0,
            "totalPearls": 0,
            "totalSand": 0,
            "lastUpdated": None,
        }
        save_state(state)
        print("State reset.")

    config = BigRedConfig()
    print(f"BIGRED: {config.user}@{config.host}")
    print(f"Attack: nocap.txt x nocap.rule")

    if not dry_run:
        if not preflight(config):
            sys.exit(1)

    all_batches = get_gravel_batches()
    if not all_batches:
        print("No gravel batches found.")
        return

    done_set = {
        k for k, v in state.get("batches", {}).items()
        if v.get("status") == "completed"
    }
    pending = [b for b in all_batches if b not in done_set]

    print(f"\nTotal: {len(all_batches):,} | Done: {len(done_set):,} | Pending: {len(pending):,}")

    if not pending:
        print("\nAll batches completed!")
        return

    if dry_run:
        print(f"\n[DRY RUN] Would process {len(pending)} batches")
        for b in pending[:5]:
            process_batch(config, b, dry_run=True)
        if len(pending) > 5:
            print(f"\n  ... and {len(pending) - 5} more")
        return

    # Process all pending batches
    t0 = time.time()
    processed = 0

    for batch in pending:
        try:
            gc, pc, sc = process_batch(config, batch)

            state["batches"][batch] = {
                "status": "completed",
                "gravelCount": gc,
                "pearlCount": pc,
                "sandCount": sc,
                "completedAt": datetime.now().isoformat(),
            }
            state["totalProcessed"] += 1
            state["totalPearls"] += pc
            state["totalSand"] += sc
            save_state(state)

            processed += 1
            elapsed = time.time() - t0
            avg = elapsed / processed
            eta = fmt_dur(avg * (len(pending) - processed))
            print(f"  Progress: {processed}/{len(pending)} | ETA: {eta}")

        except KeyboardInterrupt:
            print(f"\n\nInterrupted after {processed} batches.")
            save_state(state)
            break

        except Exception as e:
            print(f"\n  ERROR on {batch}: {e}")
            print(f"  Waiting 30s then retrying connection...")
            time.sleep(30)
            if not wait_for_connection(config):
                print("  BIGRED unreachable. Stopping.")
                save_state(state)
                break

    # Summary
    total_time = time.time() - t0
    print(f"\n{'=' * 60}")
    print(f"GRAVEL PROCESSOR COMPLETE")
    print(f"{'=' * 60}")
    print(f"Processed:  {processed}")
    print(f"Time:       {fmt_dur(total_time)}")
    print(f"PEARLS:     {state['totalPearls']:,}")
    print(f"SAND:       {state['totalSand']:,}")
    if state["totalPearls"] + state["totalSand"] > 0:
        r = state["totalPearls"] / (state["totalPearls"] + state["totalSand"]) * 100
        print(f"Crack rate: {r:.2f}%")


if __name__ == "__main__":
    main()
