#!/usr/bin/env python3
"""
John the Ripper Wrapper for Hashtopolis
========================================
Translates Hashtopolis Generic Cracker interface to JtR commands.

Usage:
    jtr_wrapper.py keyspace --wordlist <wordlist> [--rules <rules>]
    jtr_wrapper.py crack --attacked-hashlist <hashfile> --wordlist <wordlist>
                         [--rules <rules>] [--skip <n>] [--length <n>] [--format <fmt>]

Hashtopolis expects:
- keyspace: Print total number of candidates to stdout
- crack: Output cracked hashes in format: hash:plain (tab-separated)

Author: PAI Hashcrack Skill
"""

import argparse
import subprocess
import sys
import os
import tempfile
import shutil
from pathlib import Path


def find_john():
    """Find john binary - try john, john-jumbo, then common paths."""
    for cmd in ['john', 'john-jumbo']:
        if shutil.which(cmd):
            return cmd

    common_paths = [
        '/usr/sbin/john',
        '/usr/bin/john',
        '/opt/john/run/john',
        '/opt/john-jumbo/run/john',
    ]
    for path in common_paths:
        if os.path.exists(path) and os.access(path, os.X_OK):
            return path

    raise FileNotFoundError("John the Ripper not found. Install with: apt install john")


def get_keyspace(john_bin, wordlist, rules=None):
    """
    Calculate keyspace for wordlist + rules combination.
    Uses --stdout | wc -l approach since JtR has no --keyspace flag.
    """
    cmd = [john_bin, f'--wordlist={wordlist}', '--stdout']
    if rules:
        cmd.append(f'--rules={rules}')

    # Count lines without loading entire output into memory
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    count = 0
    for _ in proc.stdout:
        count += 1
    proc.wait()

    return count


