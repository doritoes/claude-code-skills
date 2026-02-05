#!/usr/bin/env bun
/**
 * PasswordExporter.ts - Export cracked passwords from Hashtopolis
 *
 * Exports all cracked hash:plaintext pairs for safekeeping before cleanup.
 * This preserves the valuable outputs (PEARLS) before we delete Hash rows.
 */

import { execSync } from "child_process";
import { existsSync, mkdirSync, writeFileSync, appendFileSync } from "fs";
import { join } from "path";

// Load config from parent .env
const envPath = join(__dirname, "..", "..", "..", ".env");
const envContent = existsSync(envPath) ? require("fs").readFileSync(envPath, "utf-8") : "";
const getEnv = (key: string): string => {
  const match = envContent.match(new RegExp(`^${key}=(.*)$`, "m"));
  return match ? match[1].trim() : process.env[key] || "";
};

interface ExportConfig {
  serverIp: string;
  sshUser: string;
  dbPassword: string;
  outputDir: string;
}

function getConfig(): ExportConfig {
  const serverUrl = getEnv("HASHCRACK_SERVER_URL") || "http://35.87.24.127:8080";
  const serverIp = serverUrl.replace(/^https?:\/\//, "").replace(/:\d+$/, "");

  return {
    serverIp,
    sshUser: getEnv("HASHCRACK_SSH_USER") || "ubuntu",
    dbPassword: getEnv("HASHCRACK_DB_PASSWORD"),
    outputDir: join(__dirname, "..", "data", "exports"),
  };
}

function execSQL(config: ExportConfig, query: string, timeout = 300000): string {
  // Clean SQL and collapse whitespace
  const cleanSql = query.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();

  // Use base64 encoding to avoid ALL shell quote escaping issues
  // This pattern works reliably with CONCAT(), special chars, etc.
  const b64Sql = Buffer.from(cleanSql).toString('base64');
  // Run grep on the server (not locally) to filter MySQL warnings - grep doesn't exist on Windows
  const sshCmd = `echo '${b64Sql}' | base64 -d | sudo docker exec -i hashtopolis-db mysql -u hashtopolis -p'${config.dbPassword}' hashtopolis -sN 2>&1 | grep -v 'Warning'`;
  const cmd = `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=30 ${config.sshUser}@${config.serverIp} "${sshCmd}"`;

  try {
    return execSync(cmd, { encoding: "utf-8", maxBuffer: 500 * 1024 * 1024, timeout }).trim();
  } catch (e: any) {
    return e.stdout?.toString() || "";
  }
}

async function exportCrackedPasswords(config: ExportConfig, options: { batchSize?: number; hashlistId?: number } = {}) {
  const batchSize = options.batchSize || 100000;

  // Ensure output directory exists
  if (!existsSync(config.outputDir)) {
    mkdirSync(config.outputDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outputFile = join(config.outputDir, `cracked-${timestamp}.txt`);
  const statsFile = join(config.outputDir, `export-stats-${timestamp}.json`);

  console.log("╭─────────────────────────────────────────────────────────────╮");
  console.log("│              PASSWORD EXPORTER                              │");
  console.log("╰─────────────────────────────────────────────────────────────╯");
  console.log("");

  // Get total count
  let countQuery = "SELECT COUNT(*) FROM Hash WHERE isCracked=1";
  if (options.hashlistId) {
    countQuery += ` AND hashlistId=${options.hashlistId}`;
  }
  const totalCount = parseInt(execSQL(config, countQuery)) || 0;

  console.log(`Total cracked passwords to export: ${totalCount.toLocaleString()}`);
  console.log(`Output file: ${outputFile}`);
  console.log("");

  if (totalCount === 0) {
    console.log("No cracked passwords to export.");
    return;
  }

  // Export in batches
  let exported = 0;
  let offset = 0;
  const startTime = Date.now();

  // Initialize output file
  writeFileSync(outputFile, "");

  while (offset < totalCount) {
    let query = `SELECT CONCAT(hash, ':', plaintext) FROM Hash WHERE isCracked=1`;
    if (options.hashlistId) {
      query += ` AND hashlistId=${options.hashlistId}`;
    }
    query += ` LIMIT ${batchSize} OFFSET ${offset}`;

    const result = execSQL(config, query);
    if (result && !result.includes("ERROR")) {
      appendFileSync(outputFile, result + "\n");
      const lines = result.split("\n").filter(l => l.trim()).length;
      exported += lines;
    }

    offset += batchSize;
    const elapsed = (Date.now() - startTime) / 1000;
    const rate = exported / elapsed;
    const eta = (totalCount - exported) / rate;

    process.stdout.write(`\r  Exported: ${exported.toLocaleString()}/${totalCount.toLocaleString()} (${Math.round(exported/totalCount*100)}%) - ETA: ${Math.round(eta)}s  `);
  }

  console.log("\n");

  // Write stats
  const stats = {
    timestamp,
    totalExported: exported,
    outputFile,
    elapsedSeconds: Math.round((Date.now() - startTime) / 1000),
    hashlistId: options.hashlistId || "all",
  };
  writeFileSync(statsFile, JSON.stringify(stats, null, 2));

  console.log("✓ Export complete!");
  console.log(`  Passwords exported: ${exported.toLocaleString()}`);
  console.log(`  Output file: ${outputFile}`);
  console.log(`  Stats file: ${statsFile}`);
}

async function exportByHashlist(config: ExportConfig) {
  console.log("╭─────────────────────────────────────────────────────────────╮");
  console.log("│              PASSWORD EXPORTER - By Hashlist                │");
  console.log("╰─────────────────────────────────────────────────────────────╯");
  console.log("");

  // Get all hashlists with cracked passwords
  const query = `
    SELECT h.hashlistId, hl.hashCount, COUNT(*) as cracked
    FROM Hash h
    JOIN Hashlist hl ON h.hashlistId = hl.hashlistId
    WHERE h.isCracked = 1
    GROUP BY h.hashlistId
    ORDER BY h.hashlistId
  `;
  const result = execSQL(config, query);

  if (!result || result.includes("ERROR")) {
    console.log("Error querying hashlists");
    return;
  }

  const lines = result.split("\n").filter(l => l.trim());
  console.log(`Found ${lines.length} hashlists with cracked passwords`);

  // Summary by batch
  const batchSummary: Record<string, { hashlists: number; cracked: number }> = {};

  for (const line of lines) {
    const [hashlistId, hashCount, cracked] = line.split("\t");
    // Estimate batch from hashlistId (8 hashlists per batch)
    const batchNum = Math.floor((parseInt(hashlistId) - 1) / 8);
    const batchKey = `batch-${String(batchNum).padStart(4, "0")}`;

    if (!batchSummary[batchKey]) {
      batchSummary[batchKey] = { hashlists: 0, cracked: 0 };
    }
    batchSummary[batchKey].hashlists++;
    batchSummary[batchKey].cracked += parseInt(cracked);
  }

  console.log("\nBatch Summary (first 20):");
  console.log("─".repeat(50));

  const batches = Object.entries(batchSummary).slice(0, 20);
  for (const [batch, data] of batches) {
    console.log(`  ${batch}: ${data.hashlists} hashlists, ${data.cracked.toLocaleString()} cracked`);
  }

  if (Object.keys(batchSummary).length > 20) {
    console.log(`  ... and ${Object.keys(batchSummary).length - 20} more batches`);
  }
}

async function getExportStats(config: ExportConfig) {
  console.log("╭─────────────────────────────────────────────────────────────╮");
  console.log("│              PASSWORD EXPORTER - Stats                      │");
  console.log("╰─────────────────────────────────────────────────────────────╯");
  console.log("");

  // Database stats - use simple separate queries
  console.log("Database Status:");

  const total = execSQL(config, "SELECT COUNT(*) FROM Hash", 60000);
  console.log(`  Total hashes in Hash table: ${parseInt(total || "0").toLocaleString()}`);

  const cracked = execSQL(config, "SELECT COUNT(*) FROM Hash WHERE isCracked=1", 60000);
  console.log(`  Cracked hashes: ${parseInt(cracked || "0").toLocaleString()}`);

  const hashlists = execSQL(config, "SELECT COUNT(DISTINCT hashlistId) FROM Hash", 60000);
  console.log(`  Hashlists with data: ${hashlists}`);

  // Local export files
  console.log("\nLocal Export Files:");
  if (existsSync(config.outputDir)) {
    const files = require("fs").readdirSync(config.outputDir);
    const txtFiles = files.filter((f: string) => f.endsWith(".txt"));
    if (txtFiles.length === 0) {
      console.log("  No exports found");
    } else {
      for (const file of txtFiles.slice(-5)) {
        const fullPath = join(config.outputDir, file);
        const stat = require("fs").statSync(fullPath);
        console.log(`  ${file} (${Math.round(stat.size / 1024 / 1024)} MB)`);
      }
    }
  } else {
    console.log("  Export directory not created yet");
  }
}

// Main
const args = process.argv.slice(2);
const config = getConfig();

if (args.includes("--help") || args.includes("-h")) {
  console.log(`
Usage: bun run PasswordExporter.ts [command] [options]

Commands:
  export          Export all cracked passwords (default)
  stats           Show export statistics
  by-hashlist     Show cracked counts by hashlist/batch

Options:
  --batch-size N  Export batch size (default: 100000)
  --hashlist N    Export only specific hashlist ID
`);
  process.exit(0);
}

const command = args[0] || "export";

if (command === "stats") {
  getExportStats(config);
} else if (command === "by-hashlist") {
  exportByHashlist(config);
} else {
  const batchSize = parseInt(args.find(a => a.startsWith("--batch-size="))?.split("=")[1] || "100000");
  const hashlistId = parseInt(args.find(a => a.startsWith("--hashlist="))?.split("=")[1] || "0") || undefined;

  exportCrackedPasswords(config, { batchSize, hashlistId });
}
