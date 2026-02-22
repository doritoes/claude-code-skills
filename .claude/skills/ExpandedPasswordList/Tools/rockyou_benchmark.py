#!/usr/bin/env python3
"""
rockyou_benchmark.py - Measure rockyou.txt + OneRuleToRuleThemStill crack rate on gravel

Selects N evenly-spaced gravel batches, combines into one chunk, uploads to
BIGRED, and runs a single hashcat attack. Reports overall crack rate for
comparison with nocap.txt + nocap.rule (29.99% across all 4,328 batches).

Does NOT save PEARLS or SAND — only measures crack rate.

Usage:
  python Tools/rockyou_benchmark.py                    Sample 10 batches (default)
  python Tools/rockyou_benchmark.py --samples 20       Sample 20 batches
  python Tools/rockyou_benchmark.py --batch 1 50 100   Run specific batches
  python Tools/rockyou_benchmark.py --dry-run           Preview without execution
"""

import os
import sys
import re
import time
import subprocess
import tempfile
from pathlib import Path

import functools
print = functools.partial(print, flush=True)

# =============================================================================
# Paths
# =============================================================================

SCRIPT_DIR = Path(__file__).resolve().parent
SKILL_DIR = SCRIPT_DIR.parent
PROJECT_ROOT = SKILL_DIR.parent.parent.parent

DATA_DIR = SKILL_DIR / "data"
GRAVEL_DIR = DATA_DIR / "gravel"
ENV_FILE = PROJECT_ROOT / ".claude" / ".env"

SHELL = r"C:\Program Files\Git\bin\bash.exe" if os.name == "nt" else "/bin/bash"

HASH_TYPE = 100  # SHA-1
CHUNK_NAME = "benchmark-chunk"
HASHCAT_CMD = (
    "hashcat -m {ht} hashlists/{chunk}.txt "
    "wordlists/rockyou.txt -r rules/OneRuleToRuleThemStill.rule "
    "--potfile-path potfiles/{chunk}.pot -O -w 3 --status --status-timer 60"
)

POLL_INTERVAL = 30
MAX_WAIT = 4 * 3600
SSH_TIMEOUT = 30
RECONNECT_MAX = 300


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


def get_potfile_count(config, potfile_name):
    try:
        r = ssh_cmd(config, (
            f"test -f {config.work_dir}/potfiles/{potfile_name} && "
            f"wc -l < {config.work_dir}/potfiles/{potfile_name} || echo 0"
        ))
        return int(r) or 0
    except Exception:
        return 0


# =============================================================================
# Helpers
# =============================================================================

def fmt_dur(s):
    if s < 60:
        return f"{s:.0f}s"
    if s < 3600:
        return f"{s / 60:.1f}m"
    return f"{int(s // 3600)}h {int((s % 3600) // 60)}m"


def get_gravel_batches():
    if not GRAVEL_DIR.exists():
        return []
    batches = []
    for f in sorted(GRAVEL_DIR.iterdir()):
        m = re.match(r'^(batch-\d{4})\.txt$', f.name)
        if m:
            batches.append(m.group(1))
    return batches


def select_samples(all_batches, n):
    """Select n evenly-spaced batches from the full list."""
    total = len(all_batches)
    if n >= total:
        return all_batches[:]
    step = total / n
    return [all_batches[int(i * step)] for i in range(n)]


def build_chunk(batches, chunk_path):
    """Combine multiple gravel batch files into one chunk. Returns total hash count."""
    total = 0
    with open(chunk_path, "w") as out:
        for batch in batches:
            path = GRAVEL_DIR / f"{batch}.txt"
            with open(path, "r") as f:
                for line in f:
                    line = line.strip()
                    if len(line) == 40:
                        out.write(line + "\n")
                        total += 1
    return total


# =============================================================================
# Benchmark
# =============================================================================

