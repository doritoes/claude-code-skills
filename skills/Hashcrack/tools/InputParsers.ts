#!/usr/bin/env bun
/**
 * InputParsers.ts - Credential Format Parsers
 *
 * Parses various credential dump formats into standardized hash entries
 * for submission to Hashtopolis.
 *
 * Supported formats:
 * - Linux shadow files (/etc/shadow)
 * - Windows SAM dumps (pwdump format)
 * - Domain Controller dumps (secretsdump NTDS.dit format)
 * - Hashcat potfile format
 * - Plain hash lists
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

import { readFileSync, existsSync } from "fs";
import { HASH_TYPES } from "./HashtopolisClient";

// =============================================================================
// Types and Interfaces
// =============================================================================

export interface ParsedHash {
  hash: string;
  username?: string;
  domain?: string;
  rid?: number;
  hashType: number;
  source: string;
  metadata?: Record<string, unknown>;
}

export interface ParseResult {
  format: InputFormat;
  hashes: ParsedHash[];
  hashType: number;
  warnings: string[];
  stats: {
    total: number;
    valid: number;
    skipped: number;
    disabled: number;
  };
  // Cracker routing
  routing: {
    hashcat: ParsedHash[];
    john: ParsedHash[];
    unsupported: ParsedHash[];
  };
}

export type InputFormat =
  | "shadow"
  | "sam"
  | "ntds"
  | "pwdump"
  | "secretsdump"
  | "hashcat_potfile"
  | "plain"
  | "unknown";

// =============================================================================
// Format Detection
// =============================================================================

/**
 * Detect the format of a credential dump file
 */
export function detectInputFormat(content: string): InputFormat {
  const lines = content.split("\n").filter((l) => l.trim() && !l.startsWith("#"));

  if (lines.length === 0) return "unknown";

  // Sample first few non-empty lines
  const samples = lines.slice(0, Math.min(10, lines.length));

  // Check for shadow file format: username:$type$...:lastchange:...
  // Format: name:password:lastchanged:minimum:maximum:warn:inactive:expire:reserved
  if (samples.some((l) => isShadowLine(l))) {
    return "shadow";
  }

  // Check for secretsdump/NTDS.dit format: domain\user:rid:lmhash:nthash:::
  // Also: domain.local\user:rid:lmhash:nthash:::
  if (samples.some((l) => isSecretsdumpLine(l))) {
    return "secretsdump";
  }

  // Check for pwdump format: username:rid:lmhash:nthash:::
  // SAM format is similar but without domain prefix
  if (samples.some((l) => isPwdumpLine(l))) {
    return "pwdump";
  }

  // Check for potfile format: hash:plaintext
  if (samples.some((l) => isPotfileLine(l))) {
    return "hashcat_potfile";
  }

  // Default to plain hash list
  return "plain";
}

function isShadowLine(line: string): boolean {
  const parts = line.split(":");
  // Shadow format has 9 fields, or at least username:hash:...
  if (parts.length < 2) return false;

  const hash = parts[1];
  // Check for crypt format ($type$salt$hash) or special values
  return (
    hash.startsWith("$") ||
    hash === "!" ||
    hash === "*" ||
    hash === "!!" ||
    hash === "x"
  );
}

function isSecretsdumpLine(line: string): boolean {
  // Format: DOMAIN\user:RID:LM:NTLM::: or domain.local\user:...
  const parts = line.split(":");
  if (parts.length < 4) return false;

  const userPart = parts[0];
  const hasBackslash = userPart.includes("\\");
  const rid = parts[1];

  return hasBackslash && /^\d+$/.test(rid);
}

function isPwdumpLine(line: string): boolean {
  // Format: username:RID:LM:NTLM:::
  const parts = line.split(":");
  if (parts.length < 4) return false;

  const rid = parts[1];
  const lm = parts[2];
  const ntlm = parts[3];

  // RID should be numeric, LM and NTLM should be 32-char hex or empty/disabled marker
  return (
    /^\d+$/.test(rid) &&
    (lm.length === 32 || lm === "aad3b435b51404eeaad3b435b51404ee" || lm === "NO PASSWORD*********************") &&
    (ntlm.length === 32 || ntlm === "31d6cfe0d16ae931b73c59d7e0c089c0")
  );
}

