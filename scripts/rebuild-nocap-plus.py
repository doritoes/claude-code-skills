"""
Rebuild nocap-plus.txt from nocap.txt + all cohort wordlists.
Deduplicates and sorts. Uses data/ symlink path.
"""
import os
import sys

SKILL_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                         ".claude", "skills", "ExpandedPasswordList")
DATA_DIR = os.path.join(SKILL_DIR, "data")
COHORTS_DIR = os.path.join(DATA_DIR, "cohorts")
NOCAP_PATH = os.path.join(DATA_DIR, "nocap.txt")
OUTPUT_PATH = os.path.join(DATA_DIR, "nocap-plus.txt")

def main():
    if not os.path.exists(NOCAP_PATH):
        print(f"ERROR: nocap.txt not found at {NOCAP_PATH}")
        sys.exit(1)

    # Memory-safe approach: load cohort words (~53K) into a small set,
    # stream nocap.txt (~14M words) to output removing any cohort dupes as we go,
    # then append remaining cohort words. Never loads nocap.txt into memory.

    tmp_path = OUTPUT_PATH + ".new"

    # Step 1: Load all cohort words into a set (small — ~53K words, <5MB)
    cohort_words = set()
    if os.path.exists(COHORTS_DIR):
        for fname in sorted(os.listdir(COHORTS_DIR)):
            if not fname.endswith(".txt"):
                continue
            fpath = os.path.join(COHORTS_DIR, fname)
            with open(fpath, "r", encoding="utf-8", errors="replace") as f:
                for line in f:
                    w = line.strip().lower()
                    if w and not w.startswith("#"):
                        cohort_words.add(w)
        print(f"  Loaded {len(cohort_words):,} unique cohort words from {COHORTS_DIR}")
    else:
        print(f"WARNING: Cohorts directory not found at {COHORTS_DIR}")

    # Step 2: Stream nocap.txt to output; mark cohort words seen in nocap as dupes
    print(f"Streaming nocap.txt from: {NOCAP_PATH}")
    nocap_count = 0
    seen_in_nocap = set()
    with open(NOCAP_PATH, "r", encoding="utf-8", errors="replace") as fin, \
         open(tmp_path, "w", encoding="utf-8") as fout:
        for line in fin:
            w = line.strip()
            if w:
                fout.write(w + "\n")
                nocap_count += 1
                low = w.lower()
                if low in cohort_words:
                    seen_in_nocap.add(low)
    print(f"  Wrote {nocap_count:,} words from nocap.txt")
    print(f"  Cohort words already in nocap: {len(seen_in_nocap):,}")

    # Step 3: Append cohort words NOT already in nocap
    new_cohort = cohort_words - seen_in_nocap
    if new_cohort:
        with open(tmp_path, "a", encoding="utf-8") as fout:
            for w in sorted(new_cohort):
                fout.write(w + "\n")
    cohort_added = len(new_cohort)
    print(f"  Appended {cohort_added:,} new cohort words")

    total = nocap_count + cohort_added
    print(f"\nTotal: {total:,} words (nocap: {nocap_count:,} + cohorts: {cohort_added:,})")

    # Safe rename
    os.replace(tmp_path, OUTPUT_PATH)
    print(f"Done. {total:,} words written to nocap-plus.txt")

if __name__ == "__main__":
    main()