def run_benchmark(config, chunk_path, hash_count):
    """Run rockyou+OneRule on the combined chunk. Returns crack count."""
    potfile_name = f"{CHUNK_NAME}.pot"
    screen_name = f"rb-chunk"
    log_file = f"{config.work_dir}/rockyou-benchmark.log"

    # Clean stale potfile + log
    try:
        ssh_cmd(config, (
            f"rm -f {config.work_dir}/potfiles/{potfile_name} "
            f"{log_file}"
        ), timeout=10)
    except Exception:
        pass

    # Upload chunk
    print(f"\n  Uploading chunk ({hash_count:,} hashes)...")
    scp_upload(config, chunk_path, f"{config.work_dir}/hashlists/{CHUNK_NAME}.txt", timeout=600)
    print(f"  Upload complete.")

    # Wait if hashcat busy
    if is_hashcat_running(config):
        print(f"  hashcat busy. Waiting...")
        while is_hashcat_running(config):
            time.sleep(POLL_INTERVAL)

    # Clean previous screen session
    try:
        ssh_cmd(config, f"screen -X -S {screen_name} quit 2>/dev/null || true", timeout=10)
    except Exception:
        pass

    # Launch hashcat in screen
    cmd = HASHCAT_CMD.format(ht=HASH_TYPE, chunk=CHUNK_NAME)
    escaped = cmd.replace("'", "'\\''")
    screen_cmd = (
        f"screen -dmS {screen_name} bash -c "
        f"'cd {config.work_dir} && {escaped} > {log_file} 2>&1'"
    )
    ssh_cmd(config, screen_cmd, timeout=15)
    print(f"  Running: rockyou.txt + OneRuleToRuleThemStill.rule")
    print(f"  Keyspace: ~{hash_count:,} hashes x 693B candidates")
    time.sleep(3)

    # Verify started
    if not is_hashcat_running(config) and not is_screen_alive(config, screen_name):
        try:
            log = ssh_cmd(config, f"tail -20 {log_file} 2>/dev/null || echo '(no log)'", timeout=10)
            print(f"  Log: {log}")
        except Exception:
            pass
        raise RuntimeError(f"hashcat failed to start")

    # Poll for completion
    start = time.time()
    not_running = 0

    while time.time() - start < MAX_WAIT:
        time.sleep(POLL_INTERVAL)
        try:
            hc = is_hashcat_running(config)
            sc = is_screen_alive(config, screen_name)
            done = is_log_complete(config, log_file)
            pot = get_potfile_count(config, potfile_name)
            el = fmt_dur(time.time() - start)

            if hc or sc:
                not_running = 0
                progress = ""
                try:
                    p = ssh_cmd(config, f"grep '^Progress' {log_file} 2>/dev/null | tail -1", timeout=10)
                    if p.strip():
                        progress = f" | {p.strip()}"
                except Exception:
                    pass
                print(f"  [{el}] running - cracked: {pot:,}{progress}")
            elif done:
                print(f"  [{el}] Finished (log confirmed)")
                break
            else:
                not_running += 1
                print(f"  [{el}] not detected ({not_running}/2) - cracked: {pot:,}")
                if not_running >= 2:
                    print(f"  Stopped")
                    break
        except Exception:
            el = fmt_dur(time.time() - start)
            print(f"  [{el}] SSH lost - reconnecting...")
            if not wait_for_connection(config):
                raise RuntimeError("Failed to reconnect to BIGRED")

    # Clean up screen
    try:
        ssh_cmd(config, f"screen -X -S {screen_name} quit 2>/dev/null || true", timeout=10)
    except Exception:
        pass

    # Wait for hashcat to fully exit
    for _ in range(10):
        if not is_hashcat_running(config):
            break
        time.sleep(3)

    # Get final crack count
    crack_count = get_potfile_count(config, potfile_name)
    elapsed = time.time() - start
    rate = crack_count / hash_count * 100 if hash_count > 0 else 0
    print(f"\n  Result: {crack_count:,} / {hash_count:,} ({rate:.2f}%) in {fmt_dur(elapsed)}")

    # Clean up remote files
    try:
        ssh_cmd(config, (
            f"rm -f {config.work_dir}/hashlists/{CHUNK_NAME}.txt "
            f"{config.work_dir}/potfiles/{potfile_name} "
            f"{log_file}"
        ), timeout=10)
    except Exception:
        pass

    return crack_count


# =============================================================================
# Preflight
# =============================================================================

