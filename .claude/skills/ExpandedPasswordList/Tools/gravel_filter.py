#!/usr/bin/env python3
"""
gravel_filter.py - ROCKS -> GRAVEL Filter (1:1 batch correspondence)

Reads rockyou.txt, computes SHA-1 hashes in memory, filters each ROCKS batch
to produce a corresponding GRAVEL batch. Also saves hash:plaintext pairs for
every rockyou match into rocks/batch-NNNN-pairs.txt.

Invariant: rocks/batch-NNNN.txt - SHA1(rockyou.txt) = gravel/batch-NNNN.txt

No pre-computed indexes. No trust in intermediate files. Straight from source.

Output per batch:
  gravel/batch-NNNN.txt        Uncracked hashes (gravel)
  rocks/batch-NNNN-pairs.txt   Cracked hash:plaintext pairs

Memory: ~2-3GB (14.3M SHA-1 -> plaintext dict)

Usage:
  python gravel_filter.py                    Filter all (with resume)
  python gravel_filter.py --no-resume        Start fresh
  python gravel_filter.py --verify           Verify invariant
  python gravel_filter.py --status           Show progress
  python gravel_filter.py --rockyou PATH     Alternate rockyou.txt
"""

import hashlib
import json
import os
import re
import sys
import time
from pathlib import Path

# Resolve paths
SCRIPT_DIR = Path(__file__).parent
SKILL_DIR = SCRIPT_DIR.parent
PROJECT_ROOT = SKILL_DIR.parent.parent.parent

# Data dir: check for symlink/directory at skill level
DATA_DIR = SKILL_DIR / "data"
if not DATA_DIR.exists():
    print(f"ERROR: Data directory not found: {DATA_DIR}")
    sys.exit(1)

ROCKS_DIR = DATA_DIR / "rocks"
GRAVEL_DIR = DATA_DIR / "gravel"
DEFAULT_ROCKYOU = PROJECT_ROOT / "rockyou.txt"
PROGRESS_FILE = DATA_DIR / "gravel-filter-progress.json"


