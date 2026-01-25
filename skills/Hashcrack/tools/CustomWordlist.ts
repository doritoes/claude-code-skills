#!/usr/bin/env bun
/**
 * CustomWordlist.ts - Custom Password List Manager
 *
 * Builds and maintains a custom wordlist of cracked passwords that weren't
 * found using standard dictionary attacks. This provides significant time
 * savings when auditing local accounts that may reuse passwords.
 *
 * Features:
 * - Extracts novel passwords from cracking results
 * - Deduplicates and normalizes entries
 * - Syncs with Hashtopolis server
 * - Tracks password discovery metadata
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

import { resolve } from "path";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  appendFileSync,
  createReadStream,
} from "fs";
import { createInterface } from "readline";
import { HashtopolisClient, CrackedHash } from "./HashtopolisClient";

// =============================================================================
// Types and Interfaces
// =============================================================================

export interface CustomWordlistConfig {
  wordlistPath: string;
  metadataPath: string;
  rockyouPath?: string;
  maxSize?: number;
}

export interface PasswordEntry {
  password: string;
  firstSeen: string;
  source: string;
  hashType?: number;
  count: number;
}

export interface WordlistMetadata {
  created: string;
  lastUpdated: string;
  totalEntries: number;
  sources: string[];
  uploadedToServer: boolean;
  serverFileId?: number;
}

// =============================================================================
// Default Paths
// =============================================================================

function getDefaultConfig(): CustomWordlistConfig {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const paiDir = process.env.PAI_DIR || resolve(home, "AI-Projects");
  const skillDir = resolve(paiDir, ".claude/skills/Hashcrack");

  return {
    wordlistPath: resolve(skillDir, "data/custom_passwords.txt"),
    metadataPath: resolve(skillDir, "data/custom_passwords.meta.json"),
    rockyouPath: undefined, // Will be checked on Hashtopolis server
    maxSize: 100000, // Max entries to keep
  };
}

// =============================================================================
// Rockyou Lookup
// =============================================================================

/**
 * Check if a password exists in rockyou.txt
 * Uses streaming to avoid loading entire file into memory
 */
export async function isInRockyou(
  password: string,
  rockyouPath: string
): Promise<boolean> {
  if (!existsSync(rockyouPath)) {
    return false;
  }

  return new Promise((resolve) => {
    const stream = createReadStream(rockyouPath, { encoding: "utf-8" });
    const rl = createInterface({ input: stream });

    let found = false;

    rl.on("line", (line) => {
      if (line === password) {
        found = true;
        rl.close();
        stream.close();
      }
    });

    rl.on("close", () => resolve(found));
    rl.on("error", () => resolve(false));
  });
}

/**
 * Build a Set of rockyou passwords for faster lookups
 * Only use for smaller comparison sets
 */
export async function loadRockyouSet(
  rockyouPath: string,
  limit?: number
): Promise<Set<string>> {
  const passwords = new Set<string>();

  if (!existsSync(rockyouPath)) {
    return passwords;
  }

  const stream = createReadStream(rockyouPath, { encoding: "utf-8" });
  const rl = createInterface({ input: stream });

  let count = 0;

  for await (const line of rl) {
    passwords.add(line);
    count++;
    if (limit && count >= limit) break;
  }

  return passwords;
}

// =============================================================================
// Custom Wordlist Manager
// =============================================================================

export class CustomWordlistManager {
  private config: CustomWordlistConfig;
  private metadata: WordlistMetadata;
  private passwords: Map<string, PasswordEntry>;

  constructor(config?: Partial<CustomWordlistConfig>) {
    this.config = { ...getDefaultConfig(), ...config };
    this.passwords = new Map();
    this.metadata = this.loadMetadata();
    this.loadWordlist();
  }

  private loadMetadata(): WordlistMetadata {
    if (existsSync(this.config.metadataPath)) {
      try {
        return JSON.parse(readFileSync(this.config.metadataPath, "utf-8"));
      } catch {
        // Invalid metadata, create new
      }
    }

    return {
      created: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
      totalEntries: 0,
      sources: [],
      uploadedToServer: false,
    };
  }

  private loadWordlist(): void {
    if (existsSync(this.config.wordlistPath)) {
      const content = readFileSync(this.config.wordlistPath, "utf-8");
      for (const line of content.split("\n")) {
        const password = line.trim();
        if (password) {
          this.passwords.set(password, {
            password,
            firstSeen: this.metadata.created,
            source: "loaded",
            count: 1,
          });
        }
      }
    }
  }

