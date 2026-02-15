#!/usr/bin/env python3
"""
sand_bruteforcer.py - Consolidated Brute Force Pre-Processor for SAND

Combines all SAND batches into large chunks and runs brute-5/6/7 once per chunk
instead of once per batch. For mask attacks, keyspace is FIXED regardless of
hashlist size, so this is ~200x faster than per-batch processing.

Output:
  data/diamonds/batch-NNNN.txt                hash:plaintext pairs per batch
  data/diamonds/passwords-batch-NNNN.txt      plaintexts only per batch
  data/diamonds/hash_plaintext_pairs.txt      master hash:plaintext (append-only)
  data/glass/batch-NNNN.txt                   uncracked survivors (--glass only)

Usage:
  python Tools/sand_bruteforcer.py --plan              Show chunk plan (dry run)
  python Tools/sand_bruteforcer.py --next              Process next pending chunk
  python Tools/sand_bruteforcer.py --chunk N           Process specific chunk
  python Tools/sand_bruteforcer.py --attack brute-7    Only run one attack
  python Tools/sand_bruteforcer.py --collect N         Redistribute chunk N results
  python Tools/sand_bruteforcer.py --glass             Compute GLASS for completed batches
  python Tools/sand_bruteforcer.py --glass --batch N   Compute GLASS for specific batch
  python Tools/sand_bruteforcer.py --status            Show progress summary
  python Tools/sand_bruteforcer.py --chunk-size N      Override max hashes per chunk
"""

import os
import sys
import json
import gzip
import time
import re
import subprocess
from pathlib import Path
from datetime import datetime

# Force unbuffered output so progress is visible in real time
import functools
print = functools.partial(print, flush=True)

# =============================================================================
# Paths
# =============================================================================

SCRIPT_DIR = Path(__file__).resolve().parent
SKILL_DIR = SCRIPT_DIR.parent
PROJECT_ROOT = SKILL_DIR.parent.parent.parent  # .claude/skills/ExpandedPasswordList -> AI-Projects

DATA_DIR = SKILL_DIR / "data"
SAND_DIR = DATA_DIR / "sand"
DIAMONDS_DIR = DATA_DIR / "diamonds"
GLASS_DIR = DATA_DIR / "glass"
STATE_FILE = DATA_DIR / "bruteforce-state.json"
SAND_STATE_FILE = DATA_DIR / "sand-state.json"
ENV_FILE = PROJECT_ROOT / ".claude" / ".env"

SHELL = r"C:\Program Files\Git\bin\bash.exe" if os.name == "nt" else "/bin/bash"

# Hashcat
HASH_TYPE = 100  # SHA-1

# Attack definitions — masks must match BigRedRunner.ts exactly
ATTACKS = {
    "brute-5": "-a 3 ?a?a?a?a?a",
    "brute-6": "-a 3 ?a?a?a?a?a?a",
    "brute-7": "-a 3 ?a?a?a?a?a?a?a",
}
ATTACK_ORDER = ["brute-5", "brute-6", "brute-7"]

# The full 17-attack order from SandStateManager.ts v5.1
DEFAULT_SAND_ATTACK_ORDER = [
    "brute-1", "brute-2", "brute-3", "brute-4",
    "brute-6", "brute-7",
    "feedback-beta-nocaprule", "nocapplus-nocaprule", "nocapplus-unobtainium",
    "hybrid-nocapplus-4digit", "mask-lllllldd", "brute-5", "mask-Ullllllld",
    "mask-Ullllldd", "hybrid-rockyou-special-digits",
    "hybrid-nocapplus-3digit", "mask-lllldddd",
]

# Defaults
DEFAULT_CHUNK_SIZE = 100_000_000  # 100M hashes per chunk

# Timing
POLL_INTERVAL = 30       # seconds between status checks
MAX_WAIT = 8 * 3600      # 8 hours max per attack (brute-7 on 100M hashes)
SSH_TIMEOUT = 30
RECONNECT_MAX = 300      # 5 min max reconnect wait


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
# SSH / SCP (reused from gravel_processor.py)
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


def scp_upload(config, local_path, remote_path, timeout=1800):
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


def scp_download(config, remote_path, local_path, timeout=1800):
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
# State Management
# =============================================================================

def load_state():
    if STATE_FILE.exists():
        return json.loads(STATE_FILE.read_text())
    return {
        "version": 1,
        "chunkSize": DEFAULT_CHUNK_SIZE,
        "chunks": {},
        "totalChunks": 0,
        "totalProcessed": 0,
        "totalCracked": 0,
        "lastUpdated": None,
    }


