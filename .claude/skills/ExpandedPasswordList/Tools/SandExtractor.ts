#!/usr/bin/env bun
/**
 * SandExtractor.ts - Extract SAND (uncracked hashes) from Stage 1 hashlists
 *
 * After Stage 1 (rockyou+OneRule) completes, this tool extracts uncracked hashes
 * to create SAND batches for Stage 2 processing.
 *
 * SAND = hashes that SURVIVED Stage 1 attacks
 *
 * @author PAI (Personal AI Infrastructure)
 * @license MIT
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const CURRENT_FILE = fileURLToPath(import.meta.url);
const SKILL_DIR = dirname(dirname(CURRENT_FILE));
const DATA_DIR = resolve(SKILL_DIR, "data");
const SAND_DIR = resolve(DATA_DIR, "sand");
const HASHCRACK_DIR = resolve(SKILL_DIR, "..", "Hashcrack");

// =============================================================================
// Configuration
// =============================================================================

interface ServerConfig {
  serverIp: string;
  dbPassword: string;
  sshUser: string;
}

function getServerConfig(): ServerConfig {
  const terraformDir = resolve(HASHCRACK_DIR, "terraform", "aws");

  try {
    const serverIp = execSync(`terraform output -raw server_ip`, {
      encoding: "utf-8",
      cwd: terraformDir,
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();
    const dbPassword = execSync(`terraform output -raw db_password`, {
      encoding: "utf-8",
      cwd: terraformDir,
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();
    return { serverIp, dbPassword, sshUser: "ubuntu" };
  } catch {
    return {
      serverIp: "16.146.72.52",
      dbPassword: "NJyf6IviJRC1jYQ0u57tRuCm",
      sshUser: "ubuntu"
    };
  }
}

function execSQL(config: ServerConfig, sql: string, timeout = 300000): string {
  const cleanSql = sql.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
  const b64Sql = Buffer.from(cleanSql).toString('base64');
  const cmd = `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=30 ${config.sshUser}@${config.serverIp} "echo ${b64Sql} | base64 -d | sudo docker exec -i hashtopolis-db mysql -u hashtopolis -p'${config.dbPassword}' hashtopolis -sN"`;

  try {
    const shell = process.platform === "win32" ? "C:\Program Files\Git\bin\bash.exe" : "/bin/bash";
    return execSync(cmd, { encoding: "utf-8", maxBuffer: 500 * 1024 * 1024, timeout, shell }).trim();
  } catch (e: unknown) {
    const error = e as { stdout?: Buffer; message?: string };
    return error.stdout?.toString() || `ERROR: ${error.message || "Unknown error"}`;
  }
}

// =============================================================================
// Types
// =============================================================================

interface HashlistCandidate {
  hashlistId: number;
  hashlistName: string;
  hashCount: number;
  cracked: number;
  uncracked: number;
  crackedPercent: number;
}

// =============================================================================
// Core Functions
// =============================================================================

async function listCandidates(config: ServerConfig): Promise<HashlistCandidate[]> {
  console.log("Querying hashlists with uncracked hashes...\n");

  const result = execSQL(config, `
    SELECT hashlistId, hashlistName, hashCount, cracked, (hashCount - cracked) as uncracked,
           ROUND(cracked * 100.0 / hashCount, 2) as crackedPercent
    FROM Hashlist
    WHERE isArchived = 0 AND (hashCount - cracked) > 0
    ORDER BY uncracked DESC
    LIMIT 50
  `);

  if (!result || result.includes("ERROR")) {
    console.log("Error querying hashlists:", result);
    return [];
  }

  const candidates: HashlistCandidate[] = [];
  for (const line of result.split("\n").filter(l => l.trim())) {
    const parts = line.split("\t");
    if (parts.length >= 6) {
      candidates.push({
        hashlistId: parseInt(parts[0]),
        hashlistName: parts[1],
        hashCount: parseInt(parts[2]),
        cracked: parseInt(parts[3]),
        uncracked: parseInt(parts[4]),
        crackedPercent: parseFloat(parts[5]),
      });
    }
  }

  return candidates;
}

async function extractSand(
  config: ServerConfig,
  hashlistId: number,
  batchNumber: number,
  options: { dryRun: boolean; compress: boolean }
): Promise<{ extracted: number; outputPath: string } | null> {
  const paddedNum = String(batchNumber).padStart(4, "0");
  const batchName = `batch-${paddedNum}`;
  const outputPath = resolve(SAND_DIR, options.compress ? `${batchName}.txt.gz` : `${batchName}.txt`);

  console.log(`\nExtracting SAND from hashlist ${hashlistId} to ${batchName}...`);

  // Get count first
  const countResult = execSQL(config, `SELECT COUNT(*) FROM Hash WHERE hashlistId=${hashlistId} AND isCracked=0`);
  const count = parseInt(countResult) || 0;

  if (count === 0) {
    console.log("  No uncracked hashes found.");
    return null;
  }

  console.log(`  Found ${count.toLocaleString()} uncracked hashes`);

  if (options.dryRun) {
    console.log(`  [DRY RUN] Would extract to ${outputPath}`);
    return { extracted: count, outputPath };
  }

  // Ensure output directory exists
  if (!existsSync(SAND_DIR)) {
    mkdirSync(SAND_DIR, { recursive: true });
  }

  // Extract hashes in batches to handle large datasets
  const batchSize = 500000;
  let extracted = 0;
  let allHashes: string[] = [];

  console.log(`  Extracting in batches of ${batchSize.toLocaleString()}...`);

  while (extracted < count) {
    const result = execSQL(config, `
      SELECT hash FROM Hash
      WHERE hashlistId=${hashlistId} AND isCracked=0
      LIMIT ${batchSize} OFFSET ${extracted}
    `, 600000);

    if (!result || result.includes("ERROR")) {
      console.log(`  Error at offset ${extracted}:`, result);
      break;
    }

    const hashes = result.split("\n").filter(h => h.length === 40);
    allHashes = allHashes.concat(hashes);
    extracted += hashes.length;

    console.log(`  Progress: ${extracted.toLocaleString()} / ${count.toLocaleString()} (${Math.round(extracted * 100 / count)}%)`);

    if (hashes.length < batchSize) break;
  }

  // Write to file
  const content = allHashes.join("\n");
  if (options.compress) {
    const compressed = gzipSync(content);
    writeFileSync(outputPath, compressed);
    console.log(`  ✓ Wrote ${allHashes.length.toLocaleString()} hashes to ${outputPath} (${Math.round(compressed.length / 1024)}KB compressed)`);
  } else {
    writeFileSync(outputPath, content);
    console.log(`  ✓ Wrote ${allHashes.length.toLocaleString()} hashes to ${outputPath}`);
  }

  return { extracted: allHashes.length, outputPath };
}

async function extractFromMultiple(
  config: ServerConfig,
  hashlistIds: number[],
  startBatch: number,
  options: { dryRun: boolean; compress: boolean }
): Promise<void> {
  let batchNumber = startBatch;
  let totalExtracted = 0;

  for (const hashlistId of hashlistIds) {
    const result = await extractSand(config, hashlistId, batchNumber, options);
    if (result) {
      totalExtracted += result.extracted;
      batchNumber++;
    }
  }

  console.log(`\n${"─".repeat(60)}`);
  console.log(`Total SAND extracted: ${totalExtracted.toLocaleString()} hashes`);
  console.log(`Created batches: ${startBatch} to ${batchNumber - 1}`);
}

// =============================================================================
// CLI
// =============================================================================

async function main() {
  const args = process.argv.slice(2);
  const config = getServerConfig();

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
SandExtractor - Extract SAND (uncracked hashes) from Stage 1 hashlists

Usage:
  bun SandExtractor.ts --list                    List hashlists with uncracked hashes
  bun SandExtractor.ts --hashlist <id>           Extract SAND from specific hashlist
  bun SandExtractor.ts --top <n>                 Extract from top N hashlists by uncracked count
  bun SandExtractor.ts --all                     Extract from all hashlists
  bun SandExtractor.ts --dry-run                 Preview without extracting
  bun SandExtractor.ts --no-compress             Don't gzip output (default: compress)
  bun SandExtractor.ts --start-batch <n>         Start batch numbering at N (default: 1)

Examples:
  bun SandExtractor.ts --list                    # See what's available
  bun SandExtractor.ts --hashlist 123 --dry-run  # Preview extraction
  bun SandExtractor.ts --top 5                   # Extract from top 5 hashlists
  bun SandExtractor.ts --hashlist 123            # Extract single hashlist
`);
    process.exit(0);
  }

  console.log("╭─────────────────────────────────────────────────────────────╮");
  console.log("│              SAND EXTRACTOR                                 │");
  console.log("╰─────────────────────────────────────────────────────────────╯");
  console.log("");

  const dryRun = args.includes("--dry-run");
  const compress = !args.includes("--no-compress");
  const startBatchArg = args.find(a => a.startsWith("--start-batch="));
  const startBatch = startBatchArg ? parseInt(startBatchArg.split("=")[1]) : 1;

  if (args.includes("--list")) {
    const candidates = await listCandidates(config);
    console.log("Hashlists with uncracked hashes:\n");
    console.log("ID\tName\t\t\t\tTotal\t\tCracked\t\tUncracked\t%");
    console.log("─".repeat(100));
    for (const c of candidates) {
      const name = c.hashlistName.padEnd(24).slice(0, 24);
      console.log(`${c.hashlistId}\t${name}\t${c.hashCount.toLocaleString().padStart(10)}\t${c.cracked.toLocaleString().padStart(10)}\t${c.uncracked.toLocaleString().padStart(10)}\t${c.crackedPercent}%`);
    }
    console.log(`\nTotal: ${candidates.length} hashlists`);
    console.log(`Total uncracked: ${candidates.reduce((s, c) => s + c.uncracked, 0).toLocaleString()}`);
    return;
  }

  const hashlistArg = args.find(a => a.startsWith("--hashlist="));
  const topArg = args.find(a => a.startsWith("--top="));
  const all = args.includes("--all");

  if (hashlistArg) {
    const hashlistId = parseInt(hashlistArg.split("=")[1]);
    await extractSand(config, hashlistId, startBatch, { dryRun, compress });
  } else if (topArg) {
    const top = parseInt(topArg.split("=")[1]);
    const candidates = await listCandidates(config);
    const hashlistIds = candidates.slice(0, top).map(c => c.hashlistId);
    await extractFromMultiple(config, hashlistIds, startBatch, { dryRun, compress });
  } else if (all) {
    const candidates = await listCandidates(config);
    const hashlistIds = candidates.map(c => c.hashlistId);
    await extractFromMultiple(config, hashlistIds, startBatch, { dryRun, compress });
  } else {
    console.log("Specify --list, --hashlist=<id>, --top=<n>, or --all");
    console.log("Use --help for more options.");
  }
}

main().catch(console.error);
