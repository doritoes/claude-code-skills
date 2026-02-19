#!/usr/bin/env python3
"""
rockyou_benchmark.py - Measure rockyou.txt + OneRuleToRuleThemStill crack rate on gravel

Runs rockyou.txt + OneRuleToRuleThemStill.rule against a sample of gravel batches
to get a baseline crack rate for comparison with nocap.txt + nocap.rule (30%).

Does NOT save PEARLS or SAND — only measures crack rate.

Usage:
  python Tools/rockyou_benchmark.py                    Sample 10 evenly-spaced batches
  python Tools/rockyou_benchmark.py --samples 20       Sample 20 batches
  python Tools/rockyou_benchmark.py --batch 1 50 100   Run specific batches
  python Tools/rockyou_benchmark.py --dry-run           Preview which batches would run
"""

import os
import sys
import re
import time
import subprocess
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
HASHCAT_CMD = (
    "hashcat -m {ht} hashlists/{batch}.txt "
    "wordlists/rockyou.txt -r rules/OneRuleToRuleThemStill.rule "
    "--potfile-path potfiles/{batch}-benchmark.pot -O -w 3 --status --status-timer 60"
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


def count_hashes(path):
    count = 0
    with open(path, "r") as f:
        for line in f:
            if len(line.strip()) == 40:
                count += 1
    return count


def select_samples(all_batches, n):
    """Select n evenly-spaced batches from the full list."""
    total = len(all_batches)
    if n >= total:
        return all_batches[:]
    step = total / n
    return [all_batches[int(i * step)] for i in range(n)]


# =============================================================================
# Benchmark
# =============================================================================

def run_benchmark(config, batch, dry_run=False):
    """Run rockyou+OneRule on one gravel batch. Returns (hash_count, crack_count)."""
    gravel_path = GRAVEL_DIR / f"{batch}.txt"
    hash_count = count_hashes(gravel_path)
    potfile_name = f"{batch}-benchmark.pot"

    print(f"\n  {batch} ({hash_count:,} hashes)")

    if dry_run:
        return hash_count, 0

    # Clean stale potfile
    try:
        ssh_cmd(config, f"rm -f {config.work_dir}/potfiles/{potfile_name}", timeout=10)
    except Exception:
        pass

    # Upload hashlist
    local_size = gravel_path.stat().st_size
    try:
        remote_size = int(ssh_cmd(
            config,
            f"stat -c %s {config.work_dir}/hashlists/{batch}.txt 2>/dev/null || echo 0"
        ))
        if remote_size != local_size:
            scp_upload(config, gravel_path, f"{config.work_dir}/hashlists/{batch}.txt")
    except Exception:
        scp_upload(config, gravel_path, f"{config.work_dir}/hashlists/{batch}.txt")

    # Launch hashcat in screen
    cmd = HASHCAT_CMD.format(ht=HASH_TYPE, batch=batch)
    screen_name = f"rb-{batch}"
    log_file = f"{config.work_dir}/rockyou-benchmark.log"

    # Wait if hashcat busy
    if is_hashcat_running(config):
        print(f"  hashcat busy. Waiting...")
        while is_hashcat_running(config):
            time.sleep(POLL_INTERVAL)

    # Clean previous session
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
    print(f"  Running: rockyou.txt + OneRuleToRuleThemStill.rule")
    time.sleep(3)

    # Verify started
    if not is_hashcat_running(config) and not is_screen_alive(config, screen_name):
        try:
            log = ssh_cmd(config, f"tail -20 {log_file} 2>/dev/null || echo '(no log)'", timeout=10)
            print(f"  Log: {log}")
        except Exception:
            pass
        raise RuntimeError(f"hashcat failed to start for {screen_name}")

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
                print(f"  [{el}] running - potfile: {pot:,}{progress}")
            elif done:
                print(f"  Finished (log confirmed)")
                break
            else:
                not_running += 1
                print(f"  [{el}] not detected ({not_running}/2) - potfile: {pot:,}")
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
    rate = crack_count / hash_count * 100 if hash_count > 0 else 0
    elapsed = time.time() - start
    print(f"  Result: {crack_count:,} / {hash_count:,} ({rate:.1f}%) in {fmt_dur(elapsed)}")

    # Clean up remote files
    try:
        ssh_cmd(config, (
            f"rm -f {config.work_dir}/hashlists/{batch}.txt "
            f"{config.work_dir}/potfiles/{potfile_name}"
        ), timeout=10)
    except Exception:
        pass

    return hash_count, crack_count


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

    # Select batches to benchmark
    if specific_batches:
        batches = [b for b in specific_batches if b in [x for x in all_batches]]
        missing = [b for b in specific_batches if b not in all_batches]
        if missing:
            print(f"WARNING: batches not found: {', '.join(missing)}")
    else:
        batches = select_samples(all_batches, n_samples)

    print(f"\n{'=' * 60}")
    print(f"  ROCKYOU BENCHMARK")
    print(f"  Attack: rockyou.txt + OneRuleToRuleThemStill.rule")
    print(f"  Batches: {len(batches)} of {len(all_batches)} gravel batches")
    print(f"{'=' * 60}")

    for b in batches:
        print(f"  - {b}")

    if dry_run:
        print(f"\n[DRY RUN] Would benchmark {len(batches)} batches")
        return

    config = BigRedConfig()
    print(f"\nBIGRED: {config.user}@{config.host}")

    if not preflight(config):
        sys.exit(1)

    # Run benchmarks
    results = []
    t0 = time.time()

    for i, batch in enumerate(batches):
        try:
            hash_count, crack_count = run_benchmark(config, batch)
            results.append((batch, hash_count, crack_count))

            done = len(results)
            avg_time = (time.time() - t0) / done
            remaining = avg_time * (len(batches) - done)
            print(f"  Progress: {done}/{len(batches)} | ETA: {fmt_dur(remaining)}")

        except KeyboardInterrupt:
            print(f"\n\nInterrupted after {len(results)} batches.")
            break

        except Exception as e:
            print(f"\n  ERROR on {batch}: {e}")
            time.sleep(30)
            if not wait_for_connection(config):
                print("  BIGRED unreachable. Stopping.")
                break

    # Summary
    if not results:
        print("No results.")
        return

    total_hashes = sum(h for _, h, _ in results)
    total_cracks = sum(c for _, _, c in results)
    overall_rate = total_cracks / total_hashes * 100 if total_hashes > 0 else 0
    elapsed = time.time() - t0

    print(f"\n{'=' * 60}")
    print(f"  ROCKYOU BENCHMARK RESULTS")
    print(f"{'=' * 60}")
    print(f"\n  Attack: rockyou.txt + OneRuleToRuleThemStill.rule")
    print(f"  Batches sampled: {len(results)}")
    print(f"  Time: {fmt_dur(elapsed)}")
    print()
    print(f"  {'Batch':<16} {'Hashes':>10} {'Cracked':>10} {'Rate':>8}")
    print(f"  {'-'*16} {'-'*10} {'-'*10} {'-'*8}")

    rates = []
    for batch, hc, cc in results:
        rate = cc / hc * 100 if hc > 0 else 0
        rates.append(rate)
        print(f"  {batch:<16} {hc:>10,} {cc:>10,} {rate:>7.1f}%")

    print(f"  {'-'*16} {'-'*10} {'-'*10} {'-'*8}")
    print(f"  {'TOTAL':<16} {total_hashes:>10,} {total_cracks:>10,} {overall_rate:>7.1f}%")

    min_rate = min(rates)
    max_rate = max(rates)
    print(f"\n  Overall: {overall_rate:.1f}% ({min_rate:.1f}% - {max_rate:.1f}% range)")
    print(f"\n  Compare: nocap.txt + nocap.rule = 30.0% (29.8% - 30.2%)")
    print(f"  Delta:   nocap adds {overall_rate - 30.0:+.1f}pp" if overall_rate != 30.0
          else f"  Delta:   identical")


if __name__ == "__main__":
    main()