function isPotfileLine(line: string): boolean {
  // Format: hash:plaintext (no colons in hash part for most types)
  const colonIdx = line.indexOf(":");
  if (colonIdx === -1) return false;

  const hash = line.substring(0, colonIdx);
  // Basic hex hash or crypt hash
  return /^[a-f0-9]{32,128}$/i.test(hash) || hash.startsWith("$");
}

// =============================================================================
// Shadow File Parser
// =============================================================================

/**
 * Supported crackers
 */
export type CrackerType = "hashcat" | "john" | "unsupported";

/**
 * Linux shadow file hash type mapping
 */
export const SHADOW_HASH_TYPES: Record<string, {
  hashcatMode: number;
  johnFormat: string;
  name: string;
  cracker: CrackerType;
}> = {
  "1": { hashcatMode: 500, johnFormat: "md5crypt", name: "md5crypt", cracker: "hashcat" },
  "2a": { hashcatMode: 3200, johnFormat: "bcrypt", name: "bcrypt", cracker: "hashcat" },
  "2b": { hashcatMode: 3200, johnFormat: "bcrypt", name: "bcrypt", cracker: "hashcat" },
  "2y": { hashcatMode: 3200, johnFormat: "bcrypt", name: "bcrypt", cracker: "hashcat" },
  "5": { hashcatMode: 7400, johnFormat: "sha256crypt", name: "sha256crypt", cracker: "hashcat" },
  "6": { hashcatMode: 1800, johnFormat: "sha512crypt", name: "sha512crypt", cracker: "hashcat" },
  "y": { hashcatMode: -1, johnFormat: "crypt", name: "yescrypt", cracker: "john" },
  "gy": { hashcatMode: -1, johnFormat: "crypt", name: "gost-yescrypt", cracker: "john" },
  "7": { hashcatMode: -1, johnFormat: "scrypt", name: "scrypt", cracker: "john" },
};

export function parseShadowFile(content: string): ParseResult {
  const lines = content.split("\n");
  const hashes: ParsedHash[] = [];
  const warnings: string[] = [];
  let skipped = 0;
  let disabled = 0;

  // Routing for different crackers
  const routing: ParseResult["routing"] = {
    hashcat: [],
    john: [],
    unsupported: [],
  };

  // Detect primary hash type from first valid hashcat-compatible hash
  let primaryHashType: number | null = null;

  for (const line of lines) {
    if (!line.trim() || line.startsWith("#")) continue;

    const parts = line.split(":");
    if (parts.length < 2) {
      skipped++;
      continue;
    }

    const username = parts[0];
    const hashField = parts[1];

    // Skip disabled/locked accounts
    if (
      hashField === "!" ||
      hashField === "*" ||
      hashField === "!!" ||
      hashField === "x" ||
      hashField === ""
    ) {
      disabled++;
      continue;
    }

    // Skip NP (no password) entries and locked accounts starting with !
    if (hashField === "NP" || (hashField.startsWith("!") && !hashField.startsWith("$"))) {
      disabled++;
      continue;
    }

    // Parse crypt format: $type$salt$hash or $type$rounds=N$salt$hash
    const cryptMatch = hashField.match(/^\$([a-z0-9]+)\$/i);
    if (!cryptMatch) {
      warnings.push(`Unknown hash format for user ${username}: ${hashField.substring(0, 20)}...`);
      skipped++;
      continue;
    }

    const hashTypeId = cryptMatch[1];
    const typeInfo = SHADOW_HASH_TYPES[hashTypeId];

    if (!typeInfo) {
      warnings.push(`Unknown hash type $${hashTypeId}$ for user ${username}`);
      skipped++;
      continue;
    }

    // Create parsed hash entry
    const parsedHash: ParsedHash = {
      hash: hashField,
      username,
      hashType: typeInfo.hashcatMode,
      source: "shadow",
      metadata: {
        hashTypeName: typeInfo.name,
        hashTypeId,
        cracker: typeInfo.cracker,
        johnFormat: typeInfo.johnFormat,
      },
    };

    // Route to appropriate cracker
    if (typeInfo.cracker === "hashcat") {
      hashes.push(parsedHash);
      routing.hashcat.push(parsedHash);

      // Set primary hash type from first valid hashcat hash
      if (primaryHashType === null) {
        primaryHashType = typeInfo.hashcatMode;
      } else if (primaryHashType !== typeInfo.hashcatMode) {
        warnings.push(
          `Mixed hash types detected: user ${username} has ${typeInfo.name} but primary is mode ${primaryHashType}`
        );
      }
    } else if (typeInfo.cracker === "john") {
      hashes.push(parsedHash);
      routing.john.push(parsedHash);
      warnings.push(
        `${typeInfo.name} ($${hashTypeId}$) for user ${username} - will route to John the Ripper`
      );
    } else {
      routing.unsupported.push(parsedHash);
      warnings.push(
        `Unsupported hash type ${typeInfo.name} ($${hashTypeId}$) for user ${username}`
      );
      skipped++;
    }
  }

  return {
    format: "shadow",
    hashes,
    hashType: primaryHashType || HASH_TYPES.sha512crypt,
    warnings,
    stats: {
      total: lines.filter((l) => l.trim() && !l.startsWith("#")).length,
      valid: hashes.length,
      skipped,
      disabled,
    },
    routing,
  };
}

