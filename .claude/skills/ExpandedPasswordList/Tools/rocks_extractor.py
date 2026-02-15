#!/usr/bin/env python3
"""
rocks_extractor.py — Extract ALL HIBP hashes into ROCKS batch files.

Reads hibp-batched/*.json.gz and extracts every SHA-1 hash into
rocks/batch-NNNN.txt files (500,000 hashes per file).

Memory strategy: Each HIBP file (~350MB decompressed) is streamed to a
temp file on disk, then memory-mapped for parsing. The mmap is managed
by the OS — not Python's heap — so memory is fully reclaimed after each
file regardless of pymalloc arena behavior.

Usage:
    python rocks_extractor.py              # Extract all (with resume)
    python rocks_extractor.py --no-resume  # Clean and start fresh
    python rocks_extractor.py --status     # Show progress
"""

import gc
import gzip
import json
import mmap
import os
import sys
import time

# ─── Paths ───────────────────────────────────────────────────────────────────

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
SKILL_DIR = os.path.dirname(SCRIPT_DIR)

DATA_DIR = os.path.join(SKILL_DIR, "data")
if os.path.isfile(DATA_DIR):
    with open(DATA_DIR) as f:
        p = f.read().strip()
        if os.path.isdir(p):
            DATA_DIR = p

HIBP_DIR = os.path.join(DATA_DIR, "hibp-batched")
ROCKS_DIR = os.path.join(DATA_DIR, "rocks")
PROGRESS_FILE = os.path.join(DATA_DIR, "rocks-progress.json")
BATCH_SIZE = 500_000


# ─── Progress ────────────────────────────────────────────────────────────────

def load_progress():
    if os.path.exists(PROGRESS_FILE):
        with open(PROGRESS_FILE) as f:
            return json.load(f)
    return {
        "lastCompletedHibpBatch": -1,
        "totalHashesExtracted": 0,
        "batchesWritten": 0,
    }


def save_progress(prog):
    tmp = PROGRESS_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(prog, f, indent=2)
    os.replace(tmp, PROGRESS_FILE)


# ─── Utilities ───────────────────────────────────────────────────────────────

def fmt_duration(secs):
    if secs < 60:
        return f"{secs:.0f}s"
    if secs < 3600:
        return f"{int(secs // 60)}m {int(secs % 60)}s"
    return f"{int(secs // 3600)}h {int((secs % 3600) // 60)}m"


def clean_rocks_dir():
    """Remove all batch files and progress from a previous run."""
    if os.path.isdir(ROCKS_DIR):
        files = [f for f in os.listdir(ROCKS_DIR) if f.startswith("batch-")]
        if files:
            print(f"Cleaning {len(files)} existing rocks files...")
            for fname in files:
                os.unlink(os.path.join(ROCKS_DIR, fname))
    if os.path.exists(PROGRESS_FILE):
        os.unlink(PROGRESS_FILE)


# ─── HIBP File Processor (temp file + mmap) ─────────────────────────────────

def decompress_to_temp(gz_path):
    """Stream-decompress a .gz file to a temp file alongside it.

    Returns the temp file path. The caller is responsible for cleanup.
    Uses a 1MB read buffer so Python never holds the full decompressed
    content in memory.
    """
    tmp_path = gz_path + ".tmp"
    with gzip.open(gz_path, "rb") as src, open(tmp_path, "wb") as dst:
        while True:
            chunk = src.read(1 << 20)  # 1 MB
            if not chunk:
                break
            dst.write(chunk)
    return tmp_path


def scan_entries_from_mmap(mm, on_hash):
    """Walk an mmap'd HIBP JSON file and extract SHA-1 hashes.

    The JSON contains entries like:
        "ABCDE": {"prefix":"ABCDE", "data":"SUFFIX:COUNT\\r\\n...", ...}

    We locate each "prefix" and "data" field by byte scanning the mmap.
    This avoids JSON parsing entirely — no Python objects are created for
    the bulk data, keeping heap usage near zero.

    Args:
        mm: A read-only mmap object over the decompressed JSON file.
        on_hash: Callback receiving each 40-char uppercase SHA-1 hash string.

    Returns:
        Number of hashes found.
    """
    PREFIX_MARKER = b'"prefix":"'
    DATA_MARKER = b'"data":"'
    BACKSLASH = 0x5C  # ord('\\')
    DQUOTE = 0x22     # ord('"')

    count = 0
    pos = 0
    size = mm.size()

    while True:
        # Find the next entry by its "prefix" field
        pi = mm.find(PREFIX_MARKER, pos)
        if pi == -1:
            break

        # Read the 5-character hex prefix
        pstart = pi + len(PREFIX_MARKER)
        if pstart + 5 > size:
            break
        prefix = mm[pstart:pstart + 5].decode("ascii").upper()

        # Find the "data" field that follows
        di = mm.find(DATA_MARKER, pstart + 5)
        if di == -1:
            break

        # Scan forward to find the closing (unescaped) double-quote
        dstart = di + len(DATA_MARKER)
        scan = dstart
        while scan < size:
            byte = mm[scan]
            if byte == BACKSLASH:
                scan += 2  # skip the escaped character
                continue
            if byte == DQUOTE:
                break
            scan += 1

        # Extract the raw bytes of the data value and decode line endings.
        # In JSON, \r\n is stored as the 4-byte sequence 0x5C 0x72 0x5C 0x6E.
        raw = mm[dstart:scan]
        text = (
            raw
            .replace(b"\\r\\n", b"\n")
            .replace(b"\\n", b"\n")
            .replace(b"\\r", b"\n")
        )

        # Each line is SUFFIX:COUNT — we want the 35-char suffix
        for line in text.split(b"\n"):
            if len(line) >= 36 and line[35:36] == b":":
                suffix = line[:35].decode("ascii").upper()
                on_hash(prefix + suffix)
                count += 1

        pos = scan + 1

    return count


