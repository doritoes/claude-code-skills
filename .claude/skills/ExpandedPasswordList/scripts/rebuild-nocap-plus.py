#!/usr/bin/env python3
"""
rebuild-nocap-plus.py — Rebuild nocap-plus.txt from nocap.txt + all cohort files.

Ensures clean output for hashcat:
  - Strips comment lines (^#)
  - Strips blank lines
  - Strips leading/trailing whitespace
  - Removes \\r (Windows line endings)
  - Deduplicates via sort -u equivalent

Usage:
  python scripts/rebuild-nocap-plus.py           # rebuild from data/
  python scripts/rebuild-nocap-plus.py --dry-run  # show counts without writing

Called by: BatchRunner.ts (Step 5), manual after cohort changes
Output: data/nocap-plus.txt
"""

import os
import sys
import glob
import time

def find_data_dir():
    """Resolve data directory (same logic as config.ts)"""
    script_dir = os.path.dirname(os.path.abspath(__file__))
    skill_dir = os.path.dirname(script_dir)

    # Check EPL_DATA_PATH env var
    env_path = os.environ.get("EPL_DATA_PATH")
    if env_path and os.path.isdir(env_path):
        return env_path

    data_path = os.path.join(skill_dir, "data")

    # Direct directory or symlink
    if os.path.isdir(data_path):
        return data_path

    # Legacy: file containing a path
    if os.path.isfile(data_path):
        with open(data_path, "r") as f:
            network_path = f.read().strip()
        if network_path and os.path.isdir(network_path):
            return network_path

    return data_path


def rebuild(data_dir: str, dry_run: bool = False) -> int:
    nocap_path = os.path.join(data_dir, "nocap.txt")
    cohort_dir = os.path.join(data_dir, "cohorts")
    output_path = os.path.join(data_dir, "nocap-plus.txt")

    if not os.path.isfile(nocap_path):
        print(f"ERROR: nocap.txt not found at {nocap_path}", file=sys.stderr)
        return 1

    # Collect all input files
    input_files = [nocap_path]
    cohort_files = sorted(glob.glob(os.path.join(cohort_dir, "*.txt")))
    input_files.extend(cohort_files)

    print(f"  Data dir: {data_dir}")
    print(f"  Base wordlist: nocap.txt")
    print(f"  Cohort files: {len(cohort_files)}")
    for cf in cohort_files:
        print(f"    - {os.path.basename(cf)}")

    # Read all words into a set (dedup)
    words = set()
    total_lines = 0
    comments_stripped = 0
    blanks_stripped = 0

    for filepath in input_files:
        with open(filepath, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                total_lines += 1
                # Strip \r and whitespace
                word = line.strip().replace("\r", "")

                # Skip comments
                if word.startswith("#"):
                    comments_stripped += 1
                    continue

                # Skip blank lines
                if not word:
                    blanks_stripped += 1
                    continue

                words.add(word)

    print(f"\n  Total input lines: {total_lines:,}")
    print(f"  Comments stripped: {comments_stripped:,}")
    print(f"  Blank lines stripped: {blanks_stripped:,}")
    print(f"  Unique words: {len(words):,}")

    if dry_run:
        print(f"\n  [DRY RUN] Would write {len(words):,} words to {output_path}")
        return 0

    # Write sorted output
    t0 = time.time()
    sorted_words = sorted(words)

    # Write to .new file first, then rename (safe write)
    tmp_path = output_path + ".new"
    with open(tmp_path, "w", encoding="utf-8", newline="\n") as f:
        for word in sorted_words:
            f.write(word + "\n")

    # Verify line count
    with open(tmp_path, "r", encoding="utf-8") as f:
        count = sum(1 for _ in f)

    if count != len(words):
        print(f"  ERROR: Written {count:,} but expected {len(words):,}. Keeping old file.", file=sys.stderr)
        os.remove(tmp_path)
        return 1

    # Atomic rename
    if os.path.exists(output_path):
        os.replace(tmp_path, output_path)
    else:
        os.rename(tmp_path, output_path)

    elapsed = time.time() - t0
    print(f"\n  Written: {output_path}")
    print(f"  Words: {len(words):,}")
    print(f"  Time: {elapsed:.1f}s")

    return 0


if __name__ == "__main__":
    dry_run = "--dry-run" in sys.argv
    data_dir = find_data_dir()

    print("=" * 60)
    print("  REBUILD nocap-plus.txt")
    print("=" * 60)

    exit_code = rebuild(data_dir, dry_run)
    sys.exit(exit_code)