def crack_hashes(john_bin, hashfile, wordlist, rules=None, skip=0, length=0,
                 hash_format='crypt', timeout=None):
    """
    Crack hashes using JtR with skip/length support via stdin piping.

    Since JtR doesn't support --skip/--length for wordlist mode,
    we generate candidates with --stdout, slice with tail/head, and pipe to --stdin.
    """
    # Create temporary pot file to avoid polluting default
    with tempfile.NamedTemporaryFile(mode='w', suffix='.pot', delete=False) as potfile:
        potfile_path = potfile.name

    try:
        # Build candidate generation command
        gen_cmd = [john_bin, f'--wordlist={wordlist}', '--stdout']
        if rules:
            gen_cmd.append(f'--rules={rules}')

        # Build crack command
        crack_cmd = [
            john_bin,
            '--stdin',
            f'--format={hash_format}',
            f'--pot={potfile_path}',
            hashfile
        ]

        if timeout:
            crack_cmd.insert(1, f'--max-run-time={timeout}')

        # If skip/length specified, pipe through tail/head
        if skip > 0 or length > 0:
            # Generate -> skip -> limit -> crack
            gen_proc = subprocess.Popen(gen_cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)

            # Build pipeline for skip/length
            if skip > 0 and length > 0:
                # tail -n +{skip+1} | head -n {length}
                tail_proc = subprocess.Popen(
                    ['tail', '-n', f'+{skip + 1}'],
                    stdin=gen_proc.stdout,
                    stdout=subprocess.PIPE
                )
                head_proc = subprocess.Popen(
                    ['head', '-n', str(length)],
                    stdin=tail_proc.stdout,
                    stdout=subprocess.PIPE
                )
                crack_proc = subprocess.Popen(
                    crack_cmd,
                    stdin=head_proc.stdout,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE
                )
                crack_proc.wait()
            elif skip > 0:
                tail_proc = subprocess.Popen(
                    ['tail', '-n', f'+{skip + 1}'],
                    stdin=gen_proc.stdout,
                    stdout=subprocess.PIPE
                )
                crack_proc = subprocess.Popen(
                    crack_cmd,
                    stdin=tail_proc.stdout,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE
                )
                crack_proc.wait()
            elif length > 0:
                head_proc = subprocess.Popen(
                    ['head', '-n', str(length)],
                    stdin=gen_proc.stdout,
                    stdout=subprocess.PIPE
                )
                crack_proc = subprocess.Popen(
                    crack_cmd,
                    stdin=head_proc.stdout,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE
                )
                crack_proc.wait()
        else:
            # No skip/length - direct pipe
            gen_proc = subprocess.Popen(gen_cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            crack_proc = subprocess.Popen(
                crack_cmd,
                stdin=gen_proc.stdout,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE
            )
            crack_proc.wait()

        # Read cracked passwords from pot file
        # JtR pot format: hash:plaintext
        cracked = []
        if os.path.exists(potfile_path):
            with open(potfile_path, 'r') as f:
                for line in f:
                    line = line.strip()
                    if ':' in line:
                        # Find the last colon - hash may contain colons
                        parts = line.rsplit(':', 1)
                        if len(parts) == 2:
                            hash_val, plain = parts
                            # Output in Hashtopolis format: hash\tplain
                            cracked.append(f"{hash_val}\t{plain}")

        return cracked

    finally:
        # Cleanup temp pot file
        if os.path.exists(potfile_path):
            os.unlink(potfile_path)


def main():
    parser = argparse.ArgumentParser(
        description='John the Ripper wrapper for Hashtopolis Generic Cracker interface'
    )
    parser.add_argument('action', choices=['keyspace', 'crack', 'benchmark'],
                        help='Action to perform')
    parser.add_argument('-w', '--wordlist', required=False,
                        help='Wordlist file for dictionary attack')
    parser.add_argument('-r', '--rules', default=None,
                        help='JtR rules section name (e.g., Jumbo, Single, best64)')
    parser.add_argument('-a', '--attacked-hashlist', dest='hashfile',
                        help='Hashlist file to crack')
    parser.add_argument('-s', '--skip', type=int, default=0,
                        help='Number of candidates to skip')
    parser.add_argument('-l', '--length', type=int, default=0,
                        help='Number of candidates to process')
    parser.add_argument('-f', '--format', default='crypt',
                        help='Hash format (default: crypt for yescrypt)')
    parser.add_argument('--timeout', type=int, default=None,
                        help='Maximum runtime in seconds')
    parser.add_argument('--version', action='version', version='jtr_wrapper 1.0.0')

    args = parser.parse_args()

    try:
        john_bin = find_john()
    except FileNotFoundError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)

    if args.action == 'keyspace':
        if not args.wordlist:
            print("ERROR: --wordlist required for keyspace calculation", file=sys.stderr)
            sys.exit(1)

        keyspace = get_keyspace(john_bin, args.wordlist, args.rules)
        print(keyspace)

    elif args.action == 'benchmark':
        # Simple benchmark - run JtR's built-in test
        result = subprocess.run([john_bin, '--test=5', f'--format={args.format}'],
                                capture_output=True, text=True)
        # Extract speed from output - look for "c/s" (candidates per second)
        for line in result.stdout.split('\n'):
            if 'c/s' in line or 'C/s' in line:
                print(line)
        print("1000")  # Return nominal speed for Hashtopolis

    elif args.action == 'crack':
        if not args.hashfile:
            print("ERROR: --attacked-hashlist required for cracking", file=sys.stderr)
            sys.exit(1)
        if not args.wordlist:
            print("ERROR: --wordlist required for cracking", file=sys.stderr)
            sys.exit(1)

        cracked = crack_hashes(
            john_bin,
            args.hashfile,
            args.wordlist,
            rules=args.rules,
            skip=args.skip,
            length=args.length,
            hash_format=args.format,
            timeout=args.timeout
        )

        # Output cracked passwords in Hashtopolis format
        for result in cracked:
            print(result)


if __name__ == '__main__':
    main()
