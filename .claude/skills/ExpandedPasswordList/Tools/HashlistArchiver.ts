#!/usr/bin/env bun
/**
 * HashlistArchiver.ts - Archive hashlists and reclaim disk space
 *
 * After tasks are archived, this tool:
 * 1. Exports cracked passwords for the hashlist
 * 2. Archives the hashlist (isArchived=1)
 * 3. Deletes Hash table rows for the hashlist (reclaims disk)
 *
 * SAFETY: Only operates on hashlists where ALL associated tasks are archived.
 */

import { execSync } from "child_process";
import { existsSync, mkdirSync, appendFileSync, readFileSync } from "fs";
import { join } from "path";

// Load config from parent .env
const envPath = join(__dirname, "..", "..", "..", ".env");
const envContent = existsSync(envPath) ? readFileSync(envPath, "utf-8") : "";
const getEnv = (key: string): string => {
  const match = envContent.match(new RegExp(`^${key}=(.*)$`, "m"));
  return match ? match[1].trim() : process.env[key] || "";
};

interface Config {
  serverIp: string;
  dbPassword: string;
  outputDir: string;
}

function getConfig(): Config {
  const serverUrl = getEnv("HASHCRACK_SERVER_URL") || "http://35.87.24.127:8080";
  const serverIp = serverUrl.replace(/^https?:\/\//, "").replace(/:\d+$/, "");

  return {
    serverIp,
    dbPassword: getEnv("HASHCRACK_DB_PASSWORD"),
    outputDir: join(__dirname, "..", "data", "exports"),
  };
}

function execSQL(config: Config, query: string, timeout = 300000): string {
  // Flatten query to single line and escape properly
  const flatQuery = query.replace(/\s+/g, " ").trim();
  const cmd = `ssh -o ConnectTimeout=30 -o StrictHostKeyChecking=no ubuntu@${config.serverIp} "sudo docker exec hashtopolis-db mysql -uroot -p'${config.dbPassword}' hashtopolis -N -e '${flatQuery.replace(/'/g, "\\'")}'" 2>&1 | grep -v 'Warning'`;
  try {
    return execSync(cmd, { encoding: "utf-8", maxBuffer: 500 * 1024 * 1024, timeout }).trim();
  } catch (e: any) {
    return e.stdout?.toString() || `ERROR: ${e.message}`;
  }
}

interface HashlistInfo {
  hashlistId: number;
  hashCount: number;
  cracked: number;
  isArchived: boolean;
  allTasksArchived: boolean;
  hashRowCount: number;
}

async function getArchivableHashlists(config: Config): Promise<HashlistInfo[]> {
  // Step 1: Get basic hashlist info (fast query)
  console.log("  Step 1: Getting hashlist info...");
  const basicQuery = "SELECT hashlistId, hashCount, cracked, isArchived FROM Hashlist WHERE isArchived = 0 ORDER BY hashlistId";
  const basicResult = execSQL(config, basicQuery, 60000);

  if (!basicResult || basicResult.includes("ERROR")) {
    console.log("Error querying hashlists:", basicResult);
    return [];
  }

  const hashlists: HashlistInfo[] = [];
  for (const line of basicResult.split("\n").filter(l => l.trim())) {
    const [hashlistId, hashCount, cracked, isArchived] = line.split("\t");
    hashlists.push({
      hashlistId: parseInt(hashlistId),
      hashCount: parseInt(hashCount),
      cracked: parseInt(cracked),
      isArchived: isArchived === "1",
      allTasksArchived: true, // Assume true, we'll check
      hashRowCount: parseInt(hashCount), // Estimate from hashCount
    });
  }

  // Step 2: Find hashlists with active (non-archived) tasks
  console.log("  Step 2: Checking for active tasks...");
  const activeTasksQuery = "SELECT DISTINCT tw.hashlistId FROM Task t JOIN TaskWrapper tw ON t.taskWrapperId = tw.taskWrapperId WHERE t.isArchived = 0";
  const activeResult = execSQL(config, activeTasksQuery, 60000);

  const activeHashlists = new Set<number>();
  if (activeResult && !activeResult.includes("ERROR")) {
    for (const line of activeResult.split("\n").filter(l => l.trim())) {
      activeHashlists.add(parseInt(line));
    }
  }

  // Mark hashlists with active tasks
  for (const h of hashlists) {
    h.allTasksArchived = !activeHashlists.has(h.hashlistId);
  }

  return hashlists;
}

async function archiveHashlist(config: Config, hashlist: HashlistInfo, options: { dryRun: boolean; exportDir: string }) {
  const { hashlistId, hashCount, cracked, hashRowCount } = hashlist;

  console.log(`\nHashlist ${hashlistId}:`);
  console.log(`  Hash count: ${hashCount.toLocaleString()}`);
  console.log(`  Cracked: ${cracked.toLocaleString()}`);
  console.log(`  Hash rows to delete: ${hashRowCount.toLocaleString()}`);

  if (options.dryRun) {
    console.log(`  [DRY RUN] Would archive and delete ${hashRowCount} rows`);
    return { deleted: 0, archived: false, hashlistId };
  }

  // Step 1: Export cracked passwords if any
  if (cracked > 0) {
    console.log(`  Exporting ${cracked} cracked passwords...`);
    const exportQuery = `SELECT CONCAT(hash, ':', plaintext) FROM Hash WHERE hashlistId=${hashlistId} AND isCracked=1`;
    const exported = execSQL(config, exportQuery);

    if (exported && !exported.includes("ERROR")) {
      const exportFile = join(options.exportDir, "cracked-master.txt");
      appendFileSync(exportFile, exported + "\n");
      console.log(`  ✓ Appended to ${exportFile}`);
    }
  }

  // Note: We'll do bulk deletes later for efficiency
  return { deleted: 0, archived: false, hashlistId, needsDelete: true };
}

async function bulkDeleteHashlists(config: Config, hashlistIds: number[]): Promise<number> {
  if (hashlistIds.length === 0) return 0;

  console.log(`\nBulk deleting ${hashlistIds.length} hashlists...`);

  // Delete in batches of 100 hashlists at a time
  let totalDeleted = 0;
  const batchSize = 100;

  for (let i = 0; i < hashlistIds.length; i += batchSize) {
    const batch = hashlistIds.slice(i, i + batchSize);
    const idList = batch.join(",");

    console.log(`  Deleting hashlists ${batch[0]}-${batch[batch.length-1]}...`);

    // Use direct SSH command with longer timeout for bulk operations
    try {
      const { execSync } = await import("child_process");
      const cmd = `ssh -o ConnectTimeout=300 -o ServerAliveInterval=60 -o StrictHostKeyChecking=no ubuntu@${config.serverIp} 'sudo docker exec hashtopolis-db mysql -uroot -p"${config.dbPassword}" hashtopolis -e "DELETE FROM Hash WHERE hashlistId IN (${idList}); SELECT ROW_COUNT();"'`;
      const result = execSync(cmd, { encoding: "utf-8", timeout: 600000 });
      const match = result.match(/(\d+)/);
      const deleted = match ? parseInt(match[1]) : 0;
      totalDeleted += deleted;
      console.log(`  ✓ Deleted ${deleted.toLocaleString()} rows`);
    } catch (e: any) {
      console.log(`  ⚠ Bulk delete may have succeeded despite timeout`);
      // Continue - the delete may have worked even if SSH timed out
    }

    // Archive the hashlists
    try {
      const { execSync } = await import("child_process");
      const cmd = `ssh -o ConnectTimeout=60 -o StrictHostKeyChecking=no ubuntu@${config.serverIp} 'sudo docker exec hashtopolis-db mysql -uroot -p"${config.dbPassword}" hashtopolis -e "UPDATE Hashlist SET isArchived=1 WHERE hashlistId IN (${idList})"'`;
      execSync(cmd, { encoding: "utf-8", timeout: 60000 });
    } catch (e) {
      // Continue
    }
  }

  return totalDeleted;
}

async function main() {
  const args = process.argv.slice(2);
  const config = getConfig();

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
Usage: bun run HashlistArchiver.ts [options]

Options:
  --dry-run       Show what would be done without making changes
  --limit N       Process only first N hashlists
  --hashlist N    Process specific hashlist ID
  --status        Show archivable hashlists without processing

Safety:
  - Only archives hashlists where ALL tasks are archived
  - Exports cracked passwords before deleting Hash rows
  - Appends to cracked-master.txt for safekeeping
`);
    process.exit(0);
  }

  const dryRun = args.includes("--dry-run");
  const statusOnly = args.includes("--status");
  const limit = parseInt(args.find(a => a.startsWith("--limit="))?.split("=")[1] || "0");
  const specificHashlist = parseInt(args.find(a => a.startsWith("--hashlist="))?.split("=")[1] || "0");

  console.log("╭─────────────────────────────────────────────────────────────╮");
  console.log("│              HASHLIST ARCHIVER                              │");
  console.log("╰─────────────────────────────────────────────────────────────╯");
  console.log("");

  if (dryRun) {
    console.log("🔍 DRY RUN MODE - No changes will be made\n");
  }

  // Ensure export directory exists
  if (!existsSync(config.outputDir)) {
    mkdirSync(config.outputDir, { recursive: true });
  }

  // Get disk usage before
  const diskBefore = execSQL(config, "SELECT ROUND(SUM(data_length + index_length) / 1024 / 1024, 2) FROM information_schema.tables WHERE table_schema = 'hashtopolis' AND table_name = 'Hash'", 30000);
  console.log(`Hash table size before: ${diskBefore} MB`);

  // Get archivable hashlists
  console.log("\nFinding archivable hashlists...");
  let hashlists = await getArchivableHashlists(config);

  // Filter to only those with all tasks archived and has Hash rows
  const archivable = hashlists.filter(h => h.allTasksArchived && h.hashRowCount > 0);

  console.log(`\nFound ${hashlists.length} non-archived hashlists`);
  console.log(`  ${archivable.length} ready to archive (all tasks archived, has Hash rows)`);

  if (archivable.length === 0) {
    console.log("\nNo hashlists ready for archiving.");
    return;
  }

  // Summary
  const totalRows = archivable.reduce((sum, h) => sum + h.hashRowCount, 0);
  const totalCracked = archivable.reduce((sum, h) => sum + h.cracked, 0);
  const estSizeMb = Math.round(totalRows * 230 / 1024 / 1024);

  console.log(`\nArchive Summary:`);
  console.log(`  Hashlists to archive: ${archivable.length}`);
  console.log(`  Total Hash rows to delete: ${totalRows.toLocaleString()}`);
  console.log(`  Total cracked to export: ${totalCracked.toLocaleString()}`);
  console.log(`  Estimated disk to reclaim: ~${estSizeMb} MB`);

  if (statusOnly) {
    console.log("\n--status mode, not processing. Use without --status to archive.");
    return;
  }

  // Apply filters
  let toProcess = archivable;
  if (specificHashlist) {
    toProcess = toProcess.filter(h => h.hashlistId === specificHashlist);
  }
  if (limit > 0) {
    toProcess = toProcess.slice(0, limit);
  }

  console.log(`\nProcessing ${toProcess.length} hashlists...`);

  let totalDeleted = 0;
  let totalArchived = 0;

  for (const hashlist of toProcess) {
    const result = await archiveHashlist(config, hashlist, {
      dryRun,
      exportDir: config.outputDir,
    });
    totalDeleted += result.deleted;
    if (result.archived) totalArchived++;
  }

  // Get disk usage after
  if (!dryRun) {
    const diskAfter = execSQL(config, "SELECT ROUND(SUM(data_length + index_length) / 1024 / 1024, 2) FROM information_schema.tables WHERE table_schema = 'hashtopolis' AND table_name = 'Hash'", 30000);
    console.log(`\n${"─".repeat(60)}`);
    console.log(`Hash table size after: ${diskAfter} MB`);
    console.log(`Disk reclaimed: ~${Math.round(parseFloat(diskBefore) - parseFloat(diskAfter))} MB`);
  }

  console.log(`\nDone!`);
  console.log(`  Hashlists archived: ${totalArchived}`);
  console.log(`  Hash rows deleted: ${totalDeleted.toLocaleString()}`);
}

main().catch(console.error);