  private saveMetadata(): void {
    // Ensure directory exists
    const dir = resolve(this.config.metadataPath, "..");
    if (!existsSync(dir)) {
      const { mkdirSync } = require("fs");
      mkdirSync(dir, { recursive: true });
    }

    this.metadata.lastUpdated = new Date().toISOString();
    this.metadata.totalEntries = this.passwords.size;
    writeFileSync(this.config.metadataPath, JSON.stringify(this.metadata, null, 2));
  }

  private saveWordlist(): void {
    // Ensure directory exists
    const dir = resolve(this.config.wordlistPath, "..");
    if (!existsSync(dir)) {
      const { mkdirSync } = require("fs");
      mkdirSync(dir, { recursive: true });
    }

    const passwords = Array.from(this.passwords.keys()).sort();
    writeFileSync(this.config.wordlistPath, passwords.join("\n") + "\n");
    this.saveMetadata();
  }

  /**
   * Add a password to the custom wordlist
   */
  addPassword(password: string, source: string, hashType?: number): boolean {
    if (!password || password.length === 0) return false;

    // Normalize: trim whitespace but preserve case
    const normalized = password.trim();
    if (normalized.length === 0) return false;

    const existing = this.passwords.get(normalized);
    if (existing) {
      existing.count++;
      return false; // Already exists
    }

    this.passwords.set(normalized, {
      password: normalized,
      firstSeen: new Date().toISOString(),
      source,
      hashType,
      count: 1,
    });

    // Track source
    if (!this.metadata.sources.includes(source)) {
      this.metadata.sources.push(source);
    }

    return true; // New password added
  }

  /**
   * Add multiple passwords from cracked results
   */
  async addFromCrackedResults(
    cracked: CrackedHash[],
    source: string,
    hashType?: number,
    skipRockyouCheck?: boolean
  ): Promise<{ added: number; skipped: number; inRockyou: number }> {
    let added = 0;
    let skipped = 0;
    let inRockyou = 0;

    // If we have rockyou path and not skipping, load common passwords
    let rockyouSet: Set<string> | null = null;
    if (!skipRockyouCheck && this.config.rockyouPath) {
      // Load first 1M passwords for quick check
      rockyouSet = await loadRockyouSet(this.config.rockyouPath, 1000000);
    }

    for (const result of cracked) {
      const password = result.plain;

      if (!password || password.length === 0) {
        skipped++;
        continue;
      }

      // Check if in rockyou (common password)
      if (rockyouSet && rockyouSet.has(password)) {
        inRockyou++;
        continue;
      }

      if (this.addPassword(password, source, hashType)) {
        added++;
      } else {
        skipped++;
      }
    }

    if (added > 0) {
      this.saveWordlist();
    }

    return { added, skipped, inRockyou };
  }

  /**
   * Add passwords from a potfile
   */
  async addFromPotfile(
    potfilePath: string,
    source?: string
  ): Promise<{ added: number; skipped: number }> {
    if (!existsSync(potfilePath)) {
      throw new Error(`Potfile not found: ${potfilePath}`);
    }

    let added = 0;
    let skipped = 0;

    const content = readFileSync(potfilePath, "utf-8");
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;

      // Potfile format: hash:plaintext
      const colonIdx = line.indexOf(":");
      if (colonIdx === -1) continue;

      const password = line.substring(colonIdx + 1);
      if (this.addPassword(password, source || potfilePath)) {
        added++;
      } else {
        skipped++;
      }
    }

    if (added > 0) {
      this.saveWordlist();
    }

