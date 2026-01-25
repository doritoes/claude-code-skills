#!/usr/bin/env bun
/**
 * JohnClient.ts - John the Ripper Integration
 *
 * Handles password cracking for hash types not supported by hashcat,
 * particularly yescrypt ($y$) which is the default in Ubuntu 24.04.
 *
 * Runs John the Ripper locally (not distributed like Hashtopolis).
 * For large-scale yescrypt cracking, consider dedicated hardware.
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

import { resolve } from "path";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  unlinkSync,
} from "fs";
import { execSync, spawn, ChildProcess } from "child_process";
import { ParsedHash } from "./InputParsers";

// =============================================================================
// Types and Interfaces
// =============================================================================

export interface JohnConfig {
  johnPath: string;
  wordlistPath?: string;
  rulesPath?: string;
  sessionName?: string;
  workDir: string;
}

export interface JohnResult {
  hash: string;
  username?: string;
  password: string;
  format?: string;
}

export interface JohnStatus {
  isRunning: boolean;
  progress?: string;
  cracked: number;
  total: number;
  speed?: string;
  eta?: string;
}

// =============================================================================
// Default Configuration
// =============================================================================

function getDefaultConfig(): JohnConfig {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const paiDir = process.env.PAI_DIR || resolve(home, "AI-Projects");
  const skillDir = resolve(paiDir, ".claude/skills/Hashcrack");

  return {
    johnPath: detectJohnPath(),
    workDir: resolve(skillDir, "data/john"),
  };
}

function detectJohnPath(): string {
  // Try common locations
  const paths = [
    "john", // In PATH
    "/usr/bin/john",
    "/usr/sbin/john",
    "/opt/john/run/john",
    "/usr/local/bin/john",
    "C:\\john\\run\\john.exe",
    "C:\\Program Files\\john\\run\\john.exe",
  ];

  for (const p of paths) {
    try {
      execSync(`"${p}" --help`, { stdio: "pipe", timeout: 5000 });
      return p;
    } catch {
      // Try next
    }
  }

  return "john"; // Default, may fail later
}

// =============================================================================
// John the Ripper Client
// =============================================================================

export class JohnClient {
  private config: JohnConfig;
  private process: ChildProcess | null = null;

  constructor(config?: Partial<JohnConfig>) {
    this.config = { ...getDefaultConfig(), ...config };

    // Ensure work directory exists
    if (!existsSync(this.config.workDir)) {
      mkdirSync(this.config.workDir, { recursive: true });
    }
  }

  /**
   * Check if John the Ripper is available
   */
  async isAvailable(): Promise<boolean> {
    try {
      execSync(`"${this.config.johnPath}" --help`, { stdio: "pipe", timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get John version info
   */
  getVersion(): string | null {
    try {
      const output = execSync(`"${this.config.johnPath}" --help`, {
        encoding: "utf-8",
        timeout: 5000,
      });
      const match = output.match(/John the Ripper (\S+)/);
      return match ? match[1] : "unknown";
    } catch {
      return null;
    }
  }

  /**
   * Prepare hash file for John
   * John expects format: username:hash or just hash
   */
  prepareHashFile(hashes: ParsedHash[], filename: string): string {
    const filePath = resolve(this.config.workDir, filename);
    const lines: string[] = [];

    for (const h of hashes) {
      if (h.username) {
        lines.push(`${h.username}:${h.hash}`);
      } else {
        lines.push(h.hash);
      }
    }

    writeFileSync(filePath, lines.join("\n") + "\n");
    return filePath;
  }

  /**
   * Run John with wordlist attack
   */
  async crackWithWordlist(
    hashFile: string,
    options: {
      wordlist?: string;
      rules?: string;
      format?: string;
      fork?: number;
    } = {}
  ): Promise<void> {
    const args: string[] = [hashFile];

    if (options.wordlist) {
      args.push(`--wordlist=${options.wordlist}`);
    }

    if (options.rules) {
      args.push(`--rules=${options.rules}`);
    }

    if (options.format) {
      args.push(`--format=${options.format}`);
    }

    if (options.fork && options.fork > 1) {
      args.push(`--fork=${options.fork}`);
    }

    // Session name for resuming
    const session = this.config.sessionName || `hashcrack_${Date.now()}`;
    args.push(`--session=${session}`);
    args.push(`--pot=${resolve(this.config.workDir, "john.pot")}`);

    console.log(`Running: john ${args.join(" ")}`);

    return new Promise((resolve, reject) => {
      this.process = spawn(this.config.johnPath, args, {
        cwd: this.config.workDir,
        stdio: ["inherit", "pipe", "pipe"],
      });

      let output = "";

      this.process.stdout?.on("data", (data) => {
        output += data.toString();
        process.stdout.write(data);
      });

      this.process.stderr?.on("data", (data) => {
        process.stderr.write(data);
      });

      this.process.on("close", (code) => {
        this.process = null;
        if (code === 0 || code === 1) {
          // John returns 1 when no passwords cracked, 0 when some cracked
          resolve();
        } else {
          reject(new Error(`John exited with code ${code}`));
        }
      });

      this.process.on("error", (err) => {
        this.process = null;
        reject(err);
      });
    });
  }

  /**
   * Run incremental (brute force) attack
   */
  async crackIncremental(
    hashFile: string,
    options: {
      format?: string;
      mode?: string; // Digits, Alpha, Alnum, etc.
      fork?: number;
    } = {}
  ): Promise<void> {
    const args: string[] = [hashFile];

    args.push(`--incremental${options.mode ? `=${options.mode}` : ""}`);

    if (options.format) {
      args.push(`--format=${options.format}`);
    }

    if (options.fork && options.fork > 1) {
      args.push(`--fork=${options.fork}`);
    }

    const session = this.config.sessionName || `hashcrack_${Date.now()}`;
    args.push(`--session=${session}`);
    args.push(`--pot=${resolve(this.config.workDir, "john.pot")}`);

    console.log(`Running: john ${args.join(" ")}`);

    return new Promise((resolve, reject) => {
      this.process = spawn(this.config.johnPath, args, {
        cwd: this.config.workDir,
        stdio: "inherit",
      });

      this.process.on("close", (code) => {
        this.process = null;
        if (code === 0 || code === 1) {
          resolve();
        } else {
          reject(new Error(`John exited with code ${code}`));
        }
      });

      this.process.on("error", (err) => {
        this.process = null;
        reject(err);
      });
    });
  }

  /**
   * Show cracked passwords
   */
  async showCracked(hashFile: string, format?: string): Promise<JohnResult[]> {
    const args: string[] = ["--show", hashFile];

    if (format) {
      args.push(`--format=${format}`);
    }

    args.push(`--pot=${resolve(this.config.workDir, "john.pot")}`);

    try {
      const output = execSync(`"${this.config.johnPath}" ${args.join(" ")}`, {
        encoding: "utf-8",
        cwd: this.config.workDir,
        timeout: 30000,
      });

      const results: JohnResult[] = [];

      // Parse output: username:password or hash:password
      for (const line of output.split("\n")) {
        if (!line.trim() || line.includes(" password hash")) continue;

        const colonIdx = line.indexOf(":");
        if (colonIdx === -1) continue;

        const first = line.substring(0, colonIdx);
        const rest = line.substring(colonIdx + 1);

        // For shadow files, format is username:password
        // For plain hashes, format is hash:password
        results.push({
          hash: first,
          password: rest.split(":")[0], // Handle additional fields
          username: first.includes("$") ? undefined : first,
        });
      }

      return results;
    } catch {
      return [];
    }
  }

  /**
   * Get status of running session
   */
  getStatus(sessionName?: string): JohnStatus {
    const session = sessionName || this.config.sessionName;

    try {
      const output = execSync(
        `"${this.config.johnPath}" --status${session ? `=${session}` : ""}`,
        {
          encoding: "utf-8",
          cwd: this.config.workDir,
          timeout: 10000,
        }
      );

      // Parse status output
      const isRunning = !output.includes("No session");
      const crackedMatch = output.match(/(\d+)g/);
      const speedMatch = output.match(/(\d+(?:\.\d+)?[KMG]?)p\/s/);

      return {
        isRunning,
        cracked: crackedMatch ? parseInt(crackedMatch[1]) : 0,
        total: 0, // John doesn't always report this
        speed: speedMatch ? speedMatch[1] + " p/s" : undefined,
      };
    } catch {
      return {
        isRunning: false,
        cracked: 0,
        total: 0,
      };
    }
  }

  /**
   * Stop running session
   */
  stop(): void {
    if (this.process) {
      this.process.kill("SIGINT");
      this.process = null;
    }
  }

  /**
   * Clean up session files
   */
  cleanup(sessionName?: string): void {
    const session = sessionName || this.config.sessionName;
    if (session) {
      const files = [
        `${session}.rec`,
        `${session}.log`,
      ];
      for (const f of files) {
        const path = resolve(this.config.workDir, f);
        if (existsSync(path)) {
          try {
            unlinkSync(path);
          } catch {
            // Ignore cleanup errors
          }
        }
      }
    }
  }

  /**
   * Run a complete cracking job with multiple attacks
   */
  async crack(
    hashes: ParsedHash[],
    options: {
      wordlist?: string;
      rules?: string;
      incremental?: boolean;
      format?: string;
      fork?: number;
    } = {}
  ): Promise<JohnResult[]> {
    // Prepare hash file
    const hashFile = this.prepareHashFile(hashes, `job_${Date.now()}.txt`);

    // Determine format from hashes if not specified
    const format = options.format ||
      (hashes[0]?.metadata?.johnFormat as string) ||
      "crypt";

    console.log(`\nCracking ${hashes.length} hashes with John the Ripper (format: ${format})`);

    // Run wordlist attack first
    if (options.wordlist || !options.incremental) {
      const wordlist = options.wordlist || "/usr/share/wordlists/rockyou.txt";
      if (existsSync(wordlist)) {
        console.log(`\nPhase 1: Wordlist attack (${wordlist})`);
        await this.crackWithWordlist(hashFile, {
          wordlist,
          rules: options.rules,
          format,
          fork: options.fork,
        });
      }
    }

    // Run incremental if requested
    if (options.incremental) {
      console.log("\nPhase 2: Incremental attack");
      await this.crackIncremental(hashFile, {
        format,
        fork: options.fork,
      });
    }

    // Get results
    const results = await this.showCracked(hashFile, format);
    console.log(`\nCracked ${results.length} of ${hashes.length} passwords`);

    return results;
  }
}

// =============================================================================
// CLI Usage
// =============================================================================

if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log(`
JohnClient - John the Ripper Integration

Usage:
  bun JohnClient.ts <command> [options]

Commands:
  check           Check if John is available
  crack <file>    Crack hashes from file
  show <file>     Show cracked passwords
  status          Show session status

Options:
  --wordlist PATH    Wordlist to use
  --rules NAME       Rules to apply
  --format NAME      Hash format (crypt, sha512crypt, etc.)
  --fork N           Number of processes

Examples:
  bun JohnClient.ts check
  bun JohnClient.ts crack shadow.txt --format crypt
  bun JohnClient.ts show shadow.txt
`);
    process.exit(0);
  }

  const client = new JohnClient();
  const command = args[0];

  switch (command) {
    case "check": {
      const available = await client.isAvailable();
      if (available) {
        const version = client.getVersion();
        console.log(`John the Ripper is available (version: ${version})`);
      } else {
        console.log("John the Ripper is NOT available");
        console.log("\nInstall with:");
        console.log("  Ubuntu/Debian: sudo apt install john");
        console.log("  macOS: brew install john");
        console.log("  Windows: Download from https://www.openwall.com/john/");
        process.exit(1);
      }
      break;
    }

    case "crack": {
      if (!args[1]) {
        console.error("Usage: crack <hashfile>");
        process.exit(1);
      }

      const parseArg = (name: string): string | undefined => {
        const idx = args.indexOf(`--${name}`);
        return idx !== -1 && args[idx + 1] ? args[idx + 1] : undefined;
      };

      // Read hashes
      const content = readFileSync(args[1], "utf-8");
      const hashes: ParsedHash[] = content.split("\n")
        .filter((l) => l.trim())
        .map((line) => {
          const colonIdx = line.indexOf(":");
          if (colonIdx !== -1) {
            return {
              username: line.substring(0, colonIdx),
              hash: line.substring(colonIdx + 1).split(":")[0],
              hashType: 0,
              source: "file",
            };
          }
          return { hash: line.trim(), hashType: 0, source: "file" };
        });

      const results = await client.crack(hashes, {
        wordlist: parseArg("wordlist"),
        rules: parseArg("rules"),
        format: parseArg("format"),
        fork: parseArg("fork") ? parseInt(parseArg("fork")!) : undefined,
        incremental: args.includes("--incremental"),
      });

      console.log("\nResults:");
      for (const r of results) {
        console.log(`  ${r.username || r.hash}: ${r.password}`);
      }
      break;
    }

    case "show": {
      if (!args[1]) {
        console.error("Usage: show <hashfile>");
        process.exit(1);
      }
      const format = args.includes("--format")
        ? args[args.indexOf("--format") + 1]
        : undefined;
      const results = await client.showCracked(args[1], format);

      if (results.length === 0) {
        console.log("No passwords cracked yet");
      } else {
        for (const r of results) {
          console.log(`${r.username || r.hash}:${r.password}`);
        }
      }
      break;
    }

    case "status": {
      const status = client.getStatus();
      console.log(`Running: ${status.isRunning}`);
      console.log(`Cracked: ${status.cracked}`);
      if (status.speed) console.log(`Speed: ${status.speed}`);
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      process.exit(1);
  }
}