def save_state(state):
    state["lastUpdated"] = datetime.now().isoformat()
    if STATE_FILE.exists():
        STATE_FILE.with_suffix(".json.bak").write_text(STATE_FILE.read_text())
    STATE_FILE.write_text(json.dumps(state, indent=2))


def load_sand_state():
    if SAND_STATE_FILE.exists():
        return json.loads(SAND_STATE_FILE.read_text())
    return {
        "version": 2,
        "batches": {},
        "attackStats": {},
        "attackOrder": [],
        "startedAt": None,
        "lastUpdated": None,
    }


def save_sand_state(state):
    state["lastUpdated"] = datetime.now().isoformat()
    if SAND_STATE_FILE.exists():
        SAND_STATE_FILE.with_suffix(".json.bak").write_text(SAND_STATE_FILE.read_text())
    SAND_STATE_FILE.write_text(json.dumps(state, indent=2))


# =============================================================================
# Helpers
# =============================================================================

def fmt_dur(s):
    if s < 60:
        return f"{s:.0f}s"
    if s < 3600:
        return f"{s / 60:.1f}m"
    return f"{int(s // 3600)}h {int((s % 3600) // 60)}m"


def get_sand_batches():
    """Return sorted list of batch names from data/sand/."""
    if not SAND_DIR.exists():
        return []
    batches = []
    for f in sorted(SAND_DIR.iterdir()):
        m = re.match(r'^(batch-\d{4})\.txt$', f.name)
        if m:
            batches.append(m.group(1))
    return batches


def count_lines(path):
    """Count non-empty lines in a file (works for plain text)."""
    count = 0
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            if line.strip():
                count += 1
    return count


def read_hashes_from_batch(batch_name):
    """Read SHA-1 hashes from a sand batch file. Supports .txt and .txt.gz."""
    txt_path = SAND_DIR / f"{batch_name}.txt"
    gz_path = SAND_DIR / f"{batch_name}.txt.gz"

    if txt_path.exists():
        hashes = []
        with open(txt_path, "r", encoding="utf-8") as f:
            for line in f:
                h = line.strip().lower()
                if len(h) == 40:
                    hashes.append(h)
        return hashes
    elif gz_path.exists():
        hashes = []
        with gzip.open(gz_path, "rt", encoding="utf-8") as f:
            for line in f:
                h = line.strip().lower()
                if len(h) == 40:
                    hashes.append(h)
        return hashes
    else:
        raise FileNotFoundError(f"Sand batch not found: {batch_name} (.txt or .txt.gz)")


# =============================================================================
# Phase 1: PLAN — Dynamic Chunk Assignment
# =============================================================================

def build_plan(chunk_size, force_replan=False):
    """Scan sand batches, skip already-bruted, group into chunks."""
    state = load_state()
    sand_state = load_sand_state()

    # If plan exists and not forcing, return existing
    if state.get("chunks") and not force_replan:
        return state

    all_batches = get_sand_batches()
    if not all_batches:
        print("No sand batches found.")
        return state

    # Skip batches where brute-5, brute-6, and brute-7 are ALL already done
    pending_batches = []
    skipped = 0
    for batch_name in all_batches:
        sb = sand_state.get("batches", {}).get(batch_name, {})
        applied = set(sb.get("attacksApplied", []))
        if {"brute-5", "brute-6", "brute-7"}.issubset(applied):
            skipped += 1
        else:
            pending_batches.append(batch_name)

    if skipped > 0:
        print(f"  Skipped {skipped} batches (brute-5/6/7 already done)")

    if not pending_batches:
        print("All batches already have brute-5/6/7 done.")
        return state

    # Count hashes per batch to build chunks
    print(f"  Scanning {len(pending_batches)} batches for hash counts...")
    batch_counts = {}
    total_hashes = 0
    for i, batch_name in enumerate(pending_batches):
        txt_path = SAND_DIR / f"{batch_name}.txt"
        gz_path = SAND_DIR / f"{batch_name}.txt.gz"
        if txt_path.exists():
            # Fast line count for plain text
            c = count_lines(txt_path)
        elif gz_path.exists():
            c = len(read_hashes_from_batch(batch_name))
        else:
            print(f"  WARNING: {batch_name} not found, skipping")
            continue
        batch_counts[batch_name] = c
        total_hashes += c
        if (i + 1) % 100 == 0:
            print(f"    Scanned {i + 1}/{len(pending_batches)} batches...")

    # Group into chunks
    chunks = {}
    chunk_num = 1
    current_batches = []
    current_count = 0

    for batch_name in pending_batches:
        if batch_name not in batch_counts:
            continue
        bc = batch_counts[batch_name]
        current_batches.append(batch_name)
        current_count += bc

        if current_count >= chunk_size:
            chunk_id = f"chunk-{chunk_num:04d}"
            chunks[chunk_id] = {
                "batches": current_batches[:],
                "hashCount": current_count,
                "built": False,
                "uploaded": False,
                "attacks": {},
                "potfileLines": 0,
                "collected": False,
                "redistributed": False,
                "completedAt": None,
            }
            chunk_num += 1
            current_batches = []
            current_count = 0

    # Last partial chunk
    if current_batches:
        chunk_id = f"chunk-{chunk_num:04d}"
        chunks[chunk_id] = {
            "batches": current_batches[:],
            "hashCount": current_count,
            "built": False,
            "uploaded": False,
            "attacks": {},
            "potfileLines": 0,
            "collected": False,
            "redistributed": False,
            "completedAt": None,
        }

    state["chunkSize"] = chunk_size
    state["chunks"] = chunks
    state["totalChunks"] = len(chunks)
    save_state(state)

    print(f"\n  Plan: {len(chunks)} chunks from {len(pending_batches)} batches ({total_hashes:,} hashes)")
    for cid, c in chunks.items():
        print(f"    {cid}: {len(c['batches'])} batches, {c['hashCount']:,} hashes")

    return state


