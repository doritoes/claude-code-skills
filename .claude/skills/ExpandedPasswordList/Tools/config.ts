/**
 * config.ts - Shared configuration for ExpandedPasswordList tools
 *
 * Handles the data directory path resolution:
 * - If `data` is a directory/symlink, use that directly
 * - If `data` is a file containing a path, use that path
 * - Otherwise use local `data/` directory (fallback)
 *
 * @author PAI (Personal AI Infrastructure)
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CURRENT_FILE = fileURLToPath(import.meta.url);
const TOOLS_DIR = dirname(CURRENT_FILE);
const SKILL_DIR = dirname(TOOLS_DIR);

/**
 * Get the data directory path.
 *
 * Priority:
 * 1. EPL_DATA_PATH environment variable
 * 2. `data` directory or symlink (preferred - direct access)
 * 3. `data` file containing network path (legacy fallback)
 */
export function getDataDir(): string {
  // Check environment variable first
  if (process.env.EPL_DATA_PATH) {
    return process.env.EPL_DATA_PATH;
  }

  const dataPath = resolve(SKILL_DIR, "data");

  if (existsSync(dataPath)) {
    const stats = statSync(dataPath);

    // If it's a directory or symlink to directory, use directly
    if (stats.isDirectory()) {
      return dataPath;
    }

    // Legacy: if it's a file containing a path reference
    if (stats.isFile()) {
      const networkPath = readFileSync(dataPath, "utf-8").trim();
      if (networkPath && existsSync(networkPath)) {
        return networkPath;
      }
    }
  }

  // Fall back to local data directory path
  return dataPath;
}

// Derived paths
export const DATA_DIR = getDataDir();
export const ROCKS_DIR = resolve(DATA_DIR, "rocks");
export const GRAVEL_DIR = resolve(DATA_DIR, "gravel");
export const SAND_DIR = resolve(DATA_DIR, "sand");
export const PEARLS_DIR = resolve(DATA_DIR, "pearls");
export const DIAMONDS_DIR = resolve(DATA_DIR, "diamonds");
export const GLASS_DIR = resolve(DATA_DIR, "glass");
export const RESULTS_DIR = resolve(DATA_DIR, "results");
export const EXPORTS_DIR = resolve(DATA_DIR, "exports");
export const FEEDBACK_DIR = resolve(DATA_DIR, "feedback");
export const ARCHIVE_DIR = resolve(DATA_DIR, "archive");

// Hash type constants
export const HASH_TYPE_SHA1 = 100;

/**
 * Decode hashcat $HEX[...] encoded plaintext.
 * Hashcat encodes passwords containing : (0x3a) and other special chars
 * as $HEX[hex_bytes] in potfiles. These are real passwords from standard
 * input devices that need to be decoded back to their original form.
 */
export function decodeHexPlain(plain: string): string {
  const match = plain.match(/^\$HEX\[([0-9a-fA-F]+)\]$/);
  if (!match) return plain;
  const hex = match[1];
  const bytes: number[] = [];
  for (let i = 0; i < hex.length; i += 2) {
    bytes.push(parseInt(hex.slice(i, i + 2), 16));
  }
  return Buffer.from(bytes).toString("utf-8");
}

/**
 * Log the current data directory configuration
 */
export function logDataConfig(): void {
  console.log(`Data Directory: ${DATA_DIR}`);
  console.log(`  GRAVEL:     ${GRAVEL_DIR}`);
  console.log(`  SAND:       ${SAND_DIR}`);
  console.log(`  DIAMONDS:   ${DIAMONDS_DIR}`);
}