def preflight(config):
    print("\n--- PRE-FLIGHT CHECKS ---")

    try:
        ssh_cmd(config, "echo connected", timeout=15)
        print(f"  SSH: {config.user}@{config.host} OK")
    except Exception:
        print(f"  FAIL: Cannot connect to BIGRED")
        return False

    # rockyou.txt
    try:
        size = int(ssh_cmd(config, f"stat -c %s {config.work_dir}/wordlists/rockyou.txt 2>/dev/null || echo 0"))
        if size == 0:
            print(f"  FAIL: rockyou.txt missing on BIGRED")
            return False
        print(f"  rockyou.txt: {size:,} bytes")
    except Exception as e:
        print(f"  FAIL: {e}")
        return False

    # OneRuleToRuleThemStill.rule
    try:
        size = int(ssh_cmd(config, f"stat -c %s {config.work_dir}/rules/OneRuleToRuleThemStill.rule 2>/dev/null || echo 0"))
        if size == 0:
            print(f"  FAIL: OneRuleToRuleThemStill.rule missing on BIGRED")
            return False
        print(f"  OneRuleToRuleThemStill.rule: {size:,} bytes")
    except Exception as e:
        print(f"  FAIL: {e}")
        return False

    if is_hashcat_running(config):
        print(f"  FAIL: hashcat already running")
        return False
    else:
        print(f"  hashcat: ready")

    print("--- PRE-FLIGHT PASSED ---")
    return True


# =============================================================================
# Main
# =============================================================================

def main():
    args = sys.argv[1:]
    dry_run = "--dry-run" in args

    # Parse --samples N
    n_samples = 10
    if "--samples" in args:
        idx = args.index("--samples")
        if idx + 1 < len(args):
            n_samples = int(args[idx + 1])

    # Parse --batch N N N
    specific_batches = []
    if "--batch" in args:
        idx = args.index("--batch")
        for a in args[idx + 1:]:
            if a.startswith("--"):
                break
            specific_batches.append(f"batch-{int(a):04d}")

    all_batches = get_gravel_batches()
    if not all_batches:
        print("No gravel batches found.")
        return

    # Select batches
    if specific_batches:
        batches = [b for b in specific_batches if b in all_batches]
        missing = [b for b in specific_batches if b not in all_batches]
        if missing:
            print(f"WARNING: batches not found: {', '.join(missing)}")
    else:
        batches = select_samples(all_batches, n_samples)

    print(f"\n{'=' * 60}")
    print(f"  ROCKYOU BENCHMARK (chunked)")
    print(f"  Attack: rockyou.txt + OneRuleToRuleThemStill.rule")
    print(f"  Batches: {len(batches)} of {len(all_batches)} gravel batches")
    print(f"{'=' * 60}")

    for b in batches:
        print(f"  - {b}")

    # Build chunk locally
    print(f"\n  Building combined chunk from {len(batches)} batches...")
    chunk_path = os.path.join(tempfile.gettempdir(), f"{CHUNK_NAME}.txt")
    hash_count = build_chunk(batches, chunk_path)
    chunk_size = os.path.getsize(chunk_path)
    print(f"  Chunk: {hash_count:,} hashes ({chunk_size / 1024 / 1024:.1f} MB)")

    if dry_run:
        print(f"\n[DRY RUN] Would benchmark {len(batches)} batches ({hash_count:,} hashes)")
        os.remove(chunk_path)
        return

    config = BigRedConfig()
    print(f"\nBIGRED: {config.user}@{config.host}")

    if not preflight(config):
        os.remove(chunk_path)
        sys.exit(1)

    # Run benchmark
    t0 = time.time()
    try:
        crack_count = run_benchmark(config, chunk_path, hash_count)
    except KeyboardInterrupt:
        print("\n\nInterrupted.")
        os.remove(chunk_path)
        sys.exit(1)
    except Exception as e:
        print(f"\n  ERROR: {e}")
        os.remove(chunk_path)
        sys.exit(1)
    finally:
        if os.path.exists(chunk_path):
            os.remove(chunk_path)

    elapsed = time.time() - t0
    rate = crack_count / hash_count * 100 if hash_count > 0 else 0

    # Summary
    print(f"\n{'=' * 60}")
    print(f"  ROCKYOU BENCHMARK RESULTS")
    print(f"{'=' * 60}")
    print(f"\n  Attack:   rockyou.txt + OneRuleToRuleThemStill.rule")
    print(f"  Batches:  {len(batches)} evenly-spaced from {len(all_batches)} total")
    print(f"  Hashes:   {hash_count:,}")
    print(f"  Cracked:  {crack_count:,}")
    print(f"  Rate:     {rate:.2f}%")
    print(f"  Time:     {fmt_dur(elapsed)}")
    print()
    print(f"  --- COMPARISON ---")
    print(f"  nocap.txt + nocap.rule:                29.99% (all 4,328 batches)")
    print(f"  rockyou.txt + OneRuleToRuleThemStill:  {rate:.2f}% ({len(batches)}-batch sample)")
    print(f"  Delta:                                 {rate - 29.99:+.2f}pp")


if __name__ == "__main__":
    main()