    return { added, skipped };
  }

  /**
   * Get all passwords as array
   */
  getPasswords(): string[] {
    return Array.from(this.passwords.keys());
  }

  /**
   * Get wordlist statistics
   */
  getStats(): {
    total: number;
    sources: string[];
    created: string;
    lastUpdated: string;
  } {
    return {
      total: this.passwords.size,
      sources: this.metadata.sources,
      created: this.metadata.created,
      lastUpdated: this.metadata.lastUpdated,
    };
  }

  /**
   * Get wordlist file path
   */
  getWordlistPath(): string {
    return this.config.wordlistPath;
  }

  /**
   * Check if wordlist exists and has entries
   */
  hasEntries(): boolean {
    return this.passwords.size > 0;
  }

  /**
   * Get wordlist content for upload
   */
  getWordlistContent(): string {
    return this.getPasswords().join("\n");
  }

  /**
   * Upload wordlist to Hashtopolis server
   */
  async uploadToServer(client: HashtopolisClient): Promise<number | null> {
    if (this.passwords.size === 0) {
      return null;
    }

    try {
      const content = this.getWordlistContent();
      const fileId = await client.uploadWordlist("custom_passwords.txt", content);

      this.metadata.uploadedToServer = true;
      this.metadata.serverFileId = fileId;
      this.saveMetadata();

      return fileId;
    } catch (error) {
      console.error(`Failed to upload wordlist: ${(error as Error).message}`);
      return null;
    }
  }

  /**
   * Export wordlist to a file
   */
  exportTo(outputPath: string): void {
    const passwords = this.getPasswords();
    writeFileSync(outputPath, passwords.join("\n") + "\n");
  }

  /**
   * Clear all entries (use with caution)
   */
  clear(): void {
    this.passwords.clear();
    this.metadata = {
      created: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
      totalEntries: 0,
      sources: [],
      uploadedToServer: false,
    };
    this.saveWordlist();
  }

  /**
   * Prune old/low-count entries if over max size
   */
  prune(): number {
    if (!this.config.maxSize || this.passwords.size <= this.config.maxSize) {
      return 0;
    }

    // Sort by count (descending), keep top entries
    const sorted = Array.from(this.passwords.entries()).sort(
      (a, b) => b[1].count - a[1].count
    );

    const toRemove = sorted.slice(this.config.maxSize);
    for (const [password] of toRemove) {
      this.passwords.delete(password);
    }

    this.saveWordlist();
    return toRemove.length;
  }
}

// =============================================================================
// CLI Usage (when run directly)
// =============================================================================

if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log(`
CustomWordlist - Custom Password List Manager

Usage:
  bun CustomWordlist.ts <command> [options]

Commands:
  stats                 Show wordlist statistics
  list                  List all passwords
  add <password>        Add a single password
  import <potfile>      Import from hashcat potfile
  export <output>       Export to file
  clear                 Clear all entries (caution!)

Options:
  --source NAME         Source name for tracking

Examples:
  bun CustomWordlist.ts stats
  bun CustomWordlist.ts import hashcat.potfile --source "pentest-2024"
  bun CustomWordlist.ts export /tmp/custom_passwords.txt
`);
    process.exit(0);
  }

  const command = args[0];
  const manager = new CustomWordlistManager();

  switch (command) {
    case "stats": {
      const stats = manager.getStats();
      console.log(`
Custom Wordlist Statistics:
  Total Entries: ${stats.total}
  Created: ${stats.created}
  Last Updated: ${stats.lastUpdated}
  Sources: ${stats.sources.join(", ") || "none"}
  Path: ${manager.getWordlistPath()}
`);
      break;
    }

    case "list": {
      const passwords = manager.getPasswords();
      if (passwords.length === 0) {
        console.log("No passwords in wordlist");
      } else {
        console.log(`Passwords (${passwords.length}):`);
        for (const p of passwords.slice(0, 100)) {
          console.log(`  ${p}`);
        }
        if (passwords.length > 100) {
          console.log(`  ... and ${passwords.length - 100} more`);
        }
      }
      break;
    }

    case "add": {
      if (!args[1]) {
        console.error("Usage: add <password>");
        process.exit(1);
      }
      const source = args.includes("--source")
        ? args[args.indexOf("--source") + 1]
        : "manual";
      const added = manager.addPassword(args[1], source);
      console.log(added ? "Password added" : "Password already exists");
      break;
    }

    case "import": {
      if (!args[1]) {
        console.error("Usage: import <potfile>");
        process.exit(1);
      }
      const source = args.includes("--source")
        ? args[args.indexOf("--source") + 1]
        : args[1];

      manager.addFromPotfile(args[1], source).then((result) => {
        console.log(`Imported: ${result.added} new, ${result.skipped} existing`);
      });
      break;
    }

    case "export": {
      if (!args[1]) {
        console.error("Usage: export <output>");
        process.exit(1);
      }
      manager.exportTo(args[1]);
      console.log(`Exported to ${args[1]}`);
      break;
    }

    case "clear": {
      manager.clear();
      console.log("Wordlist cleared");
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      process.exit(1);
  }
}