// =============================================================================
// Windows SAM/NTDS Parsers
// =============================================================================

/**
 * Empty/disabled NTLM markers
 */
const EMPTY_LM = "aad3b435b51404eeaad3b435b51404ee";
const EMPTY_NTLM = "31d6cfe0d16ae931b73c59d7e0c089c0";
const NO_PASSWORD = "NO PASSWORD*********************";

export function parsePwdump(content: string): ParseResult {
  const lines = content.split("\n");
  const hashes: ParsedHash[] = [];
  const warnings: string[] = [];
  let skipped = 0;
  let disabled = 0;

  for (const line of lines) {
    if (!line.trim() || line.startsWith("#")) continue;

    // Format: username:RID:LM:NTLM:::
    const parts = line.split(":");
    if (parts.length < 4) {
      skipped++;
      continue;
    }

    const username = parts[0];
    const rid = parseInt(parts[1]);
    const lmHash = parts[2];
    const ntlmHash = parts[3];

    // Skip empty/disabled NTLM accounts
    if (ntlmHash === EMPTY_NTLM || ntlmHash.length !== 32) {
      disabled++;
      continue;
    }

    // Skip if NTLM is not valid hex
    if (!/^[a-f0-9]{32}$/i.test(ntlmHash)) {
      skipped++;
      continue;
    }

    hashes.push({
      hash: ntlmHash.toLowerCase(),
      username,
      rid,
      hashType: HASH_TYPES.ntlm,
      source: "pwdump",
      metadata: {
        lmHash: lmHash !== EMPTY_LM && lmHash !== NO_PASSWORD ? lmHash : null,
        hasLM: lmHash !== EMPTY_LM && lmHash !== NO_PASSWORD && lmHash.length === 32,
      },
    });
  }

  // All NTLM hashes go to hashcat
  return {
    format: "pwdump",
    hashes,
    hashType: HASH_TYPES.ntlm,
    warnings,
    stats: {
      total: lines.filter((l) => l.trim() && !l.startsWith("#")).length,
      valid: hashes.length,
      skipped,
      disabled,
    },
    routing: {
      hashcat: hashes,
      john: [],
      unsupported: [],
    },
  };
}