# =============================================================================
# Phase 2: BUILD — Combine Batch Files into Chunk
# =============================================================================

def build_chunk(chunk_id, chunk_info):
    """Concatenate all batch hashes into one chunk file."""
    chunk_path = SAND_DIR / f"{chunk_id}.txt"

    if chunk_info.get("built") and chunk_path.exists():
        # Verify line count
        expected = chunk_info["hashCount"]
        actual = count_lines(chunk_path)
        if actual == expected:
            print(f"  {chunk_id} already built ({actual:,} hashes)")
            return chunk_path
        else:
            print(f"  {chunk_id} exists but wrong count ({actual:,} vs {expected:,}), rebuilding...")

    print(f"  Building {chunk_id} from {len(chunk_info['batches'])} batches...")
    t0 = time.time()
    total_written = 0

    with open(chunk_path, "w", encoding="utf-8") as out:
        for batch_name in chunk_info["batches"]:
            hashes = read_hashes_from_batch(batch_name)
            for h in hashes:
                out.write(h + "\n")
                total_written += 1

    elapsed = time.time() - t0
    print(f"  Built {chunk_id}: {total_written:,} hashes in {fmt_dur(elapsed)}")

    # Update count in case it differed from scan
    chunk_info["hashCount"] = total_written
    chunk_info["built"] = True
    return chunk_path


# =============================================================================
# Phase 3: UPLOAD + ATTACK — Run on BIGRED
# =============================================================================

def upload_chunk(config, chunk_id, chunk_path):
    """Upload chunk hashlist to BIGRED."""
    local_size = chunk_path.stat().st_size
    remote_file = f"{config.work_dir}/hashlists/{chunk_id}.txt"

    try:
        remote_size = int(ssh_cmd(
            config,
            f"stat -c %s {remote_file} 2>/dev/null || echo 0"
        ))
        if remote_size == local_size:
            print(f"  {chunk_id} already uploaded ({local_size:,} bytes)")
            return
    except Exception:
        pass

    print(f"  Uploading {chunk_id}.txt ({local_size:,} bytes)...")
    t0 = time.time()
    scp_upload(config, chunk_path, remote_file)
    print(f"  Uploaded in {fmt_dur(time.time() - t0)}")