def process_hibp_file(gz_path, on_hash):
    """Extract all SHA-1 hashes from one HIBP .json.gz file.

    Decompresses to a temp file, memory-maps it for zero-heap parsing,
    then cleans up. The ~350MB decompressed content lives entirely in
    OS-managed virtual memory, never on Python's heap.

    Args:
        gz_path: Path to the HIBP .json.gz file.
        on_hash: Callback receiving each 40-char uppercase SHA-1 hash.

    Returns:
        Number of hashes extracted from this file.
    """
    tmp_path = decompress_to_temp(gz_path)
    try:
        file_size = os.path.getsize(tmp_path)
        if file_size == 0:
            return 0

        with open(tmp_path, "rb") as f:
            mm = mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ)
            try:
                return scan_entries_from_mmap(mm, on_hash)
            finally:
                mm.close()
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


# ─── Rocks Writer ────────────────────────────────────────────────────────────

class RocksWriter:
    """Writes hashes to sequential batch files with automatic rotation.

    Each file holds up to BATCH_SIZE hashes (one per line, uppercase,
    40-char SHA-1). Files are named batch-0001.txt, batch-0002.txt, etc.
    Uses a 4MB write buffer for efficient sequential I/O.
    """

    def __init__(self, start_batch=0):
        self.batch_num = start_batch
        self.line_count = 0
        self.fd = None
        self._rotate()

    def _rotate(self):
        if self.fd:
            self.fd.close()
        self.batch_num += 1
        path = os.path.join(ROCKS_DIR, f"batch-{self.batch_num:04d}.txt")
        self.fd = open(path, "w", buffering=4 * 1024 * 1024)
        self.line_count = 0

    def write_hash(self, hash_str):
        self.fd.write(hash_str)
        self.fd.write("\n")
        self.line_count += 1
        if self.line_count >= BATCH_SIZE:
            self._rotate()

    def close(self):
        if self.fd:
            self.fd.close()
            self.fd = None


# ─── Main ────────────────────────────────────────────────────────────────────

def extract_all(resume=True):
    os.makedirs(ROCKS_DIR, exist_ok=True)

    if not resume:
        clean_rocks_dir()

    prog = load_progress() if resume else {
        "lastCompletedHibpBatch": -1,
        "totalHashesExtracted": 0,
        "batchesWritten": 0,
    }

    start_from = prog["lastCompletedHibpBatch"] + 1
    remaining = 256 - start_from

    print()
    print("RocksExtractor")
    print("==============")
    print(f"HIBP source:  {HIBP_DIR}")
    print(f"ROCKS output: {ROCKS_DIR}")
    print(f"Batch size:   {BATCH_SIZE:,}")
    print(f"Resume from:  HIBP batch 0x{start_from:02X} ({remaining} remaining)")
    print(f"Extracted:    {prog['totalHashesExtracted']:,} hashes so far")
    print(f"Batches:      {prog['batchesWritten']} written so far")
    print()

    if remaining == 0:
        print("All HIBP batches already extracted!")
        return

    t0 = time.time()
    total = prog["totalHashesExtracted"]
    writer = RocksWriter(start_batch=prog["batchesWritten"])

    for hibp_idx in range(start_from, 256):
        hibp_id = f"{hibp_idx:02X}"
        gz_path = os.path.join(HIBP_DIR, f"hibp-{hibp_id}.json.gz")

        if not os.path.exists(gz_path):
            print(f"  SKIP {hibp_id} (file not found)")
            continue

        try:
            batch_count = process_hibp_file(gz_path, writer.write_hash)
        except Exception as e:
            print(f"  ERROR {hibp_id}: {e}")
            continue

        total += batch_count
        gc.collect()

        elapsed = time.time() - t0
        done = hibp_idx - start_from + 1
        rate = done / elapsed if elapsed > 0 else 0
        eta = (255 - hibp_idx) / rate if rate > 0 else 0

        print(
            f"  {hibp_id}: {batch_count:>10,} hashes | "
            f"Total: {total:>14,} | "
            f"Batches: {writer.batch_num:>5} | "
            f"{done}/{remaining} ({done / remaining * 100:.1f}%) | "
            f"ETA: {fmt_duration(eta)}"
        )

        prog["lastCompletedHibpBatch"] = hibp_idx
        prog["totalHashesExtracted"] = total
        prog["batchesWritten"] = writer.batch_num
        save_progress(prog)

    writer.close()
    elapsed = time.time() - t0

    print()
    print("Complete!")
    print(f"  Hashes:  {total:,}")
    print(f"  Batches: {writer.batch_num}")
    print(f"  Time:    {fmt_duration(elapsed)}")


# ─── Status ──────────────────────────────────────────────────────────────────

def show_status():
    prog = load_progress()
    files = 0
    if os.path.isdir(ROCKS_DIR):
        files = len([f for f in os.listdir(ROCKS_DIR) if f.startswith("batch-")])

    pct = (prog["lastCompletedHibpBatch"] + 1) / 256 * 100

    print()
    print("RocksExtractor Status")
    print("=====================")
    print(f"HIBP completed: {prog['lastCompletedHibpBatch'] + 1}/256 ({pct:.1f}%)")
    print(f"Hashes:         {prog['totalHashesExtracted']:,}")
    print(f"Batches:        {prog['batchesWritten']}")
    print(f"Files on disk:  {files}")


# ─── CLI ─────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    args = sys.argv[1:]

    if "--help" in args or "-h" in args:
        print(__doc__)
        sys.exit(0)

    if "--status" in args:
        show_status()
        sys.exit(0)

    resume = "--no-resume" not in args
    extract_all(resume=resume)