export function parseSecretsdump(content: string): ParseResult {
  const lines = content.split("\n");
  const hashes: ParsedHash[] = [];
  const warnings: string[] = [];
  let skipped = 0;
  let disabled = 0;

  for (const line of lines) {
    if (!line.trim() || line.startsWith("#")) continue;

    // Format: DOMAIN\user:RID:LM:NTLM::: or domain.local\user:RID:LM:NTLM:::
    const parts = line.split(":");
    if (parts.length < 4) {
      skipped++;
      continue;
    }

    const userPart = parts[0];
    const rid = parseInt(parts[1]);
    const lmHash = parts[2];
    const ntlmHash = parts[3];

    // Parse domain\user
    let domain = "";
    let username = userPart;
    const backslashIdx = userPart.indexOf("\\");
    if (backslashIdx !== -1) {
      domain = userPart.substring(0, backslashIdx);
      username = userPart.substring(backslashIdx + 1);
    }

    // Skip empty/disabled NTLM accounts
    if (ntlmHash === EMPTY_NTLM || ntlmHash.length !== 32) {
      disabled++;
      continue;
    }

    // Skip if NTLM is not valid hex
    if (!/^[a-f0-9]{32}$/i.test(ntlmHash)) {
      skipped++;
      continue;
    }

    // Skip machine accounts (end with $) unless they have interesting hashes
    if (username.endsWith("$")) {
      // Still include them but mark as machine account
    }

    hashes.push({
      hash: ntlmHash.toLowerCase(),
      username,
      domain,
      rid,
      hashType: HASH_TYPES.ntlm,
      source: "secretsdump",
      metadata: {
        lmHash: lmHash !== EMPTY_LM && lmHash !== NO_PASSWORD ? lmHash : null,
        hasLM: lmHash !== EMPTY_LM && lmHash !== NO_PASSWORD && lmHash.length === 32,
        isMachineAccount: username.endsWith("$"),
        fullIdentity: userPart,
      },
    });
  }

  // All NTLM hashes go to hashcat
  return {
    format: "secretsdump",
    hashes,
    hashType: HASH_TYPES.ntlm,
    warnings,
    stats: {
      total: lines.filter((l) => l.trim() && !l.startsWith("#")).length,
      valid: hashes.length,
      skipped,
      disabled,
    },
    routing: {
      hashcat: hashes,
      john: [],
      unsupported: [],
    },
  };
}

// =============================================================================
// Plain Hash Parser
// =============================================================================

export function parsePlainHashes(content: string, hashType?: number): ParseResult {
  const lines = content.split("\n");
  const hashes: ParsedHash[] = [];
  const warnings: string[] = [];
  let skipped = 0;

  // Auto-detect hash type from first valid hash if not specified
  let detectedType: number | null = hashType || null;

  for (const line of lines) {
    const hash = line.trim();
    if (!hash || hash.startsWith("#")) continue;

    // Detect type from first hash if needed
    if (detectedType === null) {
      detectedType = detectHashTypeEnhanced(hash);
      if (detectedType === null) {
        warnings.push(`Cannot auto-detect hash type. First hash: ${hash.substring(0, 32)}...`);
        skipped++;
        continue;
      }
    }

    hashes.push({
      hash,
      hashType: detectedType,
      source: "plain",
    });
  }

  // Plain hashes typically go to hashcat
  return {
    format: "plain",
    hashes,
    hashType: detectedType || 0,
    warnings,
    stats: {
      total: lines.filter((l) => l.trim() && !l.startsWith("#")).length,
      valid: hashes.length,
      skipped,
      disabled: 0,
    },
    routing: {
      hashcat: hashes,
      john: [],
      unsupported: [],
    },
  };
}

// =============================================================================
// Enhanced Hash Type Detection
// =============================================================================

/**
 * Enhanced hash type detection with more patterns
 */
export function detectHashTypeEnhanced(hash: string): number | null {
  const trimmed = hash.trim();

  // Crypt formats (prefix-based detection)
  if (trimmed.startsWith("$1$")) return HASH_TYPES.md5crypt;
  if (trimmed.startsWith("$2a$") || trimmed.startsWith("$2b$") || trimmed.startsWith("$2y$"))
    return HASH_TYPES.bcrypt;
  if (trimmed.startsWith("$5$")) return HASH_TYPES.sha256crypt;
  if (trimmed.startsWith("$6$")) return HASH_TYPES.sha512crypt;

  // Yescrypt - warn and return null (unsupported)
  if (trimmed.startsWith("$y$") || trimmed.startsWith("$gy$")) {
    return null; // Unsupported by hashcat
  }

  // Kerberos formats
  if (trimmed.startsWith("$krb5asrep$")) return HASH_TYPES["kerberos-asrep"];
  if (trimmed.startsWith("$krb5tgs$")) return HASH_TYPES["kerberos-tgs"];

  // NetNTLMv2 format: user::domain:challenge:response:blob
  if (/^[^:]+::[^:]+:[a-f0-9]{16}:[a-f0-9]{32}:[a-f0-9]+$/i.test(trimmed)) {
    return HASH_TYPES.netntlmv2;
  }

  // NetNTLMv1 format: similar but different response length
  if (/^[^:]+::[^:]+:[a-f0-9]{16}:[a-f0-9]{48}$/i.test(trimmed)) {
    return HASH_TYPES.netntlmv1;
  }

  // Length-based detection for hex hashes
  if (/^[a-f0-9]+$/i.test(trimmed)) {
    switch (trimmed.length) {
      case 32:
        // Could be MD5 or NTLM - prefer NTLM for password auditing context
        return HASH_TYPES.ntlm;
      case 40:
        return HASH_TYPES.sha1;
      case 64:
        return HASH_TYPES.sha256;
      case 128:
        return HASH_TYPES.sha512;
    }
  }

  // LM hash (uppercase, often all same due to empty)
  if (/^[A-F0-9]{32}$/i.test(trimmed)) {
    // LM hashes are typically uppercase in dumps
    if (trimmed === trimmed.toUpperCase()) {
      return HASH_TYPES.lm;
    }
  }

  return null;
}