def run_attack(config, chunk_id, attack_name, chunk_info):
    """Run one brute-force attack on a chunk. Blocks until complete."""
    # Skip if already done
    attack_state = chunk_info.get("attacks", {}).get(attack_name, {})
    if attack_state.get("status") == "completed":
        print(f"  {attack_name} already completed for {chunk_id}")
        return

    mask_args = ATTACKS[attack_name]
    screen_name = f"sb-{chunk_id}-{attack_name}"
    log_file = f"{config.work_dir}/logs/{chunk_id}-{attack_name}.log"
    potfile = f"{config.work_dir}/potfiles/{chunk_id}.pot"
    hashlist = f"{config.work_dir}/hashlists/{chunk_id}.txt"

    # hashcat command — single potfile per chunk, all attacks append to it
    hashcat_cmd = (
        f"hashcat -m {HASH_TYPE} {hashlist} {mask_args} "
        f"--potfile-path {potfile} -O -w 3 "
        f"--status --status-timer 60"
    )

    print(f"\n  --- {attack_name} on {chunk_id} ---")

    # Check if hashcat is already running our attack
    if is_hashcat_running(config) and is_screen_alive(config, screen_name):
        print(f"  hashcat already running in screen '{screen_name}' - waiting...")
    elif is_hashcat_running(config):
        print(f"  hashcat busy (another job). Waiting...")
        while is_hashcat_running(config):
            time.sleep(POLL_INTERVAL)
        print(f"  hashcat free. Proceeding.")
        _launch_attack(config, hashcat_cmd, screen_name, log_file)
    else:
        _launch_attack(config, hashcat_cmd, screen_name, log_file)

    # Record start
    if "attacks" not in chunk_info:
        chunk_info["attacks"] = {}
    chunk_info["attacks"][attack_name] = {
        "status": "running",
        "startedAt": datetime.now().isoformat(),
    }

    # Get potfile count before this attack
    pot_before = get_potfile_count(config, f"{chunk_id}.pot")

    # Poll for completion
    _poll_attack(config, chunk_id, attack_name, screen_name, log_file, pot_before)

    # Record completion
    pot_after = get_potfile_count(config, f"{chunk_id}.pot")
    cracked = pot_after - pot_before

    chunk_info["attacks"][attack_name] = {
        "status": "completed",
        "cracked": cracked,
        "completedAt": datetime.now().isoformat(),
    }
    chunk_info["potfileLines"] = pot_after

    print(f"  {attack_name} complete: {cracked:,} new cracks (potfile total: {pot_after:,})")

    # Wait for hashcat to fully exit
    for _ in range(10):
        if not is_hashcat_running(config):
            break
        time.sleep(3)


def _launch_attack(config, hashcat_cmd, screen_name, log_file):
    """Launch hashcat in a screen session."""
    # Clean up previous session
    try:
        ssh_cmd(config, f"screen -X -S {screen_name} quit 2>/dev/null; rm -f {log_file}", timeout=10)
    except Exception:
        pass

    # Ensure logs dir exists
    try:
        ssh_cmd(config, f"mkdir -p {config.work_dir}/logs", timeout=10)
    except Exception:
        pass

    escaped = hashcat_cmd.replace("'", "'\\''")
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


def _poll_attack(config, chunk_id, attack_name, screen_name, log_file, pot_before):
    """Poll until hashcat completes. Triple completion check."""
    start = time.time()
    not_running = 0

    while time.time() - start < MAX_WAIT:
        time.sleep(POLL_INTERVAL)
        try:
            hc = is_hashcat_running(config)
            sc = is_screen_alive(config, screen_name)
            done = is_log_complete(config, log_file)
            pot = get_potfile_count(config, f"{chunk_id}.pot")
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
                print(f"  [{el}] {attack_name} running - potfile: {pot:,} (+{new}){progress}")
            elif done:
                print(f"  {attack_name} finished (log confirmed)")
                break
            else:
                not_running += 1
                print(f"  [{el}] not detected ({not_running}/2) - potfile: {pot:,}")
                if not_running >= 2:
                    print(f"  {attack_name} stopped")
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


# =============================================================================
# Phase 4: COLLECT — Redistribute Results to Batches
# =============================================================================

