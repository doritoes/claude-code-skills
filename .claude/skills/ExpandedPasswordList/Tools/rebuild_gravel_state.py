#!/usr/bin/env python3
"""
rebuild_gravel_state.py - Reconstruct gravel-state.json from existing output files

Scans pearls/ and sand/ directories, counts lines per batch, verifies the
PEARLS + SAND = GRAVEL invariant, and writes a new gravel-state.json with
all completed batches.

Usage:
  python Tools/rebuild_gravel_state.py              Preview (dry run)
  python Tools/rebuild_gravel_state.py --execute    Write the rebuilt state
"""

import os
import sys
import json
from pathlib import Path
from datetime import datetime

import functools
print = functools.partial(print, flush=True)

# Paths
SCRIPT_DIR = Path(__file__).resolve().parent
SKILL_DIR = SCRIPT_DIR.parent
DATA_DIR = SKILL_DIR / "data"
GRAVEL_DIR = DATA_DIR / "gravel"
PEARLS_DIR = DATA_DIR / "pearls"
SAND_DIR = DATA_DIR / "sand"
STATE_FILE = DATA_DIR / "gravel-state.json"


def count_lines(path):
    """Count lines in a file efficiently."""
    count = 0
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        for _ in f:
            count += 1
    return count


def find_batches():
    """Find all batch names that have BOTH pearl and sand files."""
    pearl_batches = set()
    for f in PEARLS_DIR.iterdir():
        if f.name.startswith("batch-") and f.name.endswith(".txt"):
            pearl_batches.add(f.stem)

    sand_batches = set()
    for f in SAND_DIR.iterdir():
        if f.name.startswith("batch-") and f.name.endswith(".txt"):
            sand_batches.add(f.stem)

    both = sorted(pearl_batches & sand_batches)
    pearl_only = sorted(pearl_batches - sand_batches)
    sand_only = sorted(sand_batches - pearl_batches)

    return both, pearl_only, sand_only


def main():
    execute = "--execute" in sys.argv

    print("=" * 60)
    print("GRAVEL STATE REBUILDER")
    print("=" * 60)

    if not execute:
        print("\n  *** DRY RUN — use --execute to write state ***\n")

    # Find completed batches
    both, pearl_only, sand_only = find_batches()
    print(f"Batches with BOTH pearl + sand files: {len(both):,}")

    if pearl_only:
        print(f"WARNING: {len(pearl_only)} batches have pearls but no sand:")
        for b in pearl_only[:5]:
            print(f"  {b}")
        if len(pearl_only) > 5:
            print(f"  ... and {len(pearl_only) - 5} more")

    if sand_only:
        print(f"WARNING: {len(sand_only)} batches have sand but no pearls:")
        for b in sand_only[:5]:
            print(f"  {b}")
        if len(sand_only) > 5:
            print(f"  ... and {len(sand_only) - 5} more")

    # Process each batch
    state_batches = {}
    total_pearls = 0
    total_sand = 0
    total_gravel = 0
    invariant_failures = 0

    for i, batch in enumerate(both):
        pearl_path = PEARLS_DIR / f"{batch}.txt"
        sand_path = SAND_DIR / f"{batch}.txt"
        gravel_path = GRAVEL_DIR / f"{batch}.txt"

        pc = count_lines(pearl_path)
        sc = count_lines(sand_path)

        gc = 0
        invariant_ok = None
        if gravel_path.exists():
            gc = count_lines(gravel_path)
            if pc + sc == gc:
                invariant_ok = True
            else:
                invariant_ok = False
                invariant_failures += 1

        state_batches[batch] = {
            "status": "completed",
            "gravelCount": gc,
            "pearlCount": pc,
            "sandCount": sc,
            "completedAt": datetime.now().isoformat(),
        }

        total_pearls += pc
        total_sand += sc
        total_gravel += gc

        if (i + 1) % 200 == 0 or (i + 1) == len(both):
            pct = total_pearls / total_gravel * 100 if total_gravel > 0 else 0
            print(f"  [{i+1:>5}/{len(both)}] {batch} | "
                  f"pearls: {pc:,} sand: {sc:,} gravel: {gc:,} | "
                  f"running rate: {pct:.2f}%"
                  + (f" | INVARIANT FAIL" if invariant_ok is False else ""))

        if invariant_ok is False:
            print(f"  WARNING: {batch} invariant FAIL: "
                  f"pearls({pc}) + sand({sc}) = {pc+sc} != gravel({gc})")

    # Summary
    rate = total_pearls / total_gravel * 100 if total_gravel > 0 else 0
    print(f"\n{'=' * 60}")
    print(f"SUMMARY")
    print(f"{'=' * 60}")
    print(f"  Completed batches: {len(state_batches):,}")
    print(f"  Total PEARLS:      {total_pearls:,}")
    print(f"  Total SAND:        {total_sand:,}")
    print(f"  Total GRAVEL:      {total_gravel:,}")
    print(f"  Crack rate:        {rate:.2f}%")
    print(f"  Invariant checks:  {len(both) - invariant_failures} passed, {invariant_failures} failed")

    if not execute:
        print(f"\n  *** DRY RUN — use --execute to write state ***")
        return

    # Build state
    state = {
        "version": "2.0",
        "attack": "nocap-nocaprule",
        "batches": state_batches,
        "totalProcessed": len(state_batches),
        "totalPearls": total_pearls,
        "totalSand": total_sand,
        "lastUpdated": datetime.now().isoformat(),
        "rebuiltFrom": "pearl/sand files",
        "rebuiltAt": datetime.now().isoformat(),
    }

    # Backup existing state if present
    if STATE_FILE.exists():
        bak = STATE_FILE.with_suffix(".json.bak")
        if bak.exists():
            bak.unlink()
        STATE_FILE.rename(bak)
        print(f"\n  Backed up existing state to {bak.name}")

    with open(STATE_FILE, "w") as f:
        json.dump(state, f, indent=2)

    print(f"  Wrote {STATE_FILE.name} ({len(state_batches):,} batches)")
    print(f"\n  State rebuilt successfully. Resume with:")
    print(f"    python Tools/gravel_processor.py")


if __name__ == "__main__":
    main()