// =============================================================================
// Main Parser Entry Point
// =============================================================================

/**
 * Parse any supported credential format
 */
export function parseCredentialFile(
  filePath: string,
  forceHashType?: number
): ParseResult {
  if (!existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const content = readFileSync(filePath, "utf-8");
  return parseCredentialContent(content, forceHashType);
}

/**
 * Parse credential content string
 */
export function parseCredentialContent(
  content: string,
  forceHashType?: number
): ParseResult {
  const format = detectInputFormat(content);

  switch (format) {
    case "shadow":
      return parseShadowFile(content);
    case "secretsdump":
      return parseSecretsdump(content);
    case "pwdump":
      return parsePwdump(content);
    case "plain":
    default:
      return parsePlainHashes(content, forceHashType);
  }
}

/**
 * Extract just the hashes from parsed result (for Hashtopolis submission)
 */
export function extractHashes(result: ParseResult): string[] {
  return result.hashes.map((h) => h.hash);
}

/**
 * Get unique hashes (deduplicated)
 */
export function getUniqueHashes(result: ParseResult): string[] {
  return [...new Set(result.hashes.map((h) => h.hash))];
}

/**
 * Generate a mapping file for later results correlation
 */
export function generateHashMapping(result: ParseResult): Map<string, ParsedHash[]> {
  const mapping = new Map<string, ParsedHash[]>();

  for (const hash of result.hashes) {
    const existing = mapping.get(hash.hash) || [];
    existing.push(hash);
    mapping.set(hash.hash, existing);
  }

  return mapping;
}

// =============================================================================
// CLI Usage (when run directly)
// =============================================================================

if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log(`
InputParsers - Credential Format Parser

Usage:
  bun InputParsers.ts <file> [options]

Options:
  --format     Force format detection (shadow, pwdump, secretsdump, plain)
  --type       Force hash type (hashcat mode number)
  --json       Output as JSON
  --hashes     Output only hashes (one per line)

Examples:
  bun InputParsers.ts /etc/shadow
  bun InputParsers.ts ntds.dit.ntds --hashes
  bun InputParsers.ts pwdump.txt --json

Supported Formats:
  shadow       Linux /etc/shadow files
  pwdump       SAM dump (username:RID:LM:NTLM:::)
  secretsdump  NTDS.dit dump (DOMAIN\\user:RID:LM:NTLM:::)
  plain        One hash per line
`);
    process.exit(0);
  }

  try {
    const filePath = args[0];
    const result = parseCredentialFile(filePath);

    const outputJson = args.includes("--json");
    const outputHashes = args.includes("--hashes");

    if (outputJson) {
      console.log(JSON.stringify(result, null, 2));
    } else if (outputHashes) {
      const unique = getUniqueHashes(result);
      for (const hash of unique) {
        console.log(hash);
      }
    } else {
      console.log(`
Format:     ${result.format}
Hash Type:  ${result.hashType}
Total:      ${result.stats.total}
Valid:      ${result.stats.valid}
Skipped:    ${result.stats.skipped}
Disabled:   ${result.stats.disabled}

${result.warnings.length > 0 ? "Warnings:\n" + result.warnings.map((w) => "  - " + w).join("\n") : ""}
`);
    }
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exit(1);
  }
}