def collect_chunk(config, chunk_id, state):
    """Download potfile, redistribute cracks to per-batch diamond files."""
    chunk_info = state["chunks"].get(chunk_id)
    if not chunk_info:
        print(f"ERROR: {chunk_id} not found in state")
        return False

    if chunk_info.get("redistributed"):
        print(f"  {chunk_id} already redistributed")
        return True

    # Verify all 3 attacks completed
    for attack in ATTACK_ORDER:
        a = chunk_info.get("attacks", {}).get(attack, {})
        if a.get("status") != "completed":
            print(f"  ERROR: {attack} not completed for {chunk_id}. Run attacks first.")
            return False

    DIAMONDS_DIR.mkdir(parents=True, exist_ok=True)

    # Download potfile
    remote_pot = f"{config.work_dir}/potfiles/{chunk_id}.pot"
    local_pot = DATA_DIR / f"{chunk_id}.pot.tmp"

    print(f"  Downloading potfile for {chunk_id}...")
    scp_download(config, remote_pot, local_pot)

    # Parse potfile into dict: hash -> plaintext
    print(f"  Parsing potfile...")
    pot_dict = {}
    for line in local_pot.read_text(encoding="utf-8", errors="replace").splitlines():
        colon = line.find(":")
        if colon < 0:
            continue
        h = line[:colon].strip().lower()
        pw = line[colon + 1:]
        if re.match(r'^[a-f0-9]{40}$', h):
            pot_dict[h] = pw

    total_pot_cracks = len(pot_dict)
    print(f"  Potfile: {total_pot_cracks:,} unique cracks")

    # Load existing master pairs to avoid duplicate appends
    master_pairs_path = DIAMONDS_DIR / "hash_plaintext_pairs.txt"
    existing_master_hashes = set()
    if master_pairs_path.exists():
        with open(master_pairs_path, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                colon = line.find(":")
                if colon > 0:
                    existing_master_hashes.add(line[:colon].strip().lower())

    # Redistribute to per-batch files
    sand_state = load_sand_state()
    total_redistributed = 0
    master_pairs_new = []

    for batch_name in chunk_info["batches"]:
        batch_hashes = read_hashes_from_batch(batch_name)
        batch_hash_set = set(batch_hashes)
        batch_count = len(batch_hashes)

        # Find cracks for this batch
        batch_cracks = []
        for h in batch_hashes:
            if h in pot_dict:
                batch_cracks.append((h, pot_dict[h]))

        batch_crack_count = len(batch_cracks)

        if batch_crack_count > 0:
            # Load existing diamond hashes for this batch to avoid duplicates
            batch_diamond_path = DIAMONDS_DIR / f"{batch_name}.txt"
            existing_batch_hashes = set()
            if batch_diamond_path.exists():
                with open(batch_diamond_path, "r", encoding="utf-8", errors="replace") as f:
                    for line in f:
                        colon = line.find(":")
                        if colon > 0:
                            existing_batch_hashes.add(line[:colon].strip().lower())

            # Append new hash:plaintext pairs
            new_pairs = [(h, pw) for h, pw in batch_cracks if h not in existing_batch_hashes]

            if new_pairs:
                with open(batch_diamond_path, "a", encoding="utf-8") as f:
                    for h, pw in new_pairs:
                        f.write(f"{h}:{pw}\n")

                # Append plaintexts
                pw_path = DIAMONDS_DIR / f"passwords-{batch_name}.txt"
                with open(pw_path, "a", encoding="utf-8") as f:
                    for _, pw in new_pairs:
                        f.write(pw + "\n")

                # Collect for master file
                for h, pw in new_pairs:
                    if h not in existing_master_hashes:
                        master_pairs_new.append(f"{h}:{pw}")
                        existing_master_hashes.add(h)

        # Update sand-state.json
        if batch_name not in sand_state["batches"]:
            sand_state["batches"][batch_name] = {
                "hashlistId": 0,
                "hashCount": batch_count,
                "attacksApplied": [],
                "attacksRemaining": list(DEFAULT_SAND_ATTACK_ORDER),
                "taskIds": {},
                "cracked": 0,
                "startedAt": datetime.now().isoformat(),
                "status": "pending",
            }

        batch_state = sand_state["batches"][batch_name]
        for attack in ATTACK_ORDER:
            if attack in batch_state.get("attacksRemaining", []):
                batch_state["attacksRemaining"].remove(attack)
            if attack not in batch_state.get("attacksApplied", []):
                batch_state["attacksApplied"].append(attack)
        batch_state["cracked"] = batch_state.get("cracked", 0) + batch_crack_count
        batch_state["lastAttackAt"] = datetime.now().isoformat()
        batch_state["status"] = "in_progress"

        total_redistributed += batch_crack_count

        if batch_crack_count > 0:
            rate = batch_crack_count / batch_count * 100 if batch_count > 0 else 0
            print(f"    {batch_name}: {batch_crack_count:,} / {batch_count:,} ({rate:.1f}%)")

    # Append to master pairs file
    if master_pairs_new:
        with open(master_pairs_path, "a", encoding="utf-8") as f:
            for pair in master_pairs_new:
                f.write(pair + "\n")
        print(f"  Master pairs: {len(master_pairs_new):,} new entries appended")

    # Save sand state
    save_sand_state(sand_state)

    # Verify invariant
    if total_redistributed != total_pot_cracks:
        print(f"  WARNING: Redistributed {total_redistributed:,} != potfile {total_pot_cracks:,}")
        print(f"  (Some hashes may appear in multiple batches or not match any batch)")
    else:
        print(f"  Invariant OK: redistributed {total_redistributed:,} == potfile {total_pot_cracks:,}")

    # Mark chunk as redistributed
    chunk_info["redistributed"] = True
    chunk_info["collected"] = True
    chunk_info["completedAt"] = datetime.now().isoformat()
    state["totalCracked"] = sum(
        c.get("potfileLines", 0) for c in state["chunks"].values() if c.get("redistributed")
    )
    state["totalProcessed"] = sum(
        1 for c in state["chunks"].values() if c.get("redistributed")
    )
    save_state(state)

    # Cleanup temp potfile
    local_pot.unlink(missing_ok=True)

    # Cleanup chunk file from local disk
    chunk_local = SAND_DIR / f"{chunk_id}.txt"
    if chunk_local.exists():
        chunk_local.unlink()
        print(f"  Cleaned up local {chunk_id}.txt")

    # Cleanup remote files
    try:
        ssh_cmd(config, (
            f"rm -f {config.work_dir}/hashlists/{chunk_id}.txt "
            f"{config.work_dir}/potfiles/{chunk_id}.pot "
            f"{config.work_dir}/logs/{chunk_id}-*.log"
        ), timeout=15)
        print(f"  Cleaned up BIGRED files for {chunk_id}")
    except Exception:
        print(f"  WARNING: Could not clean BIGRED files for {chunk_id}")

    print(f"\n  {chunk_id} redistribution complete: {total_redistributed:,} cracks across {len(chunk_info['batches'])} batches")
    return True


# =============================================================================
# Phase 5: GLASS — Compute Uncracked Survivors
# =============================================================================

def compute_glass(batch_name=None):
    """Compute GLASS files for fully-completed batches."""
    sand_state = load_sand_state()
    GLASS_DIR.mkdir(parents=True, exist_ok=True)

    if batch_name:
        batches_to_process = [batch_name]
    else:
        # Find all batches with status == "completed" (all 17 attacks done)
        batches_to_process = [
            name for name, b in sand_state.get("batches", {}).items()
            if b.get("status") == "completed"
        ]

    if not batches_to_process:
        print("No completed batches found for GLASS computation.")
        print("(Batches must have all 17 attacks completed.)")
        return

    total_glass = 0
    total_cracked = 0
    total_sand = 0

    for bname in sorted(batches_to_process):
        glass_path = GLASS_DIR / f"{bname}.txt"

        # Skip if already computed
        if glass_path.exists() and glass_path.stat().st_size > 0:
            print(f"  {bname}: GLASS already exists, skipping")
            continue

        # Load SAND hashes
        try:
            sand_hashes = set(read_hashes_from_batch(bname))
        except FileNotFoundError:
            print(f"  {bname}: SAND file not found, skipping")
            continue

        sand_count = len(sand_hashes)

        # Load cracked hashes from diamonds
        diamond_path = DIAMONDS_DIR / f"{bname}.txt"
        cracked_hashes = set()
        if diamond_path.exists():
            with open(diamond_path, "r", encoding="utf-8", errors="replace") as f:
                for line in f:
                    colon = line.find(":")
                    if colon > 0:
                        h = line[:colon].strip().lower()
                        if len(h) == 40:
                            cracked_hashes.add(h)

        cracked_count = len(cracked_hashes)

        # GLASS = SAND - cracked
        glass_hashes = sand_hashes - cracked_hashes
        glass_count = len(glass_hashes)

        # Verify invariant
        if cracked_count + glass_count != sand_count:
            print(f"  WARNING {bname}: cracked({cracked_count}) + glass({glass_count}) = {cracked_count + glass_count} != sand({sand_count})")
        else:
            rate = cracked_count / sand_count * 100 if sand_count > 0 else 0
            print(f"  {bname}: {cracked_count:,}/{sand_count:,} cracked ({rate:.1f}%), {glass_count:,} glass")

        # Write GLASS
        with open(glass_path, "w", encoding="utf-8") as f:
            for h in sorted(glass_hashes):
                f.write(h + "\n")

        total_glass += glass_count
        total_cracked += cracked_count
        total_sand += sand_count

    if total_sand > 0:
        rate = total_cracked / total_sand * 100
        print(f"\n  GLASS summary: {total_cracked:,}/{total_sand:,} cracked ({rate:.1f}%), {total_glass:,} glass")


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

    # hashcat — must NOT be running at startup
    if is_hashcat_running(config):
        print(f"  FAIL: hashcat already running. Kill it first:")
        print(f"        ssh pai@{config.host} 'killall -9 hashcat'")
        return False
    else:
        print(f"  hashcat: ready")

    # Disk
    try:
        df = ssh_cmd(config, f"df -h {config.work_dir} | tail -1 | awk '{{print $4}}'")
        print(f"  Disk free: {df}")
    except Exception:
        pass

    # Ensure directories
    try:
        ssh_cmd(config, f"mkdir -p {config.work_dir}/{{hashlists,potfiles,logs}}", timeout=10)
        print(f"  Work dirs: ready")
    except Exception as e:
        print(f"  WARNING: Could not create work dirs: {e}")

    # Sand batches
    batches = get_sand_batches()
    print(f"  Sand batches: {len(batches):,}")

    print("--- PRE-FLIGHT PASSED ---")
    return True


# =============================================================================
# Status
# =============================================================================

def show_status():
    state = load_state()
    sand_state = load_sand_state()

    print("\n=== Sand Bruteforcer Status ===\n")

    chunks = state.get("chunks", {})
    if not chunks:
        print("No plan yet. Run --plan first.")
        return

    print(f"Chunk size:    {state.get('chunkSize', DEFAULT_CHUNK_SIZE):,} hashes")
    print(f"Total chunks:  {state.get('totalChunks', 0)}")
    print(f"Processed:     {state.get('totalProcessed', 0)}")
    print(f"Total cracked: {state.get('totalCracked', 0):,}")
    if state.get("lastUpdated"):
        print(f"Updated:       {state['lastUpdated']}")

    print(f"\nChunk Details:")
    for cid in sorted(chunks.keys()):
        c = chunks[cid]
        nb = len(c.get("batches", []))
        hc = c.get("hashCount", 0)
        attacks = c.get("attacks", {})

        status_parts = []
        for a in ATTACK_ORDER:
            ai = attacks.get(a, {})
            s = ai.get("status", "pending")
            cr = ai.get("cracked", 0)
            if s == "completed":
                status_parts.append(f"{a}={cr:,}")
            elif s == "running":
                status_parts.append(f"{a}=RUNNING")
            else:
                status_parts.append(f"{a}=pending")

        redist = "REDISTRIBUTED" if c.get("redistributed") else "pending"
        print(f"  {cid}: {nb} batches, {hc:,} hashes | {' | '.join(status_parts)} | {redist}")

    # Sand-state summary for brute attacks
    sb = sand_state.get("batches", {})
    brute_done = sum(
        1 for b in sb.values()
        if {"brute-5", "brute-6", "brute-7"}.issubset(set(b.get("attacksApplied", [])))
    )
    print(f"\nSand-state: {brute_done}/{len(sb)} batches have brute-5/6/7 done")


# =============================================================================
# Process Chunk (orchestrates build + upload + attacks)
# =============================================================================

def process_chunk(config, chunk_id, state, attack_filter=None):
    """Process one chunk: build, upload, run attacks."""
    chunk_info = state["chunks"].get(chunk_id)
    if not chunk_info:
        print(f"ERROR: {chunk_id} not found in plan")
        return False

    print(f"\n{'=' * 60}")
    print(f"  {chunk_id}: {len(chunk_info['batches'])} batches, {chunk_info['hashCount']:,} hashes")
    print(f"{'=' * 60}")

    # Build chunk file
    chunk_path = build_chunk(chunk_id, chunk_info)
    save_state(state)

    # Upload to BIGRED
    upload_chunk(config, chunk_id, chunk_path)
    chunk_info["uploaded"] = True
    save_state(state)

    # Run attacks
    attacks_to_run = [attack_filter] if attack_filter else ATTACK_ORDER
    for attack_name in attacks_to_run:
        if attack_name not in ATTACKS:
            print(f"  ERROR: Unknown attack '{attack_name}'")
            return False

        run_attack(config, chunk_id, attack_name, chunk_info)
        save_state(state)

    return True


# =============================================================================
# Main
# =============================================================================

def main():
    args = sys.argv[1:]

    # Parse arguments
    chunk_size = DEFAULT_CHUNK_SIZE
    if "--chunk-size" in args:
        idx = args.index("--chunk-size")
        if idx + 1 < len(args):
            chunk_size = int(args[idx + 1])
            print(f"Chunk size override: {chunk_size:,}")

    # --status
    if "--status" in args:
        show_status()
        return

    # --plan
    if "--plan" in args:
        build_plan(chunk_size, force_replan=True)
        return

    # --glass
    if "--glass" in args:
        batch_name = None
        if "--batch" in args:
            idx = args.index("--batch")
            if idx + 1 < len(args):
                n = int(args[idx + 1])
                batch_name = f"batch-{n:04d}"
        compute_glass(batch_name)
        return

    # --attack filter (optional, applies to --next or --chunk)
    attack_filter = None
    if "--attack" in args:
        idx = args.index("--attack")
        if idx + 1 < len(args):
            attack_filter = args[idx + 1]
            if attack_filter not in ATTACKS:
                print(f"ERROR: Unknown attack '{attack_filter}'. Valid: {', '.join(ATTACK_ORDER)}")
                sys.exit(1)

    # --collect N
    if "--collect" in args:
        idx = args.index("--collect")
        if idx + 1 < len(args):
            n = int(args[idx + 1])
            chunk_id = f"chunk-{n:04d}"
        else:
            print("ERROR: --collect requires a chunk number")
            sys.exit(1)

        config = BigRedConfig()
        state = load_state()
        if chunk_id not in state.get("chunks", {}):
            print(f"ERROR: {chunk_id} not found in state. Run --plan first.")
            sys.exit(1)
        collect_chunk(config, chunk_id, state)
        return

    # Initialize config and preflight
    config = BigRedConfig()
    print(f"BIGRED: {config.user}@{config.host}")
    print(f"Attacks: {', '.join(ATTACK_ORDER)}")
    if attack_filter:
        print(f"Attack filter: {attack_filter}")

    # Ensure plan exists
    state = load_state()
    if not state.get("chunks"):
        print("\nNo plan found. Building plan...")
        state = build_plan(chunk_size)
        if not state.get("chunks"):
            print("No chunks to process.")
            return

    if not preflight(config):
        sys.exit(1)

    # --chunk N
    if "--chunk" in args:
        idx = args.index("--chunk")
        if idx + 1 < len(args):
            n = int(args[idx + 1])
            chunk_id = f"chunk-{n:04d}"
        else:
            print("ERROR: --chunk requires a number")
            sys.exit(1)

        if chunk_id not in state["chunks"]:
            print(f"ERROR: {chunk_id} not found in plan")
            sys.exit(1)

        t0 = time.time()
        try:
            process_chunk(config, chunk_id, state, attack_filter)
        except KeyboardInterrupt:
            print(f"\n\nInterrupted.")
            save_state(state)
        print(f"\nDone in {fmt_dur(time.time() - t0)}")
        return

    # --next
    if "--next" in args:
        # Find next chunk that needs work
        chunk_id = None
        for cid in sorted(state["chunks"].keys()):
            c = state["chunks"][cid]
            if c.get("redistributed"):
                continue
            # Check if all requested attacks are done
            if attack_filter:
                a = c.get("attacks", {}).get(attack_filter, {})
                if a.get("status") == "completed":
                    continue
            else:
                all_done = all(
                    c.get("attacks", {}).get(a, {}).get("status") == "completed"
                    for a in ATTACK_ORDER
                )
                if all_done:
                    continue
            chunk_id = cid
            break

        if not chunk_id:
            print("All chunks processed!")
            return

        t0 = time.time()
        try:
            process_chunk(config, chunk_id, state, attack_filter)
        except KeyboardInterrupt:
            print(f"\n\nInterrupted.")
            save_state(state)
        print(f"\nDone in {fmt_dur(time.time() - t0)}")
        return

    # Default: show help
    print("\nUsage:")
    print("  python Tools/sand_bruteforcer.py --plan              Build/show chunk plan")
    print("  python Tools/sand_bruteforcer.py --next              Process next pending chunk")
    print("  python Tools/sand_bruteforcer.py --chunk N           Process specific chunk")
    print("  python Tools/sand_bruteforcer.py --attack brute-7    Filter to one attack")
    print("  python Tools/sand_bruteforcer.py --collect N         Redistribute chunk N results")
    print("  python Tools/sand_bruteforcer.py --glass             Compute GLASS for completed batches")
    print("  python Tools/sand_bruteforcer.py --glass --batch N   Compute GLASS for specific batch")
    print("  python Tools/sand_bruteforcer.py --status            Show progress summary")
    print("  python Tools/sand_bruteforcer.py --chunk-size N      Override max hashes per chunk")


if __name__ == "__main__":
    main()