def fmt_duration(seconds):
    if seconds < 60:
        return f"{seconds:.0f}s"
    if seconds < 3600:
        return f"{int(seconds // 60)}m {int(seconds % 60)}s"
    hours = int(seconds // 3600)
    mins = int((seconds % 3600) // 60)
    return f"{hours}h {mins}m"


def fmt_num(n):
    return f"{n:,}"


def load_progress():
    if PROGRESS_FILE.exists():
        return json.loads(PROGRESS_FILE.read_text())
    return {
        "lastCompletedBatch": 0,
        "totalRocksHashes": 0,
        "totalRockyouFiltered": 0,
        "totalGravelHashes": 0,
        "batchesProcessed": 0,
        "rockyouEntries": 0,
        "rockyouPath": "",
        "startedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "lastUpdated": time.strftime("%Y-%m-%dT%H:%M:%S"),
    }


def save_progress(progress):
    progress["lastUpdated"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    PROGRESS_FILE.write_text(json.dumps(progress, indent=2))


def build_rockyou_hash_dict(rockyou_path):
    """Read rockyou.txt, SHA-1 hash every entry, return as dict {uppercase_hex: plaintext}.

    For duplicate SHA-1s (different entries producing same hash), keeps the first entry.
    """
    print(f"Reading rockyou.txt from: {rockyou_path}")
    start = time.time()

    hash_dict = {}
    processed = 0
    skipped = 0

    with open(rockyou_path, "r", encoding="utf-8", errors="surrogateescape") as f:
        for line in f:
            entry = line.rstrip("\n").rstrip("\r")
            if not entry:
                skipped += 1
                continue

            sha1 = hashlib.sha1(entry.encode("utf-8", errors="surrogateescape")).hexdigest().upper()
            if sha1 not in hash_dict:
                hash_dict[sha1] = entry
            processed += 1

            if processed % 1_000_000 == 0:
                elapsed = time.time() - start
                print(f"    {processed // 1_000_000}M hashed... ({fmt_duration(elapsed)})")

    elapsed = time.time() - start
    dupes = processed - len(hash_dict)
    print(f"  Done: {fmt_num(len(hash_dict))} unique SHA-1 hashes from {fmt_num(processed)} entries")
    print(f"  Skipped: {fmt_num(skipped)} empty lines")
    print(f"  Duplicates: {fmt_num(dupes)}")
    print(f"  Time: {fmt_duration(elapsed)}")
    return hash_dict


def get_rocks_batches():
    """Get sorted list of rocks batch files."""
    if not ROCKS_DIR.exists():
        return []
    batches = []
    for f in ROCKS_DIR.iterdir():
        m = re.match(r"^batch-(\d+)\.txt$", f.name)
        if m:
            batches.append({"number": int(m.group(1)), "filename": f.name})
    return sorted(batches, key=lambda b: b["number"])


def filter_batch(rockyou_hash_dict, rocks_file, gravel_file, pairs_file):
    """Filter a single rocks batch -> gravel batch + pairs file.

    Streams through rocks file line by line, writing gravel and pairs
    directly to output files. No intermediate lists held in memory.

    Args:
        rockyou_hash_dict: dict {SHA1_HEX: plaintext}
        rocks_file: path to rocks/batch-NNNN.txt
        gravel_file: path to gravel/batch-NNNN.txt (uncracked output)
        pairs_file: path to rocks/batch-NNNN-pairs.txt (hash:plaintext output)
    """
    rocks_count = 0
    filtered_count = 0
    gravel_count = 0

    with open(rocks_file, "r", encoding="utf-8", errors="surrogateescape") as rf, \
         open(gravel_file, "w", encoding="utf-8") as gf, \
         open(pairs_file, "w", encoding="utf-8", errors="surrogateescape") as pf:
        for line in rf:
            h = line.strip()
            if not h:
                continue
            rocks_count += 1
            plaintext = rockyou_hash_dict.get(h.upper())
            if plaintext is not None:
                pf.write(f"{h.upper()}:{plaintext}\n")
                filtered_count += 1
            else:
                gf.write(h + "\n")
                gravel_count += 1

    return {"rocksCount": rocks_count, "filteredCount": filtered_count, "gravelCount": gravel_count}


def filter_all(resume=True, rockyou_path=None):
    rockyou_path = rockyou_path or DEFAULT_ROCKYOU
    if not os.path.exists(rockyou_path):
        print(f"ERROR: rockyou.txt not found: {rockyou_path}")
        sys.exit(1)

    GRAVEL_DIR.mkdir(parents=True, exist_ok=True)

    rocks_batches = get_rocks_batches()
    if not rocks_batches:
        print(f"ERROR: No rocks batches in {ROCKS_DIR}")
        print("Run RocksExtractor first")
        sys.exit(1)

    # Build hash dict from rockyou.txt (SHA1 -> plaintext)
    rockyou_hashes = build_rockyou_hash_dict(rockyou_path)

    if resume:
        progress = load_progress()
    else:
        progress = load_progress()
        progress["lastCompletedBatch"] = 0
        progress["totalRocksHashes"] = 0
        progress["totalRockyouFiltered"] = 0
        progress["totalGravelHashes"] = 0
        progress["batchesProcessed"] = 0
        progress["startedAt"] = time.strftime("%Y-%m-%dT%H:%M:%S")

    progress["rockyouEntries"] = len(rockyou_hashes)
    progress["rockyouPath"] = str(rockyou_path)

    pending = [b for b in rocks_batches if b["number"] > progress["lastCompletedBatch"]]

    print()
    print("GravelFilter - ROCKS -> GRAVEL Filter")
    print("=====================================")
    print(f"Rockyou source: {rockyou_path}")
    print(f"Rockyou hashes: {fmt_num(len(rockyou_hashes))}")
    print(f"ROCKS source:   {ROCKS_DIR}")
    print(f"GRAVEL output:  {GRAVEL_DIR}")
    print(f"PAIRS output:   {ROCKS_DIR}/batch-NNNN-pairs.txt")
    print(f"Total batches:  {len(rocks_batches)}")
    print(f"Already done:   {progress['batchesProcessed']}")
    print(f"Pending:        {len(pending)}")
    print(f"Mode:           1:1 (rocks[N] - SHA1(rockyou) = gravel[N])")
    print()

    if not pending:
        print("All batches already filtered!")
        return

    start = time.time()

    for i, batch in enumerate(pending):
        batch_name = f"batch-{batch['number']:04d}"
        rocks_file = ROCKS_DIR / batch["filename"]
        gravel_file = GRAVEL_DIR / f"{batch_name}.txt"
        pairs_file = ROCKS_DIR / f"{batch_name}-pairs.txt"

        result = filter_batch(rockyou_hashes, rocks_file, gravel_file, pairs_file)

        progress["totalRocksHashes"] += result["rocksCount"]
        progress["totalRockyouFiltered"] += result["filteredCount"]
        progress["totalGravelHashes"] += result["gravelCount"]
        progress["batchesProcessed"] += 1
        progress["lastCompletedBatch"] = batch["number"]

        invariant_ok = result["rocksCount"] == result["filteredCount"] + result["gravelCount"]

        elapsed = time.time() - start
        done = i + 1
        rate = done / elapsed if elapsed > 0 else 0
        remaining = len(pending) - done
        eta = remaining / rate if rate > 0 else 0
        filter_pct = (result["filteredCount"] / result["rocksCount"] * 100) if result["rocksCount"] > 0 else 0

        status = "OK" if invariant_ok else "MISMATCH!"
        print(
            f"  {batch_name}: {fmt_num(result['rocksCount'])} rocks -> "
            f"{fmt_num(result['gravelCount'])} gravel ({filter_pct:.1f}% filtered) "
            f"{status} | {done}/{len(pending)} | ETA: {fmt_duration(eta)}"
        )

        if not invariant_ok:
            print(f"  INVARIANT VIOLATION: {result['rocksCount']} != {result['filteredCount']} + {result['gravelCount']}")

        if done % 50 == 0:
            save_progress(progress)

    save_progress(progress)

    total_time = time.time() - start
    overall_rate = (progress["totalRockyouFiltered"] / progress["totalRocksHashes"] * 100) if progress["totalRocksHashes"] > 0 else 0

    print()
    print("Filter Complete")
    print("===============")
    print(f"Batches processed:      {progress['batchesProcessed']}")
    print(f"Total ROCKS hashes:     {fmt_num(progress['totalRocksHashes'])}")
    print(f"Rockyou filtered:       {fmt_num(progress['totalRockyouFiltered'])} ({overall_rate:.2f}%)")
    print(f"GRAVEL output:          {fmt_num(progress['totalGravelHashes'])}")
    print(f"Pairs files:            {ROCKS_DIR}/batch-NNNN-pairs.txt")
    print(f"Time:                   {fmt_duration(total_time)}")
    print(f"Invariant:              rocks[N] - SHA1(rockyou) = gravel[N]")


def verify(rockyou_path=None):
    rockyou_path = rockyou_path or DEFAULT_ROCKYOU
    rockyou_hashes = build_rockyou_hash_dict(rockyou_path)
    rocks_batches = get_rocks_batches()
    violations = 0
    verified = 0

    print(f"\nVerifying {len(rocks_batches)} batch pairs...")

    for batch in rocks_batches:
        batch_name = f"batch-{batch['number']:04d}"
        rocks_file = ROCKS_DIR / batch["filename"]
        gravel_file = GRAVEL_DIR / f"{batch_name}.txt"

        if not gravel_file.exists():
            print(f"  {batch_name}: MISSING gravel file")
            violations += 1
            continue

        with open(rocks_file) as f:
            rocks_lines = [l.strip() for l in f if l.strip()]
        with open(gravel_file) as f:
            gravel_set = {l.strip() for l in f if l.strip()}

        rocks_set = set(rocks_lines)
        rockyou_in_gravel = sum(1 for h in gravel_set if h.upper() in rockyou_hashes)
        gravel_not_in_rocks = sum(1 for h in gravel_set if h not in rocks_set)
        unaccounted = sum(1 for h in rocks_lines if h not in gravel_set and h.upper() not in rockyou_hashes)

        if rockyou_in_gravel > 0 or gravel_not_in_rocks > 0 or unaccounted > 0:
            print(f"  {batch_name}: VIOLATION — rockyou_in_gravel={rockyou_in_gravel}, gravel_not_in_rocks={gravel_not_in_rocks}, unaccounted={unaccounted}")
            violations += 1
        else:
            verified += 1

        if (verified + violations) % 100 == 0:
            print(f"  ... {verified + violations}/{len(rocks_batches)} checked")

    print(f"\nVerification: {verified} OK, {violations} violations out of {len(rocks_batches)} batches")


def show_status():
    progress = load_progress()
    rocks_batches = get_rocks_batches()
    gravel_count = len([f for f in GRAVEL_DIR.iterdir() if f.name.startswith("batch-") and f.name.endswith(".txt")]) if GRAVEL_DIR.exists() else 0

    print()
    print("GravelFilter Status")
    print("===================")
    print(f"Rockyou source:    {progress.get('rockyouPath', '(not set)')}")
    print(f"Rockyou hashes:    {fmt_num(progress.get('rockyouEntries', 0))}")
    print(f"ROCKS batches:     {len(rocks_batches)}")
    print(f"GRAVEL batches:    {gravel_count}")
    print(f"Batches filtered:  {progress['batchesProcessed']}")
    print(f"ROCKS hashes:      {fmt_num(progress['totalRocksHashes'])}")
    print(f"Rockyou filtered:  {fmt_num(progress['totalRockyouFiltered'])}")
    print(f"GRAVEL hashes:     {fmt_num(progress['totalGravelHashes'])}")
    print(f"Started:           {progress['startedAt']}")
    print(f"Last updated:      {progress['lastUpdated']}")


if __name__ == "__main__":
    args = sys.argv[1:]

    rockyou_path = DEFAULT_ROCKYOU
    if "--rockyou" in args:
        idx = args.index("--rockyou")
        if idx + 1 < len(args):
            rockyou_path = Path(args[idx + 1])

    if "--help" in args or "-h" in args:
        print(__doc__)
        sys.exit(0)
    elif "--status" in args:
        show_status()
    elif "--verify" in args:
        verify(rockyou_path)
    elif "--no-resume" in args:
        filter_all(resume=False, rockyou_path=rockyou_path)
    else:
        filter_all(resume=True, rockyou_path=rockyou_path)
